import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const GENERATED_SOURCE_PATH = path.join(ROOT, "frontend", "local-mail-poc.js");
export const FRAGMENT_DIR = path.join(ROOT, "frontend-src", "local-mail-poc");

export const FRAGMENT_MANIFEST = Object.freeze([
  Object.freeze({ file: "01-core-styles.js", owner: "core-styles" }),
  Object.freeze({ file: "02-mail-import-updater.js", owner: "mail-import-updater" }),
  Object.freeze({ file: "03-settings.js", owner: "settings" }),
  Object.freeze({ file: "04-vue-pinia-navigation.js", owner: "native-navigation" }),
  Object.freeze({ file: "05-music.js", owner: "music" }),
  Object.freeze({ file: "06-bootstrap.js", owner: "bootstrap" })
]);

function fragmentPath(fragment) {
  return path.join(FRAGMENT_DIR, fragment.file);
}

export function assembleFrontendSourceBytes() {
  return Buffer.concat(FRAGMENT_MANIFEST.map((fragment) => fs.readFileSync(fragmentPath(fragment))));
}

export function assembleFrontendSourceText() {
  return assembleFrontendSourceBytes().toString("utf8");
}

export function assembleFrontendSource({ format = "text" } = {}) {
  if (format === "bytes") return assembleFrontendSourceBytes();
  if (format === "text") return assembleFrontendSourceText();
  throw new TypeError(`Unsupported frontend source format: ${format}`);
}

function assertLfOnly(bytes, label) {
  if (bytes.includes(13)) throw new Error(`${label} must use LF line endings`);
}

function checkGeneratedSource() {
  const assembled = assembleFrontendSourceBytes();
  const generated = fs.readFileSync(GENERATED_SOURCE_PATH);
  assertLfOnly(assembled, "assembled frontend source");
  assertLfOnly(generated, "generated frontend source");
  if (!assembled.equals(generated)) {
    throw new Error("Generated frontend source differs from the ordered fragments");
  }
  return { bytes: generated.length, fragments: FRAGMENT_MANIFEST.length };
}

function buildGeneratedSource() {
  const assembled = assembleFrontendSourceBytes();
  assertLfOnly(assembled, "assembled frontend source");
  fs.writeFileSync(GENERATED_SOURCE_PATH, assembled);
  return { bytes: assembled.length, fragments: FRAGMENT_MANIFEST.length };
}

function runCli() {
  const command = process.argv[2];
  if (command === "build") {
    const result = buildGeneratedSource();
    console.log(`Built ${result.bytes} bytes from ${result.fragments} frontend fragments.`);
    return;
  }
  if (command === "check") {
    const result = checkGeneratedSource();
    console.log(`Frontend source check passed: ${result.bytes} bytes from ${result.fragments} fragments.`);
    return;
  }
  console.error("Usage: node tools/frontend-source.mjs <build|check>");
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
