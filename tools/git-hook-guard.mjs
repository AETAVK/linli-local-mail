import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { PRIVATE_ROLE, PUBLIC_ROLE, readRepositoryRole } from "./repo-guard.mjs";
import { forbiddenTrackedPath, inspectRepository } from "./governance-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ZERO_SHA = /^0{40}$/;

function git(args, options = {}) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true, ...options }).trim();
}

function stagedPaths() {
  return execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], {
    cwd: ROOT,
    encoding: "buffer",
    windowsHide: true
  }).toString("utf8").split("\0").filter(Boolean).map((value) => value.replaceAll("\\", "/"));
}

function preCommit() {
  const role = readRepositoryRole(ROOT);
  const branch = git(["branch", "--show-current"]);
  const integration = process.env.LINLI_INTEGRATION === "1";
  if (role.role === PRIVATE_ROLE) {
    if (branch === role.canonicalBranch && !integration) {
      throw new Error(`Direct commits on private ${role.canonicalBranch} are blocked. Use task-collect.ps1 from an integration session.`);
    }
    if (!integration && !branch.startsWith("agent/") && !branch.startsWith("integration/")) {
      throw new Error(`Private commits are limited to agent/* or integration/* branches; current branch is ${branch || "(detached)"}.`);
    }
    const forbidden = stagedPaths()
      .map((file) => ({ file, reason: forbiddenTrackedPath(file) }))
      .filter((entry) => entry.reason);
    if (forbidden.length) {
      throw new Error(`Private or generated files cannot be committed:\n${forbidden.map((entry) => `${entry.file}: ${entry.reason}`).join("\n")}`);
    }
    const report = inspectRepository();
    if (!report.projectStatus?.ok) {
      throw new Error(`Private project status validation failed:\n${JSON.stringify(report.projectStatus, null, 2)}`);
    }
  } else if (role.role === PUBLIC_ROLE) {
    if (branch === role.canonicalBranch && !integration) {
      throw new Error(`Direct commits on public ${role.canonicalBranch} are blocked. Merge a verified generated candidate instead.`);
    }
    const unstaged = git(["diff", "--name-only", "--"]);
    if (unstaged) {
      throw new Error(`Public commits require every projected modification to be staged:\n${unstaged}`);
    }
    const report = inspectRepository({ ignoreWorkingChanges: true });
    if (!report.ok) throw new Error(`Public projection validation failed:\n${JSON.stringify(report, null, 2)}`);
  }
  console.log(`Repository pre-commit guard passed for ${role.role} on ${branch}.`);
}

function isAncestor(older, newer) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", older, newer], { cwd: ROOT, windowsHide: true });
  if (result.error) throw result.error;
  return result.status === 0;
}

function prePush() {
  const role = readRepositoryRole(ROOT);
  if (role.role === PUBLIC_ROLE) {
    const report = inspectRepository({ requireClean: true });
    if (!report.ok) throw new Error(`Public push blocked by projection validation:\n${JSON.stringify(report, null, 2)}`);
  }
  const lines = fs.readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const [localRef, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
    if (!remoteRef || !remoteSha) throw new Error(`Cannot parse pre-push update: ${line}`);
    const protectedMain = remoteRef === "refs/heads/main";
    const tag = remoteRef.startsWith("refs/tags/");
    if (tag && !/^refs\/tags\/v\d+\.\d+\.\d+$/.test(remoteRef)) {
      throw new Error(`Release tag does not match v<major>.<minor>.<patch>: ${remoteRef}`);
    }
    if ((protectedMain || tag) && ZERO_SHA.test(localSha)) {
      throw new Error(`Deletion of protected ref is blocked: ${remoteRef}`);
    }
    if (tag && !ZERO_SHA.test(remoteSha) && localSha !== remoteSha) {
      throw new Error(`Rewriting an existing release tag is blocked: ${remoteRef}`);
    }
    if (protectedMain && !ZERO_SHA.test(remoteSha) && !isAncestor(remoteSha, localSha)) {
      throw new Error("Non-fast-forward updates to refs/heads/main are blocked.");
    }
  }
  console.log(`Repository pre-push guard passed for ${role.role}.`);
}

function main() {
  const hook = process.argv[2];
  if (hook === "pre-commit") preCommit();
  else if (hook === "pre-push") prePush();
  else throw new Error(`Unknown Git hook: ${hook}`);
}

try {
  main();
} catch (error) {
  console.error(`Git policy blocked the operation: ${error.message}`);
  process.exitCode = 1;
}
