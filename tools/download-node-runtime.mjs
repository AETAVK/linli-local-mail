import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

const version = option("--version");
const cacheDirectory = path.resolve(ROOT, option("--cache-dir", path.join("dist", "node-cache")));
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  throw new Error("用法：node tools/download-node-runtime.mjs --version 24.11.1 [--cache-dir 目录]");
}

const tag = `v${version}`;
const archiveName = `node-${tag}-win-x64.zip`;
const baseUrl = `https://nodejs.org/dist/${tag}`;
const archivePath = path.join(cacheDirectory, archiveName);
const sumsUrl = `${baseUrl}/SHASUMS256.txt`;
const sums = (await fetchBuffer(sumsUrl)).toString("utf8");
const sumLine = sums
  .split(/\r?\n/)
  .map((line) => line.trim())
  .find((line) => line.endsWith(` ${archiveName}`) || line.endsWith(` *${archiveName}`));
if (!sumLine) throw new Error(`官方 SHA-256 清单中找不到 ${archiveName}`);
const match = sumLine.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
if (!match) throw new Error(`无法解析官方 SHA-256 清单行：${sumLine}`);
const expectedSha256 = match[1].toLowerCase();

fs.mkdirSync(cacheDirectory, { recursive: true });
let actualSha256 = fs.existsSync(archivePath) ? sha256(archivePath) : null;
if (actualSha256 !== expectedSha256) {
  const archive = await fetchBuffer(`${baseUrl}/${archiveName}`);
  fs.writeFileSync(archivePath, archive);
  actualSha256 = sha256(archivePath);
}
if (actualSha256 !== expectedSha256) {
  throw new Error(`Node.js 压缩包 SHA-256 校验失败：expected=${expectedSha256} actual=${actualSha256}`);
}

console.log(JSON.stringify({
  version,
  archiveName,
  archivePath,
  sourceUrl: `${baseUrl}/${archiveName}`,
  expectedSha256,
  sha256: actualSha256
}, null, 2));
