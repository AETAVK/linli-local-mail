import crypto from 'node:crypto';
import { VisionTaskStore, VISION_LIMITS } from './custom-song-vision-store.mjs';
import { VISION_ALGORITHM, VISION_POLICY } from './custom-song-vision-policy.mjs';
import { describeVisionSong, commitVisionGroup, undoVisionJob } from './custom-song-vision-write.mjs';
const failure = (message, status = 409) => Object.assign(new Error(message), { status });
const ACTIVE = ['queued', 'running', 'waiting-environment', 'paused', 'interrupted'];

export class VisionTaskService {
  constructor(catalog, { clock = () => Date.now() } = {}) {
    this.catalog = catalog; this.store = new VisionTaskStore(catalog.db, clock); this.starting = null; this.autoDenied = false;
  }
  enabled() {
    return !this.autoDenied && [undefined, '1'].includes(this.store.db.prepare("SELECT value FROM settings WHERE key='musicLibrary.visionAutoFillEnabled'").get()?.value) &&
      this.store.db.prepare("SELECT value FROM settings WHERE key='vision.autoCapacityBlocked'").get()?.value !== '1';
  }
  root(input) { return this.catalog.root(input); }
  currentRoot() { return this.catalog.refresh?.root || this.catalog.scannedRoot || this.catalog.root(); }
  blocked() { return Boolean(this.userMutation || this.catalog.inFlight || this.catalog.mappingMutation || ['collecting', 'verifying'].includes(this.catalog.debugPackages?.job?.state)); }
  assertRoot(root) { if (this.currentRoot() !== root) throw failure('当前曲库已变化，请重新选择任务'); }
  reap() {
    const lease = this.store.lease();
    if (!lease || lease.expiresAt > this.store.clock()) return;
    const job = this.store.job(lease.jobId);
    for (const target of lease.targets) if (this.store.item(target.itemId)?.state === 'claimed') this.store.updateItem(target.itemId, 'pending', 'decoder-disconnected');
    if (job && ['queued', 'running'].includes(job.status)) this.store.updateJob(job.id, job.mode === 'manual' ? 'interrupted' : 'waiting-environment', 'decoder-disconnected', true);
    this.store.setLease(null);
  }
  revoke(jobId) {
    const lease = this.store.lease();
    if (lease?.jobId === jobId) this.store.setLease({ ...lease, revoked: true });
  }
  async start({ mediaRoot, mode = 'manual', retryUnknown = false } = {}) {
    if (!['manual', 'auto'].includes(mode) || typeof retryUnknown !== 'boolean') throw failure('识别任务参数无效', 400);
    const root = this.root(mediaRoot); this.assertRoot(root);
    if (!this.catalog.mappings) throw failure('请先建立本地歌曲映射表', 503);
    if (mode === 'auto' && !this.enabled()) return { autoEnabled: false, job: null };
    if (this.blocked()) throw failure('正在处理曲库，请稍后识别');
    if (this.starting) {
      const same = this.startingRoot === root && this.startingMode === mode, result = await this.starting;
      if (same) return result;
      await Promise.resolve(); return this.start({ mediaRoot: root, mode, retryUnknown });
    }
    this.startingRoot = root; this.startingMode = mode;
    this.starting = this.startOwned(root, mode, retryUnknown);
    try { return await this.starting; } finally { this.starting = null; }
  }
  async startOwned(root, mode, retryUnknown) {
    if (mode === 'auto') {
      const manual = this.store.jobs(root).find(job => job.mode === 'manual' && ACTIVE.includes(job.status));
      if (manual) return { autoEnabled: this.enabled(), job: this.store.summary(manual), reason: 'manual-priority' };
    }
    const existing = this.store.jobs(root).find(job => job.mode === mode && ACTIVE.includes(job.status));
    if (existing) {
      if (mode === 'auto' && ['interrupted', 'paused'].includes(existing.status) && ['service-restarted', 'auto-disabled'].includes(existing.reason)) this.store.updateJob(existing.id, 'queued');
      return { autoEnabled: this.enabled(), job: this.store.summary(this.store.job(existing.id)) };
    }
    if (mode === 'manual') for (const job of this.store.jobs(root).filter(job => job.mode === 'auto' && ['queued', 'running'].includes(job.status))) {
      this.store.updateJob(job.id, 'paused', 'manual-priority', true); this.revoke(job.id);
    }
    const rows = this.store.db.prepare('SELECT name_key FROM custom_songs WHERE root=? AND available=1 ORDER BY name_key').all(root);
    const items = [], inventory = { songs: rows.length, protectedVideos: 0, omittedVideos: 0, policy: VISION_POLICY };
    for (const row of rows) {
      const described = await describeVisionSong(this.catalog, row.name_key);
      this.assertRoot(root); if (mode === 'auto' && !this.enabled()) return { autoEnabled: false, job: null };
      if (!described) continue;
      for (const file of described.files) {
        if (file.reason && !['missing-file', 'conflict'].includes(file.reason)) { inventory.protectedVideos++; continue; }
        if (items.length >= VISION_LIMITS.items) { inventory.omittedVideos++; continue; }
        const item = { nameKey: row.name_key, fileName: file.raw.fileName, revision: file.display?.fileRevision, state: 'pending' };
        if (mode === 'manual' && retryUnknown) this.store.forget(root, item.nameKey, item.fileName);
        const cached = item.revision && this.store.cache(item.revision);
        if (file.reason === 'missing-file') Object.assign(item, { state: 'missing', reason: 'missing-file' });
        else if (file.reason === 'conflict' || described.files.length > VISION_LIMITS.filesPerSong) Object.assign(item, { state: 'review', reason: 'conflict-or-too-many-files' });
        else if (cached?.kind === 'suppressed') Object.assign(item, { state: 'skipped', reason: 'stopped-or-undone' });
        else if (cached?.kind === 'unknown') Object.assign(item, { state: 'review', reason: cached.value.reason, cached: true });
        else if (cached?.kind === 'known') item.cached = true;
        items.push(item);
      }
    }
    if (mode === 'auto' && !items.some(item => item.state === 'pending')) return { autoEnabled: this.enabled(), job: null, inventory };
    const job = this.store.transaction(() => this.store.create(root, mode, items, inventory));
    return { autoEnabled: this.enabled(), job: this.store.summary(job) };
  }
  status({ mediaRoot, jobId, cursor = 0 } = {}) {
    this.reap(); const root = this.root(mediaRoot), jobs = this.store.jobs(root);
    const selected = jobId ? jobs.find(job => job.id === jobId) : jobs.find(job => ACTIVE.includes(job.status) && job.mode === 'manual') || jobs.find(job => ACTIVE.includes(job.status)) || jobs[0];
    return { autoEnabled: this.enabled(), job: this.store.summary(selected, cursor),
      jobs: jobs.map(job => ({ id: job.id, status: job.status, mode: job.mode, createdAt: job.created_at })), busy: this.blocked(),
      decoder: this.store.lease() ? { clientId: this.store.lease().clientId, jobId: this.store.lease().jobId } : null };
  }
  async claim({ mediaRoot, clientId, capabilities } = {}) {
    this.reap(); const root = this.root(mediaRoot); this.assertRoot(root);
    if (typeof clientId !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(clientId)) throw failure('解码窗口标识无效', 400);
    if (!capabilities || capabilities.visible !== true || capabilities.canvas !== true || capabilities.rvfc !== true) return { state: 'waiting-environment' };
    if (this.blocked() || this.store.lease()) return { state: 'busy' };
    const eligible = this.store.jobs(root).filter(job => ['queued', 'running'].includes(job.status) && (job.mode === 'manual' || this.enabled()));
    const job = eligible.find(job => job.mode === 'manual') || eligible[0];
    if (!job) return { state: 'idle' };
    const owner = JSON.parse(job.inventory_json).ownerClientId;
    if (job.mode === 'manual' && owner && owner !== clientId) return { state: 'manual-resume-required' };
    const first = this.store.pending(job.id)[0];
    if (!first) { this.finishJobIfDone(job.id); return { state: 'idle' }; }
    const described = await describeVisionSong(this.catalog, first.name_key);
    const currentJob = this.store.job(job.id);
    if (this.store.lease() || currentJob.generation !== job.generation || !['queued', 'running'].includes(currentJob.status) || job.mode === 'auto' && !this.enabled() || this.blocked()) return { state: 'busy' };
    this.assertRoot(root);
    const currentOwner = JSON.parse(currentJob.inventory_json).ownerClientId;
    if (job.mode === 'manual' && currentOwner && currentOwner !== clientId) return { state: 'manual-resume-required' };
    const targets = [];
    for (const item of this.store.pending(job.id, first.name_key)) {
      const cache = this.store.cache(item.revision);
      if (cache?.kind === 'suppressed' || job.mode === 'auto' && cache?.kind === 'unknown') {
        this.store.updateItem(item.id, cache.kind === 'suppressed' ? 'skipped' : 'review', cache.value.reason || 'cached-review', cache.value, true); continue;
      }
      const file = described?.files.find(file => file.raw.fileName === item.file_name);
      if (!file?.display || file.reason || file.display.fileRevision !== item.revision) {
        this.store.updateItem(item.id, file?.reason === 'missing-file' ? 'missing' : 'skipped', file?.reason || 'file-changed'); continue;
      }
      targets.push({ itemId: item.id, fileName: item.file_name, fileRevision: item.revision, stateHash: file.stateHash, url: file.display.url,
        cached: this.store.cache(item.revision)?.kind === 'known' });
    }
    if (!targets.length) { this.finishJobIfDone(job.id); return { state: 'retry' }; }
    const lease = { token: crypto.randomUUID(), clientId, jobId: job.id, generation: job.generation, mode: job.mode,
      root, nameKey: first.name_key, targets, expiresAt: this.store.clock() + VISION_LIMITS.leaseMs, revoked: false };
    this.store.transaction(() => {
      if (job.mode === 'manual') this.store.db.prepare('UPDATE song_vision_jobs SET inventory_json=? WHERE id=?')
        .run(JSON.stringify({ ...JSON.parse(currentJob.inventory_json), ownerClientId: clientId }), job.id);
      this.store.setLease(lease); this.store.updateJob(job.id, 'running');
      for (const target of targets) this.store.updateItem(target.itemId, 'claimed');
    });
    return { state: 'claimed', lease, algorithm: VISION_ALGORITHM, policy: VISION_POLICY };
  }
  assertLease(input) {
    const lease = this.store.lease(), job = lease && this.store.job(lease.jobId);
    if (!lease || lease.token !== input.token || lease.clientId !== input.clientId || lease.generation !== input.generation || lease.revoked || lease.expiresAt <= this.store.clock() ||
      !job || job.generation !== lease.generation || !['queued', 'running'].includes(job.status) || job.mode === 'auto' && !this.enabled() || job.root !== this.currentRoot() || this.blocked())
      throw failure('任务已暂停、停止或数据环境变化，忽略迟到结果');
    return lease;
  }
  heartbeat(input) {
    try { const lease = this.assertLease(input); lease.expiresAt = this.store.clock() + VISION_LIMITS.leaseMs; this.store.setLease(lease); return { accepted: true, expiresAt: lease.expiresAt }; }
    catch { return { accepted: false }; }
  }
  async submit(input) {
    const lease = this.assertLease(input);
    try { return await commitVisionGroup(this, lease, input.reports); }
    catch (error) {
      const job = this.store.job(lease.jobId);
      if (this.store.lease()?.token === lease.token && job?.generation === lease.generation && ['queued','running'].includes(job.status)) {
        this.release(lease); this.store.updateJob(job.id, 'paused', 'save-failed', true);
      }
      throw error;
    }
  }
  release(input) {
    const lease = this.store.lease();
    if (!lease || lease.token !== input.token || lease.clientId !== input.clientId) return { released: false };
    for (const target of lease.targets) if (this.store.item(target.itemId)?.state === 'claimed') this.store.updateItem(target.itemId, 'pending', 'decoder-released');
    this.store.setLease(null); return { released: true };
  }
  waitForEnvironment(lease, reason) {
    this.release(lease); this.store.updateJob(lease.jobId, 'waiting-environment', reason, true);
    return { waiting: true, job: this.store.summary(this.store.job(lease.jobId)) };
  }
  finishRejected(lease, reason) {
    this.assertLease(lease);
    for (const target of lease.targets) this.store.updateItem(target.itemId, 'skipped', reason);
    this.store.setLease(null); this.finishJobIfDone(lease.jobId);
    return { saved: 0, job: this.store.summary(this.store.job(lease.jobId)) };
  }
  finishJobIfDone(id) {
    const job = this.store.job(id);
    if (job && !this.store.hasRemaining(id)) {
      this.store.updateJob(id, 'completed'); if (job.mode === 'manual') this.resumeAutomatic(job.root);
    }
  }
  resumeAutomatic(root) {
    if (!this.enabled() || this.userMutation || this.store.jobs(root).some(job => job.mode === 'manual' && ACTIVE.includes(job.status))) return;
    for (const job of this.store.jobs(root).filter(job => job.mode === 'auto' && job.status === 'paused' && job.reason === 'manual-priority')) this.store.updateJob(job.id, 'queued');
  }
  control({ mediaRoot, jobId, action, token, clientId, generation, reason } = {}) {
    if (action === 'release') return this.release({ token, clientId });
    const root = this.root(mediaRoot), job = this.store.job(jobId);
    if (!job || job.root !== root) throw failure('找不到当前曲库的识别任务', 404);
    if (action === 'resume') {
      this.assertRoot(root); if (job.mode === 'auto' && !this.enabled()) throw failure('自动补齐未开启');
      if (!ACTIVE.includes(job.status)) return { job: this.store.summary(job) };
      this.revoke(job.id);
      if (typeof clientId === 'string' && /^[a-zA-Z0-9-]{8,100}$/.test(clientId)) this.store.db.prepare('UPDATE song_vision_jobs SET inventory_json=? WHERE id=?')
        .run(JSON.stringify({ ...JSON.parse(job.inventory_json), ownerClientId: clientId }), job.id);
      this.store.updateJob(job.id, 'queued', '', true);
    } else if (action === 'disconnect') {
      const active = this.store.lease(), owner = JSON.parse(job.inventory_json).ownerClientId;
      if (generation !== job.generation || active && active.clientId !== clientId || !active && owner !== clientId) return { job: this.store.summary(job) };
      if (active) this.release(active);
      this.store.updateJob(job.id, job.mode === 'manual' ? 'interrupted' : 'waiting-environment', 'decoder-disconnected', true);
    } else if (action === 'pause' || action === 'environment') {
      const active = this.store.lease(), owner = JSON.parse(job.inventory_json).ownerClientId;
      if (action === 'environment' && (active && active.clientId !== clientId || job.mode === 'manual' && owner && owner !== clientId)) return { job: this.store.summary(job) };
      if (ACTIVE.includes(job.status)) this.store.updateJob(job.id, action === 'environment' ? 'waiting-environment' : 'paused',
        ['hidden', 'unsupported', 'manual-priority', 'root-changed'].includes(reason) ? reason : 'paused-by-user', true);
      this.revoke(job.id);
    } else if (action === 'stop') {
      this.store.transaction(() => {
        this.store.updateJob(job.id, 'stopped', 'stopped-by-user', true); this.revoke(job.id);
        for (const item of this.store.items(job.id).filter(item => ['pending', 'claimed'].includes(item.state))) {
          this.store.updateItem(item.id, 'stopped', 'stopped-by-user');
          if (item.revision) this.store.putCache(root, item, 'suppressed', { reason: 'stopped-by-user' });
        }
      });
      if (job.mode === 'manual') this.resumeAutomatic(root);
    } else throw failure('任务操作无效', 400);
    return { job: this.store.summary(this.store.job(job.id)) };
  }
  setAutoPermission(enabled) {
    this.autoDenied = enabled !== true;
    if (!enabled) for (const job of this.store.db.prepare("SELECT * FROM song_vision_jobs WHERE mode='auto' AND status IN ('queued','running','waiting-environment')").all()) {
      this.store.updateJob(job.id, 'paused', 'auto-disabled', true); this.revoke(job.id);
    }
  }
  async undo({ mediaRoot, jobId } = {}) {
    const root = this.root(mediaRoot); this.assertRoot(root);
    const job = this.store.job(jobId);
    if (!job || job.root !== root) throw failure('找不到识别任务', 404);
    if (this.blocked()) throw failure('正在处理曲库，请稍后撤销');
    this.userMutation = true;
    for (const automatic of this.store.jobs(root).filter(item => item.mode === 'auto' && ['queued', 'running'].includes(item.status))) {
      this.store.updateJob(automatic.id, 'paused', 'manual-priority', true); this.revoke(automatic.id);
    }
    try { return await undoVisionJob(this, job); }
    finally { this.userMutation = false; this.resumeAutomatic(root); }
  }
  async locate({ mediaRoot, nameKey } = {}) {
    const root = this.root(mediaRoot); this.assertRoot(root); let index = 0;
    for (const row of this.store.db.prepare('SELECT * FROM custom_songs WHERE root=? AND available=1 ORDER BY name_key').all(root)) {
      const song = await this.catalog.present(row); if (!song) continue;
      if (row.name_key === nameKey) return { cursor: Math.floor(index / 100) * 100, nameKey, mediaRoot: root };
      index++;
    }
    throw failure('曲目已移动或不可用，请重新扫描后查看', 404);
  }
  close() {
    const lease = this.store.lease();
    if (lease) { this.release(lease); this.store.updateJob(lease.jobId, 'interrupted', 'service-restarted', true); }
  }
}
