import {
  compactWhitespace,
  nowSeconds,
  parseJson,
  randomId
} from "../utils.mjs";

const MUSIC_SOURCE_TYPES = new Set([2, 3]);
const MUSIC_PLAYLIST_ID_PATTERN = /^music-playlist-[a-z0-9-]+$/i;
export const MUSIC_DESKTOP_PLAYLIST_ID = "music-playlist-desktop";
export const MUSIC_DESKTOP_PLAYLIST_NAME = "__LOCAL_MUSIC_DESKTOP__";

function musicInputError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeMusicPlaylistId(value) {
  const id = String(value ?? "").trim();
  if (!MUSIC_PLAYLIST_ID_PATTERN.test(id) || id.length > 120) {
    throw musicInputError("自定义歌单编号无效");
  }
  return id;
}

function normalizeMusicPlaylistName(value) {
  const name = compactWhitespace(value);
  if (!name) throw musicInputError("请输入歌单名称");
  if (name.length > 40) throw musicInputError("歌单名称不能超过 40 个字符");
  return name;
}

function normalizeMusicText(value, maximum = 240) {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maximum);
}

const MUSIC_STRUCTURED_MAX_DEPTH = 8;
const MUSIC_STRUCTURED_MAX_NODES = 512;
const MUSIC_STRUCTURED_MAX_ARRAY_ITEMS = 256;
const MUSIC_STRUCTURED_MAX_OBJECT_KEYS = 64;
const MUSIC_STRUCTURED_MAX_STRING_LENGTH = 4096;
const MUSIC_STRUCTURED_MAX_BYTES = 64 * 1024;
const MUSIC_STRUCTURED_DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function normalizeMusicStructuredValue(value) {
  if (value != null && !Array.isArray(value)) {
    throw musicInputError("曲目视频视图元数据根层必须是数组");
  }
  const active = new Set();
  let nodeCount = 0;

  function clone(current, depth) {
    if (current == null) return null;
    if (depth > MUSIC_STRUCTURED_MAX_DEPTH) {
      throw musicInputError("曲目视频视图元数据嵌套过深");
    }
    if (typeof current === "string") {
      if (current.length > MUSIC_STRUCTURED_MAX_STRING_LENGTH) {
        throw musicInputError("曲目视频视图元数据过大");
      }
      return current;
    }
    if (typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw musicInputError("曲目视频视图元数据包含无效数字");
      return current;
    }
    if (typeof current === "function") {
      throw musicInputError("曲目视频视图元数据不允许函数");
    }
    if (typeof current !== "object") {
      throw musicInputError("曲目视频视图元数据必须是 JSON 结构");
    }
    if (active.has(current)) throw musicInputError("曲目视频视图元数据不能包含循环引用");

    const isArray = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    if (isArray) {
      if (prototype !== Array.prototype) throw musicInputError("曲目视频视图元数据数组格式无效");
      if (current.length > MUSIC_STRUCTURED_MAX_ARRAY_ITEMS) {
        throw musicInputError("曲目视频视图元数据数组过大");
      }
    } else if (prototype !== Object.prototype && prototype !== null) {
      throw musicInputError("曲目视频视图元数据对象格式无效");
    }

    const enumerableSymbols = Object.getOwnPropertySymbols(current)
      .filter((symbol) => Object.getOwnPropertyDescriptor(current, symbol)?.enumerable);
    if (enumerableSymbols.length) throw musicInputError("曲目视频视图元数据不允许符号键");

    const keys = Object.keys(current);
    if (!isArray && keys.length > MUSIC_STRUCTURED_MAX_OBJECT_KEYS) {
      throw musicInputError("曲目视频视图元数据对象过大");
    }
    if (isArray) {
      for (const key of keys) {
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index < 0 || index >= current.length || String(index) !== key) {
          throw musicInputError("曲目视频视图元数据数组键无效");
        }
      }
    }

    nodeCount += 1;
    if (nodeCount > MUSIC_STRUCTURED_MAX_NODES) {
      throw musicInputError("曲目视频视图元数据过大");
    }

    active.add(current);
    try {
      if (isArray) {
        const result = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          result.push(descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
            ? clone(descriptor.value, depth + 1)
            : null);
        }
        return result;
      }

      const result = {};
      for (const key of keys) {
        if (key.length > 128 || MUSIC_STRUCTURED_DANGEROUS_KEYS.has(key)) {
          throw musicInputError("曲目视频视图元数据包含危险键");
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
          throw musicInputError("曲目视频视图元数据不允许访问器");
        }
        result[key] = clone(descriptor.value, depth + 1);
      }
      return result;
    } finally {
      active.delete(current);
    }
  }

  const normalized = clone(value, 0);
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, "utf8") > MUSIC_STRUCTURED_MAX_BYTES) {
    throw musicInputError("曲目视频视图元数据过大");
  }
  return normalized;
}

