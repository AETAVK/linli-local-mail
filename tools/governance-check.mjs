import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  PRIVATE_ROLE,
  PUBLIC_ROLE,
  assertRepositoryRole,
  normalizeRemoteUrl
} from "./repo-guard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECTION_FILE = "PUBLIC_PROJECTION.json";
const PROJECT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.(?:0|[1-9]\d*))?$/;
const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

const FORBIDDEN_PREFIXES = Object.freeze([
  ".mimosa/",
  ".verification/",
  "archive/",
  "backups/",
  "data/",
  "dist/",
  "game-root-shortcuts/",
  "logs/",
  "runtime/"
]);

const FORBIDDEN_PATTERNS = Object.freeze([
  /(?:^|\/)\.env(?:\.|$)/i,
  /(?:^|\/)(?:[^/]+\.)?(?:cer|key|pem|pfx|p12)$/i,
  /(?:^|\/)(?:[^/]+\.)?(?:db|sqlite|sqlite3)$/i,
  /(?:^|\/)Olivia\.log$/i,
  /^native\/.*\.(?:exe|pdb)$/i,
  /^payload-.*\.zip$/i,
  /^runtime-manifest\.json$/i,
  /^unins\d+\.(?:dat|exe|msg)$/i
]);

const BINARY_EXTENSIONS = new Set([".exe", ".dll", ".zip", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2"]);
const SECRET_PATTERNS = Object.freeze([
  { name: "private key block", pattern: new RegExp(`BEGIN ${"PRIVATE"} KEY`) },
  { name: "GitHub token", pattern: new RegExp("\\bgh[pousr]_[A-Za-z0-9]{30,}\\b") },
  { name: "GitHub fine-grained token", pattern: new RegExp(`\\bgithub_${"pat"}_[A-Za-z0-9_]{40,}\\b`) },
  { name: "OpenAI-style API key", pattern: new RegExp(`\\b${"sk"}-[A-Za-z0-9_-]{20,}\\b`) },
  { name: "AWS access key", pattern: new RegExp("\\bAKIA[0-9A-Z]{16}\\b") }
]);
const RELEASE_NOTE_SECTIONS = Object.freeze([
  "本版新增和修复",
  "安装与升级",
  "已知限制",
  "下载与校验"
]);
const USER_FACING_INTERNAL_PATTERNS = Object.freeze([
  { name: "candidate history", pattern: /(?:发布前|本地|公开|已验收)?候选(?:安装器|提交|证据)?/i },
  { name: "private commit", pattern: /私有提交/i },
  { name: "workflow internals", pattern: /(?:GitHub Actions|流水线(?:编号|运行)?|CI 安装器|标签提交|运行时清单 SHA-256)/i },
  { name: "unreleased build history", pattern: /未安装、未推送、未打标签、未发布/i }
]);
const PUBLIC_INTERNAL_PATHS = new Set([
  "AGENTS.md",
  "PROJECT_STATUS.json",
  "STATUS.md",
  "tools/git-hook-guard.mjs",
  "tools/project-status.mjs",
  "tools/setup-repository.ps1"
]);
const PUBLIC_INTERNAL_PREFIXES = Object.freeze([".githooks/"]);
const PUBLIC_INTERNAL_SCRIPTS = new Set([
  "public:check",
  "public:export",
  "repository:setup",
  "status:check",
  "status:generate"
]);

function normalized(value) {
  return value.replaceAll("\\", "/");
}

export function validatePublicDocumentation({ version, readme, releaseNotes, sourceCode }) {
  const errors = [];
  const expectedTitle = `# v${version} 发布说明`;
  if (releaseNotes.split(/\r?\n/, 1)[0] !== expectedTitle) {
    errors.push(`release notes must start with: ${expectedTitle}`);
  }
  const firstSection = releaseNotes.search(/^##\s+/m);
  const preamble = firstSection < 0 ? releaseNotes : releaseNotes.slice(0, firstSection);
  if (preamble.split(/\r?\n/).slice(1).some((line) => line.trim())) {
    errors.push("release notes must not place status or audit metadata before the four reader-facing sections");
  }
  const headings = [...releaseNotes.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1]);
  if (JSON.stringify(headings) !== JSON.stringify(RELEASE_NOTE_SECTIONS)) {
    errors.push(`release notes must use exactly these sections in order: ${RELEASE_NOTE_SECTIONS.join(", ")}`);
  }
  for (const candidate of USER_FACING_INTERNAL_PATTERNS) {
    if (candidate.pattern.test(releaseNotes)) {
      errors.push(`release notes contain internal ${candidate.name}`);
    }
  }

  if (/^##\s+(?:当前版本|\d+\.\d+\.\d+\s+(?:新增|更新|候选))\s*$/m.test(readme)) {
    errors.push("README must not add a current-version or version-number section");
  }
  for (const candidate of USER_FACING_INTERNAL_PATTERNS.filter(({ name }) => name !== "workflow internals")) {
    if (candidate.pattern.test(readme)) {
      errors.push(`README contains internal ${candidate.name}`);
    }
  }
  for (const heading of ["功能范围", "当前限制"]) {
    if (!readme.includes(`## ${heading}`)) {
      errors.push(`README is missing the durable ${heading} section`);
    }
  }
  if (!readme.includes(`.github/release-notes/v${version}.md`)) {
    errors.push("README does not link to the current release notes");
  }
  for (const candidate of USER_FACING_INTERNAL_PATTERNS) {
    if (candidate.pattern.test(sourceCode)) {
      errors.push(`SOURCE_CODE.md contains internal ${candidate.name}`);
    }
  }
  if (!sourceCode.includes("https://github.com/AETAVK/linli-local-mail")) {
    errors.push("SOURCE_CODE.md is missing the public source repository URL");
  }
  if (!sourceCode.includes(`v${version}`)) {
    errors.push("SOURCE_CODE.md does not identify the current version tag");
  }
  return errors;
}

function documentationReleaseVersion(packageVersion) {
  const statusPath = path.join(ROOT, "PROJECT_STATUS.json");
  if (fs.existsSync(statusPath)) {
    try {
      const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
      if (STABLE_VERSION_PATTERN.test(status?.release?.version ?? "")) return status.release.version;
    } catch {}
  }
  const projectionPath = path.join(ROOT, PROJECTION_FILE);
  if (fs.existsSync(projectionPath)) {
    try {
      const projection = JSON.parse(fs.readFileSync(projectionPath, "utf8"));
      if (STABLE_VERSION_PATTERN.test(projection?.releaseVersion ?? "")) return projection.releaseVersion;
    } catch {}
  }
  return packageVersion;
}

function inspectPublicDocumentation() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const releaseVersion = documentationReleaseVersion(packageJson.version);
  const releaseNotesPath = path.join(ROOT, ".github", "release-notes", `v${releaseVersion}.md`);
  const readmePath = path.join(ROOT, "README.md");
  const sourceCodePath = path.join(ROOT, "SOURCE_CODE.md");
  if (!fs.existsSync(readmePath) || !fs.existsSync(releaseNotesPath) || !fs.existsSync(sourceCodePath)) {
    return {
      ok: false,
      version: releaseVersion,
      sourceVersion: packageJson.version,
      errors: ["README, SOURCE_CODE.md, or current release notes are missing"]
    };
  }
  const errors = validatePublicDocumentation({
    version: releaseVersion,
    readme: fs.readFileSync(readmePath, "utf8"),
    releaseNotes: fs.readFileSync(releaseNotesPath, "utf8"),
    sourceCode: fs.readFileSync(sourceCodePath, "utf8")
  });
  return { ok: errors.length === 0, version: releaseVersion, sourceVersion: packageJson.version, errors };
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    ...options
  }).trim();
}

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "buffer", windowsHide: true })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(normalized)
    .sort((left, right) => left.localeCompare(right));
}

