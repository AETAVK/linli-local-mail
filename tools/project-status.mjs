import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_STATES = new Set(["development", "candidate", "released"]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  object(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} must contain exactly: ${keys.join(", ")}.`);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function stringList(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? "an" : "a non-empty"} array.`);
  }
  return value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`));
}

function semver(value, label) {
  const result = nonEmptyString(value, label);
  if (!SEMVER.test(result)) throw new Error(`${label} must use major.minor.patch.`);
  return result;
}

function date(value, label) {
  const result = nonEmptyString(value, label);
  if (!ISO_DATE.test(result) || Number.isNaN(Date.parse(`${result}T00:00:00Z`))) {
    throw new Error(`${label} must be a valid YYYY-MM-DD date.`);
  }
  return result;
}

export function validateProjectStatus(status, { packageVersion } = {}) {
  exactKeys(status, ["schemaVersion", "statusDate", "project", "source", "release", "candidate", "acceptance", "deferred"], "PROJECT_STATUS.json");
  if (status.schemaVersion !== 1) throw new Error("PROJECT_STATUS.json schemaVersion must be 1.");
  date(status.statusDate, "statusDate");

  exactKeys(status.project, ["id", "name", "targetClient"], "project");
  if (nonEmptyString(status.project.id, "project.id") !== "linli-local-mail") {
    throw new Error("project.id must be linli-local-mail.");
  }
  nonEmptyString(status.project.name, "project.name");
  nonEmptyString(status.project.targetClient, "project.targetClient");

  exactKeys(status.source, ["version", "state"], "source");
  const sourceVersion = semver(status.source.version, "source.version");
  if (!SOURCE_STATES.has(status.source.state)) {
    throw new Error(`source.state must be one of ${[...SOURCE_STATES].join(", ")}.`);
  }
  if (packageVersion !== undefined && sourceVersion !== packageVersion) {
    throw new Error(`source.version ${sourceVersion} does not match package.json ${packageVersion}.`);
  }

  exactKeys(status.release, ["version", "published", "publishedAt", "channels"], "release");
  semver(status.release.version, "release.version");
  if (typeof status.release.published !== "boolean") throw new Error("release.published must be boolean.");
  if (status.release.published) date(status.release.publishedAt, "release.publishedAt");
  else if (status.release.publishedAt !== null) throw new Error("release.publishedAt must be null when unpublished.");
  if (!Array.isArray(status.release.channels) || (status.release.published && status.release.channels.length === 0)) {
    throw new Error("release.channels must list every published channel.");
  }
  for (const [index, channel] of status.release.channels.entries()) {
    exactKeys(channel, ["name", "url"], `release.channels[${index}]`);
    nonEmptyString(channel.name, `release.channels[${index}].name`);
    const url = nonEmptyString(channel.url, `release.channels[${index}].url`);
    try { new URL(url); } catch { throw new Error(`release.channels[${index}].url must be an absolute URL.`); }
  }

  if (status.candidate !== null) {
    exactKeys(status.candidate, ["version", "state"], "candidate");
    semver(status.candidate.version, "candidate.version");
    nonEmptyString(status.candidate.state, "candidate.state");
  }

  exactKeys(status.acceptance, ["environment", "confirmed", "notConfirmed"], "acceptance");
  nonEmptyString(status.acceptance.environment, "acceptance.environment");
  stringList(status.acceptance.confirmed, "acceptance.confirmed", { allowEmpty: true });
  stringList(status.acceptance.notConfirmed, "acceptance.notConfirmed", { allowEmpty: true });
  stringList(status.deferred, "deferred", { allowEmpty: true });
  return status;
}

function stateLabel(state) {
  return ({ development: "开发中", candidate: "候选", released: "已发布" })[state] ?? state;
}

function bullets(items) {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- 无";
}

export function renderProjectStatus(status) {
  validateProjectStatus(status);
  const candidate = status.candidate ? `\`${status.candidate.version}\`（${status.candidate.state}）` : "无";
  const releaseDate = status.release.published ? `，发布于 ${status.release.publishedAt}` : "（尚未发布）";
  const channels = status.release.channels.length
    ? status.release.channels.map((channel) => `- [${channel.name}](${channel.url})`).join("\n")
    : "- 无";
  return `# Linli Local Mail 当前状态

> 本文件由 \`PROJECT_STATUS.json\` 确定性生成。请修改机器可读状态源后运行 \`npm run status:generate\`，不要直接维护本文件。

- 状态日期：${status.statusDate}
- 当前源码：\`${status.source.version}\`（${stateLabel(status.source.state)}）
- 当前正式版：\`${status.release.version}\`${releaseDate}
- 当前候选：${candidate}
- 目标客户端：${status.project.targetClient}

## 已由真实客户端确认

验收环境：${status.acceptance.environment}。

${bullets(status.acceptance.confirmed)}

## 尚未确认

${bullets(status.acceptance.notConfirmed)}

## 暂缓事项

${bullets(status.deferred)}

## 正式发布渠道

${channels}
`;
}

function readJson(filePath, label) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch (error) { throw new Error(`${label} is missing or invalid: ${error.message}`); }
}

export function loadProjectStatus(root = DEFAULT_ROOT) {
  const packageJson = readJson(path.join(root, "package.json"), "package.json");
  const status = readJson(path.join(root, "PROJECT_STATUS.json"), "PROJECT_STATUS.json");
  return validateProjectStatus(status, { packageVersion: semver(packageJson.version, "package.json version") });
}

export function generateProjectStatus(root = DEFAULT_ROOT) {
  const rendered = renderProjectStatus(loadProjectStatus(root));
  fs.writeFileSync(path.join(root, "STATUS.md"), rendered, "utf8");
  return rendered;
}

export function checkProjectStatus(root = DEFAULT_ROOT) {
  const expected = renderProjectStatus(loadProjectStatus(root));
  const target = path.join(root, "STATUS.md");
  const actual = fs.existsSync(target) ? fs.readFileSync(target, "utf8").replaceAll("\r\n", "\n") : null;
  if (actual !== expected) {
    throw new Error("STATUS.md is missing or stale. Run npm run status:generate after editing PROJECT_STATUS.json.");
  }
  return { ok: true, version: JSON.parse(fs.readFileSync(path.join(root, "PROJECT_STATUS.json"), "utf8")).source.version };
}

function parseCli(argv) {
  const command = argv[0];
  if (!["generate", "check"].includes(command)) throw new Error("Usage: project-status.mjs <generate|check> [--root <path>]");
  let root = DEFAULT_ROOT;
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "--root" && argv[index + 1]) root = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return { command, root };
}

function main() {
  const { command, root } = parseCli(process.argv.slice(2));
  if (command === "generate") {
    generateProjectStatus(root);
    console.log(JSON.stringify({ ok: true, generated: path.join(root, "STATUS.md") }, null, 2));
  } else {
    console.log(JSON.stringify(checkProjectStatus(root), null, 2));
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    console.error(`Project status check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
