import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const token = String(process.env.GITEE_TOKEN || "").trim();
const repository = String(process.env.GITEE_REPOSITORY || "sforlife/linli-local-mail").trim();
const releaseTag = String(
  process.env.GITEE_RELEASE_TAG || process.env.GITHUB_REF_NAME || "",
).trim();

function redact(value) {
  const text = String(value ?? "");
  return token ? text.split(token).join("[REDACTED]") : text;
}

function fail(message) {
  throw new Error(redact(message));
}

function asItems(payload, label) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  fail(`Gitee ${label} 响应不是数组`);
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
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = rawBody;
    }
  }

  if (response.status === 404 && allow404) return null;
  if (!response.ok) {
    const detail = typeof body === "string" ? body : JSON.stringify(body);
    const error = new Error(
      `Gitee API ${response.status} ${response.statusText}: ${redact(detail).slice(0, 800)}`,
    );
    error.status = response.status;
    throw error;
  }
  return body;
}

function attachmentName(attachment) {
  return String(
    attachment?.name || attachment?.file_name || attachment?.filename || "",
  );
}

function attachmentId(attachment) {
  return attachment?.id ?? attachment?.attachment_id ?? null;
}

function readRelease(version, root) {
  const names = [
    `LinliLocalMail-${version}-Setup.exe`,
    `LinliLocalMail-${version}-Setup.exe.sha256`,
    `LinliLocalMail-${version}-Setup.exe.json`,
    "LinliLocalMail-SelfSigned.cer",
  ];

  return names.map((name) => {
    const filePath = path.join(root, "dist", name);
    if (!fs.existsSync(filePath)) fail(`缺少发布产物: ${path.join("dist", name)}`);
    const content = fs.readFileSync(filePath);
    return {
      name,
      filePath,
      size: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  });
}

function readReleaseNotes(version, root) {
  const filePath = path.join(root, ".github", "release-notes", `v${version}.md`);
  if (!fs.existsSync(filePath)) fail(`缺少版本专属 Release 说明: ${path.relative(root, filePath)}`);
  const notes = fs.readFileSync(filePath, "utf8").trim();
  if (!notes) fail(`版本专属 Release 说明不能为空: ${path.relative(root, filePath)}`);
  return notes;
}

async function getRelease(apiRoot) {
  const payload = await request(
    apiRoot,
    `/releases/tags/${encodeURIComponent(releaseTag)}`,
    { allow404: true },
  );
  return payload?.id ? payload : null;
}

async function waitForRelease(apiRoot) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const release = await getRelease(apiRoot);
    if (release) return release;
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  return null;
}