function indexEntries() {
  const output = execFileSync("git", ["ls-files", "-s", "-z"], { cwd: ROOT, encoding: "buffer", windowsHide: true })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const result = new Map();
  for (const record of output) {
    const match = record.match(/^\d+ ([0-9a-f]+) \d+\t(.+)$/s);
    if (!match) throw new Error(`Cannot parse Git index entry: ${record}`);
    result.set(normalized(match[2]), match[1]);
  }
  return result;
}

function changedWorktreePaths() {
  return execFileSync("git", ["-c", "status.renames=false", "status", "--porcelain=v1", "-z"], {
    cwd: ROOT,
    encoding: "buffer",
    windowsHide: true
  }).toString("utf8").split("\0").filter(Boolean).map((record) => normalized(record.slice(3)));
}

export function forbiddenTrackedPath(relativePath) {
  const value = normalized(relativePath);
  const prefix = FORBIDDEN_PREFIXES.find((candidate) => value.startsWith(candidate));
  if (prefix) return `forbidden prefix: ${prefix}`;
  const pattern = FORBIDDEN_PATTERNS.find((candidate) => candidate.test(value));
  return pattern ? `forbidden pattern: ${pattern}` : null;
}

function readProjection() {
  const markerPath = path.join(ROOT, PROJECTION_FILE);
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch (error) {
    throw new Error(`Public projection marker is missing or invalid: ${error.message}`);
  }
  if (marker.format !== 1 || !Array.isArray(marker.files) || !/^[0-9a-f]{40}$/i.test(marker.canonicalCommit ?? "")) {
    throw new Error("PUBLIC_PROJECTION.json has an unsupported or incomplete format.");
  }
  return marker;
}

