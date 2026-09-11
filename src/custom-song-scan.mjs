import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { inspectVideo } from './custom-song-media-facts.mjs';
import { ScanDiagnostics } from './custom-song-diagnostics.mjs';
import { mappingKey } from './custom-song-mappings.mjs';
import { isVisionFile, validVisionFile, revisionForResolvedFile } from './custom-song-vision-evidence.mjs';

const SONG_DIRECTORY = /^midi_[0-9]+_[0-9]+$/;
const LOG_FILE = /^Olivia(?:\.\d+)?\.log$/;
const PERIODS = ['TOD12', 'TOD1730', 'TOD20'];
const ORIGINAL_HOST = 'static-cnbeta01.olivia.miyoushe.com';
const DEFAULT_LIMITS = Object.freeze({
  maxDirectoryEntries: 10_000,
  maxLogBytes: 256 * 1024 * 1024,
  maxTotalLogBytes: 256 * 1024 * 1024,
  maxLineBytes: 1024 * 1024,
});

/**
 * Recover locally downloaded custom songs without treating the local data as trusted.
 * The scanner intentionally accepts an optional `limits` object in addition to the
 * frozen public arguments so callers can make the safety bounds tighter.
 */
export async function scanCustomSongs({ mediaRoot, logRoot, limits, previousSongs = [], inspectMedia = inspectVideo,
  diagnostics, logRootSource = 'default', patchVersion, io, mappingEntries } = {}) {
  const ownedDiagnostics = !diagnostics;
  const scanDiagnostics = diagnostics ?? new ScanDiagnostics({ mediaRoot, logRoot, logRootSource, patchVersion });
  const fileSystem = { lstat, readdir, realpath, createReadStream, ...(io && typeof io === 'object' ? io : {}) };
  const options = normaliseLimits(limits);
  const warnings = new WarningList();
  try {
    let metadata = new Map(), logsRead = false;
    const getMetadata = async () => {
      if (!logsRead) {
        metadata = await readLogMetadata(logRoot, options, warnings, scanDiagnostics, fileSystem);
        logsRead = true;
      }
      return metadata;
    };
    if (!mappingEntries || scanDiagnostics.observeLogLine) await getMetadata();
    const previous = new Map(previousSongs.map((song) => [song.nameKey, song]));
    const budget = { remainingBytes: positiveInteger(limits?.maxHashBytes, 32 * 1024 ** 3) };
    const songs = await readMedia(mediaRoot, metadata, options, warnings,
      { previous, budget, inspectMedia, diagnostics: scanDiagnostics, io: fileSystem,
        getMetadata, mappingEntries: mappingEntries ? new Map(mappingEntries.map((entry) => [mappingKey(entry.fileName), entry])) : null });
    if (logsRead) finishScanDiagnostics(scanDiagnostics, metadata, songs);
    if (ownedDiagnostics) scanDiagnostics.finish();
    return { songs, warnings: warnings.values(), diagnostics: scanDiagnostics.snapshot() };
  } catch (error) {
    scanDiagnostics.markIncomplete();
    if (ownedDiagnostics) scanDiagnostics.finish(error?.code);
    throw error;
  }
}

function finishScanDiagnostics(diagnostics, metadata, songs) {
  const counters = diagnostics.snapshot().report.stages;
  const logRootStatus = diagnostics.snapshot().report.paths.logRootStatus;
  const supportedFilesRead = counters.logFilesRead > 0;
  if (counters.logFilesUnsupported > 0) diagnostics.reason('UNSUPPORTED_LOG_FILES', counters.logFilesUnsupported);
  if (logRootStatus === 'readable') {
    if (counters.logFilesSupported === 0 && counters.logFilesUnsupported === 0) diagnostics.reason('NO_LOG_FILES');
    else if (supportedFilesRead && counters.relevantEvents === 0) diagnostics.reason('NO_RELEVANT_EVENTS');
  }
  if (counters.relevantEvents > 0 && counters.derivedEvents === counters.relevantEvents) {
    diagnostics.reason('LOCAL_DERIVED_ONLY');
  }
  if (counters.parseFailures > 0) diagnostics.reason('PARSE_FAILED', counters.parseFailures);
  if (counters.relevantEvents > 0 && counters.usableNameRecords === 0) diagnostics.reason('NO_USABLE_NAMES');
  void metadata;
}

class WarningList {
  #items = [];
  #seen = new Set();

  add(message) {
    if (!this.#seen.has(message)) {
      this.#seen.add(message);
      this.#items.push(message);
    }
  }

  values() {
    return this.#items;
  }
}

