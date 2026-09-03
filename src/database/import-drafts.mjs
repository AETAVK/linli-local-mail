import { normalizeImportedLetter } from "../history.mjs";
import {
  importDraftError,
  manualDraftToImportRecord,
  normalizeImportDraftId,
  normalizeImportDraftIds,
  normalizeImportDraftRevision,
  normalizeManualImportDraft
} from "../import-drafts.mjs";
import { nowSeconds, parseJson, randomId } from "../utils.mjs";

const ACTIVE_DRAFT_STATUSES = new Set(["ready", "error"]);

export function initializeImportDraftSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS import_drafts (
      draft_id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL DEFAULT 'manual-entry',
      status TEXT NOT NULL DEFAULT 'ready',
      payload_json TEXT NOT NULL,
      target_letter_id TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      imported_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_import_drafts_status_updated
      ON import_drafts(status, updated_at DESC);
  `);
}

export function prepareImportDraftStatements(db) {
  return {
    importDraftList: db.prepare(`
      SELECT * FROM import_drafts
      WHERE status IN ('ready', 'error')
      ORDER BY updated_at DESC, rowid DESC
    `),
    importDraftGet: db.prepare("SELECT * FROM import_drafts WHERE draft_id = ?"),
    importDraftInsert: db.prepare(`
      INSERT INTO import_drafts(
        draft_id, source_type, status, payload_json, target_letter_id,
        revision, last_error, created_at, updated_at, imported_at
      ) VALUES(?, 'manual-entry', 'ready', ?, NULL, 1, NULL, ?, ?, NULL)
    `),
    importDraftUpdate: db.prepare(`
      UPDATE import_drafts
      SET payload_json = ?, status = 'ready', revision = revision + 1,
          last_error = NULL, updated_at = ?
      WHERE draft_id = ? AND revision = ? AND status IN ('ready', 'error')
    `),
    importDraftDiscard: db.prepare(`
      UPDATE import_drafts
      SET status = 'discarded', revision = revision + 1, updated_at = ?
      WHERE draft_id = ? AND status IN ('ready', 'error')
    `),
    importDraftMarkImporting: db.prepare(`
      UPDATE import_drafts
      SET status = 'importing', last_error = NULL, updated_at = ?
      WHERE draft_id = ? AND revision = ? AND status IN ('ready', 'error')
    `),
    importDraftMarkImported: db.prepare(`
      UPDATE import_drafts
      SET status = 'imported', target_letter_id = ?, revision = revision + 1,
          last_error = NULL, updated_at = ?, imported_at = ?
      WHERE draft_id = ? AND status = 'importing'
    `),
    importDraftMarkError: db.prepare(`
      UPDATE import_drafts
      SET status = 'error', revision = revision + 1, last_error = ?, updated_at = ?
      WHERE draft_id = ? AND status NOT IN ('imported', 'discarded')
    `),
    importDraftCount: db.prepare(`
      SELECT COUNT(*) AS count FROM import_drafts WHERE status IN ('ready', 'error')
    `)
  };
}

function safeStoredPayload(row) {
  const parsed = parseJson(row.payload_json, null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      sent: { available: false, text: "", date: null, time: null, precision: null },
      reply: { available: false, text: "", date: null, time: null, precision: null }
    };
  }
  return parsed;
}

function draftRow(row) {
  if (!row) return null;
  const payload = safeStoredPayload(row);
  return {
    draftId: row.draft_id,
    sourceType: row.source_type,
    status: row.status,
    revision: Number(row.revision),
    sent: payload.sent,
    reply: payload.reply,
    targetLetterId: row.target_letter_id || null,
    lastError: row.last_error || null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    importedAt: row.imported_at == null ? null : Number(row.imported_at)
  };
}

function conflictForDraft(row, revision) {
  if (!row) throw importDraftError("找不到该待导入项", 404, "draft_not_found");
  if (!ACTIVE_DRAFT_STATUSES.has(row.status)) {
    throw importDraftError("该待导入项已经处理，不能再编辑", 409, "draft_not_editable");
  }
  if (Number(row.revision) !== revision) {
    throw importDraftError("待导入项已在其他操作中更新，请刷新后重试", 409, "draft_revision_conflict");
  }
  throw importDraftError("待导入项未能更新，请刷新后重试", 409, "draft_update_conflict");
}

export function installImportDraftDomain(MailDatabase) {
  const methods = {
    listImportDrafts() {
      return this.statements.importDraftList.all().map(draftRow);
    },

    getImportDraft(draftId) {
      return draftRow(this.statements.importDraftGet.get(normalizeImportDraftId(draftId)));
    },

    createImportDraft(input) {
      const payload = normalizeManualImportDraft(input);
      const draftId = randomId("import-draft");
      const timestamp = nowSeconds();
      this.statements.importDraftInsert.run(draftId, JSON.stringify(payload), timestamp, timestamp);
      return this.getImportDraft(draftId);
    },

    updateImportDraft(input) {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw importDraftError("待导入项更新格式无效");
      }
      const draftId = normalizeImportDraftId(input.draftId);
      const revision = normalizeImportDraftRevision(input.revision);
      const payload = normalizeManualImportDraft(input);
      const changed = this.statements.importDraftUpdate.run(
        JSON.stringify(payload),
        nowSeconds(),
        draftId,
        revision
      ).changes;
      if (!changed) conflictForDraft(this.statements.importDraftGet.get(draftId), revision);
      return this.getImportDraft(draftId);
    },

    deleteImportDrafts(input) {
      const draftIds = normalizeImportDraftIds(input);
      const timestamp = nowSeconds();
      let deleted = 0;
      const skipped = [];
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const draftId of draftIds) {
          if (this.statements.importDraftDiscard.run(timestamp, draftId).changes) deleted += 1;
          else skipped.push(draftId);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return { requested: draftIds.length, deleted, skipped };
    },

    commitOneImportDraft(draftId) {
      const normalizedId = normalizeImportDraftId(draftId);
      const initial = this.statements.importDraftGet.get(normalizedId);
      if (!initial) throw importDraftError("找不到该待导入项", 404, "draft_not_found");
      const existingLetterId = initial.target_letter_id || `manual-import-${normalizedId}`;
      if (initial.status === "imported") {
        return { draftId: normalizedId, ok: true, letterId: existingLetterId, action: "already-imported" };
      }
      if (initial.status === "discarded") {
        throw importDraftError("该待导入项已删除", 409, "draft_discarded");
      }

      try {
        const timestamp = nowSeconds();
        this.db.exec("BEGIN IMMEDIATE");
        try {
          const current = this.statements.importDraftGet.get(normalizedId);
          if (!current) throw importDraftError("找不到该待导入项", 404, "draft_not_found");
          if (current?.status === "imported") {
            this.db.exec("COMMIT");
            return {
              draftId: normalizedId,
              ok: true,
              letterId: current.target_letter_id || `manual-import-${normalizedId}`,
              action: "already-imported"
            };
          }
          if (current.status === "discarded") {
            throw importDraftError("该待导入项已删除", 409, "draft_discarded");
          }
          const payload = normalizeManualImportDraft(safeStoredPayload(current));
          const record = manualDraftToImportRecord(normalizedId, payload);
          const letter = normalizeImportedLetter(record, 0);
          if (payload.reply.available && !payload.reply.date) {
            // 普通历史 JSON 保持原有回退语义；只有文字录入明确选择“未知来信时间”时保留 NULL。
            letter.repliedAt = null;
            letter.repliedPrecision = null;
          }
          if (!this.statements.importDraftMarkImporting.run(
            timestamp,
            normalizedId,
            Number(current.revision)
          ).changes) {
            throw importDraftError("该待导入项当前不能导入", 409, "draft_not_ready");
          }
          const action = this.statements.letterExists.get(letter.letterId) ? "updated" : "inserted";
          this.writeLetter(this.statements.letterUpsert, letter);
          if (!this.statements.importDraftMarkImported.run(
            letter.letterId,
            timestamp,
            timestamp,
            normalizedId
          ).changes) {
            throw new Error("待导入项状态写入失败");
          }
          this.db.exec("COMMIT");
          return { draftId: normalizedId, ok: true, letterId: letter.letterId, action };
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.statements.importDraftMarkError.run(message.slice(0, 2000), nowSeconds(), normalizedId);
        throw error;
      }
    },

    commitImportDrafts(input) {
      const draftIds = normalizeImportDraftIds(input);
      const results = [];
      let imported = 0;
      let skipped = 0;
      for (const draftId of draftIds) {
        try {
          const result = this.commitOneImportDraft(draftId);
          results.push(result);
          if (result.action === "already-imported") skipped += 1;
          else imported += 1;
        } catch (error) {
          skipped += 1;
          results.push({
            draftId,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      return { requested: draftIds.length, imported, skipped, results };
    }
  };

  for (const [name, method] of Object.entries(methods)) {
    if (!MailDatabase.prototype[name]) MailDatabase.prototype[name] = method;
  }
}