function inspectPublicProjection(role, tracked, { ignoreWorkingChanges = false } = {}) {
  const marker = readProjection();
  const expected = new Map(marker.files.map((entry) => [normalized(entry.path), entry]));
  const allowed = new Set([...expected.keys(), PROJECTION_FILE]);
  const unmanaged = tracked.filter((file) => !allowed.has(file));
  const missing = [...expected.keys()].filter((file) => !tracked.includes(file) || !fs.existsSync(path.join(ROOT, file)));
  const changed = [];
  const index = indexEntries();
  const workingChanges = new Set(changedWorktreePaths());
  for (const [relativePath, entry] of expected) {
    const target = path.join(ROOT, relativePath);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) continue;
    if (index.get(relativePath) !== entry.gitBlob || (!ignoreWorkingChanges && workingChanges.has(relativePath))) {
      changed.push(relativePath);
    }
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const releaseVersion = marker.releaseVersion ?? packageJson.version;
  const releaseNotes = `.github/release-notes/v${releaseVersion}.md`;
  const versionErrors = [];
  if (!PROJECT_VERSION_PATTERN.test(packageJson.version ?? "")) {
    versionErrors.push("package.json version is not an approved stable or prerelease version");
  }
  if (!STABLE_VERSION_PATTERN.test(releaseVersion)) versionErrors.push("projection releaseVersion is not stable major.minor.patch");
  if (marker.packageVersion !== packageJson.version) versionErrors.push("projection packageVersion does not match package.json");
  if (marker.releaseVersion !== undefined && marker.releaseVersion !== releaseVersion) {
    versionErrors.push("projection releaseVersion is inconsistent");
  }
  if (!fs.existsSync(path.join(ROOT, releaseNotes))) versionErrors.push(`missing release notes: ${releaseNotes}`);

  const publicScopeErrors = [];
  const internalPaths = tracked.filter((file) =>
    PUBLIC_INTERNAL_PATHS.has(file) || PUBLIC_INTERNAL_PREFIXES.some((prefix) => file.startsWith(prefix))
  );
  if (internalPaths.length) {
    publicScopeErrors.push(`internal-only paths are tracked: ${internalPaths.join(", ")}`);
  }
  const trackedReleaseNotes = tracked.filter((file) => /^\.github\/release-notes\/v\d+\.\d+\.\d+\.md$/.test(file));
  if (trackedReleaseNotes.length !== 1 || trackedReleaseNotes[0] !== releaseNotes) {
    publicScopeErrors.push(`only the current release notes may be tracked: ${releaseNotes}`);
  }
  const internalScripts = Object.keys(packageJson.scripts ?? {}).filter((name) => PUBLIC_INTERNAL_SCRIPTS.has(name));
  if (internalScripts.length) {
    publicScopeErrors.push(`internal-only package scripts are present: ${internalScripts.join(", ")}`);
  }
  const attributesPath = path.join(ROOT, ".gitattributes");
  if (fs.existsSync(attributesPath) && /^\.githooks\//m.test(fs.readFileSync(attributesPath, "utf8"))) {
    publicScopeErrors.push(".gitattributes still contains a private .githooks rule");
  }

  let origin = "";
  try { origin = git(["remote", "get-url", "origin"]); } catch {}
  const originMatches = Boolean(origin) && normalizeRemoteUrl(origin) === normalizeRemoteUrl(role.approvedOrigin);

  const secrets = [];
  for (const relativePath of expected.keys()) {
    const target = path.join(ROOT, relativePath);
    if (!fs.existsSync(target) || BINARY_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) continue;
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
    const content = fs.readFileSync(target, "utf8");
    for (const candidate of SECRET_PATTERNS) {
      if (candidate.pattern.test(content)) secrets.push({ file: relativePath, reason: candidate.name });
    }
  }

  return { marker, unmanaged, missing, changed, versionErrors, publicScopeErrors, origin, originMatches, secrets };
}