function normaliseLimits(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    maxDirectoryEntries: positiveInteger(
      source.maxDirectoryEntries ?? source.maxFilesPerDirectory,
      DEFAULT_LIMITS.maxDirectoryEntries,
    ),
    maxLogBytes: positiveInteger(source.maxLogBytes, DEFAULT_LIMITS.maxLogBytes),
    maxTotalLogBytes: positiveInteger(source.maxTotalLogBytes, DEFAULT_LIMITS.maxTotalLogBytes),
    maxLineBytes: positiveInteger(source.maxLineBytes, DEFAULT_LIMITS.maxLineBytes),
  };
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function readMedia(mediaRoot, metadata, limits, warnings, evidenceOptions) {
  const { diagnostics } = evidenceOptions;
  if (!mediaRoot) {
    warnings.add('[MEDIA_ROOT_ABSENT] mediaRoot 未提供，未扫描自定义歌曲。');
    diagnostics.reason('ROOT_MISSING');
    return [];
  }

  let rootEntries;
  try {
    const rootInfo = await evidenceOptions.io.lstat(mediaRoot);
    if (rootInfo.isSymbolicLink()) {
      warnings.add('[MEDIA_ROOT_SYMLINK] mediaRoot 是符号链接，已停止扫描且未跟随链接。');
      diagnostics.reason('ROOT_INVALID');
      return [];
    }
    if (!rootInfo.isDirectory()) {
      warnings.add('[MEDIA_ROOT_NOT_DIRECTORY] mediaRoot 不是目录，未扫描自定义歌曲。');
      diagnostics.reason('ROOT_INVALID');
      return [];
    }
    rootEntries = await boundedDirectoryEntries(mediaRoot, limits, warnings, 'mediaRoot', diagnostics, evidenceOptions.io);
  } catch (error) {
    warnings.add(formatPathAccessWarning('mediaRoot', mediaRoot, error));
    diagnostics.reason(reasonForAccessError(error));
    return [];
  }

  const songs = [];
  const matchedDirectories = new Set();
  // Exact-limit enumeration is conservatively partial; no extra filesystem pass.
  let directoryCoverageComplete = rootEntries.length < limits.maxDirectoryEntries;
  for (const entry of rootEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !SONG_DIRECTORY.test(entry.name)) {
      continue;
    }

    const folderPath = path.join(mediaRoot, entry.name);
    try {
      const folderInfo = await evidenceOptions.io.lstat(folderPath);
      if (!folderInfo.isDirectory() || folderInfo.isSymbolicLink()) { directoryCoverageComplete = false; continue; }
    } catch (error) {
      directoryCoverageComplete = false;
      warnings.add(formatPathAccessWarning(`song directory ${entry.name}`, folderPath, error));
      diagnostics.reason(reasonForAccessError(error));
      continue;
    }
    matchedDirectories.add(entry.name);
    const files = await readSongFiles(folderPath, entry.name, limits, warnings, diagnostics, evidenceOptions.io);
    diagnostics.observeDirectory?.(entry.name, files);
    const mapped = files.map((fileName) => {
      const item = evidenceOptions.mappingEntries?.get(mappingKey(fileName));
      return item && (!item.filePath || item.filePath.toLowerCase() === `${entry.name}/${fileName}`.toLowerCase()) ? item : null;
    });
    let hasVision = false;
    for (let index = 0; index < mapped.length; index++) {
      const item = mapped[index];
      if (!isVisionFile(item?.automatic)) continue;
      hasVision = true;
      try {
        const target = path.join(folderPath, files[index]), stat = await evidenceOptions.io.lstat(target), real = await evidenceOptions.io.realpath(target);
        if (!validVisionFile(item.automatic, revisionForResolvedFile({ path: real, stat }))) mapped[index] = { ...item, tod: null, automatic: undefined };
      } catch { mapped[index] = { ...item, tod: null, automatic: undefined }; }
    }
    const mappedName = mapped.find((item) => item?.name && item.name !== entry.name)?.name;
    const complete = !hasVision && files.length > 0 && mappedName && mapped.every((item) => item?.filePath && (item.tod || item.manualUnknown));
    if (!complete) metadata = await evidenceOptions.getMetadata();
    const record = complete ? null : metadata.get(entry.name);
    const mapping = record ? record.mapping : new Map();
    diagnostics.match(entry.name, Boolean(mappedName) || usableName(record?.name, entry.name), {
      recordPresent: Boolean(record), mappingName: Boolean(mappedName), logName: usableName(record?.name, entry.name) });

    warnForMappingConflicts(entry.name, mapping, warnings);
    warnForDuplicateTods(entry.name, files, mapping, warnings);
    warnForMissingMappedFiles(entry.name, files, mapping, warnings);

    const result = {
      id: record?.id ?? `local-${entry.name}`,
      name: mappedName || record?.name || entry.name,
      ...(mappedName ? { mappingName: mappedName } : {}),
      nameKey: entry.name,
      files: files.map((fileName) => fileResult(fileName, mapping)),
      metadataSource: mappedName ? 'mapping' : record ? 'log' : 'directory',
      evidenceVersion: 1,
    };
    // Apply table fields before inference so imported values cannot be replaced
    // or misrepresented as new official-log evidence.
    result.files = result.files.map((file, index) => {
      const item = mapped[index];
      if (!item || (!item.tod && !item.manualUnknown)) return file;
      const saved = item.automatic;
      if (isVisionFile(saved) && (file.conflict || (mapping.get(file.fileName)?.length || 0) > 1)) return { ...file, conflict: true };
      if (isVisionFile(saved) && file.evidence === 'original' && file.tod && !file.conflict) return file;
      if (saved && saved.fileName === file.fileName) return { ...structuredClone(saved),
        ...(item.view && saved.view !== item.view ? { mappingView: item.view } : {}),
        ...(saved.tod !== item.tod || item.manualUnknown ? { mappingTod: item.tod, mappingManual: true } : {}) };
      return { fileName: file.fileName, tod: item.tod, view: item.view,
        evidence: item.manualUnknown ? 'manual' : 'mapping', ...(item.manualUnknown ? { manualUnknown: true } : {}) };
    });
    const allCandidates = [...mapping.values()].flat();
    const repeatedTod = result.files.filter((file) => file.tod && result.files.some((other) =>
      other !== file && other.tod === file.tod && other.view === file.view));
    for (const file of repeatedTod) file.conflict = true;
    const missing = [...mapping.keys()].some((fileName) => !files.includes(fileName));
    const mixed = mapping.hasRejectedOriginal || new Set(allCandidates.map((item) => item.resourceSet)).size > 1 || (record?.recordIds?.size ?? 0) > 1;
    result.recovery = { status: 'unknown', reason: null };
    if (mixed) warnings.add(`[SOURCE_VERSION_CONFLICT] 歌曲 ${entry.name} 的原始记录来自不同资源组或版本，不推定。`);
    const prior = evidenceOptions.previous.get(entry.name);
    if (!complete && !result.files.some((file) => file.manualUnknown || (file.mappingManual && file.mappingTod === null))) {
      await inferMissingPeriod(result, { folderPath, files, missing, mixed, prior, ...evidenceOptions, warnings });
    }
    songs.push(result);
  }

  let unmatched = 0;
  diagnostics.noteDirectoryCoverage?.(matchedDirectories, directoryCoverageComplete);
  for (const [nameKey, record] of metadata) {
    if (usableName(record?.name, nameKey) && !matchedDirectories.has(nameKey)) unmatched += 1;
  }
  if (unmatched > 0) {
    diagnostics.increment('unmatchedNameRecords', unmatched);
    diagnostics.reason('UNMATCHED_NAMES', unmatched);
  }

  songs.sort((left, right) => left.nameKey < right.nameKey ? -1 : left.nameKey > right.nameKey ? 1 : 0);
  return songs;
}

