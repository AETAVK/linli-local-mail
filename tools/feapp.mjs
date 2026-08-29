import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GAME_ROOT = path.resolve(ROOT, "..");
const BASELINE_PATH = path.join(ROOT, "backups", "required", "official-compatible-0.0.9.627", "feapp.dat");
const TARGET_PATH = path.join(GAME_ROOT, "0.0.9.627", "resources", "feapp.dat");
const FRONTEND_SCRIPT_PATH = path.join(ROOT, "frontend", "local-mail-poc.js");
const LOG_PATH = path.join(ROOT, "logs", "last-patch.json");
const EXPECTED_BASELINE_SHA256 = "507d59e31e98596c20ebff43f62de4f9c1d28d48e155fdd500a4dd8cbe09e81b";
const INDEX_ENTRY = "index.html";
const MAIN_ENTRY = "assets/main-31595bd3.js";
const LOCAL_SCRIPT_ENTRY = "assets/local-mail-poc.js";

const PATCH_RULES = [
  ["Te.post(\"/letter/send\"", "window.__LOCAL_MAIL_HTTP__.post(\"/letter/send\""],
  ["Te.get(\"/letter/list\"", "window.__LOCAL_MAIL_HTTP__.get(\"/letter/list\""],
  ["Te.get(\"/letter/detail\"", "window.__LOCAL_MAIL_HTTP__.get(\"/letter/detail\""],
  ["Te.get(\"/letter/unread_count\"", "window.__LOCAL_MAIL_HTTP__.get(\"/letter/unread_count\""],
  ["Te.post(\"/letter/share\"", "window.__LOCAL_MAIL_HTTP__.post(\"/letter/share\""],
  ["Te.post(\"/letter/resend\"", "window.__LOCAL_MAIL_HTTP__.post(\"/letter/resend\""],
  ["!o(w)&&o(Ss)?(r(),F(Be,", "!0?(r(),F(Be,"],
  ["J=async()=>{Q(),await C(),await H(),L=setInterval(H,U)}", "J=async()=>{if(Ie().isOfflineMode)return;Q(),await C(),await H(),L=setInterval(H,U)}"],
  ["w=()=>{l.value=!0}", "w=()=>{Ie().isOfflineMode?ze.warning(\"离线版尚未接入 MIDI 定制演奏服务\"):l.value=!0}"]
];

function sha256Sync(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("ZIP end-of-central-directory record was not found");
}

function readArchive(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const disk = buffer.readUInt16LE(eocdOffset + 4);
  const centralDisk = buffer.readUInt16LE(eocdOffset + 6);
  const count = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (disk !== 0 || centralDisk !== 0 || count === 0xffff || centralOffset === 0xffffffff) {
    throw new Error("Multi-disk and ZIP64 archives are not supported");
  }
  if (centralOffset + centralSize > eocdOffset) throw new Error("ZIP central directory is out of bounds");

  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error(`Bad central entry signature at ${cursor}`);
    const versionMade = buffer.readUInt16LE(cursor + 4);
    const versionNeeded = buffer.readUInt16LE(cursor + 6);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const dosTime = buffer.readUInt16LE(cursor + 12);
    const dosDate = buffer.readUInt16LE(cursor + 14);
    const expectedCrc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const nameBuffer = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameBuffer.toString(flags & 0x0800 ? "utf8" : "latin1");
    if (flags & 0x0001) throw new Error(`Encrypted ZIP entry is unsupported: ${name}`);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Bad local entry signature: ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = zlib.inflateRawSync(compressed);
    else throw new Error(`Unsupported compression method ${method}: ${name}`);
    if (data.length !== size) throw new Error(`Uncompressed size mismatch: ${name}`);
    if ((zlib.crc32(data) >>> 0) !== expectedCrc) throw new Error(`CRC mismatch: ${name}`);
    entries.push({ name, data, versionMade, versionNeeded, flags, method, dosTime, dosDate, externalAttributes });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== centralOffset + centralSize) throw new Error("ZIP central directory size mismatch");
  return entries;
}

