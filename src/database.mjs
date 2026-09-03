import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AUDIT_STATUS,
  DAILY_LETTER_LIMIT,
  DEFAULT_MODEL_CONFIG,
  JOB_STATUS,
  LETTER_STATUS,
  REPLY_TYPE
} from "./constants.mjs";
import {
  importPayloadItems,
  normalizeImportedLetter,
  writeLetterArguments
} from "./history.mjs";
import {
  jsonOrNull,
  nowSeconds,
  parseJson,
  randomId
} from "./utils.mjs";
import {
  ensureMusicDesktopPlaylist,
  initializeMusicDatabaseSchema,
  installMusicDatabaseDomain,
  migrateMusicPlaylistPositions,
  MUSIC_DESKTOP_PLAYLIST_ID,
  MUSIC_DESKTOP_PLAYLIST_NAME,
  prepareMusicDatabaseStatements
} from "./database/music.mjs";
import {
  initializeImportDraftSchema,
  installImportDraftDomain,
  prepareImportDraftStatements
} from "./database/import-drafts.mjs";
import { VIDEO_ASSET_ID_PATTERN } from "./video-assets.mjs";

export { MUSIC_DESKTOP_PLAYLIST_ID, MUSIC_DESKTOP_PLAYLIST_NAME };

const LETTER_COLUMNS = `
  letter_id, content, material_json, letter_status, audit_status,
  reply_type, reply_text, reply_video_url, is_read, created_at,
  replied_at, ready_at_ms, source, raw_json, created_precision,
  replied_precision, generation_status, provider_id, model_id,
  last_error, updated_at
`;

const LETTER_VALUES = new Array(21).fill("?").join(", ");

function ensureColumn(db, table, name, definition) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

function normalizeDebugMode(value, fallback) {
  if (value == null) return Boolean(fallback);
  if (typeof value === "string") return value === "1" || value.toLowerCase() === "true";
  return Boolean(value);
}

function normalizeWidgetSetting(value, fallback) {
  if (value == null) return Boolean(fallback);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value !== 0 : Boolean(fallback);
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
    if (["0", "false", "no", "off", "disabled", ""].includes(normalized)) return false;
  }
  return Boolean(fallback);
}

export const DESKTOP_COMMAND_ROUTES = Object.freeze(["/collection", "/studio"]);
const DESKTOP_COMMAND_ROUTE_SET = new Set(DESKTOP_COMMAND_ROUTES);

function normalizeDesktopCommandRoute(value) {
  const route = String(value ?? "").trim();
  if (!DESKTOP_COMMAND_ROUTE_SET.has(route)) {
    const error = new Error("route must be /collection or /studio");
    error.status = 400;
    throw error;
  }
  return route;
}

function normalizeDesktopCommandId(value) {
  const commandId = String(value ?? "").trim();
  if (!commandId) {
    const error = new Error("commandId is required");
    error.status = 400;
    throw error;
  }
  return commandId;
}

