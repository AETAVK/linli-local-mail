import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import crypto from 'node:crypto';
import { scanCustomSongs, inspectSongEventForReplay } from './custom-song-scan.mjs';
import { ScanDiagnostics } from './custom-song-diagnostics.mjs';
import { FRAGMENT_POLICY } from './custom-song-fragment-redact.mjs';

export const DEBUG_LIMITS = Object.freeze({ packageBytes: 12 * 1024 * 1024, decodedBytes: 20 * 1024 * 1024,
  events: 2048, eventBytes: 1024 * 1024, evidenceBytes: 8 * 1024 * 1024, directories: 10000, files: 20000,
  rawBytes: 256 * 1024, rawEventBytes: 32 * 1024, rawEvents: 16, ttlMs: 10 * 60 * 1000 });
const EVENT_COUNTERS = ['relevantEvents', 'parsedEvents', 'parseFailures', 'unknownActions', 'requestTypeFailures', 'responseOnlyEvents',
  'innerJsonParsed', 'innerJsonFailures', 'prefixRecoveredEvents', 'prefixEmptyEvents', 'eventsWithoutNameKey', 'derivedEvents'];
const identity = { key: v => v, value: v => v, file: v => v };
const runtimeIdentity = Promise.all(['custom-song-name-sources.mjs','custom-song-name-recovery.mjs','custom-song-name-policy.mjs','song-diagnostic-picker.mjs','custom-song-scan.mjs', 'custom-song-debug-replay.mjs', 'custom-song-debug-package.mjs','custom-song-debug-evidence.mjs','diagnostic-errors.mjs','custom-song-debug-anonymize.mjs', 'custom-song-fragment-redact.mjs', 'custom-song-debug-context.mjs', 'custom-song-structure.mjs', 'custom-song-diagnostics.mjs', 'custom-song-mappings.mjs']
  .map(name => fs.readFile(new URL('./' + name, import.meta.url)).then(bytes => [name, crypto.createHash('sha256').update(bytes).digest('hex')]).catch(()=>[name,null])))
  .then(files => ({ nodeVersion: process.version, sources: Object.fromEntries(files),basis:'disk-source-hashes-at-module-initialization' }));
export async function replayRuntimeIdentity() { return structuredClone(await runtimeIdentity); }

export function eventInvariant(line, aliases = identity) {
  const result = inspectSongEventForReplay(line);
  return { stages: Object.fromEntries(EVENT_COUNTERS.map(key => [key, result.stages[key]])), errors: result.errors,
    records: result.records.map(record => ({ key: aliases.key(record.nameKey), id: aliases.value(record.id), name: aliases.value(record.name),
      files: [...record.mapping.keys()].map(file => aliases.file(file)).sort() })) };
}

export function songInvariants(songs, aliases = identity) {
  return songs.map(song => ({ key: aliases.key(song.nameKey), name: aliases.value(song.name), source: song.metadataSource,
    files: song.files.map(file => aliases.file(file.fileName)).sort() })).sort((a, b) => a.key.localeCompare(b.key));
}

// Fully virtual filesystem: cannot read media, call URLs, or mutate a player database.
export async function replayMaterial(material, { aliases = identity } = {}) {
  const mediaRoot = path.resolve('/linli-replay/media'), logRoot = path.resolve('/linli-replay/logs');
  const dirent = (name, directory) => ({ name, isDirectory: () => directory, isFile: () => !directory, isSymbolicLink: () => false });
  const logs = new Map();
  for (const event of material.events) {
    const name = `Olivia.${event.fileOrder}.log`;
    if (!logs.has(name)) logs.set(name, []);
    logs.get(name).push(event.text);
  }
  const files = new Map(), folders = new Map([[mediaRoot, material.directories.map(item => dirent(item.key, true))],
    [logRoot, [...logs.keys()].map(name => dirent(name, false))]]);
  for (const [name, lines] of logs) files.set(path.join(logRoot, name), { text: lines.join('\n') + '\n', order: Number(name.split('.')[1]) });
  for (const item of material.directories) {
    const folder = path.join(mediaRoot, item.key);
    folders.set(folder, item.files.map(name => dirent(name, false)));
    for (const name of item.files) files.set(path.join(folder, name), { size: 1 });
  }
  const io = {
    async readdir(target) { if (folders.has(target)) return folders.get(target); throw Object.assign(new Error('virtual missing'), { code: 'ENOENT' }); },
    async lstat(target) {
      const file = files.get(target), directory = folders.has(target);
      if (!file && !directory) throw Object.assign(new Error('virtual missing'), { code: 'ENOENT' });
      return { isDirectory: () => directory, isFile: () => Boolean(file), isSymbolicLink: () => false,
        size: file?.text ? Buffer.byteLength(file.text) : file?.size || 0, mtimeMs: file?.order == null ? 0 : 100000 - file.order };
    },
    createReadStream(target) { if (!files.get(target)?.text) throw new Error('virtual data only'); return Readable.from([files.get(target).text]); },
  };
  const diagnostics = new ScanDiagnostics();
  // Match capture's forced log coverage even when the mapping table is complete.
  diagnostics.observeLogLine = () => {};
  const result = await scanCustomSongs({ mediaRoot, logRoot, io, diagnostics, mappingEntries: material.mappings,
    inspectMedia: async () => ({ valid: false, reason: 'replay-no-video' }) });
  return { events: material.events.map(event => eventInvariant(event.text, aliases)),
    songs: songInvariants(result.songs, aliases) };
}

