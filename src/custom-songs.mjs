import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanCustomSongs } from "./custom-song-scan.mjs";

const NAME_KEY = /^midi_[0-9]+_[0-9]+$/;
const PERIODS = ["TOD12", "TOD1730", "TOD20"];
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
  constructor({ db, baseUrl, mediaRoot, logRoot, scan = scanCustomSongs }) {
    this.db = db;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.defaultRoot = mediaRoot || path.join(os.homedir(), "Music", "miHoYo", "Olivia-steam", "cache", "studiovideo");
    this.logRoot = logRoot ?? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "miHoYo", "Olivia-steam", "logs");
    this.scan = scan;
    this.inFlight = null;
    this.scannedRoot = null;
    this.lastWarnings = [];
    this.durationCache = new Map();
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

  async rebuild({ mediaRoot } = {}) {
    const root = this.root(mediaRoot);
    if (this.inFlight) {
      if (this.inFlight.root !== root) throw fail("正在扫描另一个曲目目录，请稍后再试", 409);
      return this.inFlight.promise;
    }
    const promise = this.rebuildRoot(root);
    this.inFlight = { root, promise };
    try { return await promise; } finally { this.inFlight = null; }
  }

  async rebuildRoot(root) {
    try {
      if (!(await fs.promises.stat(root)).isDirectory()) throw fail("曲目下载路径不是文件夹");
    } catch (error) {
      if (error.status) throw error;
      throw fail("无法读取曲目下载文件夹，请检查游戏设置中的下载路径", 404);
    }
    const result = await this.scan({ mediaRoot: root, logRoot: this.logRoot });
    if (!Array.isArray(result.songs)) throw fail("曲目扫描返回无效数据", 500);
    const now = Date.now();
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
        if (!files.length) continue;
        const old = get.get(song.nameKey);
        const oldFiles = old ? JSON.parse(old.files_json) : [];
        // Rotated or truncated logs must not discard a mapping recovered earlier.
        for (const file of files) {
          const previous = oldFiles.find((entry) => entry.fileName === file.fileName);
          if (song.metadataSource === "directory" && !file.tod && previous?.tod) {
            file.tod = previous.tod;
            file.evidence = previous.evidence;
          }
        }
        put.run(song.nameKey, old?.song_id || String(song.id),
          song.metadataSource === "directory" && old?.metadata_source === "log" ? old.name : song.name,
          root, JSON.stringify(files), old?.metadata_source === "log" ? "log" : song.metadataSource,
          old?.media_token || crypto.randomBytes(24).toString("hex"), now);
      }
      this.db.prepare("INSERT INTO settings(key,value) VALUES('customSongs.mediaRoot',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(root);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
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
    return { path: real, size: fileStat.size, mtime: fileStat.mtimeMs };
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
    const files = [];
    let duration = 0;
    for (const file of originalFiles) {
      let resolved;
      try { resolved = await this.resolveFile(row, file.fileName); }
      catch { continue; }
      if (!duration) {
        const key = resolved.path + ":" + resolved.size + ":" + resolved.mtime;
        if (!this.durationCache.has(key)) {
          if (this.durationCache.size > 10000) this.durationCache.clear();
          this.durationCache.set(key, await mp4Duration(resolved.path).catch(() => 0));
        }
        duration = this.durationCache.get(key);
      }
      const tod = Object.hasOwn(overrides, file.fileName) ? overrides[file.fileName] : file.tod;
      files.push({ fileName: file.fileName, tod: PERIODS.includes(tod) ? tod : null,
        evidence: Object.hasOwn(overrides, file.fileName) ? "manual" : file.evidence,
        url: `${this.baseUrl}/custom-song-media/${row.media_token}/${encodeURIComponent(file.fileName)}` });
    }
    if (!files.length) return null;
    const fallback = files.find((file) => file.tod === "TOD12") || files[0];
    // Missing time-of-day variants replay a verified file. Unknown files are
    // retained for manual mapping rather than silently labeled as evening.
    const videoByTodView = PERIODS.map((tod) => ({
      url: (files.find((file) => file.tod === tod) || fallback).url, tod, view: "NI"
    }));
    return {
      id: row.song_id, userSongId: row.song_id, name: row.custom_name || row.name,
      nameKey: row.name_key, songNameKey: row.name_key, itemType: 3, sourceType: 3,
      localCustomSong: true, localAvailable: true, metadataSource: row.metadata_source,
      localFiles: files, fallbackPeriods: PERIODS.filter((tod) => !files.some((file) => file.tod === tod)),
      iconUrl: "", coverUrl: "", performanceType: "Solo", performanceTypeDisplayShortName: "定制演奏",
      videoUrl: fallback.url, audioUrl: fallback.url, mediaUrl: fallback.url, videoByTodView, duration, videoDuration: duration
    };
  }

  async list({ cursor = 0, pageSize = 100 } = {}) {
    cursor = Number(cursor); pageSize = Number(pageSize);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) throw fail("曲目分页参数无效");
    const rows = this.db.prepare("SELECT * FROM custom_songs WHERE available=1 AND root=? ORDER BY name_key").all(this.root());
    const songs = [];
    for (const row of rows) {
      const song = await this.present(row);
      if (song) songs.push(song);
    }
    return { list: songs.slice(cursor, cursor + pageSize), total: songs.length,
      nextCursor: Math.min(cursor + pageSize, songs.length), hasMore: cursor + pageSize < songs.length,
      mediaRoot: this.root(), warnings: this.lastWarnings,
      missingPeriods: songs.filter((song) => song.fallbackPeriods.length).length };
  }

  async search(input = {}) {
    const root = this.root(input.mediaRoot, input.detectedRoot);
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
        if (!entry || !files.some((file) => file.fileName === entry.fileName) || !(entry.tod === null || PERIODS.includes(entry.tod))) throw fail("视频时段设置无效");
        override[entry.fileName] = entry.tod;
      }
      const assigned = files.map((file) => Object.hasOwn(override, file.fileName) ? override[file.fileName] : file.tod).filter(Boolean);
      if (new Set(assigned).size !== assigned.length) throw fail("每个时段只能对应一个视频");
    }
    this.db.prepare("UPDATE custom_songs SET custom_name=?,overrides_json=?,updated_at=? WHERE name_key=?").run(nextName, JSON.stringify(override), Date.now(), nameKey);
    return this.present(this.db.prepare("SELECT * FROM custom_songs WHERE name_key=?").get(nameKey));
  }
}
