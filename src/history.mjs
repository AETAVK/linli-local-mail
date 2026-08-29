import { AUDIT_STATUS, LETTER_STATUS, REPLY_TYPE } from "./constants.mjs";
import { jsonOrNull, nowSeconds } from "./utils.mjs";

function normalizeEpochSeconds(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return number > 10_000_000_000 ? Math.floor(number / 1000) : Math.floor(number);
}

export function normalizeDateTime(value, fallback) {
  if (typeof value === "number" || /^\d{10,13}$/.test(String(value || "").trim())) {
    return { epoch: normalizeEpochSeconds(value, fallback), precision: "second" };
  }
  const match = String(value || "").trim().match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (!match) return { epoch: fallback, precision: "unknown" };
  const [, year, month, day, hour, minute, second] = match;
  const hasTime = hour != null;
  const hasSecond = second != null;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    hasTime ? Number(hour) : 12,
    hasTime ? Number(minute) : 0,
    hasSecond ? Number(second) : 0
  );
  const epoch = Math.floor(date.getTime() / 1000);
  return {
    epoch: Number.isFinite(epoch) && epoch > 0 ? epoch : fallback,
    precision: hasSecond ? "second" : hasTime ? "minute" : "date"
  };
}

export function importedSectionText(section) {
  if (!section || typeof section !== "object" || section.available === false) return "";
  const direct = section.text ?? section.content;
  if (direct != null && String(direct).trim()) return String(direct).trim();
  return Array.isArray(section.paragraphs)
    ? section.paragraphs.map((paragraph) => String(paragraph).trim()).filter(Boolean).join("\n\n")
    : "";
}

export function importedLetterId(item, index) {
  if (item.letterId != null || item.id != null) return String(item.letterId ?? item.id);
  if (item.shareId) return `history-${String(item.uid || "unknown")}-${String(item.shareId)}`;
  if (item.fileName) {
    const safeName = String(item.fileName).replace(/[^a-zA-Z0-9._-]+/g, "-");
    return `history-file-${safeName}`;
  }
  return `import-${Date.now()}-${index}`;
}

export function normalizeImportedLetter(item, index = 0) {
  if (!item || typeof item !== "object") throw new Error(`Imported item ${index} is not an object`);
  const now = nowSeconds();
  const sent = item.sent && typeof item.sent === "object" ? item.sent : {};
  const reply = item.reply && typeof item.reply === "object"
    ? item.reply
    : item.received && typeof item.received === "object"
      ? item.received
      : {};
  const content = sent.available === false
    ? ""
    : String(item.content ?? importedSectionText(sent)).trim();
  const replyText = reply.available === false
    ? ""
    : String(item.replyText ?? importedSectionText(reply)).trim();
  const replyVideoUrl = reply.available === false
    ? ""
    : String(item.replyVideoUrl ?? reply.videoUrl ?? "").trim();
  // 视频信件的正文通常只有视频没有文字；即使暂时拿不到视频直链（例如截图转录），
  // 只要回信侧标记为可用视频，也保留这条记录（前端按视频类型渲染，URL 缺失时显示占位）。
  const videoOnlyReply = reply.available !== false
    && String(reply.type || "").toLowerCase() === "video";
  if (!content && !replyText && !replyVideoUrl && !videoOnlyReply) {
    throw new Error(`Imported item ${index} has neither sent nor reply content`);
  }

  const created = normalizeDateTime(
    item.createdAt ?? sent.timestamp ?? item.writtenAt ?? sent.date ?? item.sourceDate,
    now - index
  );
  const replied = normalizeDateTime(
    item.repliedAt ?? reply.timestamp ?? reply.date,
    created.epoch
  );
  const hasReply = Boolean(replyText || replyVideoUrl || videoOnlyReply);
  const repliedAt = hasReply ? Math.max(created.epoch, replied.epoch) : null;
  const inferredReplyType = hasReply
    ? String(reply.type || "").toLowerCase() === "video" || replyVideoUrl
      ? REPLY_TYPE.SPEECH
      : REPLY_TYPE.TEXT
    : REPLY_TYPE.NONE;

  return {
    letterId: importedLetterId(item, index),
    content,
    material: item.material ?? null,
    letterStatus: Number(item.letterStatus ?? (hasReply ? LETTER_STATUS.REPLIED : LETTER_STATUS.PENDING)),
    auditStatus: Number(item.auditStatus ?? (hasReply ? AUDIT_STATUS.PASSED : AUDIT_STATUS.PENDING)),
    replyType: Number(item.replyType ?? reply.replyType ?? inferredReplyType),
    replyText,
    replyVideoUrl,
    isRead: Number(item.isRead ?? (item.isUnread === true ? 0 : 1)),
    createdAt: created.epoch,
    createdPrecision: item.createdPrecision ?? created.precision,
    repliedAt,
    repliedPrecision: hasReply ? item.repliedPrecision ?? replied.precision : null,
    readyAtMs: null,
    source: String(item.source ?? (item.shareId ? "history-share-json" : "import-json")),
    raw: item,
    generationStatus: hasReply ? "imported" : "none",
    providerId: null,
    modelId: null,
    lastError: null
  };
}

export function writeLetterArguments(letter) {
  return [
    letter.letterId,
    letter.content,
    jsonOrNull(letter.material),
    letter.letterStatus,
    letter.auditStatus,
    letter.replyType,
    letter.replyText,
    letter.replyVideoUrl,
    letter.isRead,
    letter.createdAt,
    letter.repliedAt,
    letter.readyAtMs,
    letter.source,
    jsonOrNull(letter.raw),
    letter.createdPrecision ?? "second",
    letter.repliedPrecision ?? null,
    letter.generationStatus ?? "none",
    letter.providerId ?? null,
    letter.modelId ?? null,
    letter.lastError ?? null,
    nowSeconds()
  ];
}

export function importPayloadItems(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.letters)) return body.letters;
  if (body && typeof body === "object") return [body];
  throw new Error("Import body must be a letter object, an array, or contain letters[]");
}
