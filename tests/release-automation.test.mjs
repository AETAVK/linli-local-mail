import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createReleaseReceipt,
  expectedReleaseAssetNames,
  inspectReleaseBundle,
  renderReleaseBody,
  sha256File,
  validateReleaseReceipt,
} from "../.github/scripts/release-contract.mjs";
import {
  normalizeReleaseBody,
  planAttachmentSync,
} from "../.github/scripts/publish-gitee-release.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT = path.join(ROOT, ".github", "scripts", "release-contract.mjs");
const VERSION = "1.2.3";
const TAG = `v${VERSION}`;
const SOURCE_COMMIT = "a".repeat(40);

test("runtime release packaging excludes PowerShell and uses native launcher shortcuts", () => {
  const release = fs.readFileSync(path.join(ROOT, "tools", "release.mjs"), "utf8");
  const allowlist = release.match(/const RUNTIME_SOURCE_ALLOWLIST = \[[\s\S]*?\];/u)?.[0] || "";
  assert.doesNotMatch(allowlist, /(?:Install\.cmd|Start-LinliLocalMail\.ps1|Stop-LinliLocalMail\.ps1|tools\/install(?:\.ps1|-launcher-wrapper\.ps1)|tools\/restore-launcher\.ps1)/u);
  assert.match(release, /const GENERATED_RUNTIME_FILES = \[[\s\S]*?native\/linli-launcher-wrapper\.exe[\s\S]*?native\/linli-windows-helper\.exe/u);
  assert.match(release, /\\"%~dp0launcher\.exe\\"/u);
  assert.match(release, /\\"%~dp0launcher\.exe\\" --linli-service-only/u);
  assert.match(release, /\\"%~dp0launcher\.exe\\" --linli-service-stop/u);
  assert.match(release, /function assertNoRuntimePowerShell\(staging, entries\)/u);
  assert.match(release, /entries\.filter\(\(entry\) => entry\.toLowerCase\(\)\.endsWith\("\.ps1"\)\)/u);
  assert.ok(release.indexOf("assertNoRuntimePowerShell(staging, entries)") < release.indexOf("execFileSync(\"tar\", [\"-a\", \"-cf\""));
});

function releaseTemplate() {
  return [
    `# v${VERSION} 发布说明`,
    "",
    "## 本版新增和修复",
    "",
    "- 保留人工撰写的功能说明。",
    "",
    "## 安装与升级",
    "",
    "- 安装前备份游戏文件。",
    "",
    "## 已知限制",
    "",
    "- 仍有一项已知限制。",
    "",
    "## 下载与校验",
    "",
    `- SHA-256：\`${"f".repeat(64)}\``,
    "- 这是必须被实际构建数据替换的陈旧内容。",
    "",
  ].join("\n");
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linli-release-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist, { recursive: true });
  const names = expectedReleaseAssetNames(VERSION);
  const installerPath = path.join(dist, names[0]);
  fs.writeFileSync(installerPath, Buffer.from("deterministic installer fixture", "utf8"));
  const installerSha256 = sha256File(installerPath);
  const installerSize = fs.statSync(installerPath).size;
  fs.writeFileSync(path.join(dist, names[1]), `${installerSha256}  ${names[0]}\n`, "ascii");
  fs.writeFileSync(path.join(dist, names[2]), `${JSON.stringify({
    version: VERSION,
    installer: names[0],
    installerSha256,
    installerSize,
    installerEngine: "Inno Setup 7.1.0 x64",
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(dist, names[3]), Buffer.from("certificate fixture", "utf8"));
  const notes = path.join(root, "release-notes.md");
  fs.writeFileSync(notes, releaseTemplate(), "utf8");
  return { root, names, notes, installerPath, installerSha256, installerSize };
}

function runContract(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [CONTRACT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, expectedStatus, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

function prepare(fixture) {
  const bodyPath = path.join(fixture.root, "release-body.md");
  const receiptPath = path.join(fixture.root, "release-receipt.json");
  const args = [
    "prepare", "--version", VERSION, "--tag", TAG, "--source-commit", SOURCE_COMMIT,
    "--root", fixture.root, "--notes", fixture.notes,
    "--body-output", bodyPath, "--receipt-output", receiptPath,
  ];
  runContract(args);
  return { args, bodyPath, receiptPath };
}

test("prepare replaces stale download data and produces one deterministic body and receipt", (t) => {
  const fixture = createFixture(t);
  const prepared = prepare(fixture);
  const firstBody = fs.readFileSync(prepared.bodyPath, "utf8");
  const firstReceipt = fs.readFileSync(prepared.receiptPath, "utf8");

  assert.match(firstBody, /保留人工撰写的功能说明/u);
  assert.match(firstBody, new RegExp(fixture.installerSha256, "u"));
  assert.match(firstBody, new RegExp(`${fixture.installerSize} bytes`, "u"));
  assert.doesNotMatch(firstBody, /必须被实际构建数据替换/u);
  assert.doesNotMatch(firstBody, new RegExp("f{64}", "u"));
  assert.ok(firstBody.endsWith("\n"));
  assert.ok(!firstBody.endsWith("\n\n"));

  runContract(prepared.args);
  assert.equal(fs.readFileSync(prepared.bodyPath, "utf8"), firstBody);
  assert.equal(fs.readFileSync(prepared.receiptPath, "utf8"), firstReceipt);
  const receipt = JSON.parse(firstReceipt);
  assert.equal(receipt.sourceCommit, SOURCE_COMMIT);
  assert.equal(receipt.assets.length, 4);
  assert.equal(receipt.assets[0].size, fixture.installerSize);

  const manifestPath = path.join(fixture.root, "dist", fixture.names[2]);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.version = "1.2.4";
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  assert.match(runContract(prepared.args, 1).stderr, /version/u);
});

test("verify rejects body, receipt, and artifact tampering", (t) => {
  for (const target of ["body", "receipt", "asset"]) {
    const fixture = createFixture(t);
    const prepared = prepare(fixture);
    const verifyArgs = [
      "verify", "--version", VERSION, "--tag", TAG, "--source-commit", SOURCE_COMMIT,
      "--root", fixture.root, "--body", prepared.bodyPath, "--receipt", prepared.receiptPath,
    ];
    if (target === "body") fs.appendFileSync(prepared.bodyPath, "篡改正文\n", "utf8");
    if (target === "receipt") {
      const receipt = JSON.parse(fs.readFileSync(prepared.receiptPath, "utf8"));
      receipt.bodySha256 = "0".repeat(64);
      fs.writeFileSync(prepared.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    }
    if (target === "asset") fs.appendFileSync(fixture.installerPath, "tamper", "utf8");
    assert.notEqual(runContract(verifyArgs, 1).stderr.trim(), "", `${target} tampering must explain its failure`);
  }
});

test("extract-github accepts only one final four-asset release and preserves its body", (t) => {
  const fixture = createFixture(t);
  const bundle = inspectReleaseBundle({ root: fixture.root, version: VERSION, requireCurrentManifest: true });
  const body = renderReleaseBody({ template: releaseTemplate(), version: VERSION, tag: TAG, bundle });
  const metadataPath = path.join(fixture.root, "github-release.json");
  const bodyPath = path.join(fixture.root, "mirror-body.md");
  const receiptPath = path.join(fixture.root, "mirror-receipt.json");
  const metadata = {
    tagName: TAG,
    isDraft: false,
    isPrerelease: false,
    body,
    targetCommitish: SOURCE_COMMIT,
    assets: bundle.assets.map(({ name, size, sha256 }) => ({ name, size, digest: `sha256:${sha256}` })),
  };
  const args = [
    "extract-github", "--metadata", metadataPath, "--root", fixture.root,
    "--body-output", bodyPath, "--receipt-output", receiptPath, "--source-commit", SOURCE_COMMIT,
  ];
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`, "utf8");
  runContract(args);
  assert.equal(fs.readFileSync(bodyPath, "utf8"), normalizeReleaseBody(body));

  for (const [label, mutate] of [
    ["draft", (copy) => { copy.isDraft = true; }],
    ["prerelease", (copy) => { copy.isPrerelease = true; }],
    ["missing asset", (copy) => { copy.assets.pop(); }],
    ["duplicate asset", (copy) => { copy.assets[1].name = copy.assets[0].name; }],
    ["wrong size", (copy) => { copy.assets[0].size += 1; }],
    ["wrong digest", (copy) => { copy.assets[0].digest = `sha256:${"0".repeat(64)}`; }],
  ]) {
    const invalid = structuredClone(metadata);
    mutate(invalid);
    fs.writeFileSync(metadataPath, `${JSON.stringify(invalid)}\n`, "utf8");
    assert.notEqual(runContract(args, 1).stderr.trim(), "", `${label} must be rejected`);
  }
});

