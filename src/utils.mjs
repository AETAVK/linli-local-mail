import crypto from "node:crypto";

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function randomId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

export function parseJson(value, fallback = null) {
  if (value == null || value === "") return fallback;
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return fallback;
  }
}

export function jsonOrNull(value) {
  return value == null ? null : JSON.stringify(value);
}

export function clampNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

export function normalizeHttpUrl(value, { required = true } = {}) {
  const text = String(value ?? "").trim().replace(/\/+$/, "");
  if (!text && !required) return "";
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`Invalid HTTP URL: ${text || "(empty)"}`);
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error(`Only http:// and https:// URLs are supported: ${text}`);
  }
  return text;
}

export function joinEndpoint(baseUrl, suffix) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const normalizedSuffix = `/${String(suffix || "").replace(/^\/+/, "")}`;
  return base.endsWith(normalizedSuffix) ? base : `${base}${normalizedSuffix}`;
}

export function compactWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function excerpt(value, length = 48) {
  const compact = compactWhitespace(value);
  return compact.length > length ? `${compact.slice(0, length)}……` : compact;
}

export async function readJsonBody(req, { maximumBytes = 2 * 1024 * 1024 } = {}) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maximumBytes) throw new Error(`Request body exceeds ${maximumBytes} bytes`);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function fetchJson(url, options = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("request timeout")), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    const body = text ? parseJson(text, null) : null;
    if (!response.ok) {
      const detail = body?.error?.message || body?.message || text || response.statusText;
      const error = new Error(`Provider HTTP ${response.status}: ${String(detail).slice(0, 800)}`);
      error.status = response.status;
      error.responseBody = body;
      throw error;
    }
    if (body == null) throw new Error("Provider returned a non-JSON response");
    return body;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`Provider request timed out after ${timeoutMs} ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
