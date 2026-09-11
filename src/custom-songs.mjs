import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanCustomSongs } from "./custom-song-scan.mjs";
import { inspectVideo } from "./custom-song-media-facts.mjs";
import { ScanDiagnostics } from "./custom-song-diagnostics.mjs";
import { SongDebugPackageManager } from "./custom-song-debug-package.mjs";
import { VisionTaskService } from "./custom-song-vision-jobs.mjs";
import { captureDebugContext, safeFrontendEvidence } from "./custom-song-debug-context.mjs";
import { detailedServiceEvidence } from "./custom-song-debug-evidence.mjs";
import {snapshotSongDatabase,mappingNameSource,validateExtraSourcePaths} from "./custom-song-name-sources.mjs";
import {baseSongName,savedSongName,normalizeSongRename,planSongRename} from "./custom-song-name-policy.mjs";
import { diagnosticError } from "./diagnostic-errors.mjs";
import { revisionForResolvedFile, isVisionFile, validVisionFile } from "./custom-song-vision-evidence.mjs";
import { SERVICE_VERSION } from "./constants.mjs";
import { CustomSongMappings, mappingKey } from "./custom-song-mappings.mjs";
import { CustomSongRefresh } from "./custom-song-refresh.mjs";

const NAME_KEY = /^midi_[0-9]+_[0-9]+$/;
const PERIODS = ["TOD12", "TOD1730", "TOD20"];
const FILE_REVISION = /^v1:[0-9a-f]{64}$/;
const PRESENTATION_CACHE_TTL_MS = 30 * 1000;
const PRESENTATION_CACHE_MAX_SONGS = 1000;
const PRESENTATION_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
};

// Seek between MP4 boxes; never read a multi-gigabyte video into memory.
async function mp4Duration(filePath) {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const size = (await handle.stat()).size;
    const header = Buffer.alloc(16);
    let offset = 0;
    for (let count = 0; offset + 8 <= size && count < 4096; count += 1) {
      if ((await handle.read(header, 0, 16, offset)).bytesRead < 8) return 0;
      let bytes = header.readUInt32BE(0);
      let prefix = 8;
      if (bytes === 1) { bytes = Number(header.readBigUInt64BE(8)); prefix = 16; }
      if (bytes === 0) bytes = size - offset;
      if (!Number.isSafeInteger(bytes) || bytes < prefix || offset + bytes > size) return 0;
      if (header.toString("ascii", 4, 8) === "moov") {
        if (bytes > 16 * 1024 * 1024) return 0;
        const moov = Buffer.alloc(bytes - prefix);
        await handle.read(moov, 0, moov.length, offset + prefix);
        for (let p = 0; p + 8 <= moov.length;) {
          const childSize = moov.readUInt32BE(p);
          if (childSize < 8 || p + childSize > moov.length) break;
          if (moov.toString("ascii", p + 4, p + 8) === "mvhd") {
            const version = moov[p + 8];
            if (version > 1 || childSize < (version === 1 ? 40 : 28)) return 0;
            const scale = moov.readUInt32BE(p + (version === 1 ? 28 : 20));
            const ticks = version === 1 ? Number(moov.readBigUInt64BE(p + 32)) : moov.readUInt32BE(p + 24);
            return scale > 0 && ticks / scale < 86400 ? ticks / scale : 0;
          }
          p += childSize;
        }
        return 0;
      }
      offset += bytes;
    }
    return 0;
  } finally { await handle.close(); }
}

