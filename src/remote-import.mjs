import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SERVICE_VERSION } from "./constants.mjs";

// 官方日志自动检测与远端历史读取。
//
// 安全边界：
// - 只读取本机官方客户端日志，检测候选不发起任何网络请求；
// - 远端地址必须是 HTTPS 且主机属于 olivia.miyoushe.com 或 *.olivia.miyoushe.com；
// - 只允许官方客户端需要的固定 x-* 请求头，不允许用户输入自定义地址；
// - 重定向、超大响应、超时、取消与有限重试都在本模块内处理；
// - x-token 只存在于当前任务的进程内存中，绝不写库、写日志、导出或进入模型上下文。

export const OFFICIAL_LOG_FILES = Object.freeze(["Olivia.log", "Olivia.1.log", "Olivia.2.log"]);
export const OFFICIAL_HOST_EXACT = "olivia.miyoushe.com";
export const OFFICIAL_HOST_PATTERN = /^[a-z0-9-]+\.olivia\.miyoushe\.com$/i;
export const OFFICIAL_API_PREFIX = "/toy";

// 官方客户端真实调用契约（来自 .627 客户端前端对 Axios 实例的调用证据）：
// Axios 基址是 toyApiUrl + "/toy"，以下是相对于该基址的接口路径；因此最终
// 请求 URL 分别是 {toyApiUrl}/toy/letter/*。本地桥仍使用不带 /toy 的相对路径。
export const REMOTE_ENDPOINTS = Object.freeze({
  authProbe: "/letter/unread_count",
  letterList: "/letter/list",
  letterDetail: "/letter/detail"
});

// 官方客户端需要的固定 x-* 请求头白名单。Token 与 UID 不在此列（它们总是
// 从日志上下文单独装配），列表里也不包含 Cookie / Authorization 等敏感项。
export const OFFICIAL_HEADER_WHITELIST = Object.freeze([
  "x-biz",
  "x-bundle_id",
  "x-client",
  "x-client_type",
  "x-client_version",
  "x-device",
  "x-device_id",
  "x-device_model",
  "x-language",
  "x-lifecycle_id",
  "x-platform",
  "x-pkg_version",
  "x-sys_version",
  "x-sign",
  "x-sign_type"
]);

export const REMOTE_IMPORT_SOURCE = "remote-history";
export const REMOTE_IMPORT_SOURCE_LABEL = "官方信箱历史（本地日志会话恢复）";

// 官方 Olivia.N.log 的轮转上限约为 20 MiB；24 MiB 可以完整覆盖一个轮转文件，
// 同时在异常超大日志上仍只读取最新尾部，避免无界内存占用。
export const MAX_LOG_BYTES = 24 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_LIST_PAGES = 100;
const LIST_PAGE_SIZE = 50;

const TERMINAL_STATES = new Set(["completed", "partial", "failed", "cancelled"]);

const OFFICIAL_USER_AGENT = `LinliLocalMail/${SERVICE_VERSION} (official-history-restore)`;

