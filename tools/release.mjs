import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const ALLOW_DIRTY = process.argv.includes("--allow-dirty");
// 运行时包只从这份白名单取文件；源码仓库中的 docs/tests/历史/开发工具不会进入玩家包。
// 目录项表示递归包含该目录，文件项表示只包含该文件。
const RUNTIME_SOURCE_ALLOWLIST = [
  "README.md",
  "LICENSE",
  "NOTICE.md",
  "SOURCE_CODE.md",
  "THIRD_PARTY_NOTICES.md",
  "Install.cmd",
  "Start-LinliLocalMail.ps1",
  "Stop-LinliLocalMail.ps1",
  "server.mjs",
  "src",
  "frontend",
  "config/characters/linli.v1.json",
  "tools/backup.mjs",
  "tools/doctor.mjs",
  "tools/feapp.mjs",
  "tools/history.mjs",
  "tools/install.ps1",
  "tools/install-launcher-wrapper.ps1",
  "tools/restore-launcher.ps1"
];

const GENERATED_RUNTIME_FILES = ["native/linli-launcher-wrapper.exe"];
const RUNTIME_ALLOWLIST = [...RUNTIME_SOURCE_ALLOWLIST, ...GENERATED_RUNTIME_FILES];

const FORBIDDEN = [
  "docs/",
  "tests/",
  "imports/",
  "data/",
  "logs/",
  "backups/",
  "archive/",
  "dist/",
  "native/linli-launcher-wrapper.pdb"
];

const ROOT_CMD_FILES = {
  "Start-LinliLocalMail.cmd": "@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0linli-local-mail\\Start-LinliLocalMail.ps1\"\r\n",
  "Start-LinliLocalMail-ServiceOnly.cmd": "@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0linli-local-mail\\Start-LinliLocalMail.ps1\" -NoGame\r\n",
  "Stop-LinliLocalMail.cmd": "@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0linli-local-mail\\Stop-LinliLocalMail.ps1\"\r\n"
};

function git(args, options = {}) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true, ...options }).trim();
}

function assertCleanTree() {
  if (ALLOW_DIRTY) return;
  const status = git(["status", "--porcelain"]);
  if (status) {
    throw new Error("Working tree is not clean; commit or stash before building a release. Use --allow-dirty to override for local testing.\n" + status);
  }
}

function trackedFilesUnder(sourcePath) {
  const output = git(["ls-files", "-z", "--", sourcePath], { encoding: "utf8" });
  return output.split("\0").filter(Boolean);
}

function overlayDirtyRuntimeSources(staging) {
  if (!ALLOW_DIRTY) return;

  // git archive 保证发布包不会带入未跟踪的私有文件；本地 --allow-dirty
  // 仍需把已跟踪文件的工作树修改覆盖到暂存区，否则候选包会落后于当前源码。
  for (const source of RUNTIME_SOURCE_ALLOWLIST) {
    const sourcePath = path.join(ROOT, source);
    const sourceStat = fs.existsSync(sourcePath) ? fs.statSync(sourcePath) : null;
    const files = sourceStat?.isDirectory()
      ? trackedFilesUnder(source)
      : [source];

    for (const relative of files) {
      const currentPath = path.join(ROOT, relative);
      const targetPath = path.join(staging, relative);
      if (fs.existsSync(currentPath) && fs.statSync(currentPath).isFile()) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(currentPath, targetPath);
      } else {
        fs.rmSync(targetPath, { recursive: true, force: true });
      }
    }
  }
}

function assertPublishedSourceLocation() {
  if (process.argv.includes("--allow-unpublished-source")) return;
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const repository = typeof packageMetadata.repository === "string"
    ? packageMetadata.repository
    : packageMetadata.repository?.url;
  const sourceNotice = fs.readFileSync(path.join(ROOT, "SOURCE_CODE.md"), "utf8");
  if (!repository || repository.includes("SOURCE_REPOSITORY_URL") || sourceNotice.includes("SOURCE_REPOSITORY_URL")) {
    throw new Error(
      "Public source repository URL is not configured. Replace SOURCE_REPOSITORY_URL in package.json and SOURCE_CODE.md before building a public release."
    );
  }
}

function buildLauncherWrapper() {
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "tools/build-launcher-wrapper.ps1", "-Clean"],
    { cwd: ROOT, stdio: "inherit", windowsHide: true }
  );
  const wrapper = path.join(ROOT, "native", "linli-launcher-wrapper.exe");
  if (!fs.existsSync(wrapper)) throw new Error(`Launcher wrapper build did not produce ${wrapper}`);
  return wrapper;
}

