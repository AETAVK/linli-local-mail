import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_NOTE_SECTIONS = Object.freeze([
  "本版新增和修复",
  "安装与升级",
  "已知限制",
  "下载与校验",
]);

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/iu;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, stableJson(value[key])]),
  );
}

function normalizeReleaseText(value) {
  return `${String(value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").trimEnd()}\n`;
}

function resolveFromRoot(root, candidate) {
  invariant(typeof candidate === "string" && candidate.trim(), "Release path must be a non-empty string");
  return path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root, candidate);
}

function readJson(filePath, label) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be a JSON object`);
  return value;
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, normalizeReleaseText(value), "utf8");
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(stableJson(value), null, 2)}\n`, "utf8");
}

export function validateVersion(value) {
  const version = String(value ?? "").trim();
  invariant(VERSION_PATTERN.test(version), `Version must use major.minor.patch: ${version || "<empty>"}`);
  return version;
}

export function versionToTag(value) {
  return `v${validateVersion(value)}`;
}

export function validateTag(value, version) {
  const tag = String(value ?? "").trim();
  const expected = versionToTag(version);
  invariant(tag === expected, `Release tag ${tag || "<empty>"} does not match ${expected}`);
  return tag;
}

export function validateSourceCommit(value) {
  const sourceCommit = String(value ?? "").trim().toLowerCase();
  invariant(COMMIT_PATTERN.test(sourceCommit), "Source commit must be a full 40-character Git SHA");
  return sourceCommit;
}

export function expectedReleaseAssetNames(versionValue) {
  const version = validateVersion(versionValue);
  const installer = `LinliLocalMail-${version}-Setup.exe`;
  return Object.freeze([
    installer,
    `${installer}.sha256`,
    `${installer}.json`,
    "LinliLocalMail-SelfSigned.cer",
  ]);
}

export function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

export function sha256Text(value) {
  return sha256Buffer(Buffer.from(String(value), "utf8"));
}

function verifySidecar(sidecarText, installerName, installerSha256) {
  const line = String(sidecarText).trim();
  const match = line.match(/^([0-9a-f]{64})\s+(.+)$/iu);
  invariant(match, "SHA-256 sidecar must contain '<64 hex>  <installer name>'");
  invariant(match[1].toLowerCase() === installerSha256, "SHA-256 sidecar does not match installer bytes");
  invariant(match[2] === installerName, "SHA-256 sidecar names a different installer");
}

function verifyBuildManifest(manifest, { version, installerName, installerSize, installerSha256, requireCurrentManifest }) {
  invariant(manifest.installer === installerName, "Build manifest installer name does not match release contract");
  invariant(
    String(manifest.installerSha256 ?? "").toLowerCase() === installerSha256,
    "Build manifest SHA-256 does not match installer bytes",
  );

  if (requireCurrentManifest) {
    invariant(manifest.version === version, "Build manifest version is missing or does not match release version");
    invariant(Number.isSafeInteger(manifest.installerSize), "Build manifest installerSize is missing or invalid");
  }
  if (manifest.version !== undefined) {
    invariant(manifest.version === version, "Build manifest version does not match release version");
  }
  if (manifest.installerSize !== undefined) {
    invariant(manifest.installerSize === installerSize, "Build manifest installerSize does not match installer bytes");
  }
}

export function inspectReleaseBundle({ root = process.cwd(), version: versionValue, requireCurrentManifest = false } = {}) {
  const version = validateVersion(versionValue);
  const releaseRoot = path.resolve(root);
  const names = expectedReleaseAssetNames(version);
  const assets = names.map((name) => {
    const filePath = path.join(releaseRoot, "dist", name);
    invariant(fs.existsSync(filePath) && fs.statSync(filePath).isFile(), `Missing release asset: dist/${name}`);
    const contents = fs.readFileSync(filePath);
    return { name, filePath, size: contents.length, sha256: sha256Buffer(contents) };
  });

  const [installer, sidecar, manifestAsset] = assets;
  verifySidecar(fs.readFileSync(sidecar.filePath, "utf8"), installer.name, installer.sha256);
  const manifest = readJson(manifestAsset.filePath, "Build manifest");
  verifyBuildManifest(manifest, {
    version,
    installerName: installer.name,
    installerSize: installer.size,
    installerSha256: installer.sha256,
    requireCurrentManifest,
  });

  return {
    version,
    installer: { ...installer },
    assets: assets.map((asset) => ({ ...asset })),
    manifest,
  };
}

