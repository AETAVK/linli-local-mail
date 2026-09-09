import crypto from 'node:crypto';
import { VISION_ALGORITHM, VISION_POLICY } from './custom-song-vision-policy.mjs';

export const VISION_LIMITS = Object.freeze({ jobs: 32, items: 10000, filesPerSong: 12, cache: 10000, leaseMs: 30000 });
export class VisionTaskStore {
  constructor(db, clock = () => Date.now()) {
    this.db = db; this.clock = clock;
    db.exec(`CREATE TABLE IF NOT EXISTS song_vision_jobs (
      id TEXT PRIMARY KEY,root TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '',
      generation INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,inventory_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS song_vision_items (
      id TEXT PRIMARY KEY,job_id TEXT NOT NULL,name_key TEXT NOT NULL,file_name TEXT NOT NULL,revision TEXT,state TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '',
      cache_hit INTEGER NOT NULL DEFAULT 0,result_json TEXT,before_json TEXT,write_hash TEXT,
      UNIQUE(job_id,name_key,file_name));
      CREATE INDEX IF NOT EXISTS song_vision_item_jobs ON song_vision_items(job_id,state,name_key);
      CREATE TABLE IF NOT EXISTS song_vision_cache (
      key TEXT PRIMARY KEY,root TEXT NOT NULL,name_key TEXT NOT NULL,file_name TEXT NOT NULL,kind TEXT NOT NULL,value_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS song_vision_lease (id INTEGER PRIMARY KEY CHECK(id=1),value_json TEXT NOT NULL);`);
    // A new service cannot inherit a decoder or silently resume a manual write task.
    db.prepare("UPDATE song_vision_jobs SET status='interrupted',generation=generation+1,reason='service-restarted',updated_at=? WHERE status IN ('queued','running','waiting-environment')").run(clock());
    db.exec("UPDATE song_vision_items SET state='pending' WHERE state='claimed'; DELETE FROM song_vision_lease;");
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }
  jobs(root) { return this.db.prepare('SELECT * FROM song_vision_jobs WHERE root=? ORDER BY created_at DESC,id DESC').all(root); }
  job(id) { return this.db.prepare('SELECT * FROM song_vision_jobs WHERE id=?').get(id); }
  items(id) { return this.db.prepare('SELECT * FROM song_vision_items WHERE job_id=? ORDER BY name_key,file_name').all(id); }
  item(id) { return this.db.prepare('SELECT * FROM song_vision_items WHERE id=?').get(id); }
  pending(id, nameKey) {
    return nameKey === undefined ? this.db.prepare("SELECT id,name_key,file_name,revision,state FROM song_vision_items WHERE job_id=? AND state='pending' ORDER BY name_key,file_name LIMIT 1").all(id)
      : this.db.prepare("SELECT id,name_key,file_name,revision,state FROM song_vision_items WHERE job_id=? AND name_key=? AND state='pending' ORDER BY file_name").all(id, nameKey);
  }
  hasRemaining(id) { return Boolean(this.db.prepare("SELECT 1 FROM song_vision_items WHERE job_id=? AND state IN ('pending','claimed') LIMIT 1").get(id)); }
  updateJob(id, status, reason = '', invalidate = false) {
    this.db.prepare('UPDATE song_vision_jobs SET status=?,reason=?,generation=generation+?,updated_at=? WHERE id=?').run(status, reason, invalidate ? 1 : 0, this.clock(), id);
  }
  updateItem(id, state, reason = '', result = null, cached = false) {
    this.db.prepare('UPDATE song_vision_items SET state=?,reason=?,result_json=?,cache_hit=? WHERE id=?')
      .run(state, reason, result ? JSON.stringify({ tod: result.tod || null, reason: result.reason || reason, frames: result.frames?.length || 0 }) : null, cached ? 1 : 0, id);
  }
  create(root, mode, items, inventory) {
    const terminal = this.db.prepare("SELECT id FROM song_vision_jobs WHERE status IN ('completed','stopped','undone') ORDER BY updated_at ASC").all();
    let count = this.db.prepare('SELECT COUNT(*) AS n FROM song_vision_jobs').get().n;
    while (count >= VISION_LIMITS.jobs && terminal.length) {
      const old = terminal.shift(); this.db.prepare('DELETE FROM song_vision_items WHERE job_id=?').run(old.id);
      this.db.prepare('DELETE FROM song_vision_jobs WHERE id=?').run(old.id); count--;
    }
    if (count >= VISION_LIMITS.jobs) throw Object.assign(new Error('任务上限已达，请先停止旧任务'), { status: 409 });
    const id = crypto.randomUUID(), now = this.clock();
    this.db.prepare('INSERT INTO song_vision_jobs VALUES(?,?,?,?,?,1,?,?,?)')
      .run(id, root, mode, items.some(item => item.state === 'pending') ? 'queued' : 'completed', '', now, now, JSON.stringify(inventory));
    const put = this.db.prepare('INSERT INTO song_vision_items(id,job_id,name_key,file_name,revision,state,reason,cache_hit) VALUES(?,?,?,?,?,?,?,?)');
    for (const item of items) put.run(crypto.randomUUID(), id, item.nameKey, item.fileName, item.revision || null, item.state, item.reason || '', item.cached ? 1 : 0);
    return this.job(id);
  }
  cacheKey(revision) { return VISION_ALGORITHM + ':' + VISION_POLICY + ':' + revision; }
  cache(revision) { const row = this.db.prepare('SELECT * FROM song_vision_cache WHERE key=?').get(this.cacheKey(revision)); return row ? { ...row, value: JSON.parse(row.value_json) } : null; }
  forget(root, nameKey, fileName) {
    this.db.prepare("DELETE FROM song_vision_cache WHERE root=? AND name_key=? AND file_name=? AND kind<>'known'").run(root, nameKey, fileName);
    if (this.db.prepare('SELECT COUNT(*) AS n FROM song_vision_cache').get().n < VISION_LIMITS.cache)
      this.db.prepare("DELETE FROM settings WHERE key='vision.autoCapacityBlocked'").run();
  }
  putCache(root, item, kind, value) {
    const key = this.cacheKey(item.revision);
    if (!this.db.prepare('SELECT key FROM song_vision_cache WHERE key=?').get(key)) {
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM song_vision_cache').get().n;
      if (count >= VISION_LIMITS.cache) {
        const disposable = this.db.prepare("SELECT key FROM song_vision_cache WHERE kind<>'suppressed' ORDER BY updated_at ASC LIMIT 1").get();
        if (!disposable) {
          if (kind === 'suppressed') this.db.prepare("INSERT INTO settings(key,value) VALUES('vision.autoCapacityBlocked','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
          return false;
        }
        this.db.prepare('DELETE FROM song_vision_cache WHERE key=?').run(disposable.key);
      }
    }
    this.db.prepare('INSERT OR REPLACE INTO song_vision_cache VALUES(?,?,?,?,?,?,?)')
      .run(key, root, item.name_key || item.nameKey, item.file_name || item.fileName, kind, JSON.stringify(value), this.clock());
    return true;
  }
  lease() { const row = this.db.prepare('SELECT value_json FROM song_vision_lease WHERE id=1').get(); return row ? JSON.parse(row.value_json) : null; }
  setLease(value) {
    if (!value) this.db.exec('DELETE FROM song_vision_lease');
    else this.db.prepare('INSERT OR REPLACE INTO song_vision_lease VALUES(1,?)').run(JSON.stringify(value));
  }
  summary(job, cursor = 0) {
    if (!job) return null;
    const counts = { totalVideos: 0, pending: 0, claimed: 0, saved: 0, review: 0, missing: 0, failed: 0, skipped: 0, stopped: 0, undone: 0, cached: 0 };
    for (const group of this.db.prepare('SELECT state,COUNT(*) AS n,SUM(cache_hit) AS cached FROM song_vision_items WHERE job_id=? GROUP BY state').all(job.id)) {
      counts.totalVideos += group.n; if (Object.hasOwn(counts, group.state)) counts[group.state] += group.n; counts.cached += group.cached || 0;
    }
    const start = Math.max(0, Math.min(10000, Number.isSafeInteger(cursor) ? cursor : 0));
    return { id: job.id, mediaRoot: job.root, mode: job.mode, status: job.status, reason: job.reason, generation: job.generation,
      inventory: JSON.parse(job.inventory_json), counts, createdAt: job.created_at, updatedAt: job.updated_at,
      items: this.db.prepare('SELECT id,name_key,file_name,state,reason,cache_hit,result_json FROM song_vision_items WHERE job_id=? ORDER BY name_key,file_name LIMIT 100 OFFSET ?').all(job.id, start).map(item => ({ id: item.id, nameKey: item.name_key, fileName: item.file_name,
        state: item.state, reason: item.reason, cached: Boolean(item.cache_hit), tod: item.result_json ? JSON.parse(item.result_json)?.tod || null : null })),
      nextCursor: Math.min(start + 100, counts.totalVideos), hasMore: start + 100 < counts.totalVideos };
  }
}
