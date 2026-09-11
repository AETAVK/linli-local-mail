import crypto from 'node:crypto';
import { evidenceType, inspectFieldShape, inspectRequestStructure, jsonErrorEvidence, leadingStructureType } from './custom-song-structure.mjs';

const MAX_REPORT_BYTES = 64 * 1024;
const MAX_LOG_FILES = 64;
const MAX_SAMPLES = 32;
const MAX_ISSUES = 64;
const MAX_KEYS = 10_000;
const ACTIONS = ['checkLocalSongs', 'startSongDownload'];
const TYPES = ['missing', 'null', 'string', 'object', 'array', 'number', 'boolean', 'other'];
const MAX_TYPE_SAMPLES = 8;
const MAX_STRUCTURE_SAMPLES = 12;
const MAX_RECORD_SAMPLES = 16;
const typeCounts = () => Object.fromEntries(TYPES.map(type => [type, 0]));

const COUNTER_NAMES = Object.freeze([
  'logFilesDiscovered', 'logFilesSupported', 'logFilesRead', 'logFilesSkipped',
  'logFilesFailed', 'logFilesUnsupported', 'relevantEvents', 'parsedEvents',
  'usableNameRecords', 'uniqueNameRecords', 'parseFailures', 'truncatedRequests',
  'oversizedLines', 'derivedEvents', 'songDirectories', 'matchedNames',
  'unmatchedNameRecords', 'unusableNames', 'indexedSongs', 'unindexedSongs', 'recoveredNames',
  'retainedNames', 'manualNames', 'directoryNames',
  'logFilesIgnored', 'totalLines', 'nonEmptyLines', 'markerLines', 'linesWithoutMarker',
  'bomLines', 'suspectedEncodingLines', 'outerJsonParsed', 'unclassifiedOuterFailures',
  'unknownActions', 'requestTypeFailures', 'responseOnlyEvents', 'innerJsonParsed', 'innerJsonFailures',
  'prefixAttempts', 'prefixRecoveredEvents', 'prefixEmptyEvents', 'eventsWithoutNameKey',
  'recordKeysObserved', 'missingNameRecords', 'invalidNameRecords', 'mergedNameLosses',
  'mappingMatchedNames', 'logMatchedNames', 'unattributedMatchedNames',
]);

const ROOT_STATUSES = new Set(['unread', 'missing', 'invalid', 'readable', 'denied', 'error']);
const FILE_STATUSES = new Set(['pending', 'read', 'skipped', 'failed', 'partial', 'unsupported']);
const STAGES = new Set(['line', 'outer', 'action', 'request', 'inner', 'prefix', 'fields', 'merge', 'match', 'coverage']);
const DISPLAY_SOURCES = new Set(['scanned', 'recovered', 'retained', 'manual', 'directory', 'unusable', 'unindexed']);
const ERROR_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'UNKNOWN']);
const OUTCOME_COUNTERS = new Set([
  'indexedSongs', 'unindexedSongs', 'recoveredNames', 'retainedNames', 'manualNames', 'directoryNames', 'unusableNames',
]);

