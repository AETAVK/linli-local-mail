import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { normalizeImportedLetter } from "../src/history.mjs";
import {
  EXPECTED_BASELINE_SHA256,
  EXPECTED_WEBPLAYER_BASELINE_SHA256
} from "./feapp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GAME_ROOT = path.resolve(ROOT, "..");
const SERVICE_ROOT = "http://127.0.0.1:27149";

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: String(detail || "") });
}

function hash(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function checkHash(name, filePath, expected) {
  try {
    const actual = hash(filePath);
    record(name, actual === expected, actual);
  } catch (error) {
    record(name, false, error.message);
  }
}

async function checkService() {
  try {
    const healthResponse = await fetch(`${SERVICE_ROOT}/health`);
    const health = await healthResponse.json();
    record("local service", healthResponse.ok && health.ok, `v${health.serviceVersion}; SQLite=${health.database?.integrity}; letters=${health.database?.letters}`);

    const unauthorized = await fetch(`${SERVICE_ROOT}/api/settings`);
    record("session guard", unauthorized.status === 401, `without token HTTP ${unauthorized.status}`);

    const blockedOrigin = await fetch(`${SERVICE_ROOT}/api/session`, { headers: { origin: "https://untrusted.example" } });
    record("origin guard", blockedOrigin.status === 403, `untrusted origin HTTP ${blockedOrigin.status}`);

    const sessionResponse = await fetch(`${SERVICE_ROOT}/api/session`);
    const session = await sessionResponse.json();
    const diagnosticsResponse = await fetch(`${SERVICE_ROOT}/api/diagnostics`, {
      headers: { "X-Local-Mail-Session": session.data?.token || "" }
    });
    const diagnostics = await diagnosticsResponse.json();
    record("private diagnostics", diagnosticsResponse.ok && diagnostics.code === 0, `providers=${diagnostics.data?.model?.providers?.length ?? "?"}`);
    const readiness = diagnostics.data?.model?.readiness;
    const failedChecks = (readiness?.checks || []).filter((check) => !check.ok).map((check) => `${check.id}: ${check.detail}`);
    record(
      "model readiness",
      readiness?.ready === true,
      readiness?.ready === true
        ? `orchestration=${readiness.orchestrationVersion}; model generation ready`
        : `模型生成未就绪（本地服务可运行）— ${failedChecks.join("; ") || "未知原因"}`
    );
  } catch (error) {
    record("local service", false, error.message);
  }
}

function checkLauncherWrapper() {
  const launcherPath = path.join(GAME_ROOT, "launcher.exe");
  const originalPath = path.join(GAME_ROOT, "launcher.original.exe");
  const manifestPath = path.join(GAME_ROOT, "launcher-wrapper.json");
  const wrapperBinaryPath = path.join(ROOT, "native", "linli-launcher-wrapper.exe");

  if (!fs.existsSync(originalPath) && !fs.existsSync(manifestPath)) {
    record("launcher wrapper", true, "not installed (optional; run Install.cmd to enable direct startup)");
    return;
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const originalHash = hash(originalPath);
    const activeHash = hash(launcherPath);
    const expectedOriginal = String(manifest.originalSha256 || "").toLowerCase();
    const expectedWrapper = String(manifest.wrapperSha256 || "").toLowerCase();
    const wrapperAvailable = fs.existsSync(wrapperBinaryPath);
    const activeMatches = manifest.active === "official"
      ? activeHash === originalHash
      : manifest.active === "wrapper" && activeHash === expectedWrapper;
    const backupMatches = Boolean(expectedOriginal) && originalHash === expectedOriginal;
    const detail = manifest.active === "official"
      ? "official launcher restored; wrapper binary remains available"
      : `wrapper active; original backup=${backupMatches}; binary=${wrapperAvailable}`;
    record("launcher wrapper", activeMatches && backupMatches && wrapperAvailable, detail);
  } catch (error) {
    record("launcher wrapper", false, error.message);
  }
}

async function main() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  record("Node.js", nodeMajor >= 24, process.version);

  const versionPath = path.join(GAME_ROOT, "version.json");
  const version = JSON.parse(fs.readFileSync(versionPath, "utf8"));
  record("game version", String(version.client || "").includes("v0.0.9.627"), version.client || "missing client version");

  const rolePath = path.join(ROOT, "config", "characters", "linli.v1.json");
  const role = JSON.parse(fs.readFileSync(rolePath, "utf8"));
  record(
    "Lin Li profile",
    role.id === "linli" && role.schemaVersion === 2 && Array.isArray(role.persona) && role.persona.length >= 4 && role.historicalNotes?.injected === false,
    `${role.id} ${role.version} (schema ${role.schemaVersion}, orchestration ${role.orchestration})`
  );

  const historyDirectory = path.join(ROOT, "imports", "history");
  const historyFiles = fs.existsSync(historyDirectory)
    ? fs.readdirSync(historyDirectory).filter((name) => name.endsWith(".json")).sort()
    : [];
  let validHistory = 0;
  for (const [index, name] of historyFiles.entries()) {
    normalizeImportedLetter(JSON.parse(fs.readFileSync(path.join(historyDirectory, name), "utf8")), index);
    validHistory += 1;
  }
  // 干净部署（分享给其他玩家）可以没有任何本地历史文件；只要存在就必须全部有效。
  record(
    "history JSON",
    validHistory === historyFiles.length,
    historyFiles.length ? `${validHistory}/${historyFiles.length} valid files` : "no local history files (clean install)"
  );

  const baselineDirectory = path.join(ROOT, "backups", "required", "official-compatible-0.0.9.627");
  const baselinePath = path.join(baselineDirectory, "feapp.dat");
  const webplayerBaselinePath = path.join(baselineDirectory, "webplayer.dat");
  checkHash("compatible baseline", baselinePath, EXPECTED_BASELINE_SHA256);
  checkHash("compatible webplayer baseline", webplayerBaselinePath, EXPECTED_WEBPLAYER_BASELINE_SHA256);

  const webplayerPath = path.join(GAME_ROOT, "0.0.9.627", "resources", "webplayer.dat");
  try {
    record("webplayer archive", fs.lstatSync(webplayerPath).isFile(), hash(webplayerPath));
  } catch (error) {
    record("webplayer archive", false, error.message);
  }

  const patchCheck = spawnSync(process.execPath, [path.join(ROOT, "tools", "feapp.mjs"), "verify"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true
  });
  let patchJson = null;
  try { patchJson = JSON.parse(String(patchCheck.stdout || "")); } catch {}
  record("frontend patch", patchCheck.status === 0, patchCheck.status === 0 ? "verified" : (patchCheck.stderr || patchCheck.stdout).trim());
  record(
    "webplayer patch",
    patchCheck.status === 0 && Boolean(patchJson?.webplayer?.installedSha256),
    patchCheck.status === 0 && patchJson?.webplayer?.installedSha256 ? "verified" : "webplayer result missing"
  );

  checkLauncherWrapper();
  await checkService();
  const ok = checks.every((item) => item.ok);
  console.log(JSON.stringify({ ok, checks }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
