import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  inspectReleaseBundle,
  sha256File,
  sha256Text,
  validateReleaseNotesTemplate,
  validateReleaseReceipt,
  validateSourceCommit,
  validateTag,
  validateVersion,
} from "./release-contract.mjs";

const curlCommand = process.platform === "win32" ? "curl.exe" : "curl";
const transferMaxTimeSeconds = "900";
const transferSpeedLimitBytes = "1";
const transferSpeedTimeSeconds = "90";
const transferStdoutMaxBytes = 2_000_000;
const transferStderrTailBytes = 8_192;
const token = String(process.env.GITEE_TOKEN || "").trim();
const repository = String(process.env.GITEE_REPOSITORY || "sforlife/linli-local-mail").trim();
const releaseTag = String(process.env.GITEE_RELEASE_TAG || "").trim();

function redact(value) {
  const text = String(value ?? "");
  const secrets = [...new Set([token, String(process.env.GITEE_TOKEN || "").trim()].filter(Boolean))];
  return secrets.reduce((redacted, secret) => redacted.split(secret).join("[REDACTED]"), text);
}

function fail(message) {
  throw new Error(redact(message));
}

export function normalizeReleaseBody(value) {
  return `${String(value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").trimEnd()}\n`;
}

function asItems(payload, label) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  fail(`Gitee ${label} 响应不是数组`);
}

function attachmentName(attachment) {
  return String(attachment?.name || attachment?.file_name || attachment?.filename || "");
}

function attachmentId(attachment) {
  return attachment?.id ?? attachment?.attachment_id ?? null;
}

