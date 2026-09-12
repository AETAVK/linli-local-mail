import path from 'node:path';
import { SERVICE_VERSION } from './constants.mjs';
import { VISION_ALGORITHM, VISION_POLICY } from './custom-song-vision-policy.mjs';
import { diagnosticReason,diagnosticCode } from './diagnostic-errors.mjs';

const count = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 100000000) : 0;
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value < 4000000000000 ? value : null;
const fixed = (value, values) => values.includes(value) ? value : 'unknown';
const optionalBool = value => typeof value === 'boolean' ? value : null;
const period = value => ['TOD12', 'TOD1730', 'TOD20'].includes(value);
const JOB_STATES = ['queued','running','waiting-environment','paused','interrupted','completed','stopped','undone'];
const ITEM_STATES = ['pending','claimed','saved','review','missing','failed','skipped','stopped','undone'];
const REASONS = ['protected-manual','protected-mapping','protected-original','already-labelled','missing-file','conflict','duplicate-period','unfamiliar-scene','unclear-frames','frame-conflict','file-or-mapping-changed','media-error','timeout','environment','unsupported','hidden','decoder-disconnected','auto-disabled','service-restarted','manual-priority','stopped-or-undone','stopped-by-user','undone-by-user','conflict-or-too-many-files','visual-inference'];
const ENDPOINTS = ['vision/status','vision/start','vision/claim','vision/submit','vision/heartbeat','vision/control','vision/undo','vision/locate','catalog/search','catalog/status','music/preferences','mapping/import','mapping/export','folder/choose','catalog/scan'];
const OPERATIONS = ['status','start','claim','submit','heartbeat','control','undo','locate','prepare','refresh','pause','resume','stop','release','disconnect','environment','save','read'];
export function safeFrontendEvidence(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { available: false, reason: 'not-supplied' };
  const failures = list => (Array.isArray(list) ? list.slice(-16) : []).map(item => ({
    endpoint: fixed(item?.endpoint, ENDPOINTS), operation: fixed(item?.operation, OPERATIONS),
    httpStatus: Number.isInteger(item?.httpStatus) && item.httpStatus >= 100 && item.httpStatus <= 599 ? item.httpStatus : 0,
    category: fixed(item?.category, ['busy','access-denied','invalid-request','invalid-response','rate-limited','service-error','unknown-no-status','client-error']),
    scope: fixed(item?.scope,['current','previous']),phase:diagnosticReason(item?.phase),code:diagnosticCode(item?.code),sqliteCode:Number.isInteger(item?.sqliteCode)&&item.sqliteCode>=0&&item.sqliteCode<=65535?item.sqliteCode:null,
    errno:Number.isInteger(item?.errno)&&Math.abs(item.errno)<10000000?item.errno:null,
    at: timestamp(item?.at), durationMs: Math.min(count(item?.durationMs), 300000),
    ...(Number.isSafeInteger(item?.recoveredAt) ? { recoveredAt: timestamp(item.recoveredAt) } : {})
  }));
  const capabilities = {};
  for (const key of ['visible','canvas','rvfc']) capabilities[key] = optionalBool(input.capabilities?.[key]);
  return { available: true, trust: 'frontend-self-report',
    build:input.build&&/^[a-f0-9]{64}$/.test(input.build.sha256)&&/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(input.build.version)?{version:input.build.version,sha256:input.build.sha256,basis:'declared-by-running-script-not-independent-attestation'}:null,
    browserVersions:typeof input.userAgent==='string'?(input.userAgent.slice(0,512).match(/(?:Chrome|Chromium|CEF|Electron)\/[\d.]+/g)||[]):[],
    scriptRevision: input.scriptRevision === 'song-diagnostics-2026-09-11' ? input.scriptRevision : 'unknown',
    historyScope: 'current-renderer-memory-only', startedAt: timestamp(input.startedAt), capturedAt: timestamp(input.capturedAt),
    capabilities, autoEnabled: optionalBool(input.autoEnabled), environmentHold: optionalBool(input.environmentHold), decoding: optionalBool(input.decoding),
    currentFailures: failures(input.currentFailures).slice(-8), recentFailures: failures(input.recentFailures) };
}

function rootEvidence(values) {
  const labels = new Map(), roots = {}, relationships = [];
  const valid = value => typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value) && !value.includes('\0');
  const normalized = value => path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
  const entries = Object.entries(values).filter(([, value]) => valid(value));
  for (const [role,value] of Object.entries(values)) {
    if (!valid(value)) { roots[role] = { present: false, alias: null }; continue; }
    const key = normalized(value); if (!labels.has(key)) labels.set(key, `root-${labels.size + 1}`);
    roots[role] = { present: true, alias: labels.get(key),source:role==='official'?'frontend-self-report':role==='requested'?'request-value':'service-observed' };
  }
  for (let i=0;i<entries.length;i++) for(let j=i+1;j<entries.length;j++) relationships.push({
    left: entries[i][0], right: entries[j][0], rawEqual: entries[i][1] === entries[j][1], normalizedEqual: normalized(entries[i][1]) === normalized(entries[j][1]) });
  return { normalization: 'windows-lexical-not-realpath', roots, relationships, doesNotProveMigration: true };
}

