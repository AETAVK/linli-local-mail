import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn as spawnProcess, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MODULE_PATH = fileURLToPath(import.meta.url);
const DEFAULT_SERVICE_ROOT = path.resolve(path.dirname(MODULE_PATH), "..");
const EXPECTED_GAME_VERSION = "0.0.9.627";
const FEAPP_RELATIVE_PATH = `${EXPECTED_GAME_VERSION}/resources/feapp.dat`;
const WEBPLAYER_RELATIVE_PATH = `${EXPECTED_GAME_VERSION}/resources/webplayer.dat`;
const STATE_RELATIVE_PATH = "data/installer-state.json";
const CHARACTER_TARGET_RELATIVE_PATH = "config/characters/linli.v1.json";
const CHARACTER_DEFAULT_RELATIVE_PATH = "config/defaults/linli.v1.json";
const LAUNCHER_NAMES = ["launcher.exe", "launcher.original.exe", "launcher-wrapper.json"];
const DEFAULT_SHORTCUT_NAMES = [
  "Start-LinliLocalMail.cmd",
  "Start-LinliLocalMail-ServiceOnly.cmd",
  "Stop-LinliLocalMail.cmd"
];
const PROTECTED_PROCESS_NAMES = ["olivia.exe", "launcher.exe", "launcher.original.exe"];
const HANDOFF_POLL_MILLISECONDS = 1000;
const HANDOFF_WAIT_TIMEOUT_MILLISECONDS = 24 * 60 * 60 * 1000;
const SERVICE_STOP_TIMEOUT_MILLISECONDS = 30 * 1000;
const PROCESS_QUERY_TIMEOUT_MILLISECONDS = 5000;

export class InstallerError extends Error {
  constructor(message, { code = "installer_error", details = null } = {}) {
    super(message);
    this.name = "InstallerError";
    this.code = code;
    this.details = details;
  }
}

function parseArguments(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      result._.push(argument);
      continue;
    }
    const equal = argument.indexOf("=");
    if (equal > 2) {
      result[argument.slice(2, equal)] = argument.slice(equal + 1);
      continue;
    }
    const key = argument.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

function normalizeRelative(value) {
  const text = String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!text || text.includes("\0") || path.posix.isAbsolute(text) || /^[a-z]:/iu.test(text)) {
    throw new InstallerError(`无效的相对路径：${value}`, { code: "invalid_manifest_path" });
  }
  const normalized = path.posix.normalize(text);
  if (normalized === ".." || normalized.startsWith("../") || normalized.split("/").includes("..")) {
    throw new InstallerError(`相对路径越界：${value}`, { code: "invalid_manifest_path" });
  }
  return normalized;
}

function safeJoin(root, relative) {
  const normalized = normalizeRelative(relative);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...normalized.split("/"));
  const prefix = `${resolvedRoot}${path.sep}`.toLowerCase();
  if (resolved.toLowerCase() !== resolvedRoot.toLowerCase() && !resolved.toLowerCase().startsWith(prefix)) {
    throw new InstallerError(`路径越界：${relative}`, { code: "path_escape" });
  }
  let current = resolvedRoot;
  for (const segment of path.relative(resolvedRoot, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new InstallerError(`拒绝经过符号链接或重解析点：${current}`, { code: "unsafe_reparse_path" });
    }
  }
  return resolved;
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function unlinkIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      fs.chmodSync(filePath, 0o666);
      fs.unlinkSync(filePath);
      return;
    }
    throw error;
  }
}

export function removeTreeSafe(targetPath) {
  let stat;
  try {
    stat = fs.lstatSync(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    unlinkIfExists(targetPath);
    return;
  }
  for (const entry of fs.readdirSync(targetPath)) {
    removeTreeSafe(path.join(targetPath, entry));
  }
  try {
    fs.rmdirSync(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      fs.chmodSync(targetPath, 0o777);
      fs.rmdirSync(targetPath);
      return;
    }
    throw error;
  }
}

function removeExisting(targetPath, { allowDirectory = false } = {}) {
  let stat;
  try { stat = fs.lstatSync(targetPath); } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    if (!allowDirectory) {
      throw new InstallerError(`目标路径是目录：${targetPath}`, { code: "unexpected_directory" });
    }
    removeTreeSafe(targetPath);
    return;
  }
  unlinkIfExists(targetPath);
}

export function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function atomicWrite(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temporaryPath, data);
  try {
    removeExisting(filePath);
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { unlinkIfExists(temporaryPath); } catch {}
    throw error;
  }
}

function writeJson(filePath, value) {
  atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath, { optional = false } = {}) {
  if (optional && !fs.existsSync(filePath)) return null;
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw new InstallerError(`无法读取 JSON：${filePath}（${error.message}）`, { code: "invalid_json" });
  }
}

function assertRegularFile(filePath, description) {
  let stat;
  try { stat = fs.lstatSync(filePath); } catch { stat = null; }
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new InstallerError(`${description}不是普通文件：${filePath}`, { code: "invalid_file_type" });
  }
}

function assertDirectory(directory, description) {
  let stat;
  try { stat = fs.lstatSync(directory); } catch { stat = null; }
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new InstallerError(`${description}不是普通目录：${directory}`, { code: "invalid_directory" });
  }
}

function copyFileVerified(source, destination) {
  assertRegularFile(source, "源文件");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporaryPath = `${destination}.linli-temp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.copyFileSync(source, temporaryPath);
  if (sha256File(source) !== sha256File(temporaryPath)) {
    unlinkIfExists(temporaryPath);
    throw new InstallerError(`文件复制校验失败：${destination}`, { code: "copy_verification_failed" });
  }
  try {
    removeExisting(destination, { allowDirectory: true });
    fs.renameSync(temporaryPath, destination);
  } catch (error) {
    try { unlinkIfExists(temporaryPath); } catch {}
    throw error;
  }
}

function validateRuntimeManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.version !== "string") {
    throw new InstallerError("运行时清单格式不正确", { code: "invalid_runtime_manifest" });
  }
  if (manifest.gameVersion !== EXPECTED_GAME_VERSION) {
    throw new InstallerError(`安装包面向的游戏版本不是 ${EXPECTED_GAME_VERSION}`, { code: "unsupported_manifest_game_version" });
  }
  if (!Array.isArray(manifest.managedFiles) || !manifest.managedFiles.length) {
    throw new InstallerError("运行时清单没有受管文件", { code: "invalid_runtime_manifest" });
  }
  const seen = new Set();
  for (const entry of manifest.managedFiles) {
    entry.path = normalizeRelative(entry.path);
    if (seen.has(entry.path.toLowerCase())) {
      throw new InstallerError(`运行时清单包含重复文件：${entry.path}`, { code: "invalid_runtime_manifest" });
    }
    seen.add(entry.path.toLowerCase());
    if (!/^[0-9a-f]{64}$/iu.test(String(entry.sha256 || "")) || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new InstallerError(`运行时清单文件信息不完整：${entry.path}`, { code: "invalid_runtime_manifest" });
    }
  }
  manifest.rootShortcuts = Array.isArray(manifest.rootShortcuts) ? manifest.rootShortcuts : [];
  for (const entry of manifest.rootShortcuts) {
    entry.name = path.basename(normalizeRelative(entry.name));
    entry.source = normalizeRelative(entry.source);
    if (!/^[0-9a-f]{64}$/iu.test(String(entry.sha256 || ""))) {
      throw new InstallerError(`启动入口清单不完整：${entry.name}`, { code: "invalid_runtime_manifest" });
    }
  }
  return manifest;
}

export function loadRuntimeManifest(manifestPath) {
  return validateRuntimeManifest(readJson(manifestPath));
}

function writeProbe(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const probe = path.join(directory, `.linli-write-probe-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    fs.writeFileSync(probe, "probe", { flag: "wx" });
  } catch (error) {
    throw new InstallerError(`当前用户无法写入目录：${directory}（${error.message}）`, { code: "permission_denied" });
  } finally {
    try { unlinkIfExists(probe); } catch {}
  }
}

function isProcessRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  if (process.platform !== "win32") return false;
  try {
    return Boolean(queryWindowsProcessIdentity(pid));
  } catch {
    // An identity query failure is not proof of exit. Keep waiting and fail
    // closed at the timeout instead of guessing that the PID is gone.
    return true;
  }
}

function processEntryName(entry) {
  return typeof entry === "string"
    ? entry
    : entry?.name || entry?.imageName || entry?.ImageName || entry?.Name || "";
}

function normalizeProtectedProcessNames(value) {
  const values = Array.isArray(value)
    ? value
    : value && typeof value[Symbol.iterator] === "function"
      ? [...value]
      : String(value ?? "").split(/\r?\n/u);
  const names = new Set();
  for (const entry of values) {
    const normalized = String(processEntryName(entry)).trim().replace(/^"|"$/gu, "").toLowerCase();
    if (PROTECTED_PROCESS_NAMES.includes(normalized)) names.add(normalized);
  }
  return PROTECTED_PROCESS_NAMES.filter((name) => names.has(name));
}

export function protectedProcessNamesFromTasklist(stdout) {
  const names = [];
  for (const line of String(stdout || "").split(/\r?\n/u)) {
    const match = line.trim().match(/^"([^"]+)"/u);
    if (match) names.push(match[1]);
  }
  return normalizeProtectedProcessNames(names);
}

function tasklistEntriesFromCsv(stdout) {
  const entries = [];
  for (const line of String(stdout || "").split(/\r?\n/u)) {
    const match = line.trim().match(/^"([^"]+)","(\d+)"/u);
    if (match) entries.push({ name: match[1], pid: Number(match[2]) });
  }
  return entries;
}

function isPathWithinRoot(filePath, rootPath) {
  const root = normalizeComparablePath(rootPath);
  const file = normalizeComparablePath(filePath);
  return Boolean(root && file && file.startsWith(`${root}/`));
}

export function protectedProcessNamesForGameRoot(entries, gameRoot) {
  const scoped = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = processEntryName(entry);
    if (!PROTECTED_PROCESS_NAMES.includes(String(name).trim().toLowerCase())) continue;
    if (isPathWithinRoot(entry?.executablePath || entry?.ExecutablePath, gameRoot)) scoped.push(name);
  }
  return normalizeProtectedProcessNames(scoped);
}

function readWindowsProtectedProcessNames(gameRoot = null) {
  const result = spawnSync("tasklist.exe", ["/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: PROCESS_QUERY_TIMEOUT_MILLISECONDS,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new InstallerError(
      `无法安全检查游戏进程：${result.error?.message || String(result.stderr || "").trim() || `tasklist exit ${result.status}`}`,
      { code: "process_list_failed", details: { status: result.status, stderr: String(result.stderr || "").trim() } }
    );
  }
  const entries = tasklistEntriesFromCsv(result.stdout);
  if (!gameRoot) return normalizeProtectedProcessNames(entries);
  // tasklist is machine-wide. Resolve each protected PID's executable path so
  // an unrelated launcher.exe elsewhere cannot block this game update.
  const scoped = [];
  for (const entry of entries) {
    if (!PROTECTED_PROCESS_NAMES.includes(String(entry.name).toLowerCase())) continue;
    const identity = queryWindowsProcessIdentity(entry.pid);
    if (!identity) continue;
    if (!identity.executablePath) {
      throw new InstallerError(`无法验证 ${entry.name} 的可执行路径，拒绝继续安装`, {
        code: "process_path_unavailable",
        details: { pid: entry.pid, name: entry.name }
      });
    }
    scoped.push({ name: identity.name || entry.name, executablePath: identity.executablePath });
  }
  return protectedProcessNamesForGameRoot(scoped, gameRoot);
}

function waitForPid(pid, timeoutMilliseconds = 120_000) {
  if (!pid) return;
  const numericPid = Number(pid);
  if (!Number.isSafeInteger(numericPid) || numericPid <= 0) {
    throw new InstallerError(`无效的等待进程编号：${pid}`, { code: "invalid_wait_pid" });
  }
  const deadline = Date.now() + timeoutMilliseconds;
  while (isProcessRunning(numericPid) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (isProcessRunning(numericPid)) {
    throw new InstallerError(`等待旧版本地服务退出超时（PID ${numericPid}）`, { code: "wait_pid_timeout" });
  }
}

function runningLauncherNames({ platform = process.platform, processListImpl = null, gameRoot = null } = {}) {
  if (processListImpl) {
    return normalizeProtectedProcessNames(processListImpl());
  }
  if (platform !== "win32") {
    throw new InstallerError("无法在当前平台安全检查游戏进程", { code: "process_check_unsupported" });
  }
  return readWindowsProtectedProcessNames(gameRoot);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function handoffLogWriter(logPath, logImpl = null) {
  return (message, details = null) => {
    const suffix = details == null ? "" : ` ${JSON.stringify(details)}`;
    const line = `${new Date().toISOString()} ${String(message)}${suffix}\n`;
    if (typeof logImpl === "function") {
      try { logImpl(String(message), details); } catch {}
    }
    if (!logPath) return;
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, line, "utf8");
    } catch {
      // A logging failure must not turn a safe refusal into an unsafe install.
    }
  };
}

export async function waitForProtectedProcesses({
  platform = process.platform,
  gameRoot = null,
  processListImpl = null,
  sleepImpl = delay,
  now = () => Date.now(),
  pollMilliseconds = HANDOFF_POLL_MILLISECONDS,
  timeoutMilliseconds = HANDOFF_WAIT_TIMEOUT_MILLISECONDS,
  log = () => {}
} = {}) {
  const startedAt = now();
  const deadline = startedAt + timeoutMilliseconds;
  let previous = "";
  for (;;) {
    let running;
    try {
      running = runningLauncherNames({ platform, processListImpl, gameRoot });
    } catch (error) {
      if (error instanceof InstallerError) throw error;
      throw new InstallerError(`无法安全检查游戏进程：${error.message}`, {
        code: "process_list_failed"
      });
    }
    const state = running.join(",");
    if (state !== previous) {
      if (running.length) log(`等待游戏和启动器退出：${running.join("、")}`);
      else if (previous) log("游戏和启动器已全部退出");
      previous = state;
    }
    if (!running.length) {
      return {
        waited: Math.max(0, now() - startedAt),
        polls: previous ? 2 : 1
      };
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new InstallerError(`等待游戏和启动器退出超时：${running.join("、")}`, {
        code: "protected_process_timeout",
        details: { running }
      });
    }
    await sleepImpl(Math.min(Math.max(1, Number(pollMilliseconds) || 1), remaining));
  }
}

function normalizeProcessIdentity(value) {
  if (!value) return null;
  const identity = {
    pid: Number(value.pid ?? value.ProcessId),
    name: String(value.name ?? value.Name ?? "").trim(),
    executablePath: String(value.executablePath ?? value.ExecutablePath ?? "").trim(),
    commandLine: String(value.commandLine ?? value.CommandLine ?? "").trim(),
    creationDate: String(value.creationDate ?? value.CreationDate ?? "").trim()
  };
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) return null;
  return identity;
}

export function processIdentityQueryCommand(pid) {
  const numericPid = Number(pid);
  if (!Number.isSafeInteger(numericPid) || numericPid <= 0) {
    throw new InstallerError(`无效的服务进程编号：${pid}`, { code: "invalid_service_pid" });
  }
  return [
    "$utf8NoBom = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false;",
    "[Console]::OutputEncoding = $utf8NoBom;",
    "$OutputEncoding = $utf8NoBom;",
    "$p = Get-CimInstance -ClassName Win32_Process",
    `-Filter 'ProcessId = ${numericPid}' -ErrorAction Stop;`,
    "if ($null -eq $p) { exit 3 };",
    "$p | Select-Object -First 1 ProcessId,Name,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress"
  ].join(" ");
}

