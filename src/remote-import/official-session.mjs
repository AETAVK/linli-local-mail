import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SERVICE_VERSION } from "../constants.mjs";

// Official-session discovery is kept separate from network import orchestration so
// log parsing and credential boundaries can evolve without occupying the job module.

export const OFFICIAL_LOG_FILES = Object.freeze(["Olivia.log", "Olivia.1.log", "Olivia.2.log"]);
export const OFFICIAL_HOST_EXACT = "olivia.miyoushe.com";
export const OFFICIAL_HOST_PATTERN = /^[a-z0-9-]+\.olivia\.miyoushe\.com$/i;
export const OFFICIAL_API_PREFIX = "/toy";

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

// 官方 Olivia.N.log 的轮转上限约为 20 MiB；24 MiB 可以完整覆盖一个轮转文件，
// 同时在异常超大日志上仍只读取最新尾部，避免无界内存占用。
export const MAX_LOG_BYTES = 24 * 1024 * 1024;
const OFFICIAL_USER_AGENT = `LinliLocalMail/${SERVICE_VERSION} (official-history-restore)`;

export class RemoteImportError extends Error {
  constructor(message, { code = "remote_import_error", status = 400 } = {}) {
    super(message);
    this.name = "RemoteImportError";
    this.code = code;
    this.status = status;
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