async function readSongFiles(folderPath, nameKey, limits, warnings, diagnostics, io) {
  const entries = await boundedDirectoryEntries(folderPath, limits, warnings, `song directory ${nameKey}`, diagnostics, io);
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/\.mp4$/i.test(entry.name)) {
      continue;
    }

    try {
      const info = await io.lstat(path.join(folderPath, entry.name));
      if (info.isFile() && info.size > 0) {
        files.push(entry.name);
      }
    } catch (error) {
      warnings.add(formatPathAccessWarning(`video file ${nameKey}/${entry.name}`, path.join(folderPath, entry.name), error));
      diagnostics.reason(reasonForAccessError(error));
    }
  }

  files.sort(compareNames);
  files.hasRejectedVideo = entries.incomplete === true || entries.filter((entry) => /\.mp4$/i.test(entry.name)).length !== files.length;
  return files;
}

function fileResult(fileName, mapping) {
  const candidates = mapping.get(fileName) ?? [];
  if (candidates.length === 1) {
    return {
      fileName,
      tod: candidates[0].tod,
      view: candidates[0].view,
      evidence: 'original',
      provenance: candidates[0].sources,
      resourceSet: candidates[0].resourceSet,
    };
  }
  return { fileName, tod: null, view: null, evidence: 'unknown',
    ...(candidates.length > 1 ? { conflict: true, provenance: candidates.flatMap((candidate) => candidate.sources) } : {}) };
}

async function inferMissingPeriod(song, { folderPath, files, missing, mixed, prior, budget, inspectMedia, warnings }) {
  const confirmed = song.files.filter((file) => file.evidence === 'original' && PERIODS.includes(file.tod));
  const reject = (reason) => { song.recovery = { status: 'unknown', reason }; };
  if (song.files.length !== 3 || files.hasRejectedVideo) return reject('requires-three-valid-files');
  if (missing || mixed || song.files.some((file) => file.conflict)) return reject('conflicting-or-incomplete-source');
  if (confirmed.length !== 2 || new Set(confirmed.map((file) => file.tod)).size !== 2) return reject('requires-two-original-periods');
  if (!confirmed[0].view || confirmed[0].view !== confirmed[1].view || !['NI', 'WI'].includes(confirmed[0].view)) return reject('inconsistent-view');
  const facts = [];
  try {
    for (const file of song.files) {
      const previous = prior?.files?.find((old) => old.fileName === file.fileName)?.mediaFacts;
      const fact = await inspectMedia(path.join(folderPath, file.fileName), { previous, budget });
      file.mediaFacts = fact;
      facts.push(fact);
    }
  } catch {
    warnings.add(`[MEDIA_EVIDENCE_UNAVAILABLE] 歌曲 ${song.nameKey} 的媒体证据无法读取，保留待确认。`);
    return reject('media-unreadable-or-changed');
  }
  if (facts.some((fact) => !fact.valid || !fact.profile || !(fact.duration > 0))) return reject('invalid-video');
  if (facts.some((fact) => !/^[a-f0-9]{64}$/.test(fact.sha256 ?? ''))) {
    warnings.add('[HASH_BUDGET] 部分视频未完成内容校验，保持待确认；已校验的文件可在重扫时复用缓存。');
    return reject('hash-unavailable');
  }
  if (new Set(facts.map((fact) => fact.sha256)).size !== 3) return reject('duplicate-content');
  if (new Set(facts.map((fact) => JSON.stringify(fact.profile))).size !== 1) return reject('different-video-profile');
  const duration = facts.map((fact) => fact.duration);
  // Timing only rejects different renders; it never labels a period.
  if (Math.max(...duration) - Math.min(...duration) > Math.max(0.25, Math.min(...duration) * 0.002)) return reject('duration-mismatch');
  const unknown = song.files.find((file) => file.evidence === 'unknown');
  if (!unknown) return reject('no-unique-remaining-file');
  const tod = PERIODS.find((period) => !confirmed.some((file) => file.tod === period));
  Object.assign(unknown, { tod, view: confirmed[0].view, evidence: 'inferred', inference: {
    method: 'elimination', version: 1, assumption: 'three-files-one-render-set-and-view',
    files: song.files.map((file) => ({ fileName: file.fileName, fingerprint: file.mediaFacts.fingerprint,
      sha256: file.mediaFacts.sha256, duration: file.mediaFacts.duration })),
    originals: confirmed.map(({ fileName, tod, view, resourceSet, provenance }) => ({ fileName, tod, view, resourceSet, provenance })),
  } });
  song.recovery = { status: 'inferred', reason: 'unique-missing-period', fileName: unknown.fileName };
}