function writeArchive(entries) {
  if (entries.length > 0xffff) throw new Error("Too many ZIP entries");
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const method = entry.method === 0 ? 0 : 8;
    const compressed = method === 0 ? data : zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data) >>> 0;
    const flags = ((entry.flags || 0) | 0x0800) & ~0x0008;
    const dosTime = entry.dosTime || 0;
    const dosDate = entry.dosDate || 0x0021;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(Math.max(20, entry.versionNeeded || 20), 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    localChunks.push(local, nameBuffer, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.versionMade || 20, 4);
    central.writeUInt16LE(Math.max(20, entry.versionNeeded || 20), 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(entry.externalAttributes || 0, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, nameBuffer);

    offset += local.length + nameBuffer.length + compressed.length;
  }

  const central = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localChunks, central, eocd]);
}

function exactReplace(text, before, after) {
  const parts = text.split(before);
  if (parts.length !== 2) throw new Error(`Expected exactly one frontend patch point: ${before}`);
  return parts.join(after);
}

function patchEntries(baselineEntries, localScript) {
  const entries = baselineEntries.map((entry) => ({ ...entry, data: Buffer.from(entry.data) }));
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const index = byName.get(INDEX_ENTRY);
  const main = byName.get(MAIN_ENTRY);
  if (!index || !main) throw new Error("Expected .627 frontend entries were not found");

  const marker = '<script type="module" crossorigin src="./assets/main-31595bd3.js"></script>';
  let indexText = index.data.toString("utf8");
  if (!indexText.includes('./assets/local-mail-poc.js')) {
    indexText = exactReplace(indexText, marker, `<script src="./assets/local-mail-poc.js"></script>\n  ${marker}`);
  }
  index.data = Buffer.from(indexText, "utf8");

  let mainText = main.data.toString("utf8");
  for (const [before, after] of PATCH_RULES) mainText = exactReplace(mainText, before, after);
  main.data = Buffer.from(mainText, "utf8");

  entries.push({
    name: LOCAL_SCRIPT_ENTRY,
    data: Buffer.from(localScript),
    versionMade: 20,
    versionNeeded: 20,
    flags: 0x0800,
    method: 8,
    dosTime: 0,
    dosDate: 0x0021,
    externalAttributes: 0
  });
  return entries;
}

function entryMap(entries) {
  return new Map(entries.map((entry) => [entry.name, entry]));
}

function verifyPatchedArchive(buffer, baselineBuffer, localScript) {
  const current = readArchive(buffer);
  const baseline = readArchive(baselineBuffer);
  const currentMap = entryMap(current);
  const baselineMap = entryMap(baseline);
  const expectedNames = new Set([...baselineMap.keys(), LOCAL_SCRIPT_ENTRY]);
  const unexpected = [...currentMap.keys()].filter((name) => !expectedNames.has(name));
  const missing = [...expectedNames].filter((name) => !currentMap.has(name));
  if (unexpected.length || missing.length) {
    throw new Error(`Archive entry mismatch; unexpected=${unexpected.join(",")} missing=${missing.join(",")}`);
  }

  const allowedChanged = new Set([INDEX_ENTRY, MAIN_ENTRY]);
  const changed = [];
  for (const [name, baselineEntry] of baselineMap) {
    const currentEntry = currentMap.get(name);
    if (!currentEntry.data.equals(baselineEntry.data)) changed.push(name);
    if (!allowedChanged.has(name) && !currentEntry.data.equals(baselineEntry.data)) {
      throw new Error(`Unrelated frontend entry changed: ${name}`);
    }
  }
  if (!currentMap.get(LOCAL_SCRIPT_ENTRY).data.equals(localScript)) {
    throw new Error("Packed local-mail-poc.js does not match its source file");
  }
  const indexText = currentMap.get(INDEX_ENTRY).data.toString("utf8");
  if ((indexText.match(/assets\/local-mail-poc\.js/g) || []).length !== 1) {
    throw new Error("index.html must load local-mail-poc.js exactly once");
  }
  const mainText = currentMap.get(MAIN_ENTRY).data.toString("utf8");
  for (const [before, after] of PATCH_RULES) {
    if (mainText.includes(before) || !mainText.includes(after)) throw new Error(`Frontend API wrapper patch is missing: ${after}`);
  }
  return {
    entries: current.length,
    baselineEntries: baseline.length,
    changedEntries: changed,
    addedEntries: [LOCAL_SCRIPT_ENTRY]
  };
}