async function uploadAttachment(apiRoot, releaseId, asset) {
  const endpoint = `${apiRoot}/releases/${releaseId}/attach_files`;
  const temporaryDirectory = fs.mkdtempSync(
    path.join(process.env.RUNNER_TEMP || os.tmpdir(), "linli-gitee-upload-"),
  );
  const headerFile = path.join(temporaryDirectory, "headers.txt");
  fs.writeFileSync(
    headerFile,
    [
      `Authorization: Bearer ${token}`,
      "Accept: application/json",
      "User-Agent: linli-local-mail-github-release",
    ].join("\r\n") + "\r\n",
    "utf8",
  );

  try {
    const args = [
      "--silent",
      "--show-error",
      "--fail-with-body",
      "--location",
      "--http1.1",
      "--connect-timeout",
      "30",
      "--max-time",
      "900",
      "--header",
      `@${headerFile}`,
      "--header",
      "Expect:",
      "--form",
      `file=@${asset.filePath};type=application/octet-stream`,
      endpoint,
    ];
    const { stdout, stderr } = await execFileAsync("curl.exe", args, {
      windowsHide: true,
      maxBuffer: 2_000_000,
    });
    if (stdout) {
      try {
        return JSON.parse(stdout);
      } catch {
        return stdout;
      }
    }
    return null;
  } catch (error) {
    const details = [error?.message, error?.stderr, error?.stdout]
      .filter(Boolean)
      .join(" ");
    throw new Error(
      `Gitee 附件上传失败 ${asset.name}: ${redact(details).slice(0, 800)}`,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main() {
  if (!token) {
    fail(
      "未配置 GITEE_TOKEN。请通过本机进程环境变量或 Gitee Go 安全变量注入 Gitee 访问令牌。",
    );
  }

  const repositoryParts = repository.split("/");
  if (repositoryParts.length !== 2 || repositoryParts.some((part) => !part)) {
    fail(`GITEE_REPOSITORY 必须是 owner/repository：${repository}`);
  }
  if (!/^v\d+\.\d+\.\d+$/.test(releaseTag)) {
    fail(`GITEE_RELEASE_TAG 必须符合 v<major>.<minor>.<patch>：${releaseTag}`);
  }

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
  );
  const packageVersion = String(packageJson.version || "").trim();
  const versionMatch = releaseTag.match(/^v(\d+\.\d+\.\d+)$/);
  if (!versionMatch) {
    fail(`Gitee Release 标签格式无效：${releaseTag}`);
  }
  const version = versionMatch[1];
  if (releaseTag !== `v${packageVersion}` && process.env.GITEE_ALLOW_VERSION_MISMATCH !== "1") {
    fail(`Gitee Release 标签 ${releaseTag} 与 package.json 版本 ${packageVersion} 不一致`);
  }

  const [owner, repo] = repositoryParts;
  const apiRoot = `https://gitee.com/api/v5/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const root = process.cwd();
  const assets = readRelease(version, root);
  const releaseBody = readReleaseNotes(version, root);

  let release = await getRelease(apiRoot);
  if (!release) {
    const form = new URLSearchParams({
      tag_name: releaseTag,
      name: `Linli Local Mail ${version}`,
      target_commitish: String(process.env.GITEE_TARGET_COMMIT || releaseTag),
      body: releaseBody,
      prerelease: "false",
    });
    await request(apiRoot, "/releases", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    release = await waitForRelease(apiRoot);
  } else {
    await request(apiRoot, `/releases/${encodeURIComponent(String(release.id))}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        tag_name: releaseTag,
        name: `Linli Local Mail ${version}`,
        body: releaseBody,
      }),
    });
  }

  if (!release?.id) {
    fail(`无法取得 Gitee Release ${releaseTag} 的 ID`);
  }

  const releaseId = encodeURIComponent(String(release.id));
  const existing = asItems(
    await request(apiRoot, `/releases/${releaseId}/attach_files`),
    "附件",
  );

  for (const asset of assets) {
    const matching = existing.filter(
      (attachment) => attachmentName(attachment) === asset.name,
    );
    for (const attachment of matching) {
      const id = attachmentId(attachment);
      if (id === null) fail(`Gitee 附件缺少 ID：${asset.name}`);
      await request(
        apiRoot,
        `/releases/${releaseId}/attach_files/${encodeURIComponent(String(id))}`,
        { method: "DELETE" },
      );
    }

    await uploadAttachment(apiRoot, releaseId, asset);
    console.log(
      `已同步 ${asset.name} (${asset.size} bytes, sha256 ${asset.sha256})`,
    );
  }

  const finalAttachments = asItems(
    await request(apiRoot, `/releases/${releaseId}/attach_files`),
    "附件",
  );
  for (const asset of assets) {
    const remote = finalAttachments.find(
      (attachment) => attachmentName(attachment) === asset.name,
    );
    if (!remote) fail(`Gitee Release 缺少附件：${asset.name}`);
    const remoteSize = Number(remote.size ?? remote.file_size ?? NaN);
    if (Number.isFinite(remoteSize) && remoteSize > 0 && remoteSize !== asset.size) {
      fail(`Gitee 附件大小不匹配：${asset.name}，本地 ${asset.size}，远端 ${remoteSize}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        repository,
        tag: releaseTag,
        releaseUrl: `https://gitee.com/${owner}/${repo}/releases/tag/${encodeURIComponent(releaseTag)}`,
        assets: assets.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(`[gitee-release] ${redact(error?.stack || error?.message || error)}`);
  process.exitCode = 1;
});