function assertNoForbidden(entries) {
  const violations = [];
  for (const entry of entries) {
    const normalized = String(entry).replace(/\\/g, "/");
    for (const forbidden of FORBIDDEN) {
      if (normalized === forbidden || normalized.startsWith(forbidden)) violations.push(normalized);
    }
  }
  if (violations.length) {
    throw new Error(`Private/development files leaked into the archive:\n${violations.join("\n")}`);
  }
}

function isRuntimePathAllowed(entry) {
  return RUNTIME_ALLOWLIST.some((allowed) =>
    entry === allowed || entry.startsWith(`${allowed}/`)
  );
}

function assertRuntimeAllowlist(entries) {
  const generated = new Set(Object.keys(ROOT_CMD_FILES).map((name) => `game-root-shortcuts/${name}`));
  const unexpected = entries.filter((entry) => !isRuntimePathAllowed(entry) && !generated.has(entry));
  const missing = RUNTIME_ALLOWLIST.filter((allowed) => {
    if (allowed.includes("/")) return !entries.includes(allowed);
    return !entries.some((entry) => entry === allowed || entry.startsWith(`${allowed}/`));
  });
  if (unexpected.length || missing.length) {
    throw new Error(
      `Runtime allowlist mismatch; unexpected=${unexpected.join(",")} missing=${missing.join(",")}`
    );
  }
}

function listArchiveEntries(zipPath) {
  // Windows 10+ 自带 bsdtar，可列出 zip 条目。
  const output = execFileSync("tar", ["-tf", zipPath], { encoding: "utf8", windowsHide: true });
  return output.split(/\r?\n/).filter(Boolean);
}

const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const zipName = `linli-local-mail-${version}.zip`;
const zipPath = path.join(DIST, zipName);

assertCleanTree();
assertPublishedSourceLocation();
const builtWrapper = buildLauncherWrapper();
fs.mkdirSync(DIST, { recursive: true });

const staging = fs.mkdtempSync(path.join(os.tmpdir(), "linli-release-"));
try {
  // 直接按运行时白名单从 HEAD 取文件，避免先把源码仓库的私人数据复制进暂存目录。
  const tarPath = path.join(staging, "archive.tar");
  execFileSync(
    "git",
    ["archive", "--format=tar", "-o", tarPath, "HEAD", "--", ...RUNTIME_SOURCE_ALLOWLIST],
    { cwd: ROOT, windowsHide: true }
  );
  execFileSync("tar", ["-xf", tarPath, "-C", staging], { windowsHide: true });
  fs.rmSync(tarPath, { force: true });
  overlayDirtyRuntimeSources(staging);

  const wrapperBinary = path.join(staging, "native", "linli-launcher-wrapper.exe");
  fs.mkdirSync(path.dirname(wrapperBinary), { recursive: true });
  fs.copyFileSync(builtWrapper, wrapperBinary);

  // 根目录启动入口模板：接收者复制到游戏根目录即可。
  const shortcuts = path.join(staging, "game-root-shortcuts");
  fs.mkdirSync(shortcuts, { recursive: true });
  for (const [name, content] of Object.entries(ROOT_CMD_FILES)) {
    fs.writeFileSync(path.join(shortcuts, name), content, "utf8");
  }

  const entries = [];
  const walk = (directory, prefix = "") => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) walk(path.join(directory, item.name), relative);
      else entries.push(relative);
    }
  };
  walk(staging);
  assertNoForbidden(entries);
  assertRuntimeAllowlist(entries);

  if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
  // bsdtar（Windows 10+ 自带）按扩展名 -a 生成 zip；数组传参天然处理含空格路径。
  execFileSync("tar", ["-a", "-cf", zipPath, "-C", staging, "."], { windowsHide: true });

  const zipBuffer = fs.readFileSync(zipPath);
  const sha256 = crypto.createHash("sha256").update(zipBuffer).digest("hex");
  fs.writeFileSync(path.join(DIST, `${zipName}.sha256`), `${sha256}  ${zipName}\n`, "utf8");

  assertNoForbidden(listArchiveEntries(zipPath));

  console.log(JSON.stringify({
    release: zipName,
    path: zipPath,
    sha256,
    files: entries.length,
    runtimeAllowlist: RUNTIME_ALLOWLIST
  }, null, 2));
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
