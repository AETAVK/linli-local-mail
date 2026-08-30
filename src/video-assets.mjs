import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

// 原生视频回信只保存官方返回的既有视频，不生成视频、不转写音频。
// 文件名只由本地随机 assetId 产生，绝不把远端 URL 或用户输入拼进路径。
export const DEFAULT_MAX_VIDEO_BYTES = 512 * 1024 * 1024;
export const VIDEO_ASSET_ID_PATTERN = /^video-[a-f0-9-]{20,80}$/i;

const TRUSTED_MEDIA_SUFFIXES = Object.freeze([
  ".olivia.miyoushe.com",
  ".miyoushe.com",
  ".mihoyo.com",
  ".hoyoverse.com"
]);

export class VideoAssetError extends Error {
  constructor(message, { code = "video_asset_error", status = 502 } = {}) {
    super(message);
    this.name = "VideoAssetError";
    this.code = code;
    this.status = status;
  }
}

function isTrustedHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return TRUSTED_MEDIA_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

export function validateRemoteVideoUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return { ok: false, reason: "missing" };
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "not_https" };
  if (url.username || url.password) return { ok: false, reason: "credentials_not_allowed" };
  if (!isTrustedHost(url.hostname)) return { ok: false, reason: "untrusted_host" };
  return { ok: true, url: url.toString() };
}

function responseHeader(response, name) {
  return String(response?.headers?.get?.(name) || "").trim().toLowerCase();
}

function contentType(response) {
  const value = responseHeader(response, "content-type").split(";", 1)[0].trim();
  return value;
}

function combinedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(1, Number(timeoutMs) || 20_000));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function isMp4Header(buffer) {
  return buffer.length >= 8 && buffer.subarray(4, 8).toString("ascii") === "ftyp";
}

function asReadable(body) {
  if (!body) return null;
  if (typeof body.getReader === "function") return Readable.fromWeb(body);
  return body;
}

function normalizePositiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

export function parseByteRange(value, size) {
  const total = normalizePositiveInteger(size);
  if (!total || !String(value || "").trim()) return null;
  const match = String(value).trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return { invalid: true };
  const [, startText, endText] = match;
  if (!startText && !endText) return { invalid: true };

  let start;
  let end;
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { invalid: true };
    start = Math.max(0, total - suffixLength);
    end = total - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : total - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= total) {
      return { invalid: true };
    }
    end = Math.min(end, total - 1);
  }
  return { start, end, length: end - start + 1 };
}

export class VideoAssetStore {
  constructor(root, { maxBytes = DEFAULT_MAX_VIDEO_BYTES } = {}) {
    this.root = path.resolve(String(root));
    this.maxBytes = Math.max(1, Number(maxBytes) || DEFAULT_MAX_VIDEO_BYTES);
  }

  assetPath(mediaId) {
    const id = String(mediaId || "");
    if (!VIDEO_ASSET_ID_PATTERN.test(id)) {
      throw new VideoAssetError("视频资产编号无效。", { code: "invalid_video_asset_id", status: 400 });
    }
    return path.join(this.root, `${id}.mp4`);
  }

  hasAsset(asset) {
    if (!asset?.mediaId) return false;
    try {
      const stat = fs.statSync(this.assetPath(asset.mediaId));
      if (!stat.isFile() || stat.size <= 0) return false;
      const expectedSize = normalizePositiveInteger(asset.byteSize);
      return !expectedSize || stat.size === expectedSize;
    } catch {
      return false;
    }
  }

  stat(mediaId) {
    try {
      const stat = fs.statSync(this.assetPath(mediaId));
      if (!stat.isFile()) return null;
      return stat;
    } catch {
      return null;
    }
  }

  createReadStream(mediaId, options) {
    return fs.createReadStream(this.assetPath(mediaId), options);
  }

  async remove(assetOrId) {
    const mediaId = typeof assetOrId === "string" ? assetOrId : assetOrId?.mediaId;
    if (!mediaId || !VIDEO_ASSET_ID_PATTERN.test(String(mediaId))) return false;
    try {
      await fsp.rm(this.assetPath(mediaId), { force: true });
      return true;
    } catch {
      return false;
    }
  }