function attachmentSize(attachment) {
  const value = Number(attachment?.size ?? attachment?.file_size ?? Number.NaN);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function planAttachmentSync(expectedAssets, existingAttachments) {
  const expectedNames = new Set(expectedAssets.map((asset) => asset.name));
  const unexpectedAttachments = existingAttachments.filter((attachment) => !expectedNames.has(attachmentName(attachment)));
  if (unexpectedAttachments.length) {
    const names = unexpectedAttachments.map((attachment) => attachmentName(attachment) || "(无名称)");
    fail(`Gitee Release 存在契约外附件：${names.join("、")}`);
  }
  const result = { upload: [], verify: [] };
  for (const asset of expectedAssets) {
    const matching = existingAttachments.filter((attachment) => attachmentName(attachment) === asset.name);
    if (matching.length > 1) fail(`Gitee Release 存在重复附件：${asset.name}`);
    if (matching.length === 0) {
      result.upload.push(asset);
      continue;
    }
    const remoteSize = attachmentSize(matching[0]);
    if (remoteSize !== null && remoteSize !== asset.size) {
      fail(`Gitee 已发布附件大小冲突：${asset.name}，本地 ${asset.size}，远端 ${remoteSize}；请发布新版本`);
    }
    result.verify.push({ asset, attachment: matching[0] });
  }

  const duplicatesOutsideContract = existingAttachments.filter((attachment, index, all) => {
    const name = attachmentName(attachment);
    return expectedNames.has(name) && all.findIndex((candidate) => attachmentName(candidate) === name) !== index;
  });
  if (duplicatesOutsideContract.length) fail("Gitee Release 存在重复的契约附件");
  return result;
}

async function request(apiRoot, endpoint, options = {}) {
  const { allow404 = false, ...fetchOptions } = options;
  const response = await fetch(`${apiRoot}${endpoint}`, {
    redirect: "error",
    ...fetchOptions,
    signal: fetchOptions.signal || AbortSignal.timeout(60_000),
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "linli-local-mail-github-release",
      ...(fetchOptions.headers || {}),
    },
  });
  const rawBody = await response.text();
  let body = null;
  if (rawBody) {
    try { body = JSON.parse(rawBody); } catch { body = rawBody; }
  }
  if (response.status === 404 && allow404) return null;
  if (!response.ok) {
    const detail = typeof body === "string" ? body : JSON.stringify(body);
    const error = new Error(`Gitee API ${response.status} ${response.statusText}: ${redact(detail).slice(0, 800)}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function getRelease(apiRoot) {
  const payload = await request(apiRoot, `/releases/tags/${encodeURIComponent(releaseTag)}`, { allow404: true });
  return payload?.id ? payload : null;
}

async function waitForRelease(apiRoot) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const release = await getRelease(apiRoot);
    if (release) return release;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  return null;
}

function temporaryCurlHeaders(directory) {
  const headerFile = path.join(directory, "headers.txt");
  fs.writeFileSync(
    headerFile,
    [`Authorization: Bearer ${token}`, "Accept: application/octet-stream", "User-Agent: linli-local-mail-github-release"].join("\r\n") + "\r\n",
    "utf8",
  );
  return headerFile;
}

function curlConfigValue(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\r", "\\r").replaceAll("\n", "\\n")}"`;
}

function temporaryCurlConfig(directory, entries) {
  const configFile = path.join(directory, "curl.conf");
  fs.writeFileSync(
    configFile,
    entries.map(([key, value]) => value === null ? key : `${key} = ${curlConfigValue(value)}`).join("\n") + "\n",
    "utf8",
  );
  return configFile;
}

function parseCurlProgress(chunk) {
  const matches = [...String(chunk).matchAll(/(?:^|\s)(\d{1,3}(?:\.\d+)?)%/gu)];
  const value = matches.length ? Number(matches.at(-1)[1]) : null;
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

export function runCurlTransfer(configFile, label, curlOptions = [], { log = console.log } = {}) {
  return new Promise((resolve, reject) => {
    const safeLabel = redact(label);
    const startedAt = Date.now();
    let latestProgress = null;
    let lastProgressAt = 0;
    let lastReportedAt = startedAt;
    let stdout = "";
    let stdoutBytes = 0;
    let stderrTail = Buffer.alloc(0);
    let settled = false;

    const clearHeartbeat = (error) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      if (error) {
        try { child.kill(); } catch { /* child may already be closed */ }
        reject(error);
      }
    };
    const appendStderrTail = (chunk) => {
      const combined = Buffer.concat([stderrTail, chunk]);
      stderrTail = combined.subarray(Math.max(0, combined.length - transferStderrTailBytes));
    };

    log(`[gitee-release] ${safeLabel} transfer started`);
    const child = spawn(curlCommand, [...curlOptions, "--config", configFile], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const reportProgress = (value) => {
      const now = Date.now();
      latestProgress = value;
      lastProgressAt = now;
      if (now - lastReportedAt >= 30_000 || value >= 100) {
        log(`[gitee-release] ${safeLabel} transfer progress ${Math.round(value)}%`);
        lastReportedAt = now;
      }
    };
    const heartbeat = setInterval(() => {
      const now = Date.now();
      if (latestProgress !== null && now - lastProgressAt < 35_000 && now - lastReportedAt >= 30_000) {
        log(`[gitee-release] ${safeLabel} transfer progress ${Math.round(latestProgress)}%`);
        lastReportedAt = now;
      }
    }, 30_000);
    heartbeat.unref?.();

    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > transferStdoutMaxBytes) {
        clearHeartbeat(new Error(`Gitee ${safeLabel} transfer stdout exceeded ${transferStdoutMaxBytes} bytes`));
        return;
      }
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      if (settled) return;
      appendStderrTail(chunk);
      const progress = parseCurlProgress(chunk.toString());
      if (progress !== null) reportProgress(progress);
    });
    child.on("error", (error) => {
      if (settled) return;
      clearHeartbeat(new Error(`Gitee ${safeLabel} transfer could not start: ${redact(error.message)}`));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      clearInterval(heartbeat);
      settled = true;
      const durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      if (code !== 0) {
        const detail = stderrTail.toString("utf8").trim().split(/\r?\n/u).at(-1)?.slice(0, 400) || `exit code ${code ?? "unknown"}`;
        reject(new Error(`Gitee ${safeLabel} transfer failed after ${durationSeconds}s: ${redact(detail)}${signal ? ` (${signal})` : ""}`));
        return;
      }
      log(`[gitee-release] ${safeLabel} transfer finished in ${durationSeconds}s`);
      resolve(stdout);
    });
  });
}

