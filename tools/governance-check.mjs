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
import { checkProjectStatus } from "./project-status.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECTION_FILE = "PUBLIC_PROJECTION.json";

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

function normalized(value) {
  return value.replaceAll("\\", "/");
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
  const releaseNotes = `.github/release-notes/v${packageJson.version}.md`;
  const versionErrors = [];
  if (!/^\d+\.\d+\.\d+$/.test(packageJson.version ?? "")) versionErrors.push("package.json version is not semantic major.minor.patch");
  if (marker.packageVersion !== packageJson.version) versionErrors.push("projection packageVersion does not match package.json");
  if (!fs.existsSync(path.join(ROOT, releaseNotes))) versionErrors.push(`missing release notes: ${releaseNotes}`);

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

  return { marker, unmanaged, missing, changed, versionErrors, origin, originMatches, secrets };
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
    requireHooks,
    projectStatus: null
  };

  try {
    result.projectStatus = checkProjectStatus(ROOT);
  } catch (error) {
    result.projectStatus = { ok: false, error: error.message };
  }

  if (role.role === PRIVATE_ROLE) {
    result.forbidden = tracked
      .map((file) => ({ file, reason: forbiddenTrackedPath(file) }))
      .filter((entry) => entry.reason);
    result.ok = result.forbidden.length === 0
      && result.projectStatus.ok
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
      origin: projection.origin,
      originMatches: projection.originMatches,
      secretFindings: projection.secrets
    });
    result.ok = projection.unmanaged.length === 0
      && projection.missing.length === 0
      && projection.changed.length === 0
      && projection.versionErrors.length === 0
      && projection.originMatches
      && projection.secrets.length === 0
      && result.projectStatus.ok
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
