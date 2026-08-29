import crypto from "node:crypto";

import { AUDIT_STATUS, LETTER_STATUS, REPLY_TYPE } from "./constants.mjs";

const SHARE_PATH = "/single-pages/letterShare.html";
const SHARE_HOST_PATTERN = /^web-[a-z0-9-]+\.olivia\.miyoushe\.com$/i;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export class ShareImportError extends Error {
  constructor(message, statusCode = 400, code = "share_import_error") {
    super(message);
    this.name = "ShareImportError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function extractUrlText(rawInput) {
  const value = String(rawInput ?? "").trim().replaceAll("\\&", "&");
  const match = value.match(/https:\/\/[^\s\]\)>]+/i);
  return (match?.[0] || value)
    .trim()
    .replace(/^[<(\[]+/, "")
    .replace(/[>\])，。；;、]+$/, "");
}

export function parseShareLink(rawInput) {
  const value = extractUrlText(rawInput);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ShareImportError("请输入有效的 HTTPS 分享链接", 400, "invalid_share_url");
  }

  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:") {
    throw new ShareImportError("分享链接必须使用 HTTPS", 400, "invalid_share_scheme");
  }
  if (!SHARE_HOST_PATTERN.test(host) || url.pathname.replace(/\/$/, "").toLowerCase() !== SHARE_PATH.toLowerCase()) {
    throw new ShareImportError("这不是 Olivia 的信件分享链接", 400, "invalid_share_host");
  }

  const uid = String(url.searchParams.get("uid") || "").trim();
  const shareId = String(url.searchParams.get("shareId") || "").trim();
  if (!uid || !shareId) {
    throw new ShareImportError("分享链接缺少 uid 或 shareId", 400, "missing_share_parameters");
  }
  if (uid.length > 128 || shareId.length > 128) {
    throw new ShareImportError("分享链接参数过长", 400, "invalid_share_parameters");
  }

  const normalized = new URL(`https://${host}${SHARE_PATH}`);
  normalized.searchParams.set("uid", uid);
  normalized.searchParams.set("shareId", shareId);
  const apiHost = `toy-${host.slice(4)}`;
  const apiUrl = new URL(`https://${apiHost}/toy/letter/share`);
  apiUrl.searchParams.set("uid", uid);
  apiUrl.searchParams.set("share_id", shareId);

  return {
    sourceUrl: normalized.toString(),
    finalUrl: normalized.toString(),
    uid,
    shareId,
    apiUrl: apiUrl.toString()
  };
}

function normalizeText(value) {
  const text = String(value ?? "").replace(/\r\n?/g, "\n").trim();
  return text || null;
}