function backupCurrentTarget(targetBuffer) {
  const digest = sha256Sync(targetBuffer);
  const directory = path.join(ROOT, "backups", "patch-snapshots", "pre-formal-install");
  const backupPath = path.join(directory, `feapp-${digest.slice(0, 16)}.dat`);
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(backupPath)) fs.writeFileSync(backupPath, targetBuffer);
  return backupPath;
}

function atomicWrite(targetPath, data) {
  const temporary = `${targetPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, data);
  try {
    fs.renameSync(temporary, targetPath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function writeLog(command, result) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.writeFileSync(LOG_PATH, `${JSON.stringify({ command, at: new Date().toISOString(), ...result }, null, 2)}\n`, "utf8");
}

async function main() {
  const command = process.argv[2] || "verify";

  // import-baseline：新环境引导。从接收者自己的官方 0.627 包提取兼容基线并按哈希校验，
  // 使分发时无需携带官方文件；哈希不匹配说明本体版本不对或包已被改动。
  if (command === "import-baseline") {
    const sourceBuffer = fs.readFileSync(TARGET_PATH);
    const sourceHash = sha256Sync(sourceBuffer);
    if (sourceHash !== EXPECTED_BASELINE_SHA256) {
      throw new Error(
        `Official feapp.dat hash mismatch: ${sourceHash}. Expected the untouched .627 baseline `
        + `(${EXPECTED_BASELINE_SHA256}). Make sure the game client is version 0.0.9.627 and not already patched.`
      );
    }
    if (fs.existsSync(BASELINE_PATH)) {
      const existingHash = sha256Sync(fs.readFileSync(BASELINE_PATH));
      if (existingHash === EXPECTED_BASELINE_SHA256) {
        const result = { imported: false, reason: "baseline already present", sha256: existingHash };
        console.log(JSON.stringify(result, null, 2));
        return;
      }
    }
    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    atomicWrite(BASELINE_PATH, sourceBuffer);
    const result = { imported: true, sha256: sourceHash, baselinePath: path.relative(GAME_ROOT, BASELINE_PATH) };
    writeLog(command, result);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const baselineBuffer = fs.readFileSync(BASELINE_PATH);
  const baselineHash = sha256Sync(baselineBuffer);
  if (baselineHash !== EXPECTED_BASELINE_SHA256) {
    throw new Error(`Compatible baseline hash mismatch: ${baselineHash}`);
  }

  if (command === "install") {
    const localScript = fs.readFileSync(FRONTEND_SCRIPT_PATH);
    const targetBefore = fs.readFileSync(TARGET_PATH);
    const backupPath = backupCurrentTarget(targetBefore);
    const patched = writeArchive(patchEntries(readArchive(baselineBuffer), localScript));
    const verification = verifyPatchedArchive(patched, baselineBuffer, localScript);
    atomicWrite(TARGET_PATH, patched);
    const result = {
      ...verification,
      baselineSha256: baselineHash,
      installedSha256: sha256Sync(patched),
      sourceScriptSha256: sha256Sync(localScript),
      backupPath: path.relative(GAME_ROOT, backupPath)
    };
    writeLog(command, result);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "verify") {
    const localScript = fs.readFileSync(FRONTEND_SCRIPT_PATH);
    const target = fs.readFileSync(TARGET_PATH);
    const result = {
      ...verifyPatchedArchive(target, baselineBuffer, localScript),
      baselineSha256: baselineHash,
      installedSha256: sha256Sync(target),
      sourceScriptSha256: sha256Sync(localScript)
    };
    writeLog(command, result);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "restore") {
    const targetBefore = fs.readFileSync(TARGET_PATH);
    const backupPath = backupCurrentTarget(targetBefore);
    atomicWrite(TARGET_PATH, baselineBuffer);
    const restoredHash = sha256Sync(fs.readFileSync(TARGET_PATH));
    if (restoredHash !== baselineHash) throw new Error("Restored archive did not match the compatible baseline");
    const result = { restoredSha256: restoredHash, backupPath: path.relative(GAME_ROOT, backupPath) };
    writeLog(command, result);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error("Usage: node tools/feapp.mjs <import-baseline|install|verify|restore>");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