function invalid() { throw new Error('INVALID_DEBUG_PACKAGE'); }
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
export function validateReplayMaterial(material) {
  if (!plain(material) || !Array.isArray(material.events) || material.events.length > DEBUG_LIMITS.events ||
    !Array.isArray(material.directories) || material.directories.length > DEBUG_LIMITS.directories ||
    !Array.isArray(material.mappings) || material.mappings.length > DEBUG_LIMITS.files) invalid();
  let bytes = 0, fileCount = 0;
  for (const event of material.events) {
    if (!plain(event) || typeof event.text !== 'string' || !Number.isSafeInteger(event.fileOrder) || event.fileOrder < 0 || event.fileOrder > 10000) invalid();
    const size = Buffer.byteLength(event.text);
    if (size > DEBUG_LIMITS.eventBytes) invalid(); bytes += size;
  }
  if (bytes > DEBUG_LIMITS.evidenceBytes) invalid();
  const keys = new Set();
  for (const item of material.directories) {
    if (!plain(item) || !/^midi_\d+_\d+$/.test(item.key) || item.key.length > 128 || keys.has(item.key) || !Array.isArray(item.files)) invalid();
    keys.add(item.key); fileCount += item.files.length;
    if (fileCount > DEBUG_LIMITS.files || new Set(item.files).size !== item.files.length) invalid();
    for (const name of item.files) if (typeof name !== 'string' || !/^[\w.-]+\.mp4$/i.test(name) || name.length > 128 || name.includes('..')) invalid();
  }
  for (const item of material.mappings) {
    if (!plain(item) || typeof item.fileName !== 'string' || !/^[\w.-]+\.mp4$/i.test(item.fileName) || item.fileName.length > 128 || item.fileName.includes('..') ||
      (item.filePath != null && (typeof item.filePath !== 'string' || item.filePath.length > 260 || item.filePath.includes('..') || !/^midi_\d+_\d+\/[\w.-]+\.mp4$/i.test(item.filePath))) ||
      (item.name != null && (typeof item.name !== 'string' || item.name.length > 256)) ||
      ![null, undefined, 'TOD12', 'TOD1730', 'TOD20'].includes(item.tod) || ![null, undefined, 'NI', 'WI'].includes(item.view) ||
      (item.manualUnknown !== undefined && typeof item.manualUnknown !== 'boolean')) invalid();
  }
  return material;
}

export function decodeDebugPackage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > DEBUG_LIMITS.packageBytes) invalid();
  let value;
  try { value = JSON.parse((buffer[0]===0x1f&&buffer[1]===0x8b?gunzipSync(buffer, { maxOutputLength: DEBUG_LIMITS.decodedBytes }):buffer).toString('utf8')); } catch { invalid(); }
  if (!plain(value) || value.format !== 'linli-song-debug' || ![1, 2, 3].includes(value.schemaVersion) || !plain(value.manifest) || !plain(value.diagnostics) ||
    Buffer.byteLength(JSON.stringify(value.diagnostics)) > 65536 || Object.keys(value).some(key => !['format','schemaVersion','manifest','diagnostics','material','verification','sensitive','details'].includes(key))) invalid();
  validateReplayMaterial(value.material);
  if(value.manifest.context&&Buffer.byteLength(JSON.stringify(value.manifest.context))>65536)invalid();
  if (value.sensitive !== undefined) {
    if (!Array.isArray(value.sensitive) || value.sensitive.length > DEBUG_LIMITS.rawEvents) invalid();
    let bytes = 0;
    for (const record of value.sensitive) {
      if (!plain(record) || typeof record.text !== 'string' || !Number.isSafeInteger(record.eventIndex) || record.eventIndex < 0 || record.eventIndex >= value.material.events.length) invalid();
      if (value.schemaVersion >= 2 && (record.contentKind !== 'credential-redacted-fragment' || !['targeted-credentials-v1',FRAGMENT_POLICY].includes(record.policy))) invalid();
      const size = Buffer.byteLength(record.text); if (size > DEBUG_LIMITS.rawEventBytes) invalid(); bytes += size;
    }
    if (bytes > DEBUG_LIMITS.rawBytes) invalid();
  }
  if(value.details!==undefined&&(!plain(value.details)||Buffer.byteLength(JSON.stringify(value.details))>16*1024*1024))invalid();
  return value;
}