function normalizeMusicUrl(value) {
  const text = normalizeMusicText(value, 2048);
  if (!text) return "";
  try {
    const parsed = new URL(text);
    return new Set(["http:", "https:"]).has(parsed.protocol) ? text : "";
  } catch {
    return "";
  }
}

function normalizeFirstMusicUrl(...values) {
  for (const value of values) {
    const normalized = normalizeMusicUrl(value);
    if (normalized) return normalized;
  }
  return "";
}

function normalizeMusicDuration(value) {
  const duration = Number(value);
  return Number.isFinite(duration) ? Math.max(0, Math.min(86_400, duration)) : 0;
}

function normalizeMusicSong(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw musicInputError("歌单曲目格式无效");
  }
  const sourceType = Number(input.sourceType ?? input.itemType);
  if (!MUSIC_SOURCE_TYPES.has(sourceType)) {
    throw musicInputError("歌单曲目来源无效");
  }
  const itemId = normalizeMusicText(input.itemId ?? input.id ?? input.songId, 160);
  if (!itemId) throw musicInputError("歌单曲目缺少编号");
  const id = normalizeMusicText(input.id ?? input.songId ?? itemId, 160);
  const coverUrl = normalizeFirstMusicUrl(
    input.coverUrl, input.cover, input.iconUrl, input.icon
  );
  const videoUrl = normalizeFirstMusicUrl(input.videoUrl, input.videoURL, input.video_url);
  const audioUrl = normalizeFirstMusicUrl(input.audioUrl, input.audioURL, input.audio_url);
  const mediaUrl = normalizeFirstMusicUrl(input.mediaUrl, input.mediaURL, input.media_url);
  const duration = normalizeMusicDuration(
    input.duration ?? input.videoDuration ?? input.audioDuration
  );
  const nameKey = normalizeMusicText(input.nameKey, 240);
  const songNameKey = normalizeMusicText(input.songNameKey ?? input.song_name_key, 240) || nameKey;

  const song = {
    id,
    itemId,
    itemType: sourceType,
    sourceType,
    sourceId: normalizeMusicText(input.sourceId ?? input.source_id, 160),
    songId: normalizeMusicText(input.songId ?? id, 160),
    performanceId: normalizeMusicText(input.performanceId ?? input.performance_id, 160),
    name: normalizeMusicText(input.name, 240) || "未命名曲目",
    nameKey,
    songNameKey,
    cover: coverUrl,
    coverUrl,
    icon: coverUrl,
    iconUrl: coverUrl,
    performanceType: normalizeMusicText(input.performanceType, 80),
    performanceTypeDisplayShortName: normalizeMusicText(input.performanceTypeDisplayShortName, 80),
    performanceTypeDisplayName: normalizeMusicText(input.performanceTypeDisplayName, 120),
    styleType: normalizeMusicText(input.styleType, 80),
    styleTypeDisplayName: normalizeMusicText(input.styleTypeDisplayName, 120),
    styleTypeDisplayShortName: normalizeMusicText(input.styleTypeDisplayShortName, 80),
    performance: normalizeMusicText(input.performance, 120),
    performanceName: normalizeMusicText(input.performanceName, 120),
    style: normalizeMusicText(input.style, 120),
    styleName: normalizeMusicText(input.styleName, 120),
    duration,
    videoDuration: normalizeMusicDuration(input.videoDuration ?? duration),
    audioDuration: normalizeMusicDuration(input.audioDuration ?? duration),
    videoUrl,
    audioUrl,
    mediaUrl,
    videoByTodView: normalizeMusicStructuredValue(input.videoByTodView ?? input.video_by_tod_view)
  };
  return {
    itemKey: `${sourceType}:${itemId}`,
    sourceType,
    song
  };
}

