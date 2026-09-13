import crypto from "node:crypto";
import { fingerprintCustomSongInputs } from "./custom-song-inputs.mjs";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_SONGS = 1000;
const CHECK_INTERVAL = 30_000;
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Revisions describe visible content, not transient verification state. Merely
// checking the same files must not reset the native pager or its selection.
export function songCatalogRevision(result) {
  return digest(result.list.map((song) => ({ id: song.id, name: song.name, duration: song.duration,
    files: song.localFiles.map((file) => [file.fileName, file.tod, file.view, file.url]),
    fallbackPeriods: song.fallbackPeriods })));
}

export class CustomSongRefresh {
  constructor(catalog, { fingerprint = fingerprintCustomSongInputs } = {}) {
    this.catalog = catalog;
    this.fingerprint = fingerprint;
    this.root = null;
    this.epoch = 0;
    this.states = new Map();
    this.memo = null;
    this.job = null;
    this.timer = null;
    this.nextRoot = null;
    this.closed = false;
    catalog.db.exec(`CREATE TABLE IF NOT EXISTS custom_song_catalog_cache (
      root TEXT PRIMARY KEY, mapping_hash TEXT NOT NULL, input_signature TEXT,
      revision TEXT NOT NULL, base_url TEXT NOT NULL, snapshot_json TEXT, updated_at INTEGER NOT NULL
    )`);
  }

  mapping() {
    const entries = this.catalog.mappings.read();
    return { entries, hash: this.mappingHash(entries) };
  }

  mappingHash(entries) { return digest(entries); }

  selectRoot(root) {
    if (this.root !== root) {
      const manager=this.catalog.debugPackages,preserving=manager?.hasPriority()&&manager.job?.root===root;
      if(manager?.hasPriority()&&!preserving)manager.clear('root-changed');
      this.root = root; this.epoch += 1; this.memo = null;
      // Song/media identity is globally keyed by nameKey in the native bridge.
      // A snapshot from another selected root must never retain old media URLs.
      if(!preserving)this.catalog.db.prepare("DELETE FROM custom_song_catalog_cache WHERE root<>?").run(root);
    }
    if (!this.states.has(root)) {
      if (this.states.size >= 16) this.states.clear();
      this.states.set(root, { revision: "", refreshing: false, error: "", checkedAt: null, retries: 0 });
    }
    return this.states.get(root);
  }

  stored(root) {
    return this.catalog.db.prepare("SELECT * FROM custom_song_catalog_cache WHERE root=?").get(root);
  }

  invalidate() {
    this.epoch += 1;
    this.memo = null;
    this.catalog.db.prepare("UPDATE custom_song_catalog_cache SET mapping_hash='',input_signature=NULL").run();
    for (const state of this.states.values()) state.checkedAt = null;
    if (this.job) this.nextRoot = this.root;
  }

  quick(root, paging) {
    const state = this.selectRoot(root), mapping = this.mapping();
    let result;
    if (this.memo?.root === root && this.memo.mappingHash === mapping.hash) result = this.memo.result;
    else {
      const saved = this.stored(root);
      if (saved?.mapping_hash === mapping.hash && saved.base_url === this.catalog.baseUrl && saved.snapshot_json) {
        try { result = JSON.parse(saved.snapshot_json); } catch { /* derived cache can be reconstructed */ }
      }
      if (!result) result = this.catalog.savedPresentation(root, mapping.entries, saved?.snapshot_json,{readOnly:this.catalog.debugPackages?.hasPriority()===true});
      if (result.list.length <= MAX_SONGS && Buffer.byteLength(JSON.stringify(result)) <= MAX_BYTES) {
        this.memo = { root, mappingHash: mapping.hash, result };
      }
    }
    state.revision = songCatalogRevision(result);
    this.schedule(root);
    return { ...this.catalog.pagePresentation(result, paging), refresh: this.status(root),
      verificationPending: state.refreshing || Boolean(state.error) };
  }

  status(root) {
    const state = this.states.get(root);
    return { mediaRoot: root, revision: state?.revision || this.stored(root)?.revision || "",
      refreshing: Boolean(state?.refreshing), error: state?.error || "",
      ...(state?.warning ? { warning: state.warning } : {}) };
  }

  inputs(root) { return this.fingerprint({ mediaRoot: root, logRoot: this.catalog.logRoot }); }

