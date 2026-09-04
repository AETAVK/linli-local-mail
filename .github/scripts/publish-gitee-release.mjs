import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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

const execFileAsync = promisify(execFile);
const curlCommand = process.platform === "win32" ? "curl.exe" : "curl";
const token = String(process.env.GITEE_TOKEN || "").trim();
const repository = String(process.env.GITEE_REPOSITORY || "sforlife/linli-local-mail").trim();
const releaseTag = String(process.env.GITEE_RELEASE_TAG || "").trim();

function redact(value) {
  const text = String(value ?? "");
  return token ? text.split(token).join("[REDACTED]") : text;
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

async function uploadAttachment(apiRoot, releaseId, asset) {
  const temporaryDirectory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "linli-gitee-upload-"));
  const headerFile = temporaryCurlHeaders(temporaryDirectory);
  try {
    const { stdout } = await execFileAsync(curlCommand, [
      "--silent", "--show-error", "--fail-with-body", "--location", "--http1.1",
      "--connect-timeout", "30", "--max-time", "900",
      "--header", `@${headerFile}`, "--header", "Expect:",
      "--form-string", `access_token=${token}`,
      "--form", `file=@${asset.filePath};type=application/octet-stream`,
      `${apiRoot}/releases/${releaseId}/attach_files`,
    ], { windowsHide: true, maxBuffer: 2_000_000 });
    if (!stdout) return null;
    try { return JSON.parse(stdout); } catch { return stdout; }
  } catch (error) {
    const details = [error?.message, error?.stderr, error?.stdout].filter(Boolean).join(" ");
    throw new Error(`Gitee 附件上传失败 ${asset.name}: ${redact(details).slice(0, 800)}`);
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
  try {
    await execFileAsync(curlCommand, [
      "--silent", "--show-error", "--fail", "--location", "--http1.1",
      "--connect-timeout", "30", "--max-time", "900",
      "--header", `@${headerFile}`, "--output", outputPath,
      `${apiRoot}/releases/${releaseId}/attach_files/${encodeURIComponent(String(id))}/download`,
    ], { windowsHide: true, maxBuffer: 2_000_000 });
    const size = fs.statSync(outputPath).size;
    if (size !== expected.size) fail(`Gitee 附件下载大小不一致：${expected.name}，预期 ${expected.size}，实际 ${size}`);
    const digest = sha256File(outputPath);
    if (digest !== expected.sha256) fail(`Gitee 附件 SHA-256 不一致：${expected.name}；不会覆盖，请发布新版本`);
    return digest;
  } catch (error) {
    throw new Error(`Gitee 附件远端复核失败 ${expected.name}: ${redact(error?.message || error).slice(0, 800)}`);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
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
  const plan = planAttachmentSync(bundle.assets, attachments);
  const results = [];

  for (const asset of plan.upload) {
    await uploadAttachment(apiRoot, releaseId, asset);
    results.push({ name: asset.name, status: "uploaded", size: asset.size, sha256: asset.sha256 });
  }

  attachments = asItems(await request(apiRoot, `/releases/${releaseId}/attach_files`), "附件");
  planAttachmentSync(bundle.assets, attachments);
  for (const asset of bundle.assets) {
    const matching = attachments.filter((attachment) => attachmentName(attachment) === asset.name);
    if (matching.length !== 1) fail(`Gitee Release 附件缺失或重名：${asset.name}`);
    await downloadAndHashAttachment(apiRoot, releaseId, matching[0], asset);
    if (!results.some((entry) => entry.name === asset.name)) {
      results.push({ name: asset.name, status: "skipped", size: asset.size, sha256: asset.sha256 });
    }
  }

  if (normalizeReleaseBody(release.body) !== body) {
    await request(apiRoot, `/releases/${releaseId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ tag_name: releaseTag, name: `Linli Local Mail ${version}`, body }),
    });
  }

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