export function readDetailedEvidence(buffer,{confirmSensitive=false}={}){
 if(confirmSensitive!==true)throw Error('DETAILED_EVIDENCE_REQUIRES_CONFIRMATION');
 const bundle=decodeDebugPackage(buffer),manifest=bundle.manifest;
 const complete=manifest.complete===true&&manifest.readCoverageComplete===true&&
   !manifest.coverage?.inputFilesChanged&&!manifest.coverage?.inputFilesUnavailableAfterRead&&
   (!bundle.details?.nameRecovery||bundle.details.nameRecovery.complete===true)&&
   bundle.details?.coverage?.complete===true&&bundle.details?.service?.coverage?.complete===true&&!(manifest.failures||[]).length;
 // Data only. Never open roots/extraPaths from a package or execute its preview plan.
 return{schemaVersion:bundle.schemaVersion,details:bundle.details||null,failures:manifest.failures||[],complete,
   nameRecovery:bundle.details?.nameRecovery?.schemaVersion===1?bundle.details.nameRecovery:null,
   nameRecoveryAvailable:bundle.details?.nameRecovery?.schemaVersion===1};
}

export async function replayDebugPackage(buffer, { includeRaw = false, confirmSensitive = false } = {}) {
  if (typeof includeRaw !== 'boolean' || typeof confirmSensitive !== 'boolean' || includeRaw && !confirmSensitive) throw new Error('RAW_REPLAY_REQUIRES_CONFIRMATION');
  const bundle = decodeDebugPackage(buffer);
  const result = await replayMaterial(bundle.material);
  // Only fixed counters in CLI output; never echo any untrusted request, name, path or error.
  const receipt = { schemaVersion: 3, mode: includeRaw ? (bundle.schemaVersion >= 2 ? 'credential-redacted-fragments' : 'legacy-sensitive-originals') : 'sanitized-summary',
    fragmentBytes: bundle.schemaVersion >= 2 ? 'redacted-not-original' : 'legacy-may-contain-credentials',
    detailedEvents:includeRaw?bundle.details?.events?.length||0:0,summaryOnly:!includeRaw,
    runtimeMatchesCapture: JSON.stringify(await replayRuntimeIdentity()) === JSON.stringify(bundle.manifest.runtime),
    events: result.events.length, extractedRecords: result.events.reduce((n, event) => n + event.records.length, 0),
    songDirectories: result.songs.length, replayMatchesStored: JSON.stringify(result) === JSON.stringify(bundle.verification?.sanitizedResult),
    lossyEvents: Array.isArray(bundle.verification?.events) ? bundle.verification.events.filter(item => item.status !== 'equivalent').length : null,
    rawEventsReplayed: 0, rawResults: [] };
  if (includeRaw) for (const item of bundle.sensitive || []) {
    const raw = eventInvariant(item.text), sanitized = result.events[item.eventIndex];
    receipt.rawEventsReplayed++;
    receipt.rawResults.push({ eventIndex: item.eventIndex, stages: raw.stages, errorCategories: raw.errors,
      extractedRecords: raw.records.length, namedRecords: raw.records.filter(record => typeof record.name === 'string' && record.name.trim()).length,
      matchesSanitizedStages: JSON.stringify(raw.stages) === JSON.stringify(sanitized.stages),
      matchesSanitizedRecordCount: raw.records.length === sanitized.records.length });
  }
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [file, ...flags] = process.argv.slice(2);
    if (!file || flags.some(flag => !['--include-raw', '--confirm-sensitive'].includes(flag))) invalid();
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > DEBUG_LIMITS.packageBytes) invalid();
    console.log(JSON.stringify(await replayDebugPackage(await fs.readFile(file), {
      includeRaw: flags.includes('--include-raw'), confirmSensitive: flags.includes('--confirm-sensitive'),
    }), null, 2));
  } catch { console.error('排障包无效、超过安全上限，或缺少敏感片段回放确认。旧版片段可能包含未脱敏凭据。'); process.exitCode = 1; }
}