function normalizeStoredMusicSong(song) {
  if (!song || typeof song !== "object" || Array.isArray(song)) return {};
  const normalized = { ...song };
  const hasVideoByTodView = Object.prototype.hasOwnProperty.call(song, "videoByTodView");
  const hasVideoByTodViewAlias = Object.prototype.hasOwnProperty.call(song, "video_by_tod_view");
  if (hasVideoByTodView || hasVideoByTodViewAlias) {
    try {
      normalized.videoByTodView = normalizeMusicStructuredValue(
        song.videoByTodView ?? song.video_by_tod_view
      );
    } catch {
      // 历史上被错误文本化的值不可逆；读出时只当作缺失，等待完整曲目再次覆盖。
      normalized.videoByTodView = null;
    }
    delete normalized.video_by_tod_view;
  }

  const nameKey = typeof song.nameKey === "string" ? normalizeMusicText(song.nameKey, 240) : "";
  const songNameKey = typeof song.songNameKey === "string"
    ? normalizeMusicText(song.songNameKey, 240)
    : "";
  if (!songNameKey && nameKey) normalized.songNameKey = nameKey;
  return normalized;
}

const MUSIC_DESKTOP_CANONICAL_INPUT_FIELDS = [
  "id",
  "itemId",
  "itemType",
  "sourceType",
  "sourceId",
  "source_id",
  "songId",
  "song_id",
  "performanceId",
  "performance_id",
  "name",
  "nameKey",
  "songNameKey",
  "song_name_key",
  "cover",
  "coverUrl",
  "icon",
  "iconUrl",
  "performanceType",
  "performanceTypeDisplayShortName",
  "performanceTypeDisplayName",
  "styleType",
  "styleTypeDisplayName",
  "styleTypeDisplayShortName",
  "performance",
  "performanceName",
  "style",
  "styleName",
  "duration",
  "videoDuration",
  "audioDuration",
  "videoUrl",
  "videoURL",
  "video_url",
  "audioUrl",
  "audioURL",
  "audio_url",
  "mediaUrl",
  "mediaURL",
  "media_url",
  "videoByTodView",
  "video_by_tod_view"
];

function preserveMusicDesktopSong(source, normalizedSong) {
  let preserved;
  try {
    preserved = JSON.parse(JSON.stringify(source));
  } catch {
    throw musicInputError("歌单曲目格式无效");
  }
  for (const field of MUSIC_DESKTOP_CANONICAL_INPUT_FIELDS) {
    delete preserved[field];
  }
  return { ...preserved, ...normalizedSong };
}

function normalizeMusicDesktopSong(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw musicInputError("歌单曲目格式无效");
  }
  const source = entry.song && typeof entry.song === "object" && !Array.isArray(entry.song)
    ? entry.song
    : entry;
  const normalized = normalizeMusicSong({
    ...source,
    sourceType: entry.sourceType ?? entry.itemType ?? source.sourceType ?? source.itemType,
    itemId: entry.itemId ?? source.itemId ?? source.id ?? source.songId,
    id: source.id ?? source.songId ?? entry.itemId
  });
  return {
    ...normalized,
    song: preserveMusicDesktopSong(source, normalized.song),
    source
  };
}

