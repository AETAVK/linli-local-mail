import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKUP_ROOT = path.join(ROOT, "backups", "user-data");
const DATABASE_PATH = path.join(ROOT, "data", "mail-poc.sqlite3");
const SECRET_PATH = path.join(ROOT, "data", "secrets.dpapi.json");
const IMPORT_HISTORY_PATH = path.join(ROOT, "imports", "history");
const RECOVERY_ROOT = path.join(ROOT, "backups", "recovery", "pre-restore");

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function copyTree(source, target) {
  if (!fs.existsSync(source)) return;
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(source)) copyTree(path.join(source, name), path.join(target, name));
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function relativeFiles(root) {
  const values = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name !== "manifest.json") values.push(path.relative(root, absolute).replaceAll("\\", "/"));
    }
  }
  walk(root);
  return values.sort();
}

async function createBackup() {
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  const destination = path.join(BACKUP_ROOT, timestamp());
  fs.mkdirSync(destination, { recursive: false });

  const sourceDatabase = new DatabaseSync(DATABASE_PATH, { readOnly: true });
  try {
    await sqliteBackup(sourceDatabase, path.join(destination, "mail.sqlite3"));
  } finally {
    sourceDatabase.close();
  }
  copyTree(SECRET_PATH, path.join(destination, "data", "secrets.dpapi.json"));
  copyTree(path.join(ROOT, "config"), path.join(destination, "config"));
  copyTree(IMPORT_HISTORY_PATH, path.join(destination, "imports", "history"));

  const files = relativeFiles(destination);
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    source: ROOT,
    files: Object.fromEntries(files.map((name) => [name, sha256(path.join(destination, name))]))
  };
  fs.writeFileSync(path.join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ created: destination, files: files.length, databaseIntegrity: "snapshot completed" }, null, 2));
  return destination;
}

async function serviceIsRunning() {
  try {
    const response = await fetch("http://127.0.0.1:27149/health");
    return response.ok;
  } catch {
    return false;
  }
}

function validateBackup(directory) {
  const resolvedRoot = path.resolve(BACKUP_ROOT);
  const resolved = path.resolve(directory);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("Restore source must be inside backups/user-data");
  const manifestPath = path.join(resolved, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.version !== 1 || typeof manifest.files !== "object") throw new Error("Unsupported backup manifest");
  for (const [name, expected] of Object.entries(manifest.files)) {
    const candidate = path.resolve(resolved, name);
    if (!candidate.startsWith(`${resolved}${path.sep}`)) throw new Error(`Unsafe backup path: ${name}`);
    if (!fs.existsSync(candidate) || sha256(candidate) !== expected) throw new Error(`Backup hash mismatch: ${name}`);
  }
  if (!manifest.files["mail.sqlite3"]) throw new Error("Backup does not contain mail.sqlite3");
  return { resolved, manifest };
}

async function restoreBackup(directory, confirmed) {
  if (!confirmed) throw new Error("Restore overwrites current local mail data; repeat with --yes after checking the backup path");
  if (await serviceIsRunning()) throw new Error("Stop the local mail service before restoring a backup");
  const { resolved } = validateBackup(directory);

  const recoveryRoot = path.join(RECOVERY_ROOT, timestamp());
  fs.mkdirSync(recoveryRoot, { recursive: true });
  if (fs.existsSync(DATABASE_PATH)) fs.copyFileSync(DATABASE_PATH, path.join(recoveryRoot, "mail.sqlite3"));
  if (fs.existsSync(SECRET_PATH)) copyTree(SECRET_PATH, path.join(recoveryRoot, "data", "secrets.dpapi.json"));
  copyTree(path.join(ROOT, "config"), path.join(recoveryRoot, "config"));
  copyTree(IMPORT_HISTORY_PATH, path.join(recoveryRoot, "imports", "history"));

  fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
  const temporaryDatabase = `${DATABASE_PATH}.restore-${process.pid}`;
  fs.copyFileSync(path.join(resolved, "mail.sqlite3"), temporaryDatabase);
  fs.copyFileSync(temporaryDatabase, DATABASE_PATH);
  fs.unlinkSync(temporaryDatabase);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${DATABASE_PATH}${suffix}`;
    if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
  }
  if (fs.existsSync(path.join(resolved, "data", "secrets.dpapi.json"))) {
    copyTree(path.join(resolved, "data", "secrets.dpapi.json"), SECRET_PATH);
  }
  if (fs.existsSync(path.join(resolved, "config"))) copyTree(path.join(resolved, "config"), path.join(ROOT, "config"));
  const historySource = fs.existsSync(path.join(resolved, "imports", "history"))
    ? path.join(resolved, "imports", "history")
    : path.join(resolved, "history");
  if (fs.existsSync(historySource)) copyTree(historySource, IMPORT_HISTORY_PATH);
  console.log(JSON.stringify({ restored: resolved, previousDataRecovery: recoveryRoot }, null, 2));
}

function verifyBackup(directory) {
  const { resolved, manifest } = validateBackup(directory);
  const database = new DatabaseSync(path.join(resolved, "mail.sqlite3"), { readOnly: true });
  let integrity;
  try {
    integrity = database.prepare("PRAGMA quick_check").get().quick_check;
  } finally {
    database.close();
  }
  if (integrity !== "ok") throw new Error(`Backup SQLite integrity check failed: ${integrity}`);
  console.log(JSON.stringify({ verified: resolved, createdAt: manifest.createdAt, files: Object.keys(manifest.files).length, integrity }, null, 2));
}

async function main() {
  const [command = "create", source, confirmation] = process.argv.slice(2);
  if (command === "create") {
    await createBackup();
    return;
  }
  if (command === "restore" && source) {
    await restoreBackup(source, confirmation === "--yes");
    return;
  }
  if (command === "verify" && source) {
    verifyBackup(source);
    return;
  }
  throw new Error("Usage: node tools/backup.mjs create | verify <backup-directory> | restore <backup-directory> --yes");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
