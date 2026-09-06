import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanCustomSongs } from "./custom-song-scan.mjs";
import { inspectVideo } from "./custom-song-media-facts.mjs";
import { ScanDiagnostics } from "./custom-song-diagnostics.mjs";
import { SERVICE_VERSION } from "./constants.mjs";

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
  constructor({ db, baseUrl, mediaRoot, logRoot, scan = scanCustomSongs, clock = () => Date.now() }) {
    this.db = db;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.defaultRoot = mediaRoot || path.join(os.homedir(), "Music", "miHoYo", "Olivia-steam", "cache", "studiovideo");
    this.logRoot = logRoot ?? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "miHoYo", "Olivia-steam", "logs");
    this.scan = scan;
    this.logRootSource = logRoot == null ? "default" : "environment";
    this.lastDiagnostics = null;
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

  async assemblePresentation(root) {
    const rows = this.db.prepare("SELECT * FROM custom_songs WHERE available=1 AND root=? ORDER BY name_key").all(root);
    const songs = [];
    for (const row of rows) {
      const song = await this.present(row);
      if (song) songs.push(song);
    }
    const result = { list: songs, total: songs.length, mediaRoot: root,
      warnings: structuredClone(this.lastWarnings), missingPeriods: songs.filter((song) => song.fallbackPeriods.length).length };
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

  async rebuild({ mediaRoot } = {}) {
    const root = this.root(mediaRoot);
    if (this.inFlight) {
      if (this.inFlight.root !== root) {
        this.invalidatePresentationCache();
        throw fail("正在扫描另一个曲目目录，请稍后再试", 409);
      }
      return this.inFlight.promise;
    }
    this.invalidatePresentationCache();
    const promise = this.rebuildRoot(root);
    this.inFlight = { root, promise };
    try { return await promise; } finally {
      this.invalidatePresentationCache();
      this.inFlight = null;
    }
  }

  async rebuildRoot(root) {
    const diagnostics = new ScanDiagnostics({ mediaRoot: root, logRoot: this.logRoot,
      logRootSource: this.logRootSource, patchVersion: SERVICE_VERSION });
    this.lastDiagnostics = null;
    try {
      const result = await this.rebuildWithDiagnostics(root, diagnostics);
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

  async rebuildWithDiagnostics(root, diagnostics) {
    try {
      if (!(await fs.promises.stat(root)).isDirectory()) throw fail("曲目下载路径不是文件夹");
    } catch (error) {
      if (error.status) throw error;
      throw Object.assign(fail("无法读取曲目下载文件夹，请检查游戏设置中的下载路径", 404), { code: error.code });
    }
    const previousSongs = this.db.prepare("SELECT name_key,files_json FROM custom_songs WHERE root=?").all(root)
      .map((row) => ({ nameKey: row.name_key, files: JSON.parse(row.files_json) }));
    const result = await this.scan({ mediaRoot: root, logRoot: this.logRoot, previousSongs, diagnostics });
    if (!Array.isArray(result.songs)) throw fail("曲目扫描返回无效数据", 500);
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
          if (!file.tod && previous?.tod && previous.evidence !== "inferred") {
            file.legacyMapping = { tod: previous.tod, view: previous.view ?? null };
          }
          if (!file.conflict && !file.tod && previous?.tod && previous.evidence !== "inferred"
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
    this.scannedRoot = root;
    this.lastWarnings = result.warnings || [];
    return this.list({ pageSize: 200 });
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
    const stat = resolved.stat;
    const metadata = {
      path: resolved.path,
      size: String(stat.size),
      mtimeNs: stat.mtimeNs === undefined ? String(stat.mtimeMs) : String(stat.mtimeNs),
      ctimeNs: stat.ctimeNs === undefined ? String(stat.ctimeMs) : String(stat.ctimeNs),
      ino: String(stat.ino),
      dev: String(stat.dev)
    };
    return `v1:${crypto.createHash("sha256").update(JSON.stringify(metadata)).digest("hex")}`;
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
          || (Object.hasOwn(overrides, source.fileName) && overrides[source.fileName] !== source.tod)) invalidInference.add(file.fileName);
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
      const automaticTod = invalidInference.has(file.fileName) ? null : file.tod;
      const automaticEvidence = invalidInference.has(file.fileName) ? "unknown"
        : file.evidence === "log" ? "legacy" : file.evidence || "unknown";
      const manual = Object.hasOwn(overrides, file.fileName);
      const tod = manual ? overrides[file.fileName] : automaticTod;
      const evidence = manual ? "manual" : automaticEvidence;
      const source = file.provenance?.[0];
      const evidenceNote = invalidInference.has(file.fileName) ? "旧推定的文件或映射依据已变化，请重新扫描或手工确认。"
        : evidence === "original" ? `原始日志记录：${source?.logFile ?? "已存记录"}${source?.line ? ` 第 ${source.line} 行` : ""}；不代表已核对实际画面。`
        : evidence === "inferred" ? "由两条原始时段记录及三份不同视频排除推定；以同组、同视角为前提，未核对实际画面。"
        : evidence === "legacy" ? "旧映射缺少可复核来源，保留供校正，不计为原始确认。"
        : evidence === "manual" ? "此文件采用手工设置；选择自动识别可撤销该覆盖。"
        : "没有可靠时段映射；播放可暂时复用其他视频。";
      files.push({ fileName: file.fileName, tod: PERIODS.includes(tod) ? tod : null,
        view: file.view ?? null, evidence, automaticTod: PERIODS.includes(automaticTod) ? automaticTod : null,
        automaticEvidence, evidenceNote, conflict: Boolean(file.conflict), provenance: file.provenance ?? [],
        ...(file.inference ? { inference: file.inference } : {}),
        fileRevision,
        url: `${this.baseUrl}/custom-song-media/${row.media_token}/${encodeURIComponent(file.fileName)}` });
    }
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
      id: row.song_id, userSongId: row.song_id, name: row.custom_name || row.name,
      nameKey: row.name_key, songNameKey: row.name_key, itemType: 3, sourceType: 3,
      localAvailable: true, metadataSource: row.metadata_source,
      localFiles: files, fallbackPeriods: PERIODS.filter((tod) => !files.some((file) => file.tod === tod)),
      iconUrl: "", coverUrl: "", performanceType: "Solo", performanceTypeDisplayShortName: "定制演奏",
      videoUrl: fallback.url, audioUrl: fallback.url, mediaUrl: fallback.url, videoByTodView, duration, videoDuration: duration
    };
  }

  async list({ cursor = 0, pageSize = 100 } = {}) {
    ({ cursor, pageSize } = this.paging({ cursor, pageSize }));
    const root = this.root();
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
    const root = this.root(input.mediaRoot, input.detectedRoot);
    if (input.cached === true) {
      const paging = this.paging(input);
      if (this.scannedRoot !== root) await this.rebuild({ mediaRoot: root });
      return this.cachedList(root, paging);
    }
    if (this.scannedRoot !== root) await this.rebuild({ mediaRoot: root });
    return this.list(input);
  }

  async update({ nameKey, name, mappings } = {}) {
    if (!NAME_KEY.test(String(nameKey))) throw fail("曲目编号无效");
    const row = this.db.prepare("SELECT * FROM custom_songs WHERE name_key=?").get(nameKey);
    if (!row) throw fail("找不到曲目", 404);
    const nextName = name === undefined ? row.custom_name : String(name).trim();
    if (name !== undefined && (!nextName || nextName.length > 240)) throw fail("曲名应为 1～240 个字符");
    const override = JSON.parse(row.overrides_json);
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
        if (entry.reset === true && !Object.hasOwn(entry, "tod")) delete override[entry.fileName];
        else if (entry.reset === undefined && (entry.tod === null || PERIODS.includes(entry.tod))) override[entry.fileName] = entry.tod;
        else throw fail("视频时段设置无效");
      }
      const proposed = await this.present({ ...row, overrides_json: JSON.stringify(override) });
      const assigned = (proposed?.localFiles ?? []).map((file) => file.tod).filter(Boolean);
      if (new Set(assigned).size !== assigned.length) throw fail("每个时段只能对应一个视频");
    }
    this.db.prepare("UPDATE custom_songs SET custom_name=?,overrides_json=?,updated_at=? WHERE name_key=?").run(nextName, JSON.stringify(override), Date.now(), nameKey);
    this.invalidatePresentationCache();
    return this.present(this.db.prepare("SELECT * FROM custom_songs WHERE name_key=?").get(nameKey));
  }
}
