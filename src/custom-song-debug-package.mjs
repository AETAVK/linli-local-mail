import crypto from 'node:crypto';
import fs from 'node:fs';
import { setImmediate as yieldTurn } from 'node:timers/promises';
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
import {assessSongNames} from './custom-song-name-recovery.mjs';
import { diagnosticError } from './diagnostic-errors.mjs';
import path from 'node:path';
import { DEBUG_LIMITS, replayMaterial, eventInvariant, songInvariants, replayRuntimeIdentity, validateReplayMaterial } from './custom-song-debug-replay.mjs';

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

export async function collectSongDebugPackage({ mediaRoot, logRoot, logRootSource = 'custom', mappingEntries = [], context = null, detailContext = null, failures = [], frozenNameSources = [], extraPaths = [], backupRoot, io = {}, signal, onProgress = () => {}, limits = {} }) {
  const budget = { ...DEBUG_LIMITS, ...limits };
  const diagnostics = new ScanDiagnostics({ mediaRoot, logRoot, logRootSource: logRootSource === 'default' ? 'default' : 'custom', patchVersion: SERVICE_VERSION });
  const events = [], directories = [], fileOrders = new Map();
  const details=new DetailedSongEvidence(),categoryCounts={};let order=0;
  const selectedNameSources=new Map();let nameBytes=0,logDirectorySnapshot=null;
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
    const additional=await collectExtraNameSources({extraPaths,backupRoot,signal,io});
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
  } finally { events.length = 0; directories.length = 0; snapshots.clear(); readPaths.clear(); }
}

export function fitSongDetailBudget(details,manifest,maxBytes=15*1024*1024){
  const size=()=>Buffer.byteLength(JSON.stringify(details));
  if(size()<=maxBytes)return;
  manifest.complete=false;manifest.detailBudgetLimited=true;
  details.coverage={...details.coverage,complete:false,packageBudgetLimited:true};
  for(const field of ['events','files']){
    if(size()<=maxBytes)return;
    details.coverage[field+'OmittedForNameEvidence']=(details[field]||[]).length;details[field]=[];
  }
  for(const [key,component] of Object.entries(details.service?.components||{})){
    if(size()<=maxBytes)return;
    details.service.components[key]={available:false,reason:'package-budget',recordsOmitted:component.records?.length||0};
    details.service.coverage={...details.service.coverage,complete:false};
  }
  if(size()>maxBytes&&details.nameEvidence){
    const evidence=details.nameEvidence;
    evidence.sources=boundNameSources(evidence.sources,Math.max(1024,Math.floor(maxBytes/8)));
    details.nameRecovery=assessSongNames(evidence);
    manifest.nameRecovery={schemaVersion:1,counts:details.nameRecovery.counts,complete:false,inventoryComplete:evidence.inventory.complete};
  }
}

export function minimalDebugPackage(input,cause){
  const diagnostics=new ScanDiagnostics();diagnostics.finish('SCAN_FAILED');const report=diagnostics.snapshot().report;
  const failures=[...(input.failures||[]),diagnosticError(cause,'capture-failure')];
  const bundle={format:'linli-song-debug',schemaVersion:3,manifest:{scanId:report.scanId,createdAt:new Date().toISOString(),sourceVersion:SERVICE_VERSION,minimal:true,summaryOnly:true,complete:false,scope:'available-components-only',context:input.context||{available:false},failures,coverage:{rawEligibleEvents:0,rawOmittedEvents:0}},diagnostics:report,material:{events:[],directories:[],mappings:[]},verification:{events:[],scope:'not-captured'}};
  return{bundle,sensitive:[],details:{schemaVersion:1,service:input.detailContext,failures,coverage:{complete:false,reason:'capture-unavailable'}},defaultArchive:encodeSongDebugPackage(bundle)};
}

