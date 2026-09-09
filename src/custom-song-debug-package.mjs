import crypto from 'node:crypto';
import fs from 'node:fs';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { SERVICE_VERSION } from './constants.mjs';
import { scanCustomSongs } from './custom-song-scan.mjs';
import { ScanDiagnostics } from './custom-song-diagnostics.mjs';
import { SongEvidenceAnonymizer, isSongEvidenceCandidate } from './custom-song-debug-anonymize.mjs';
import { redactSongFragment, FRAGMENT_POLICY } from './custom-song-fragment-redact.mjs';
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

export async function collectSongDebugPackage({ mediaRoot, logRoot, logRootSource = 'custom', mappingEntries = [], io = {}, signal, onProgress = () => {}, limits = {} }) {
  const budget = { ...DEBUG_LIMITS, ...limits };
  const diagnostics = new ScanDiagnostics({ mediaRoot, logRoot, logRootSource: logRootSource === 'default' ? 'default' : 'custom', patchVersion: SERVICE_VERSION });
  const events = [], directories = [], fileOrders = new Map();
  const coverage = { candidateEvents: 0, retainedEvents: 0, omittedEvents: 0, retainedBytes: 0,
    omittedDirectories: 0, omittedFiles: 0, inputFilesChanged: 0, inputFilesUnavailableAfterRead: 0,
    rawEligibleEvents: 0, rawRetainedEvents: 0, rawOmittedEvents: 0, candidateProbeLimitedEvents: 0 };
  const snapshots = new Map(), readPaths = new Set();
  const baseIo = { lstat: fs.promises.lstat, readdir: fs.promises.readdir, createReadStream: fs.createReadStream, ...io };
  const check = () => { if (signal?.aborted) throw error('DEBUG_CAPTURE_CANCELLED', 409); };
  const observedIo = {
    async lstat(target) { check(); const info = await baseIo.lstat(target); if (info.isFile()) snapshots.set(target, { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino }); return info; },
    async readdir(...args) { check(); return baseIo.readdir(...args); },
    createReadStream(target, options) {
      check(); readPaths.add(target); const saved = snapshots.get(target);
      return baseIo.createReadStream(target, { ...options, ...(signal ? { signal } : {}), ...(saved?.size > 0 ? { end: saved.size - 1 } : {}) });
    },
  };
  diagnostics.observeLogLine = (line, context, outer) => {
    check(); const probe = candidate(line, outer);
    if (probe.limited) coverage.candidateProbeLimitedEvents++;
    if (!probe.matched) return;
    coverage.candidateEvents++;
    const size = Buffer.byteLength(line);
    if (events.length >= budget.events || size > budget.eventBytes || coverage.retainedBytes + size > budget.evidenceBytes) { coverage.omittedEvents++; return; }
    if (!fileOrders.has(context.fileId)) fileOrders.set(context.fileId, fileOrders.size);
    events.push({ text: line, fileOrder: fileOrders.get(context.fileId), source: { fileId: context.fileId, line: context.line } });
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
    const capturedScan = await scanCustomSongs({ mediaRoot, logRoot, diagnostics, mappingEntries, io: observedIo,
      inspectMedia: async () => ({ valid: false, reason: 'capture-no-video' }) });
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
    const material = { events: [], directories: directories.map(item => ({ key: aliases.key(item.key), files: item.files.map(file => aliases.file(file)) })), mappings: [] };
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
    const sensitive = [], rawCandidates = []; let rawBytes = 0, sanitizedBytes = 0;
    for (let index = 0; index < events.length; index++) {
      check(); if (index % 32 === 0) await yieldTurn();
      const event = events[index], redacted = aliases.line(event.text);
      const redactedBytes = Buffer.byteLength(redacted.text);
      sanitizedBytes += redactedBytes;
      if (redactedBytes > DEBUG_LIMITS.eventBytes || sanitizedBytes > DEBUG_LIMITS.evidenceBytes) throw error('DEBUG_REDACTION_EXPANSION_LIMIT', 413);
      const source = { ...event.source };
      if (!report.logFiles.some(file => file.fileId === source.fileId)) { source.fileId = null; source.fileOmitted = true; }
      material.events.push({ text: redacted.text, fileOrder: event.fileOrder, source });
      const before = eventInvariant(event.text, aliases), after = eventInvariant(redacted.text);
      const equivalent = JSON.stringify(before) === JSON.stringify(after);
      const reasons = [...redacted.losses, ...(!equivalent ? ['production-invariant-difference'] : [])];
      verification.events.push({ eventIndex: index, status: equivalent && !reasons.length ? 'equivalent' : 'lossy',
        productionEquivalent: equivalent, reasons });
      const rawReasons = reasons.filter(reason => !['outer-field-aliased', 'outer-number-generalized'].includes(reason));
      if (rawReasons.length) {
        coverage.rawEligibleEvents++;
        rawCandidates.push({ index, priority: !equivalent ? 3 : rawReasons.some(reason => ['unknown-action-aliased', 'unknown-field-aliased'].includes(reason)) ? 2 : 1 });
      }
    }
    coverage.fragmentOmissions = {};
    verification.fragments = [];
    rawCandidates.sort((a, b) => b.priority - a.priority || a.index - b.index);
    for (const { index } of rawCandidates) {
      const event = events[index], marker = event.text.indexOf('[OTEL Logger]');
      const raw = marker >= 0 ? event.text.slice(marker) : event.text;
      const fragment = redactSongFragment(raw, { bytes: budget.rawEventBytes });
      const bytes = fragment.ok ? Buffer.byteLength(fragment.text) : 0;
      const reason = !fragment.ok ? fragment.reason : sensitive.length >= budget.rawEvents || rawBytes + bytes > budget.rawBytes ? 'attachment-budget-exceeded' : null;
      if (reason) { coverage.fragmentOmissions[reason] = (coverage.fragmentOmissions[reason] || 0) + 1; continue; }
      const productionEquivalent = JSON.stringify(eventInvariant(raw)) === JSON.stringify(eventInvariant(fragment.text));
      verification.fragments.push({ eventIndex: index, productionEquivalent, redactions: fragment.redactions });
      sensitive.push({ eventIndex: index, source: material.events[index].source, text: fragment.text,
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
      limitations: ['not-an-atomic-filesystem-backup', 'no-video-content-or-period-validation', 'mapping-name-fields-only',
        'unknown-fields-and-actions-may-be-lossy', 'missing-history-cannot-be-recovered', 'candidate-key-probe-bounded-to-128-nodes', 'no-backup-decompression-or-other-accounts'],
    };
    check();
    const bundle = { format: 'linli-song-debug', schemaVersion: 2, manifest, diagnostics: report, material, verification };
    // Freeze a validated downloadable default before exposing ready; never defer a default format/size failure to download.
    const defaultArchive = encodeSongDebugPackage(bundle);
    return { bundle, sensitive, defaultArchive };
  } finally { events.length = 0; directories.length = 0; snapshots.clear(); readPaths.clear(); }
}

export function encodeSongDebugPackage(bundle) {
  validateReplayMaterial(bundle.material);
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
    job.promise = this.collect({ ...input, signal: job.controller.signal, onProgress: progress => {
      if (this.job === job) { job.state = progress.phase; job.progress = progress.retainedEvents; }
    } }).then(snapshot => {
      if (this.job !== job || job.controller.signal.aborted) return;
      job.snapshot = snapshot; job.state = 'ready'; job.confirmationId = crypto.randomBytes(24).toString('base64url');
    }).catch(caught => { if (this.job === job) {
      job.state = 'failed'; job.snapshot = null; job.confirmationId = null;
      job.failureCode = ['DEBUG_REDACTION_EXPANSION_LIMIT', 'DEBUG_PACKAGE_TOO_LARGE'].includes(caught?.message) ? caught.message : 'DEBUG_CAPTURE_FAILED';
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
    if (input.includeRaw) { bundle.sensitive = job.snapshot.sensitive; bundle.manifest.sensitivity = 'SENSITIVE-PRIVATE-SHARING-ONLY'; }
    const bytes = !input.includeRaw && job.snapshot.defaultArchive ? job.snapshot.defaultArchive : encodeSongDebugPackage(bundle);
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