const REASONS = Object.freeze({
  LOG_ROOT_MISSING: { message: '日志根目录不存在。', suggestion: '检查游戏数据目录或选择正确的日志目录。', certainty: 'fact' },
  LOG_ROOT_INVALID: { message: '日志根目录不是可读取的普通目录。', suggestion: '检查日志目录配置。', certainty: 'fact' },
  LOG_READ_DENIED: { message: '日志目录或文件没有读取权限。', suggestion: '检查当前账户的读取权限。', certainty: 'fact' },
  LOG_READ_ERROR: { message: '日志读取发生错误。', suggestion: '核对游戏实际日志位置、文件可读性及磁盘状态。', certainty: 'unknown' },
  NO_LOG_FILES: { message: '未发现可扫描的日志文件。', suggestion: '核对游戏实际日志位置，并查找旧日志备份；新日志未必包含旧歌曲历史。', certainty: 'fact' },
  UNSUPPORTED_LOG_FILES: { message: '发现未扫描的备份、改名或压缩文件。', suggestion: '未扫描的备份/改名/压缩文件不代表记录丢失。', certainty: 'fact' },
  NO_RELEVANT_EVENTS: { message: '本次已读取日志中没有确认的自定义歌曲事件。', suggestion: '确认这些日志来自包含自定义歌曲操作的游戏运行。', certainty: 'unknown' },
  PARSE_FAILED: { message: '已确认的歌曲事件在请求解析阶段存在缺口。', suggestion: '保留现有日志并提供脱敏诊断；重复扫描不会修复静态格式问题。', certainty: 'unknown' },
  REQUEST_TRUNCATED: { message: '请求包含显式截断标志。', suggestion: '寻找包含该次历史的完整日志或旧备份；更晚日志不一定包含同一记录。', certainty: 'fact' },
  NO_USABLE_NAMES: { message: '没有发现可用于目录匹配的歌曲名称。', suggestion: '确认日志包含歌曲名称字段。', certainty: 'fact' },
  UNUSABLE_NAMES: { message: '部分入库歌曲的最终名称为空白或无效。', suggestion: '保留原始记录，查找旧备份或手动填写曲名。', certainty: 'fact' },
  UNMATCHED_NAMES: { message: '部分日志歌曲记录没有匹配到媒体目录。', suggestion: '比较日志记录与视频目录的来源和时间。', certainty: 'fact' },
  LOCAL_DERIVED_ONLY: { message: '日志只包含本地派生记录，未作为原始证据使用。', suggestion: '尝试使用更早的原始日志重新扫描。', certainty: 'fact' },
  READ_LIMIT: { message: '扫描受到文件或字节预算限制。', suggestion: '缩小扫描范围或提高受控预算后重试。', certainty: 'fact' },
  DIRECTORY_LIMIT: { message: '目录条目超过扫描上限。', suggestion: '缩小媒体目录或提高受控目录预算。', certainty: 'fact' },
  UNDETERMINED: { message: '扫描结果无法确定。', suggestion: '保留现有日志并提供脱敏诊断，核对数据来源。', certainty: 'unknown' },
  SCAN_FAILED: { message: '扫描因未分类错误失败。', suggestion: '检查路径和可读性，保留现有日志并提供脱敏诊断。', certainty: 'unknown' },
  ROOT_MISSING: { message: '扫描根路径不存在。', suggestion: '检查路径配置和游戏数据。', certainty: 'fact' },
  ROOT_INVALID: { message: '扫描根路径无效。', suggestion: '选择一个有效的目录。', certainty: 'fact' },
  PERMISSION_DENIED: { message: '扫描根路径访问被拒绝。', suggestion: '检查当前账户的读取权限。', certainty: 'fact' },
  NAME_FALLBACK: { message: '部分歌曲使用目录名作为名称回退。', suggestion: '确认日志中的歌曲名称记录。', certainty: 'fact' },
  NO_MARKER: { message: '部分非空日志未识别到 OTEL 标记。', suggestion: '核对日志格式和来源，查找旧备份；不据此判断歌曲历史不存在。', certainty: 'unknown' },
  ENCODING_SUSPECTED: { message: '发现 NUL 或解码替换符，疑似编码不匹配。', suggestion: '保留原文件并核对编码；本次未自动切换解码方式。', certainty: 'unknown' },
  UNCLASSIFIED_OUTER_JSON: { message: 'OTEL 外层格式异常，无法确认是否属于歌曲事件。', suggestion: '保留日志并提供匿名文件/行号诊断；不能据此断言歌曲数据损坏。', certainty: 'unknown' },
  UNKNOWN_ACTION: { message: '存在未受支持或未识别的动作。', suggestion: '核对游戏日志格式；仅已识别的歌曲动作参与恢复。', certainty: 'unknown' },
  REQUEST_TYPE_INVALID: { message: '歌曲事件的 request 不是字符串。', suggestion: '保留该日志并提供脱敏诊断，重复扫描不会改变字段类型。', certainty: 'fact' },
  INNER_JSON_FAILED: { message: '歌曲 request 的完整 JSON 解析失败。', suggestion: '查看前缀恢复结果；保留现有日志或查找同次历史的完整备份。', certainty: 'fact' },
  PREFIX_NO_RECORDS: { message: '前缀恢复未提取到歌曲键记录。', suggestion: '保留日志和诊断；不表示原请求中一定没有歌曲。', certainty: 'unknown' },
  PREFIX_NAME_MISSING: { message: '前缀恢复取得歌曲键，但未取得名称。', suggestion: '可能受截断或字段顺序影响，请保留日志；本次不改变恢复算法。', certainty: 'unknown' },
  NAME_KEY_NOT_EXTRACTED: { message: '该请求未提取到有效歌曲键。', suggestion: '空请求或不同结构均可能造成此结果，请核对日志来源和格式。', certainty: 'unknown' },
  NAME_FIELD_MISSING: { message: '匹配记录缺少名称字段或名称为空。', suggestion: '尝试同次历史的其他日志备份，或手动填写曲名。', certainty: 'fact' },
  NAME_FIELD_TYPE_INVALID: { message: '名称字段不是字符串。', suggestion: '保留日志并提供诊断，或手动填写曲名。', certainty: 'fact' },
  NAME_BLANK: { message: '名称字段仅包含空白。', suggestion: '查找旧备份或手动填写曲名；重复扫描不会修复该字段。', certainty: 'fact' },
  NAME_EQUALS_KEY: { message: '记录的名称与目录键相同，不能恢复真实曲名。', suggestion: '查找有真实名称的旧备份，或手动填写曲名。', certainty: 'fact' },
  NO_MATCHING_KEY: { message: '部分媒体目录在已解析记录中没有对应歌曲键。', suggestion: '核对日志和歌曲目录的来源，尝试旧备份；不表示历史从未存在。', certainty: 'fact' },
  NAME_REASON_UNCERTAIN: { message: '存在覆盖或证据缺口，部分缺名原因尚不确定。', suggestion: '保留已有日志及脱敏报告，勿把未提取到记录视为历史不存在。', certainty: 'unknown' },
  MERGED_NAME_UNUSABLE: { message: '曾提取到可用名称，但合并或最终显示选取后未保留可用名称。', suggestion: '对照匿名来源或手动校正；本次只报告，不修改名称覆盖规则。', certainty: 'fact' },
  NAME_AVAILABLE: { message: '名称可用。', suggestion: '无需处理。', certainty: 'fact' },
});

