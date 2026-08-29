import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeImportedLetter } from "../src/history.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_HISTORY_PATH = path.join(ROOT, "imports", "history");
const SERVICE_ROOT = "http://127.0.0.1:27149";

function jsonFiles(targets) {
  const requested = targets.length ? targets : [DEFAULT_HISTORY_PATH];
  const files = [];
  for (const target of requested) {
    const absolute = path.resolve(process.cwd(), target);
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      files.push(...fs.readdirSync(absolute)
        .filter((name) => name.toLowerCase().endsWith(".json"))
        .sort()
        .map((name) => path.join(absolute, name)));
    } else {
      files.push(absolute);
    }
  }
  return [...new Set(files)];
}

function readItems(files) {
  return files.map((filePath, index) => {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const normalized = normalizeImportedLetter(raw, index);
    return { filePath, raw, normalized };
  });
}

function validationSummary(items) {
  return {
    valid: items.length,
    letters: items.map(({ filePath, raw, normalized }) => ({
      file: path.relative(ROOT, filePath),
      letterId: normalized.letterId,
      sentAvailable: Boolean(normalized.content),
      replyAvailable: Boolean(normalized.replyText || normalized.replyVideoUrl),
      createdPrecision: normalized.createdPrecision,
      repliedPrecision: normalized.repliedPrecision,
      reviewStatus: raw.provenance?.reviewStatus || null
    }))
  };
}

async function serviceApi(endpoint, options = {}) {
  const sessionResponse = await fetch(`${SERVICE_ROOT}/api/session`);
  const sessionPayload = await sessionResponse.json();
  if (!sessionResponse.ok) throw new Error(sessionPayload.message || "Local service session failed");
  const response = await fetch(`${SERVICE_ROOT}${endpoint}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "X-Local-Mail-Session": sessionPayload.data.token
    }
  });
  const payload = await response.json();
  if (!response.ok || payload.code !== 0) throw new Error(payload.message || `Local service HTTP ${response.status}`);
  return payload.data;
}

async function main() {
  const [command = "validate", ...targets] = process.argv.slice(2);
  if (!new Set(["validate", "import"]).has(command)) {
    throw new Error("Usage: node tools/history.mjs <validate|import> [file-or-directory ...]");
  }
  const files = jsonFiles(targets);
  if (!files.length) throw new Error("No history JSON files found");
  const items = readItems(files);
  const validation = validationSummary(items);

  if (command === "validate") {
    console.log(JSON.stringify(validation, null, 2));
    return;
  }

  const imported = await serviceApi("/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ letters: items.map((item) => item.raw) })
  });
  console.log(JSON.stringify({ ...validation, import: imported }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