async function boundedDirectoryEntries(directory, limits, warnings, label, diagnostics, io = { readdir }) {
  let entries;
  try {
    entries = await io.readdir(directory, { withFileTypes: true });
  } catch (error) {
    warnings.add(formatPathAccessWarning(label, directory, error));
    diagnostics?.reason(reasonForAccessError(error));
    return [];
  }

  entries.sort((left, right) => compareNames(left.name, right.name));
  if (entries.length > limits.maxDirectoryEntries) {
    warnings.add(`[DIRECTORY_LIMIT] ${label} 有 ${entries.length} 个条目，仅扫描前 ${limits.maxDirectoryEntries} 个。`);
    diagnostics?.reason('DIRECTORY_LIMIT');
    return Object.assign(entries.slice(0, limits.maxDirectoryEntries), { incomplete: true });
  }
  return entries;
}

async function readLogMetadata(logRoot, limits, warnings, diagnostics, io) {
  const metadata = new Map();
  if (!logRoot) {
    warnings.add('[LOG_ROOT_ABSENT] logRoot 未提供，将使用目录名，视频元数据标记为 unknown。');
    diagnostics.setRoot('missing');
    diagnostics.reason('LOG_ROOT_MISSING');
    return metadata;
  }

  let entries;
  try {
    const rootInfo = await io.lstat(logRoot);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      warnings.add('[LOG_ROOT_INVALID] logRoot 不是普通目录，将使用目录元数据回退。');
      diagnostics.setRoot('invalid');
      diagnostics.reason('LOG_ROOT_INVALID');
      return metadata;
    }
    entries = await io.readdir(logRoot, { withFileTypes: true });
    diagnostics.setRoot('readable');
  } catch (error) {
    warnings.add(formatPathAccessWarning('logRoot', logRoot, error));
    diagnostics.setRoot(rootStatusForError(error));
    diagnostics.reason(logReasonForError(error));
    return metadata;
  }

  const logFiles = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    diagnostics.increment('logFilesDiscovered');
    const filePath = path.join(logRoot, entry.name);
    if (!LOG_FILE.test(entry.name)) {
      // This is diagnostic coverage only; the official accepted-file rule and
      // the recovery warning list remain unchanged. Do not penalize readme/ini.
      const possibleLog = /^Olivia(?:[._ -].*)?\.(?:log|txt|bak|old|zip|gz|7z)(?:[._ -].*)?$/i.test(entry.name)
        || /\.log(?:[._ -].*)?$/i.test(entry.name);
      if (!possibleLog) { diagnostics.increment('logFilesIgnored'); continue; }
      diagnostics.increment('logFilesUnsupported');
      try {
        const info = await io.lstat(filePath);
        diagnostics.addFile({ name: entry.name, size: info.size, status: 'unsupported' });
      } catch (error) {
        diagnostics.addFile({ name: entry.name, status: 'unsupported', errorCode: error?.code });
      }
      continue;
    }
    diagnostics.increment('logFilesSupported');
    try {
      const info = await io.lstat(filePath);
      if (info.isSymbolicLink() || !info.isFile()) {
        diagnostics.increment('logFilesFailed');
        diagnostics.addFile({ name: entry.name, size: info.size, status: 'failed', errorCode: 'EINVAL' });
        diagnostics.reason('LOG_READ_ERROR');
        continue;
      }
      logFiles.push({ name: entry.name, path: filePath, size: info.size, mtimeMs: info.mtimeMs,
        fileId: diagnostics.beginFile({ name: entry.name, size: info.size }) });
    } catch (error) {
      warnings.add(formatPathAccessWarning(`log file ${entry.name}`, filePath, error));
      diagnostics.increment('logFilesFailed');
      diagnostics.addFile({ name: entry.name, status: 'failed', errorCode: error?.code });
      diagnostics.reason('LOG_READ_ERROR');
    }
  }

  logFiles.sort(compareLogFiles);
  let remainingBytes = limits.maxTotalLogBytes;
  for (const logFile of logFiles) {
    if (logFile.size > limits.maxLogBytes) {
      warnings.add(`[LOG_FILE_TOO_LARGE] 日志 ${logFile.name} 超过 ${limits.maxLogBytes} 字节上限，已跳过。`);
      diagnostics.increment('logFilesSkipped');
      diagnostics.addFile({ fileId: logFile.fileId, name: logFile.name, size: logFile.size, status: 'skipped' });
      diagnostics.reason('READ_LIMIT');
      continue;
    }
    if (logFile.size > remainingBytes) {
      warnings.add(`[LOG_BUDGET_EXHAUSTED] 剩余预算不足以读取 ${logFile.name}，继续检查后续较小日志。`);
      diagnostics.increment('logFilesSkipped');
      diagnostics.addFile({ fileId: logFile.fileId, name: logFile.name, size: logFile.size, status: 'skipped' });
      diagnostics.reason('READ_LIMIT');
      continue;
    }

    const fileRecords = new Map();
    let fileStatus = 'read';
    let fileErrorCode;
    try {
      let lineNumber = 0;
      for await (const item of boundedLines(logFile.path, limits.maxLineBytes, io)) {
        lineNumber += 1;
        diagnostics.increment('totalLines', 1, logFile.fileId);
        if (item.tooLong) {
          warnings.add(`[LOG_LINE_TOO_LARGE] 日志 ${logFile.name} 含有超过 ${limits.maxLineBytes} 字节的行，该行已跳过。`);
          diagnostics.increment('oversizedLines', 1, logFile.fileId);
          diagnostics.issue({ fileId: logFile.fileId, line: lineNumber }, 'line', 'READ_LIMIT');
          fileStatus = 'partial';
          continue;
        }
        const context = { logFile: logFile.name, fileId: logFile.fileId, line: lineNumber };
        const records = parseLogLine(item.line, context, warnings, diagnostics);
        for (const record of records) {
          if (record.nameKey) {
            fileRecords.set(record.nameKey, fileRecords.has(record.nameKey)
              ? mergeRecords(record, fileRecords.get(record.nameKey))
              : record);
          }
        }
      }
    } catch (error) {
      warnings.add(formatPathAccessWarning(`log file ${logFile.name}`, logFile.path, error));
      fileStatus = 'failed';
      fileErrorCode = error?.code;
      diagnostics.reason('LOG_READ_ERROR');
    }
    diagnostics.increment(fileStatus === 'failed' ? 'logFilesFailed' : 'logFilesRead');
    diagnostics.addFile({ fileId: logFile.fileId, name: logFile.name, size: logFile.size, status: fileStatus, errorCode: fileErrorCode });
    diagnostics.finishFile(logFile.fileId);
    remainingBytes -= logFile.size;

    for (const [nameKey, record] of fileRecords) {
      metadata.set(nameKey, metadata.has(nameKey)
        ? mergeRecords(metadata.get(nameKey), record)
        : record);
    }
  }
  return metadata;
}