const REASON_ALIASES = Object.freeze({
  ENOENT: 'ROOT_MISSING',
  EACCES: 'PERMISSION_DENIED',
  EPERM: 'PERMISSION_DENIED',
  EINVAL: 'ROOT_INVALID',
});

const INCOMPLETE_REASONS = new Set([
  'LOG_ROOT_MISSING', 'LOG_ROOT_INVALID', 'LOG_READ_DENIED', 'LOG_READ_ERROR',
  'PARSE_FAILED', 'REQUEST_TRUNCATED', 'READ_LIMIT', 'DIRECTORY_LIMIT',
  'UNSUPPORTED_LOG_FILES', 'UNDETERMINED', 'SCAN_FAILED', 'ROOT_MISSING',
  'ROOT_INVALID', 'PERMISSION_DENIED',
  'ENCODING_SUSPECTED', 'UNCLASSIFIED_OUTER_JSON', 'REQUEST_TYPE_INVALID', 'INNER_JSON_FAILED',
]);

export class ScanDiagnostics {
  #scanId = crypto.randomUUID();
  #startedAt = new Date().toISOString();
  #finishedAt = null;
  #mediaRoot;
  #logRoot;
  #logRootSource;
  #patchVersion;
  #logRootStatus = 'unread';
  #complete = true;
  #counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  #reasons = new Map();
  #logFiles = [];
  #issues = [];
  #filesById = new Map();
  #recordFacts = new Map();
  #directoryFacts = new Map();
  #omitted = { logFiles: 0, samples: 0, issues: 0, recordKeys: 0 };
  #fileOrdinal = 0;
  #sampleOrdinal = 0;
  #namedRecords = new Set();
  #recordOrdinal = 0;
  #directoryCoverage = 'unavailable';
  #typeBuckets = new Set();
  #structureBuckets = new Map();
  #requestEvidence = {
    scope: 'recognized-song-events-only',
    byAction: Object.fromEntries(ACTIONS.map(action => [action, {
      events: 0, requestTypes: typeCounts(), responseTypes: typeCounts(), typePairs: {},
    }])),
    typeSamples: [], structureSamples: [],
    structureEvents: 0, omittedTypeSamples: 0, omittedStructureSamples: 0,
  };

  constructor({ mediaRoot, logRoot, logRootSource = 'default', patchVersion } = {}) {
    this.#mediaRoot = typeof mediaRoot === 'string' ? mediaRoot : null;
    this.#logRoot = typeof logRoot === 'string' ? logRoot : null;
    this.#logRootSource = logRootSource === 'default' ? 'default' : 'custom';
    this.#patchVersion = validSemver(patchVersion) ? patchVersion : 'unknown';
  }

  increment(key, amount = 1, fileId) {
    if (!Object.prototype.hasOwnProperty.call(this.#counters, key)) return;
    const numeric = Number(amount);
    if (!Number.isFinite(numeric) || numeric <= 0) return;
    this.#counters[key] += Math.min(Math.floor(numeric), Number.MAX_SAFE_INTEGER - this.#counters[key]);
    const file = this.#filesById.get(fileId);
    if (file) file.stages[key] = Math.min(Number.MAX_SAFE_INTEGER, (file.stages[key] || 0) + Math.floor(numeric));
  }

  setRoot(status) {
    if (!ROOT_STATUSES.has(status)) return;
    this.#logRootStatus = status;
    if (status !== 'readable') this.#markIncomplete();
  }

  beginFile({ name, size } = {}) {
    return this.addFile({ name, size, status: 'pending' });
  }

  addFile({ name, size, status, errorCode, fileId } = {}) {
    if (!FILE_STATUSES.has(status)) return;
    const extension = safeExtension(name);
    let item = this.#filesById.get(fileId);
    if (!fileId) {
      const ordinal = ++this.#fileOrdinal;
      fileId = `${this.#scanId.slice(0, 8)}-f${ordinal}`;
      item = {
      fileId,
      name: `logfile-${ordinal}${extension}`,
      size: numericSize(size),
      status, stages: {},
      };
      if (this.#logFiles.length < MAX_LOG_FILES) {
        this.#logFiles.push(item); this.#filesById.set(fileId, item);
      } else this.#omitted.logFiles += 1;
    }
    const normalizedError = normalizeErrorCode(errorCode);
    if (item) {
      item.status = status;
      if (normalizedError) item.errorCode = normalizedError;
    }
    if (status !== 'read' && status !== 'pending') this.#markIncomplete();
    return fileId;
  }

  finishFile(fileId) {
    const file = this.#filesById.get(fileId);
    if (file?.stages.nonEmptyLines && !file.stages.markerLines) {
      this.issue({ fileId, line: null }, 'line', 'NO_MARKER', file.stages.nonEmptyLines, 0, true);
    }
  }

  source(context, stage, reasonCode) {
    const fileId = typeof context?.fileId === 'string' && context.fileId.startsWith(this.#scanId.slice(0, 8) + '-f')
      && /^\d+$/.test(context.fileId.split('-f')[1]) ? context.fileId : null;
    return { fileId, line: Number.isSafeInteger(context?.line) && context.line > 0 ? context.line : null,
      stage: STAGES.has(stage) ? stage : 'coverage',
      reasonCode: Object.hasOwn(REASONS, reasonCode) ? reasonCode : 'UNDETERMINED' };
  }

  issue(context, stage, reasonCode, count = 1, relatedRecords = 0, aggregate = false) {
    const source = this.source(context, stage, reasonCode);
    count = numericSize(count); relatedRecords = numericSize(relatedRecords);
    if (!count) return;
    this.reason(source.reasonCode, count);
    const existing = this.#issues.find(item => item.fileId === source.fileId && item.stage === source.stage
      && item.reasonCode === source.reasonCode && (aggregate || item.line === source.line));
    if (existing) {
      existing.count = Math.min(Number.MAX_SAFE_INTEGER, existing.count + count);
      existing.relatedRecords = Math.min(Number.MAX_SAFE_INTEGER, existing.relatedRecords + relatedRecords);
    } else if (this.#issues.length < MAX_ISSUES) this.#issues.push({ ...source, count, relatedRecords });
    else this.#omitted.issues = Math.min(Number.MAX_SAFE_INTEGER, this.#omitted.issues + count);
  }

  reason(code, count = 1) {
    const normalized = typeof code === 'string' && Object.hasOwn(REASONS, code) ? code : 'UNDETERMINED';
    const numeric = Number(count);
    if (!Number.isFinite(numeric) || numeric <= 0) return;
    const current = this.#reasons.get(normalized) ?? 0;
    this.#reasons.set(normalized, current + Math.min(Math.floor(numeric), Number.MAX_SAFE_INTEGER - current));
    if (INCOMPLETE_REASONS.has(normalized)) this.#markIncomplete();
  }

  match(nameKey, hasName, { recordPresent, mappingName, logName } = {}) {
    this.increment('songDirectories');
    if (hasName === true) {
      this.increment('matchedNames');
      this.increment(mappingName === true ? 'mappingMatchedNames' : logName === true ? 'logMatchedNames' : 'unattributedMatchedNames');
    }
    const ordinal = ++this.#sampleOrdinal;
    if (typeof nameKey !== 'string' || nameKey.length > 256 || this.#directoryFacts.size >= MAX_KEYS) return;
    const fact = this.#recordFacts.get(nameKey);
    let reasonCode = 'NAME_AVAILABLE';
    if (!hasName) {
      if (recordPresent && fact?.usable) {
        reasonCode = 'MERGED_NAME_UNUSABLE';
        this.increment('mergedNameLosses');
        this.issue(fact.invalidSource, 'merge', reasonCode, 1, 1);
      } else if (fact?.invalidSource) reasonCode = fact.invalidSource.reasonCode;
      else if (recordPresent) reasonCode = 'NAME_REASON_UNCERTAIN';
      else reasonCode = 'NO_MATCHING_KEY';
      if (!fact) this.issue(null, 'match', reasonCode, 1, 1, true);
    }
    this.#directoryFacts.set(nameKey, { ordinal, hasName: hasName === true,
      displayHasName: hasName === true, displaySource: 'scanned', reasonCode,
      sources: [fact?.invalidSource, fact?.usableSource].filter(Boolean).slice(0, 2) });
  }

  noteDisplayOutcome(nameKey, displaySource, displayHasName) {
    const sample = this.#directoryFacts.get(nameKey);
    if (!sample) return;
    sample.displaySource = DISPLAY_SOURCES.has(displaySource) ? displaySource : 'unindexed';
    sample.displayHasName = displayHasName === true;
    if (sample.displaySource !== 'unindexed' && !sample.displayHasName && sample.hasName) {
      sample.reasonCode = 'MERGED_NAME_UNUSABLE';
      this.issue(null, 'merge', sample.reasonCode, 1, 1, true);
    }
  }

  outcomes(counts = {}) {
    if (!counts || typeof counts !== 'object') return;
    for (const key of OUTCOME_COUNTERS) {
      if (!Object.prototype.hasOwnProperty.call(counts, key)) continue;
      const numeric = Number(counts[key]);
      if (Number.isFinite(numeric) && numeric >= 0) this.#counters[key] = Math.min(Math.floor(numeric), Number.MAX_SAFE_INTEGER);
    }
  }

  observeRequestFields(action, attributes, context) {
    if (!ACTIONS.includes(action) || !attributes || typeof attributes !== 'object') return;
    const requestType = evidenceType(attributes?.['query.request'], Object.hasOwn(attributes, 'query.request'));
    const responseType = evidenceType(attributes?.['query.response'], Object.hasOwn(attributes, 'query.response'));
    const counts = this.#requestEvidence.byAction[action];
    counts.events++; counts.requestTypes[requestType]++; counts.responseTypes[responseType]++;
    const pair = `${requestType}/${responseType}`;
    counts.typePairs[pair] = (counts.typePairs[pair] || 0) + 1;
    if (requestType === 'string') return;
    const bucket = `${action}:${pair}`;
    if (this.#typeBuckets.has(bucket) || this.#requestEvidence.typeSamples.length >= MAX_TYPE_SAMPLES) {
      this.#requestEvidence.omittedTypeSamples++; return;
    }
    this.#typeBuckets.add(bucket);
    this.#requestEvidence.typeSamples.push({ action, requestType, responseType,
      ...(['object', 'array'].includes(requestType) ? { shape: inspectFieldShape(attributes['query.request']) } : {}),
      source: this.source(context, 'request', 'REQUEST_TYPE_INVALID') });
  }

  observeRequestStructure(request, context, { error = null, parsed = false, parsedValue, prefixRecords = 0 } = {}) {
    if (typeof request !== 'string' || !ACTIONS.includes(context?.action)) return;
    const parseStatus = error ? parsed ? 'record-walk-failed' : 'json-failed' : 'parsed-no-records';
    const jsonError = jsonErrorEvidence(error, request.length);
    const lead = leadingStructureType(request);
    const bucket = `${context.action}:${parseStatus}:${jsonError.category}:${lead}:${prefixRecords > 0}`;
    this.#requestEvidence.structureEvents++;
    const used = this.#structureBuckets.get(bucket) || 0;
    // Reserve eight places for failures even if valid empty/wrapped input arrives first.
    const ordinaryFull = !error && this.#requestEvidence.structureSamples.filter(item => item.parseStatus === 'parsed-no-records').length >= 4;
    if (used >= 2 || ordinaryFull || this.#requestEvidence.structureSamples.length >= MAX_STRUCTURE_SAMPLES) {
      this.#requestEvidence.omittedStructureSamples++; return;
    }
    this.#structureBuckets.set(bucket, used + 1);
    // Only admitted representatives incur a structural walk; no second log read.
    const structure = inspectRequestStructure(request);
    this.#requestEvidence.structureSamples.push({ action: context.action, parseStatus,
      jsonError, prefixRecoveredRecords: numericSize(prefixRecords),
      parsedRootType: parsed ? evidenceType(parsedValue) : 'unknown',
      decodedContainerCandidate: parsed && typeof parsedValue === 'string' ? leadingStructureType(parsedValue) : 'unknown',
      structure, source: this.source(context, error ? 'inner' : 'prefix', error ? 'INNER_JSON_FAILED'
        : prefixRecords > 0 ? 'NAME_REASON_UNCERTAIN' : 'PREFIX_NO_RECORDS') });
  }

  noteDirectoryCoverage(directories, complete) {
    this.#directoryCoverage = complete ? 'complete' : 'partial';
    for (const [key, fact] of this.#recordFacts) {
      fact.directoryMatch = directories.has(key) ? 'observed' : complete ? 'not-observed' : 'unknown';
    }
  }

  #recordKeyEvidence() {
    const counts = { trackedUniqueKeys: this.#recordFacts.size, validDirectoryKeys: 0, otherKeys: 0,
      observedDirectoryKeys: 0, notObservedDirectoryKeys: 0, unknownDirectoryKeys: 0 };
    const samples = [];
    for (const [key, fact] of this.#recordFacts) {
      const keyFormat = /^midi_[0-9]+_[0-9]+$/.test(key) ? 'midi-directory' : 'other';
      const directoryMatch = fact.directoryMatch || (this.#directoryFacts.has(key) ? 'observed' : 'unknown');
      counts[keyFormat === 'midi-directory' ? 'validDirectoryKeys' : 'otherKeys']++;
      counts[directoryMatch === 'observed' ? 'observedDirectoryKeys' : directoryMatch === 'not-observed' ? 'notObservedDirectoryKeys' : 'unknownDirectoryKeys']++;
      samples.push({ keyId: `${this.#scanId.slice(0, 8)}-k${fact.ordinal}`, keyFormat, directoryMatch,
        usableNameObserved: fact.usable, observations: fact.observations,
        sources: [fact.invalidSource, fact.usableSource].filter(Boolean).map(source => ({ ...source })) });
    }
    samples.sort((a, b) => keySamplePriority(a) - keySamplePriority(b));
    return { scope: 'retained-log-keys-vs-scanned-eligible-media-directories', directoryCoverage: this.#directoryCoverage,
      ...counts, omittedKeyObservations: this.#omitted.recordKeys,
      samples: samples.slice(0, MAX_RECORD_SAMPLES), omittedSamples: Math.max(0, samples.length - MAX_RECORD_SAMPLES) };
  }

  finish(errorCode) {
    if (this.#finishedAt) return this.snapshot();
    if (errorCode !== undefined && errorCode !== null) {
      const normalized = normalizeErrorCode(errorCode) ?? 'UNKNOWN';
      this.reason(REASON_ALIASES[normalized] ?? 'SCAN_FAILED');
      this.#markIncomplete();
    }
    this.#finishedAt = new Date().toISOString();
    return this.snapshot();
  }

  snapshot() {
    const report = {
      schemaVersion: 3,
      patchVersion: this.#patchVersion,
      scanId: this.#scanId,
      startedAt: this.#startedAt,
      finishedAt: this.#finishedAt,
      complete: Boolean(this.#finishedAt) && this.#complete,
      coverageMeaning: 'current-scan-only',
      stages: { ...this.#counters },
      reasons: [...this.#reasons.entries()].map(([code, count]) => ({ code, ...REASONS[code], count })),
      paths: {
        mediaRoot: '<MEDIA_ROOT>',
        logRoot: this.#logRootSource === 'default' ? '<APPDATA>/miHoYo/Olivia-steam/logs' : '<CUSTOM_LOG_ROOT>',
        logRootSource: this.#logRootSource,
        logRootStatus: this.#logRootStatus,
      },
      logFiles: this.#logFiles.map((item) => ({ ...item, stages: { ...item.stages } })),
      issues: this.#issues.map(item => ({ ...item })),
      requestEvidence: structuredClone(this.#requestEvidence),
      recordKeys: this.#recordKeyEvidence(),
      samples: [...this.#directoryFacts.values()].sort((a, b) => (a.displaySource === 'unindexed' ? 2 : Number(a.displayHasName))
        - (b.displaySource === 'unindexed' ? 2 : Number(b.displayHasName))
        || a.ordinal - b.ordinal).slice(0, MAX_SAMPLES).map(item => ({ ...item,
          sampleId: `${this.#scanId.slice(0, 8)}-s${item.ordinal}`,
          certainty: !item.displayHasName && (!this.#complete || item.reasonCode === 'NAME_REASON_UNCERTAIN'
            || item.reasonCode === 'PREFIX_NAME_MISSING') ? 'unknown' : REASONS[item.reasonCode].certainty,
          sources: item.sources.map(source => ({ ...source })) })),
      omitted: { ...this.#omitted, samples: Math.max(0, this.#sampleOrdinal - Math.min(MAX_SAMPLES, this.#directoryFacts.size)) },
    };
    const safeReport = capReport(report);
    return {
      scanId: this.#scanId,
      startedAt: this.#startedAt,
      finishedAt: this.#finishedAt,
      complete: report.complete,
      local: {
        mediaRoot: this.#mediaRoot,
        logRoot: this.#logRoot,
        logRootSource: this.#logRootSource,
        logRootStatus: this.#logRootStatus,
      },
      report: safeReport,
    };
  }

  // Raw values are used only transiently for classification and correlation.
  // Exported samples are constructed from an explicit scalar field allowlist.
  noteNameRecord(nameKey, name, context = {}, { prefix = false, invalidType = false } = {}) {
    if (typeof nameKey !== 'string') return;
    this.increment('recordKeysObserved', 1, context.fileId);
    let reasonCode = 'NAME_AVAILABLE';
    if (typeof name !== 'string' || !name.trim() || name === nameKey) {
      reasonCode = invalidType || (name != null && typeof name !== 'string') ? 'NAME_FIELD_TYPE_INVALID' : prefix && !name ? 'PREFIX_NAME_MISSING'
        : !name ? 'NAME_FIELD_MISSING' : !name.trim() ? 'NAME_BLANK' : 'NAME_EQUALS_KEY';
      this.increment(reasonCode === 'NAME_FIELD_MISSING' || reasonCode === 'PREFIX_NAME_MISSING'
        ? 'missingNameRecords' : 'invalidNameRecords', 1, context.fileId);
      this.issue(context, prefix ? 'prefix' : 'fields', reasonCode, 1, 1);
    } else {
      this.increment('usableNameRecords', 1, context.fileId);
      if (!this.#namedRecords.has(nameKey)) {
        this.#namedRecords.add(nameKey);
        this.increment('uniqueNameRecords', 1, context.fileId);
      }
    }
    if (nameKey.length > 256 || (!this.#recordFacts.has(nameKey) && this.#recordFacts.size >= MAX_KEYS)) {
      this.#omitted.recordKeys++;
      return;
    }
    const fact = this.#recordFacts.get(nameKey) ?? { usable: false, ordinal: ++this.#recordOrdinal, observations: 0 };
    fact.observations++;
    const source = this.source(context, prefix ? 'prefix' : 'fields', reasonCode);
    if (reasonCode === 'NAME_AVAILABLE') { fact.usable = true; fact.usableSource = source; }
    else fact.invalidSource = source;
    this.#recordFacts.set(nameKey, fact);
  }

  markIncomplete() { this.#markIncomplete(); }

  #markIncomplete() { this.#complete = false; }
}

function validSemver(value) {
  return typeof value === 'string' && value.length <= 64
    && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.(?:0|[1-9]\d*))?$/.test(value)
    ? value : null;
}

function safeExtension(name) {
  const basename = typeof name === 'string' ? name.split(/[\\/]/).pop() : '';
  const match = basename?.match(/(\.[A-Za-z0-9]{1,8})$/);
  const extension = match?.[1].toLowerCase();
  return new Set(['.log', '.txt', '.zip', '.gz', '.bak', '.7z']).has(extension) ? extension : '.other';
}

function numericSize(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.min(Math.floor(numeric), Number.MAX_SAFE_INTEGER);
}

function normalizeErrorCode(error) {
  const code = typeof error === 'string' ? error : error?.code;
  if (typeof code !== 'string') return null;
  return ERROR_CODES.has(code) ? code : 'UNKNOWN';
}

function keySamplePriority(sample) {
  return sample.directoryMatch === 'observed' ? 2 : sample.usableNameObserved ? 0 : 1;
}

function capReport(report) {
  const bytes = () => Buffer.byteLength(JSON.stringify(report), 'utf8');
  // Independently bound new sections before considering the existing report.
  while (Buffer.byteLength(JSON.stringify(report.requestEvidence), 'utf8') > 12 * 1024 && report.requestEvidence.structureSamples.length) {
    report.requestEvidence.structureSamples.pop(); report.requestEvidence.omittedStructureSamples++;
  }
  while (Buffer.byteLength(JSON.stringify(report.requestEvidence), 'utf8') > 12 * 1024 && report.requestEvidence.typeSamples.length) {
    report.requestEvidence.typeSamples.pop(); report.requestEvidence.omittedTypeSamples++;
  }
  while (Buffer.byteLength(JSON.stringify(report.recordKeys), 'utf8') > 8 * 1024 && report.recordKeys.samples.length) {
    report.recordKeys.samples.pop(); report.recordKeys.omittedSamples++;
  }
  // Keep diagnostic issues and the highest-priority missing-name samples for
  // as long as possible. Dropped file metadata is accounted for explicitly.
  while (bytes() > MAX_REPORT_BYTES && report.logFiles.length) {
    report.logFiles.pop(); report.omitted.logFiles++;
  }
  while (bytes() > MAX_REPORT_BYTES && report.issues.length) {
    report.omitted.issues += report.issues.pop().count;
  }
  while (bytes() > MAX_REPORT_BYTES && report.samples.length) {
    report.samples.pop(); report.omitted.samples++;
  }
  const retainedFiles = new Set(report.logFiles.map(file => file.fileId));
  for (const source of [...report.issues, ...report.samples.flatMap(sample => sample.sources),
    ...report.requestEvidence.typeSamples.map(sample => sample.source),
    ...report.requestEvidence.structureSamples.map(sample => sample.source),
    ...report.recordKeys.samples.flatMap(sample => sample.sources)]) {
    if (source.fileId && !retainedFiles.has(source.fileId)) {
      source.fileId = null;
      source.fileOmitted = true;
    }
  }
  // These fixed-size counters/labels are bounded independently of log input.
  // Dropping metadata may add fileOmitted flags, so recheck after normalization.
  while (bytes() > MAX_REPORT_BYTES && report.issues.length) report.omitted.issues += report.issues.pop().count;
  while (bytes() > MAX_REPORT_BYTES && report.samples.length) { report.samples.pop(); report.omitted.samples++; }
  while (bytes() > MAX_REPORT_BYTES && report.requestEvidence.structureSamples.length) {
    report.requestEvidence.structureSamples.pop(); report.requestEvidence.omittedStructureSamples++;
  }
  while (bytes() > MAX_REPORT_BYTES && report.recordKeys.samples.length) {
    report.recordKeys.samples.pop(); report.recordKeys.omittedSamples++;
  }
  return report;
}
