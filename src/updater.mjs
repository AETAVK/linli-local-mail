import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn as spawnProcess } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const GITEE_API_ROOT = "https://gitee.com/api/v5/repos/sforlife/linli-local-mail";
const GITHUB_API_ROOT = "https://api.github.com/repos/AETAVK/linli-local-mail";
const GITEE_RELEASE_PAGE = "https://gitee.com/sforlife/linli-local-mail/releases/tag/";
const CACHE_MILLISECONDS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MILLISECONDS = 20_000;
const DOWNLOAD_TIMEOUT_MILLISECONDS = 15 * 60 * 1000;
const MAX_INSTALLER_BYTES = 200 * 1024 * 1024;

const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "gitee.com",
  "github.com",
  "api.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com"
]);

export class UpdateError extends Error {
  constructor(message, { status = 500, code = "update_error" } = {}) {
    super(message);
    this.name = "UpdateError";
    this.status = status;
    this.code = code;
  }
}

export function parseStableVersion(value) {
  const match = String(value ?? "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return {
    text: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`,
    parts: [Number(match[1]), Number(match[2]), Number(match[3])]
  };
}

export function compareVersions(left, right) {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  if (!a || !b) throw new UpdateError("版本号必须符合 major.minor.patch", { status: 400, code: "invalid_version" });
  for (let index = 0; index < 3; index += 1) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index] > b.parts[index] ? 1 : -1;
  }
  return 0;
}

function expectedAssetNames(version) {
  const installer = `LinliLocalMail-${version}-Setup.exe`;
  return {
    installer,
    checksum: `${installer}.sha256`
  };
}

function isAllowedDownloadUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase();
    return ALLOWED_DOWNLOAD_HOSTS.has(hostname)
      || hostname.endsWith(".gitee.com")
      || hostname.endsWith(".github.com")
      || hostname.endsWith(".githubusercontent.com");
  } catch {
    return false;
  }
}

function normalizedAsset(asset) {
  const name = String(asset?.name || "").trim();
  const downloadUrl = String(asset?.browser_download_url || asset?.download_url || "").trim();
  if (!name || !isAllowedDownloadUrl(downloadUrl)) return null;
  const size = Number(asset?.size);
  return {
    name,
    downloadUrl,
    size: Number.isSafeInteger(size) && size >= 0 ? size : null,
    digest: /^sha256:[0-9a-f]{64}$/i.test(String(asset?.digest || ""))
      ? String(asset.digest).toLowerCase()
      : null
  };
}

function normalizeRelease({ source, release, assets, fallbackPageUrl }) {
  if (!release || release.draft || release.prerelease) return null;
  const parsed = parseStableVersion(release.tag_name);
  if (!parsed) return null;
  const names = expectedAssetNames(parsed.text);
  const normalizedAssets = (Array.isArray(assets) ? assets : [])
    .map(normalizedAsset)
    .filter(Boolean);
  const installer = normalizedAssets.find((asset) => asset.name === names.installer);
  const checksum = normalizedAssets.find((asset) => asset.name === names.checksum);
  if (!installer) return null;
  return {
    source,
    version: parsed.text,
    tag: `v${parsed.text}`,
    name: String(release.name || release.tag_name || `v${parsed.text}`),
    releasePageUrl: String(release.html_url || fallbackPageUrl || ""),
    publishedAt: release.published_at || release.created_at || null,
    installer,
    checksum
  };
}

function publicCheck(candidate, currentVersion, checkedAt) {
  return {
    currentVersion,
    latestVersion: candidate.version,
    updateAvailable: compareVersions(candidate.version, currentVersion) > 0,
    source: candidate.source,
    releaseName: candidate.name,
    releasePageUrl: candidate.releasePageUrl,
    publishedAt: candidate.publishedAt,
    installer: {
      name: candidate.installer.name,
      size: candidate.installer.size
    },
    checkedAt
  };
}

function responseUrl(response, requestedUrl) {
  return String(response?.url || requestedUrl || "");
}

async function responseTextWithLimit(response, maximumBytes) {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maximumBytes) {
    throw new UpdateError("更新校验文件异常过大", { status: 502, code: "checksum_too_large" });
  }
  return text;
}

export class UpdateManager {
  constructor({
    currentVersion,
    serviceRoot,
    updateRoot = path.join(serviceRoot, "data", "updates"),
    fetchImpl = globalThis.fetch,
    spawnImpl = spawnProcess,
    platform = process.platform,
    now = () => Date.now(),
    cacheMilliseconds = CACHE_MILLISECONDS,
    requestTimeoutMilliseconds = REQUEST_TIMEOUT_MILLISECONDS,
    downloadTimeoutMilliseconds = DOWNLOAD_TIMEOUT_MILLISECONDS
  }) {
    const parsedCurrent = parseStableVersion(currentVersion);
    if (!parsedCurrent) throw new UpdateError(`当前版本号无效：${currentVersion}`, { code: "invalid_current_version" });
    if (typeof fetchImpl !== "function") throw new UpdateError("当前 Node.js 不支持网络更新检查");
    this.currentVersion = parsedCurrent.text;
    this.serviceRoot = path.resolve(serviceRoot);
    this.gameRoot = path.dirname(this.serviceRoot);
    this.updateRoot = path.resolve(updateRoot);
    this.fetchImpl = fetchImpl;
    this.spawnImpl = spawnImpl;
    this.platform = platform;
    this.now = now;
    this.cacheMilliseconds = cacheMilliseconds;
    this.requestTimeoutMilliseconds = requestTimeoutMilliseconds;
    this.downloadTimeoutMilliseconds = downloadTimeoutMilliseconds;
    this.cachedCandidate = null;
    this.cachedPublicCheck = null;
    this.cacheExpiresAt = 0;
    this.applying = false;
  }

  async fetchJson(url, options = {}) {
    const response = await this.fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        Accept: "application/json",
        "User-Agent": `LinliLocalMail/${this.currentVersion} (updater)`,
        ...(options.headers || {})
      },
      signal: AbortSignal.timeout(this.requestTimeoutMilliseconds)
    });
    if (!response.ok) {
      throw new UpdateError(`更新源返回 HTTP ${response.status}`, { status: 502, code: "release_http_error" });
    }
    return response.json();
  }

  async queryGitee() {
    const release = await this.fetchJson(`${GITEE_API_ROOT}/releases/latest`);
    if (!release?.id) throw new UpdateError("Gitee 最新版本响应缺少 Release ID", { status: 502 });
    const assets = await this.fetchJson(`${GITEE_API_ROOT}/releases/${release.id}/attach_files`);
    return normalizeRelease({
      source: "gitee",
      release,
      assets,
      fallbackPageUrl: `${GITEE_RELEASE_PAGE}${encodeURIComponent(String(release.tag_name || ""))}`
    });
  }

  async queryGitHub() {
    const release = await this.fetchJson(`${GITHUB_API_ROOT}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
    return normalizeRelease({
      source: "github",
      release,
      assets: release?.assets,
      fallbackPageUrl: "https://github.com/AETAVK/linli-local-mail/releases/latest"
    });
  }

  async check({ force = false } = {}) {
    const timestamp = this.now();
    if (!force && this.cachedPublicCheck && timestamp < this.cacheExpiresAt) {
      return this.cachedPublicCheck;
    }

    const settled = await Promise.allSettled([this.queryGitee(), this.queryGitHub()]);
    const candidates = settled
      .filter((item) => item.status === "fulfilled" && item.value)
      .map((item) => item.value);
    if (!candidates.length) {
      const reasons = settled
        .filter((item) => item.status === "rejected")
        .map((item) => item.reason?.message)
        .filter(Boolean);
      throw new UpdateError(
        `暂时无法连接补丁更新源${reasons.length ? `：${reasons.join("；")}` : ""}`,
        { status: 502, code: "release_sources_unavailable" }
      );
    }

    candidates.sort((left, right) => {
      const versionOrder = compareVersions(right.version, left.version);
      if (versionOrder) return versionOrder;
      return left.source === "gitee" ? -1 : 1;
    });
    const newestVersion = candidates[0].version;
    const sameVersion = candidates.filter((candidate) => candidate.version === newestVersion);
    const candidate = sameVersion.find((item) => item.source === "gitee") || sameVersion[0];
    const githubMatch = sameVersion.find((item) => item.source === "github");
    const githubDigest = githubMatch?.installer?.digest;
    if (githubDigest) candidate.expectedSha256 = githubDigest.slice("sha256:".length);

    const checkedAt = new Date(timestamp).toISOString();
    this.cachedCandidate = candidate;
    this.cachedPublicCheck = publicCheck(candidate, this.currentVersion, checkedAt);
    this.cacheExpiresAt = timestamp + this.cacheMilliseconds;
    return this.cachedPublicCheck;
  }

  async resolveExpectedSha256(candidate) {
    if (/^[0-9a-f]{64}$/i.test(String(candidate.expectedSha256 || ""))) {
      return String(candidate.expectedSha256).toLowerCase();
    }
    if (!candidate.checksum) {
      throw new UpdateError("更新版本缺少 SHA-256 校验信息", { status: 502, code: "checksum_missing" });
    }
    const response = await this.fetchImpl(candidate.checksum.downloadUrl, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": `LinliLocalMail/${this.currentVersion} (updater)` },
      signal: AbortSignal.timeout(this.requestTimeoutMilliseconds)
    });
    if (!response.ok || !isAllowedDownloadUrl(responseUrl(response, candidate.checksum.downloadUrl))) {
      throw new UpdateError("无法安全下载更新校验文件", { status: 502, code: "checksum_download_failed" });
    }
    const text = await responseTextWithLimit(response, 4096);
    const match = text.trim().match(/^([0-9a-f]{64})(?:\s+\*?.+)?$/i);
    if (!match) throw new UpdateError("更新校验文件格式无效", { status: 502, code: "checksum_invalid" });
    return match[1].toLowerCase();
  }

  sha256(filePath) {
    const hash = crypto.createHash("sha256");
    const file = fs.openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
      let bytesRead;
      do {
        bytesRead = fs.readSync(file, buffer, 0, buffer.length, null);
        if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
      } while (bytesRead);
    } finally {
      fs.closeSync(file);
    }
    return hash.digest("hex");
  }

  async downloadInstaller(candidate, expectedSha256) {
    const versionDirectory = path.join(this.updateRoot, candidate.version);
    const installerPath = path.join(versionDirectory, candidate.installer.name);
    fs.mkdirSync(versionDirectory, { recursive: true });

    if (fs.existsSync(installerPath) && this.sha256(installerPath) === expectedSha256) {
      return { installerPath, sha256: expectedSha256, reused: true };
    }

    const temporaryPath = path.join(versionDirectory, `${candidate.installer.name}.${process.pid}.part`);
    fs.rmSync(temporaryPath, { force: true });
    const response = await this.fetchImpl(candidate.installer.downloadUrl, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": `LinliLocalMail/${this.currentVersion} (updater)` },
      signal: AbortSignal.timeout(this.downloadTimeoutMilliseconds)
    });
    if (!response.ok || !response.body) {
      throw new UpdateError(`更新安装包下载失败（HTTP ${response.status}）`, { status: 502, code: "installer_download_failed" });
    }
    if (!isAllowedDownloadUrl(responseUrl(response, candidate.installer.downloadUrl))) {
      throw new UpdateError("更新安装包被重定向到非允许域名", { status: 502, code: "installer_redirect_rejected" });
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_INSTALLER_BYTES) {
      throw new UpdateError("更新安装包大小超过安全限制", { status: 502, code: "installer_too_large" });
    }

    const source = Readable.fromWeb(response.body);
    const hash = crypto.createHash("sha256");
    let received = 0;
    source.on("data", (chunk) => {
      received += chunk.length;
      hash.update(chunk);
      if (received > MAX_INSTALLER_BYTES) {
        source.destroy(new UpdateError("更新安装包大小超过安全限制", { status: 502, code: "installer_too_large" }));
      }
    });

    try {
      await pipeline(source, fs.createWriteStream(temporaryPath, { flags: "wx" }));
      if (candidate.installer.size != null && received !== candidate.installer.size) {
        throw new UpdateError(
          `更新安装包大小不一致：预期 ${candidate.installer.size}，实际 ${received}`,
          { status: 502, code: "installer_size_mismatch" }
        );
      }
      const actualSha256 = hash.digest("hex");
      if (actualSha256 !== expectedSha256) {
        throw new UpdateError("更新安装包 SHA-256 校验失败，已拒绝运行", { status: 502, code: "installer_hash_mismatch" });
      }
      fs.rmSync(installerPath, { force: true });
      fs.renameSync(temporaryPath, installerPath);
      fs.writeFileSync(
        path.join(versionDirectory, "verified-update.json"),
        `${JSON.stringify({
          version: candidate.version,
          source: candidate.source,
          installer: candidate.installer.name,
          sha256: actualSha256,
          downloadedAt: new Date(this.now()).toISOString()
        }, null, 2)}\n`,
        "utf8"
      );
      return { installerPath, sha256: actualSha256, reused: false };
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
  }

  launchInstaller(installerPath, expectedSha256) {
    if (this.platform !== "win32") {
      throw new UpdateError("一键安装更新当前只支持 Windows", { status: 501, code: "platform_unsupported" });
    }
    if (!fs.existsSync(installerPath) || this.sha256(installerPath) !== expectedSha256) {
      throw new UpdateError("准备运行的安装包未通过最终校验", { status: 409, code: "prepared_update_invalid" });
    }
    const child = this.spawnImpl(
      installerPath,
      ["--game-root", this.gameRoot, "--confirmed-update", "--wait-pid", String(process.pid)],
      {
        cwd: this.gameRoot,
        detached: true,
        stdio: "ignore",
        windowsHide: false
      }
    );
    child.unref?.();
  }

  async apply({ version } = {}) {
    if (this.applying) {
      throw new UpdateError("补丁更新已经在处理中", { status: 409, code: "update_busy" });
    }
    this.applying = true;
    try {
      const status = await this.check();
      if (!status.updateAvailable || !this.cachedCandidate) {
        throw new UpdateError("当前已经是最新补丁版本", { status: 409, code: "already_latest" });
      }
      const requested = parseStableVersion(version);
      if (!requested || requested.text !== this.cachedCandidate.version) {
        throw new UpdateError("请求安装的版本与最新检查结果不一致，请重新检查", { status: 409, code: "stale_update_request" });
      }
      const expectedSha256 = await this.resolveExpectedSha256(this.cachedCandidate);
      const prepared = await this.downloadInstaller(this.cachedCandidate, expectedSha256);
      this.launchInstaller(prepared.installerPath, expectedSha256);
      return {
        launched: true,
        version: this.cachedCandidate.version,
        source: this.cachedCandidate.source,
        sha256: expectedSha256,
        reusedDownload: prepared.reused,
        restartRequired: true
      };
    } finally {
      this.applying = false;
    }
  }
}