function compareLogFiles(left, right) {
  if (left.mtimeMs !== right.mtimeMs) return right.mtimeMs - left.mtimeMs;
  const leftRank = logRotationRank(left.name);
  const rightRank = logRotationRank(right.name);
  if (leftRank !== rightRank) return leftRank - rightRank;
  return compareNames(left.name, right.name);
}

function logRotationRank(name) {
  if (name === 'Olivia.log') return 0;
  return Number(name.match(/^Olivia\.(\d+)\.log$/)?.[1] ?? Number.MAX_SAFE_INTEGER);
}

async function* boundedLines(filePath, maxLineBytes, io = { createReadStream }) {
  const stream = io.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  let pending = '';
  let droppingLongLine = false;

  for await (const chunk of stream) {
    let text = chunk;
    if (droppingLongLine) {
      const newline = text.indexOf('\n');
      if (newline < 0) continue;
      droppingLongLine = false;
      yield { tooLong: true };
      text = text.slice(newline + 1);
    }
    pending += text;
    while (true) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      if (Buffer.byteLength(line, 'utf8') > maxLineBytes) yield { tooLong: true };
      else yield { line };
    }
    if (Buffer.byteLength(pending, 'utf8') > maxLineBytes) {
      pending = '';
      droppingLongLine = true;
    }
  }

  if (pending) {
    if (Buffer.byteLength(pending, 'utf8') > maxLineBytes) yield { tooLong: true };
    else yield { line: pending.replace(/\r$/, '') };
  } else if (droppingLongLine) {
    yield { tooLong: true };
  }
}

// Data-only replay boundary: the same parser and prefix recovery as a real scan.
// Raw records remain internal to the caller; never serialize this return value as a report.
export function inspectSongEventForReplay(line) {
  const diagnostics = new ScanDiagnostics();
  const records = parseLogLine(line, { logFile: 'Olivia.log', line: 1 }, new WarningList(), diagnostics);
  const report = diagnostics.snapshot().report;
  return { records, stages: report.stages, reasons: report.reasons.map(item => item.code).sort(),
    errors: report.requestEvidence.structureSamples.map(item => item.jsonError.category) };
}