export function encodeSongDebugPackage(bundle) {
  validateReplayMaterial(bundle.material);
  if(bundle.manifest.context&&Buffer.byteLength(JSON.stringify(bundle.manifest.context))>65536)throw error('DEBUG_CONTEXT_TOO_LARGE',413);
  const json = Buffer.from(JSON.stringify(bundle));
  if (json.length > DEBUG_LIMITS.decodedBytes) throw error('DEBUG_PACKAGE_TOO_LARGE', 413);
  const buffer = gzipSync(json, { level: 1 });
  if (buffer.length > DEBUG_LIMITS.packageBytes) throw error('DEBUG_PACKAGE_TOO_LARGE', 413);
  return buffer;
}

export class SongDebugPackageManager {
  constructor({ collect = collectSongDebugPackage, ttlMs = DEBUG_LIMITS.ttlMs } = {}) { this.collect = collect; this.ttlMs = ttlMs; this.job = null; }
  clear() {
    if (!this.job) return;
    this.job.controller.abort(); clearTimeout(this.job.timer); this.job.snapshot = null;
    this.job.confirmationId = null; this.job.state = 'cancelled'; this.job = null;
  }
  start(input) {
    if (this.job && ['collecting', 'verifying'].includes(this.job.state)) throw error('DEBUG_CAPTURE_BUSY', 409);
    this.clear();
    const job = { id: crypto.randomUUID(), root: input.mediaRoot, state: 'collecting', controller: new AbortController(), progress: 0 };
    this.job = job;
    job.timer = setTimeout(() => { if (this.job === job) this.clear(); }, this.ttlMs); job.timer.unref?.();
    job.promise = (input.minimalOnly?Promise.resolve(minimalDebugPackage(input,{code:'DEBUG_CAPTURE_BUSY'})):this.collect({ ...input, signal: job.controller.signal, onProgress: progress => {
      if (this.job === job) { job.state = progress.phase; job.progress = progress.retainedEvents; }
    } })).then(snapshot => {
      if (this.job !== job || job.controller.signal.aborted) return;
      job.snapshot = snapshot; job.state = 'ready'; job.confirmationId = crypto.randomBytes(24).toString('base64url');
    }).catch(caught => { if (this.job === job) {
      job.snapshot=minimalDebugPackage(input,caught);job.state='ready';job.confirmationId=crypto.randomBytes(24).toString('base64url');
    } });
    return { jobId: job.id, state: job.state };
  }
  current({ jobId, mediaRoot }) {
    if (!this.job || this.job.id !== jobId || this.job.root !== mediaRoot) throw error('DEBUG_SNAPSHOT_EXPIRED', 409);
    return this.job;
  }
  status(input) {
    const job = this.current(input), snapshot = job.snapshot;
    return { jobId: job.id, state: job.state, retainedEvents: job.progress, ...(job.state === 'failed' ? { failureCode: job.failureCode } : {}), ...(snapshot ? {
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
    const bundle = structuredClone(job.snapshot.bundle);
    if (input.includeRaw) { bundle.sensitive = job.snapshot.sensitive;bundle.details=job.snapshot.details;bundle.manifest.summaryOnly=false;bundle.manifest.sensitivity = 'SENSITIVE-PRIVATE-SHARING-ONLY'; }
    let bytes;
    try{bytes=!input.includeRaw&&job.snapshot.defaultArchive?job.snapshot.defaultArchive:encodeSongDebugPackage(bundle);}catch(caught){
      if(!input.includeRaw)throw caught;
      bundle.material={events:[],directories:[],mappings:[]};bundle.sensitive=[];bundle.manifest.summaryMaterialOmittedForDetailedBudget=true;bundle.manifest.complete=false;
      bytes=encodeSongDebugPackage(bundle);
    }
    const result = { scanId: bundle.manifest.scanId, fileName: `linli-song-debug-${input.includeRaw ? 'SENSITIVE-' : ''}${bundle.manifest.scanId}.json.gz`,
      mimeType: 'application/gzip', base64: bytes.toString('base64'), bytes: bytes.length };
    this.clear(); return result;
  }
  cancel(input) {
    // An exact job id remains cancellable after the selected root changes.
    if (!this.job || this.job.id !== input.jobId) throw error('DEBUG_SNAPSHOT_EXPIRED', 409);
    this.clear(); return { cancelled: true };
  }
}