export class CustomSongCatalog {
  constructor({ db, baseUrl, mediaRoot, logRoot, mappingPath, scan = scanCustomSongs, clock = () => Date.now(), refreshOptions }) {
    this.db = db;
    this.diagnosticStartedAt = Date.now();
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.defaultRoot = mediaRoot || path.join(os.homedir(), "Music", "miHoYo", "Olivia-steam", "cache", "studiovideo");
    this.logRoot = logRoot ?? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "miHoYo", "Olivia-steam", "logs");
    this.scan = scan;
    this.mappings = mappingPath ? new CustomSongMappings(mappingPath) : null;
    this.mappingMutation = false;
    this.logRootSource = logRoot == null ? "default" : "environment";
    this.lastDiagnostics = null;
    this.debugPackages = new SongDebugPackageManager();
    this.inFlight = null;
    this.scannedRoot = null;
    this.lastWarnings = [];
    this.durationCache = new Map();
    this.clock = clock;
    this.presentationGeneration = 0;
    this.presentationSnapshot = null;
    this.presentationFill = null;
    db.exec(`CREATE TABLE IF NOT EXISTS custom_songs (
      name_key TEXT PRIMARY KEY, song_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      custom_name TEXT, root TEXT NOT NULL, files_json TEXT NOT NULL, overrides_json TEXT NOT NULL DEFAULT '{}',
      metadata_source TEXT NOT NULL, media_token TEXT NOT NULL UNIQUE,
      available INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL
    )`);
    this.refresh = this.mappings ? new CustomSongRefresh(this, refreshOptions) : null;
    this.visionTasks = new VisionTaskService(this, { clock });
  }

  root(input, detectedRoot) {
    const stored = this.db.prepare("SELECT value FROM settings WHERE key = 'customSongs.mediaRoot'").get()?.value;
    const root = input || stored || detectedRoot || this.defaultRoot;
    if (typeof root !== "string" || root.length > 4096 || !path.isAbsolute(root) || root.includes("\0")) {
      throw fail("请选择有效的曲目下载文件夹绝对路径");
    }
    return path.resolve(root);
  }

  invalidatePresentationCache() {
    this.presentationGeneration += 1;
    this.presentationSnapshot = null;
  }

  paging({ cursor = 0, pageSize = 100 } = {}) {
    cursor = Number(cursor); pageSize = Number(pageSize);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) {
      throw fail("曲目分页参数无效");
    }
    return { cursor, pageSize };
  }

  pagePresentation(result, { cursor, pageSize }) {
    const songs = structuredClone(result.list);
    return { list: songs.slice(cursor, cursor + pageSize), total: result.total,
      nextCursor: Math.min(cursor + pageSize, result.total), hasMore: cursor + pageSize < result.total,
      mediaRoot: result.mediaRoot, warnings: structuredClone(result.warnings), missingPeriods: result.missingPeriods };
  }

  async assemblePresentation(root, warnings = this.lastWarnings) {
    const rows = this.db.prepare("SELECT * FROM custom_songs WHERE available=1 AND root=? ORDER BY name_key").all(root);
    const songs = [];
    for (const row of rows) {
      const song = await this.present(row);
      if (song) songs.push(song);
    }
    const result = { list: songs, total: songs.length, mediaRoot: root,
      warnings: structuredClone(warnings), missingPeriods: songs.filter((song) => song.fallbackPeriods.length).length };
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    return { result, cacheable: songs.length <= PRESENTATION_CACHE_MAX_SONGS && bytes <= PRESENTATION_CACHE_MAX_BYTES };
  }

  async cachedList(root, paging) {
    const now = this.clock();
    const snapshot = this.presentationSnapshot;
    if (snapshot && snapshot.root === root && snapshot.generation === this.presentationGeneration
      && now < snapshot.expiresAt) {
      return this.pagePresentation(snapshot.result, paging);
    }
    if (snapshot) this.presentationSnapshot = null;

    const generation = this.presentationGeneration;
    let fill = this.presentationFill;
    if (!fill || fill.root !== root || fill.generation !== generation) {
      const promise = (async () => {
        const assembled = await this.assemblePresentation(root);
        if (assembled.cacheable && this.presentationGeneration === generation && this.scannedRoot === root) {
          this.presentationSnapshot = { root, generation, expiresAt: this.clock() + PRESENTATION_CACHE_TTL_MS,
            result: structuredClone(assembled.result) };
        }
        return assembled.result;
      })();
      fill = { root, generation, promise };
      this.presentationFill = fill;
      promise.finally(() => {
        if (this.presentationFill?.promise === promise) this.presentationFill = null;
      }).catch(() => {});
    }
    return this.pagePresentation(await fill.promise, paging);
  }

  savedPresentation(root, entries, priorJson) {
    let prior = { list: [], warnings: [] };
    try { if (priorJson) prior = JSON.parse(priorJson); } catch { /* optional derived cache */ }
    const previous = new Map(prior.list.map((song) => [song.nameKey, song]));
    const table = new Map(entries.map((entry) => [mappingKey(entry.fileName), entry]));
    const groups = new Map();
    for (const entry of table.values()) {
      const key = entry.filePath.split("/")[0];
      if (!NAME_KEY.test(key) || !this.validFileName(entry.fileName)) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    const allRows = this.db.prepare("SELECT * FROM custom_songs WHERE root=? ORDER BY name_key").all(root);
    const rows = new Map(allRows.filter((row) => row.available).map((row) => [row.name_key, row]));
    const known = new Set(allRows.map((row) => row.name_key));
    // An imported table can populate the first list even before any scan has
    // run. Register only safe relative media names; media() still resolves the
    // real path and checks availability before serving a single byte.
    if (!this.inFlight) {
      const insert = this.db.prepare(`INSERT INTO custom_songs
        (name_key,song_id,name,root,files_json,metadata_source,media_token,available,updated_at)
        VALUES(?,?,?,?,?,'mapping',?,1,?) ON CONFLICT(name_key) DO UPDATE SET
        name=excluded.name,custom_name=NULL,root=excluded.root,files_json=excluded.files_json,
        overrides_json='{}',metadata_source='mapping',available=1,updated_at=excluded.updated_at`);
      let transaction = false;
      try { for (const [key, mapped] of groups) {
        if (known.has(key)) continue;
        if (!transaction) { this.db.exec("BEGIN IMMEDIATE"); transaction = true; }
        const existing = this.db.prepare("SELECT * FROM custom_songs WHERE name_key=?").get(key);
        const files = mapped.map((entry) => ({ ...(entry.automatic || {}), fileName: entry.fileName,
          ...(entry.automatic ? {} : { tod: entry.tod, view: entry.view, evidence: entry.tod ? "mapping" : "unknown" }) }));
        insert.run(key, existing?.song_id || `local-${key}`, mapped.find((entry) => entry.name)?.name || key,
          root, JSON.stringify(files), existing?.media_token || crypto.randomBytes(24).toString("hex"), Date.now());
        rows.set(key, this.db.prepare("SELECT * FROM custom_songs WHERE name_key=?").get(key));
      } if (transaction) this.db.exec("COMMIT"); }
      catch (error) { if (transaction) this.db.exec("ROLLBACK"); throw error; }
    }
    const songs = [];
    for (const row of [...rows.values()].sort((a, b) => a.name_key < b.name_key ? -1 : a.name_key > b.name_key ? 1 : 0)) {
      const raw = [...new Map(JSON.parse(row.files_json).map((file) => [mappingKey(file.fileName), file])).values()];
      const overrides = JSON.parse(row.overrides_json);
      const old = previous.get(row.name_key);
      let name = savedSongName(row, raw, entries);
      const files = raw.map((file) => {
        const candidate = table.get(mappingKey(file.fileName));
        const mapped = candidate && (!candidate.filePath || candidate.filePath.toLowerCase() === `${row.name_key}/${file.fileName}`.toLowerCase()) ? candidate : null;
        if (mapped?.name) name = mapped.name;
        const manual = mapped ? mapped.manualUnknown || (mapped.tod && Object.hasOwn(overrides, file.fileName)
          && overrides[file.fileName] === mapped.tod) : Object.hasOwn(overrides, file.fileName);
        let tod = mapped ? mapped.tod || (mapped.manualUnknown ? null : file.tod) : manual ? overrides[file.fileName]
          : file.mappingManual ? file.mappingTod : file.tod;
        let evidence = manual ? "manual" : mapped?.tod && mapped.tod !== file.tod ? "mapping" : file.evidence || "unknown";
        if (isVisionFile(file) && !manual) { tod = null; evidence = 'vision-pending'; }
        return { fileName: file.fileName, tod: PERIODS.includes(tod) ? tod : null,
          view: mapped ? ((mapped.tod || mapped.manualUnknown ? mapped.view : null) ?? file.view ?? null)
            : file.mappingView ?? file.view ?? null, evidence,
          automaticTod: isVisionFile(file) ? null : PERIODS.includes(file.tod) ? file.tod : null,
          automaticEvidence: file.evidence || "unknown", conflict: Boolean(file.conflict),
          evidenceNote: isVisionFile(file) ? "画面推测：正在核对文件版本，暂不作为有效时段。" : "已载入保存的映射，文件可用性正在后台核对。", provenance: file.provenance || [],
          ...(old?.localFiles?.find((value) => value.fileName === file.fileName)?.fileRevision
            ? { fileRevision: old.localFiles.find((value) => value.fileName === file.fileName).fileRevision } : {}),
          url: `${this.baseUrl}/custom-song-media/${row.media_token}/${encodeURIComponent(file.fileName)}` };
      }).filter((file) => this.validFileName(file.fileName));
      const duration = old?.duration || raw.find((file) => file.mediaFacts?.duration > 0)?.mediaFacts.duration || 0;
      const song = this.songPresentation({ ...row, name, custom_name: null }, files, duration);
      if (song) songs.push({ ...song, localVerificationPending: true });
    }
    return { list: songs, total: songs.length, mediaRoot: root, warnings: prior.warnings || [],
      missingPeriods: songs.filter((song) => song.fallbackPeriods.length).length };
  }

  async rebuild({ mediaRoot } = {}, internal = {}) {
    if (this.mappingMutation) throw fail("正在保存歌曲映射，请稍后再试", 409);
    const root = this.root(mediaRoot);
    this.refresh?.selectRoot(root);
    if (this.inFlight) {
      if (this.inFlight.root !== root) {
        this.invalidatePresentationCache();
        throw fail("正在扫描另一个曲目目录，请稍后再试", 409);
      }
      return this.rebuildPage(await this.inFlight.promise);
    }
    this.invalidatePresentationCache();
    const promise = this.rebuildRoot(root, internal.inputs);
    this.inFlight = { root, promise };
    try { return this.rebuildPage(await promise); } finally {
      this.invalidatePresentationCache();
      this.inFlight = null;
    }
  }

  rebuildPage(result) {
    return { ...this.pagePresentation(result, { cursor: 0, pageSize: 200 }), diagnostics: result.diagnostics };
  }

  async rebuildRoot(root, inputSnapshot) {
    const diagnostics = new ScanDiagnostics({ mediaRoot: root, logRoot: this.logRoot,
      logRootSource: this.logRootSource, patchVersion: SERVICE_VERSION });
    this.lastDiagnostics = null;
    try {
      const epoch = this.refresh?.epoch;
      const before = this.refresh ? inputSnapshot || await this.refresh.inputs(root) : null;
      const result = await this.rebuildWithDiagnostics(root, diagnostics, epoch);
      if (this.refresh && !this.refresh.closed && this.refresh.root === root && this.refresh.epoch === epoch) {
        const after = await this.refresh.inputs(root);
        if (!this.refresh.closed && this.refresh.root === root && this.refresh.epoch === epoch) this.refresh.save(root, result, before, after);
      }
      diagnostics.finish();
      this.lastDiagnostics = diagnostics.snapshot();
      return { ...result, diagnostics: this.lastDiagnostics };
    } catch (error) {
      diagnostics.finish(error.code || "SCAN_FAILED");
      this.lastDiagnostics = diagnostics.snapshot();
      error.scanDiagnostics = this.lastDiagnostics;
      throw error;
    }
  }

  getDiagnostics({ mediaRoot, scanId } = {}, exportOnly = false) {
    if (this.inFlight) throw fail("扫描尚未结束，请稍后查看诊断", 409);
    const snapshot = this.lastDiagnostics;
    if (!snapshot || snapshot.local.mediaRoot !== this.root(mediaRoot)) {
      throw fail("此目录尚无扫描报告，请先重新扫描", 404);
    }
    if ((exportOnly && !scanId) || (scanId && scanId !== snapshot.scanId)) {
      throw fail("扫描报告已更新，请刷新诊断后再导出", 409);
    }
    return structuredClone(exportOnly ? snapshot.report : snapshot);
  }

  debugPackage(action, input = {}) {
    const mediaRoot = this.root(input.mediaRoot);
    if (action === 'start') {
      const extraPaths=validateExtraSourcePaths(input.extraPaths||[]);
      let frozenNameSources=[];
      try{frozenNameSources=snapshotSongDatabase(this.db);}
      catch{frozenNameSources=[{id:'current-db',kind:'current-db',complete:false,gaps:[{reason:'database-snapshot-failed'}],records:[]}];}
      // Deliberately bypass rebuild/search: no SQLite, mapping persistence, or playback mutations.
      const failures=[];let mappingEntries=[];
      try{mappingEntries=structuredClone(this.mappings?.read()||[]);}catch(error){failures.push(diagnosticError(error,'mapping-read'));}
      let context;
      try { context = captureDebugContext(this, { mediaRoot, requestedRoot: input.mediaRoot, officialRoot: input.officialRoot, frontend: input.frontend }, mappingEntries); }
      catch(error) { failures.push(diagnosticError(error,'context-read'));context = { schemaVersion: 1, basis: 'before-debug-capture-read-only', available: false, reason: 'context-snapshot-unavailable',frontend:safeFrontendEvidence(input.frontend),service:{version:SERVICE_VERSION} }; }
      const detailContext=detailedServiceEvidence(this,{...input,mediaRoot},mappingEntries,failures);
      frozenNameSources.push(mappingNameSource(mappingEntries));
      const original=detailContext.components['mapping-source'];
      if(original?.records){
        const source=mappingNameSource(original.records.map(r=>r.value),{id:'current-mapping-original',kind:'mapping-original'});
        if(original.omitted||original.records.some(r=>r.gaps?.length)){source.complete=false;source.gaps.push({reason:'mapping-original-evidence-omitted'});}
        frozenNameSources.push(source);
      }else if(this.mappings){
        const absent=original?.error?.code==='ENOENT';
        frozenNameSources.push({id:'current-mapping-original',kind:'mapping-original',state:absent?'confirmed-absent':'unavailable',complete:absent,gaps:absent?[]:[{reason:'mapping-original-unavailable'}],records:[]});
      }
      return this.debugPackages.start({ mediaRoot, logRoot: this.logRoot, logRootSource: this.logRootSource, mappingEntries, context,detailContext,failures,frozenNameSources,extraPaths,
        backupRoot:this.mappings?path.join(path.dirname(path.dirname(this.mappings.filePath)),'backups'):null,
        minimalOnly:Boolean(this.inFlight||this.mappingMutation||this.visionTasks.userMutation) });
    }
    if (!['status', 'download', 'cancel'].includes(action)) throw fail('未知排障操作', 404);
    return this.debugPackages[action]({ ...input, mediaRoot });
  }

  async rebuildWithDiagnostics(root, diagnostics, epoch) {
    try {
      if (!(await fs.promises.stat(root)).isDirectory()) throw fail("曲目下载路径不是文件夹");
    } catch (error) {
      if (error.status) throw error;
      throw Object.assign(fail("无法读取曲目下载文件夹，请检查游戏设置中的下载路径", 404), { code: error.code });
    }
    const previousSongs = this.db.prepare("SELECT name_key,files_json FROM custom_songs WHERE root=?").all(root)
      .map((row) => ({ nameKey: row.name_key, files: JSON.parse(row.files_json) }));
    const previousRows = this.mappings ? this.db.prepare("SELECT * FROM custom_songs").all() : null;
    const previousRoot = this.db.prepare("SELECT value FROM settings WHERE key='customSongs.mediaRoot'").get();
    if (this.mappings && !fs.existsSync(this.mappings.filePath)) {
      const saved = this.savedPresentation(root, []);
      await this.persistMappings(root, new Map(saved.list.map((song) => [song.nameKey, song])),
        { epoch, mappingHash: this.refresh?.mappingHash([]) });
    }
    const mappingState = this.refresh?.mapping();
    const mappingEntries = mappingState?.entries || this.mappings?.read();
    const tableByFile = new Map((mappingEntries || []).map((entry) => [mappingKey(entry.fileName), entry]));
    const result = await this.scan({ mediaRoot: root, logRoot: this.logRoot, previousSongs, diagnostics, mappingEntries });
    if (!Array.isArray(result.songs)) throw fail("曲目扫描返回无效数据", 500);
    this.assertCurrentScan(root, epoch, mappingState?.hash);
    const now = Date.now();
    const counts = { indexedSongs: 0, unindexedSongs: 0, recoveredNames: 0,
      retainedNames: 0, manualNames: 0, directoryNames: 0, unusableNames: 0 };
    const displayOutcomes = [];
    const get = this.db.prepare("SELECT * FROM custom_songs WHERE name_key = ?");
    const put = this.db.prepare(`INSERT INTO custom_songs
      (name_key,song_id,name,root,files_json,metadata_source,media_token,available,updated_at)
      VALUES(?,?,?,?,?,?,?,1,?) ON CONFLICT(name_key) DO UPDATE SET
      name=excluded.name, root=excluded.root, files_json=excluded.files_json,
      metadata_source=excluded.metadata_source, available=1, updated_at=excluded.updated_at`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // An incomplete scan must not erase previously recovered records.
      if (!(result.warnings || []).length) this.db.prepare("UPDATE custom_songs SET available=0").run();
      for (const song of result.songs) {
        if (!NAME_KEY.test(song.nameKey)) continue;
        const files = song.files.filter((file) => this.validFileName(file.fileName));
        if (!files.length) {
          displayOutcomes.push([song.nameKey, "unindexed", false]);
          continue;
        }
        const old = get.get(song.nameKey);
        if (old && this.mappings) {
          const overrides = JSON.parse(old.overrides_json);
          for (const file of files) {
            const entry = tableByFile.get(mappingKey(file.fileName));
            if (!entry || (entry.filePath && entry.filePath.toLowerCase() !== `${song.nameKey}/${file.fileName}`.toLowerCase())) continue;
            // The JSON is authoritative, including edits made while stopped.
            // Never let an old SQLite override rewrite newer table values.
            if (entry.manualUnknown) overrides[file.fileName] = null;
            else if (!entry.tod) delete overrides[file.fileName];
            else if (Object.hasOwn(overrides, file.fileName)) overrides[file.fileName] = entry.tod;
          }
          this.db.prepare("UPDATE custom_songs SET overrides_json=? WHERE name_key=?").run(JSON.stringify(overrides), song.nameKey);
        }
        if (song.mappingName && old) {
          this.db.prepare("UPDATE custom_songs SET custom_name=? WHERE name_key=?").run(song.mappingName, song.nameKey);
          old.custom_name = song.mappingName;
        }
        counts.indexedSongs += 1;
        // Explain the existing naming precedence without changing it. Manual,
        // retained and this-scan names are mutually exclusive, across all pages.
        const keepsOld = song.metadataSource === "directory" && old?.metadata_source === "log";
        const displayedName = old?.custom_name || (keepsOld ? old.name : song.name);
        if (old?.custom_name) counts.manualNames += 1;
        else if (displayedName === song.nameKey) counts.directoryNames += 1;
        else if (typeof displayedName !== "string" || !displayedName.trim()) counts.unusableNames += 1;
        else if (keepsOld) counts.retainedNames += 1;
        else if (song.metadataSource === "log") counts.recoveredNames += 1;
        else counts.retainedNames += 1;
        const displaySource = old?.custom_name ? "manual" : displayedName === song.nameKey ? "directory"
          : typeof displayedName !== "string" || !displayedName.trim() ? "unusable"
          : keepsOld || song.metadataSource !== "log" ? "retained" : "recovered";
        displayOutcomes.push([song.nameKey, displaySource,
          typeof displayedName === "string" && Boolean(displayedName.trim()) && displayedName !== song.nameKey]);
        const oldFiles = old ? JSON.parse(old.files_json) : [];
        // Old unqualified 'log' labels may be polluted. Preserve them as legacy
        // hints, never as new original evidence or input to exclusion inference.
        for (const file of files) {
          const previous = oldFiles.find((entry) => entry.fileName === file.fileName);
          if (!file.tod && previous?.tod && previous.evidence !== "inferred" && !isVisionFile(previous)) {
            file.legacyMapping = { tod: previous.tod, view: previous.view ?? null };
          }
          if (!file.conflict && !file.tod && previous?.tod && previous.evidence !== "inferred" && !isVisionFile(previous)
            && (song.metadataSource === "directory" || song.evidenceVersion === 1)) {
            file.tod = previous.tod;
            file.view = previous.view ?? null;
            file.evidence = "legacy";
          }
          if (file.evidence === "log") file.evidence = "legacy";
          if (file.evidence === "original" && !file.provenance?.some((source) => source.kind === "official-log")) file.evidence = "legacy";
        }
        put.run(song.nameKey, old?.song_id || String(song.id),
          song.metadataSource === "directory" && old?.metadata_source === "log" ? old.name : song.name,
          root, JSON.stringify(files), old?.metadata_source === "log" ? "log" : song.metadataSource,
          old?.media_token || crypto.randomBytes(24).toString("hex"), now);
      }
      this.db.prepare("INSERT INTO settings(key,value) VALUES('customSongs.mediaRoot',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(root);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    counts.unindexedSongs = result.songs.length - counts.indexedSongs;
    diagnostics.outcomes(counts);
    for (const outcome of displayOutcomes) diagnostics.noteDisplayOutcome(...outcome);
    if (counts.directoryNames) diagnostics.reason("NAME_FALLBACK", counts.directoryNames);
    if (counts.unusableNames) diagnostics.reason("UNUSABLE_NAMES", counts.unusableNames);
    let assembled, writtenMappingHash;
    try {
      assembled = await this.assemblePresentation(root, result.warnings || []);
      this.assertCurrentScan(root, epoch, mappingState?.hash);
      writtenMappingHash = await this.persistMappings(root, new Map(assembled.result.list.map((song) => [song.nameKey, song])), { epoch, mappingHash: mappingState?.hash });
    }
    catch (error) {
      // Do not hold SQLite's shared connection in a transaction while awaiting
      // media checks. Restore this catalog only if its file persistence fails.
      this.scannedRoot = null;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("DELETE FROM custom_songs").run();
        const restore = this.db.prepare(`INSERT INTO custom_songs
          (name_key,song_id,name,custom_name,root,files_json,overrides_json,metadata_source,media_token,available,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
        for (const row of previousRows || []) restore.run(row.name_key,row.song_id,row.name,row.custom_name,row.root,
          row.files_json,row.overrides_json,row.metadata_source,row.media_token,row.available,row.updated_at);
        if (previousRoot) this.db.prepare("UPDATE settings SET value=? WHERE key='customSongs.mediaRoot'").run(previousRoot.value);
        else this.db.prepare("DELETE FROM settings WHERE key='customSongs.mediaRoot'").run();
        this.db.exec("COMMIT");
      } catch (restoreError) { this.db.exec("ROLLBACK"); throw restoreError; }
      throw error;
    }
    if (!this.refresh || (this.refresh.root === root && this.refresh.epoch === epoch)) this.scannedRoot = root;
    this.lastWarnings = result.warnings || [];
    return { ...assembled.result, mappingHash: writtenMappingHash };
  }

  assertCurrentScan(root, epoch, mappingHash) {
    if (!this.refresh) return;
    if (this.refresh.closed || this.refresh.root !== root || this.refresh.epoch !== epoch) throw fail("曲目目录已变化，已忽略旧检查结果", 409);
    if (mappingHash && this.refresh.mapping().hash !== mappingHash) throw Object.assign(fail("歌曲映射已变化，正在重新检查", 409), { code: "MAPPING_CHANGED" });
  }

  async mappingEntriesForRow(row, presentation) {
    const song = arguments.length > 1 ? presentation : await this.present(row);
    if (!song) return [];
    const rawFiles = JSON.parse(row.files_json);
    return song.localFiles.map((file) => ({ fileName: file.fileName,
      filePath: `${row.name_key}/${file.fileName}`, name: song.name === row.name_key ? "" : song.name,
      tod: file.tod, view: file.view,
      ...(file.evidence === "manual" && !file.tod ? { manualUnknown: true } : {}),
      automatic: (({ mappingTod, mappingManual, mappingView, manualUnknown, ...automatic }) => automatic)(rawFiles.find((raw) => raw.fileName === file.fileName)) }));
  }

  async persistMappings(root, presentations, guard) {
    if (!this.mappings) return;
    const entries = new Map(this.mappings.read().map((entry) => [mappingKey(entry.fileName), entry]));
    for (const row of this.db.prepare("SELECT * FROM custom_songs WHERE root=? AND available=1 ORDER BY name_key").all(root)) {
      const entriesForRow = presentations ? await this.mappingEntriesForRow(row, presentations.get(row.name_key) ?? null)
        : await this.mappingEntriesForRow(row);
      for (const entry of entriesForRow) {
        const key = mappingKey(entry.fileName), old = entries.get(key);
        if (!old?.filePath || old.filePath.toLowerCase() === entry.filePath.toLowerCase()) entries.set(key, entry);
      }
    }
    if (guard) this.assertCurrentScan(root, guard.epoch, guard.mappingHash);
    this.mappings.write([...entries.values()]);
    return this.refresh?.mappingHash([...entries.values()]);
  }

  async exportMappings({ mediaRoot } = {}) {
    if (!this.mappings) throw fail("歌曲映射表未配置", 503);
    if (this.inFlight || this.mappingMutation) throw fail("正在处理歌曲映射，请稍后再试", 409);
    // Export is a backup of the whole table, including files not on this machine.
    if (!fs.existsSync(this.mappings.filePath)) await this.search({ mediaRoot });
    return this.mappings.export();
  }

  async importMappings({ document } = {}) {
    if (!this.mappings) throw fail("歌曲映射表未配置", 503);
    if (this.inFlight || this.mappingMutation) throw fail("正在处理歌曲映射，请稍后再试", 409);
    const merged = this.mappings.mergeImport(document);
    const incoming = new Map(merged.incoming.map((entry) => [mappingKey(entry.fileName), entry]));
    this.commitMappings(merged.entries, () => {
      for (const row of this.db.prepare("SELECT * FROM custom_songs").all()) {
        const files = JSON.parse(row.files_json), overrides = JSON.parse(row.overrides_json);
        let changed = false, name = row.custom_name || row.name;
        for (let index = 0; index < files.length; index += 1) {
          const file = files[index], entry = incoming.get(mappingKey(file.fileName));
          if (!entry) continue;
          if (entry.filePath && entry.filePath.toLowerCase() !== `${row.name_key}/${file.fileName}`.toLowerCase()) continue;
          delete overrides[file.fileName];
          name = entry.name || row.name_key;
          if (entry.tod || entry.manualUnknown) overrides[file.fileName] = entry.tod;
          if (entry.view) file.mappingView = entry.view;
          else delete file.mappingView;
          if (isVisionFile(file)) { delete file.vision; file.evidence = 'unknown'; file.tod = null; }
          changed = true;
        }
        if (changed) this.db.prepare("UPDATE custom_songs SET name=?,custom_name=NULL,files_json=?,overrides_json=? WHERE name_key=?")
          .run(name, JSON.stringify(files), JSON.stringify(overrides), row.name_key);
      }
    });
    this.scannedRoot = null;
    this.invalidatePresentationCache();
    this.refresh?.invalidate();
    return { imported: merged.imported, overwritten: merged.overwritten, total: merged.entries.length };
  }

  commitMappings(entries, updateCatalog) {
    const existed = this.mappings && fs.existsSync(this.mappings.filePath);
    const previous = this.mappings?.read();
    let written = false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      updateCatalog();
      if (this.mappings) { this.mappings.write(entries); written = true; }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      if (written) {
        try {
          if (existed) this.mappings.write(previous);
          else fs.rmSync(this.mappings.filePath, { force: true });
        } catch {
          this.scannedRoot = null;
          this.invalidatePresentationCache();
          throw fail("歌曲映射文件已保存，但目录提交和备份恢复失败；请导出当前映射备份后重新读取曲目", 500);
        }
      }
      throw error;
    }
  }

  validFileName(name) {
    return typeof name === "string" && name.length < 256 && name === path.basename(name)
      && !/[\\/:\0]/.test(name) && /\.mp4$/i.test(name);
  }

  async resolveFile(row, fileName) {
    if (!row || !NAME_KEY.test(row.name_key) || !this.validFileName(fileName)) throw fail("找不到本地演奏视频", 404);
    if (!JSON.parse(row.files_json).some((file) => file.fileName === fileName)) throw fail("找不到本地演奏视频", 404);
    const root = await fs.promises.realpath(row.root);
    const folder = path.join(root, row.name_key);
    const target = path.join(folder, fileName);
    const folderStat = await fs.promises.lstat(folder);
    const fileStat = await fs.promises.lstat(target);
    if (folderStat.isSymbolicLink() || fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.size <= 0) throw fail("本地演奏视频不可用", 404);
    const real = await fs.promises.realpath(target);
    if (!inside(root, real) || path.dirname(real).toLowerCase() !== folder.toLowerCase()) throw fail("视频路径超出曲目目录", 403);
    return { path: real, size: fileStat.size, mtime: fileStat.mtimeMs, stat: fileStat };
  }

  fileRevision(resolved) {
    return revisionForResolvedFile(resolved);
  }

  async media(token, fileName) {
    if (!/^[a-f0-9]{48}$/.test(token)) throw fail("找不到本地演奏视频", 404);
    const row = this.db.prepare("SELECT * FROM custom_songs WHERE media_token=? AND available=1").get(token);
    try { return await this.resolveFile(row, fileName); }
    catch (error) { if (error.status) throw error; throw fail("本地视频已移动或无法读取，请重新扫描", 404); }
  }

  async present(row) {
    const originalFiles = JSON.parse(row.files_json);
    const overrides = JSON.parse(row.overrides_json);
    const invalidInference = new Set();
    for (const file of originalFiles.filter((entry) => entry.evidence === "inferred")) {
      const inference = file.inference;
      if (inference?.method !== "elimination" || inference.version !== 1 || inference.files?.length !== 3 || inference.originals?.length !== 2) {
        invalidInference.add(file.fileName);
        continue;
      }
      for (const source of inference.originals) {
        const original = originalFiles.find((entry) => entry.fileName === source.fileName);
        if (original?.evidence !== "original" || original.tod !== source.tod || original.view !== source.view || original.conflict
          || (Object.hasOwn(overrides, source.fileName) && overrides[source.fileName] !== source.tod)
          || (original?.mappingView && original.mappingView !== source.view)
          || (original?.mappingManual && original.mappingTod !== source.tod)) invalidInference.add(file.fileName);
      }
      for (const dependency of inference.files) {
        try {
          const original = originalFiles.find((entry) => entry.fileName === dependency.fileName);
          const resolved = await this.resolveFile(row, dependency.fileName);
          const current = await inspectVideo(resolved.path, { previous: original?.mediaFacts, budget: { remainingBytes: 0 } });
          if (current.fingerprint !== dependency.fingerprint || current.sha256 !== dependency.sha256 || !current.valid) invalidInference.add(file.fileName);
        } catch { invalidInference.add(file.fileName); }
      }
    }
    const files = [];
    let duration = 0;
    for (const file of originalFiles) {
      let resolved;
      try { resolved = await this.resolveFile(row, file.fileName); }
      catch { continue; }
      const fileRevision = this.fileRevision(resolved);
      if (!duration) {
        const key = resolved.path + ":" + resolved.size + ":" + resolved.mtime;
        if (!this.durationCache.has(key)) {
          if (this.durationCache.size > 10000) this.durationCache.clear();
          this.durationCache.set(key, await mp4Duration(resolved.path).catch(() => 0));
        }
        duration = this.durationCache.get(key);
      }
      const staleVision = isVisionFile(file) && !validVisionFile(file, fileRevision);
      const automaticTod = invalidInference.has(file.fileName) || staleVision ? null : file.tod;
      const automaticEvidence = invalidInference.has(file.fileName) || staleVision ? "unknown"
        : file.evidence === "log" ? "legacy" : file.evidence || "unknown";
      const manual = Object.hasOwn(overrides, file.fileName);
      const tod = manual ? overrides[file.fileName] : file.manualUnknown ? null
        : file.mappingManual ? file.mappingTod : automaticTod;
      const evidence = manual || file.mappingManual || file.manualUnknown ? "manual" : automaticEvidence;
      const source = file.provenance?.[0];
      const evidenceNote = invalidInference.has(file.fileName) ? "旧推定的文件或映射依据已变化，请重新扫描或手工确认。"
        : staleVision ? "旧画面推测的文件或策略版本已变化，当前时段未知。"
        : evidence === "vision" ? "画面推测：由本地城市窗景规则判定，不是官方记录或概率保证。"
        : evidence === "original" ? `原始日志记录：${source?.logFile ?? "已存记录"}${source?.line ? ` 第 ${source.line} 行` : ""}；不代表已核对实际画面。`
        : evidence === "inferred" ? "由两条原始时段记录及三份不同视频排除推定；以同组、同视角为前提，未核对实际画面。"
        : evidence === "legacy" ? "旧映射缺少可复核来源，保留供校正，不计为原始确认。"
        : evidence === "manual" ? "此文件采用手工设置；选择自动识别可撤销该覆盖。"
        : evidence === "mapping" ? "采用歌曲映射表中的时段；可在此校正。"
        : "没有可靠时段映射；播放可暂时复用其他视频。";
      files.push({ fileName: file.fileName, tod: PERIODS.includes(tod) ? tod : null,
        view: file.mappingView ?? file.view ?? null, evidence, automaticTod: PERIODS.includes(automaticTod) ? automaticTod : null,
        automaticEvidence, evidenceNote, conflict: Boolean(file.conflict), provenance: file.provenance ?? [],
        ...(file.inference ? { inference: file.inference } : {}),
        ...(file.vision ? { vision: { algorithm: file.vision.algorithm, policy: file.vision.policy, batchId: file.vision.batchId, savedAt: file.vision.savedAt } } : {}),
        fileRevision,
        url: `${this.baseUrl}/custom-song-media/${row.media_token}/${encodeURIComponent(file.fileName)}` });
    }
    return this.songPresentation(row, files, duration);
  }

  songPresentation(row, files, duration) {
    if (!files.length) return null;
    const fallback = files.find((file) => file.tod === "TOD12") || files[0];
    // Missing time-of-day variants replay a verified file. Unknown files are
    // retained for manual mapping rather than silently labeled as evening.
    const videoByTodView = PERIODS.map((tod) => {
      const mapped = files.find((file) => file.tod === tod);
      return { localPlaybackFallback: !mapped, url: (mapped || fallback).url, tod, view: (mapped || fallback).view || "NI" };
    });
    return {
      localCustomSong: true, localEvidenceVersion: 1,
      id: row.song_id, userSongId: row.song_id, name: baseSongName(row),
      nameKey: row.name_key, songNameKey: row.name_key, itemType: 3, sourceType: 3,
      localAvailable: true, metadataSource: row.metadata_source,
      localFiles: files, fallbackPeriods: PERIODS.filter((tod) => !files.some((file) => file.tod === tod)),
      iconUrl: "", coverUrl: "", performanceType: "Solo", performanceTypeDisplayShortName: "定制演奏",
      videoUrl: fallback.url, audioUrl: fallback.url, mediaUrl: fallback.url, videoByTodView, duration, videoDuration: duration
    };
  }

  async list({ cursor = 0, pageSize = 100 } = {}) {
    ({ cursor, pageSize } = this.paging({ cursor, pageSize }));
    const root = this.refresh?.root || this.root();
    const rows = this.db.prepare("SELECT * FROM custom_songs WHERE available=1 AND root=? ORDER BY name_key").all(root);
    const songs = [];
    for (const row of rows) {
      const song = await this.present(row);
      if (song) songs.push(song);
    }
    return { list: songs.slice(cursor, cursor + pageSize), total: songs.length,
      nextCursor: Math.min(cursor + pageSize, songs.length), hasMore: cursor + pageSize < songs.length,
      mediaRoot: root, warnings: this.lastWarnings,
      missingPeriods: songs.filter((song) => song.fallbackPeriods.length).length };
  }

  async search(input = {}) {
    const root = input.mediaRoot ? this.root(input.mediaRoot) : this.refresh?.root || this.root(undefined, input.detectedRoot);
    if (input.cached === true && this.refresh) return this.refresh.quick(root, this.paging(input));
    this.refresh?.selectRoot(root);
    if (input.cached === true) {
      const paging = this.paging(input);
      if (this.scannedRoot !== root) await this.rebuild({ mediaRoot: root });
      return this.cachedList(root, paging);
    }
    if (this.scannedRoot !== root) await this.rebuild({ mediaRoot: root });
    return this.list(input);
  }

  async update({ nameKey, name, mappings } = {}) {
    if (this.inFlight || this.mappingMutation) throw fail("正在处理歌曲映射，请稍后再试", 409);
    this.mappingMutation = true;
    try { return await this.updateMapping({ nameKey, name, mappings }); }
    finally { this.mappingMutation = false; }
  }

  async updateMapping({ nameKey, name, mappings } = {}) {
    if (!NAME_KEY.test(String(nameKey))) throw fail("曲目编号无效");
    const row = this.db.prepare("SELECT * FROM custom_songs WHERE name_key=?").get(nameKey);
    if (!row) throw fail("找不到曲目", 404);
    const nextName = name === undefined ? row.custom_name : normalizeSongRename(name);
    if (name !== undefined && (!nextName || nextName.length > 240)) throw fail("曲名应为 1～240 个字符");
    if(name!==undefined&&mappings===undefined){
      // The same pure plan is used by diagnostics. A name edit cannot reclassify video periods.
      const plan=planSongRename(row,this.mappings?.read()||[],nextName);
      this.commitMappings(this.mappings?plan.nextEntries:undefined,()=>this.db.prepare("UPDATE custom_songs SET custom_name=?,updated_at=? WHERE name_key=?").run(nextName,Date.now(),nameKey));
      this.invalidatePresentationCache();this.refresh?.invalidate();
      return this.present(this.db.prepare("SELECT * FROM custom_songs WHERE name_key=?").get(nameKey));
    }
    const override = JSON.parse(row.overrides_json);
    const originalFiles = JSON.parse(row.files_json);
    if (mappings !== undefined) {
      if (!Array.isArray(mappings) || mappings.length > 12) throw fail("视频时段设置无效");
      const files = JSON.parse(row.files_json);
      for (const entry of mappings) {
        if (!entry || !files.some((file) => file.fileName === entry.fileName)) throw fail("视频时段设置无效");
        if (Object.hasOwn(entry, "expectedFileRevision")) {
          if (typeof entry.expectedFileRevision !== "string" || !FILE_REVISION.test(entry.expectedFileRevision)) {
            throw fail("视频文件版本无效");
          }
          let resolved;
          try { resolved = await this.resolveFile(row, entry.fileName); }
          catch { throw fail("视频文件已变化或丢失，请刷新后重试", 409); }
          if (this.fileRevision(resolved) !== entry.expectedFileRevision) {
            throw fail("视频文件已变化或丢失，请刷新后重试", 409);
          }
        }
        if (entry.reset === true && !Object.hasOwn(entry, "tod")) {
          delete override[entry.fileName];
          const original = originalFiles.find((file) => file.fileName === entry.fileName);
          delete original.mappingTod; delete original.mappingManual; delete original.mappingView; delete original.manualUnknown;
          if (["manual", "mapping"].includes(original.evidence)) {
            original.evidence = "unknown"; original.tod = null;
          }
        }
        else if (entry.reset === undefined && (entry.tod === null || PERIODS.includes(entry.tod))) override[entry.fileName] = entry.tod;
        else throw fail("视频时段设置无效");
      }
      const proposed = await this.present({ ...row, files_json: JSON.stringify(originalFiles), overrides_json: JSON.stringify(override) });
      const assigned = (proposed?.localFiles ?? []).map((file) => file.tod).filter(Boolean);
      if (new Set(assigned).size !== assigned.length) throw fail("每个时段只能对应一个视频");
    }
    let nextEntries;
    if (this.mappings) {
      const entries = new Map(this.mappings.read().map((entry) => [mappingKey(entry.fileName), entry]));
      const proposed = { ...row, custom_name: nextName, files_json: JSON.stringify(originalFiles), overrides_json: JSON.stringify(override) };
      for (const entry of await this.mappingEntriesForRow(proposed)) entries.set(mappingKey(entry.fileName), entry);
      nextEntries = [...entries.values()];
    }
    this.commitMappings(nextEntries, () => this.db.prepare("UPDATE custom_songs SET custom_name=?,files_json=?,overrides_json=?,updated_at=? WHERE name_key=?")
      .run(nextName, JSON.stringify(originalFiles), JSON.stringify(override), Date.now(), nameKey));
    this.invalidatePresentationCache();
    this.refresh?.invalidate();
    return this.present(this.db.prepare("SELECT * FROM custom_songs WHERE name_key=?").get(nameKey));
  }

  async close() { this.visionTasks.close(); this.debugPackages.clear(); await this.refresh?.close(); }
}