export function parseWindowsProcessIdentityJson(value) {
  let parsed;
  try { parsed = JSON.parse(String(value || "").trim()); } catch (error) {
    throw new InstallerError(`服务进程身份响应无效：${error.message}`, {
      code: "service_identity_unavailable"
    });
  }
  const identity = normalizeProcessIdentity(Array.isArray(parsed) ? parsed[0] : parsed);
  if (!identity) {
    throw new InstallerError("无法读取服务进程身份", { code: "service_identity_unavailable" });
  }
  return identity;
}

function queryWindowsProcessIdentity(pid) {
  const numericPid = Number(pid);
  const command = processIdentityQueryCommand(numericPid);
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: PROCESS_QUERY_TIMEOUT_MILLISECONDS,
    maxBuffer: 1024 * 1024
  });
  if (result.status === 3 && !result.error) return null;
  if (result.error || result.status !== 0) {
    throw new InstallerError(
      `无法验证服务进程身份（PID ${numericPid}）：${result.error?.message || String(result.stderr || "").trim() || `PowerShell exit ${result.status}`}`,
      { code: "service_identity_unavailable", details: { status: result.status, stderr: String(result.stderr || "").trim() } }
    );
  }
  try {
    return parseWindowsProcessIdentityJson(result.stdout);
  } catch (error) {
    if (error instanceof InstallerError) {
      error.message = `PID ${numericPid}：${error.message}`;
      throw error;
    }
    throw error;
  }
}

function normalizeComparablePath(value) {
  return String(value || "")
    .replaceAll("\\", "/")
    .replace(/\/+$/u, "")
    .toLowerCase();
}