// Synchronous read-only snapshot BEFORE the capture manager becomes busy. Never call status/reap/search/present.
export function captureDebugContext(catalog, input, mappingEntries) {
  const capturedAt = Date.now(), gaps = [], db = catalog.db;
  const setting = key => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
  const root = input.mediaRoot;
  const values = { requested: input.requestedRoot, selected: root, persisted: setting('customSongs.mediaRoot'),
    official: input.officialRoot, default: catalog.defaultRoot, indexed: catalog.scannedRoot, refreshing: catalog.refresh?.root };
  const indexRoots = db.prepare('SELECT root,COUNT(*) AS n FROM custom_songs GROUP BY root LIMIT 17').all();
  indexRoots.slice(0,16).forEach((row,index) => { values[`index-${index + 1}`] = row.root; });
  const paths = rootEvidence(values);
  const rows = db.prepare('SELECT name_key,CASE WHEN length(files_json)<=65536 THEN files_json END AS files_json,CASE WHEN length(overrides_json)<=65536 THEN overrides_json END AS overrides_json FROM custom_songs WHERE root=? AND available=1 LIMIT 1001').all(root);
  const index = { rowCount: db.prepare('SELECT COUNT(*) AS n FROM custom_songs WHERE root=? AND available=1').get(root).n,
    sampledRows: Math.min(rows.length,1000), files: 0, periodLabels: 0, byEvidence: {}, protectedIndicators: {}, policyStale: 0,
    liveRevisionValidity: 'not-checked', eligibility: 'stored-indicators-only-not-live-eligibility', omittedRows: 0, skippedRows:0,omittedFiles:0, omittedBytes: false };
  index.omittedRows=Math.max(0,index.rowCount-index.sampledRows);
  index.namedRows=db.prepare("SELECT COUNT(*) AS n FROM custom_songs WHERE root=? AND available=1 AND trim(COALESCE(NULLIF(custom_name,''),name,''))<>'' AND COALESCE(NULLIF(custom_name,''),name)<>name_key").get(root).n;
  index.unnamedOrDirectoryRows=Math.max(0,index.rowCount-index.namedRows);
  let bytes=0;
  for (const row of rows.slice(0,1000)) {
    if (typeof row.files_json!=='string'||typeof row.overrides_json!=='string'||(bytes += Buffer.byteLength(row.files_json)+Buffer.byteLength(row.overrides_json)) > 8*1024*1024) { index.omittedBytes=true;index.skippedRows++;continue; }
    let files,overrides;try{files=JSON.parse(row.files_json);overrides=JSON.parse(row.overrides_json);}catch{gaps.push('invalid-index-json');continue;}
    if (!Array.isArray(files)) continue;
    index.omittedFiles+=Math.max(0,files.length-32);
    for(const file of files.slice(0,32)) {
      if(!file||typeof file!=='object'||Array.isArray(file)){gaps.push('invalid-index-file');continue;}
      index.files++;if(period(file.tod))index.periodLabels++;
      const evidence=fixed(file.evidence,['original','manual','mapping','inferred','legacy','vision','vision-pending','unknown']);
      index.byEvidence[evidence]=(index.byEvidence[evidence]||0)+1;
      const reason=Object.hasOwn(overrides||{},file.fileName)||file.manualUnknown||file.mappingManual?'protected-manual':file.conflict?'conflict':evidence==='original'?'protected-original':period(file.tod)?'already-labelled':'unknown';
      index.protectedIndicators[reason]=(index.protectedIndicators[reason]||0)+1;
      if(evidence==='vision'&&(file.vision?.algorithm!==VISION_ALGORITHM||file.vision?.policy!==VISION_POLICY))index.policyStale++;
    }
  }
  const tasks=[];
  for (const job of db.prepare('SELECT id,status,mode,reason FROM song_vision_jobs WHERE root=? ORDER BY created_at DESC LIMIT 32').all(root)) {
    const counts={}, reasons={};
    for(const group of db.prepare('SELECT state,reason,COUNT(*) AS n FROM song_vision_items WHERE job_id=? GROUP BY state,reason').all(job.id)) {
      const state=fixed(group.state,ITEM_STATES), reason=diagnosticReason(group.reason);counts[state]=(counts[state]||0)+group.n;reasons[reason]=(reasons[reason]||0)+group.n;
    }
    tasks.push({ alias:`task-${tasks.length+1}`,status:fixed(job.status,JOB_STATES),mode:fixed(job.mode,['auto','manual']),reason:diagnosticReason(job.reason),counts,reasons });
  }
  const refresh=catalog.refresh?.states?.get(root);
  const mapping = { entries: mappingEntries.length, names:0, periodLabels:0, byEvidence:{}, validity:'stored-labels-not-proof-of-correctness' };
  for(const entry of mappingEntries.slice(0,20000)) {
    if(typeof entry.name==='string'&&entry.name.trim())mapping.names++;
    if(period(entry.tod))mapping.periodLabels++;
    const evidence=fixed(entry.automatic?.evidence,['original','manual','mapping','inferred','legacy','vision','unknown']);mapping.byEvidence[evidence]=(mapping.byEvidence[evidence]||0)+1;
  }
  if(indexRoots.length>16)gaps.push('index-roots-truncated');if(index.omittedRows||index.omittedBytes||index.omittedFiles)gaps.push('index-evidence-truncated');
  return { schemaVersion:1,capturedAt,basis:'before-debug-capture-read-only',frontend:safeFrontendEvidence(input.frontend),
    service:{version:SERVICE_VERSION,startedAt:catalog.diagnosticStartedAt||null,historyScope:'current-service-memory-only',autoEnabled:catalog.visionTasks.enabled(),
      busyBeforeCapture:catalog.diagnosticBusyReasons?catalog.diagnosticBusyReasons().length>0:catalog.visionTasks.blocked(),refresh:{available:Boolean(refresh),refreshing:Boolean(refresh?.refreshing),hasFailure:Boolean(refresh?.error)},tasks},
    paths,index,mapping,gaps:[...new Set(gaps)],limitations:['no-other-accounts-or-disks','no-video-decoding-or-content-hashing','no-historical-logs-outside-selected-root','file-moves-can-invalidate-visual-revisions','labels-do-not-prove-correct-periods'] };
}