function normalizeLetterIdList(input) {
  const raw = Array.isArray(input) ? input : [input];
  const ids = [];
  const seen = new Set();
  for (const value of raw) {
    const id = String(value ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (!ids.length) throw new Error("letterIds must contain at least one letter id");
  if (ids.length > 500) throw new Error("letterIds supports at most 500 letters per request");
  return ids;
}

function mediaAssetEntry(mediaAssets, letterId) {
  if (mediaAssets instanceof Map) {
    return { has: mediaAssets.has(letterId), value: mediaAssets.get(letterId) };
  }
  if (mediaAssets && typeof mediaAssets === "object"
    && Object.prototype.hasOwnProperty.call(mediaAssets, letterId)) {
    return { has: true, value: mediaAssets[letterId] };
  }
  return { has: false, value: undefined };
}

function normalizeVideoAsset(asset, letterId) {
  if (!asset || typeof asset !== "object") return null;
  const mediaId = String(asset.mediaId ?? asset.media_id ?? "").trim();
  if (!VIDEO_ASSET_ID_PATTERN.test(mediaId)) throw new Error("视频资产编号无效");
  const fileName = String(asset.fileName ?? asset.file_name ?? `${mediaId}.mp4`).trim();
  if (!fileName || fileName !== path.basename(fileName) || fileName.length > 180) {
    throw new Error("视频资产文件名无效");
  }
  const mimeType = String(asset.mimeType ?? asset.mime_type ?? "video/mp4").trim().toLowerCase();
  if (!mimeType.startsWith("video/")) throw new Error("视频资产 MIME 类型无效");
  const byteSize = Number(asset.byteSize ?? asset.byte_size);
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0) throw new Error("视频资产大小无效");
  const sha256 = String(asset.sha256 || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("视频资产校验和无效");
  const sourceUrl = String(asset.sourceUrl ?? asset.source_url ?? "").trim();
  return {
    mediaId,
    letterId,
    kind: "reply_video",
    fileName,
    mimeType,
    byteSize,
    sha256,
    sourceUrl
  };
}

function normalizeRuntimeSettings(input, current) {
  const replyDelayMs = Number(input.replyDelayMs ?? current.replyDelayMs);
  if (!Number.isFinite(replyDelayMs) || replyDelayMs < 0 || replyDelayMs > 600000) {
    throw new Error("replyDelayMs must be between 0 and 600000");
  }
  const nextDebugMode = normalizeDebugMode(input.debugMode, current.debugMode);
  let dailyLetterLimit = current.dailyLetterLimit;
  if (input.dailyLetterLimit != null) {
    const requested = Math.round(Number(input.dailyLetterLimit));
    if (!Number.isFinite(requested)) throw new Error("dailyLetterLimit must be a number");
    const clamped = Math.min(DAILY_LETTER_LIMIT.MAX, Math.max(DAILY_LETTER_LIMIT.MIN, requested));
    if (clamped !== current.dailyLetterLimit && !nextDebugMode) {
      throw new Error("每日写信上限只能在开启调试模式后调整");
    }
    dailyLetterLimit = clamped;
  }
  return {
    replyDelayMs: Math.floor(replyDelayMs),
    dailyLetterLimit,
    debugMode: nextDebugMode,
    mailWidget: normalizeWidgetSetting(input.mailWidget, current.mailWidget),
    musicWidget: normalizeWidgetSetting(input.musicWidget, current.musicWidget)
  };
}

export class MailDatabase {
  constructor(dbPath, legacyJsonPath) {
    this.dbPath = dbPath;
    this.legacyJsonPath = legacyJsonPath;
    this.db = new DatabaseSync(dbPath);
    this.initialize();
    this.prepare();
    this.migratedLegacyLetters = this.migrateLegacyJson();
    this.recoveredJobs = this.recoverInterruptedJobs();
  }

  initialize() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS letters (
        letter_id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        material_json TEXT,
        letter_status INTEGER NOT NULL,
        audit_status INTEGER NOT NULL,
        reply_type INTEGER NOT NULL,
        reply_text TEXT NOT NULL DEFAULT '',
        reply_video_url TEXT NOT NULL DEFAULT '',
        is_read INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        replied_at INTEGER,
        ready_at_ms INTEGER,
        source TEXT NOT NULL DEFAULT 'local',
        raw_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_letters_created_at
        ON letters(created_at DESC);

      CREATE TABLE IF NOT EXISTS letter_media (
        media_id TEXT PRIMARY KEY,
        letter_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        source_url TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        UNIQUE(letter_id, kind),
        FOREIGN KEY(letter_id) REFERENCES letters(letter_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_letter_media_letter
        ON letter_media(letter_id, kind);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS desktop_commands (
        slot INTEGER PRIMARY KEY CHECK (slot = 1),
        command_id TEXT NOT NULL UNIQUE,
        route TEXT NOT NULL CHECK (route IN ('/collection', '/studio')),
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS generation_jobs (
        job_id TEXT PRIMARY KEY,
        letter_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        scheduled_at_ms INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        provider_id TEXT,
        model_id TEXT,
        request_json TEXT,
        response_json TEXT,
        usage_json TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(letter_id) REFERENCES letters(letter_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_generation_jobs_queue
        ON generation_jobs(status, scheduled_at_ms, created_at);

      CREATE INDEX IF NOT EXISTS idx_generation_jobs_letter
        ON generation_jobs(letter_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS memories (
        memory_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'curated',
        content TEXT NOT NULL,
        source_letter_id TEXT,
        confidence REAL NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(source_letter_id) REFERENCES letters(letter_id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memories_status
        ON memories(status, updated_at DESC);
    `);

    initializeMusicDatabaseSchema(this.db);
    initializeImportDraftSchema(this.db);

    ensureColumn(this.db, "letters", "created_precision", "TEXT NOT NULL DEFAULT 'second'");
    ensureColumn(this.db, "letters", "replied_precision", "TEXT");
    ensureColumn(this.db, "letters", "generation_status", "TEXT NOT NULL DEFAULT 'none'");
    ensureColumn(this.db, "letters", "provider_id", "TEXT");
    ensureColumn(this.db, "letters", "model_id", "TEXT");
    ensureColumn(this.db, "letters", "last_error", "TEXT");
    ensureColumn(this.db, "letters", "updated_at", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(this.db, "music_playlist_items", "position", "INTEGER");
    migrateMusicPlaylistPositions(this.db);
    ensureMusicDesktopPlaylist(this.db);

    const insertSetting = this.db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)");
    insertSetting.run("reply_delay_ms", "5000");
    insertSetting.run("daily_letter_limit", String(DAILY_LETTER_LIMIT.DEFAULT));
    insertSetting.run("model_config_json", JSON.stringify(DEFAULT_MODEL_CONFIG));
    insertSetting.run("legacy_json_migrated", "0");
    insertSetting.run("debug_mode", "0");
    insertSetting.run("mail_widget", "1");
    insertSetting.run("music_widget", "1");
    insertSetting.run("remoteImport.promptDisabled", "0");
    insertSetting.run("remoteImport.snoozedUntil", "0");
    insertSetting.run("remoteImport.lastSuccessAt", "");
    insertSetting.run("remoteImport.lastImportedAccount", "");
    insertSetting.run("remoteImport.lastImportedIdsHash", "");
    insertSetting.run("musicLibrary.confirmSelectionClear", "1");
    this.db.exec("PRAGMA user_version = 6");
  }

  prepare() {
    this.statements = {
      settingGet: this.db.prepare("SELECT value FROM settings WHERE key = ?"),
      settingSet: this.db.prepare(`
        INSERT INTO settings(key, value) VALUES(?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `),
      desktopCommandGet: this.db.prepare(`
        SELECT command_id AS commandId, route, created_at AS createdAt
        FROM desktop_commands
        WHERE slot = 1
      `),
      desktopCommandUpsert: this.db.prepare(`
        INSERT INTO desktop_commands(slot, command_id, route, created_at)
        VALUES(1, ?, ?, ?)
        ON CONFLICT(slot) DO UPDATE SET
          command_id = excluded.command_id,
          route = excluded.route,
          created_at = excluded.created_at
      `),
      desktopCommandAck: this.db.prepare(
        "DELETE FROM desktop_commands WHERE slot = 1 AND command_id = ?"
      ),
      letterInsert: this.db.prepare(`INSERT OR IGNORE INTO letters(${LETTER_COLUMNS}) VALUES(${LETTER_VALUES})`),
      letterUpsert: this.db.prepare(`
        INSERT INTO letters(${LETTER_COLUMNS}) VALUES(${LETTER_VALUES})
        ON CONFLICT(letter_id) DO UPDATE SET
          content = excluded.content,
          material_json = excluded.material_json,
          letter_status = excluded.letter_status,
          audit_status = excluded.audit_status,
          reply_type = excluded.reply_type,
          reply_text = excluded.reply_text,
          reply_video_url = excluded.reply_video_url,
          is_read = excluded.is_read,
          created_at = excluded.created_at,
          replied_at = excluded.replied_at,
          ready_at_ms = excluded.ready_at_ms,
          source = excluded.source,
          raw_json = excluded.raw_json,
          created_precision = excluded.created_precision,
          replied_precision = excluded.replied_precision,
          generation_status = excluded.generation_status,
          provider_id = excluded.provider_id,
          model_id = excluded.model_id,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at
      `),
      letterExists: this.db.prepare("SELECT 1 AS found FROM letters WHERE letter_id = ?"),
      letterGet: this.db.prepare("SELECT * FROM letters WHERE letter_id = ?"),
      letterRead: this.db.prepare("UPDATE letters SET is_read = 1, updated_at = ? WHERE letter_id = ?"),
      mediaByLetter: this.db.prepare(`
        SELECT media_id, letter_id, kind, file_name, mime_type, byte_size, sha256, source_url, created_at
        FROM letter_media WHERE letter_id = ? AND kind = 'reply_video'
      `),
      mediaById: this.db.prepare(`
        SELECT media_id, letter_id, kind, file_name, mime_type, byte_size, sha256, source_url, created_at
        FROM letter_media WHERE media_id = ?
      `),
      mediaUpsert: this.db.prepare(`
        INSERT INTO letter_media(
          media_id, letter_id, kind, file_name, mime_type, byte_size, sha256, source_url, created_at
        ) VALUES(?, ?, 'reply_video', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(letter_id, kind) DO UPDATE SET
          media_id = excluded.media_id,
          file_name = excluded.file_name,
          mime_type = excluded.mime_type,
          byte_size = excluded.byte_size,
          sha256 = excluded.sha256,
          source_url = excluded.source_url,
          created_at = excluded.created_at
      `),
      mediaDeleteByLetter: this.db.prepare("DELETE FROM letter_media WHERE letter_id = ? AND kind = 'reply_video'"),
      mediaCount: this.db.prepare("SELECT COUNT(*) AS count FROM letter_media"),
      unreadCount: this.db.prepare("SELECT COUNT(*) AS count FROM letters WHERE is_read = 0"),
      letterCount: this.db.prepare("SELECT COUNT(*) AS count FROM letters"),
      lettersSentToday: this.db.prepare("SELECT COUNT(*) AS count FROM letters WHERE source = 'local' AND created_at >= ?"),
      importedOfficialCount: this.db.prepare("SELECT COUNT(*) AS count FROM letters WHERE source != 'local' AND raw_json IS NOT NULL AND json_extract(raw_json, '$.letterId') IS NOT NULL"),
      queuedJob: this.db.prepare(`
        SELECT * FROM generation_jobs
        WHERE status = ? AND scheduled_at_ms <= ?
        ORDER BY scheduled_at_ms ASC, created_at ASC
        LIMIT 1
      `),
      jobInsert: this.db.prepare(`
        INSERT INTO generation_jobs(
          job_id, letter_id, status, attempt, scheduled_at_ms,
          started_at, finished_at, provider_id, model_id,
          request_json, response_json, usage_json, error,
          created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
      `),
      jobGet: this.db.prepare("SELECT * FROM generation_jobs WHERE job_id = ?"),
      activeMemories: this.db.prepare(`
        SELECT memory_id AS memoryId, kind, content,
               source_letter_id AS sourceLetterId, confidence,
               status, created_at AS createdAt, updated_at AS updatedAt
        FROM memories WHERE status = 'active'
        ORDER BY updated_at DESC
      `)
    };
    Object.assign(this.statements, prepareMusicDatabaseStatements(this.db));
    Object.assign(this.statements, prepareImportDraftStatements(this.db));
  }

  close() {
    this.db.close();
  }

  getSetting(key) {
    return this.statements.settingGet.get(key)?.value;
  }

  setSetting(key, value) {
    this.statements.settingSet.run(key, String(value));
  }

  getRuntimeSettings() {
    const storedLimit = Number(this.getSetting("daily_letter_limit"));
    const dailyLetterLimit = Number.isFinite(storedLimit)
      ? Math.min(DAILY_LETTER_LIMIT.MAX, Math.max(DAILY_LETTER_LIMIT.MIN, Math.round(storedLimit)))
      : DAILY_LETTER_LIMIT.DEFAULT;
    return {
      replyDelayMs: Number(this.getSetting("reply_delay_ms") || 5000),
      dailyLetterLimit,
      debugMode: this.getSetting("debug_mode") === "1",
      mailWidget: normalizeWidgetSetting(this.getSetting("mail_widget"), true),
      musicWidget: normalizeWidgetSetting(this.getSetting("music_widget"), true)
    };
  }

  updateRuntimeSettings(input) {
    const next = normalizeRuntimeSettings(input || {}, this.getRuntimeSettings());
    this.setSetting("reply_delay_ms", next.replyDelayMs);
    this.setSetting("daily_letter_limit", next.dailyLetterLimit);
    this.setSetting("debug_mode", next.debugMode ? "1" : "0");
    this.setSetting("mail_widget", next.mailWidget ? "1" : "0");
    this.setSetting("music_widget", next.musicWidget ? "1" : "0");
    return this.getRuntimeSettings();
  }

  enqueueDesktopCommand(route) {
    const normalizedRoute = normalizeDesktopCommandRoute(route);
    const commandId = randomId("desktop-command");
    const createdAt = Date.now();
    this.statements.desktopCommandUpsert.run(commandId, normalizedRoute, createdAt);
    return this.getPendingDesktopCommand();
  }

  getPendingDesktopCommand() {
    return this.statements.desktopCommandGet.get() || null;
  }

  getDesktopCommand() {
    return this.getPendingDesktopCommand();
  }

  ackDesktopCommand(commandId) {
    const normalizedCommandId = normalizeDesktopCommandId(commandId);
    return Boolean(this.statements.desktopCommandAck.run(normalizedCommandId).changes);
  }

  lettersSentToday() {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    return this.statements.lettersSentToday.get(Math.floor(startOfToday.getTime() / 1000)).count;
  }

  // 已导入到本地的"官方信件"数量：导入路径会把官方 letterId 保存在 raw_json，
  // 本地写信（source='local'）没有这个字段。用于官方历史提示判断"这批信是否已在本地"。
  importedOfficialCount() {
    return this.statements.importedOfficialCount.get().count;
  }

  remainingSendQuota() {
    return Math.max(0, this.getRuntimeSettings().dailyLetterLimit - this.lettersSentToday());
  }

  assertSendQuota() {
    const used = this.lettersSentToday();
    const limit = this.getRuntimeSettings().dailyLetterLimit;
    if (used >= limit) {
      const error = new Error(`今日写信次数已用完（${used}/${limit}），明天再给林离写信吧。`);
      error.status = 429;
      throw error;
    }
  }

  writeLetter(statement, letter) {
    return statement.run(...writeLetterArguments(letter));
  }

  migrateLegacyJson() {
    if (this.getSetting("legacy_json_migrated") === "1") return 0;
    let imported = 0;
    if (fs.existsSync(this.legacyJsonPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.legacyJsonPath, "utf8"));
        const items = Array.isArray(parsed) ? parsed : parsed.letters;
        if (Array.isArray(items)) {
          items.forEach((item, index) => {
            const letter = normalizeImportedLetter({ ...item, source: item.source ?? "legacy-json" }, index);
            imported += Number(this.writeLetter(this.statements.letterInsert, letter).changes || 0);
          });
        }
      } catch (error) {
        console.warn(`Legacy JSON migration skipped: ${error.message}`);
      }
    }
    this.setSetting("legacy_json_migrated", "1");
    return imported;
  }

  recoverInterruptedJobs() {
    const now = nowSeconds();
    const jobs = this.db.prepare("SELECT job_id, letter_id FROM generation_jobs WHERE status = ?").all(JOB_STATUS.RUNNING);
    if (!jobs.length) return 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const resetJob = this.db.prepare(`
        UPDATE generation_jobs
        SET status = ?, scheduled_at_ms = ?, started_at = NULL,
            error = 'recovered after service restart', updated_at = ?
        WHERE job_id = ?
      `);
      const resetLetter = this.db.prepare(`
        UPDATE letters
        SET letter_status = ?, audit_status = ?, generation_status = 'queued',
            last_error = NULL, updated_at = ?
        WHERE letter_id = ?
      `);
      for (const job of jobs) {
        resetJob.run(JOB_STATUS.QUEUED, Date.now(), now, job.job_id);
        resetLetter.run(LETTER_STATUS.PENDING, AUDIT_STATUS.PENDING, now, job.letter_id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return jobs.length;
  }

  toVideoAsset(row) {
    if (!row) return null;
    return {
      mediaId: row.media_id,
      letterId: row.letter_id,
      kind: row.kind,
      fileName: row.file_name,
      mimeType: row.mime_type,
      byteSize: row.byte_size,
      sha256: row.sha256,
      sourceUrl: row.source_url || "",
      createdAt: row.created_at
    };
  }

  getVideoAsset(letterId) {
    return this.toVideoAsset(this.statements.mediaByLetter.get(String(letterId || "")));
  }

  getVideoAssetById(mediaId) {
    return this.toVideoAsset(this.statements.mediaById.get(String(mediaId || "")));
  }

  replaceVideoAsset(letterId, asset) {
    const id = String(letterId || "");
    const previous = this.getVideoAsset(id);
    if (!asset) {
      this.statements.mediaDeleteByLetter.run(id);
      return previous?.mediaId && previous.mediaId !== asset?.mediaId ? previous.mediaId : null;
    }
    const normalized = normalizeVideoAsset(asset, id);
    this.statements.mediaUpsert.run(
      normalized.mediaId,
      id,
      normalized.fileName,
      normalized.mimeType,
      normalized.byteSize,
      normalized.sha256,
      normalized.sourceUrl,
      nowSeconds()
    );
    return previous?.mediaId && previous.mediaId !== normalized.mediaId ? previous.mediaId : null;
  }

  rowToLetter(row, { includeInternal = false } = {}) {
    const letter = {
      letterId: row.letter_id,
      content: row.content,
      material: parseJson(row.material_json, null),
      letterStatus: row.letter_status,
      auditStatus: row.audit_status,
      replyType: row.reply_type,
      replyText: row.reply_text,
      replyVideoUrl: row.reply_video_url,
      isRead: row.is_read,
      createdAt: row.created_at,
      repliedAt: row.replied_at ?? undefined,
      source: row.source
    };
    if (includeInternal) {
      Object.assign(letter, {
        createdPrecision: row.created_precision,
        repliedPrecision: row.replied_precision,
        generationStatus: row.generation_status,
        providerId: row.provider_id,
        modelId: row.model_id,
        lastError: row.last_error,
        raw: parseJson(row.raw_json, null),
        updatedAt: row.updated_at,
        replyVideoAsset: this.getVideoAsset(row.letter_id)
      });
    }
    return letter;
  }

  toListItem(row) {
    const summarySource = row.content || row.reply_text || "历史回信";
    return {
      letterId: row.letter_id,
      summary: summarySource.length > 20 ? `${summarySource.slice(0, 20)}...` : summarySource,
      letterStatus: row.letter_status,
      auditStatus: row.audit_status,
      replyType: row.reply_type,
      isRead: row.is_read,
      createdAt: row.created_at,
      repliedAt: row.replied_at ?? undefined
    };
  }

  importLetters(body, { mediaAssets = null } = {}) {
    const items = importPayloadItems(body);
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    const removedMediaIds = [];
    const errors = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      items.forEach((item, index) => {
        try {
          if (item?.ok === false) throw new Error(String(item.error || "JSON item is marked ok=false"));
          const letter = normalizeImportedLetter(item, index);
          const mediaEntry = mediaAssetEntry(mediaAssets, letter.letterId);
          const mediaAsset = mediaEntry.has ? normalizeVideoAsset(mediaEntry.value, letter.letterId) : undefined;
          const exists = Boolean(this.statements.letterExists.get(letter.letterId));
          this.writeLetter(this.statements.letterUpsert, letter);
          if (mediaEntry.has) {
            const removedMediaId = this.replaceVideoAsset(letter.letterId, mediaAsset);
            if (removedMediaId) removedMediaIds.push(removedMediaId);
          }
          if (exists) updated += 1;
          else inserted += 1;
        } catch (error) {
          skipped += 1;
          errors.push({
            index,
            fileName: item?.fileName ?? null,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { imported: inserted + updated, inserted, updated, skipped, removedMediaIds, errors };
  }

  // 远端历史导入：只新增不存在的记录；已存在且来源为远端导入的记录允许更新
  // （重复导入幂等、新回信补全）；已存在但来源不是远端导入的记录视为本地内容，
  // 保留不动并报告 conflict，绝不由远端同步静默覆盖。
  importRemoteLetters(records, { mediaAssets = null } = {}) {
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let conflicts = 0;
    const importedIds = [];
    const removedMediaIds = [];
    const errors = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      records.forEach((record, index) => {
        try {
          if (record?.ok === false) throw new Error(String(record.error || "Remote letter is marked ok=false"));
          const letter = normalizeImportedLetter(record, index, { keepUnknownTime: true });
          const mediaEntry = mediaAssetEntry(mediaAssets, letter.letterId);
          const mediaAsset = mediaEntry.has ? normalizeVideoAsset(mediaEntry.value, letter.letterId) : undefined;
          const existing = this.statements.letterGet.get(letter.letterId);
          if (!existing) {
            this.writeLetter(this.statements.letterInsert, letter);
            if (mediaEntry.has) {
              const removedMediaId = this.replaceVideoAsset(letter.letterId, mediaAsset);
              if (removedMediaId) removedMediaIds.push(removedMediaId);
            }
            inserted += 1;
            importedIds.push(letter.letterId);
          } else if (existing.source === "remote-history") {
            this.writeLetter(this.statements.letterUpsert, letter);
            if (mediaEntry.has) {
              const removedMediaId = this.replaceVideoAsset(letter.letterId, mediaAsset);
              if (removedMediaId) removedMediaIds.push(removedMediaId);
            }
            updated += 1;
            importedIds.push(letter.letterId);
          } else {
            conflicts += 1;
          }
        } catch (error) {
          skipped += 1;
          errors.push({
            index,
            fileName: record?.fileName ?? null,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      imported: inserted + updated,
      inserted,
      updated,
      skipped,
      conflicts,
      importedIds,
      removedMediaIds,
      errors
    };
  }

  getRemoteImportSettings() {
    return {
      promptDisabled: this.getSetting("remoteImport.promptDisabled") === "1",
      snoozedUntil: Number(this.getSetting("remoteImport.snoozedUntil") || 0),
      lastSuccessAt: this.getSetting("remoteImport.lastSuccessAt") || null,
      lastImportedAccount: this.getSetting("remoteImport.lastImportedAccount") || null,
      lastImportedIdsHash: this.getSetting("remoteImport.lastImportedIdsHash") || null
    };
  }

  updateRemoteImportPrompt(action) {
    const timestamp = nowSeconds();
    if (action === "snooze") {
      this.setSetting("remoteImport.promptDisabled", "0");
      this.setSetting("remoteImport.snoozedUntil", String(timestamp + 6 * 3600));
    } else if (action === "disable") {
      this.setSetting("remoteImport.promptDisabled", "1");
      this.setSetting("remoteImport.snoozedUntil", "0");
    } else if (action === "enable") {
      this.setSetting("remoteImport.promptDisabled", "0");
      this.setSetting("remoteImport.snoozedUntil", "0");
      this.setSetting("remoteImport.lastImportedAccount", "");
      this.setSetting("remoteImport.lastImportedIdsHash", "");
    }
    return this.getRemoteImportSettings();
  }

  markRemoteImportSuccess({ account, idsHash }) {
    this.setSetting("remoteImport.lastSuccessAt", new Date().toISOString());
    this.setSetting("remoteImport.lastImportedAccount", String(account || ""));
    this.setSetting("remoteImport.lastImportedIdsHash", String(idsHash || ""));
  }

  createLetter(content, material, raw, delayMs) {
    const timestamp = nowSeconds();
    const letterId = randomId("local");
    const jobId = randomId("job");
    const scheduledAt = Date.now() + delayMs;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.writeLetter(this.statements.letterInsert, {
        letterId,
        content,
        material,
        letterStatus: LETTER_STATUS.PENDING,
        auditStatus: AUDIT_STATUS.PENDING,
        replyType: REPLY_TYPE.NONE,
        replyText: "",
        replyVideoUrl: "",
        isRead: 1,
        createdAt: timestamp,
        createdPrecision: "second",
        repliedAt: null,
        repliedPrecision: null,
        readyAtMs: scheduledAt,
        source: "local",
        raw,
        generationStatus: JOB_STATUS.QUEUED,
        providerId: null,
        modelId: null,
        lastError: null
      });
      this.statements.jobInsert.run(
        jobId,
        letterId,
        JOB_STATUS.QUEUED,
        0,
        scheduledAt,
        timestamp,
        timestamp
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { letterId, jobId };
  }

  listLetters({ cursor = 0, pageSize = 20 } = {}) {
    const offset = Math.max(0, Math.floor(Number(cursor) || 0));
    const size = Math.min(100, Math.max(1, Math.floor(Number(pageSize) || 20)));
    const total = this.statements.letterCount.get().count;
    const rows = this.db.prepare(`
      SELECT * FROM letters
      ORDER BY created_at DESC, rowid DESC
      LIMIT ? OFFSET ?
    `).all(size, offset);
    const nextCursor = offset + rows.length;
    return {
      list: rows.map((row) => this.toListItem(row)),
      total,
      remainingToday: this.remainingSendQuota(),
      hasMore: nextCursor < total,
      nextCursor: nextCursor < total ? nextCursor : 0
    };
  }

  getLetter(letterId, { markRead = false, includeInternal = false } = {}) {
    const row = this.statements.letterGet.get(letterId);
    if (!row) return null;
    if (markRead && row.is_read === 0) {
      this.statements.letterRead.run(nowSeconds(), letterId);
      row.is_read = 1;
    }
    return this.rowToLetter(row, { includeInternal });
  }

  unreadCount() {
    return this.statements.unreadCount.get().count;
  }

  claimNextJob() {
    const row = this.statements.queuedJob.get(JOB_STATUS.QUEUED, Date.now());
    if (!row) return null;
    const timestamp = nowSeconds();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db.prepare(`
        UPDATE generation_jobs
        SET status = ?, attempt = attempt + 1, started_at = ?,
            error = NULL, updated_at = ?
        WHERE job_id = ? AND status = ?
      `).run(JOB_STATUS.RUNNING, timestamp, timestamp, row.job_id, JOB_STATUS.QUEUED).changes;
      if (!changed) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.db.prepare(`
        UPDATE letters
        SET letter_status = ?, audit_status = ?, generation_status = ?,
            ready_at_ms = NULL, last_error = NULL, updated_at = ?
        WHERE letter_id = ?
      `).run(
        LETTER_STATUS.LLM_PROCESSING,
        AUDIT_STATUS.PASSED,
        JOB_STATUS.RUNNING,
        timestamp,
        row.letter_id
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.statements.jobGet.get(row.job_id);
  }

  attachJobRequest(jobId, { providerId = null, modelId = null, request = null } = {}) {
    this.db.prepare(`
      UPDATE generation_jobs
      SET provider_id = ?, model_id = ?, request_json = ?, updated_at = ?
      WHERE job_id = ?
    `).run(providerId, modelId, jsonOrNull(request), nowSeconds(), jobId);
  }

  completeJob(job, result) {
    const timestamp = nowSeconds();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        UPDATE letters
        SET letter_status = ?, audit_status = ?, reply_type = ?,
            reply_text = ?, reply_video_url = '', replied_at = ?,
            replied_precision = 'second', is_read = 0,
            generation_status = ?, provider_id = ?, model_id = ?,
            last_error = NULL, updated_at = ?
        WHERE letter_id = ?
      `).run(
        LETTER_STATUS.REPLIED,
        AUDIT_STATUS.PASSED,
        REPLY_TYPE.TEXT,
        result.body,
        timestamp,
        JOB_STATUS.COMPLETED,
        result.providerId ?? null,
        result.modelId ?? null,
        timestamp,
        job.letter_id
      );
      this.db.prepare(`
        UPDATE generation_jobs
        SET status = ?, provider_id = ?, model_id = ?, response_json = ?,
            usage_json = ?, error = NULL, finished_at = ?, updated_at = ?
        WHERE job_id = ?
      `).run(
        JOB_STATUS.COMPLETED,
        result.providerId ?? null,
        result.modelId ?? null,
        jsonOrNull(result.response),
        jsonOrNull(result.usage),
        timestamp,
        timestamp,
        job.job_id
      );
      this.statements.mediaDeleteByLetter.run(job.letter_id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  failJob(job, error) {
    const timestamp = nowSeconds();
    const message = String(error || "generation failed").slice(0, 4000);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        UPDATE letters
        SET letter_status = ?, audit_status = ?, reply_type = ?,
            reply_text = '', generation_status = ?, last_error = ?,
            updated_at = ?
        WHERE letter_id = ?
      `).run(
        LETTER_STATUS.FAILED,
        AUDIT_STATUS.PASSED,
        REPLY_TYPE.NONE,
        JOB_STATUS.FAILED,
        message,
        timestamp,
        job.letter_id
      );
      this.db.prepare(`
        UPDATE generation_jobs
        SET status = ?, error = ?, finished_at = ?, updated_at = ?
        WHERE job_id = ?
      `).run(JOB_STATUS.FAILED, message, timestamp, timestamp, job.job_id);
      this.statements.mediaDeleteByLetter.run(job.letter_id);
      this.db.exec("COMMIT");
    } catch (failure) {
      this.db.exec("ROLLBACK");
      throw failure;
    }
  }

  retryLetter(letterId, delayMs) {
    const row = this.statements.letterGet.get(letterId);
    if (!row) return null;
    const timestamp = nowSeconds();
    const jobId = randomId("job");
    const scheduledAt = Date.now() + delayMs;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        UPDATE letters
        SET letter_status = ?, audit_status = ?, reply_type = ?,
            reply_text = '', reply_video_url = '', replied_at = NULL,
            replied_precision = NULL, ready_at_ms = ?, is_read = 1,
            generation_status = ?, provider_id = NULL, model_id = NULL,
            last_error = NULL, updated_at = ?
        WHERE letter_id = ?
      `).run(
        LETTER_STATUS.PENDING,
        AUDIT_STATUS.PENDING,
        REPLY_TYPE.NONE,
        scheduledAt,
        JOB_STATUS.QUEUED,
        timestamp,
        letterId
      );
      this.statements.jobInsert.run(
        jobId,
        letterId,
        JOB_STATUS.QUEUED,
        0,
        scheduledAt,
        timestamp,
        timestamp
      );
      this.statements.mediaDeleteByLetter.run(letterId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { letterId, jobId };
  }

  // 全部已完成并成功保存的通信事件，按真实时间从旧到新。
  // 不在 SQL 层固定截断：上下文预算选择器需要看到最新事件、关系起点和可被当前来信引用的旧事件；
  // 真正进入模型的数量由 orchestrator 根据模型容量和历史策略决定。
  // 常规信件一行 = 一次完整通信（去信 + 回信）；停服告别信等主动来信 content 为空、reply_text 为正文，
  // 由时间线构建器作为独立 assistant 事件处理。生成失败的信（letter_status <> REPLIED）不会进入这里。
  historyRows(excludedLetterId) {
    return this.db.prepare(`
      SELECT * FROM letters
      WHERE letter_id <> ? AND letter_status = ? AND reply_type <> ?
        AND (content <> '' OR reply_text <> '')
      ORDER BY created_at ASC, rowid ASC
    `).all(excludedLetterId, LETTER_STATUS.REPLIED, REPLY_TYPE.NONE);
  }

  activeMemories() {
    return this.statements.activeMemories.all();
  }

  upsertMemory(input) {
    const memoryId = String(input.memoryId || randomId("memory"));
    const content = String(input.content || "").trim();
    if (!content) throw new Error("Memory content cannot be empty");
    const kind = String(input.kind || "curated");
    const confidence = Math.max(0, Math.min(1, Number(input.confidence ?? 1)));
    const status = input.status === "inactive" ? "inactive" : "active";
    const timestamp = nowSeconds();
    this.db.prepare(`
      INSERT INTO memories(memory_id, kind, content, source_letter_id, confidence, status, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET
        kind = excluded.kind,
        content = excluded.content,
        source_letter_id = excluded.source_letter_id,
        confidence = excluded.confidence,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(
      memoryId,
      kind,
      content,
      input.sourceLetterId || null,
      confidence,
      status,
      timestamp,
      timestamp
    );
    return this.activeMemories().find((memory) => memory.memoryId === memoryId)
      || { memoryId, kind, content, confidence, status };
  }

  health() {
    const jobs = Object.fromEntries(
      this.db.prepare("SELECT status, COUNT(*) AS count FROM generation_jobs GROUP BY status")
        .all()
        .map((row) => [row.status, row.count])
    );
    return {
      database: this.dbPath,
      letters: this.statements.letterCount.get().count,
      importDrafts: this.statements.importDraftCount.get().count,
      videoAssets: this.statements.mediaCount.get().count,
      jobs,
      settings: this.getRuntimeSettings(),
      migratedLegacyLetters: this.migratedLegacyLetters,
      recoveredJobs: this.recoveredJobs,
      integrity: this.db.prepare("PRAGMA quick_check").get().quick_check
    };
  }

  exportLetters(input) {
    const ids = normalizeLetterIdList(input);
    const letters = [];
    const missing = [];
    for (const id of ids) {
      const row = this.statements.letterGet.get(id);
      if (row) letters.push(this.rowToLetter(row, { includeInternal: true }));
      else missing.push(id);
    }
    return {
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      requested: ids.length,
      exported: letters.length,
      missing,
      letters
    };
  }

  deleteLetters(input, { includeMediaIds = false } = {}) {
    const ids = normalizeLetterIdList(input);
    const statement = this.db.prepare("DELETE FROM letters WHERE letter_id = ?");
    let deleted = 0;
    const missing = [];
    const mediaIds = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of ids) {
        const media = this.getVideoAsset(id);
        if (statement.run(id).changes) {
          deleted += 1;
          if (media?.mediaId) mediaIds.push(media.mediaId);
        } else missing.push(id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return includeMediaIds
      ? { requested: ids.length, deleted, missing, mediaIds }
      : { requested: ids.length, deleted, missing };
  }

  exportData() {
    const letters = this.db.prepare("SELECT * FROM letters ORDER BY created_at ASC, rowid ASC").all();
    const memories = this.activeMemories();
    const modelConfig = parseJson(this.getSetting("model_config_json"), DEFAULT_MODEL_CONFIG);
    return {
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      letters: letters.map((row) => this.rowToLetter(row, { includeInternal: true })),
      memories,
      settings: {
        ...this.getRuntimeSettings(),
        modelConfig
      }
    };
  }
}

installMusicDatabaseDomain(MailDatabase);
installImportDraftDomain(MailDatabase);
