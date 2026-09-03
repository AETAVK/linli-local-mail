const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;
const DRAFT_ID_PATTERN = /^import-draft-[a-z0-9-]+$/i;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_DRAFTS_PER_REQUEST = 100;

export function importDraftError(message, status = 400, code = "invalid_import_draft") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function normalizeText(value, label) {
  const text = String(value ?? "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\u0000", "")
    .trim();
  if (!text) throw importDraftError(`${label}不能为空`);
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    throw importDraftError(`${label}不能超过 256 KiB`);
  }
  return text;
}

function normalizeDate(value, label, { required = false } = {}) {
  const text = String(value ?? "").trim();
  if (!text) {
    if (required) throw importDraftError(`${label}不能为空`);
    return null;
  }
  const match = DATE_PATTERN.exec(text);
  if (!match) throw importDraftError(`${label}必须使用 YYYY-MM-DD 格式`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const valueAtNoon = new Date(0);
  valueAtNoon.setFullYear(year, month - 1, day);
  valueAtNoon.setHours(12, 0, 0, 0);
  if (
    !Number.isFinite(valueAtNoon.getTime())
    || valueAtNoon.getFullYear() !== year
    || valueAtNoon.getMonth() !== month - 1
    || valueAtNoon.getDate() !== day
  ) {
    throw importDraftError(`${label}不是有效日期`);
  }
  return text;
}

function normalizeTime(value, label, { date } = {}) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (!date) throw importDraftError(`${label}填写时间前必须先填写日期`);
  const match = TIME_PATTERN.exec(text);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw importDraftError(`${label}必须使用有效的 HH:mm 格式`);
  }
  return text;
}

function normalizeSection(input, label, { dateRequired = false } = {}) {
  const section = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const available = section.available === true;
  if (!available) {
    return { available: false, text: "", date: null, time: null, precision: null };
  }
  const date = normalizeDate(section.date, `${label}日期`, { required: dateRequired });
  const time = normalizeTime(section.time, `${label}时间`, { date });
  return {
    available: true,
    text: normalizeText(section.text, `${label}正文`),
    date,
    time,
    precision: date ? (time ? "minute" : "date") : null
  };
}

export function manualSectionEpoch(section) {
  if (!section?.available || !section.date) return null;
  const match = DATE_PATTERN.exec(section.date);
  const timeMatch = section.time ? TIME_PATTERN.exec(section.time) : null;
  if (!match || (section.time && !timeMatch)) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = timeMatch ? Number(timeMatch[1]) : 12;
  const minute = timeMatch ? Number(timeMatch[2]) : 0;
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, 0, 0);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    || date.getHours() !== hour
    || date.getMinutes() !== minute
  ) {
    throw importDraftError("日期时间在当前时区中无效");
  }
  return Math.floor(date.getTime() / 1000);
}

function validateChronology(sent, reply) {
  if (!sent.available || !reply.available || !reply.date) return;
  if (reply.date < sent.date) throw importDraftError("来信日期不能早于去信日期");
  if (reply.date === sent.date && sent.time && reply.time && reply.time < sent.time) {
    throw importDraftError("来信时间不能早于去信时间");
  }
}

export function normalizeManualImportDraft(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw importDraftError("文字录入内容格式无效");
  }
  const rawSent = input.sent && typeof input.sent === "object" ? input.sent : {};
  const rawReply = input.reply && typeof input.reply === "object" ? input.reply : {};
  const sentAvailable = rawSent.available === true;
  const replyAvailable = rawReply.available === true;
  if (!sentAvailable && !replyAvailable) throw importDraftError("请至少录入去信或来信中的一项");

  const sent = normalizeSection(rawSent, "去信", { dateRequired: sentAvailable });
  const reply = normalizeSection(rawReply, "来信", {
    dateRequired: replyAvailable && !sentAvailable
  });
  validateChronology(sent, reply);
  return { sent, reply };
}

export function normalizeImportDraftId(value) {
  const draftId = String(value ?? "").trim();
  if (!DRAFT_ID_PATTERN.test(draftId) || draftId.length > 120) {
    throw importDraftError("待导入项编号无效");
  }
  return draftId;
}

export function normalizeImportDraftIds(input) {
  const raw = Array.isArray(input) ? input : [input];
  const result = [];
  const seen = new Set();
  for (const value of raw) {
    const id = normalizeImportDraftId(value);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  if (!result.length) throw importDraftError("请至少选择一项待导入信件");
  if (result.length > MAX_DRAFTS_PER_REQUEST) {
    throw importDraftError(`一次最多处理 ${MAX_DRAFTS_PER_REQUEST} 项待导入信件`);
  }
  return result;
}

export function normalizeImportDraftRevision(value) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw importDraftError("待导入项版本无效");
  }
  return revision;
}

export function manualDraftToImportRecord(draftId, payload) {
  const normalizedId = normalizeImportDraftId(draftId);
  const normalized = normalizeManualImportDraft(payload);
  const sentEpoch = manualSectionEpoch(normalized.sent);
  const replyEpoch = manualSectionEpoch(normalized.reply);
  const createdAt = normalized.sent.available ? sentEpoch : replyEpoch;
  const createdPrecision = normalized.sent.available
    ? normalized.sent.precision
    : normalized.reply.precision;
  return {
    letterId: `manual-import-${normalizedId}`,
    source: "manual-import",
    createdAt,
    createdPrecision,
    repliedAt: normalized.reply.available ? replyEpoch : null,
    repliedPrecision: normalized.reply.available ? normalized.reply.precision : null,
    isRead: 1,
    sent: {
      available: normalized.sent.available,
      text: normalized.sent.text,
      paragraphs: normalized.sent.text ? normalized.sent.text.split(/\n{2,}/) : [],
      date: normalized.sent.date,
      type: "text",
      videoUrl: null
    },
    reply: {
      available: normalized.reply.available,
      text: normalized.reply.text,
      paragraphs: normalized.reply.text ? normalized.reply.text.split(/\n{2,}/) : [],
      date: normalized.reply.date,
      type: "text",
      videoUrl: null
    },
    replyAiGenerated: false,
    ok: true,
    manualImport: {
      draftId: normalizedId,
      enteredAt: new Date().toISOString(),
      sentPrecision: normalized.sent.precision,
      replyPrecision: normalized.reply.precision
    }
  };
}
