import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPOSITORY_ID = "linli-local-mail";
export const PRIVATE_ROLE = "private-canonical";
export const PUBLIC_ROLE = "public-projection";

export function normalizeRemoteUrl(value) {
  return String(value ?? "")
    .trim()
    .replace(/^git@github\.com:/i, "https://github.com/")
    .replace(/\.git\/?$/i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

export function readRepositoryRole(repositoryRoot = ROOT) {
  const rolePath = path.join(repositoryRoot, "repo-role.json");
  let role;
  try {
    role = JSON.parse(fs.readFileSync(rolePath, "utf8"));
  } catch (error) {
    throw new Error(`Repository identity is missing or invalid at ${rolePath}: ${error.message}`);
  }
  if (role.schemaVersion !== 1 || role.repositoryId !== REPOSITORY_ID) {
    throw new Error(`Unsupported repository identity at ${rolePath}.`);
  }
  if (![PRIVATE_ROLE, PUBLIC_ROLE].includes(role.role)) {
    throw new Error(`Unknown Linli repository role: ${role.role ?? "(missing)"}.`);
  }
  return role;
}

export function assertRepositoryRole(repositoryRoot, allowedRoles) {
  const role = readRepositoryRole(repositoryRoot);
  if (!allowedRoles.includes(role.role)) {
    throw new Error(`This operation allows ${allowedRoles.join(" or ")}, but the current repository is ${role.role}.`);
  }
  const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true
  }).trim();
  if (path.resolve(topLevel).localeCompare(path.resolve(repositoryRoot), undefined, { sensitivity: "accent" }) !== 0) {
    throw new Error(`Repository root mismatch: expected ${repositoryRoot}, Git reports ${topLevel}.`);
  }
  return role;
}

function main() {
  const values = process.argv.slice(2);
  const allowedRoles = [];
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] !== "--allow-role" || !values[index + 1]) throw new Error("Usage: repo-guard.mjs --allow-role <role> [--allow-role <role>]");
    allowedRoles.push(values[++index]);
  }
  if (!allowedRoles.length) throw new Error("At least one --allow-role is required.");
  const role = assertRepositoryRole(ROOT, allowedRoles);
  console.log(JSON.stringify({ ok: true, root: ROOT, role: role.role }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`Repository guard failed: ${error.message}`);
    process.exitCode = 1;
  }
}
