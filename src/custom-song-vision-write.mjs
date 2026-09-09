import crypto from 'node:crypto';
import { mappingKey } from './custom-song-mappings.mjs';
import { VISION_ALGORITHM, VISION_POLICY, evaluateVisionFrames } from './custom-song-vision-policy.mjs';
import { visionEligibility, visionStateHash, occupiedVisionPeriods } from './custom-song-vision-evidence.mjs';

export async function describeVisionSong(catalog, nameKey) {
  const row = catalog.db.prepare('SELECT * FROM custom_songs WHERE name_key=? AND available=1').get(nameKey);
  if (!row) return null;
  const shown = await catalog.present(row), table = new Map((catalog.mappings?.read() || []).map(entry => [mappingKey(entry.fileName), entry]));
  return { row, files: JSON.parse(row.files_json).map(raw => {
    const entry = table.get(mappingKey(raw.fileName));
    const matching = entry && (!entry.filePath || entry.filePath.toLowerCase() === `${row.name_key}/${raw.fileName}`.toLowerCase()) ? entry : null;
    const display = shown?.localFiles.find(file => file.fileName === raw.fileName);
    return { raw, display, entry: matching, reason: visionEligibility(row, raw, display, matching),
      stateHash: visionStateHash(row, raw, matching) };
  }) };
}

// All asynchronous checks precede the final state recheck and synchronous JSON/SQLite commit.
export async function commitVisionGroup(service, lease, reports) {
  const { catalog, store } = service;
  service.assertLease(lease);
  if (!Array.isArray(reports) || reports.length !== lease.targets.length || new Set(reports.map(report => report?.fileName)).size !== reports.length)
    throw Object.assign(new Error('需要提交领取的整组视频结果'), { status: 400 });
  const described = await describeVisionSong(catalog, lease.nameKey);
  service.assertLease(lease);
  if (!described || described.row.root !== lease.root) return service.finishRejected(lease, 'root-or-song-changed');
  const reportMap = new Map(reports.map(report => [report?.fileName, report]));
  const outcomes = [];
  for (const target of lease.targets) {
    const current = described.files.find(file => file.raw.fileName === target.fileName), report = reportMap.get(target.fileName);
    if (!report || report.fileRevision !== target.fileRevision) throw Object.assign(new Error('视频结果版本不匹配'), { status: 400 });
    if (!current?.display) { outcomes.push({ target, state: 'missing', reason: 'missing-file' }); continue; }
    if (current.display.fileRevision !== target.fileRevision || current.stateHash !== target.stateHash || current.reason) {
      outcomes.push({ target, state: 'skipped', reason: current.reason || 'file-or-mapping-changed' }); continue;
    }
    if (report.errorCode) {
      if (!['media-error', 'timeout', 'environment', 'unsupported', 'aborted'].includes(report.errorCode)) throw Object.assign(new Error('取帧错误分类无效'), { status: 400 });
      if (report.errorCode !== 'media-error') return service.waitForEnvironment(lease, report.errorCode);
      outcomes.push({ target, state: 'failed', reason: 'media-error', result: { tod: null, reason: 'media-error', cacheable: true, frames: [] } });
      continue;
    }
    const cached = report.useCache === true ? store.cache(target.fileRevision) : null;
    const result = cached && cached.kind === 'known' ? cached.value : evaluateVisionFrames(report);
    if (!result.cacheable) return service.waitForEnvironment(lease, result.reason);
    outcomes.push({ target, state: result.tod ? 'candidate' : 'review', reason: result.reason, result, cached: Boolean(cached && cached.kind === 'known') });
  }
  // Verify every actual file immediately before the commit barrier, including occupied periods.
  for (const file of described.files) {
    if (!file.display) continue;
    let current;
    try { current = catalog.fileRevision(await catalog.resolveFile(described.row, file.raw.fileName)); }
    catch { return service.finishRejected(lease, 'file-or-mapping-changed'); }
    if (current !== file.display.fileRevision) return service.finishRejected(lease, 'file-or-mapping-changed');
  }
  service.assertLease(lease);
  const freshRow = catalog.db.prepare('SELECT * FROM custom_songs WHERE name_key=? AND available=1').get(lease.nameKey);
  const entries = catalog.mappings.read(), table = new Map(entries.map(entry => [mappingKey(entry.fileName), entry]));
  if (!freshRow || freshRow.files_json !== described.row.files_json || freshRow.overrides_json !== described.row.overrides_json || freshRow.updated_at !== described.row.updated_at)
    return service.finishRejected(lease, 'file-or-mapping-changed');
  for (const file of described.files) {
    const entry = table.get(mappingKey(file.raw.fileName));
    const current = entry && (!entry.filePath || entry.filePath.toLowerCase() === `${lease.nameKey}/${file.raw.fileName}`.toLowerCase()) ? entry : null;
    if (visionStateHash(freshRow, file.raw, current) !== file.stateHash) return service.finishRejected(lease, 'file-or-mapping-changed');
  }
  const occupied = occupiedVisionPeriods(described.files);
  for (const outcome of outcomes.filter(item => item.state === 'candidate')) {
    if (occupied.has(outcome.result.tod) || outcomes.some(other => other !== outcome && other.result?.tod === outcome.result.tod)) {
      outcome.state = 'review'; outcome.reason = 'duplicate-period';
    }
  }
  const files = JSON.parse(freshRow.files_json), now = store.clock();
  const save = outcomes.filter(outcome => outcome.state === 'candidate');
  const updateState = () => {
    service.assertLease(lease);
    for (const outcome of outcomes) {
      const item = store.item(outcome.target.itemId);
      if (outcome.result) store.putCache(lease.root, item, outcome.result.tod ? 'known' : 'unknown', outcome.result);
      if (outcome.state !== 'candidate') { store.updateItem(item.id, outcome.state, outcome.reason, outcome.result, outcome.cached); continue; }
      const index = files.findIndex(file => file.fileName === item.file_name), original = files[index];
      const key = mappingKey(item.file_name), priorEntry = table.get(key) || null;
      const vision = { schemaVersion: 1, algorithm: VISION_ALGORITHM, policy: VISION_POLICY, fileRevision: item.revision,
        batchId: lease.jobId, itemId: item.id, writeId: crypto.randomUUID(), savedAt: now,
        frames: outcome.result.frames.map(({ time, target, verified, tod, reason }) => ({ time, target, verified, tod, reason })) };
      const next = { ...original, tod: outcome.result.tod, evidence: 'vision', vision };
      delete next.mappingManual; delete next.mappingTod; delete next.manualUnknown;
      files[index] = next;
      const displayName = priorEntry?.name || freshRow.custom_name || freshRow.name;
      const entry = { fileName: item.file_name, filePath: `${lease.nameKey}/${item.file_name}`,
        name: displayName === lease.nameKey ? '' : displayName,
        tod: next.tod, view: next.view || null, automatic: next };
      table.set(key, entry);
      store.updateItem(item.id, 'saved', 'visual-inference', outcome.result, outcome.cached);
      const hash = visionStateHash({ ...freshRow, files_json: JSON.stringify(files) }, next, entry, { includeRowVersion: false });
      store.db.prepare('UPDATE song_vision_items SET before_json=?,write_hash=? WHERE id=?')
        .run(JSON.stringify({ file: original, entry: priorEntry, fileRevision: item.revision }), hash, item.id);
    }
    if (save.length) store.db.prepare('UPDATE custom_songs SET files_json=?,updated_at=? WHERE name_key=?').run(JSON.stringify(files), now, lease.nameKey);
    store.setLease(null); service.finishJobIfDone(lease.jobId);
  };
  if (save.length) {
    // updateState constructs the entries synchronously; commitMappings writes the same mutable array after this callback.
    const nextEntries = [...entries];
    catalog.commitMappings(nextEntries, () => { updateState(); nextEntries.splice(0, nextEntries.length, ...table.values()); });
    catalog.invalidatePresentationCache(); catalog.refresh?.invalidate();
  } else store.transaction(updateState);
  return { saved: save.length, applied: save.map(outcome => ({ nameKey: lease.nameKey, fileName: outcome.target.fileName,
    fileRevision: outcome.target.fileRevision, tod: outcome.result.tod, evidence: 'vision' })), job: store.summary(store.job(lease.jobId)) };
}