const MUSIC_DESKTOP_PARTIAL_FIELDS = [
  ["id", ["id"]],
  ["songId", ["songId", "song_id"]],
  ["sourceId", ["sourceId", "source_id"]],
  ["name", ["name"]],
  ["nameKey", ["nameKey"]],
  ["songNameKey", ["songNameKey", "song_name_key"]],
  ["cover", ["cover", "coverUrl", "icon", "iconUrl"]],
  ["coverUrl", ["cover", "coverUrl", "icon", "iconUrl"]],
  ["icon", ["cover", "coverUrl", "icon", "iconUrl"]],
  ["iconUrl", ["cover", "coverUrl", "icon", "iconUrl"]],
  ["performanceId", ["performanceId", "performance_id"]],
  ["performanceType", ["performanceType"]],
  ["performanceTypeDisplayShortName", ["performanceTypeDisplayShortName"]],
  ["performanceTypeDisplayName", ["performanceTypeDisplayName"]],
  ["styleType", ["styleType"]],
  ["styleTypeDisplayName", ["styleTypeDisplayName"]],
  ["styleTypeDisplayShortName", ["styleTypeDisplayShortName"]],
  ["performance", ["performance"]],
  ["performanceName", ["performanceName"]],
  ["style", ["style"]],
  ["styleName", ["styleName"]],
  ["duration", ["duration"]],
  ["videoDuration", ["videoDuration"]],
  ["audioDuration", ["audioDuration"]],
  ["videoUrl", ["videoUrl", "videoURL", "video_url"]],
  ["audioUrl", ["audioUrl", "audioURL", "audio_url"]],
  ["mediaUrl", ["mediaUrl", "mediaURL", "media_url"]],
  ["videoByTodView", ["videoByTodView", "video_by_tod_view"]]
];

function mergeMusicDesktopSong(existingSong, incomingSong, source) {
  const merged = { ...(existingSong || {}), ...incomingSong };
  for (const [field, aliases] of MUSIC_DESKTOP_PARTIAL_FIELDS) {
    const provided = aliases.some((alias) => Object.prototype.hasOwnProperty.call(source, alias));
    if (!provided && existingSong && Object.prototype.hasOwnProperty.call(existingSong, field)) {
      merged[field] = existingSong[field];
    }
  }
  return merged;
}