function parseLogLine(line, context, warnings, diagnostics) {
  if (line.trim()) diagnostics.increment('nonEmptyLines', 1, context.fileId);
  if (line.includes('\ufeff')) diagnostics.increment('bomLines', 1, context.fileId);
  if (/[\u0000\ufffd\ufffe]/.test(line)) {
    diagnostics.increment('suspectedEncodingLines', 1, context.fileId);
    diagnostics.issue(context, 'line', 'ENCODING_SUSPECTED', 1, 0, true);
  }
  const marker = line.indexOf('[OTEL Logger]');
  if (marker < 0) {
    diagnostics.observeLogLine?.(line, context);
    diagnostics.increment('linesWithoutMarker', 1, context.fileId);
    return [];
  }
  diagnostics.increment('markerLines', 1, context.fileId);
  const start = line.indexOf('{', marker + '[OTEL Logger]'.length);
  if (start < 0) {
    diagnostics.observeLogLine?.(line, context);
    diagnostics.increment('unclassifiedOuterFailures', 1, context.fileId);
    diagnostics.issue(context, 'outer', 'UNCLASSIFIED_OUTER_JSON');
    return [];
  }

  let outer;
  try {
    outer = JSON.parse(line.slice(start));
  } catch {
    diagnostics.observeLogLine?.(line, context);
    diagnostics.increment('unclassifiedOuterFailures', 1, context.fileId);
    diagnostics.issue(context, 'outer', 'UNCLASSIFIED_OUTER_JSON');
    return [];
  }
  diagnostics.observeLogLine?.(line, context, outer);
  diagnostics.increment('outerJsonParsed', 1, context.fileId);
  const attributes = outer?.attributes && typeof outer.attributes === 'object' ? outer.attributes : outer;
  const action = attributes?.['query.action'];
  if (action !== 'checkLocalSongs' && action !== 'startSongDownload') {
    diagnostics.increment('unknownActions', 1, context.fileId);
    diagnostics.issue(context, 'action', 'UNKNOWN_ACTION', 1, 0, true);
    return [];
  }
  diagnostics.increment('relevantEvents', 1, context.fileId);
  diagnostics.observeRequestFields?.(action, attributes, context);
  const request = attributes?.['query.request'];
  if (!Object.hasOwn(attributes, 'query.request') && Object.hasOwn(attributes, 'query.response')) {
    diagnostics.increment('responseOnlyEvents', 1, context.fileId);
    return []; // Acknowledgements do not supply names and are not malformed requests.
  }
  if (typeof request !== 'string') {
    diagnostics.increment('parseFailures', 1, context.fileId);
    diagnostics.increment('requestTypeFailures', 1, context.fileId);
    diagnostics.issue(context, 'request', 'REQUEST_TYPE_INVALID');
    return [];
  }
  // New payloads carry the marker first; old truncated payloads are also
  // rejected by their media URLs. Positive URL validation below is independent.
  if (/\/custom-song-media\/|"localCustomSong"\s*:\s*true|"localEvidenceVersion"/.test(request)) {
    warnings.add('[LOCAL_DERIVED_LOG_IGNORED] 已排除本地播放或回退产生的请求，不作为原始证据。');
    diagnostics.increment('derivedEvents', 1, context.fileId);
    return [];
  }
  const records = parseRequestRecords(request, { ...context, action }, diagnostics);
  if (records.parseFailure) diagnostics.increment('parseFailures', 1, context.fileId);
  if (records.parsedEvent) diagnostics.increment('parsedEvents', 1, context.fileId);
  if (!records.length) {
    diagnostics.increment('eventsWithoutNameKey', 1, context.fileId);
    diagnostics.issue(context, 'fields', 'NAME_KEY_NOT_EXTRACTED');
  }
  return records;
}

function parseRequestRecords(request, context, diagnostics) {
  let value, parsed = false;
  try {
    value = JSON.parse(request);
    parsed = true;
    diagnostics.increment('innerJsonParsed', 1, context.fileId);
    const records = [];
    collectObjectRecords(value, records, context, diagnostics);
    if (records.length > 0) return markParsedEvent(records);
    const partial = observePrefix(request, context, diagnostics, false);
    diagnostics.observeRequestStructure?.(request, context, { parsed, parsedValue: value, prefixRecords: partial.length });
    return markParsedEvent(partial);
  } catch (error) {
    diagnostics.increment('innerJsonFailures', 1, context.fileId);
    diagnostics.issue(context, 'inner', 'INNER_JSON_FAILED');
    if (/\[(?:truncated(?:\s+\d+\s+chars)?|cut|partial)\]\s*$/i.test(request)) {
      diagnostics.increment('truncatedRequests', 1, context.fileId);
      diagnostics.issue(context, 'inner', 'REQUEST_TRUNCATED');
    }
    // Preserve ordered-prefix recovery; a failure alone does not prove truncation.
    const partial = observePrefix(request, context, diagnostics, true);
    diagnostics.observeRequestStructure?.(request, context, { error, parsed, parsedValue: value, prefixRecords: partial.length });
    if (partial.length > 0) {
      return markParsedEvent(markParseFailure(partial));
    }
    return markParseFailure([]);
  }
}

function observePrefix(request, context, diagnostics, failedJson) {
  diagnostics.increment('prefixAttempts', 1, context.fileId);
  const records = partialRecords(request, context);
  diagnostics.increment(records.length ? 'prefixRecoveredEvents' : 'prefixEmptyEvents', 1, context.fileId);
  if (!records.length && failedJson) diagnostics.issue(context, 'prefix', 'PREFIX_NO_RECORDS');
  for (const record of records) diagnostics.noteNameRecord(record.nameKey, record.name, context, { prefix: true });
  return records;
}

function markParseFailure(records) {
  records.parseFailure = true;
  return records;
}

function markParsedEvent(records) {
  records.parsedEvent = true;
  return records;
}

function collectObjectRecords(value, records, context, diagnostics) {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value)) {
    const record = recordFromObject(value, context);
    if (record) {
      records.push(record);
      diagnostics.noteNameRecord(record.nameKey, record.name, context,
        { invalidType: Object.hasOwn(value, 'name') && value.name !== null && typeof value.name !== 'string' });
    }
  }
  for (const child of Object.values(value)) collectObjectRecords(child, records, context, diagnostics);
}

