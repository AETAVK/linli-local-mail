import crypto from 'node:crypto';
import fs from 'node:fs';
import { setImmediate as yieldTurn, setTimeout as waitDelay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { SERVICE_VERSION } from './constants.mjs';
import { scanCustomSongs } from './custom-song-scan.mjs';
import { ScanDiagnostics } from './custom-song-diagnostics.mjs';
import { SongEvidenceAnonymizer, isSongEvidenceCandidate } from './custom-song-debug-anonymize.mjs';
import { redactSongFragment, FRAGMENT_POLICY } from './custom-song-fragment-redact.mjs';
import { captureRelationships, diagnosticAssessment } from './custom-song-debug-context.mjs';
import { evidenceType, inspectFieldShape, inspectRequestStructure, leadingStructureType } from './custom-song-structure.mjs';
import { DetailedSongEvidence } from './custom-song-debug-evidence.mjs';
import {collectExtraNameSources,captureNameInventory,newNameSource,observeNameLogLine,verifyNameSourceGroup,boundNameSources} from './custom-song-name-sources.mjs';
import {assessSongNames,renderSongNameReport,compactSongNameResult} from './custom-song-name-recovery.mjs';
import { diagnosticError } from './diagnostic-errors.mjs';
import path from 'node:path';
import { DEBUG_LIMITS, replayMaterial, eventInvariant, songInvariants, replayRuntimeIdentity, validateReplayMaterial, decodeDebugPackage, readDetailedEvidence } from './custom-song-debug-replay.mjs';

const error = (code, status = 400) => Object.assign(new Error(code), { status });
function candidate(line, outer) {
  if (!line.includes('[OTEL Logger]')) return { matched: false, limited: false };
  const attrs = outer?.attributes || outer;
  let action = attrs?.['query.action'];
  if (!outer) {
    // Even a damaged outer object may have a complete action string. Use it only to exclude non-song data.
    const token = line.match(/"query\.action"\s*:\s*("(?:[^"\\]|\\.)*")/);
    if (token) try { action = JSON.parse(token[1]); } catch { /* unknown action */ }
  }
  if (typeof action === 'string' && /letter|mail/i.test(action)) return { matched: false, limited: false };
  if (['checkLocalSongs', 'startSongDownload'].includes(action)) return { matched: true, limited: false };
  if (!outer) return { matched: line.includes('[OTEL Logger]') && isSongEvidenceCandidate(line), limited: false };
  // Inspect decoded keys too (e.g. unicode-escaped field names); bounded, never collect ordinary telemetry wholesale.
  const pending = [outer]; let visited = 0, limited = false;
  for (const field of ['query.request', 'query.response']) {
    let value = attrs?.[field], depth = 0;
    while (typeof value === 'string' && /^\s*[\[{\"]/.test(value) && /nameKey|videoByTodView|\\u[0-9a-f]{4}/i.test(value)) {
      if (value.length > 128 * 1024 || depth++ >= 4) {
        if (isSongEvidenceCandidate(value)) return { matched: true, limited: true };
        limited = true; break;
      }
      try { value = JSON.parse(value); pending.push(value); }
      catch { return { matched: isSongEvidenceCandidate(value), limited: false }; }
    }
  }
  while (pending.length && visited++ < 128) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    if (Object.hasOwn(value, 'nameKey') || Object.hasOwn(value, 'videoByTodView')) return { matched: true, limited };
    const children = Object.values(value);
    if (children.length > 128 - visited) limited = true;
    for (const item of children.slice(0, 128 - visited)) if (item && typeof item === 'object') pending.push(item);
  }
  return { matched: false, limited: limited || pending.length > 0 };
}

export async function collectSongDebugPackage({ mediaRoot, logRoot, logRootSource = 'custom', mappingEntries = [], context = null, detailContext = null, failures = [], frozenNameSources = [], extraPaths = [], backupRoot, io = {}, signal, onProgress = () => {}, onEvidence = () => {}, limits = {} }) {
  const budget = { ...DEBUG_LIMITS, ...limits };
  const diagnostics = new ScanDiagnostics({ mediaRoot, logRoot, logRootSource: logRootSource === 'default' ? 'default' : 'custom', patchVersion: SERVICE_VERSION });
  const events = [], directories = [], fileOrders = new Map();
  const details=new DetailedSongEvidence(),categoryCounts={};let order=0;
  const selectedNameSources=new Map();let nameBytes=0,logDirectorySnapshot=null;
  let retainedInventory=null,retainedExtraSources=[];
  const captureCoverage={inventoryComplete:false,logsComplete:false,extrasComplete:false};
  const coverage = { candidateEvents: 0, retainedEvents: 0, omittedEvents: 0, retainedBytes: 0,
    omittedDirectories: 0, omittedFiles: 0, inputFilesChanged: 0, inputFilesUnavailableAfterRead: 0,
    rawEligibleEvents: 0, rawRetainedEvents: 0, rawOmittedEvents: 0, candidateProbeLimitedEvents: 0 };
  const snapshots = new Map(), readPaths = new Set();
  const baseIo = { lstat: fs.promises.lstat, readdir: fs.promises.readdir, createReadStream: fs.createReadStream, ...io };
  const check = () => { if (signal?.aborted) throw error('DEBUG_CAPTURE_CANCELLED', 409); };
  const observedIo = {
    async lstat(target) { check(); try{const info = await baseIo.lstat(target); if (info.isFile()) snapshots.set(target, { size: info.size, mtimeMs: info.mtimeMs, ctimeMs:info.ctimeMs, ino: info.ino });
      const relative=path.relative(mediaRoot,target),logRelative=path.relative(logRoot,target);
      const isMedia=relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),isLog=logRelative&&!logRelative.startsWith('..')&&!path.isAbsolute(logRelative);
      if(isMedia||isLog)details.file({relativePath:(isMedia?relative:logRelative).replace(/\\/g,'/'),source:isMedia?'selected-media':'selected-logs',size:info.size,mtimeMs:info.mtimeMs,zeroBytes:info.isFile()&&info.size===0,symbolicLink:info.isSymbolicLink(),basis:'lstat-during-capture'});
      return info;
    }catch(error){details.file({relativePath:path.relative(mediaRoot,target).replace(/\\/g,'/'),error:diagnosticError(error,'file-stat'),basis:'failed-lstat'});throw error;} },
    async readdir(target,...args) { check();const entries=await baseIo.readdir(target,...args);
      if(target===logRoot)try{const info=await baseIo.lstat(target);logDirectorySnapshot={size:info.size,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs,ino:info.ino};}catch{}
      for(const entry of Array.isArray(entries)?entries.slice(0,20000):[])if(entry?.isSymbolicLink?.())details.file({relativePath:path.relative(mediaRoot,path.join(target,entry.name)).replace(/\\/g,'/'),symbolicLink:true,basis:'directory-entry-excluded'});
      return entries;
    },
    createReadStream(target, options) {
      check(); readPaths.add(target); const saved = snapshots.get(target);
      details.file({fileName:path.basename(target),source:'selected-logs',size:saved?.size,mtimeMs:saved?.mtimeMs,readStart:0,readEndInclusive:saved?.size>0?saved.size-1:null,basis:'bounded-read-request-not-proof-of-full-read'});
      return baseIo.createReadStream(target, { ...options, ...(signal ? { signal } : {}), ...(saved?.size > 0 ? { end: saved.size - 1 } : {}) });
    },
  };
  const recordLogFile=diagnostics.addFile.bind(diagnostics);
  diagnostics.addFile=(item)=>{
    const id=recordLogFile(item);
    if(typeof item.name==='string'){
      if(!selectedNameSources.has(item.name))selectedNameSources.set(item.name,newNameSource('selected-log-'+selectedNameSources.size,'selected-log',path.join(logRoot,item.name)));
      const source=selectedNameSources.get(item.name);source.fileId=id;source.readStatus=item.status;
    }
    return id;
  };
  diagnostics.observeLogLine = (line, context, outer) => {
    const nameFile=context.logFile||'unknown';
    if(!selectedNameSources.has(nameFile))selectedNameSources.set(nameFile,newNameSource('selected-log-'+selectedNameSources.size,'selected-log',path.join(logRoot,nameFile)));
    const nameSource=selectedNameSources.get(nameFile),priorBytes=nameSource.retainedBytes||0,priorLength=nameSource.records.length;
    observeNameLogLine(nameSource,line,context.line);
    nameBytes+=(nameSource.retainedBytes||0)-priorBytes;
    if(nameBytes>4*1024*1024){nameSource.records.length=priorLength;nameBytes-=(nameSource.retainedBytes||0)-priorBytes;nameSource.retainedBytes=priorBytes;
      nameSource.complete=false;if(!nameSource.gaps.some(g=>g.reason==='log-name-retention-budget'))nameSource.gaps.push({reason:'log-name-retention-budget'});}
    check(); const probe = candidate(line, outer);
    if (probe.limited) coverage.candidateProbeLimitedEvents++;
    if (!probe.matched) return;
    coverage.candidateEvents++;
    const source={fileId:context.fileId,line:context.line,fileName:path.basename(context.logFile||'unknown')};
    const category=details.observe(line,source,outer,order++)||'other-song-event';
    categoryCounts[category]=(categoryCounts[category]||0)+1;
    const size = Buffer.byteLength(line);
    if (!fileOrders.has(context.fileId)) fileOrders.set(context.fileId, fileOrders.size);
    const priority=category==='song-association'?2:category==='response-only'||category==='local-derived'?0:1;
    if(priority===0&&categoryCounts[category]>64){coverage.omittedEvents++;return;}
    if(size>budget.eventBytes){coverage.omittedEvents++;return;}
    while(events.length>=budget.events||coverage.retainedBytes+size>budget.evidenceBytes){
      const index=events.findLastIndex(event=>event.priority<priority);if(index<0){coverage.omittedEvents++;return;}
      coverage.retainedBytes-=Buffer.byteLength(events[index].text);events.splice(index,1);coverage.retainedEvents--;coverage.omittedEvents++;
    }
    events.push({ text: line, fileOrder: fileOrders.get(context.fileId), source: { fileId: context.fileId, line: context.line },order:order-1,priority });
    coverage.retainedBytes += size; coverage.retainedEvents++;
    if (events.length % 64 === 0) onProgress({ phase: 'collecting', retainedEvents: events.length });
  };
  let fileCount = 0;
  diagnostics.observeDirectory = (key, files) => {
    check();
    if (directories.length >= budget.directories) { coverage.omittedDirectories++; coverage.omittedFiles += files.length; return; }
    const retained = files.slice(0, Math.max(0, budget.files - fileCount));
    coverage.omittedFiles += files.length - retained.length; fileCount += retained.length;
    directories.push({ key, files: retained });
  };
  try {
    try{const stat=await baseIo.lstat(mediaRoot);const real=await (io.realpath||fs.promises.realpath)(mediaRoot);details.file({root:mediaRoot,actualPath:real,size:stat.size,mtimeMs:stat.mtimeMs,directory:stat.isDirectory(),symbolicLink:stat.isSymbolicLink(),basis:'selected-root-stat-realpath'});}catch(error){details.file({root:mediaRoot,error:diagnosticError(error,'root-access'),basis:'selected-root-access-failed'});}
    let capturedScan={songs:[]};try{capturedScan = await scanCustomSongs({ mediaRoot, logRoot, diagnostics, mappingEntries, io: observedIo,
      inspectMedia: async () => ({ valid: false, reason: 'capture-no-video' }) });}catch(error){if(signal?.aborted)throw error;failures.push(diagnosticError(error,'capture-scan'));}
    events.sort((a,b)=>a.order-b.order);
    check();
    for (const target of readPaths) {
      try {
        const after = await baseIo.lstat(target), before = snapshots.get(target);
        if (after.isSymbolicLink() || !after.isFile() || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) coverage.inputFilesChanged++;
      } catch { coverage.inputFilesUnavailableAfterRead++; }
    }
    diagnostics.finish();
    const report = diagnostics.snapshot().report;
    const aliases = new SongEvidenceAnonymizer();
    const material = { events: [], directories: directories.map(item => ({ key: aliases.key(item.key), files: [...new Set(item.files.map(file => aliases.file(file)))] })), mappings: [] };
    coverage.caseFoldCollisions=directories.reduce((n,item)=>n+item.files.length-new Set(item.files.map(file=>file.toLowerCase())).size,0);
    const actualFiles = new Map(directories.flatMap(item => item.files.map(file => [file.toLowerCase(), file])));
    const sourceFiles = new Set(actualFiles.keys());
    const projectedMappings = mappingEntries.filter(item => sourceFiles.has(item.fileName.toLowerCase())).slice(0, budget.files).map(item => ({
      fileName: item.fileName, ...(item.filePath ? { filePath: item.filePath } : {}), name: item.name || '',
      tod: item.tod || null, view: item.view || null, ...(item.manualUnknown ? { manualUnknown: true } : {}),
    }));
    material.mappings = projectedMappings.map(item => ({ ...item, fileName: aliases.file(actualFiles.get(item.fileName.toLowerCase())), name: aliases.value(item.name),
      ...(item.filePath ? { filePath: aliases.key(item.filePath.split('/')[0]) + '/' + aliases.file(actualFiles.get(item.fileName.toLowerCase())) } : {}) }));
    onProgress({ phase: 'verifying', retainedEvents: events.length });
    const verification = { scope: 'production-log-parser-and-name-matching-only', offsets: 'anonymized-not-original',
      events: [], nameMatchingEquivalent: false, sanitizedResult: null };
    const sensitive = [], rawCandidates = [], relationshipRecords = []; let rawBytes = 0, sanitizedBytes = 0;
    coverage.relationshipRecordsOmitted=0;
    for (let index = 0; index < events.length; index++) {
      check(); if (index % 32 === 0) await yieldTurn();
      const event = events[index], redacted = aliases.line(event.text);
      const redactedBytes = Buffer.byteLength(redacted.text);
      sanitizedBytes += redactedBytes;
      if (redactedBytes > DEBUG_LIMITS.eventBytes || sanitizedBytes > DEBUG_LIMITS.evidenceBytes) {
        sanitizedBytes-=redactedBytes;redacted.text='[OTEL Logger] {}';sanitizedBytes+=Buffer.byteLength(redacted.text);redacted.losses.push('anonymization-capacity-omitted');coverage.omittedEvents++;
      }
      const source = { ...event.source };
      if (!report.logFiles.some(file => file.fileId === source.fileId)) { source.fileId = null; source.fileOmitted = true; }
      material.events.push({ text: redacted.text, fileOrder: event.fileOrder, source });
      const before = eventInvariant(event.text, aliases), after = eventInvariant(redacted.text);
      const original = eventInvariant(event.text);
      const retainedRecords=original.records.slice(0,Math.max(0,20000-relationshipRecords.length));relationshipRecords.push(...retainedRecords);
      coverage.relationshipRecordsOmitted+=original.records.length-retainedRecords.length;
      const equivalent = JSON.stringify(before) === JSON.stringify(after);
      const reasons = [...redacted.losses, ...(!equivalent ? ['production-invariant-difference'] : [])];
      verification.events.push({ eventIndex: index, status: equivalent && !reasons.length ? 'equivalent' : 'lossy',
        productionEquivalent: equivalent, reasons });
      const rawReasons = reasons.filter(reason => !['outer-field-aliased', 'outer-number-generalized'].includes(reason));
      if (rawReasons.length) {
        coverage.rawEligibleEvents++;
        const stages=original.stages;
        const category=stages.derivedEvents?'local-derived':stages.responseOnlyEvents?'response-only':stages.requestTypeFailures?'request-type':stages.innerJsonFailures?'inner-json':stages.unknownActions?'unknown-action':!equivalent?'parser-difference':'anonymization';
        let attrs={};try{const outer=JSON.parse(event.text.slice(event.text.indexOf('{',event.text.indexOf('[OTEL Logger]'))));attrs=outer?.attributes||outer||{};}catch{}
        const requestType=evidenceType(attrs['query.request'],Object.hasOwn(attrs,'query.request')),responseType=evidenceType(attrs['query.response'],Object.hasOwn(attrs,'query.response'));
        const shape=requestType+':'+(typeof attrs['query.request']==='string'?leadingStructureType(attrs['query.request']):responseType);
        rawCandidates.push({ index, category, shape, requestType, responseType, priority:category==='response-only'?0:!equivalent?3:category==='unknown-action'?2:1 });
      }
    }
    coverage.fragmentOmissions = {};
    coverage.fragmentCategories = {};
    verification.structuralRepresentatives=[];
    verification.fragments = [];
    rawCandidates.sort((a, b) => b.priority - a.priority || a.index - b.index);
    const groups=new Map();
    for(const item of rawCandidates){const group=item.category+':'+events[item.index].fileOrder+':'+item.shape;if(!groups.has(group))groups.set(group,[]);groups.get(group).push(item);}
    const ordered=[];while(ordered.length<rawCandidates.length)for(const items of groups.values())if(items.length)ordered.push(items.shift());
    const structureGroups=new Set();let structuralBytes=0;
    for (const item of ordered) {
      const {index,category,shape}=item;
      const categoryCounts=coverage.fragmentCategories[category]||(coverage.fragmentCategories[category]={eligible:0,retained:0,omitted:0});categoryCounts.eligible++;
      const event = events[index], marker = event.text.indexOf('[OTEL Logger]');
      const raw = marker >= 0 ? event.text.slice(marker) : event.text;
      const group=category+':'+event.fileOrder+':'+shape;
      if(!structureGroups.has(group)&&verification.structuralRepresentatives.length<24){
        let attrs={};try{const outer=JSON.parse(raw.slice(raw.indexOf('{')));attrs=outer?.attributes||outer||{};}catch{}
        const request=attrs['query.request'];const summary={eventIndex:index,category,requestType:item.requestType,responseType:item.responseType,
          request:typeof request==='string'?inspectRequestStructure(request):inspectFieldShape(request),response:inspectFieldShape(attrs['query.response'])};
        const size=Buffer.byteLength(JSON.stringify(summary));if(structuralBytes+size<=32768){verification.structuralRepresentatives.push(summary);structuralBytes+=size;structureGroups.add(group);}
      }
      const fragment = redactSongFragment(raw, { bytes: budget.rawEventBytes });
      const bytes = fragment.ok ? Buffer.byteLength(fragment.text) : 0;
      const reason = !fragment.ok ? fragment.reason : category==='response-only'&&categoryCounts.retained>=2?'response-only-quota':sensitive.length >= budget.rawEvents || rawBytes + bytes > budget.rawBytes ? 'attachment-budget-exceeded' : null;
      if (reason) { categoryCounts.omitted++;coverage.fragmentOmissions[reason] = (coverage.fragmentOmissions[reason] || 0) + 1; continue; }
      categoryCounts.retained++;
      const productionEquivalent = JSON.stringify(eventInvariant(raw)) === JSON.stringify(eventInvariant(fragment.text));
      verification.fragments.push({ eventIndex: index, productionEquivalent, redactions: fragment.redactions });
      sensitive.push({ eventIndex: index, source: material.events[index].source, text: fragment.text, category,
        contentKind: fragment.contentKind, policy: fragment.policy, redactions: fragment.redactions }); rawBytes += bytes;
    }
    coverage.rawOmittedEvents = coverage.rawEligibleEvents - sensitive.length;
    check();
    const originalResult = await replayMaterial({ events, directories, mappings: projectedMappings }, { aliases });
    const sanitizedResult = await replayMaterial(material);
    verification.nameMatchingEquivalent = JSON.stringify(originalResult.songs) === JSON.stringify(sanitizedResult.songs);
    verification.capturedScanNameMatchingEquivalent = JSON.stringify(songInvariants(capturedScan.songs, aliases)) === JSON.stringify(originalResult.songs);
    verification.sanitizedResult = sanitizedResult;
    if (!verification.nameMatchingEquivalent) verification.nameMatchingGap = 'anonymization-or-projected-input-difference';
    coverage.rawRetainedEvents = sensitive.length;
    const readCoverageComplete = report.paths.logRootStatus === 'readable' && !['logFilesSkipped', 'logFilesFailed', 'logFilesUnsupported', 'oversizedLines'].some(key => report.stages[key]) &&
      !report.reasons.some(reason => ['DIRECTORY_LIMIT', 'READ_LIMIT', 'ROOT_MISSING', 'ROOT_INVALID', 'PERMISSION_DENIED', 'UNDETERMINED', 'SCAN_FAILED'].includes(reason.code));
    const captureComplete = readCoverageComplete && !coverage.omittedEvents && !coverage.omittedDirectories && !coverage.omittedFiles &&
      !coverage.inputFilesChanged && !coverage.inputFilesUnavailableAfterRead && !coverage.candidateProbeLimitedEvents;
    const manifest = { scanId: report.scanId, createdAt: new Date().toISOString(), sourceVersion: SERVICE_VERSION,
      runtime: await replayRuntimeIdentity(), snapshotBasis: 'single-capture-read-then-memory-only', scope: 'selected-log-root-and-eligible-media-directory-names',
      complete: captureComplete, captureComplete, readCoverageComplete,
      originalParserHadFailures: ['requestTypeFailures', 'innerJsonFailures', 'unclassifiedOuterFailures'].some(key => report.stages[key] > 0),
      originalScanComplete: report.complete, fidelityComplete: verification.events.every(item => item.status === 'equivalent') && captureComplete &&
        verification.nameMatchingEquivalent && verification.capturedScanNameMatchingEquivalent,
      coverage, limits: budget, sensitivity: 'sanitized', fragmentPolicy: FRAGMENT_POLICY, fragmentBytes: 'redacted-not-original',
      context: context || {available:false,reason:'not-supplied'},
      relationships:captureRelationships(mappingEntries,directories,relationshipRecords),
      fragmentSelection:'problem-source-shape-round-robin-response-only-max-2',
      limitations: ['not-an-atomic-filesystem-backup', 'no-video-content-or-period-validation', 'mapping-name-fields-only',
        'unknown-fields-and-actions-may-be-lossy', 'missing-history-cannot-be-recovered', 'candidate-key-probe-bounded-to-128-nodes', 'no-backup-decompression-or-other-accounts'],
    };
    check();
    manifest.assessment=diagnosticAssessment(manifest.context,manifest.relationships,coverage);
    manifest.failures=failures;manifest.summaryOnly=true;manifest.complete=manifest.complete&&!failures.length&&!coverage.caseFoldCollisions;
    // SQL/cache were frozen synchronously at start. No quick/search/selectRoot/present or write entry is called.
    const nameInventory=await captureNameInventory(mediaRoot,{io});
    retainedInventory=nameInventory;captureCoverage.inventoryComplete=nameInventory.complete===true;
    const additional=await collectExtraNameSources({extraPaths,backupRoot,signal,io});
    retainedExtraSources=additional.sources;captureCoverage.extrasComplete=additional.complete===true;
    const selected=[...selectedNameSources.values()];
    for(const source of selected){
      const before=snapshots.get(source.locator);
      if(before)source.snapshot=before;
      if(source.readStatus!=='read'){source.complete=false;source.gaps.push({reason:'selected-log-'+source.readStatus});}
    }
    if(report.paths.logRootStatus!=='readable')selected.push({id:'selected-log-root',kind:'selected-log-root',complete:false,gaps:[{reason:'log-root-not-readable'}],records:[]});
    if(logDirectorySnapshot)selected.push({...newNameSource('selected-log-directory','selected-log-directory',logRoot),snapshot:logDirectorySnapshot,directory:true});
    const stable=await verifyNameSourceGroup(selected,{stat:baseIo.lstat});
    for(const source of selected){
      const supplied=additional.sources.find(item=>item.complete&&item.locator===source.locator&&JSON.stringify(item.snapshot)===JSON.stringify(source.snapshot));
      if(source.readStatus==='unsupported'&&supplied&&source.gaps.every(g=>g.reason==='selected-log-unsupported')){
        source.complete=true;source.gaps=[];source.coveredBy=supplied.id;
      }
    }
    if(!stable){
      const changed=selected.filter(s=>!s.directory&&s.gaps.some(g=>g.reason==='source-changed-after-read'||g.reason==='source-unavailable-after-read'));
      for(const source of changed){
        source.unstableRead=true;
        try{const retry=await collectExtraNameSources({extraPaths:[source.locator],signal,io});
          for(const replacement of retry.sources)replacement.id='retry-'+source.id;
          selected.push(...retry.sources);
        }catch{}
      }
    }
    const nameSources=boundNameSources([...frozenNameSources,...selected,...additional.sources]);
    captureCoverage.logsComplete=report.paths.logRootStatus==='readable'&&selected.every(source=>source.complete===true);
    if(report.stages.suspectedEncodingLines||coverage.candidateProbeLimitedEvents)nameSources.push({id:'log-format-coverage',complete:false,gaps:[{reason:'log-format-understanding-incomplete'}],records:[]});
    const nameRecovery=assessSongNames({inventory:nameInventory,sources:nameSources,mappingEntries});
    manifest.nameRecovery={schemaVersion:1,counts:nameRecovery.counts,inventoryComplete:nameRecovery.inventoryComplete,complete:nameRecovery.complete};
    manifest.complete=manifest.complete&&nameRecovery.complete;
    const detailPayload={...details.snapshot(),service:detailContext,failures,directories:details.snapshot().files.length?undefined:directories,
      nameEvidence:{schemaVersion:1,inventory:nameInventory,sources:nameSources,mappingEntries},nameRecovery};
    fitSongDetailBudget(detailPayload,manifest);
    const bundle = { format: 'linli-song-debug', schemaVersion: 3, manifest, diagnostics: report, material, verification };
    // Freeze a validated downloadable default before exposing ready; never defer a default format/size failure to download.
    const defaultArchive = encodeSongDebugPackage(bundle);
    return { bundle, sensitive, defaultArchive,details:detailPayload };
  } catch(caught) {
    if(!signal?.aborted)try{onEvidence({events:details.snapshot(),directories:structuredClone(directories),inventory:retainedInventory,
      coverage:captureCoverage,sources:boundNameSources([...selectedNameSources.values(),...retainedExtraSources]),capturedAt:Date.now()});}catch{}
    throw caught;
  } finally { events.length = 0; directories.length = 0; snapshots.clear(); readPaths.clear(); }
}

const jsonBytes = value => Buffer.byteLength(JSON.stringify(value) ?? 'null');
function omittedValue(value) {
  const json=JSON.stringify(value)??'null';
  return {omitted:true,reason:'package-budget',originalBytes:Buffer.byteLength(json),
    sha256:crypto.createHash('sha256').update(json).digest('hex')};
}
// Ancillary evidence is a bounded prefix with an explicit gap, never a silently truncated value.
function boundedEvidence(value,limit,depth=0){
  if(value==null||jsonBytes(value)<=limit)return value;
  if(typeof value!=='object'||depth>=8||limit<512)return omittedValue(value);
  if(Array.isArray(value)){
    const kept=[];let bytes=2;
    for(const item of value){
      const size=jsonBytes(item)+1;if(bytes+size>limit-512)break;kept.push(item);bytes+=size;
    }
    return {records:kept,complete:false,omitted:value.length-kept.length,
      omittedIndexRange:[kept.length,value.length-1],reason:'package-budget'};
  }
  const entries=Object.entries(value),out={};
  const each=Math.max(160,Math.floor((limit-512)/Math.max(1,entries.length)));
  for(const [key,item] of entries)out[key]=boundedEvidence(item,each,depth+1);
  return jsonBytes(out)<=limit?out:omittedValue(value);
}
function boundedRows(rows,limit,convert){
  const kept=[],omitted=[];let bytes=2;
  for(let i=0;i<rows.length;i++){
    const row=convert(rows[i],i),size=jsonBytes(row)+1;
    if(bytes+size<=limit-1024){kept.push(row);bytes+=size;}else omitted.push(i);
  }
  return {records:kept,coverage:{complete:false,originalCount:rows.length,retainedCount:kept.length,
    omittedCount:omitted.length,omittedIndexRanges:compactRanges(omitted),reason:'package-budget'}};
}
function compactRanges(indices){
  const ranges=[];for(const index of indices){const last=ranges.at(-1);if(last&&last[1]+1===index)last[1]=index;else ranges.push([index,index]);}
  // Pathological alternating oversized rows still cannot create unbounded coverage metadata.
  return ranges.length<=64?ranges:{first:ranges.slice(0,32),last:ranges.slice(-32),rangeCount:ranges.length,complete:false};
}
function cumulativeCoverage(current,previous){
  if(!previous)return current;
  return {...current,inputCount:current.originalCount,originalCount:previous.originalCount,
    omittedCount:(previous.omittedCount||0)+current.omittedCount,
    indexBasis:'this-pass-input; earlier omissions in budget.previousPasses'};
}
export function fitSongDetailBudget(details,manifest,maxBytes=DEBUG_LIMITS.detailBytes-1024*1024){
  if(jsonBytes(details)<=maxBytes)return;
  const inputBytes=jsonBytes(details),previousBudget=details.budget;
  const originalBytes=previousBudget?.originalBytes??inputBytes,
    originalFields=previousBudget?.originalFields??Object.fromEntries(Object.entries(details).map(([key,value])=>[key,jsonBytes(value)]));
  // First remove large duplicate event/file bodies only; a small existing name report need not change.
  for(const field of ['events','files','retainedCapture','directories']){
    if(jsonBytes(details[field])<=Math.floor(maxBytes*.15))continue;
    details.coverage={...details.coverage,complete:false,packageBudgetLimited:true,
      [field+'OmittedForNameEvidence']:{originalBytes:jsonBytes(details[field]),
        count:Array.isArray(details[field])?details[field].length:null,reason:'package-budget'}};
    details[field]=Array.isArray(details[field])?[]:null;
    manifest.complete=false;manifest.detailBudgetLimited=true;
    if(jsonBytes(details)<=maxBytes)return;
  }
  const report=details.nameRecovery,evidence=details.nameEvidence;
  // Keep independent per-song essentials before duplicate source bodies, file inventories and services.
  const songs=boundedRows(report?.songs||[],Math.floor(maxBytes*.44),song=>{
    const compact=compactSongNameResult(song);
    const candidates=boundedRows(compact.candidates,8192,c=>c);
    return {nameKey:compact.nameKey,currentName:compact.currentName,selectedName:compact.selectedName,
      status:candidates.coverage.omittedCount?'incomplete':compact.status,
      label:candidates.coverage.omittedCount?'检查未完成':compact.label,
      candidates:candidates.records,candidateCoverage:cumulativeCoverage(candidates.coverage,song.candidateCoverage),
      excludedCandidates:[],excludedCandidatesOmitted:compact.excludedCandidatesOmitted,
      files:[],filesOmitted:compact.filesOmitted,conflicts:(compact.conflicts||[]).slice(0,8),
      conflictsOmitted:(song.conflictsOmitted||0)+Math.max(0,(compact.conflicts||[]).length-8),preview:null,
      gaps:compact.gaps,relatedCoverageComplete:false,conclusionScope:'budget-limited-evidence-not-a-write-plan'};
  });
  const inventory=boundedRows(evidence?.inventory?.songs||[],Math.floor(maxBytes*.08),song=>({
    nameKey:song.nameKey,name:song.name,exclusion:song.exclusion,files:[],filesOmitted:(song.filesOmitted||0)+(song.files||[]).length}));
  const sourceRows=boundedRows(evidence?.sources||[],Math.floor(maxBytes*.12),source=>({
    id:source.id,kind:source.kind,locator:boundedEvidence(source.locator,1024),snapshot:boundedEvidence(source.snapshot,2048),
    complete:false,originalRecordCount:source.originalRecordCount??(source.records||[]).length,
    records:[],gaps:[{reason:'package-budget-source-body-omitted',originalGaps:boundedEvidence(source.gaps,1024)}]}));
  const replacement={schemaVersion:1,coverage:{complete:false,packageBudgetLimited:true},
    budget:{originalBytes,originalFields,inputBytes,limitBytes:maxBytes,policy:'per-song-names-and-source-links-first',
      previousPasses:previousBudget?[...(previousBudget.previousPasses||[]),{limitBytes:previousBudget.limitBytes,
        songCoverage:previousBudget.songCoverage,inventoryCoverage:previousBudget.inventoryCoverage,sourceCoverage:previousBudget.sourceCoverage}].slice(-4):[],
      songCoverage:cumulativeCoverage(songs.coverage,previousBudget?.songCoverage),
      inventoryCoverage:cumulativeCoverage(inventory.coverage,previousBudget?.inventoryCoverage),
      sourceCoverage:cumulativeCoverage(sourceRows.coverage,previousBudget?.sourceCoverage),
      note:'recordIndex and sourceNameKey refer to original source records; omitted bodies are not replayable. Retained rows are not a complete inventory or recovery plan.'},
    service:boundedEvidence(details.service,Math.floor(maxBytes*.12)),
    failures:boundedEvidence(details.failures,Math.floor(maxBytes*.01)),
    wait:boundedEvidence(details.wait,Math.floor(maxBytes*.01)),
    beforeWait:boundedEvidence(details.beforeWait,Math.floor(maxBytes*.01)),snapshotAt:details.snapshotAt,
    retainedCapture:boundedEvidence(details.retainedCapture,Math.floor(maxBytes*.02)),
    events:boundedEvidence(details.events,Math.floor(maxBytes*.02)),
    files:boundedEvidence(details.files,Math.floor(maxBytes*.01)),directories:boundedEvidence(details.directories,Math.floor(maxBytes*.01))};
  if(evidence)replacement.nameEvidence={schemaVersion:1,inventory:{root:boundedEvidence(evidence.inventory?.root,2048),
    complete:false,songs:inventory.records,gaps:[{reason:'package-budget',...inventory.coverage}]},
    sources:sourceRows.records,mappingEntries:boundedEvidence(evidence.mappingEntries,Math.floor(maxBytes*.02))};
  if(report){
    const counts={};for(const song of songs.records)counts[song.status]=(counts[song.status]||0)+1;
    replacement.nameRecovery={schemaVersion:1,algorithm:report.algorithm,capturedAt:report.capturedAt,readOnly:true,
      complete:false,inventoryComplete:false,counts,songs:songs.records,inventoryGaps:[{reason:'package-budget'}],
      sources:sourceRows.records.map(({records,...source})=>source),scope:'retained-budget-limited-song-evidence',
      readableComplete:false,readable:'诊断包达到容量限制；逐首保留名称与来源关联见 songs，省略范围见 details.budget。不可据此直接执行恢复。'};
  }
  // Fixed allocation leaves room for JSON framing and explicit omission metadata. Fail closed if violated.
  if(jsonBytes(replacement)>maxBytes)throw error('DEBUG_DETAIL_BUDGET_FAILED',413);
  for(const key of Object.keys(details))delete details[key];Object.assign(details,replacement);
  manifest.complete=false;manifest.detailBudgetLimited=true;
  if(replacement.nameRecovery)manifest.nameRecovery={schemaVersion:1,counts:replacement.nameRecovery.counts,complete:false,inventoryComplete:false};
}

export function minimalDebugPackage(input,cause){
  const diagnostics=new ScanDiagnostics();diagnostics.finish('SCAN_FAILED');const report=diagnostics.snapshot().report;
  const timeout=cause?.code==='DEBUG_WAIT_TIMEOUT';
  const failures=[...(input.failures||[]),...(!timeout?[diagnosticError(cause,'capture-failure')]:[])];
  const bundle={format:'linli-song-debug',schemaVersion:3,manifest:{scanId:report.scanId,createdAt:new Date().toISOString(),sourceVersion:SERVICE_VERSION,minimal:true,summaryOnly:true,complete:false,scope:'available-components-only',context:input.context||{available:false},failures,coverage:{rawEligibleEvents:0,rawOmittedEvents:0}},diagnostics:report,material:{events:[],directories:[],mappings:[]},verification:{events:[],scope:'not-captured'}};
  const sources=boundNameSources([...(input.frozenNameSources||[]),...(input.retained?.sources||[])]);
  const rows=new Map();
  const sameRoot=value=>String(value||'').replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase()===String(input.mediaRoot||'').replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase();
  for(const source of sources.filter(s=>/db-songs$|db-cache$/.test(s.kind||'')))for(const row of source.records||[]){
    if(row.nameKey&&sameRoot(row.root)&&!rows.has(row.nameKey))rows.set(row.nameKey,{nameKey:row.nameKey,root:row.root,
      files:row.files||[],name:row.customName||row.name,basis:'frozen-index-not-live-directory'});
  }
  for(const row of input.retained?.directories||[])if(!rows.has(row.key))rows.set(row.key,{nameKey:row.key,root:input.mediaRoot,
    files:row.files.map(fileName=>({fileName})),basis:'observed-prefix-not-complete-directory'});
  if(input.retained?.inventory?.songs)for(const row of input.retained.inventory.songs)rows.set(row.nameKey,row);
  const coverage=input.retained?.coverage||{},gaps=[{reason:'partial-diagnostic-capture'}];
  for(const [key,label] of [['inventoryComplete','live-directory'],['logsComplete','logs'],['extrasComplete','backups-and-extra-sources']])
    if(!coverage[key])gaps.push({reason:label+(input.retained?'-coverage-not-established':'-not-checked')});
  const inventory={root:input.mediaRoot,songs:[...rows.values()].slice(0,10000),complete:false,
    basis:'frozen-index-and-any-observed-prefix-not-live-inventory',
    observedCoverage:coverage,gaps};
  if(rows.size>10000)inventory.gaps.push({reason:'partial-inventory-budget'});
  const nameEvidence={schemaVersion:1,inventory,sources,mappingEntries:input.mappingEntries||[]};
  const nameRecovery=assessSongNames(nameEvidence);
  for(const song of nameRecovery.songs)if(song.preview){song.preview.applicable=false;song.preview.prerequisites.push('verify-live-state-after-partial-capture');}
  nameRecovery.complete=false;
  const partialText=renderSongNameReport(nameRecovery);nameRecovery.readableComplete=partialText.length<=250000;
  nameRecovery.readable='部分排障信息：只覆盖明确已取得资料，未完成项见逐首缺口；不是无法恢复名单。\n'+partialText.slice(0,250000);
  bundle.manifest.partialReason=timeout?'wait-timeout':'capture-unavailable';
  bundle.manifest.nameRecovery={schemaVersion:1,counts:nameRecovery.counts,complete:false,inventoryComplete:false};
  const details={schemaVersion:1,service:input.detailContext,failures,coverage:{complete:false,reason:'capture-unavailable'},nameEvidence,nameRecovery,
    retainedCapture:input.retained?.events||null,snapshotAt:input.snapshotAt??input.detailContext?.capturedAt??null};
  fitSongDetailBudget(details,bundle.manifest);
  for(const song of details.nameRecovery.songs)if(song.preview){song.preview.applicable=false;
    if(!song.preview.prerequisites.includes('verify-live-state-after-partial-capture'))song.preview.prerequisites.push('verify-live-state-after-partial-capture');}
  details.nameRecovery.readable='部分排障信息：须重新核对实时资料，不可直接执行恢复计划。\n'+renderSongNameReport(details.nameRecovery).slice(0,250000);
  return{bundle,sensitive:[],details,defaultArchive:encodeSongDebugPackage(bundle)};
}

export function encodeSongDebugPackage(bundle) {
  validateReplayMaterial(bundle.material);
  if(bundle.details&&jsonBytes(bundle.details)>DEBUG_LIMITS.detailBytes)throw error('DEBUG_DETAILS_TOO_LARGE',413);
  if(bundle.manifest.context&&Buffer.byteLength(JSON.stringify(bundle.manifest.context))>65536)throw error('DEBUG_CONTEXT_TOO_LARGE',413);
  const json = Buffer.from(JSON.stringify(bundle));
  if (json.length > DEBUG_LIMITS.decodedBytes) throw error('DEBUG_PACKAGE_TOO_LARGE', 413);
  const buffer = gzipSync(json, { level: 1 });
  if (buffer.length > DEBUG_LIMITS.packageBytes) throw error('DEBUG_PACKAGE_TOO_LARGE', 413);
  // Validate exactly the emitted bytes with the consumer, not just an estimated JSON size.
  if(bundle.details)readDetailedEvidence(buffer,{confirmSensitive:true});else decodeDebugPackage(buffer);
  return buffer;
}

function prepareDownloadArchives(snapshot){
  fitSongDetailBudget(snapshot.details,snapshot.bundle.manifest);
  const detailed={...snapshot.bundle,manifest:{...snapshot.bundle.manifest,summaryOnly:false,sensitivity:'SENSITIVE-PRIVATE-SHARING-ONLY'},
    sensitive:snapshot.sensitive,details:snapshot.details};
  try{snapshot.detailedArchive=encodeSongDebugPackage(detailed);}catch(caught){
    if(!['DEBUG_PACKAGE_TOO_LARGE','DEBUG_DETAILS_TOO_LARGE'].includes(caught.message))throw caught;
    detailed.manifest.summaryMaterialOmittedForDetailedBudget=true;detailed.manifest.complete=false;
    detailed.manifest.omittedReplayMaterial={events:detailed.material.events.length,directories:detailed.material.directories.length,
      mappings:detailed.material.mappings.length,sensitive:detailed.sensitive.length,reason:'package-budget'};
    detailed.material={events:[],directories:[],mappings:[]};detailed.sensitive=[];
    detailed.verification={events:[],scope:'summary-replay-omitted-for-detailed-budget'};
    // A second fixed, conservative ceiling bounds both uncompressed and incompressible output.
    fitSongDetailBudget(detailed.details,detailed.manifest,4*1024*1024);
    snapshot.detailedArchive=encodeSongDebugPackage(detailed);
  }
  if(detailed.manifest.detailBudgetLimited){snapshot.bundle.manifest.complete=false;
    snapshot.bundle.manifest.detailBudgetLimited=true;snapshot.bundle.manifest.nameRecovery=detailed.manifest.nameRecovery;}
  snapshot.defaultArchive=encodeSongDebugPackage(snapshot.bundle);
}

export class SongDebugPackageManager {
  constructor({ collect = collectSongDebugPackage, ttlMs = DEBUG_LIMITS.ttlMs, waitMs=60000, pollMs=100,
    now=()=>Date.now(), sleep=(ms,signal)=>waitDelay(ms,undefined,{signal}) } = {}) {
    this.collect=collect;this.ttlMs=ttlMs;this.waitMs=waitMs;this.pollMs=pollMs;this.now=now;this.sleep=sleep;this.job=null;
  }
  hasPriority(){return this.job?.priorityHeld===true;}
  allowsRefresh(ticket){return Boolean(ticket&&this.hasPriority()&&this.job.admittedRefresh===ticket);}
  allowsVisual(token){return Boolean(token&&this.hasPriority()&&this.job.admittedVisual===token);}
  reuse(input){
    const job=this.job;
    return job&&job.root===input.mediaRoot&&(job.input?.requestId??null)===(input.requestId??null)&&JSON.stringify(job.input?.extraPaths||[])===JSON.stringify(input.extraPaths||[])?
      {jobId:job.id,state:job.state}:null;
  }
  release(job,reason){
    if(!job.priorityHeld)return;
    job.priorityHeld=false;job.wait.releasedAt=this.now();job.wait.releaseReason=reason;
    try{job.input?.releasePriority?.(reason);}catch(caught){job.wait.releaseError=diagnosticError(caught,'diagnostic-release');}
  }
  clear(reason='cancelled') {
    if (!this.job) return;
    const job=this.job;
    job.controller.abort();clearTimeout(job.timer);this.release(job,reason);
    job.snapshot=null;job.retained=null;job.latestInput=null;job.admittedRefresh=null;job.admittedVisual=null;
    job.confirmationId=null;job.state='cancelled';job.input=null;this.job=null;
  }
  start(input) {
    const reused=this.reuse(input);if(reused)return reused;
    this.clear(this.job?.root===input.mediaRoot?'superseded':'root-changed');
    const job = { id: crypto.randomUUID(), root: input.mediaRoot, state: 'waiting', controller: new AbortController(), progress: 0,
      input,snapshot:null,retained:null,wait:{requestedAt:this.now(),cycles:0,observedWaitMs:0,observations:[],beforeSnapshotAt:input.snapshotAt??null} };
    this.job = job;
    job.timer=setTimeout(()=>{if(this.job===job)this.clear('expired');},this.ttlMs);job.timer.unref?.();
    job.promise=this.run(job);
    return { jobId: job.id, state: job.state };
  }
  observe(job,reasons){
    const signature=JSON.stringify(reasons),last=job.wait.observations.at(-1);
    if(last?.signature===signature)return;
    if(job.wait.observations.length>=32){job.wait.observations.shift();job.wait.omittedObservations=(job.wait.omittedObservations||0)+1;}
    job.wait.observations.push({at:this.now(),reasons,signature});
  }
  waitSummary(job){
    const {observations,...summary}=job.wait;
    return {...summary,observations:observations.map(item=>({at:item.at,reasons:item.reasons.map(reason=>reason.kind)}))};
  }
  finish(job,snapshot){
    this.release(job,'ready');
    job.wait.finishedAt=this.now();
    snapshot.bundle.manifest.wait=this.waitSummary(job);
    snapshot.details??={schemaVersion:1,coverage:{complete:false}};
    snapshot.details.wait={...job.wait,observations:job.wait.observations.map(({signature,...item})=>item)};
    if(job.wait.hasObservedBusy)snapshot.details.beforeWait={snapshotAt:job.input.snapshotAt??null,context:job.input.context||null,
      sourceSnapshots:(job.input.frozenNameSources||[]).map(source=>({id:source.id,kind:source.kind,snapshot:source.snapshot??null,records:source.records?.length||0}))};
    fitSongDetailBudget(snapshot.details,snapshot.bundle.manifest);
    if(snapshot.bundle.manifest.minimal&&snapshot.details.nameRecovery){
      for(const song of snapshot.details.nameRecovery.songs)if(song.preview){song.preview.applicable=false;
        if(!song.preview.prerequisites.includes('verify-live-state-after-partial-capture'))song.preview.prerequisites.push('verify-live-state-after-partial-capture');}
      const text=renderSongNameReport(snapshot.details.nameRecovery);
      snapshot.details.nameRecovery.readableComplete=text.length<=250000;
      snapshot.details.nameRecovery.readable='部分排障信息：实时条件仍需核对，不能直接执行恢复计划。\n'+text.slice(0,250000);
    }
    prepareDownloadArchives(snapshot);
    job.snapshot=snapshot;job.state='ready';job.confirmationId=crypto.randomBytes(24).toString('base64url');
  }
  async run(job){
    const original=job.input,roundStart=this.now(),previousWait=job.wait.observedWaitMs;
    job.wait.cycles++;job.wait.deadline=roundStart+this.waitMs;job.wait.timedOut=false;job.priorityHeld=true;
    let input=original,observedThisRound=false;
    try{
      job.admittedRefresh=original.existingRefresh?.()||null;job.admittedVisual=original.existingVisual?.()||null;
      let reasons=original.externalBusy?.()||[];
      this.observe(job,reasons);
      while(reasons.length){
        observedThisRound=true;job.state='waiting';job.wait.hasObservedBusy=true;job.wait.observedWaitMs=previousWait+Math.max(0,this.now()-roundStart);
        if(this.now()>=job.wait.deadline){
          job.wait.timedOut=true;job.state='awaiting-choice';
          job.snapshot=minimalDebugPackage({...input,retained:job.retained},{code:'DEBUG_WAIT_TIMEOUT'});
          this.release(job,'wait-timeout');return;
        }
        await this.sleep(Math.max(1,Math.min(this.pollMs,job.wait.deadline-this.now())),job.controller.signal);
        if(this.job!==job||job.controller.signal.aborted)return;
        reasons=original.externalBusy?.()||[];this.observe(job,reasons);
      }
      job.wait.observedWaitMs=previousWait+(observedThisRound?Math.max(0,this.now()-roundStart):0);
      job.wait.externalBusyClearedAt=job.wait.hasObservedBusy?this.now():null;
      if(job.wait.hasObservedBusy&&original.refreshSnapshot){
        const fresh=original.refreshSnapshot();
        input={...original,...fresh,frozenNameSources:[...(fresh.frozenNameSources||[]),
          ...(original.frozenNameSources||[]).map(source=>({...source,id:'before-wait/'+source.id,kind:'before-wait/'+source.kind}))]};
        job.wait.afterSnapshotAt=fresh.snapshotAt??this.now();
      }
      job.latestInput=input;job.state='collecting';
      const snapshot=input.minimalOnly?minimalDebugPackage(input,{code:'DEBUG_CAPTURE_BUSY'}):await this.collect({...input,
        signal:job.controller.signal,onEvidence:retained=>{if(this.job===job&&!job.controller.signal.aborted)job.retained=retained;},
        onProgress:progress=>{if(this.job===job&&!job.controller.signal.aborted){job.state=progress.phase;job.progress=progress.retainedEvents;}}
      });
      if(this.job===job&&!job.controller.signal.aborted)this.finish(job,snapshot);
    }catch(caught){
      if(this.job===job&&!job.controller.signal.aborted){
        try{this.finish(job,minimalDebugPackage({...input,retained:job.retained},caught));}
        catch(fallback){this.release(job,'failed');job.state='failed';job.failureCode='DEBUG_CAPTURE_FAILED';}
      }
    }
  }
  continue(input){
    const job=this.current(input);
    if(job.state!=='awaiting-choice')throw error('DEBUG_NOT_WAITING_FOR_CHOICE',409);
    job.confirmationId=null;job.state='waiting';job.promise=this.run(job);return{jobId:job.id,state:job.state};
  }
  partial(input){
    const job=this.current(input);
    if(job.state!=='awaiting-choice')throw error('DEBUG_NOT_WAITING_FOR_CHOICE',409);
    this.finish(job,job.snapshot||minimalDebugPackage({...job.input,retained:job.retained},{code:'DEBUG_WAIT_TIMEOUT'}));
    return this.status(input);
  }
  current({ jobId, mediaRoot }) {
    if (!this.job || this.job.id !== jobId || this.job.root !== mediaRoot) throw error('DEBUG_SNAPSHOT_EXPIRED', 409);
    return this.job;
  }
  status(input) {
    const job = this.current(input), snapshot = job.snapshot;
    return { jobId: job.id, state: job.state, retainedEvents: job.progress, wait:this.waitSummary(job), ...(job.state === 'failed' ? { failureCode: job.failureCode } : {}), ...(snapshot ? {
      scanId: snapshot.bundle.manifest.scanId, confirmationId: job.confirmationId,
      minimal:snapshot.bundle.manifest.minimal===true,detailsAvailable:Boolean(snapshot.details),
      nameRecovery:snapshot.bundle.manifest.nameRecovery||null,
      rawEligibleEvents: snapshot.bundle.manifest.coverage.rawEligibleEvents, rawRetainedEvents: snapshot.sensitive.length,
      rawOmittedEvents: snapshot.bundle.manifest.coverage.rawOmittedEvents,
      fragmentOmissions: snapshot.bundle.manifest.coverage.fragmentOmissions || {}, fragmentPolicy: FRAGMENT_POLICY,
      rawSources: snapshot.sensitive.map(item => item.source), complete: snapshot.bundle.manifest.complete,
      lossyEvents: snapshot.bundle.verification.events.filter(item => item.status !== 'equivalent').length,
    } : {}) };
  }
  download(input) {
    const job = this.current(input);
    if (job.state !== 'ready' || !job.snapshot || input.scanId !== job.snapshot.bundle.manifest.scanId) throw error('DEBUG_SNAPSHOT_NOT_READY', 409);
    if (typeof input.includeRaw !== 'boolean' || (input.confirmSensitive !== undefined && typeof input.confirmSensitive !== 'boolean') ||
      input.includeRaw && (input.confirmSensitive !== true || input.confirmationId !== job.confirmationId)) throw error('DEBUG_RAW_REQUIRES_EXPLICIT_CONFIRMATION', 403);
    const bundle = job.snapshot.bundle;
    const bytes=input.includeRaw?job.snapshot.detailedArchive:job.snapshot.defaultArchive;
    const result = { scanId: bundle.manifest.scanId, fileName: `linli-song-debug-${input.includeRaw ? 'SENSITIVE-' : ''}${bundle.manifest.scanId}.json.gz`,
      mimeType: 'application/gzip', base64: bytes.toString('base64'), bytes: bytes.length };
    // HTTP completion and a browser click cannot prove that the player saved the file.
    // Keep the immutable, prevalidated bytes until an explicit lifecycle boundary or TTL.
    return result;
  }
  cancel(input) {
    // An exact job id remains cancellable after the selected root changes.
    if (!this.job || this.job.id !== input.jobId) throw error('DEBUG_SNAPSHOT_EXPIRED', 409);
    this.clear(); return { cancelled: true };
  }
}