function normalizeMusicItemKeys(input) {
  const raw = input?.itemKeys ?? input?.item_keys
    ?? (input && input.itemType != null ? [input] : input);
  const values = Array.isArray(raw) ? raw : [raw];
  const keys = [];
  const seen = new Set();
  for (const value of values) {
    const key = typeof value === "object" && value !== null
      ? `${Number(value.itemType ?? value.sourceType)}:${String(value.itemId ?? value.id ?? "").trim()}`
      : String(value ?? "").trim();
    if (!/^[23]:[^\s]{1,160}$/.test(key) || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  if (!keys.length) throw musicInputError("请至少选择一首曲目");
  if (keys.length > 200) throw musicInputError("一次最多操作 200 首曲目");
  return keys;
}

function normalizeMusicOrder(input) {
  const raw = input?.itemKeys ?? input?.item_keys ?? input?.order ?? input?.items ?? input;
  const values = Array.isArray(raw) ? raw : [raw];
  const keys = [];
  const seen = new Set();
  for (const value of values) {
    const key = typeof value === "object" && value !== null
      ? `${Number(value.itemType ?? value.sourceType)}:${String(value.itemId ?? value.id ?? "").trim()}`
      : String(value ?? "").trim();
    if (!/^[23]:[^\s]{1,160}$/.test(key) || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  if (!keys.length) throw musicInputError("请至少提供一项曲目顺序");
  if (keys.length > 200) throw musicInputError("一次最多排序 200 首曲目");
  return keys;
}

export function initializeMusicDatabaseSchema(db) {
  db.exec(`
      CREATE TABLE IF NOT EXISTS music_playlists (
        playlist_id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS music_playlist_items (
        playlist_id TEXT NOT NULL,
        item_key TEXT NOT NULL,
        source_type INTEGER NOT NULL,
        song_json TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        position INTEGER,
        PRIMARY KEY(playlist_id, item_key),
        FOREIGN KEY(playlist_id) REFERENCES music_playlists(playlist_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_music_playlist_items_added
        ON music_playlist_items(playlist_id, added_at);
    `);
}

export function migrateMusicPlaylistPositions(db) {
  const playlists = db.prepare(`
      SELECT DISTINCT playlist_id
      FROM music_playlist_items
      WHERE position IS NULL
    `).all();
  if (!playlists.length) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const maxPosition = db.prepare(
      "SELECT COALESCE(MAX(position), -1) AS position FROM music_playlist_items WHERE playlist_id = ?"
    );
    const missingItems = db.prepare(`
        SELECT item_key
        FROM music_playlist_items
        WHERE playlist_id = ? AND position IS NULL
        ORDER BY added_at ASC, rowid ASC
      `);
    const setPosition = db.prepare(
      "UPDATE music_playlist_items SET position = ? WHERE playlist_id = ? AND item_key = ?"
    );
    for (const playlist of playlists) {
      let position = Number(maxPosition.get(playlist.playlist_id).position) + 1;
      for (const item of missingItems.all(playlist.playlist_id)) {
        setPosition.run(position, playlist.playlist_id, item.item_key);
        position += 1;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function ensureMusicDesktopPlaylist(db) {
  const now = nowSeconds();
  const playlistByName = db.prepare(
    "SELECT playlist_id, name FROM music_playlists WHERE name = ? COLLATE NOCASE"
  );
  const playlistById = db.prepare(
    "SELECT playlist_id, name FROM music_playlists WHERE playlist_id = ?"
  );
  const renamePlaylist = db.prepare(
    "UPDATE music_playlists SET name = ?, updated_at = ? WHERE playlist_id = ?"
  );
  const insertPlaylist = db.prepare(`
      INSERT INTO music_playlists(playlist_id, name, created_at, updated_at)
      VALUES(?, ?, ?, ?)
    `);

  db.exec("BEGIN IMMEDIATE");
  try {
    const conflict = playlistByName.get(MUSIC_DESKTOP_PLAYLIST_NAME);
    if (conflict && conflict.playlist_id !== MUSIC_DESKTOP_PLAYLIST_ID) {
      let attempt = 0;
      let replacementName;
      while (true) {
        const suffix = ` [legacy:${conflict.playlist_id}${attempt ? `-${attempt}` : ""}]`;
        replacementName = `${conflict.name}${suffix}`;
        const taken = playlistByName.get(replacementName);
        if (!taken || taken.playlist_id === conflict.playlist_id) break;
        attempt += 1;
      }
      renamePlaylist.run(replacementName, now, conflict.playlist_id);
    }

    const existing = playlistById.get(MUSIC_DESKTOP_PLAYLIST_ID);
    if (!existing) {
      insertPlaylist.run(MUSIC_DESKTOP_PLAYLIST_ID, MUSIC_DESKTOP_PLAYLIST_NAME, now, now);
    } else if (existing.name !== MUSIC_DESKTOP_PLAYLIST_NAME) {
      renamePlaylist.run(MUSIC_DESKTOP_PLAYLIST_NAME, now, MUSIC_DESKTOP_PLAYLIST_ID);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function prepareMusicDatabaseStatements(db) {
  return {
    musicPlaylistList: db.prepare(`
        SELECT p.playlist_id, p.name, p.created_at, p.updated_at,
               COUNT(i.item_key) AS item_count
        FROM music_playlists p
        LEFT JOIN music_playlist_items i ON i.playlist_id = p.playlist_id
        WHERE p.playlist_id <> ?
        GROUP BY p.playlist_id
        ORDER BY p.created_at ASC, p.playlist_id ASC
      `),
    musicPlaylistGet: db.prepare(`
        SELECT p.playlist_id, p.name, p.created_at, p.updated_at,
               COUNT(i.item_key) AS item_count
        FROM music_playlists p
        LEFT JOIN music_playlist_items i ON i.playlist_id = p.playlist_id
        WHERE p.playlist_id = ?
        GROUP BY p.playlist_id
      `),
    musicPlaylistByName: db.prepare("SELECT playlist_id FROM music_playlists WHERE name = ? COLLATE NOCASE"),
    musicPlaylistInsert: db.prepare(`
        INSERT INTO music_playlists(playlist_id, name, created_at, updated_at)
        VALUES(?, ?, ?, ?)
      `),
    musicPlaylistItems: db.prepare(`
        SELECT item_key, source_type, song_json, added_at, position
        FROM music_playlist_items
        WHERE playlist_id = ?
        ORDER BY position ASC, added_at ASC, rowid ASC
      `),
    musicPlaylistItemGet: db.prepare(`
        SELECT item_key, source_type, song_json, added_at, position
        FROM music_playlist_items
        WHERE playlist_id = ? AND item_key = ?
      `),
    musicPlaylistNextPosition: db.prepare(`
        SELECT COALESCE(MAX(position), -1) + 1 AS position
        FROM music_playlist_items
        WHERE playlist_id = ?
      `),
    musicPlaylistItemUpsert: db.prepare(`
        INSERT INTO music_playlist_items(playlist_id, item_key, source_type, song_json, added_at, position)
        VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(playlist_id, item_key) DO UPDATE SET
          source_type = excluded.source_type,
          song_json = excluded.song_json
      `),
    musicPlaylistItemDelete: db.prepare(`
        DELETE FROM music_playlist_items WHERE playlist_id = ? AND item_key = ?
      `),
    musicPlaylistTouch: db.prepare("UPDATE music_playlists SET updated_at = ? WHERE playlist_id = ?")
  };
}

export function installMusicDatabaseDomain(MailDatabase) {
  const methods = {
    musicPlaylistRow(row) {
      if (!row) return null;
      return {
        playlistId: row.playlist_id,
        name: row.name,
        itemCount: Number(row.item_count || 0),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at)
      };
    },

    listMusicPlaylists() {
      return this.statements.musicPlaylistList.all(MUSIC_DESKTOP_PLAYLIST_ID)
        .map((row) => this.musicPlaylistRow(row));
    },

    getMusicPlaylist(playlistId) {
      return this.musicPlaylistRow(this.statements.musicPlaylistGet.get(normalizeMusicPlaylistId(playlistId)));
    },

    requireMusicPlaylist(playlistId) {
      const playlist = this.getMusicPlaylist(playlistId);
      if (!playlist) throw musicInputError("找不到该自定义歌单", 404);
      return playlist;
    },

    createMusicPlaylist(input) {
      const name = normalizeMusicPlaylistName(input?.name ?? input);
      if (name.toLowerCase() === MUSIC_DESKTOP_PLAYLIST_NAME.toLowerCase()) {
        throw musicInputError("该歌单名称为系统保留名称", 409);
      }
      if (this.statements.musicPlaylistByName.get(name)) {
        throw musicInputError("已有同名自定义歌单", 409);
      }
      const playlistId = randomId("music-playlist");
      const now = nowSeconds();
      this.statements.musicPlaylistInsert.run(playlistId, name, now, now);
      return this.requireMusicPlaylist(playlistId);
    },

    listMusicPlaylistItems(playlistId) {
      const playlist = this.requireMusicPlaylist(playlistId);
      const items = this.statements.musicPlaylistItems.all(playlist.playlistId).map((row) => ({
        itemKey: row.item_key,
        sourceType: Number(row.source_type),
        song: normalizeStoredMusicSong(parseJson(row.song_json, {})),
        addedAt: Number(row.added_at),
        position: Number(row.position ?? 0)
      }));
      return { playlist, items };
    },

    upsertMusicPlaylistItems(playlist, songs) {
      const now = nowSeconds();
      let added = 0;
      let updated = 0;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const entry of songs) {
          const exists = this.db.prepare(
            "SELECT 1 AS found FROM music_playlist_items WHERE playlist_id = ? AND item_key = ?"
          ).get(playlist.playlistId, entry.itemKey);
          const position = Number(this.statements.musicPlaylistNextPosition.get(playlist.playlistId).position);
          this.statements.musicPlaylistItemUpsert.run(
            playlist.playlistId,
            entry.itemKey,
            entry.sourceType,
            JSON.stringify(entry.song),
            now,
            position
          );
          if (exists) updated += 1;
          else added += 1;
        }
        this.statements.musicPlaylistTouch.run(now, playlist.playlistId);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return {
        playlist: this.requireMusicPlaylist(playlist.playlistId),
        requested: songs.length,
        added,
        updated
      };
    },

    addMusicPlaylistItems(playlistId, input) {
      const playlist = this.requireMusicPlaylist(playlistId);
      const rawSongs = Array.isArray(input?.songs) ? input.songs : input?.song ? [input.song] : [];
      if (!rawSongs.length) throw musicInputError("请至少选择一首曲目");
      if (rawSongs.length > 200) throw musicInputError("一次最多操作 200 首曲目");
      return this.upsertMusicPlaylistItems(playlist, rawSongs.map(normalizeMusicSong));
    },

    musicDesktopItem(row) {
      const song = normalizeStoredMusicSong(parseJson(row.song_json, {}));
      const itemId = String(song.itemId || song.id || "");
      const songId = String(song.songId || song.id || itemId);
      const cover = song.cover || song.coverUrl || song.icon || song.iconUrl || "";
      const nameKey = song.nameKey || "";
      const songNameKey = song.songNameKey || nameKey;
      return {
        itemKey: row.item_key,
        itemId,
        id: itemId,
        itemType: Number(row.source_type),
        sourceType: Number(row.source_type),
        sourceId: song.sourceId || "",
        songId,
        performanceId: song.performanceId || "",
        name: song.name || "未命名曲目",
        nameKey,
        songNameKey,
        cover,
        coverUrl: cover,
        icon: cover,
        iconUrl: cover,
        videoUrl: song.videoUrl || "",
        audioUrl: song.audioUrl || "",
        mediaUrl: song.mediaUrl || "",
        videoByTodView: song.videoByTodView ?? null,
        performanceType: song.performanceType || "",
        performanceTypeDisplayShortName: song.performanceTypeDisplayShortName || "",
        performanceTypeDisplayName: song.performanceTypeDisplayName || "",
        styleType: song.styleType || "",
        styleTypeDisplayName: song.styleTypeDisplayName || "",
        styleTypeDisplayShortName: song.styleTypeDisplayShortName || "",
        performance: song.performance || "",
        performanceName: song.performanceName || "",
        style: song.style || "",
        styleName: song.styleName || "",
        duration: Number(song.duration || 0),
        videoDuration: Number(song.videoDuration || 0),
        audioDuration: Number(song.audioDuration || 0),
        addedAt: Number(row.added_at),
        position: Number(row.position ?? 0),
        song
      };
    },

    listMusicDesktop() {
      const playlist = this.requireMusicPlaylist(MUSIC_DESKTOP_PLAYLIST_ID);
      const list = this.statements.musicPlaylistItems.all(playlist.playlistId)
        .map((row) => this.musicDesktopItem(row));
      return {
        list,
        total: list.length,
        hasMore: false,
        nextCursor: 0
      };
    },

    addMusicDesktopItems(input) {
      const rawEntries = Array.isArray(input?.songs)
        ? input.songs
        : input?.song || input?.itemType != null
          ? [input]
          : [];
      if (!rawEntries.length) throw musicInputError("请至少选择一首曲目");
      if (rawEntries.length > 200) throw musicInputError("一次最多操作 200 首曲目");
      const entries = rawEntries.map(normalizeMusicDesktopSong);
      const priorSongs = new Map();
      const mergedEntries = entries.map((entry) => {
        const existingSong = priorSongs.has(entry.itemKey)
          ? priorSongs.get(entry.itemKey)
          : (() => {
              const row = this.statements.musicPlaylistItemGet.get(
                MUSIC_DESKTOP_PLAYLIST_ID,
                entry.itemKey
              );
              return row ? parseJson(row.song_json, {}) : null;
            })();
        const mergedSong = mergeMusicDesktopSong(existingSong, entry.song, entry.source);
        priorSongs.set(entry.itemKey, mergedSong);
        return { ...entry, song: mergedSong };
      });
      const result = this.upsertMusicPlaylistItems(
        this.requireMusicPlaylist(MUSIC_DESKTOP_PLAYLIST_ID),
        mergedEntries.map((entry) => ({
          ...entry,
          song: entry.song
        }))
      );
      const items = mergedEntries.map((entry) => {
        const row = this.statements.musicPlaylistItemGet.get(
          MUSIC_DESKTOP_PLAYLIST_ID,
          entry.itemKey
        );
        return this.musicDesktopItem(row);
      });
      return {
        requested: result.requested,
        added: result.added,
        updated: result.updated,
        item: items.length === 1 ? items[0] : null,
        items,
        total: result.playlist.itemCount
      };
    },

    removeMusicPlaylistItems(playlistId, input) {
      const playlist = this.requireMusicPlaylist(playlistId);
      const itemKeys = normalizeMusicItemKeys(input?.itemKeys ?? input?.item_keys ?? input);
      let removed = 0;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const itemKey of itemKeys) {
          removed += this.statements.musicPlaylistItemDelete.run(playlist.playlistId, itemKey).changes;
        }
        if (removed) this.statements.musicPlaylistTouch.run(nowSeconds(), playlist.playlistId);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return {
        playlist: this.requireMusicPlaylist(playlist.playlistId),
        requested: itemKeys.length,
        removed
      };
    },

    removeMusicDesktopItems(input) {
      const result = this.removeMusicPlaylistItems(MUSIC_DESKTOP_PLAYLIST_ID, input);
      return {
        requested: result.requested,
        removed: result.removed,
        total: result.playlist.itemCount
      };
    },

    reorderMusicPlaylistItems(playlistId, input) {
      const playlist = this.requireMusicPlaylist(playlistId);
      const requested = normalizeMusicOrder(input);
      const rows = this.statements.musicPlaylistItems.all(playlist.playlistId);
      const current = rows.map((row) => row.item_key);
      for (const itemKey of requested) {
        if (!current.includes(itemKey)) throw musicInputError("排序曲目不存在", 404);
      }
      const ordered = [
        ...requested,
        ...current.filter((itemKey) => !requested.includes(itemKey))
      ];
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const setPosition = this.db.prepare(
          "UPDATE music_playlist_items SET position = ? WHERE playlist_id = ? AND item_key = ?"
        );
        ordered.forEach((itemKey, index) => setPosition.run(index, playlist.playlistId, itemKey));
        this.statements.musicPlaylistTouch.run(nowSeconds(), playlist.playlistId);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return {
        playlist: this.requireMusicPlaylist(playlist.playlistId),
        reordered: requested.length,
        order: ordered
      };
    },

    reorderMusicDesktop(input) {
      const result = this.reorderMusicPlaylistItems(MUSIC_DESKTOP_PLAYLIST_ID, input);
      return { ...result, ...this.listMusicDesktop() };
    },

    getMusicLibraryPreferences() {
      return {
        confirmSelectionClear: this.getSetting("musicLibrary.confirmSelectionClear") !== "0"
      };
    },

    updateMusicLibraryPreferences(input) {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw musicInputError("曲库偏好格式无效");
      }
      if (input.confirmSelectionClear != null) {
        this.setSetting("musicLibrary.confirmSelectionClear", input.confirmSelectionClear ? "1" : "0");
      }
      return this.getMusicLibraryPreferences();
    },

    getMusicLibrary() {
      return {
        playlists: this.listMusicPlaylists(),
        preferences: this.getMusicLibraryPreferences()
      };
    }
  };
  Object.defineProperties(
    MailDatabase.prototype,
    Object.fromEntries(Object.entries(methods).map(([name, value]) => [name, {
      configurable: true,
      writable: true,
      value
    }]))
  );
}