export function validateReleaseNotesTemplate({ text, version: versionValue } = {}) {
  const version = validateVersion(versionValue);
  const normalized = normalizeReleaseText(text);
  const firstLine = normalized.split("\n", 1)[0];
  invariant(firstLine === `# v${version} 发布说明`, `Release notes must start with '# v${version} 发布说明'`);

  const headings = [...normalized.matchAll(/^##\s+(.+?)\s*$/gmu)];
  const names = headings.map((match) => match[1]);
  invariant(
    JSON.stringify(names) === JSON.stringify(RELEASE_NOTE_SECTIONS),
    `Release notes must use exactly these sections in order: ${RELEASE_NOTE_SECTIONS.join(", ")}`,
  );
  const preamble = normalized.slice(firstLine.length + 1, headings[0].index);
  invariant(!preamble.trim(), "Release notes must not contain a preamble before the four sections");

  return {
    version,
    text: normalized,
    headings: headings.map((match) => ({ name: match[1], index: match.index })),
    downloadSectionIndex: headings[3].index,
  };
}

function releaseDownloadUrl(host, repository, tag, name) {
  return `https://${host}/${repository}/releases/download/${tag}/${encodeURIComponent(name)}`;
}

function sizeInMiB(size) {
  return (size / (1024 * 1024)).toFixed(2);
}

export function renderReleaseBody({
  template,
  version: versionValue,
  tag: tagValue,
  bundle,
  githubRepository = "AETAVK/linli-local-mail",
  giteeRepository = "sforlife/linli-local-mail",
} = {}) {
  const version = validateVersion(versionValue);
  const tag = validateTag(tagValue, version);
  const parsed = validateReleaseNotesTemplate({ text: template, version });
  invariant(bundle?.version === version, "Release bundle version does not match release body version");
  const expectedNames = expectedReleaseAssetNames(version);
  invariant(
    JSON.stringify(bundle.assets?.map((asset) => asset.name)) === JSON.stringify(expectedNames),
    "Release bundle does not contain the exact four expected assets",
  );

  const [installer, sidecar, manifest, certificate] = bundle.assets;
  const prefix = parsed.text.slice(0, parsed.downloadSectionIndex).trimEnd();
  const downloadSection = [
    "## 下载与校验",
    "",
    `- [GitHub 下载安装器](${releaseDownloadUrl("github.com", githubRepository, tag, installer.name)})`,
    `- [Gitee 下载安装器（国内镜像）](${releaseDownloadUrl("gitee.com", giteeRepository, tag, installer.name)})`,
    `- 安装器：\`${installer.name}\``,
    `- 文件大小：\`${installer.size} bytes\`（\`${sizeInMiB(installer.size)} MiB\`）`,
    `- SHA-256：\`${installer.sha256}\``,
    `- 校验文件：\`${sidecar.name}\``,
    `- 构建清单：\`${manifest.name}\``,
    `- 自签名公钥证书：\`${certificate.name}\``,
    "",
    "若安装器计算结果与上述 SHA-256 不一致，请勿运行。",
  ].join("\n");

  return normalizeReleaseText(`${prefix}\n\n${downloadSection}`);
}

function receiptAssets(assets) {
  return assets.map(({ name, size, sha256 }) => ({
    name: String(name),
    sha256: String(sha256).toLowerCase(),
    size: Number(size),
  }));
}

export function createReleaseReceipt({
  version: versionValue,
  tag: tagValue,
  sourceCommit: sourceCommitValue,
  body,
  assets,
} = {}) {
  const version = validateVersion(versionValue);
  const tag = validateTag(tagValue, version);
  const sourceCommit = validateSourceCommit(sourceCommitValue);
  const normalizedBody = normalizeReleaseText(body);
  const normalizedAssets = receiptAssets(assets ?? []);
  invariant(
    JSON.stringify(normalizedAssets.map((asset) => asset.name)) === JSON.stringify(expectedReleaseAssetNames(version)),
    "Release receipt requires the exact four expected assets in contract order",
  );
  for (const asset of normalizedAssets) {
    invariant(Number.isSafeInteger(asset.size) && asset.size >= 0, `Invalid release asset size: ${asset.name}`);
    invariant(/^[0-9a-f]{64}$/u.test(asset.sha256), `Invalid release asset SHA-256: ${asset.name}`);
  }

  return stableJson({
    schemaVersion: 1,
    tag,
    version,
    sourceCommit,
    bodySha256: sha256Text(normalizedBody),
    bodySize: Buffer.byteLength(normalizedBody, "utf8"),
    assets: normalizedAssets,
  });
}

export function validateReleaseReceipt({
  receipt,
  version: versionValue,
  tag: tagValue,
  sourceCommit: sourceCommitValue,
  body,
  assets,
} = {}) {
  invariant(receipt && typeof receipt === "object" && !Array.isArray(receipt), "Release receipt must be an object");
  const expected = createReleaseReceipt({
    version: versionValue,
    tag: tagValue,
    sourceCommit: sourceCommitValue ?? receipt.sourceCommit,
    body,
    assets,
  });
  invariant(JSON.stringify(stableJson(receipt)) === JSON.stringify(expected), "Release receipt does not match body or assets");
  return expected;
}

function validateGithubMetadata({ metadata, version, tag, bundle }) {
  invariant(metadata && typeof metadata === "object" && !Array.isArray(metadata), "GitHub Release metadata must be an object");
  invariant(metadata.tagName === tag, `GitHub Release tag does not match ${tag}`);
  invariant(metadata.isDraft === false, "GitHub Release is still a draft");
  invariant(metadata.isPrerelease === false, "GitHub Release is a prerelease");
  validateReleaseNotesTemplate({ text: metadata.body, version });

  const remoteAssets = Array.isArray(metadata.assets) ? metadata.assets : [];
  const expectedNames = expectedReleaseAssetNames(version);
  invariant(remoteAssets.length === expectedNames.length, "GitHub Release must expose exactly four uploaded assets");
  const byName = new Map(remoteAssets.map((asset) => [asset.name, asset]));
  invariant(byName.size === remoteAssets.length, "GitHub Release contains duplicate asset names");
  invariant(expectedNames.every((name) => byName.has(name)), "GitHub Release asset names do not match the release contract");

  for (const local of bundle.assets) {
    const remote = byName.get(local.name);
    invariant(Number(remote.size) === local.size, `GitHub Release asset size mismatch: ${local.name}`);
    if (remote.digest !== undefined && remote.digest !== null && String(remote.digest).trim()) {
      invariant(String(remote.digest).toLowerCase() === `sha256:${local.sha256}`, `GitHub Release asset digest mismatch: ${local.name}`);
    }
  }
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    invariant(key.startsWith("--"), `Unexpected CLI argument: ${key}`);
    const value = rest[index + 1];
    invariant(value !== undefined && !value.startsWith("--"), `Missing value for ${key}`);
    invariant(values[key] === undefined, `Duplicate CLI argument: ${key}`);
    values[key] = value;
    index += 1;
  }
  return { command, values };
}

function required(values, name) {
  invariant(typeof values[name] === "string" && values[name].trim(), `Missing required option: ${name}`);
  return values[name];
}

async function runCli(argv) {
  const { command, values } = parseCli(argv);
  const root = path.resolve(values["--root"] || process.cwd());

  if (command === "prepare") {
    const version = validateVersion(required(values, "--version"));
    const tag = validateTag(required(values, "--tag"), version);
    const sourceCommit = validateSourceCommit(required(values, "--source-commit"));
    const notesPath = resolveFromRoot(root, required(values, "--notes"));
    const bodyPath = resolveFromRoot(root, required(values, "--body-output"));
    const receiptPath = resolveFromRoot(root, required(values, "--receipt-output"));
    const bundle = inspectReleaseBundle({ root, version, requireCurrentManifest: true });
    const body = renderReleaseBody({ template: fs.readFileSync(notesPath, "utf8"), version, tag, bundle });
    const receipt = createReleaseReceipt({ version, tag, sourceCommit, body, assets: bundle.assets });
    writeText(bodyPath, body);
    writeJson(receiptPath, receipt);
    validateReleaseReceipt({ receipt, version, tag, sourceCommit, body: fs.readFileSync(bodyPath, "utf8"), assets: bundle.assets });
    return { command, tag, version, sourceCommit, body: path.relative(root, bodyPath), receipt: path.relative(root, receiptPath), bodySha256: receipt.bodySha256, assets: receipt.assets };
  }

  if (command === "verify") {
    const version = validateVersion(required(values, "--version"));
    const tag = validateTag(required(values, "--tag"), version);
    const bodyPath = resolveFromRoot(root, required(values, "--body"));
    const receiptPath = resolveFromRoot(root, required(values, "--receipt"));
    const receipt = readJson(receiptPath, "Release receipt");
    const sourceCommit = values["--source-commit"] === undefined
      ? validateSourceCommit(receipt.sourceCommit)
      : validateSourceCommit(values["--source-commit"]);
    const bundle = inspectReleaseBundle({ root, version, requireCurrentManifest: true });
    validateReleaseNotesTemplate({ text: fs.readFileSync(bodyPath, "utf8"), version });
    const verified = validateReleaseReceipt({ receipt, version, tag, sourceCommit, body: fs.readFileSync(bodyPath, "utf8"), assets: bundle.assets });
    return { command, tag, version, sourceCommit, bodySha256: verified.bodySha256, assets: verified.assets };
  }

  if (command === "extract-github") {
    const metadataPath = resolveFromRoot(root, required(values, "--metadata"));
    const bodyPath = resolveFromRoot(root, required(values, "--body-output"));
    const receiptPath = resolveFromRoot(root, required(values, "--receipt-output"));
    const sourceCommit = validateSourceCommit(required(values, "--source-commit"));
    const metadata = readJson(metadataPath, "GitHub Release metadata");
    const tag = String(metadata.tagName ?? "").trim();
    invariant(/^v\d+\.\d+\.\d+$/u.test(tag), "GitHub Release tag must use vmajor.minor.patch");
    const version = validateVersion(tag.slice(1));
    const bundle = inspectReleaseBundle({ root, version, requireCurrentManifest: false });
    validateGithubMetadata({ metadata, version, tag, bundle });
    const body = normalizeReleaseText(metadata.body);
    const receipt = createReleaseReceipt({ version, tag, sourceCommit, body, assets: bundle.assets });
    writeText(bodyPath, body);
    writeJson(receiptPath, receipt);
    return { command, tag, version, sourceCommit, body: path.relative(root, bodyPath), receipt: path.relative(root, receiptPath), bodySha256: receipt.bodySha256, assets: receipt.assets };
  }

  throw new Error("Usage: release-contract.mjs <prepare|verify|extract-github> [options]");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`[release-contract] ${error?.message || error}\n`);
      process.exitCode = 1;
    });
}