function recordFromObject(value, context) {
  if (typeof value.nameKey !== 'string' || !value.nameKey) return null;
  return {
    id: numericId(value.id),
    name: typeof value.name === 'string' && value.name ? value.name : null,
    nameKey: value.nameKey,
    mapping: mappingsFromValue(value.videoByTodView, { ...context, nameKey: value.nameKey }),
    recordIds: new Set(numericId(value.id) ? [numericId(value.id)] : []),
  };
}

function partialRecords(request, context) {
  const nameKeyNeedle = '"nameKey"';
  const nameKeyPositions = [];
  let cursor = 0;
  while (true) {
    const position = request.indexOf(nameKeyNeedle, cursor);
    if (position < 0) break;
    const value = readField(request.slice(position), 'nameKey');
    if (typeof value === 'string' && value) nameKeyPositions.push(position);
    cursor = position + nameKeyNeedle.length;
  }

  const starts = nameKeyPositions.map((nameKeyPosition, index) => {
    const lowerBound = index === 0 ? 0 : nameKeyPositions[index - 1] + nameKeyNeedle.length;
    return lastFieldStart(request, 'id', lowerBound, nameKeyPosition)
      ?? lastFieldStart(request, 'name', lowerBound, nameKeyPosition)
      ?? lowerBound;
  });
  const records = [];
  for (let index = 0; index < nameKeyPositions.length; index += 1) {
    const start = starts[index];
    const end = starts[index + 1] ?? request.length;
    const segment = request.slice(start, end);
    const nameKey = readField(segment, 'nameKey');
    if (typeof nameKey !== 'string' || !nameKey) continue;
    records.push({
      id: numericId(readField(segment, 'id')),
      name: nonEmptyString(readField(segment, 'name')),
      nameKey,
      mapping: mappingsFromText(segment, { ...context, nameKey }),
      recordIds: new Set(numericId(readField(segment, 'id')) ? [numericId(readField(segment, 'id'))] : []),
    });
  }
  return records;
}

function lastFieldStart(text, key, lowerBound, upperBound) {
  const needle = `"${key}"`;
  let last = null;
  let cursor = lowerBound;
  while (true) {
    const position = text.indexOf(needle, cursor);
    if (position < 0 || position >= upperBound) return last;
    let valueStart = position + needle.length;
    while (/\s/.test(text[valueStart] ?? '')) valueStart += 1;
    if (text[valueStart] === ':') last = position;
    cursor = position + needle.length;
  }
}

function mappingsFromValue(value, context) {
  if (!Array.isArray(value)) return new Map();
  const mapping = new Map();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const url = typeof item.url === 'string' ? item.url : null;
    const tod = nonEmptyString(item.tod);
    const view = nonEmptyString(item.view);
    const original = originalResource(url, tod, view, context);
    if (original?.rejected) mapping.hasRejectedOriginal = true;
    else if (original) addMapping(mapping, original.fileName, original.candidate);
  }
  return mapping;
}

function mappingsFromText(request, context) {
  const mapping = new Map();
  const key = '"videoByTodView"';
  let cursor = request.indexOf(key);
  while (cursor >= 0) {
    const arrayStart = request.indexOf('[', cursor + key.length);
    if (arrayStart < 0) break;
    const arrayEnd = request.indexOf(']', arrayStart + 1);
    const sectionEnd = arrayEnd >= 0 ? arrayEnd : request.length;
    let objectStart = request.indexOf('{', arrayStart + 1);
    while (objectStart >= 0 && objectStart < sectionEnd) {
      const nextObject = request.indexOf('{', objectStart + 1);
      const objectEnd = nextObject >= 0 && nextObject < sectionEnd ? nextObject : sectionEnd;
      const segment = request.slice(objectStart, objectEnd);
      const url = readField(segment, 'url');
      const tod = readField(segment, 'tod');
      const view = readField(segment, 'view');
      const original = originalResource(url, tod, view, context);
      if (original?.rejected) mapping.hasRejectedOriginal = true;
      else if (original) addMapping(mapping, original.fileName, original.candidate);
      objectStart = nextObject;
    }
    cursor = request.indexOf(key, sectionEnd + 1);
  }
  return mapping;
}

function addMapping(mapping, fileName, candidate) {
  const candidates = mapping.get(fileName) ?? [];
  const existing = candidates.find((item) => item.tod === candidate.tod && item.view === candidate.view && item.resourceSet === candidate.resourceSet);
  if (!existing) {
    candidates.push(candidate);
    candidates.sort((left, right) => compareNames(`${left.tod}\0${left.view}`, `${right.tod}\0${right.view}`));
  } else existing.sources = [...existing.sources, ...candidate.sources]
    .filter((source, index, all) => all.findIndex((entry) => entry.id === source.id) === index).slice(0, 4);
  mapping.set(fileName, candidates);
}

function mergeRecords(newer, older) {
  const mapping = new Map();
  for (const [fileName, candidates] of newer.mapping) {
    mapping.set(fileName, candidates.map((candidate) => ({ ...candidate })));
  }
  for (const [fileName, candidates] of older.mapping) {
    for (const candidate of candidates) addMapping(mapping, fileName, candidate);
  }
  mapping.hasRejectedOriginal = Boolean(newer.mapping.hasRejectedOriginal || older.mapping.hasRejectedOriginal);
  return {
    id: newer.id ?? older.id,
    name: newer.name || older.name || null,
    nameKey: newer.nameKey,
    mapping,
    recordIds: new Set([...(newer.recordIds ?? []), ...(older.recordIds ?? [])]),
  };
}