export class RemoteImportError extends Error {
  constructor(message, { code = "remote_import_error", status = 400 } = {}) {
    super(message);
    this.name = "RemoteImportError";
    this.code = code;
    this.status = status;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfCancelled(signal) {
  if (signal?.aborted) {
    const error = new RemoteImportError("任务已取消。", { code: "remote_import_cancelled", status: 409 });
    error.cancelled = true;
    throw error;
  }
}

export function redactSecrets(value) {
  const text = String(value ?? "");
  return text
    .replace(/("x-token"\s*:\s*")[^"]*(")/gi, '$1••••••••$2')
    .replace(/("x-token"\s*:\s*')[^']*(')/gi, "$1••••••••$2")
    .replace(/(x-token\s*[=:]\s*)[^\s"',;&}]+/gi, "$1••••••••")
    .replace(/(authorization\s*[=:]\s*)[^\s"',;&}]+/gi, "$1••••••••")
    .replace(/(cookie\s*[=:]\s*)[^\s"',;&}]+/gi, "$1••••••••");
}

export function sanitizeRemoteError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message).slice(0, 400);
}

export function defaultOfficialLogPaths() {
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const root = path.join(appData, "miHoYo", "Olivia-steam", "logs");
  return OFFICIAL_LOG_FILES.map((name) => path.join(root, name));
}

export function validateOfficialBaseUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) return { ok: false, reason: "missing" };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:") return { ok: false, reason: "not_https" };
  if (host !== OFFICIAL_HOST_EXACT && !OFFICIAL_HOST_PATTERN.test(host)) {
    return { ok: false, reason: "not_official_host" };
  }
  if (url.username || url.password) return { ok: false, reason: "credentials_not_allowed" };
  if (url.search || url.hash) return { ok: false, reason: "query_or_hash_not_allowed" };
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (pathname !== "/" && pathname !== OFFICIAL_API_PREFIX) {
    return { ok: false, reason: "unexpected_path" };
  }
  return {
    ok: true,
    baseUrl: url.origin,
    apiBaseUrl: `${url.origin}${OFFICIAL_API_PREFIX}`
  };
}

// 从任意文本中提取平衡的 JSON 对象。支持一行多个对象和嵌套对象；
// 遇到未闭合的对象时标记 truncated 并停止，供调用方走降级恢复。
export function extractJsonObjects(text) {
  const objects = [];
  let truncated = false;
  let cursor = 0;
  const length = text.length;
  while (cursor < length) {
    const start = text.indexOf("{", cursor);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end === -1) {
      truncated = true;
      break;
    }
    try {
      objects.push(JSON.parse(text.slice(start, end + 1)));
    } catch {
      // 单段损坏不影响其他对象
    }
    cursor = end + 1;
  }
  return { objects, truncated };
}

function collectValuesByKey(node, keyPattern, output, depth = 0) {
  if (depth > 8 || !node) return;
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") return;
  if (Array.isArray(node)) {
    for (const item of node) collectValuesByKey(item, keyPattern, output, depth + 1);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (keyPattern.test(key)) {
      if (value != null) output.push(value);
    } else if (value && typeof value === "object") {
      collectValuesByKey(value, keyPattern, output, depth + 1);
    }
  }
}

function firstStringValue(values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return null;
}

// 日志最后一行被截断时，只降级恢复非账户相关的 toyApiUrl。Token、UID 和
// 设备头必须来自同一条完整的 /letter/list 请求，避免拼接不同会话的凭证。
function salvageLogFragments(text) {
  const pattern = /["']?(?:toyApiUrl|toy_api_url|baseUrl)["']?\s*[:=]\s*["'](https:\/\/[a-z0-9-]+\.olivia\.miyoushe\.com(?:\/toy)?\/?)["']/gi;
  let baseUrl = null;
  for (const match of text.matchAll(pattern)) baseUrl = match[1];
  return { baseUrl };
}

// 在按修改时间从新到旧的日志条目中查找“最近一次”出现的字段。
// matcher.fromObject 处理完整 JSON 对象，matcher.fromSalvage 处理截断尾部。
function findNewestField(entries, matcher) {
  for (const entry of entries) {
    for (let index = entry.objects.length - 1; index >= 0; index -= 1) {
      const found = matcher.fromObject(entry.objects[index]);
      if (found != null) return found;
    }
    if (entry.salvage) {
      const found = matcher.fromSalvage?.(entry.salvage);
      if (found != null) return found;
    }
  }
  return null;
}

function extractString(object, keyPattern) {
  const values = [];
  collectValuesByKey(object, keyPattern, values);
  return firstStringValue(values);
}

function collectDeviceHeaders(object) {
  const headers = {};
  for (const name of OFFICIAL_HEADER_WHITELIST) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const value = extractString(object, new RegExp(`^${escaped}$`, "i"));
    if (value != null) headers[name] = String(value).slice(0, 256);
  }
  return headers;
}

function hasLetterListRequest(object) {
  const values = [];
  collectValuesByKey(object, /^(url|path|fullurl|api|request[._-]?url|http[._-]?(?:url|target))$/i, values);
  return values.some((value) => String(value).includes("/letter/list"));
}

// 打补丁后的客户端信箱轮询不再产生 OTEL network_request 日志；当所有日志中
// 都没有 /letter/list 记录时，回退到任意官方 network_request（/signIn、
// /midi/* 等）提取最新凭证。官方 token 是账户级的，已实测可调信箱接口。
// 凭证仍然只从同一条完整请求对象内提取，不跨对象拼接。
function hasNetworkRequest(object) {
  const values = [];
  collectValuesByKey(object, /^(url|path|fullurl|api|request[._-]?url|http[._-]?(?:url|target))$/i, values);
  return values.some((value) => String(value).includes("/"));
}

function credentialContextFrom(object) {
  const token = extractString(object, /^x-token$/i);
  const uid = extractString(object, /^x-uid$/i);
  if (!token || !uid) return null;
  return {
    token,
    uid: String(uid),
    deviceHeaders: collectDeviceHeaders(object)
  };
}

// 按日志条目 mtime 从新到旧扫描；同一份日志内信箱请求优先于其他官方请求，
// 但更旧日志里的信箱请求不会抢走更新日志里的其他请求凭证——凭证新鲜度
// 比请求类型更重要（旧会话的 token 已被官方轮换作废）。
function findNewestMailboxContext(entries) {
  let foundRequest = false;
  for (const entry of entries) {
    let mailboxCandidate = null;
    for (let index = entry.objects.length - 1; index >= 0; index -= 1) {
      const object = entry.objects[index];
      if (!hasNetworkRequest(object)) continue;
      const context = credentialContextFrom(object);
      if (!context) continue;
      const isMailbox = hasLetterListRequest(object);
      if (isMailbox) foundRequest = true;
      if (isMailbox) return { foundRequest, context, source: "mailbox_request" };
      if (!mailboxCandidate) mailboxCandidate = { context };
    }
    if (mailboxCandidate) {
      return { foundRequest, context: mailboxCandidate.context, source: "any_network_request" };
    }
  }
  return { foundRequest, context: null, source: null };
}

function readLogTail(filePath, size, maximumBytes = MAX_LOG_BYTES) {
  const bytesToRead = Math.min(Math.max(0, Number(size) || 0), maximumBytes);
  if (bytesToRead === 0) return "";
  const buffer = Buffer.allocUnsafe(bytesToRead);
  const descriptor = fs.openSync(filePath, "r");
  let totalRead = 0;
  try {
    const position = Math.max(0, size - bytesToRead);
    while (totalRead < bytesToRead) {
      const count = fs.readSync(descriptor, buffer, totalRead, bytesToRead - totalRead, position + totalRead);
      if (count === 0) break;
      totalRead += count;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return buffer.subarray(0, totalRead).toString("utf8");
}

// 读取并解析官方日志目录。返回结构化状态，绝不包含 token。
export function readOfficialLogContext(logsPaths) {
  const paths = logsPaths && logsPaths.length ? logsPaths : defaultOfficialLogPaths();
  let anyFileExists = false;
  let readFailure = null;
  const entries = [];
  for (const filePath of paths) {
    let stat = null;
    try {
      stat = fs.statSync(filePath);
    } catch {
      // 单个日志文件不存在是正常情况
    }
    if (!stat) continue;
    anyFileExists = true;
    if (!stat.isFile()) continue;
    try {
      const rawText = readLogTail(filePath, stat.size);
      const { objects, truncated } = extractJsonObjects(rawText);
      entries.push({
        filePath,
        mtimeMs: stat.mtimeMs,
        rawText,
        objects,
        salvage: truncated ? salvageLogFragments(rawText) : null
      });
    } catch (error) {
      readFailure = sanitizeRemoteError(error);
    }
  }

  if (!anyFileExists) {
    return { ok: false, code: "no_log_file", message: "未找到官方客户端日志文件。", context: null };
  }
  if (readFailure && entries.length === 0) {
    return {
      ok: false,
      code: "log_read_error",
      message: `读取官方日志失败：${readFailure}`,
      context: null
    };
  }

  entries.sort((left, right) => right.mtimeMs - left.mtimeMs);

  const baseUrl = findNewestField(entries, {
    fromObject: (object) => extractString(object, /^(toyapiurl|toy_api_url|baseurl)$/i),
    fromSalvage: (salvage) => salvage.baseUrl
  });
  const mailbox = findNewestMailboxContext(entries);

  if (!mailbox.context && !mailbox.foundRequest) {
    // 连回退凭证都找不到：日志里没有任何带 x-token+x-uid 的官方网络请求
    return {
      ok: false,
      code: "no_recent_mailbox_request",
      message: "未能在本机官方日志中找到可用的登录凭证，请先启动并登录官方游戏，再重试。",
      context: null
    };
  }
  const validated = baseUrl ? validateOfficialBaseUrl(baseUrl) : { ok: false, reason: "missing" };
  if (!validated.ok) {
    return {
      ok: false,
      code: "invalid_toy_api_url",
      message: "官方日志中的 toyApiUrl 无效，无法用于恢复历史。",
      context: null
    };
  }
  if (!mailbox.context) {
    return {
      ok: false,
      code: "missing_credentials",
      message: "官方日志中缺少登录凭证，请先在官方游戏中打开一次信箱，再重试。",
      context: null
    };
  }

  return {
    ok: true,
    code: "ok",
    message: mailbox.source === "mailbox_request"
      ? "检测到本机可能存在官方信箱历史记录。"
      : "检测到本机官方登录凭证（来自最近的官方请求），可以尝试读取官方信箱历史。",
    context: {
      baseUrl: validated.baseUrl,
      apiBaseUrl: validated.apiBaseUrl,
      token: mailbox.context.token,
      uid: mailbox.context.uid,
      deviceHeaders: mailbox.context.deviceHeaders,
      lastMailboxRequest: mailbox.source === "mailbox_request",
      credentialSource: mailbox.source
    }
  };
}

export function buildOfficialHeaders(context) {
  const headers = {};
  const source = context?.deviceHeaders && typeof context.deviceHeaders === "object"
    ? context.deviceHeaders
    : {};
  for (const name of OFFICIAL_HEADER_WHITELIST) {
    const value = source[name];
    if (value != null && String(value) !== "") headers[name] = String(value);
  }
  headers["x-token"] = String(context.token || "");
  headers["x-uid"] = String(context.uid || "");
  headers["User-Agent"] = OFFICIAL_USER_AGENT;
  return headers;
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

function contentHash(...values) {
  return crypto
    .createHash("sha256")
    .update(values.map((value) => String(value ?? "")).join("\u0000"))
    .digest("hex")
    .slice(0, 12);
}

function pickValue(data, names) {
  for (const name of names) {
    const value = data?.[name];
    if (value != null && String(value) !== "") return value;
  }
  return null;
}

// 把官方接口的 letter 记录转换为项目历史 JSON 契约。
// 字段同时兼容 camelCase 和 snake_case；缺失的时间保持为空，绝不从
// 文件名、当前时间或列表顺序伪造（由 normalizeImportedLetter 的
// keepUnknownTime 模式保证）。
export function normalizeRemoteLetter(data, { uid, sourceUrl } = {}) {
  const letterIdRaw = pickValue(data, ["letter_id", "letterId", "id", "letterID"]);
  const shareIdRaw = pickValue(data, ["share_id", "shareId"]);
  const content = normalizeText(pickValue(data, ["content", "sentText", "sent_text", "content_text"]));
  const replyText = normalizeText(pickValue(data, ["reply_text", "replyText"]));
  const replyVideoUrl = normalizeText(pickValue(data, ["reply_video_url", "replyVideoUrl"]));
  const replyTypeRaw = pickValue(data, ["reply_type", "replyType"]);
  const letterStatusRaw = pickValue(data, ["letter_status", "letterStatus", "status"]);
  const createdAtRaw = pickValue(data, ["created_at", "createdAt", "sent_at", "sentAt", "send_at", "sendAt"]);
  const repliedAtRaw = pickValue(data, ["replied_at", "repliedAt", "reply_at", "replyAt"]);
  const updatedAtRaw = pickValue(data, ["updated_at", "updatedAt", "update_at", "updateAt"]);

  const letterId = letterIdRaw ? String(letterIdRaw) : "";
  const shareId = shareIdRaw ? String(shareIdRaw) : letterId;
  const stableId = letterId
    || `history-${String(uid || "unknown")}-${shareId || contentHash(content, replyText, createdAtRaw)}`;
  const replyTypeNumber = Number(replyTypeRaw);
  const hasVideoReply = Boolean(replyVideoUrl) || (Number.isFinite(replyTypeNumber) && replyTypeNumber >= 2);
  const hasReply = Boolean(replyText) || hasVideoReply;
  const createdAt = Number(createdAtRaw) > 0 ? createdAtRaw : null;
  const repliedAt = Number(repliedAtRaw) > 0 ? repliedAtRaw : null;
  const material = data?.material && typeof data.material === "object" && !Array.isArray(data.material)
    ? data.material
    : null;
  const isRead = Number.isFinite(Number(data?.isRead ?? data?.is_read)) ? Number(data?.isRead ?? data?.is_read) : 1;

  const written = createdAt ? localDateParts(createdAt) : null;
  const replied = repliedAt ? localDateParts(repliedAt) : null;
  const fileName = written
    ? `${written.day}_${written.time.replace(":", "-")}_${shareId || stableId}.json`
    : `official-${stableId}.json`;

  const sent = {
    available: Boolean(content),
    text: content,
    paragraphs: content ? content.split("\n").map((item) => item.trim()).filter(Boolean) : [],
    date: written?.day ?? null,
    type: "text",
    videoUrl: null
  };
  const reply = {
    available: hasReply,
    text: replyText,
    paragraphs: replyText ? replyText.split("\n").map((item) => item.trim()).filter(Boolean) : [],
    date: replied?.day ?? null,
    type: hasVideoReply ? "video" : "text",
    videoUrl: replyVideoUrl
  };

  return {
    fileName,
    sourceUrl: sourceUrl || REMOTE_IMPORT_SOURCE_LABEL,
    finalUrl: sourceUrl || REMOTE_IMPORT_SOURCE_LABEL,
    uid: String(uid || ""),
    shareId: shareId || stableId,
    letterId: stableId,
    sourceDate: written?.day ?? null,
    writtenAt: written?.dateTime ?? null,
    repliedAt: replied?.dateTime ?? null,
    createdAt,
    createdPrecision: createdAt ? "second" : null,
    repliedPrecision: repliedAt ? "second" : null,
    replyVideoUrl,
    letterStatus: Number.isFinite(Number(letterStatusRaw))
      ? Number(letterStatusRaw)
      : hasReply ? 4 : 1,
    auditStatus: hasReply ? 2 : 1,
    replyType: Number.isFinite(replyTypeNumber)
      ? replyTypeNumber
      : hasReply ? (replyVideoUrl ? 2 : 1) : 0,
    sent,
    reply,
    material,
    isRead,
    replyAiGenerated: true,
    source: REMOTE_IMPORT_SOURCE,
    ok: true,
    error: null,
    updatedAtEpoch: Number(updatedAtRaw) || 0
  };
}

export function buildOfficialUrl(baseUrl, endpoint, params) {
  const validated = validateOfficialBaseUrl(baseUrl);
  if (!validated.ok) {
    throw new RemoteImportError("官方日志中的 toyApiUrl 无效。", {
      code: "invalid_toy_api_url",
      status: 400
    });
  }
  const normalizedEndpoint = `/${String(endpoint ?? "").replace(/^\/+/, "")}`;
  if (!Object.values(REMOTE_ENDPOINTS).includes(normalizedEndpoint)) {
    throw new RemoteImportError("不支持的官方接口路径。", {
      code: "invalid_official_endpoint",
      status: 500
    });
  }
  const apiRoot = new URL(`${OFFICIAL_API_PREFIX}/`, `${validated.baseUrl}/`);
  const url = new URL(normalizedEndpoint.slice(1), apiRoot);
  for (const [key, value] of Object.entries(params || {})) {
    if (value != null && String(value) !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function retryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

async function officialRequest(fetchImpl, url, { context, signal, timeoutMs, attempts, backoffMs, authContext = false }) {
  const headers = buildOfficialHeaders(context);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfCancelled(signal);
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers,
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      });
    } catch (error) {
      throwIfCancelled(signal);
      lastError = error;
      if (attempt < attempts) {
        await sleep(backoffMs * attempt);
        continue;
      }
      const detail = sanitizeRemoteError(lastError);
      throw new RemoteImportError(
        `无法连接官方服务器：${detail}`,
        { code: "official_network_error", status: 502 }
      );
    }

    if (retryableStatus(response.status)) {
      if (attempt < attempts) {
        await sleep(backoffMs * attempt);
        continue;
      }
      throw new RemoteImportError(
        `官方服务器暂时不可用（HTTP ${response.status}），请稍后重试。`,
        { code: "official_server_unavailable", status: 502 }
      );
    }

    const contentLength = Number(response.headers?.get?.("content-length") || 0);
    if (contentLength > MAX_RESPONSE_BYTES) {
      throw new RemoteImportError("官方接口返回的数据过大。", { code: "official_response_too_large", status: 502 });
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw new RemoteImportError("官方接口返回的数据过大。", { code: "official_response_too_large", status: 502 });
    }
    if (!response.ok) {
      if (authContext && (response.status === 401 || response.status === 403)) {
        throw new RemoteImportError(
          "官方服务器拒绝了本地保存的登录凭证（可能来自过旧的日志会话）。请启动官方游戏并重新登录，稍等片刻后重试。",
          { code: "official_session_expired", status: 401 }
        );
      }
      throw new RemoteImportError(
        `官方接口请求失败（HTTP ${response.status}）。`,
        { code: "official_http_error", status: 502 }
      );
    }
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new RemoteImportError(
        "官方接口返回格式变化：响应不是有效 JSON。",
        { code: "official_format_changed", status: 502 }
      );
    }
    if (typeof envelope?.code === "number" && envelope.code !== 0) {
      const detail = redactSecrets(String(envelope.message || envelope.code || "未知错误")).slice(0, 200);
      if (authContext) {
        throw new RemoteImportError(
          `官方服务器拒绝了本地保存的登录凭证（${detail}）。请启动官方游戏并重新登录，稍等片刻后重试。`,
          { code: "official_session_expired", status: 401 }
        );
      }
      throw new RemoteImportError(`官方接口返回错误：${detail}`, { code: "official_api_error", status: 502 });
    }
    return envelope?.data ?? envelope;
  }
  throw new RemoteImportError("官方接口请求失败。", { code: "official_http_error", status: 502 });
}

function extractListItems(data) {
  const payload = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const items = payload.list ?? payload.letters ?? payload.items ?? payload.records ?? [];
  return Array.isArray(items) ? items : [];
}

export function createRemoteImportJob({
  context,
  database,
  mediaStore = null,
  fetchImpl = fetch,
  logger = console,
  endpoints = REMOTE_ENDPOINTS,
  attempts = 3,
  backoffMs = 750,
  timeoutMs = REQUEST_TIMEOUT_MS,
  onFinished = null
}) {
  const abortController = new AbortController();
  const state = {
    jobId: crypto.randomUUID(),
    state: "detecting",
    stage: "detect",
    percent: 0,
    found: 0,
    imported: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    videoFound: 0,
    videoSaved: 0,
    videoFailed: 0,
    conflicts: 0,
    message: "正在检测官方日志。",
    errorCode: null,
    errors: [],
    importedIds: [],
    account: String(context.uid || ""),
    startedAt: new Date().toISOString(),
    finishedAt: null
  };

  const set = (partial) => Object.assign(state, partial);
  const snapshot = () => ({
    ...state,
    errors: state.errors.slice(0, 5),
    importedIds: (state.importedIds || []).slice()
  });
  const mediaAssets = mediaStore ? new Map() : null;
  const importedMediaLetterIds = new Set();
  const cleanedMediaIds = new Set();
  async function cleanupUncommittedMedia() {
    if (!mediaStore || !mediaAssets) return;
    for (const [letterId, asset] of mediaAssets) {
      if (!asset || asset.reused || importedMediaLetterIds.has(letterId) || cleanedMediaIds.has(asset.mediaId)) continue;
      await mediaStore.remove(asset);
      cleanedMediaIds.add(asset.mediaId);
      state.videoSaved = Math.max(0, state.videoSaved - 1);
    }
  }

  function finish(stateName, errorCode, message) {
    set({
      state: stateName,
      stage: stateName,
      errorCode,
      message,
      finishedAt: new Date().toISOString(),
      percent: stateName === "completed" ? 100 : state.percent
    });
  }

  async function run() {
    try {
      set({ state: "authenticating", stage: "auth", percent: 2, message: "正在读取官方登录状态…" });
      await officialRequest(fetchImpl, buildOfficialUrl(context.baseUrl, endpoints.authProbe), {
        context,
        signal: abortController.signal,
        timeoutMs,
        attempts,
        backoffMs,
        authContext: true
      });
      set({ percent: 6 });

      set({ state: "fetching_letters", stage: "list", percent: 8, message: "正在拉取信件列表…" });
      const listItems = [];
      let cursor = null;
      for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
        throwIfCancelled(abortController.signal);
        const data = await officialRequest(
          fetchImpl,
          buildOfficialUrl(context.baseUrl, endpoints.letterList, {
            cursor: cursor || undefined,
            // 官方只认下划线参数；驼峰 pageSize 会被忽略、每页返回全部条目
            page_size: LIST_PAGE_SIZE
          }),
          { context, signal: abortController.signal, timeoutMs, attempts, backoffMs }
        );
        const pageItems = extractListItems(data);
        listItems.push(...pageItems);
        const nextCursor = data?.nextCursor ?? data?.next_cursor ?? null;
        const hasMore = Boolean(data?.hasMore ?? data?.has_more);
        set({ found: listItems.length, percent: 8 + Math.min(22, page * 2), message: `已发现 ${listItems.length} 封。` });
        if (!pageItems.length) break;
        if (!hasMore && !nextCursor) break;
        if (nextCursor != null) cursor = nextCursor;
      }

      set({ state: "fetching_details", stage: "detail", percent: 30, message: `正在读取详情 0/${listItems.length}` });
      const records = [];
      for (let index = 0; index < listItems.length; index += 1) {
        throwIfCancelled(abortController.signal);
        try {
          const item = listItems[index];
          const itemId = pickValue(item, ["letter_id", "letterId", "id"]);
          const data = await officialRequest(
            fetchImpl,
            buildOfficialUrl(context.baseUrl, endpoints.letterDetail, {
              // 官方 axios 拦截器把驼峰 query 转下划线后才发送（humps 类转换），
              // 服务端只认 letter_id；实测 letterId 会被静默忽略并报"连线断开"。
              ...(itemId ? { letter_id: itemId } : { share_id: pickValue(item, ["share_id", "shareId"]) })
            }),
            { context, signal: abortController.signal, timeoutMs, attempts, backoffMs }
          );
          const record = normalizeRemoteLetter(data, { uid: context.uid, sourceUrl: REMOTE_IMPORT_SOURCE_LABEL });
          if (mediaStore) {
            mediaAssets.set(record.letterId, null);
            if (record.replyVideoUrl) {
              state.videoFound += 1;
              try {
                const existingAsset = database.getVideoAsset(record.letterId);
                state.message = `正在保存第 ${index + 1} 封视频…`;
                const asset = await mediaStore.ensureRemoteVideo(record.replyVideoUrl, {
                  fetchImpl,
                  signal: abortController.signal,
                  timeoutMs,
                  existing: existingAsset
                });
                mediaAssets.set(record.letterId, asset);
                if (!asset.reused) state.videoSaved += 1;
              } catch (error) {
                throwIfCancelled(abortController.signal);
                state.videoFailed += 1;
                state.failed += 1;
                state.errors.push(`第 ${index + 1} 封视频未保存：${sanitizeRemoteError(error)}`);
              }
            }
          }
          records.push(record);
        } catch (error) {
          throwIfCancelled(abortController.signal);
          state.failed += 1;
          state.errors.push(`第 ${index + 1} 封：${sanitizeRemoteError(error)}`);
        }
        state.percent = 30 + Math.floor(55 * ((index + 1) / Math.max(1, listItems.length)));
        state.message = `正在读取详情 ${index + 1}/${listItems.length}`;
      }

      set({ state: "importing", stage: "import", percent: 88, message: "正在写入本地邮箱…" });
      const result = database.importRemoteLetters(records, { mediaAssets });
      const importedIdSet = new Set(result.importedIds || []);
      for (const letterId of importedIdSet) importedMediaLetterIds.add(letterId);
      if (mediaStore) {
        await cleanupUncommittedMedia();
        for (const mediaId of result.removedMediaIds || []) {
          await mediaStore.remove(mediaId);
        }
      }
      set({
        imported: result.imported,
        inserted: result.inserted,
        updated: result.updated,
        skipped: result.skipped,
        conflicts: result.conflicts,
        videoFound: state.videoFound,
        videoSaved: state.videoSaved,
        videoFailed: state.videoFailed,
        importedIds: result.importedIds || [],
        percent: 100
      });
      for (const entry of result.errors.slice(0, 5)) {
        state.errors.push(entry.message);
      }

      if (state.failed > 0 || result.skipped > 0 || result.conflicts > 0) {
        const parts = [];
        if (result.imported > 0) parts.push(`新增 ${result.inserted}，更新 ${result.updated}`);
        if (result.conflicts > 0) parts.push(`重复 ${result.conflicts}（本地已有，内容已保留）`);
        if (result.skipped > 0) parts.push(`跳过 ${result.skipped}`);
        if (state.failed > 0) parts.push(`失败 ${state.failed}`);
        if (state.videoSaved > 0) parts.push(`已保存视频 ${state.videoSaved}`);
        if (state.videoFailed > 0) parts.push(`视频保存失败 ${state.videoFailed}`);
        if (result.imported > 0 || result.conflicts > 0) {
          finish("partial", null, `导入完成（部分）：${parts.join("，")}。`);
        } else {
          finish("failed", "remote_import_failed", `导入失败：${parts.join("，")}。`);
        }
      } else if (records.length === 0) {
        finish("completed", null, "官方信箱中没有新的历史记录可导入。");
      } else {
        finish("completed", null, `导入完成：新增 ${result.inserted}，更新 ${result.updated}。`);
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        finish("cancelled", "remote_import_cancelled", "导入已取消；本次尚未写入的详情不会保存，数据库中原有记录不变。");
      } else {
        finish("failed", error?.code || "remote_import_failed", sanitizeRemoteError(error));
      }
    } finally {
      await cleanupUncommittedMedia();
      if (!TERMINAL_STATES.has(state.state)) {
        finish("failed", "remote_import_failed", "导入任务异常结束。");
      }
      try {
        onFinished?.(snapshot());
      } catch (callbackError) {
        logger.error?.(`remote import finish callback failed: ${sanitizeRemoteError(callbackError)}`);
      }
    }
  }

  return {
    run,
    snapshot,
    cancel() {
      abortController.abort();
    },
    get cancelled() {
      return abortController.signal.aborted;
    }
  };
}

export class RemoteImportManager {
  constructor({ database, mediaStore = null, fetchImpl = fetch, logger = console, logPaths = null, jobOptions = {} } = {}) {
    this.database = database;
    this.mediaStore = mediaStore;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.logPaths = logPaths;
    this.jobOptions = jobOptions;
    this.job = null;
    this.lastResult = null;
  }

  detect() {
    const detection = readOfficialLogContext(this.logPaths);
    const prompt = this.database.getRemoteImportSettings();
    // 本地已有的官方信件数（含远端/分享链接导入）：官方仍在运营时，
    // 每个登录过的用户都会命中日志凭证；用它区分"从未导入"与"已全部/部分导入"。
    const importedOfficialCount = this.database.importedOfficialCount();
    if (!detection.ok || !detection.context) {
      return {
        found: false,
        code: detection.code,
        message: detection.message,
        source: null,
        account: null,
        idsHash: null,
        importedOfficialCount,
        prompt
      };
    }
    return {
      found: true,
      code: "ok",
      message: detection.message,
      source: { kind: "official-log" },
      account: detection.context.uid,
      idsHash: contentHash(detection.context.uid, detection.context.baseUrl),
      importedOfficialCount,
      prompt
    };
  }

  start() {
    if (this.job && !TERMINAL_STATES.has(this.job.snapshot().state)) {
      throw new RemoteImportError(
        "已有官方历史导入任务正在运行。",
        { code: "remote_import_busy", status: 409 }
      );
    }
    const detection = readOfficialLogContext(this.logPaths);
    if (!detection.ok || !detection.context) {
      throw new RemoteImportError(detection.message, { code: detection.code, status: 400 });
    }
    const manager = this;
    const job = createRemoteImportJob({
      context: detection.context,
      database: this.database,
      mediaStore: this.mediaStore,
      fetchImpl: this.fetchImpl,
      logger: this.logger,
      ...this.jobOptions,
      onFinished(snapshot) {
        manager.lastResult = snapshot;
        if (snapshot.state === "completed" || snapshot.state === "partial") {
          const ids = snapshot.importedIds?.length
            ? snapshot.importedIds.slice().sort()
            : [snapshot.account, snapshot.startedAt];
          manager.database.markRemoteImportSuccess({
            account: snapshot.account,
            idsHash: contentHash(...ids)
          });
        }
      }
    });
    this.job = job;
    this.lastResult = null;
    job.run().catch(() => {});
    return job.snapshot();
  }

  status() {
    if (this.job) return this.job.snapshot();
    if (this.lastResult) return this.lastResult;
    return {
      jobId: null,
      state: "idle",
      stage: "idle",
      percent: 0,
      found: 0,
      imported: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      videoFound: 0,
      videoSaved: 0,
      videoFailed: 0,
      conflicts: 0,
      message: "没有正在运行的官方历史导入任务。",
      errorCode: null,
      errors: [],
      account: null,
      startedAt: null,
      finishedAt: null
    };
  }

  cancel() {
    if (!this.job || TERMINAL_STATES.has(this.job.snapshot().state)) return this.status();
    this.job.cancel();
    return this.job.snapshot();
  }
}