  async ensureRemoteVideo(urlValue, {
    fetchImpl = fetch,
    signal,
    timeoutMs = 30_000,
    existing = null
  } = {}) {
    const validated = validateRemoteVideoUrl(urlValue);
    if (!validated.ok) {
      throw new VideoAssetError("视频地址不是受信任的 HTTPS 官方媒体地址。", {
        code: `video_${validated.reason}`,
        status: 422
      });
    }
    const sourceUrl = validated.url;
    if (existing?.sourceUrl === sourceUrl && this.hasAsset(existing)) {
      return { ...existing, sourceUrl, reused: true };
    }

    let response;
    try {
      response = await fetchImpl(sourceUrl, {
        method: "GET",
        redirect: "error",
        signal: combinedSignal(signal, timeoutMs),
        headers: {
          Accept: "video/mp4,video/*;q=0.9,application/octet-stream;q=0.5",
          "User-Agent": "LinliLocalMail/0.8.0 (video-archive)"
        }
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new VideoAssetError(
        `读取官方视频失败：${error instanceof Error ? error.message : String(error)}`,
        { code: "video_fetch_failed", status: 502 }
      );
    }
    if (!response.ok) {
      throw new VideoAssetError(`读取官方视频失败（HTTP ${response.status}）。`, {
        code: "video_http_error",
        status: 502
      });
    }
    const contentLength = Number(response.headers?.get?.("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > this.maxBytes) {
      throw new VideoAssetError("官方视频超过本地保存大小上限。", {
        code: "video_too_large",
        status: 413
      });
    }
    const readable = asReadable(response.body);
    if (!readable) {
      throw new VideoAssetError("官方视频响应没有可读取的内容。", {
        code: "video_empty_body",
        status: 502
      });
    }

    await fsp.mkdir(this.root, { recursive: true });
    const mediaId = `video-${crypto.randomUUID()}`;
    const temporaryPath = path.join(this.root, `.${mediaId}.part`);
    const finalPath = this.assetPath(mediaId);
    const hash = crypto.createHash("sha256");
    let byteSize = 0;
    let header = Buffer.alloc(0);
    const maxBytes = this.maxBytes;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteSize += buffer.length;
        if (byteSize > maxBytes) {
          callback(new VideoAssetError("官方视频超过本地保存大小上限。", {
            code: "video_too_large",
            status: 413
          }));
          return;
        }
        if (header.length < 64) {
          header = Buffer.concat([header, buffer]).subarray(0, 64);
        }
        hash.update(buffer);
        callback(null, buffer);
      }
    });

    try {
      await pipeline(readable, limiter, fs.createWriteStream(temporaryPath), {
        signal: combinedSignal(signal, timeoutMs)
      });
      const mimeType = contentType(response);
      if (!mimeType.startsWith("video/") && !isMp4Header(header)) {
        throw new VideoAssetError("官方视频响应不是可播放的视频格式。", {
          code: "video_invalid_format",
          status: 422
        });
      }
      if (byteSize <= 0) {
        throw new VideoAssetError("官方视频内容为空。", { code: "video_empty_body", status: 422 });
      }
      await fsp.rename(temporaryPath, finalPath);
      return {
        mediaId,
        fileName: `${mediaId}.mp4`,
        mimeType: mimeType.startsWith("video/") ? mimeType : "video/mp4",
        byteSize,
        sha256: hash.digest("hex"),
        sourceUrl,
        reused: false
      };
    } catch (error) {
      await fsp.rm(temporaryPath, { force: true }).catch(() => {});
      if (error instanceof VideoAssetError) throw error;
      if (signal?.aborted) throw error;
      throw new VideoAssetError(
        `保存官方视频失败：${error instanceof Error ? error.message : String(error)}`,
        { code: "video_save_failed", status: 502 }
      );
    }
  }
}