  schedule(root, retry = false) {
    if (this.closed || root !== this.root) return;
    const known=this.states.get(root);
    if (known?.refreshing || (known?.checkedAt != null && this.catalog.clock() - known.checkedAt < CHECK_INTERVAL)) return;
    if(this.catalog.debugPackages?.hasPriority()){
      this.diagnosticDeferredRoot=root;this.diagnosticDeferredRetry=Boolean(this.diagnosticDeferredRetry||retry);return;
    }
    const state = this.selectRoot(root);
    if(this.diagnosticDeferredRoot===root){this.diagnosticDeferredRoot=null;this.diagnosticDeferredRetry=false;}
    if (!retry) state.retries = 0;
    state.refreshing = true;
    state.error = "";
    state.warning = "";
    if (this.job) { this.nextRoot = root; return; }
    let done;
    this.job = new Promise((resolve) => { done = resolve; });
    const diagnosticRefresh=this.job;
    // Yield past the HTTP response: no directory or log work is on the first
    // response's critical path, even when the previous scan found missing data.
    this.timer = setTimeout(async () => {
      this.timer = null;
      const epoch = this.epoch;
      try {
        if (this.closed || root !== this.root) return;
        if (this.catalog.inFlight) {
          await this.catalog.inFlight.promise;
          return;
        }
        const mapping = this.mapping(), inputs = await this.inputs(root);
        if (this.closed || root !== this.root || epoch !== this.epoch) return;
        const saved = this.stored(root);
        if (inputs.cacheable && saved?.mapping_hash === mapping.hash && saved.input_signature === inputs.signature) {
          this.catalog.scannedRoot = root;
          return;
        }
        await this.catalog.rebuild({ mediaRoot: root }, { inputs,diagnosticRefresh });
      } catch (error) {
        if (!this.closed && root === this.root && epoch === this.epoch) {
          if (error.code === "MAPPING_CHANGED") this.retryChangedInputs(root);
          else state.error = error.message || "后台曲目校验未完成";
        }
      } finally {
        state.refreshing = false;
        state.checkedAt = epoch === this.epoch ? this.catalog.clock() : null;
        this.job = null;
        done();
        const next = this.nextRoot;
        this.nextRoot = null;
        if (next && !this.closed) {
          const nextState = this.states.get(next);
          if (nextState) { nextState.refreshing = false; nextState.checkedAt = null; }
          this.schedule(next, true);
        }
      }
    }, 0);
    this.timer.unref?.();
  }

  retryChangedInputs(root) {
    const state = this.states.get(root);
    if (!state || root !== this.root || this.closed) return;
    if (state.retries < 1) {
      state.retries++; this.nextRoot = root;
      if (!this.job) { this.nextRoot = null; state.checkedAt = null; this.schedule(root, true); }
    }
    else state.error = "文件或映射仍在变化，已保留当前曲目；可在管理中重新扫描";
  }

  releaseDiagnosticPriority(reason){
    if(['root-changed','root-or-selection-changed','closed'].includes(reason)){
      this.diagnosticDeferredRoot=null;this.diagnosticDeferredRetry=false;return;
    }
    if(this.catalog.debugPackages?.hasPriority()||!this.diagnosticDeferredRoot)return;
    if(this.catalog.mappingMutation||this.catalog.visionTasks?.userMutation||this.catalog.activeDiagnosticLease?.())return;
    const root=this.diagnosticDeferredRoot,retry=this.diagnosticDeferredRetry;
    this.diagnosticDeferredRoot=null;this.diagnosticDeferredRetry=false;
    if(!this.closed&&root===this.root)this.schedule(root,retry);
  }

  save(root, result, before, after) {
    if (this.closed) return;
    const mapping = this.mapping();
    if (result.mappingHash && result.mappingHash !== mapping.hash) { this.retryChangedInputs(root); return; }
    const { mappingHash, ...presentation } = result;
    const revision = songCatalogRevision(presentation);
    const serialized = JSON.stringify(presentation);
    const snapshot = result.list.length <= MAX_SONGS && Buffer.byteLength(serialized) <= MAX_BYTES ? serialized : null;
    const signature = before?.cacheable && after?.cacheable && before.signature === after.signature ? after.signature : null;
    this.catalog.db.prepare(`INSERT INTO custom_song_catalog_cache
      (root,mapping_hash,input_signature,revision,base_url,snapshot_json,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(root) DO UPDATE SET mapping_hash=excluded.mapping_hash,input_signature=excluded.input_signature,
      revision=excluded.revision,base_url=excluded.base_url,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at`)
      .run(root, mapping.hash, signature, revision, this.catalog.baseUrl, snapshot, this.catalog.clock());
    if (root === this.root) {
      const state = this.selectRoot(root);
      state.revision = revision;
      state.error = "";
      state.warning = "";
      this.memo = snapshot ? { root, mappingHash: mapping.hash, result: presentation } : null;
      if (before?.cacheable && after?.cacheable && before.signature !== after.signature) {
        if (before.mediaCacheable === true && after.mediaCacheable === true &&
            typeof before.mediaSignature === 'string' && before.mediaSignature === after.mediaSignature) {
          // Keep the combined cache signature invalid: newer log evidence is checked on the
          // next ordinary refresh. Log churn alone must not block a verified media inventory.
          state.warning = "日志仍在写入，本次曲库结果可用；新的日志信息将在后续检查中读取。";
        } else this.retryChangedInputs(root);
      }
    }
  }

  async wait() {
    // Tests and orderly shutdown can await background work without delaying API reads.
    while (this.job) { this.timer?.ref?.(); await this.job; }
  }

  async close() {
    this.closed = true;
    this.nextRoot = null;
    if (this.timer) {
      // Let the scheduled callback settle the public job promise; it observes closed.
      this.timer.ref?.();
    }
    await this.wait();
  }
}
