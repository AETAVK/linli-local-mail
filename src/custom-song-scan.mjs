import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

const SONG_DIRECTORY = /^midi_[0-9]+_[0-9]+$/;
const LOG_FILE = /^Olivia(?:\.\d+)?\.log$/;
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
export async function scanCustomSongs({ mediaRoot, logRoot, limits } = {}) {
  const options = normaliseLimits(limits);
  const warnings = new WarningList();
  const metadata = await readLogMetadata(logRoot, options, warnings);
  const songs = await readMedia(mediaRoot, metadata, options, warnings);

  return { songs, warnings: warnings.values() };
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

async function readMedia(mediaRoot, metadata, limits, warnings) {
  if (!mediaRoot) {
    warnings.add('[MEDIA_ROOT_ABSENT] mediaRoot 未提供，未扫描自定义歌曲。');
    return [];
  }

  let rootEntries;
  try {
    const rootInfo = await lstat(mediaRoot);
    if (rootInfo.isSymbolicLink()) {
      warnings.add('[MEDIA_ROOT_SYMLINK] mediaRoot 是符号链接，已停止扫描且未跟随链接。');
      return [];
    }
    if (!rootInfo.isDirectory()) {
      warnings.add('[MEDIA_ROOT_NOT_DIRECTORY] mediaRoot 不是目录，未扫描自定义歌曲。');
      return [];
    }
    rootEntries = await boundedDirectoryEntries(mediaRoot, limits, warnings, 'mediaRoot');
  } catch (error) {
    warnings.add(formatPathAccessWarning('mediaRoot', mediaRoot, error));
    return [];
  }

  const songs = [];
  for (const entry of rootEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !SONG_DIRECTORY.test(entry.name)) {
      continue;
    }

    const folderPath = path.join(mediaRoot, entry.name);
    try {
      const folderInfo = await lstat(folderPath);
      if (!folderInfo.isDirectory() || folderInfo.isSymbolicLink()) continue;
    } catch (error) {
      warnings.add(formatPathAccessWarning(`song directory ${entry.name}`, folderPath, error));
      continue;
    }
    const files = await readSongFiles(folderPath, entry.name, limits, warnings);
    const record = metadata.get(entry.name);
    const mapping = record ? record.mapping : new Map();

    warnForMappingConflicts(entry.name, mapping, warnings);
    warnForDuplicateTods(entry.name, files, mapping, warnings);
    warnForMissingMappedFiles(entry.name, files, mapping, warnings);

    songs.push({
      id: record?.id ?? `local-${entry.name}`,
      name: record?.name || entry.name,
      nameKey: entry.name,
      files: files.map((fileName) => fileResult(fileName, mapping)),
      metadataSource: record ? 'log' : 'directory',
    });
  }

  songs.sort((left, right) => left.nameKey < right.nameKey ? -1 : left.nameKey > right.nameKey ? 1 : 0);
  return songs;
}

async function readSongFiles(folderPath, nameKey, limits, warnings) {
  const entries = await boundedDirectoryEntries(folderPath, limits, warnings, `song directory ${nameKey}`);
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/\.mp4$/i.test(entry.name)) {
      continue;
    }

    try {
      const info = await lstat(path.join(folderPath, entry.name));
      if (info.isFile() && info.size > 0) {
        files.push(entry.name);
      }
    } catch (error) {
      warnings.add(formatPathAccessWarning(`video file ${nameKey}/${entry.name}`, path.join(folderPath, entry.name), error));
    }
  }

  files.sort(compareNames);
  return files;
}

function fileResult(fileName, mapping) {
  const candidates = mapping.get(fileName) ?? [];
  if (candidates.length === 1) {
    return {
      fileName,
      tod: candidates[0].tod,
      view: candidates[0].view,
      evidence: 'log',
    };
  }
  return { fileName, tod: null, view: 'NI', evidence: 'unknown' };
}

async function boundedDirectoryEntries(directory, limits, warnings, label) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    warnings.add(formatPathAccessWarning(label, directory, error));
    return [];
  }

  entries.sort((left, right) => compareNames(left.name, right.name));
  if (entries.length > limits.maxDirectoryEntries) {
    warnings.add(`[DIRECTORY_LIMIT] ${label} 有 ${entries.length} 个条目，仅扫描前 ${limits.maxDirectoryEntries} 个。`);
    return entries.slice(0, limits.maxDirectoryEntries);
  }
  return entries;
}