export function inspectRepository({ requireClean = false, requireHooks = false, expectedRole = null, ignoreWorkingChanges = false } = {}) {
  if (!fs.existsSync(path.join(ROOT, ".git"))) throw new Error(`Not a Git worktree: ${ROOT}`);
  const role = assertRepositoryRole(ROOT, expectedRole ? [expectedRole] : [PRIVATE_ROLE, PUBLIC_ROLE]);
  const tracked = trackedFiles();
  const status = git(["status", "--porcelain=v1"]);
  const branch = git(["branch", "--show-current"]);
  let hooksPath = "";
  try { hooksPath = git(["config", "--local", "--get", "core.hooksPath"]); } catch {}
  const hooksConfigured = normalized(hooksPath) === ".githooks";
  const result = {
    root: ROOT,
    role: role.role,
    branch,
    trackedFiles: tracked.length,
    clean: !status,
    requireClean,
    hooksConfigured,
    requireHooks
  };

  try {
    result.publicDocumentation = inspectPublicDocumentation();
  } catch (error) {
    result.publicDocumentation = { ok: false, errors: [error.message] };
  }

  if (role.role === PRIVATE_ROLE) {
    result.forbidden = tracked
      .map((file) => ({ file, reason: forbiddenTrackedPath(file) }))
      .filter((entry) => entry.reason);
    result.ok = result.forbidden.length === 0
      && result.publicDocumentation.ok
      && (!requireClean || result.clean)
      && (!requireHooks || hooksConfigured);
  } else {
    const projection = inspectPublicProjection(role, tracked, { ignoreWorkingChanges });
    Object.assign(result, {
      canonicalCommit: projection.marker.canonicalCommit,
      packageVersion: projection.marker.packageVersion,
      unmanagedTracked: projection.unmanaged,
      missingProjected: projection.missing,
      changedProjected: projection.changed,
      versionErrors: projection.versionErrors,
      publicScopeErrors: projection.publicScopeErrors,
      origin: projection.origin,
      originMatches: projection.originMatches,
      secretFindings: projection.secrets
    });
    result.ok = projection.unmanaged.length === 0
      && projection.missing.length === 0
      && projection.changed.length === 0
      && projection.versionErrors.length === 0
      && projection.publicScopeErrors.length === 0
      && projection.originMatches
      && projection.secrets.length === 0
      && result.publicDocumentation.ok
      && (!requireClean || result.clean)
      && (!requireHooks || hooksConfigured);
  }
  return result;
}

export function projectionFileDigest(relativePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, relativePath))).digest("hex");
}

function main() {
  const args = process.argv.slice(2);
  const knownSwitches = new Set(["--require-clean", "--require-hooks"]);
  let expectedRole = null;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (knownSwitches.has(value)) continue;
    if (value === "--expected-role" && args[index + 1]) {
      expectedRole = args[++index];
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  const result = inspectRepository({
    requireClean: args.includes("--require-clean"),
    requireHooks: args.includes("--require-hooks"),
    expectedRole
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`Governance check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