export function diagnosticAssessment(context, relationships, coverage) {
  const facts=[],suspicions=[],evidenceGaps=['no-video-period-ground-truth','no-uncaptured-historical-content'];
  if(relationships.nameCoverage.directoryKeys&&!relationships.nameCoverage.intersectingNamedKeys)facts.push('no-named-log-key-intersection-in-retained-material');
  if(relationships.mapping.labelsWithoutName)facts.push('mapping-period-labels-without-names');
  if(relationships.mapping.relativePathMismatch)facts.push('mapping-relative-path-mismatch');
  if(relationships.mapping.ambiguousBasename)facts.push('same-basename-in-multiple-directories');
  const relationship=context?.paths?.relationships?.find(item=>item.left==='persisted'&&item.right==='official');
  if(relationship&&relationship.normalizedEqual===false){facts.push('persisted-root-differs-from-reported-official-root');suspicions.push('root-choice-may-explain-different-inventory-not-proof-of-migration');}
  if(coverage.inputFilesChanged)evidenceGaps.push('input-changed-during-capture');
  if(coverage.omittedEvents||coverage.omittedFiles||coverage.omittedDirectories||coverage.relationshipRecordsOmitted)evidenceGaps.push('retained-capture-limited');
  if(!context?.frontend?.available)evidenceGaps.push('frontend-state-not-observed');
  if(!context||context.available===false)evidenceGaps.push('pre-capture-service-context-unavailable');
  return {facts,suspicions,evidenceGaps,notAnAllFaultsGuarantee:true};
}

export function captureRelationships(mappingEntries, directories, records) {
  const directoryKeys=new Set(directories.map(item=>item.key)), fileLocations=new Map(), logKeys=new Set(), namedLogKeys=new Set();
  for(const item of directories)for(const name of item.files){const key=name.toLowerCase();if(!fileLocations.has(key))fileLocations.set(key,new Set());fileLocations.get(key).add(item.key.toLowerCase()+'/'+key);}
  for(const record of records){logKeys.add(record.key);if(typeof record.name==='string'&&record.name.trim())namedLogKeys.add(record.key);}
  const mapping={matchedFiles:0,matchedNamedFiles:0,relativePathMismatch:0,missingBasename:0,ambiguousBasename:0,labelsWithoutName:0};
  for(const entry of mappingEntries.slice(0,20000)){
    const locations=fileLocations.get(String(entry.fileName).toLowerCase()), named=typeof entry.name==='string'&&Boolean(entry.name.trim());
    if(period(entry.tod)&&!named)mapping.labelsWithoutName++;
    if(!locations){mapping.missingBasename++;continue;}
    if(locations.size>1)mapping.ambiguousBasename++;
    if(entry.filePath&&!locations.has(entry.filePath.replace(/\\/g,'/').toLowerCase())){mapping.relativePathMismatch++;continue;}
    mapping.matchedFiles++;if(named)mapping.matchedNamedFiles++;
  }
  return { basis:'retained-capture-material-not-entire-disk',nameCoverage:{directoryKeys:directoryKeys.size,logKeys:logKeys.size,namedLogKeys:namedLogKeys.size,
    intersectingLogKeys:[...logKeys].filter(key=>directoryKeys.has(key)).length,intersectingNamedKeys:[...namedLogKeys].filter(key=>directoryKeys.has(key)).length},mapping,
    periodCorrectness:'not-checked',factsOnly:true };
}