function hasServerEntry(commandLine) {
  return /(?:^|[\s"'\\/])server\.mjs(?:$|[\s"'\\/])/iu.test(String(commandLine || ""));
}

function isServiceIdentity(identity, { serviceRoot, servicePort = null } = {}) {
  if (!identity || !hasServerEntry(identity.commandLine)) return false;
  if (!/^node(?:\.exe)?$/iu.test(path.basename(identity.name || ""))) return false;
  const root = normalizeComparablePath(serviceRoot);
  const command = normalizeComparablePath(identity.commandLine);
  const executable = normalizeComparablePath(identity.executablePath);
  const rooted = Boolean(root) && (command.includes(root) || executable.includes(`${root}/runtime/`));
  return rooted;
}

function sameProcessIdentity(expected, current) {
  if (!expected || !current || expected.pid !== current.pid) return false;
  if (expected.creationDate && current.creationDate && expected.creationDate !== current.creationDate) return false;
  if (expected.executablePath && current.executablePath
      && normalizeComparablePath(expected.executablePath) !== normalizeComparablePath(current.executablePath)) return false;
  if (expected.commandLine && current.commandLine
      && expected.commandLine.replace(/\s+/gu, " ") !== current.commandLine.replace(/\s+/gu, " ")) return false;
  return true;
}

export async function requestAuthenticatedShutdown({
  host = "127.0.0.1",
  port = null,
  expectedVersion = null,
  fetchImpl = globalThis.fetch
} = {}) {
  if (port == null) return { ok: false, reason: "shutdown_port_missing" };
  const numericPort = Number(port);
  if (!Number.isSafeInteger(numericPort) || numericPort <= 0 || numericPort > 65535) {
    return { ok: false, reason: "invalid_port" };
  }
  if (typeof fetchImpl !== "function") return { ok: false, reason: "fetch_unavailable" };
  if (String(host || "") !== "127.0.0.1") return { ok: false, reason: "non_loopback_host" };
  try {
    const sessionResponse = await fetchImpl(`http://${host}:${numericPort}/api/session`, {
      method: "GET",
      headers: { Connection: "close" },
      signal: AbortSignal.timeout(2000)
    });
    if (!sessionResponse.ok) return { ok: false, reason: `session_http_${sessionResponse.status}` };
    const sessionPayload = await sessionResponse.json();
    if (sessionPayload?.code != null && sessionPayload.code !== 0) {
      return { ok: false, reason: "session_rejected", response: sessionPayload };
    }
    const session = sessionPayload?.data && typeof sessionPayload.data === "object"
      ? sessionPayload.data
      : sessionPayload;
    const token = String(session?.token || "").trim();
    const serviceVersion = String(session?.serviceVersion || "");
    if (!token) return { ok: false, reason: "session_token_missing" };
    if (expectedVersion && serviceVersion !== String(expectedVersion)) {
      return { ok: false, reason: "service_version_mismatch", version: serviceVersion || null };
    }
    const shutdownResponse = await fetchImpl(`http://${host}:${numericPort}/api/shutdown`, {
      method: "POST",
      headers: {
        Connection: "close",
        "Content-Type": "application/json",
        "X-Local-Mail-Session": token
      },
      body: "{}",
      signal: AbortSignal.timeout(2000)
    });
    if (!shutdownResponse.ok) return { ok: false, reason: `shutdown_http_${shutdownResponse.status}` };
    let shutdownPayload = null;
    try { shutdownPayload = await shutdownResponse.json(); } catch {}
    if (shutdownPayload?.code != null && shutdownPayload.code !== 0) {
      return { ok: false, reason: "shutdown_rejected", response: shutdownPayload };
    }
    return { ok: true, serviceVersion, authenticated: true, shutdownRequested: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

export function installerLaunchArguments(gameRoot, pid = process.pid) {
  const normalizedRoot = path.resolve(String(gameRoot || ""));
  const normalizedPid = Number(pid);
  if (!String(gameRoot || "").trim()) {
    throw new InstallerError("游戏目录不能为空", { code: "missing_game_root" });
  }
  if (!Number.isSafeInteger(normalizedPid) || normalizedPid <= 0) {
    throw new InstallerError("等待进程编号无效", { code: "invalid_wait_pid" });
  }
  return [
    `/GAME_ROOT=${normalizedRoot}`,
    "/CONFIRMED_UPDATE=1",
    `/WAIT_PID=${normalizedPid}`
  ];
}

async function captureServiceIdentity({
  servicePid,
  serviceRoot,
  servicePort,
  queryProcessImpl,
  log
}) {
  const identity = normalizeProcessIdentity(await queryProcessImpl(servicePid));
  if (!identity) {
    log(`服务进程已退出，无需停止 PID ${servicePid}`);
    return null;
  }
  if (!isServiceIdentity(identity, { serviceRoot, servicePort })) {
    throw new InstallerError(`指定 PID ${servicePid} 不是可验证的本地回信服务，拒绝终止`, {
      code: "service_identity_mismatch",
      details: { pid: servicePid, name: identity.name, commandLine: identity.commandLine }
    });
  }
  log(`已验证本地回信服务 PID ${servicePid}`, {
    commandLine: identity.commandLine,
    creationDate: identity.creationDate || null
  });
  return identity;
}

export async function stopVerifiedService({
  servicePid,
  expectedIdentity,
  serviceRoot,
  servicePort = null,
  serviceVersion = null,
  serviceHost = "127.0.0.1",
  queryProcessImpl = (pid) => queryWindowsProcessIdentity(pid),
  shutdownImpl = (options) => requestAuthenticatedShutdown(options),
  sleepImpl = delay,
  now = () => Date.now(),
  timeoutMilliseconds = SERVICE_STOP_TIMEOUT_MILLISECONDS,
  log = () => {}
} = {}) {
  const numericPid = Number(servicePid);
  if (!Number.isSafeInteger(numericPid) || numericPid <= 0) {
    throw new InstallerError(`无效的服务进程编号：${servicePid}`, { code: "invalid_service_pid" });
  }
  if (!expectedIdentity) return { stopped: false, alreadyStopped: true };

  const current = normalizeProcessIdentity(await queryProcessImpl(numericPid));
  if (!current) {
    log(`服务 PID ${numericPid} 在停止前已退出`);
    return { stopped: false, alreadyStopped: true };
  }
  if (!sameProcessIdentity(expectedIdentity, current)) {
    throw new InstallerError(`服务 PID ${numericPid} 已被其他进程复用，拒绝终止`, {
      code: "service_pid_reused",
      details: { expected: expectedIdentity, current }
    });
  }
  if (!isServiceIdentity(current, { serviceRoot, servicePort })) {
    throw new InstallerError(`停止前无法再次验证本地回信服务 PID ${numericPid}`, {
      code: "service_identity_mismatch"
    });
  }
  let shutdown;
  try {
    shutdown = await shutdownImpl({
      pid: numericPid,
      host: serviceHost,
      port: servicePort,
      expectedVersion: serviceVersion,
      serviceRoot,
      identity: current
    });
  } catch (error) {
    throw new InstallerError(`认证 HTTP 停服请求失败，拒绝终止 PID ${numericPid}：${error.message}`, {
      code: "service_shutdown_failed"
    });
  }
  if (!shutdown?.ok) {
    throw new InstallerError(`认证 HTTP 停服未确认成功，拒绝继续安装 PID ${numericPid}`, {
      code: "service_shutdown_failed",
      details: shutdown || null
    });
  }
  log(`已请求本地回信服务通过认证 HTTP 停止 PID ${numericPid}`, {
    serviceVersion: shutdown.serviceVersion || serviceVersion || null
  });
  const startedAt = now();
  const deadline = startedAt + timeoutMilliseconds;
  for (;;) {
    const observed = normalizeProcessIdentity(await queryProcessImpl(numericPid));
    if (!observed) {
      log(`本地回信服务 PID ${numericPid} 已退出`);
      return { stopped: true, alreadyStopped: false };
    }
    if (!sameProcessIdentity(expectedIdentity, observed)) {
      throw new InstallerError(`停止服务后 PID ${numericPid} 被其他进程复用，拒绝继续安装`, {
        code: "service_pid_reused",
        details: { expected: expectedIdentity, current: observed }
      });
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new InstallerError(`等待本地回信服务退出超时（PID ${numericPid}）`, {
        code: "service_stop_timeout"
      });
    }
    await sleepImpl(Math.min(HANDOFF_POLL_MILLISECONDS, remaining));
  }
}

export async function handoffUpdate({
  gameRoot,
  installerPath,
  expectedSha256,
  servicePid,
  serviceRoot = null,
  serviceHost = "127.0.0.1",
  servicePort = null,
  serviceVersion = null,
  platform = process.platform,
  handoffPid = process.pid,
  processListImpl = null,
  queryProcessImpl = null,
  shutdownImpl = null,
  spawnImpl = spawnProcess,
  sleepImpl = delay,
  now = () => Date.now(),
  logImpl = null,
  logPath = null,
  protectedProcessTimeoutMilliseconds = HANDOFF_WAIT_TIMEOUT_MILLISECONDS,
  serviceStopTimeoutMilliseconds = SERVICE_STOP_TIMEOUT_MILLISECONDS
} = {}) {
  const layout = resolveLayout(gameRoot);
  const log = handoffLogWriter(
    logPath ? path.resolve(logPath) : path.join(layout.serviceRoot, "logs", "installer", "update-handoff.log"),
    logImpl
  );
  try {
    if (platform !== "win32") {
      throw new InstallerError("更新交接当前只支持 Windows，已安全停止", { code: "platform_unsupported" });
    }
    assertDirectory(layout.gameRoot, "游戏根目录");
    const normalizedServiceRoot = serviceRoot == null ? layout.serviceRoot : path.resolve(String(serviceRoot));
    if (normalizeComparablePath(normalizedServiceRoot) !== normalizeComparablePath(layout.serviceRoot)) {
      throw new InstallerError("更新交接的本地服务目录与游戏目录不一致", { code: "service_root_mismatch" });
    }
    const normalizedInstallerPath = path.resolve(String(installerPath || ""));
    if (!String(installerPath || "").trim()) {
      throw new InstallerError("更新交接缺少安装包路径", { code: "missing_installer_path" });
    }
    assertRegularFile(normalizedInstallerPath, "更新安装包");
    const normalizedHash = String(expectedSha256 || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(normalizedHash)) {
      throw new InstallerError("更新交接缺少有效的 SHA-256", { code: "invalid_expected_sha256" });
    }
    if (sha256File(normalizedInstallerPath) !== normalizedHash) {
      throw new InstallerError("更新安装包在交接前 SHA-256 校验失败，已拒绝运行", {
        code: "handoff_installer_hash_mismatch"
      });
    }

    const normalizedPid = Number(servicePid);
    if (!Number.isSafeInteger(normalizedPid) || normalizedPid <= 0) {
      throw new InstallerError(`无效的服务进程编号：${servicePid}`, { code: "invalid_service_pid" });
    }
    const normalizedPort = servicePort == null ? null : Number(servicePort);
    if (normalizedPort != null && (!Number.isSafeInteger(normalizedPort) || normalizedPort <= 0 || normalizedPort > 65535)) {
      throw new InstallerError(`无效的服务端口：${servicePort}`, { code: "invalid_service_port" });
    }
    const query = queryProcessImpl || ((pid) => queryWindowsProcessIdentity(pid));
    const shutdown = shutdownImpl || ((options) => requestAuthenticatedShutdown(options));
    const identity = await captureServiceIdentity({
      servicePid: normalizedPid,
      serviceRoot: normalizedServiceRoot,
      servicePort: normalizedPort,
      queryProcessImpl: query,
      log
    });
    const wait = await waitForProtectedProcesses({
      platform,
      gameRoot: layout.gameRoot,
      processListImpl: processListImpl || (() => readWindowsProtectedProcessNames(layout.gameRoot)),
      sleepImpl,
      now,
      timeoutMilliseconds: protectedProcessTimeoutMilliseconds,
      log
    });
    const service = await stopVerifiedService({
      servicePid: normalizedPid,
      expectedIdentity: identity,
      serviceRoot: normalizedServiceRoot,
      servicePort: normalizedPort,
      serviceVersion,
      serviceHost,
      queryProcessImpl: query,
      shutdownImpl: shutdown,
      sleepImpl,
      now,
      timeoutMilliseconds: serviceStopTimeoutMilliseconds,
      log
    });
    const finalSha256 = sha256File(normalizedInstallerPath);
    if (finalSha256 !== normalizedHash) {
      throw new InstallerError("停止服务后更新安装包 SHA-256 校验失败，已拒绝运行", {
        code: "handoff_installer_hash_mismatch"
      });
    }
    const installerArguments = installerLaunchArguments(layout.gameRoot, handoffPid);
    let child;
    try {
      child = spawnImpl(normalizedInstallerPath, installerArguments, {
        cwd: layout.gameRoot,
        detached: true,
        stdio: "ignore",
        windowsHide: false
      });
      if (!child) throw new Error("spawn returned no child process");
      child.unref?.();
      child.once?.("error", (error) => log(`安装程序异步启动失败：${error.message}`));
    } catch (error) {
      throw new InstallerError(`启动更新安装程序失败：${error.message}`, {
        code: "installer_spawn_failed"
      });
    }
    log("已启动更新安装程序；交接程序即将退出", {
      installerPath: normalizedInstallerPath,
      waitPid: Number(handoffPid),
      protectedProcessWait: wait,
      serviceStopped: service.stopped || service.alreadyStopped
    });
    return {
      ok: true,
      launched: true,
      installerStarted: true,
      installerPath: normalizedInstallerPath,
      sha256: finalSha256,
      waitPid: Number(handoffPid),
      serviceStopped: service.stopped || service.alreadyStopped,
      protectedProcessesCleared: true
    };
  } catch (error) {
    log(`更新交接安全失败：${error instanceof Error ? error.message : String(error)}`, {
      code: error?.code || "handoff_error",
      details: error?.details || null
    });
    throw error;
  }
}

export function resolveLayout(gameRootValue) {
  const gameRoot = path.resolve(gameRootValue);
  const serviceRoot = path.join(gameRoot, "linli-local-mail");
  return {
    gameRoot,
    serviceRoot,
    feappPath: path.join(gameRoot, EXPECTED_GAME_VERSION, "resources", "feapp.dat"),
    webplayerPath: path.join(gameRoot, EXPECTED_GAME_VERSION, "resources", "webplayer.dat"),
    launcherPath: path.join(gameRoot, "launcher.exe"),
    originalLauncherPath: path.join(gameRoot, "launcher.original.exe"),
    launcherManifestPath: path.join(gameRoot, "launcher-wrapper.json"),
    statePath: safeJoin(serviceRoot, STATE_RELATIVE_PATH)
  };
}

export function preflight({
  gameRoot,
  waitPid = null,
  skipProcessCheck = false,
  skipWriteProbe = false,
  platform = process.platform,
  processListImpl = null
} = {}) {
  if (!gameRoot) throw new InstallerError("没有提供游戏根目录", { code: "missing_game_root" });
  if (process.platform === "win32" && !process.env.PROCESSOR_ARCHITEW6432 && process.arch !== "x64") {
    throw new InstallerError("本安装包仅支持 64 位 Windows", { code: "unsupported_architecture" });
  }
  const layout = resolveLayout(gameRoot);
  assertDirectory(layout.gameRoot, "游戏根目录");
  assertRegularFile(layout.feappPath, `${EXPECTED_GAME_VERSION} 前端包`);
  assertRegularFile(layout.webplayerPath, `${EXPECTED_GAME_VERSION} webplayer 前端包`);
  assertRegularFile(layout.launcherPath, "游戏启动器");
  waitForPid(waitPid ? Number(waitPid) : null);
  if (!skipProcessCheck) {
    const running = runningLauncherNames({ platform, processListImpl, gameRoot: layout.gameRoot });
    if (running.length) {
      throw new InstallerError(
        `游戏或启动器仍在运行：${running.join("、")}。请完全退出游戏和启动器后重试；不会强制结束进程，也不会跳过进程保护。`,
        { code: "launcher_running" }
      );
    }
  }
  if (!skipWriteProbe) {
    writeProbe(layout.gameRoot);
    if (fs.existsSync(layout.serviceRoot)) writeProbe(layout.serviceRoot);
  }
  return {
    ok: true,
    gameVersion: EXPECTED_GAME_VERSION,
    gameRoot: layout.gameRoot,
    serviceRoot: layout.serviceRoot,
    feappPath: layout.feappPath,
    webplayerPath: layout.webplayerPath
  };
}

function snapshotPath(transaction, root, relative, namespace) {
  const normalized = normalizeRelative(relative);
  const target = safeJoin(root, normalized);
  let stat = null;
  try { stat = fs.lstatSync(target); } catch {}
  if (stat?.isSymbolicLink()) {
    throw new InstallerError(`拒绝处理符号链接或重解析点：${target}`, { code: "unsafe_existing_path" });
  }
  const snapshot = {
    root: path.resolve(root),
    relative: normalized,
    existed: Boolean(stat),
    type: stat?.isDirectory() ? "directory" : stat?.isFile() ? "file" : stat ? "other" : "missing",
    backupRelative: null
  };
  if (snapshot.type === "other") {
    throw new InstallerError(`无法备份特殊文件：${target}`, { code: "unsafe_existing_path" });
  }
  if (snapshot.existed) {
    snapshot.backupRelative = normalizeRelative(`snapshots/${namespace}/${normalized}`);
    const backup = safeJoin(transaction.backupRoot, snapshot.backupRelative);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    if (snapshot.type === "file") fs.copyFileSync(target, backup);
    else fs.cpSync(target, backup, { recursive: true, force: false, errorOnExist: true });
  }
  transaction.snapshots.push(snapshot);
}

function restoreSnapshot(transaction, snapshot) {
  const target = safeJoin(snapshot.root, snapshot.relative);
  removeExisting(target, { allowDirectory: true });
  if (!snapshot.existed) return;
  const backup = safeJoin(transaction.backupRoot, snapshot.backupRelative);
  if (snapshot.type === "file") {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(backup, target);
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(backup, target, { recursive: true, force: false, errorOnExist: true });
  }
}

function persistTransaction(transaction, transactionFile) {
  transaction.updatedAt = new Date().toISOString();
  writeJson(path.join(transaction.backupRoot, "transaction.json"), transaction);
  if (transactionFile) writeJson(transactionFile, transaction);
}

function readTransaction(transactionFile) {
  const transaction = readJson(transactionFile);
  if (!transaction?.backupRoot || !Array.isArray(transaction.snapshots)) {
    throw new InstallerError("安装事务文件不完整", { code: "invalid_transaction" });
  }
  return transaction;
}

function recoverInterruptedTransactions(serviceRoot) {
  const transactionsRoot = path.join(serviceRoot, "backups", "installer-transactions");
  if (!fs.existsSync(transactionsRoot)) return [];
  const recovered = [];
  for (const entry of fs.readdirSync(transactionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const transactionPath = path.join(transactionsRoot, entry.name, "transaction.json");
    if (!fs.existsSync(transactionPath)) continue;
    const transaction = readJson(transactionPath, { optional: true });
    if (!transaction || ["committed", "rolled-back"].includes(transaction.status)) continue;
    rollbackTransaction(transaction, transactionPath);
    recovered.push(transaction.id);
  }
  return recovered;
}

export function prepareTransaction({
  gameRoot,
  manifestPath,
  transactionFile,
  waitPid = null,
  skipProcessCheck = false,
  platform = process.platform,
  processListImpl = null
} = {}) {
  const check = preflight({ gameRoot, waitPid, skipProcessCheck, platform, processListImpl });
  const layout = resolveLayout(check.gameRoot);
  const recoveredTransactions = recoverInterruptedTransactions(layout.serviceRoot);
  const manifest = loadRuntimeManifest(manifestPath);
  const id = `${new Date().toISOString().replace(/[-:.TZ]/gu, "")}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const backupRoot = path.join(layout.serviceRoot, "backups", "installer-transactions", id);
  fs.mkdirSync(backupRoot, { recursive: true });
  const oldState = readJson(layout.statePath, { optional: true });
  const managed = new Set(manifest.managedFiles.map((entry) => entry.path));
  for (const entry of oldState?.managedFiles || []) {
    if (entry?.path) managed.add(normalizeRelative(entry.path));
  }
  const transaction = {
    schemaVersion: 1,
    id,
    status: "prepared",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: manifest.version,
    gameRoot: layout.gameRoot,
    serviceRoot: layout.serviceRoot,
    backupRoot,
    manifest,
    snapshots: []
  };
  for (const relative of [...managed].sort()) snapshotPath(transaction, layout.serviceRoot, relative, "program");
  snapshotPath(transaction, layout.serviceRoot, CHARACTER_TARGET_RELATIVE_PATH, "mutable");
  snapshotPath(transaction, layout.serviceRoot, STATE_RELATIVE_PATH, "mutable");
  snapshotPath(transaction, layout.gameRoot, FEAPP_RELATIVE_PATH, "game");
  snapshotPath(transaction, layout.gameRoot, WEBPLAYER_RELATIVE_PATH, "game");
  for (const name of LAUNCHER_NAMES) snapshotPath(transaction, layout.gameRoot, name, "game");
  const shortcutNames = manifest.rootShortcuts.length
    ? manifest.rootShortcuts.map((entry) => entry.name)
    : DEFAULT_SHORTCUT_NAMES;
  for (const name of shortcutNames) snapshotPath(transaction, layout.gameRoot, name, "game");
  persistTransaction(transaction, transactionFile);
  return { ok: true, transactionId: id, transactionFile, backupRoot, recoveredTransactions };
}

function readServicePidRecord(layout) {
  const pidPath = path.join(layout.serviceRoot, "data", "service.pid.json");
  let stat = null;
  try { stat = fs.lstatSync(pidPath); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new InstallerError(`无法读取服务 PID 记录：${pidPath}（${error.message}）`, { code: "invalid_service_pid_record" });
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new InstallerError(`服务 PID 记录不是普通文件：${pidPath}`, { code: "invalid_service_pid_record" });
  }
  const record = readJson(pidPath);
  if (!record || Array.isArray(record) || typeof record !== "object") {
    throw new InstallerError(`服务 PID 记录格式无效：${pidPath}`, { code: "invalid_service_pid_record" });
  }
  const pid = Number(record.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new InstallerError(`服务 PID 记录中的 PID 无效：${pidPath}`, { code: "invalid_service_pid_record" });
  }
  const serverPath = String(record.serverPath || "").trim();
  const expectedServerPath = path.join(layout.serviceRoot, "server.mjs");
  if (!serverPath || !isPathWithinRoot(serverPath, layout.serviceRoot)
      || normalizeComparablePath(serverPath) !== normalizeComparablePath(expectedServerPath)) {
    throw new InstallerError(`服务 PID 记录的 serverPath 不在所选服务目录内：${pidPath}`, {
      code: "service_root_mismatch",
      details: { serverPath, serviceRoot: layout.serviceRoot }
    });
  }
  return { pid, serverPath };
}

export async function prepareInstallTransaction({
  gameRoot,
  manifestPath,
  transactionFile,
  waitPid = null,
  platform = process.platform,
  processListImpl = null,
  preflightImpl = preflight,
  prepareImpl = prepareTransaction,
  queryProcessImpl = (pid) => queryWindowsProcessIdentity(pid),
  shutdownImpl = (options) => requestAuthenticatedShutdown(options),
  sleepImpl = delay,
  now = () => Date.now(),
  serviceStopTimeoutMilliseconds = SERVICE_STOP_TIMEOUT_MILLISECONDS,
  log = () => {}
} = {}) {
  const check = await preflightImpl({
    gameRoot,
    waitPid,
    skipWriteProbe: true,
    platform,
    processListImpl
  });
  const layout = resolveLayout(check.gameRoot || gameRoot);
  const record = readServicePidRecord(layout);
  if (record) {
    const identity = normalizeProcessIdentity(await queryProcessImpl(record.pid));
    if (identity) {
      if (!isServiceIdentity(identity, { serviceRoot: layout.serviceRoot })) {
        throw new InstallerError(`指定 PID ${record.pid} 不是所选服务目录中的 node server.mjs，拒绝终止`, {
          code: "service_identity_mismatch",
          details: { pid: record.pid, serverPath: record.serverPath, identity }
        });
      }
      await stopVerifiedService({
        servicePid: record.pid,
        expectedIdentity: identity,
        serviceRoot: layout.serviceRoot,
        servicePort: 27149,
        serviceVersion: null,
        serviceHost: "127.0.0.1",
        queryProcessImpl,
        shutdownImpl,
        sleepImpl,
        now,
        timeoutMilliseconds: serviceStopTimeoutMilliseconds,
        log
      });
    }
  }
  return await prepareImpl({
    gameRoot: layout.gameRoot,
    manifestPath,
    transactionFile,
    waitPid,
    platform,
    processListImpl
  });
}

export function rollbackTransaction(transactionOrFile, transactionFile = null) {
  const transaction = typeof transactionOrFile === "string" ? readTransaction(transactionOrFile) : transactionOrFile;
  const pointer = transactionFile || (typeof transactionOrFile === "string" ? transactionOrFile : null);
  const failures = [];
  for (const snapshot of [...transaction.snapshots].reverse()) {
    try { restoreSnapshot(transaction, snapshot); } catch (error) { failures.push(`${snapshot.relative}: ${error.message}`); }
  }
  transaction.status = failures.length ? "rollback-incomplete" : "rolled-back";
  transaction.rollbackFailures = failures;
  persistTransaction(transaction, pointer);
  if (failures.length) {
    throw new InstallerError(`回滚未完全成功：${failures.join("；")}`, { code: "rollback_incomplete", details: failures });
  }
  return { ok: true, transactionId: transaction.id, status: transaction.status };
}

function runNodeTool(serviceRoot, argumentsList, { allowFailure = false } = {}) {
  const nodePath = path.join(serviceRoot, "runtime", "node.exe");
  assertRegularFile(nodePath, "内置 Node.js");
  const result = spawnSync(nodePath, argumentsList, {
    cwd: serviceRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  const stdout = String(result.stdout || "").trim();
  const stderr = String(result.stderr || "").trim();
  if (result.error || result.status !== 0) {
    if (allowFailure) return { ok: false, status: result.status, stdout, stderr, error: result.error?.message };
    throw new InstallerError(
      `命令执行失败：${argumentsList.join(" ")}（${stderr || stdout || result.error?.message || `exit ${result.status}`}）`,
      { code: "installer_command_failed" }
    );
  }
  let json = null;
  if (stdout) {
    try { json = JSON.parse(stdout); } catch {}
  }
  return { ok: true, status: result.status, stdout, stderr, json };
}

function installFrontendPackages(layout) {
  const baselinePaths = {
    feapp: path.join(layout.serviceRoot, "backups", "required", "official-compatible-0.0.9.627", "feapp.dat"),
    webplayer: path.join(layout.serviceRoot, "backups", "required", "official-compatible-0.0.9.627", "webplayer.dat")
  };
  const overrides = {};
  let verification = runNodeTool(layout.serviceRoot, ["tools/feapp.mjs", "verify"], { allowFailure: true });
  if (!verification.ok || !verification.json?.webplayer) {
    if (!fs.existsSync(baselinePaths.feapp) || !fs.existsSync(baselinePaths.webplayer)) {
      const imported = runNodeTool(layout.serviceRoot, ["tools/feapp.mjs", "import-baseline"]);
      const reports = {
        feapp: imported.json,
        webplayer: imported.json?.webplayer
      };
      for (const [name, report] of Object.entries(reports)) {
        if (report?.source === "rebuilt-by-unpatching" && report.baselinePath) {
          overrides[name] = safeJoin(layout.gameRoot, report.baselinePath);
        }
      }
    }
    const installArguments = ["tools/feapp.mjs", "install"];
    if (overrides.feapp) installArguments.push("--baseline", overrides.feapp);
    if (overrides.webplayer) installArguments.push("--webplayer-baseline", overrides.webplayer);
    runNodeTool(layout.serviceRoot, installArguments);
    const verifyArguments = ["tools/feapp.mjs", "verify"];
    if (overrides.feapp) verifyArguments.push("--baseline", overrides.feapp);
    if (overrides.webplayer) verifyArguments.push("--webplayer-baseline", overrides.webplayer);
    verification = runNodeTool(layout.serviceRoot, verifyArguments);
  }
  if (!verification.json?.webplayer) {
    throw new InstallerError("双前端包校验结果缺少 webplayer.dat", { code: "webplayer_verification_missing" });
  }
  const frontend = {
    feapp: {
      installedSha256: sha256File(layout.feappPath),
      baselineSha256: verification.json?.baselineSha256 || null,
      sourceScriptSha256: verification.json?.sourceScriptSha256 || null
    },
    webplayer: {
      installedSha256: sha256File(layout.webplayerPath),
      baselineSha256: verification.json.webplayer.baselineSha256 || null
    }
  };
  if (overrides.feapp) frontend.feapp.baselineOverride = path.relative(layout.gameRoot, overrides.feapp);
  if (overrides.webplayer) frontend.webplayer.baselineOverride = path.relative(layout.gameRoot, overrides.webplayer);
  return frontend;
}

function atomicReplaceFile(source, destination) {
  const temporaryPath = `${destination}.linli-replace-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.copyFileSync(source, temporaryPath);
  if (sha256File(source) !== sha256File(temporaryPath)) {
    unlinkIfExists(temporaryPath);
    throw new InstallerError(`临时文件校验失败：${destination}`, { code: "copy_verification_failed" });
  }
  removeExisting(destination);
  fs.renameSync(temporaryPath, destination);
}

export function installLauncherWrapper(layout, version) {
  const wrapperPath = path.join(layout.serviceRoot, "native", "linli-launcher-wrapper.exe");
  assertRegularFile(wrapperPath, "启动器包装器");
  assertRegularFile(layout.launcherPath, "游戏启动器");
  const wrapperHash = sha256File(wrapperPath);
  const currentHash = sha256File(layout.launcherPath);
  let manifest = readJson(layout.launcherManifestPath, { optional: true });
  let originalHash = fs.existsSync(layout.originalLauncherPath) ? sha256File(layout.originalLauncherPath) : null;
  const registeredWrapper = manifest?.active === "wrapper"
    && manifest.wrapperSha256
    && String(manifest.wrapperSha256).toLowerCase() === currentHash;

  if (currentHash === wrapperHash) {
    if (!originalHash) {
      throw new InstallerError("launcher.exe 已是包装器，但缺少 launcher.original.exe，拒绝继续覆盖", { code: "missing_official_launcher_backup" });
    }
  } else if (registeredWrapper) {
    if (!originalHash) {
      throw new InstallerError("旧包装器已安装，但缺少官方启动器备份", { code: "missing_official_launcher_backup" });
    }
  } else if (!originalHash) {
    copyFileVerified(layout.launcherPath, layout.originalLauncherPath);
    originalHash = sha256File(layout.originalLauncherPath);
  } else {
    if (manifest?.originalSha256 && String(manifest.originalSha256).toLowerCase() !== originalHash) {
      throw new InstallerError("launcher.original.exe 与清单哈希不一致", { code: "launcher_backup_mismatch" });
    }
    const currentIsOfficial = currentHash === originalHash;
    const currentIsKnownWrapper = manifest?.wrapperSha256
      && String(manifest.wrapperSha256).toLowerCase() === currentHash;
    if (!currentIsOfficial && !currentIsKnownWrapper) {
      throw new InstallerError("当前 launcher.exe 既不是登记的官方启动器，也不是本项目包装器，拒绝覆盖", { code: "unknown_launcher" });
    }
  }

  if (sha256File(layout.launcherPath) !== wrapperHash) atomicReplaceFile(wrapperPath, layout.launcherPath);
  if (sha256File(layout.launcherPath) !== wrapperHash) {
    throw new InstallerError("启动器包装器安装后校验失败", { code: "wrapper_verification_failed" });
  }
  manifest = {
    schemaVersion: 1,
    active: "wrapper",
    originalFile: "launcher.original.exe",
    originalSha256: originalHash,
    wrapperFile: "launcher.exe",
    wrapperSha256: wrapperHash,
    installerVersion: version,
    installedAt: new Date().toISOString()
  };
  writeJson(layout.launcherManifestPath, manifest);
  return manifest;
}

export function restoreLauncher(layout, { removeArtifacts = false } = {}) {
  if (!fs.existsSync(layout.originalLauncherPath)) return { restored: false, reason: "no official launcher backup" };
  assertRegularFile(layout.originalLauncherPath, "官方启动器备份");
  assertRegularFile(layout.launcherPath, "当前游戏启动器");
  const manifest = readJson(layout.launcherManifestPath, { optional: true });
  const originalHash = sha256File(layout.originalLauncherPath);
  const currentHash = sha256File(layout.launcherPath);
  if (manifest?.originalSha256 && String(manifest.originalSha256).toLowerCase() !== originalHash) {
    throw new InstallerError("官方启动器备份哈希与清单不一致，拒绝恢复", { code: "launcher_backup_mismatch" });
  }
  if (manifest?.active === "wrapper" && manifest.wrapperSha256
      && String(manifest.wrapperSha256).toLowerCase() !== currentHash) {
    throw new InstallerError("当前 launcher.exe 已被其他程序修改，拒绝覆盖", { code: "launcher_changed_after_install" });
  }
  if (currentHash !== originalHash) atomicReplaceFile(layout.originalLauncherPath, layout.launcherPath);
  if (sha256File(layout.launcherPath) !== originalHash) {
    throw new InstallerError("官方启动器恢复后校验失败", { code: "launcher_restore_failed" });
  }
  if (removeArtifacts) {
    unlinkIfExists(layout.originalLauncherPath);
    unlinkIfExists(layout.launcherManifestPath);
  } else {
    writeJson(layout.launcherManifestPath, {
      ...(manifest || {}),
      schemaVersion: 1,
      active: "official",
      originalFile: "launcher.original.exe",
      originalSha256: originalHash,
      wrapperFile: "launcher.exe",
      restoredAt: new Date().toISOString()
    });
  }
  return { restored: true, originalSha256: originalHash };
}

export function installRootShortcuts(layout, manifest) {
  const installed = [];
  for (const entry of manifest.rootShortcuts) {
    const source = safeJoin(layout.serviceRoot, entry.source);
    const destination = path.join(layout.gameRoot, entry.name);
    assertRegularFile(source, "启动入口模板");
    if (sha256File(source) !== String(entry.sha256).toLowerCase()) {
      throw new InstallerError(`启动入口模板哈希不符：${entry.name}`, { code: "shortcut_source_mismatch" });
    }
    if (fs.existsSync(destination) && !fs.lstatSync(destination).isFile()) {
      throw new InstallerError(`启动入口目标不是普通文件：${destination}`, { code: "shortcut_collision" });
    }
    copyFileVerified(source, destination);
    installed.push({ name: entry.name, sha256: sha256File(destination) });
  }
  return installed;
}

export function ensureCharacterConfig(layout, previousState = null) {
  const source = safeJoin(layout.serviceRoot, CHARACTER_DEFAULT_RELATIVE_PATH);
  const target = safeJoin(layout.serviceRoot, CHARACTER_TARGET_RELATIVE_PATH);
  assertRegularFile(source, "发行版人设文件");
  const distributedHash = sha256File(source);
  let managed = false;
  let action = "preserved-custom";
  if (!fs.existsSync(target)) {
    copyFileVerified(source, target);
    managed = true;
    action = "created";
  } else {
    assertRegularFile(target, "当前人设文件");
    const currentHash = sha256File(target);
    const previousDefault = previousState?.character?.managedDefaultSha256;
    if (currentHash === distributedHash) {
      managed = true;
      action = "already-current";
    } else if (previousDefault && currentHash === String(previousDefault).toLowerCase()) {
      copyFileVerified(source, target);
      managed = true;
      action = "updated-default";
    }
  }
  JSON.parse(fs.readFileSync(target, "utf8"));
  return {
    action,
    managed,
    distributedSha256: distributedHash,
    managedDefaultSha256: managed ? distributedHash : null,
    currentSha256: sha256File(target)
  };
}

function verifyManagedFiles(serviceRoot, manifest) {
  const mismatches = [];
  for (const entry of manifest.managedFiles) {
    const filePath = safeJoin(serviceRoot, entry.path);
    if (!fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile()) {
      mismatches.push({ path: entry.path, reason: "missing" });
      continue;
    }
    const actual = sha256File(filePath);
    if (actual !== String(entry.sha256).toLowerCase()) mismatches.push({ path: entry.path, reason: "hash", actual });
  }
  if (mismatches.length) {
    throw new InstallerError(`受管文件校验失败：${mismatches.map((item) => item.path).join("、")}`, {
      code: "managed_file_verification_failed",
      details: mismatches
    });
  }
  return { files: manifest.managedFiles.length };
}

export function applyTransaction(transactionFile) {
  const transaction = readTransaction(transactionFile);
  const layout = resolveLayout(transaction.gameRoot);
  const manifestPath = path.join(layout.serviceRoot, "runtime-manifest.json");
  const installedManifest = loadRuntimeManifest(manifestPath);
  if (installedManifest.version !== transaction.version) {
    throw new InstallerError("已部署运行时版本与安装事务不一致", { code: "transaction_version_mismatch" });
  }
  transaction.status = "applying";
  persistTransaction(transaction, transactionFile);
  try {
    const managed = verifyManagedFiles(layout.serviceRoot, installedManifest);
    const previousStateSnapshot = transaction.snapshots.find((item) =>
      item.root.toLowerCase() === layout.serviceRoot.toLowerCase() && item.relative === STATE_RELATIVE_PATH);
    const previousState = previousStateSnapshot?.existed
      ? readJson(safeJoin(transaction.backupRoot, previousStateSnapshot.backupRelative), { optional: true })
      : null;
    const character = ensureCharacterConfig(layout, previousState);
    const frontend = installFrontendPackages(layout);
    const launcher = installLauncherWrapper(layout, installedManifest.version);
    const shortcuts = installRootShortcuts(layout, installedManifest);
    const state = {
      schemaVersion: 1,
      version: installedManifest.version,
      gameVersion: EXPECTED_GAME_VERSION,
      gameRoot: layout.gameRoot,
      serviceRoot: layout.serviceRoot,
      installedAt: new Date().toISOString(),
      transactionId: transaction.id,
      managedFiles: installedManifest.managedFiles,
      character,
      feapp: frontend.feapp,
      webplayer: frontend.webplayer,
      launcher,
      shortcuts
    };
    writeJson(layout.statePath, state);
    verifyManagedFiles(layout.serviceRoot, installedManifest);
    if (sha256File(layout.launcherPath) !== launcher.wrapperSha256) {
      throw new InstallerError("最终启动器校验失败", { code: "wrapper_verification_failed" });
    }
    for (const entry of shortcuts) {
      if (sha256File(path.join(layout.gameRoot, entry.name)) !== entry.sha256) {
        throw new InstallerError(`最终启动入口校验失败：${entry.name}`, { code: "shortcut_verification_failed" });
      }
    }
    transaction.status = "verified";
    transaction.result = { managed, character, ...frontend, launcher, shortcuts };
    persistTransaction(transaction, transactionFile);
    return { ok: true, transactionId: transaction.id, version: installedManifest.version, statePath: layout.statePath };
  } catch (error) {
    transaction.failure = { at: new Date().toISOString(), message: error.message, code: error.code || "installer_error" };
    persistTransaction(transaction, transactionFile);
    try { rollbackTransaction(transaction, transactionFile); } catch (rollbackError) {
      throw new InstallerError(`${error.message}；自动回滚也未完全成功：${rollbackError.message}`, {
        code: "apply_and_rollback_failed",
        details: { apply: error.message, rollback: rollbackError.message }
      });
    }
    throw error;
  }
}

export function commitTransaction(transactionFile) {
  const transaction = readTransaction(transactionFile);
  if (transaction.status !== "verified") {
    throw new InstallerError(`事务尚未完成验证，不能提交：${transaction.status}`, { code: "transaction_not_verified" });
  }
  transaction.status = "committed";
  transaction.committedAt = new Date().toISOString();
  persistTransaction(transaction, transactionFile);
  return { ok: true, transactionId: transaction.id, status: transaction.status };
}

function removeOwnedShortcuts(layout, state) {
  const preserved = [];
  const removed = [];
  for (const entry of state?.shortcuts || []) {
    const target = path.join(layout.gameRoot, path.basename(entry.name));
    if (!fs.existsSync(target)) continue;
    if (!fs.lstatSync(target).isFile() || sha256File(target) !== String(entry.sha256).toLowerCase()) {
      preserved.push(entry.name);
      continue;
    }
    unlinkIfExists(target);
    removed.push(entry.name);
  }
  return { removed, preserved };
}

function restoreFrontendForUninstall(layout, state) {
  const packageStates = [
    { name: "feapp", path: layout.feappPath, state: state?.feapp, description: "feapp.dat" },
    { name: "webplayer", path: layout.webplayerPath, state: state?.webplayer, description: "webplayer.dat" }
  ];
  const recorded = packageStates.filter((item) => item.state?.installedSha256);
  const results = {
    feapp: { restored: false, reason: "no installer state" },
    webplayer: { restored: false, reason: "not recorded in legacy installer state" }
  };
  if (!recorded.length) return results;

  for (const item of recorded) {
    assertRegularFile(item.path, item.description);
    const currentHash = sha256File(item.path);
    if (currentHash !== String(item.state.installedSha256).toLowerCase()) {
      throw new InstallerError(
        `当前 ${item.description} 已在安装后被其他程序修改，卸载器不会覆盖它`,
        { code: `${item.name}_changed_after_install` }
      );
    }
  }

  const restoreArguments = ["tools/feapp.mjs", "restore"];
  if (recorded.length === 1) restoreArguments.push("--package", recorded[0].name);
  for (const item of recorded) {
    if (!item.state.baselineOverride) continue;
    const overridePath = safeJoin(layout.gameRoot, item.state.baselineOverride);
    assertRegularFile(overridePath, `${item.name} 临时基线`);
    restoreArguments.push(item.name === "feapp" ? "--baseline" : "--webplayer-baseline", overridePath);
  }
  const restored = runNodeTool(layout.serviceRoot, restoreArguments);
  for (const item of recorded) {
    results[item.name] = {
      restored: true,
      result: restored.json?.[item.name] || restored.json,
      sha256: sha256File(item.path)
    };
  }
  return results;
}

export function uninstall({
  gameRoot,
  deleteUserData = false,
  skipProcessCheck = false,
  platform = process.platform,
  processListImpl = null
} = {}) {
  const layout = resolveLayout(gameRoot);
  assertRegularFile(layout.launcherPath, "游戏启动器");
  if (!skipProcessCheck) {
    const running = runningLauncherNames({ platform, processListImpl, gameRoot: layout.gameRoot });
    if (running.length) {
      throw new InstallerError(
        `游戏或启动器仍在运行：${running.join("、")}。请完全退出游戏和启动器后重试卸载；不会强制结束进程。`,
        { code: "launcher_running" }
      );
    }
  }
  const state = readJson(layout.statePath, { optional: true });
  if (!state) throw new InstallerError("找不到安装状态，拒绝盲目恢复游戏文件", { code: "missing_installer_state" });
  const frontend = restoreFrontendForUninstall(layout, state);
  const feapp = frontend.feapp;
  const webplayer = frontend.webplayer;
  const launcher = restoreLauncher(layout, { removeArtifacts: true });
  const shortcuts = removeOwnedShortcuts(layout, state);
  const uninstalledState = {
    ...state,
    active: false,
    uninstalledAt: new Date().toISOString(),
    uninstallResult: { feapp, webplayer, launcher, shortcuts }
  };
  writeJson(layout.statePath, uninstalledState);
  if (deleteUserData) {
    for (const relative of ["data", "imports", "logs", "backups", "config/characters"]) {
      removeTreeSafe(safeJoin(layout.serviceRoot, relative));
    }
  }
  return { ok: true, deleteUserData, feapp, webplayer, launcher, shortcuts };
}

function printResult(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const [command = "help", ...rest] = process.argv.slice(2);
  const options = parseArguments(rest);
  const gameRoot = options["game-root"] || path.dirname(DEFAULT_SERVICE_ROOT);
  if (command === "handoff") {
    printResult(await handoffUpdate({
      gameRoot,
      installerPath: options.installer,
      expectedSha256: options.sha256,
      servicePid: options["service-pid"],
      serviceRoot: options["service-root"] || null,
      serviceHost: options["service-host"] || "127.0.0.1",
      servicePort: options["service-port"] || null,
      serviceVersion: options["service-version"] || null,
      logPath: options.log || null
    }));
    return;
  }
  if (command === "preflight") {
    printResult(preflight({
      gameRoot,
      waitPid: options["wait-pid"] || null,
      skipProcessCheck: Boolean(options["skip-process-check"]),
      skipWriteProbe: Boolean(options["skip-write-probe"])
    }));
    return;
  }
  if (command === "prepare") {
    printResult(await prepareInstallTransaction({
      gameRoot,
      manifestPath: options.manifest,
      transactionFile: options.transaction,
      waitPid: options["wait-pid"] || null
    }));
    return;
  }
  if (command === "apply") {
    printResult(applyTransaction(options.transaction));
    return;
  }
  if (command === "commit") {
    printResult(commitTransaction(options.transaction));
    return;
  }
  if (command === "rollback") {
    printResult(rollbackTransaction(options.transaction));
    return;
  }
  if (command === "uninstall") {
    printResult(uninstall({
      gameRoot,
      deleteUserData: Boolean(options["delete-user-data"]),
      skipProcessCheck: Boolean(options["skip-process-check"])
    }));
    return;
  }
  throw new InstallerError(
    "用法：installer-core.mjs <handoff|preflight|prepare|apply|commit|rollback|uninstall> [选项]",
    { code: "usage" }
  );
}

if (path.resolve(process.argv[1] || "") === path.resolve(MODULE_PATH)) {
  main().catch((error) => {
    const payload = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: error?.code || "installer_error",
      details: error?.details || null
    };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 1;
  });
}