test("release receipt and Gitee attachment planning are strict and non-destructive", (t) => {
  const fixture = createFixture(t);
  const bundle = inspectReleaseBundle({ root: fixture.root, version: VERSION, requireCurrentManifest: true });
  const body = renderReleaseBody({ template: releaseTemplate(), version: VERSION, tag: TAG, bundle });
  const receipt = createReleaseReceipt({ version: VERSION, tag: TAG, sourceCommit: SOURCE_COMMIT, body, assets: bundle.assets });
  assert.deepEqual(
    validateReleaseReceipt({ receipt, version: VERSION, tag: TAG, sourceCommit: SOURCE_COMMIT, body, assets: bundle.assets }),
    receipt,
  );

  const existing = bundle.assets.map((asset, index) => ({ id: index + 1, name: asset.name, size: asset.size }));
  const aligned = planAttachmentSync(bundle.assets, existing);
  assert.equal(aligned.upload.length, 0);
  assert.equal(aligned.verify.length, 4);
  const missing = planAttachmentSync(bundle.assets, existing.slice(1));
  assert.deepEqual(missing.upload.map((asset) => asset.name), [bundle.assets[0].name]);
  assert.throws(
    () => planAttachmentSync(bundle.assets, [...existing, { id: 5, name: "unexpected-api-attachment.zip", size: 123 }]),
    /契约外附件/u,
  );
  assert.throws(() => planAttachmentSync(bundle.assets, [...existing, existing[0]]), /重复附件/u);
  assert.throws(() => planAttachmentSync(bundle.assets, [{ ...existing[0], size: existing[0].size + 1 }]), /大小冲突/u);
});

