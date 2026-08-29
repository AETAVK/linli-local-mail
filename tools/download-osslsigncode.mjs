import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "2.13";
const ARCHIVE_NAME = `osslsigncode-${VERSION}-windows-x64-mingw.zip`;
const ARCHIVE_URL = `https://github.com/mtrojnar/osslsigncode/releases/download/${VERSION}/${ARCHIVE_NAME}`;
const EXPECTED_SHA256 = "c6d3ec8f383a6ed204503a9d4445788f2d3e71da87f3604c42e40167ad9ceb8e";

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function fetchBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败 ${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

const cacheDirectory = path.resolve(ROOT, option("--cache-dir", path.join("dist", "tool-cache")));
const archivePath = path.join(cacheDirectory, ARCHIVE_NAME);
fs.mkdirSync(cacheDirectory, { recursive: true });

let actualSha256 = fs.existsSync(archivePath) ? sha256(archivePath) : null;
if (actualSha256 !== EXPECTED_SHA256) {
  fs.writeFileSync(archivePath, await fetchBuffer(ARCHIVE_URL));
  actualSha256 = sha256(archivePath);
}
if (actualSha256 !== EXPECTED_SHA256) {
  throw new Error(`osslsigncode SHA-256 校验失败：expected=${EXPECTED_SHA256} actual=${actualSha256}`);
}

console.log(JSON.stringify({
  version: VERSION,
  archiveName: ARCHIVE_NAME,
  archivePath,
  sourceUrl: ARCHIVE_URL,
  sha256: actualSha256
}, null, 2));