function localDateParts(epochSeconds) {
  const numeric = Number(epochSeconds);
  const date = new Date((Number.isFinite(numeric) && numeric > 0 ? numeric : Math.floor(Date.now() / 1000)) * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return { day, time, dateTime: `${day} ${time}` };
}

function buildSection(textValue, epochSeconds, type = "text", videoUrlValue = null) {
  const text = normalizeText(textValue);
  const videoUrl = normalizeText(videoUrlValue);
  const paragraphs = text ? text.split("\n").map((item) => item.trim()).filter(Boolean) : [];
  const date = localDateParts(epochSeconds);
  return {
    available: paragraphs.length > 0 || Boolean(videoUrl),
    text: paragraphs.length ? paragraphs.join("\n\n") : null,
    paragraphs,
    date: date.day,
    time: date.time,
    dateTime: date.dateTime,
    type,
    videoUrl
  };
}

export function sharedApiDataToImportRecord(parsed, data) {
  if (!data || typeof data !== "object") {
    throw new ShareImportError("官方接口没有返回信件数据", 502, "empty_share_data");
  }

  const createdAt = Number(data.created_at) > 0 ? Math.floor(Number(data.created_at)) : Math.floor(Date.now() / 1000);
  const repliedAt = Number(data.replied_at) > 0 ? Math.floor(Number(data.replied_at)) : null;
  const replyVideoUrl = normalizeText(data.reply_video_url);
  const sent = buildSection(data.content, createdAt, "text", null);
  const reply = buildSection(data.reply_text, repliedAt || createdAt, replyVideoUrl ? "video" : "text", replyVideoUrl);
  if (!sent.available && !reply.available) {
    throw new ShareImportError("分享数据中没有可导入的去信或回信", 422, "empty_shared_letter");
  }

  const written = localDateParts(createdAt);
  const replied = repliedAt ? localDateParts(repliedAt) : null;
  const letterId = String(data.letter_id || "").trim() || `history-${parsed.uid}-${parsed.shareId}`;
  const hasReply = reply.available;

  return {
    fileName: `${written.day}_${written.time.replace(":", "-")}_${parsed.shareId}.json`,
    sourceUrl: parsed.sourceUrl,
    finalUrl: parsed.finalUrl,
    uid: parsed.uid,
    shareId: String(data.share_id || parsed.shareId),
    letterId,
    sourceDate: written.day,
    writtenAt: written.dateTime,
    repliedAt: replied?.dateTime ?? null,
    createdAt,
    createdPrecision: "second",
    repliedPrecision: repliedAt ? "second" : null,
    letterStatus: Number.isFinite(Number(data.letter_status))
      ? Number(data.letter_status)
      : hasReply ? LETTER_STATUS.REPLIED : LETTER_STATUS.PENDING,
    auditStatus: hasReply ? AUDIT_STATUS.PASSED : AUDIT_STATUS.PENDING,
    replyType: Number.isFinite(Number(data.reply_type))
      ? Number(data.reply_type)
      : hasReply ? replyVideoUrl ? REPLY_TYPE.SPEECH : REPLY_TYPE.TEXT : REPLY_TYPE.NONE,
    sent,
    reply,
    replyAiGenerated: true,
    source: "share-link-live",
    ok: true,
    error: null,
    extractedAt: localDateParts(Math.floor(Date.now() / 1000)).dateTime,
    updatedAtEpoch: Number(data.updated_at) || 0
  };
}

export async function extractSharedLetter(rawInput, { fetchImpl = fetch, timeoutMs = 25_000 } = {}) {
  const parsed = parseShareLink(rawInput);
  let response;
  try {
    response = await fetchImpl(parsed.apiUrl, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: "application/json",
        "User-Agent": "LinliLocalMail/0.3.1",
        "x-biz": "toy",
        "x-bundle_id": "com.mihoyo.olivia",
        "x-device_model": "LinliLocalMail Windows",
        "x-language": "zh-cn",
        "x-lifecycle_id": crypto.randomUUID(),
        "x-pkg_version": "0.0.0",
        "x-sys_version": `${process.platform} ${process.arch}`
      }
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw new ShareImportError(
      timedOut ? "读取官方分享数据超时" : `无法读取官方分享数据：${error instanceof Error ? error.message : String(error)}`,
      timedOut ? 504 : 502,
      timedOut ? "share_fetch_timeout" : "share_fetch_failed"
    );
  }

  const contentLength = Number(response.headers?.get?.("content-length") || 0);
  if (contentLength > MAX_RESPONSE_BYTES) {
    throw new ShareImportError("官方接口返回的数据过大", 502, "share_response_too_large");
  }
  const responseText = await response.text();
  if (Buffer.byteLength(responseText, "utf8") > MAX_RESPONSE_BYTES) {
    throw new ShareImportError("官方接口返回的数据过大", 502, "share_response_too_large");
  }
  if (!response.ok) {
    throw new ShareImportError(`官方接口请求失败（HTTP ${response.status}）`, 502, "share_http_error");
  }

  let envelope;
  try {
    envelope = JSON.parse(responseText);
  } catch {
    throw new ShareImportError("官方接口返回的不是有效 JSON", 502, "invalid_share_response");
  }
  if (Number(envelope?.code) !== 0 || !envelope?.data) {
    throw new ShareImportError(
      String(envelope?.message || `官方接口错误代码：${envelope?.code ?? "未知"}`),
      502,
      "share_api_error"
    );
  }

  return sharedApiDataToImportRecord(parsed, envelope.data);
}

export async function extractSharedLetters(rawInputs, options = {}) {
  const inputs = Array.isArray(rawInputs) ? rawInputs : [rawInputs];
  const results = [];
  for (let index = 0; index < inputs.length; index += 1) {
    try {
      const record = await extractSharedLetter(inputs[index], options);
      results.push({ index, ok: true, record });
    } catch (error) {
      results.push({
        index,
        ok: false,
        code: error?.code || "share_import_error",
        statusCode: error?.statusCode || 500,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return results;
}