test("workflows enforce one body, immutable GitHub assets, and GitHub-sourced Gitee mirroring", () => {
  const releaseWorkflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const syncWorkflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "sync-gitee.yml"), "utf8");
  const publisher = fs.readFileSync(path.join(ROOT, ".github", "scripts", "publish-gitee-release.mjs"), "utf8");
  const builder = fs.readFileSync(path.join(ROOT, "tools", "build-installer.ps1"), "utf8");
  const publishedBlock = releaseWorkflow.match(/function Assert-PublishedRelease[\s\S]*?(?=\r?\n\s*& gh release view)/u)?.[0] || "";
  const nativeHelperBuild = releaseWorkflow.indexOf("run: npm run launcher:build");
  const finalCandidateTests = releaseWorkflow.indexOf("run: npm test");

  assert.doesNotMatch(releaseWorkflow, /source_ref/u);
  assert.doesNotMatch(releaseWorkflow, /ephemeral self-signed|临时自签名.*exit 0/iu);
  assert.ok(nativeHelperBuild >= 0 && nativeHelperBuild < finalCandidateTests);
  assert.match(releaseWorkflow, /release-contract\.mjs prepare/u);
  assert.match(releaseWorkflow, /release-body\.md/u);
  assert.match(releaseWorkflow, /release-receipt\.json/u);
  assert.match(releaseWorkflow, /gh release create .*--draft/u);
  assert.doesNotMatch(publishedBlock, /gh release upload[^\r\n]*--clobber/u);
  assert.match(releaseWorkflow, /uses: \.\/\.github\/workflows\/sync-gitee\.yml/u);

  assert.match(syncWorkflow, /workflow_call:/u);
  assert.match(syncWorkflow, /workflow_dispatch:/u);
  assert.match(syncWorkflow, /ref:\s+\$\{\{\s*inputs\.tag\s*\}\}/u);
  assert.doesNotMatch(syncWorkflow, /ref:\s+main/u);
  assert.match(syncWorkflow, /gh release view[\s\S]+?--json tagName,isDraft,isPrerelease,body,assets/u);
  assert.match(syncWorkflow, /release-contract\.mjs extract-github/u);
  assert.doesNotMatch(syncWorkflow, /GITEE_ALLOW_VERSION_MISMATCH/u);

  assert.match(publisher, /GITEE_RELEASE_BODY_FILE/u);
  assert.match(publisher, /GITEE_RELEASE_RECEIPT_FILE/u);
  assert.match(publisher, /attach_files\/\$\{encodeURIComponent\(String\(id\)\)\}\/download/u);
  assert.doesNotMatch(publisher, /package\.json/u);
  assert.doesNotMatch(publisher, /\.github[\\/]release-notes/u);
  assert.doesNotMatch(publisher, /method:\s*"DELETE"/u);
  assert.match(builder, /version = \$version/u);
  assert.match(builder, /installerSize = \(Get-Item/u);

});
