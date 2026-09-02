import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const VERSION = "7.1.0";
const FILE_NAME = `innosetup-${VERSION}-x64.exe`;
const URL = `https://github.com/jrsoftware/issrc/releases/download/is-7_1_0/${FILE_NAME}`;
const EXPECTED_SHA256 = "0362a383ed217d4c4239b5933866dd96d3eb2102737da92f80f6057a4b40df2f";

function unlinkIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function option(name, fallback) {
  const direct = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

const cacheDirectory = path.resolve(option("--cache-dir", path.join("dist", "tool-cache")));
const outputPath = path.join(cacheDirectory, FILE_NAME);
fs.mkdirSync(cacheDirectory, { recursive: true });

if (!fs.existsSync(outputPath) || sha256(outputPath) !== EXPECTED_SHA256) {
  const temporaryPath = `${outputPath}.${process.pid}.part`;
  unlinkIfExists(temporaryPath);
  const response = await fetch(URL, { redirect: "follow", signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`Inno Setup download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporaryPath, { flags: "wx" }));
  const actual = sha256(temporaryPath);
  if (actual !== EXPECTED_SHA256) {
    unlinkIfExists(temporaryPath);
    throw new Error(`Inno Setup SHA-256 mismatch: ${actual}`);
  }
  unlinkIfExists(outputPath);
  fs.renameSync(temporaryPath, outputPath);
}

console.log(JSON.stringify({ version: VERSION, path: outputPath, sha256: EXPECTED_SHA256, sourceUrl: URL }, null, 2));