function readField(text, key) {
  const needle = `"${key}"`;
  let cursor = 0;
  while (true) {
    const keyStart = text.indexOf(needle, cursor);
    if (keyStart < 0) return undefined;
    let valueStart = keyStart + needle.length;
    while (/\s/.test(text[valueStart] ?? '')) valueStart += 1;
    if (text[valueStart] !== ':') {
      cursor = keyStart + needle.length;
      continue;
    }
    valueStart += 1;
    while (/\s/.test(text[valueStart] ?? '')) valueStart += 1;
    if (text[valueStart] === '"') {
      for (let index = valueStart + 1; index < text.length; index += 1) {
        if (text[index] === '"' && text[index - 1] !== '\\') {
          try {
            return JSON.parse(text.slice(valueStart, index + 1));
          } catch {
            return undefined;
          }
        }
      }
      return undefined;
    }
    const scalar = text.slice(valueStart).match(/^(?:-?\d+(?:\.\d+)?|null|true|false)/)?.[0];
    if (!scalar) return undefined;
    return scalar === 'null' ? null : scalar === 'true' ? true : scalar === 'false' ? false : Number(scalar);
  }
}

function originalResource(value, tod, view, context) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== ORIGINAL_HOST || url.port || url.username || url.password) return null;
    const match = url.pathname.match(/^\/midiPerf\/\d+\/\d+\/([^/]+\.mp4)$/i);
    if (!match || !SONG_DIRECTORY.test(context.nameKey)) return null;
    if (tod === undefined || view === undefined || tod === null || view === null) return null;
    if (!PERIODS.includes(tod) || !['NI', 'WI'].includes(view)) return { rejected: true };
    const fileName = decodeURIComponent(match[1]);
    if (fileName !== path.basename(fileName) || /[\\/:\0]/.test(fileName) || fileName.length >= 256) return null;
    const resourceSet = crypto.createHash('sha256').update(url.origin + url.pathname.slice(0, url.pathname.lastIndexOf('/'))).digest('hex');
    // Retain only a source pointer and normalized mapping identity, never the
    // raw request, signed URL, account credentials or query parameters.
    const id = crypto.createHash('sha256').update(JSON.stringify([context.nameKey, resourceSet, fileName, tod, view])).digest('hex');
    return { fileName, candidate: { tod, view, resourceSet, sources: [{
      kind: 'official-log', id, logFile: context.logFile, line: context.line, action: context.action,
    }] } };
  } catch { return null; }
}

function numericId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  return null;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value ? value : null;
}

function usableName(name, nameKey) {
  return typeof name === 'string' && Boolean(name.trim()) && name !== nameKey;
}

function warnForMappingConflicts(nameKey, mapping, warnings) {
  for (const [fileName, candidates] of mapping) {
    if (candidates.length > 1) {
      warnings.add(`[LOG_MAPPING_CONFLICT] 歌曲 ${nameKey} 的 ${fileName} 存在冲突日志元数据，文件已标记为 unknown。`);
    }
  }
}

function warnForDuplicateTods(nameKey, files, mapping, warnings) {
  const byTod = new Map();
  for (const fileName of files) {
    const candidates = mapping.get(fileName) ?? [];
    if (candidates.length !== 1) continue;
    const filesForTod = byTod.get(candidates[0].tod) ?? [];
    filesForTod.push(fileName);
    byTod.set(candidates[0].tod, filesForTod);
  }
  for (const [tod, filesForTod] of byTod) {
    if (filesForTod.length > 1) {
      warnings.add(`[DUPLICATE_TOD] 歌曲 ${nameKey} 有多个文件明确标为 ${tod}，已保留显式映射且未推断。`);
    }
  }
}

function warnForMissingMappedFiles(nameKey, files, mapping, warnings) {
  const present = new Set(files);
  for (const fileName of mapping.keys()) {
    if (!present.has(fileName)) {
      warnings.add(`[LOG_VIDEO_MISSING] 歌曲 ${nameKey} 的日志引用了缺失视频 ${fileName}。`);
    }
  }
}

function formatPathAccessWarning(label, target, error) {
  if (error?.code === 'ENOENT') return `[PATH_MISSING] ${label} 不存在（${target}），将使用可用回退。`;
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return `[PATH_ACCESS_DENIED] ${label} 无法访问（${target}），权限被拒绝。`;
  return `[PATH_READ_ERROR] ${label} 无法读取（${target}），错误码 ${error?.code ?? 'UNKNOWN'}。`;
}

function rootStatusForError(error) {
  if (error?.code === 'ENOENT') return 'missing';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'denied';
  if (error?.code === 'EINVAL') return 'invalid';
  return 'error';
}

function reasonForAccessError(error) {
  if (error?.code === 'ENOENT') return 'ROOT_MISSING';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'PERMISSION_DENIED';
  if (error?.code === 'EINVAL') return 'ROOT_INVALID';
  return 'SCAN_FAILED';
}

function logReasonForError(error) {
  if (error?.code === 'ENOENT') return 'LOG_ROOT_MISSING';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'LOG_READ_DENIED';
  if (error?.code === 'EINVAL') return 'LOG_ROOT_INVALID';
  return 'LOG_READ_ERROR';
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
