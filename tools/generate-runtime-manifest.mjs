import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function option(name, fallback = null) {
  const direct = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function walk(directory, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Runtime payload contains a symbolic link: ${relative}`);
    if (entry.isDirectory()) files.push(...walk(fullPath, relative));
    else if (entry.isFile()) files.push(relative.replaceAll("\\", "/"));
    else throw new Error(`Runtime payload contains an unsupported file type: ${relative}`);
  }
  return files;
}

const root = path.resolve(option("--root", ""));
const output = path.resolve(option("--output", path.join(root, "runtime-manifest.json")));
const version = String(option("--version", "")).trim();
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Runtime root does not exist: ${root}`);
if (!/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.(?:0|[1-9]\d*))?$/u.test(version)) {
  throw new Error(`Version must use major.minor.patch or an approved prerelease form: ${version}`);
}

const outputRelative = path.relative(root, output).replaceAll("\\", "/");
const files = walk(root).filter((relative) => relative !== outputRelative).sort();
const managedFiles = files.map((relative) => {
  const filePath = path.join(root, ...relative.split("/"));
  return { path: relative, size: fs.statSync(filePath).size, sha256: sha256(filePath) };
});
const shortcutRoot = "game-root-shortcuts/";
const rootShortcuts = managedFiles
  .filter((entry) => entry.path.startsWith(shortcutRoot) && path.posix.dirname(entry.path) === "game-root-shortcuts")
  .map((entry) => ({ name: path.posix.basename(entry.path), source: entry.path, sha256: entry.sha256 }));
if (!rootShortcuts.length) throw new Error("Runtime payload does not contain game-root shortcut templates");

const manifest = {
  schemaVersion: 1,
  version,
  gameVersion: "0.0.9.627",
  generatedAt: new Date().toISOString(),
  managedFiles,
  rootShortcuts
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, files: managedFiles.length, shortcuts: rootShortcuts.length }, null, 2));