export async function undoVisionJob(service, job) {
  const { catalog, store } = service;
  service.control({ mediaRoot: job.root, jobId: job.id, action: 'stop' });
  const summary = { undone: 0, skipped: 0, reasons: {} };
  for (const item of store.items(job.id).filter(item => item.state === 'saved' && item.before_json)) {
    let reason = '', row = catalog.db.prepare('SELECT * FROM custom_songs WHERE name_key=?').get(item.name_key);
    const files = row ? JSON.parse(row.files_json) : [], file = files.find(file => file.fileName === item.file_name);
    const entries = catalog.mappings.read(), entry = entries.find(entry => mappingKey(entry.fileName) === mappingKey(item.file_name));
    if (!row || row.root !== job.root || file?.vision?.batchId !== job.id || file.vision.itemId !== item.id) reason = 'owner-changed';
    else if (visionStateHash(row, file, entry, { includeRowVersion: false }) !== item.write_hash) reason = 'edited-after-save';
    if (!reason) {
      try { if (catalog.fileRevision(await catalog.resolveFile(row, item.file_name)) !== item.revision) reason = 'file-changed'; }
      catch { reason = 'missing-file'; }
    }
    const currentRow = catalog.db.prepare('SELECT * FROM custom_songs WHERE name_key=?').get(item.name_key);
    const currentEntries = catalog.mappings.read();
    if (!reason && (currentRow?.files_json !== row.files_json || currentRow?.overrides_json !== row.overrides_json || JSON.stringify(currentEntries) !== JSON.stringify(entries))) reason = 'edited-after-save';
    if (!reason && service.currentRoot() !== job.root) reason = 'root-changed';
    if (reason) { summary.skipped++; summary.reasons[reason] = (summary.reasons[reason] || 0) + 1; continue; }
    const before = JSON.parse(item.before_json), index = files.findIndex(file => file.fileName === item.file_name), key = mappingKey(item.file_name);
    files[index] = before.file;
    const table = new Map(currentEntries.map(entry => [mappingKey(entry.fileName), entry]));
    if (before.entry) table.set(key, before.entry); else table.delete(key);
    catalog.commitMappings([...table.values()], () => {
      store.db.prepare('UPDATE custom_songs SET files_json=?,updated_at=? WHERE name_key=?').run(JSON.stringify(files), store.clock(), item.name_key);
      store.updateItem(item.id, 'undone', 'undone-by-user'); store.putCache(job.root, item, 'suppressed', { reason: 'undone-by-user' });
    });
    summary.undone++;
  }
  store.updateJob(job.id, 'undone', summary.skipped ? 'some-items-protected' : 'undone-by-user', true);
  catalog.invalidatePresentationCache(); catalog.refresh?.invalidate();
  return { ...summary, job: store.summary(store.job(job.id)) };
}