async function uploadAttachment(apiRoot, releaseId, asset) {
  const temporaryDirectory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "linli-gitee-upload-"));
  const headerFile = temporaryCurlHeaders(temporaryDirectory);
  const configFile = temporaryCurlConfig(temporaryDirectory, [
    ["header", `@${headerFile}`],
    ["header", "Expect:"],
    ["form-string", `access_token=${token}`],
    ["form", `file=@${asset.filePath};type=application/octet-stream`],
    ["url", `${apiRoot}/releases/${releaseId}/attach_files`],
  ]);
  try {
    const stdout = await runCurlTransfer(configFile, `upload ${asset.name}`, [
      "--show-error", "--fail-with-body", "--location", "--http1.1",
      "--connect-timeout", "30", "--max-time", transferMaxTimeSeconds,
      "--speed-limit", transferSpeedLimitBytes, "--speed-time", transferSpeedTimeSeconds,
      "--progress-bar",
    ]);
    if (!stdout) return null;
    try { return JSON.parse(stdout); } catch { return stdout; }
  } catch (error) {
    throw new Error(`Gitee 附件上传失败 ${redact(asset.name)}: ${redact(error?.message || error).slice(0, 800)}`);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function downloadAndHashAttachment(apiRoot, releaseId, attachment, expected) {
  const id = attachmentId(attachment);
  if (id === null) fail(`Gitee 附件缺少 ID：${expected.name}`);
  const temporaryDirectory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "linli-gitee-verify-"));
  const headerFile = temporaryCurlHeaders(temporaryDirectory);
  const outputPath = path.join(temporaryDirectory, expected.name);
  const configFile = temporaryCurlConfig(temporaryDirectory, [
    ["header", `@${headerFile}`],
    ["output", outputPath],
    ["url", `${apiRoot}/releases/${releaseId}/attach_files/${encodeURIComponent(String(id))}/download`],
  ]);
  try {
    await runCurlTransfer(configFile, `download ${expected.name}`, [
      "--show-error", "--fail", "--location", "--http1.1",
      "--connect-timeout", "30", "--max-time", transferMaxTimeSeconds,
      "--speed-limit", transferSpeedLimitBytes, "--speed-time", transferSpeedTimeSeconds,
      "--progress-bar",
    ]);
    const size = fs.statSync(outputPath).size;
    if (size !== expected.size) fail(`Gitee 附件下载大小不一致：${expected.name}，预期 ${expected.size}，实际 ${size}`);
    const digest = sha256File(outputPath);
    if (digest !== expected.sha256) fail(`Gitee 附件 SHA-256 不一致：${expected.name}；不会覆盖，请发布新版本`);
    return digest;
  } catch (error) {
    throw new Error(`Gitee 附件远端复核失败 ${redact(expected.name)}: ${redact(error?.message || error).slice(0, 800)}`);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function hasAttachment(attachments, expectedName) {
  return attachments.some((attachment) => attachmentName(attachment) === expectedName);
}

const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const ambiguousInventoryRetryDelays = [0, 1_000, 2_000];

export async function syncGiteeAttachments({
  expectedAssets,
  initialAttachments,
  refreshAttachments,
  uploadAttachment: upload,
  verifyAttachment: verify,
  publishBody,
  maxInventoryRefreshes = 3,
  sleep = defaultSleep,
}) {
  if (!Array.isArray(expectedAssets) || expectedAssets.length !== 4) {
    fail("Gitee 附件同步必须接收完整的四资产契约");
  }
  if (typeof refreshAttachments !== "function" || typeof upload !== "function" || typeof verify !== "function") {
    fail("Gitee 附件同步缺少注入的库存、上传或复核函数");
  }
  if (publishBody !== undefined && typeof publishBody !== "function") {
    fail("Gitee 正文发布函数必须是函数");
  }
  if (!Number.isInteger(maxInventoryRefreshes) || maxInventoryRefreshes < 1 || maxInventoryRefreshes > 3) {
    fail("Gitee 不确定上传库存刷新次数必须是 1 到 3 的整数");
  }
  if (typeof sleep !== "function") fail("Gitee 不确定上传重试等待函数必须是函数");

  let attachments = initialAttachments;
  const results = [];
  const initialPlan = planAttachmentSync(expectedAssets, attachments);
  for (const asset of initialPlan.upload) {
    attachments = await refreshAttachments({ reason: "before-upload", asset });
    const currentPlan = planAttachmentSync(expectedAssets, attachments);
    if (!currentPlan.upload.some((candidate) => candidate.name === asset.name)) continue;
    if (hasAttachment(attachments, asset.name)) continue;
    try {
      await upload(asset);
      results.push({ name: asset.name, status: "uploaded", size: asset.size, sha256: asset.sha256 });
    } catch (error) {
      let reconciled = false;
      let lastRefreshError = error;
      for (let attempt = 1; attempt <= maxInventoryRefreshes; attempt += 1) {
        if (attempt > 1) await sleep(ambiguousInventoryRetryDelays[attempt - 1]);
        let refreshed;
        try {
          refreshed = await refreshAttachments({ reason: "upload-uncertain", asset, attempt });
        } catch (refreshError) {
          lastRefreshError = refreshError;
          continue;
        }
        planAttachmentSync(expectedAssets, refreshed);
        if (hasAttachment(refreshed, asset.name)) {
          reconciled = true;
          attachments = refreshed;
          break;
        }
        attachments = refreshed;
      }
      if (!reconciled) {
        fail(`Gitee 附件上传状态不明确：${asset.name}；已刷新库存 ${maxInventoryRefreshes} 次仍未确认，安全停止，请重新运行。原因：${redact(lastRefreshError?.message || lastRefreshError).slice(0, 500)}`);
      }
      results.push({ name: asset.name, status: "reconciled", size: asset.size, sha256: asset.sha256 });
    }
  }

  attachments = await refreshAttachments({ reason: "post-upload" });
  planAttachmentSync(expectedAssets, attachments);
  for (const asset of expectedAssets) {
    const matching = attachments.filter((attachment) => attachmentName(attachment) === asset.name);
    if (matching.length !== 1) fail(`Gitee Release 附件缺失或重名：${asset.name}`);
    await verify(matching[0], asset);
    if (!results.some((entry) => entry.name === asset.name)) {
      results.push({ name: asset.name, status: "skipped", size: asset.size, sha256: asset.sha256 });
    }
  }

  if (publishBody) await publishBody();
  return { attachments, results };
}

async function main() {
  if (!token) fail("未配置 GITEE_TOKEN");
  const repositoryParts = repository.split("/");
  if (repositoryParts.length !== 2 || repositoryParts.some((part) => !part)) fail(`GITEE_REPOSITORY 必须是 owner/repository：${repository}`);
  const match = releaseTag.match(/^v(\d+\.\d+\.\d+)$/u);
  if (!match) fail(`GITEE_RELEASE_TAG 必须符合 v<major>.<minor>.<patch>：${releaseTag}`);
  const version = validateVersion(match[1]);
  validateTag(releaseTag, version);

  const root = process.cwd();
  const bodyFile = path.resolve(root, process.env.GITEE_RELEASE_BODY_FILE || "dist/release-body.md");
  const receiptFile = path.resolve(root, process.env.GITEE_RELEASE_RECEIPT_FILE || "dist/release-receipt.json");
  if (!fs.existsSync(bodyFile)) fail(`缺少 GitHub Release 正文文件：${bodyFile}`);
  if (!fs.existsSync(receiptFile)) fail(`缺少 GitHub Release 收据：${receiptFile}`);
  const body = normalizeReleaseBody(fs.readFileSync(bodyFile, "utf8"));
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  const sourceCommit = validateSourceCommit(process.env.GITEE_SOURCE_COMMIT || receipt.sourceCommit);
  validateReleaseNotesTemplate({ text: body, version });
  const bundle = inspectReleaseBundle({ root, version, requireCurrentManifest: false });
  validateReleaseReceipt({ receipt, version, tag: releaseTag, sourceCommit, body, assets: bundle.assets });

  const [owner, repo] = repositoryParts;
  const apiRoot = `https://gitee.com/api/v5/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  let release = await getRelease(apiRoot);
  let created = false;
  if (!release) {
    const form = new URLSearchParams({
      tag_name: releaseTag,
      name: `Linli Local Mail ${version}`,
      target_commitish: String(process.env.GITEE_TARGET_COMMIT || releaseTag),
      body: "镜像同步中，附件尚未完成校验，请暂勿下载。",
      prerelease: "false",
    });
    await request(apiRoot, "/releases", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    release = await waitForRelease(apiRoot);
    created = true;
  }
  if (!release?.id) fail(`无法取得 Gitee Release ${releaseTag} 的 ID`);

  const releaseId = encodeURIComponent(String(release.id));
  let attachments = asItems(await request(apiRoot, `/releases/${releaseId}/attach_files`), "附件");
  const syncResult = await syncGiteeAttachments({
    expectedAssets: bundle.assets,
    initialAttachments: attachments,
    refreshAttachments: async () => asItems(await request(apiRoot, `/releases/${releaseId}/attach_files`), "附件"),
    uploadAttachment: (asset) => uploadAttachment(apiRoot, releaseId, asset),
    verifyAttachment: (attachment, asset) => downloadAndHashAttachment(apiRoot, releaseId, attachment, asset),
    publishBody: async () => {
      if (normalizeReleaseBody(release.body) !== body) {
        await request(apiRoot, `/releases/${releaseId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ tag_name: releaseTag, name: `Linli Local Mail ${version}`, body }),
        });
      }
    },
  });
  const results = syncResult.results;

  release = await getRelease(apiRoot);
  const finalBody = normalizeReleaseBody(release?.body);
  if (finalBody !== body || sha256Text(finalBody) !== receipt.bodySha256) {
    fail("Gitee Release 最终正文与 GitHub Release 正文不一致");
  }

  console.log(JSON.stringify({
    repository,
    tag: releaseTag,
    sourceCommit,
    bodySha256: receipt.bodySha256,
    created,
    releaseUrl: `https://gitee.com/${owner}/${repo}/releases/tag/${encodeURIComponent(releaseTag)}`,
    assets: results.sort((left, right) => left.name.localeCompare(right.name)),
  }, null, 2));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[gitee-release] ${redact(error?.stack || error?.message || error)}`);
    process.exitCode = 1;
  });
}