async function readLogMetadata(logRoot, limits, warnings) {
  const metadata = new Map();
  if (!logRoot) {
    warnings.add('[LOG_ROOT_ABSENT] logRoot 未提供，将使用目录名，视频元数据标记为 unknown。');
    return metadata;
  }

  let entries;
  try {
    const rootInfo = await lstat(logRoot);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      warnings.add('[LOG_ROOT_INVALID] logRoot 不是普通目录，将使用目录元数据回退。');
      return metadata;
    }
    entries = await readdir(logRoot, { withFileTypes: true });
  } catch (error) {
    warnings.add(formatPathAccessWarning('logRoot', logRoot, error));
    return metadata;
  }

  const logFiles = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !LOG_FILE.test(entry.name)) continue;
    const filePath = path.join(logRoot, entry.name);
    try {
      const info = await lstat(filePath);
      if (info.isSymbolicLink() || !info.isFile()) continue;
      logFiles.push({ name: entry.name, path: filePath, size: info.size, mtimeMs: info.mtimeMs });
    } catch (error) {
      warnings.add(formatPathAccessWarning(`log file ${entry.name}`, filePath, error));
    }
  }

  logFiles.sort(compareLogFiles);
  let remainingBytes = limits.maxTotalLogBytes;
  for (const logFile of logFiles) {
    if (logFile.size > limits.maxLogBytes) {
      warnings.add(`[LOG_FILE_TOO_LARGE] 日志 ${logFile.name} 超过 ${limits.maxLogBytes} 字节上限，已跳过。`);
      continue;
    }
    if (logFile.size > remainingBytes) {
      warnings.add(`[LOG_BUDGET_EXHAUSTED] 日志预算在 ${logFile.name} 前耗尽，剩余日志已跳过。`);
      break;
    }

    const fileRecords = new Map();
    try {
      for await (const item of boundedLines(logFile.path, limits.maxLineBytes)) {
        if (item.tooLong) {
          warnings.add(`[LOG_LINE_TOO_LARGE] 日志 ${logFile.name} 含有超过 ${limits.maxLineBytes} 字节的行，该行已跳过。`);
          continue;
        }
        const records = parseLogLine(item.line);
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
    }
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

async function* boundedLines(filePath, maxLineBytes) {
  const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
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

function parseLogLine(line) {
  const marker = line.indexOf('[OTEL Logger]');
  if (marker < 0) return [];
  const start = line.indexOf('{', marker + '[OTEL Logger]'.length);
  if (start < 0) return [];

  let outer;
  try {
    outer = JSON.parse(line.slice(start));
  } catch {
    return [];
  }
  const attributes = outer?.attributes && typeof outer.attributes === 'object' ? outer.attributes : outer;
  const action = attributes?.['query.action'];
  if (action !== 'checkLocalSongs' && action !== 'startSongDownload') return [];
  const request = attributes?.['query.request'];
  if (typeof request !== 'string') return [];
  return parseRequestRecords(request);
}

function parseRequestRecords(request) {
  try {
    const value = JSON.parse(request);
    const records = [];
    collectObjectRecords(value, records);
    if (records.length > 0) return records;
  } catch {
    // The service deliberately truncates query.request; recover the ordered prefix below.
  }
  return partialRecords(request);
}

function collectObjectRecords(value, records) {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value)) {
    const record = recordFromObject(value);
    if (record) records.push(record);
  }
  for (const child of Object.values(value)) collectObjectRecords(child, records);
}

function recordFromObject(value) {
  if (typeof value.nameKey !== 'string' || !value.nameKey) return null;
  return {
    id: numericId(value.id),
    name: typeof value.name === 'string' && value.name ? value.name : null,
    nameKey: value.nameKey,
    mapping: mappingsFromValue(value.videoByTodView),
  };
}

function partialRecords(request) {
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
      mapping: mappingsFromText(segment),
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

function mappingsFromValue(value) {
  if (!Array.isArray(value)) return new Map();
  const mapping = new Map();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const url = typeof item.url === 'string' ? item.url : null;
    const tod = nonEmptyString(item.tod);
    const view = nonEmptyString(item.view);
    const fileName = url && basenameFromUrl(url);
    if (!fileName || !tod || !view) continue;
    addMapping(mapping, fileName, { tod, view });
  }
  return mapping;
}

function mappingsFromText(request) {
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
      const fileName = typeof url === 'string' ? basenameFromUrl(url) : null;
      if (fileName && typeof tod === 'string' && tod && typeof view === 'string' && view) {
        addMapping(mapping, fileName, { tod, view });
      }
      objectStart = nextObject;
    }
    cursor = request.indexOf(key, sectionEnd + 1);
  }
  return mapping;
}

function addMapping(mapping, fileName, candidate) {
  const candidates = mapping.get(fileName) ?? [];
  if (!candidates.some((item) => item.tod === candidate.tod && item.view === candidate.view)) {
    candidates.push(candidate);
    candidates.sort((left, right) => compareNames(`${left.tod}\0${left.view}`, `${right.tod}\0${right.view}`));
  }
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
  return {
    id: newer.id ?? older.id,
    name: newer.name || older.name || null,
    nameKey: newer.nameKey,
    mapping,
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

function basenameFromUrl(value) {
  const withoutQuery = value.split(/[?#]/, 1)[0];
  const slash = withoutQuery.lastIndexOf('/');
  const raw = slash >= 0 ? withoutQuery.slice(slash + 1) : withoutQuery;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function numericId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  return null;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value ? value : null;
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

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
