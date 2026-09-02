import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installerLaunchArguments } from "../src/updater.mjs";

import {
  ensureCharacterConfig,
  handoffUpdate,
  installLauncherWrapper,
  installRootShortcuts,
  loadRuntimeManifest,
  parseWindowsProcessIdentityJson,
  prepareInstallTransaction,
  prepareTransaction,
  preflight,
  processIdentityQueryCommand,
  protectedProcessNamesFromTasklist,
  protectedProcessNamesForGameRoot,
  removeTreeSafe,
  requestAuthenticatedShutdown,
  resolveLayout,
  restoreLauncher,
  rollbackTransaction,
  sha256File,
  uninstall
} from "../tools/installer-core.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linli-installer-core-test-"));
  const gameRoot = path.join(root, "含 空格&符号的游戏目录");
  const layout = resolveLayout(gameRoot);
  fs.mkdirSync(path.dirname(layout.feappPath), { recursive: true });
  fs.mkdirSync(path.join(layout.serviceRoot, "native"), { recursive: true });
  fs.mkdirSync(path.join(layout.serviceRoot, "game-root-shortcuts"), { recursive: true });
  fs.mkdirSync(path.join(layout.serviceRoot, "config", "defaults"), { recursive: true });
  fs.writeFileSync(layout.feappPath, "official-feapp");
  fs.writeFileSync(layout.webplayerPath, "official-webplayer");
  fs.writeFileSync(layout.launcherPath, "official-launcher");
  fs.writeFileSync(path.join(layout.serviceRoot, "server.mjs"), "old-server");
  fs.writeFileSync(path.join(layout.serviceRoot, "native", "linli-launcher-wrapper.exe"), "wrapper-v1");
  fs.writeFileSync(path.join(layout.serviceRoot, "game-root-shortcuts", "Start-LinliLocalMail.cmd"), "start-v1");
  fs.writeFileSync(path.join(layout.serviceRoot, "config", "defaults", "linli.v1.json"), '{"id":"linli","version":1}\n');
  return { root, gameRoot, layout };
}

function manifestFor(layout, version = "0.10.3") {
  const managedPaths = [
    "server.mjs",
    "native/linli-launcher-wrapper.exe",
    "game-root-shortcuts/Start-LinliLocalMail.cmd",
    "config/defaults/linli.v1.json"
  ];
  return {
    schemaVersion: 1,
    version,
    gameVersion: "0.0.9.627",
    managedFiles: managedPaths.map((relative) => {
      const filePath = path.join(layout.serviceRoot, ...relative.split("/"));
      return { path: relative, size: fs.statSync(filePath).size, sha256: sha256File(filePath) };
    }),
    rootShortcuts: [{
      name: "Start-LinliLocalMail.cmd",
      source: "game-root-shortcuts/Start-LinliLocalMail.cmd",
      sha256: sha256File(path.join(layout.serviceRoot, "game-root-shortcuts", "Start-LinliLocalMail.cmd"))
    }]
  };
}

test("preflight accepts a valid .627 root with Unicode and spaces", (t) => {
  const current = fixture();
  t.after(() => fs.rmSync(current.root, { recursive: true, force: true }));
  const result = preflight({ gameRoot: current.gameRoot, skipProcessCheck: true });
  assert.equal(result.ok, true);
  assert.equal(result.gameVersion, "0.0.9.627");
  assert.equal(result.webplayerPath, current.layout.webplayerPath);
});

test("runtime manifest rejects traversal", (t) => {
  const current = fixture();
  t.after(() => fs.rmSync(current.root, { recursive: true, force: true }));
  const manifestPath = path.join(current.root, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    version: "0.10.3",
    gameVersion: "0.0.9.627",
    managedFiles: [{ path: "../escape", size: 1, sha256: "0".repeat(64) }]
  }));
  assert.throws(() => loadRuntimeManifest(manifestPath), /越界/u);
});

test("prepare and rollback restore overwritten and newly created files", (t) => {
  const current = fixture();
  t.after(() => fs.rmSync(current.root, { recursive: true, force: true }));
  const runtimeManifest = manifestFor(current.layout);
  runtimeManifest.managedFiles.push({ path: "src/new-file.mjs", size: 3, sha256: "0".repeat(64) });
  const manifestPath = path.join(current.root, "runtime-manifest.json");
  const transactionFile = path.join(current.root, "transaction.json");
  fs.writeFileSync(manifestPath, JSON.stringify(runtimeManifest));

  prepareTransaction({
    gameRoot: current.gameRoot,
    manifestPath,
    transactionFile,
    skipProcessCheck: true
  });
  fs.writeFileSync(path.join(current.layout.serviceRoot, "server.mjs"), "new-server");
  fs.mkdirSync(path.join(current.layout.serviceRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(current.layout.serviceRoot, "src", "new-file.mjs"), "new");
  fs.writeFileSync(current.layout.feappPath, "patched-feapp");
  fs.writeFileSync(current.layout.webplayerPath, "patched-webplayer");

  rollbackTransaction(transactionFile);
  assert.equal(fs.readFileSync(path.join(current.layout.serviceRoot, "server.mjs"), "utf8"), "old-server");
  assert.equal(fs.existsSync(path.join(current.layout.serviceRoot, "src", "new-file.mjs")), false);
  assert.equal(fs.readFileSync(current.layout.feappPath, "utf8"), "official-feapp");
  assert.equal(fs.readFileSync(current.layout.webplayerPath, "utf8"), "official-webplayer");
  const transaction = JSON.parse(fs.readFileSync(transactionFile, "utf8"));
  assert.ok(transaction.snapshots.some((snapshot) => snapshot.relative === "0.0.9.627/resources/webplayer.dat"));
});

test("a later prepare recovers an interrupted transaction before taking a new snapshot", (t) => {
  const current = fixture();
  t.after(() => fs.rmSync(current.root, { recursive: true, force: true }));
  const manifestPath = path.join(current.root, "runtime-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifestFor(current.layout)));
  const firstPointer = path.join(current.root, "first-transaction.json");
  const first = prepareTransaction({
    gameRoot: current.gameRoot,
    manifestPath,
    transactionFile: firstPointer,
    skipProcessCheck: true
  });
  fs.writeFileSync(path.join(current.layout.serviceRoot, "server.mjs"), "interrupted-server");
  fs.writeFileSync(current.layout.feappPath, "interrupted-feapp");
  fs.writeFileSync(current.layout.webplayerPath, "interrupted-webplayer");

  const secondPointer = path.join(current.root, "second-transaction.json");
  const second = prepareTransaction({
    gameRoot: current.gameRoot,
    manifestPath,
    transactionFile: secondPointer,
    skipProcessCheck: true
  });
  assert.deepEqual(second.recoveredTransactions, [first.transactionId]);
  assert.equal(fs.readFileSync(path.join(current.layout.serviceRoot, "server.mjs"), "utf8"), "old-server");
  assert.equal(fs.readFileSync(current.layout.feappPath, "utf8"), "official-feapp");
  assert.equal(fs.readFileSync(current.layout.webplayerPath, "utf8"), "official-webplayer");
  rollbackTransaction(secondPointer);
});

test("prepare rejects a managed path whose ancestor is a Windows junction", {
  skip: process.platform !== "win32"
}, (t) => {
  const current = fixture();
  t.after(() => fs.rmSync(current.root, { recursive: true, force: true }));
  const outside = path.join(current.root, "outside");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "escaped.mjs"), "outside");
  fs.symlinkSync(outside, path.join(current.layout.serviceRoot, "src"), "junction");
  const manifest = manifestFor(current.layout);
  manifest.managedFiles.push({
    path: "src/escaped.mjs",
    size: 7,
    sha256: sha256File(path.join(outside, "escaped.mjs"))
  });
  const manifestPath = path.join(current.root, "runtime-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => prepareTransaction({
    gameRoot: current.gameRoot,
    manifestPath,
    transactionFile: path.join(current.root, "transaction.json"),
    skipProcessCheck: true
  }), /重解析点/u);
});

test("launcher wrapper is installed and official launcher is restored", (t) => {
  const current = fixture();
  t.after(() => fs.rmSync(current.root, { recursive: true, force: true }));
  const installed = installLauncherWrapper(current.layout, "0.10.3");
  assert.equal(sha256File(current.layout.launcherPath), installed.wrapperSha256);
  assert.equal(fs.readFileSync(current.layout.originalLauncherPath, "utf8"), "official-launcher");
  const restored = restoreLauncher(current.layout, { removeArtifacts: true });
  assert.equal(restored.restored, true);
  assert.equal(fs.readFileSync(current.layout.launcherPath, "utf8"), "official-launcher");
  assert.equal(fs.existsSync(current.layout.originalLauncherPath), false);
});

test("custom character config is preserved while defaults remain available", (t) => {
  const current = fixture();
  t.after(() => fs.rmSync(current.root, { recursive: true, force: true }));
  const target = path.join(current.layout.serviceRoot, "config", "characters", "linli.v1.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '{"id":"linli","custom":true}\n');
  const result = ensureCharacterConfig(current.layout, null);
  assert.equal(result.action, "preserved-custom");
  assert.equal(result.managed, false);
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).custom, true);
});

test("root shortcuts are copied with the declared hash", (t) => {
  const current = fixture();
  t.after(() => fs.rmSync(current.root, { recursive: true, force: true }));
  const manifest = manifestFor(current.layout);
  const installed = installRootShortcuts(current.layout, manifest);
  assert.equal(installed.length, 1);
  assert.equal(
    sha256File(path.join(current.gameRoot, "Start-LinliLocalMail.cmd")),
    manifest.rootShortcuts[0].sha256
  );
});

function installedFixture(t) {
  const current = fixture();
  t.after(() => fs.rmSync(current.root, { recursive: true, force: true }));
  installLauncherWrapper(current.layout, "0.10.3");
  const shortcuts = installRootShortcuts(current.layout, manifestFor(current.layout));
  for (const relative of ["data", "imports", "logs", "backups", "config/characters"]) {
    const directory = path.join(current.layout.serviceRoot, relative);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "user-marker.txt"), relative);
  }
  fs.writeFileSync(current.layout.statePath, JSON.stringify({
    schemaVersion: 1,
    version: "0.10.3",
    feapp: {},
    shortcuts
  }));
  return current;
}

test("default uninstall restores the launcher and keeps user data", (t) => {
  const current = installedFixture(t);
  const result = uninstall({ gameRoot: current.gameRoot, skipProcessCheck: true });
  assert.equal(result.deleteUserData, false);
  assert.equal(fs.readFileSync(current.layout.launcherPath, "utf8"), "official-launcher");
  assert.equal(fs.existsSync(path.join(current.gameRoot, "Start-LinliLocalMail.cmd")), false);
  for (const relative of ["data", "imports", "logs", "backups", "config/characters"]) {
    assert.equal(fs.existsSync(path.join(current.layout.serviceRoot, relative, "user-marker.txt")), true);
  }
});

test("uninstall refuses a webplayer archive changed after a dual-package install", (t) => {
  const current = fixture();
  t.after(() => fs.rmSync(current.root, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(current.layout.statePath), { recursive: true });
  fs.writeFileSync(current.layout.webplayerPath, "installed-webplayer");
  fs.writeFileSync(current.layout.statePath, JSON.stringify({
    schemaVersion: 1,
    version: "0.10.4",
    feapp: {},
    webplayer: { installedSha256: sha256File(current.layout.webplayerPath) }
  }));
  fs.writeFileSync(current.layout.webplayerPath, "changed-webplayer");
  assert.throws(
    () => uninstall({ gameRoot: current.gameRoot, skipProcessCheck: true }),
    (error) => error?.code === "webplayer_changed_after_install" && /webplayer\.dat/u.test(error.message)
  );
  assert.equal(fs.readFileSync(current.layout.launcherPath, "utf8"), "official-launcher");
});

test("explicit delete-user-data uninstall removes only declared user-data roots", (t) => {
  const current = installedFixture(t);
  const result = uninstall({ gameRoot: current.gameRoot, deleteUserData: true, skipProcessCheck: true });
  assert.equal(result.deleteUserData, true);
  for (const relative of ["data", "imports", "logs", "backups", "config/characters"]) {
    assert.equal(fs.existsSync(path.join(current.layout.serviceRoot, relative)), false);
  }
  assert.equal(fs.readFileSync(path.join(current.layout.serviceRoot, "server.mjs"), "utf8"), "old-server");
  assert.equal(fs.existsSync(path.join(current.layout.serviceRoot, "config", "defaults", "linli.v1.json")), true);
});

test("updater passes one Inno argument per value for Unicode game roots", () => {
  const gameRoot = path.resolve("C:/游戏目录/含 空格&符号");
  assert.deepEqual(installerLaunchArguments(gameRoot, 27149), [
    `/GAME_ROOT=${gameRoot}`,
    "/CONFIRMED_UPDATE=1",
    "/WAIT_PID=27149"
  ]);
});

test("updater rejects an invalid wait PID", () => {
  assert.throws(() => installerLaunchArguments("C:/game", 0), /等待进程编号无效/);
});

test("recursive deletion handles nested Unicode paths without fs.rmSync", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linli-delete-test-"));
  const target = path.join(root, "含 空格&符号", "数据目录");
  fs.mkdirSync(path.join(target, "嵌套"), { recursive: true });
  fs.writeFileSync(path.join(target, "嵌套", "信件.json"), "{}\n");
  removeTreeSafe(path.join(root, "含 空格&符号"));
  assert.equal(fs.existsSync(path.join(root, "含 空格&符号")), false);
  fs.rmdirSync(root);
});

test("protected process parsing includes Olivia and both launcher identities", () => {
  assert.deepEqual(
    protectedProcessNamesFromTasklist([
      '"Olivia.exe","100","Console","1","10,000 K"',
      '"launcher.exe","101","Console","1","10,000 K"',
      '"launcher.original.exe","102","Console","1","10,000 K"',
      '"node.exe","103","Console","1","10,000 K"'
    ].join("\r\n")),
    ["olivia.exe", "launcher.exe", "launcher.original.exe"]
  );
});

test("game process protection scopes executable paths to the selected game root", () => {
  const root = path.resolve("C:/游戏目录/含 空格&符号");
  assert.deepEqual(
    protectedProcessNamesForGameRoot([
      { name: "launcher.exe", executablePath: path.join(root, "launcher.exe") },
      { name: "Olivia.exe", executablePath: path.join(root, "Olivia.exe") },
      { name: "launcher.original.exe", executablePath: path.join(path.dirname(root), "other-game", "launcher.original.exe") }
    ], root),
    ["olivia.exe", "launcher.exe"]
  );
});

test("PowerShell identity output preserves Chinese and space paths with explicit no-BOM UTF-8", () => {
  const gameRoot = path.join(os.tmpdir(), "用户 数据", "BSide Olivia Lin Test");
  const nodePath = path.join(gameRoot, "linli-local-mail", "runtime", "node.exe");
  const launcherPath = path.join(gameRoot, "launcher.exe");
  const command = processIdentityQueryCommand(4321);

  assert.match(command, /\[Console\]::OutputEncoding/);
  assert.match(command, /\$OutputEncoding/);
  assert.match(command, /UTF8Encoding/);
  assert.match(command, /\$false/);

  const identity = parseWindowsProcessIdentityJson(JSON.stringify({
    ProcessId: 4321,
    Name: "node.exe",
    ExecutablePath: nodePath,
    CommandLine: `"${nodePath}" server.mjs`,
    CreationDate: "20260829010203.123456+480",
  }));

  assert.equal(identity.pid, 4321);
  assert.equal(identity.executablePath, nodePath);
  assert.equal(identity.commandLine, `"${nodePath}" server.mjs`);
  assert.deepEqual(
    protectedProcessNamesForGameRoot(
      [{ name: "launcher.exe", pid: 4322, executablePath: launcherPath }],
      gameRoot,
    ),
    ["launcher.exe"],
  );
});

test("installer preflight blocks Olivia while preserving strict process protection", (t) => {
  const current = fixture();
  t.after(() => fs.rmSync(current.root, { recursive: true, force: true }));
  assert.throws(
    () => preflight({
      gameRoot: current.gameRoot,
      platform: "win32",
      processListImpl: () => ["Olivia.exe"]
    }),
    (error) => error?.code === "launcher_running" && /不会强制结束进程/u.test(error.message)
  );
});

test("authenticated shutdown fetches the matching session token and sends it to /api/shutdown", async () => {
  const calls = [];
  const result = await requestAuthenticatedShutdown({
    host: "127.0.0.1",
    port: 27149,
    expectedVersion: "0.10.7",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/api/session")) {
        return new Response(JSON.stringify({ code: 0, data: { token: "session-token", serviceVersion: "0.10.7" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ code: 0, data: { requested: true } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:27149/api/session",
    "http://127.0.0.1:27149/api/shutdown"
  ]);
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.headers["X-Local-Mail-Session"], "session-token");
  assert.equal(calls[1].options.body, "{}");
});

test("authenticated shutdown refuses a service-version mismatch before POST", async () => {
  let postCalls = 0;
  const result = await requestAuthenticatedShutdown({
    host: "127.0.0.1",
    port: 27149,
    expectedVersion: "0.10.7",
    fetchImpl: async (url) => {
      if (url.endsWith("/api/shutdown")) postCalls += 1;
      return new Response(JSON.stringify({ code: 0, data: { token: "token", serviceVersion: "0.10.6" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "service_version_mismatch");
  assert.equal(postCalls, 0);
});

function handoffFixture() {
  const current = fixture();
  const installerPath = path.join(
    current.layout.serviceRoot,
    "data",
    "updates",
    "0.10.8",
    "LinliLocalMail-0.10.8-Setup.exe"
  );
  fs.mkdirSync(path.dirname(installerPath), { recursive: true });
  fs.writeFileSync(installerPath, "verified setup payload");
  return { ...current, installerPath, installerSha256: sha256File(installerPath) };
}

test("handoff waits for game processes, stops the verified service, rechecks hash, then starts Inno", async (t) => {
  const current = handoffFixture();
  t.after(() => fs.rmSync(current.root, { recursive: true, force: true }));
  const events = [];
  const identity = {
    pid: 4321,
    name: "node.exe",
    executablePath: path.join(current.layout.serviceRoot, "runtime", "node.exe"),
    commandLine: `"${path.join(current.layout.serviceRoot, "runtime", "node.exe")}" server.mjs`,
    creationDate: "20260902130000.000000+000"
  };
  let processListCalls = 0;
  let queryCalls = 0;
  const spawnCalls = [];
  const result = await handoffUpdate({
    gameRoot: current.gameRoot,
    serviceRoot: current.layout.serviceRoot,
    installerPath: current.installerPath,
    expectedSha256: current.installerSha256,
    servicePid: identity.pid,
    serviceVersion: "0.10.7",
    platform: "win32",
    handoffPid: 9911,
    processListImpl: () => {
      processListCalls += 1;
      events.push(`process-list:${processListCalls}`);
      return processListCalls === 1 ? ["Olivia.exe", "launcher.exe", "launcher.original.exe"] : [];
    },
    queryProcessImpl: () => {
      queryCalls += 1;
      events.push(`query:${queryCalls}`);
      return queryCalls < 3 ? identity : null;
    },
    shutdownImpl: async () => {
      events.push("shutdown-http");
      return { ok: true };
    },
    sleepImpl: async () => events.push("wait"),
    now: () => 0,
    spawnImpl: (...args) => {
      spawnCalls.push(args);
      events.push("spawn-installer");
      return { unref() {}, once() {} };
    },
    logPath: path.join(current.root, "handoff.log")
  });

  assert.equal(result.ok, true);
  assert.equal(result.installerStarted, true);
  assert.equal(result.serviceStopped, true);
  assert.equal(result.waitPid, 9911);
  assert.equal(processListCalls, 2);
  assert.equal(queryCalls, 3);
  assert.ok(events.indexOf("shutdown-http") > events.indexOf("process-list:2"));
  assert.ok(events.indexOf("shutdown-http") < events.indexOf("query:3"));
  assert.ok(events.indexOf("spawn-installer") > events.indexOf("query:3"));
  assert.equal(spawnCalls.length, 1);
  const [installerPath, args, options] = spawnCalls[0];
  assert.equal(installerPath, current.installerPath);
  assert.deepEqual(args, [
    `/GAME_ROOT=${current.gameRoot}`,
    "/CONFIRMED_UPDATE=1",
    "/WAIT_PID=9911"
  ]);
  assert.equal(options.cwd, current.gameRoot);
  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
  assert.equal(options.windowsHide, false);
});

test("handoff fails closed when authenticated HTTP shutdown is not confirmed", async (t) => {
  const current = handoffFixture();
  t.after(() => fs.rmSync(current.root, { recursive: true, force: true }));
  const identity = {
    pid: 4321,
    name: "node.exe",
    executablePath: path.join(current.layout.serviceRoot, "runtime", "node.exe"),
    commandLine: `"${path.join(current.layout.serviceRoot, "runtime", "node.exe")}" server.mjs`,
    creationDate: "20260902130000.000000+000"
  };
  let shutdownCalls = 0;
  let spawnCalls = 0;
  await assert.rejects(
    handoffUpdate({
      gameRoot: current.gameRoot,
      installerPath: current.installerPath,
      expectedSha256: current.installerSha256,
      servicePid: identity.pid,
      platform: "win32",
      processListImpl: () => [],
      queryProcessImpl: () => identity,
      shutdownImpl: async () => {
        shutdownCalls += 1;
        return { ok: false, reason: "session_http_503" };
      },
      spawnImpl: () => { spawnCalls += 1; return { unref() {} }; }
    }),
    (error) => error?.code === "service_shutdown_failed" && /拒绝继续安装/u.test(error.message)
  );
  assert.equal(shutdownCalls, 1);
  assert.equal(spawnCalls, 0);
});

test("handoff refuses a hash mismatch before waiting or stopping anything", async (t) => {
  const current = handoffFixture();
  t.after(() => fs.rmSync(current.root, { recursive: true, force: true }));
  let processListCalls = 0;
  let queryCalls = 0;
  let terminateCalls = 0;
  let spawnCalls = 0;
  await assert.rejects(
    handoffUpdate({
      gameRoot: current.gameRoot,
      installerPath: current.installerPath,
      expectedSha256: "0".repeat(64),
      servicePid: 4321,
      platform: "win32",
      processListImpl: () => { processListCalls += 1; return []; },
      queryProcessImpl: () => { queryCalls += 1; return null; },
      shutdownImpl: () => { terminateCalls += 1; return { ok: true }; },
      spawnImpl: () => { spawnCalls += 1; return { unref() {} }; }
    }),
    (error) => error?.code === "handoff_installer_hash_mismatch" && /SHA-256/u.test(error.message)
  );
  assert.equal(processListCalls, 0);
  assert.equal(queryCalls, 0);
  assert.equal(terminateCalls, 0);
  assert.equal(spawnCalls, 0);
});

test("handoff logs a process-list failure and fails closed without stopping the service", async (t) => {
  const current = handoffFixture();
  t.after(() => fs.rmSync(current.root, { recursive: true, force: true }));
  const logPath = path.join(current.root, "handoff-failure.log");
  let terminateCalls = 0;
  let spawnCalls = 0;
  const identity = {
    pid: 4321,
    name: "node.exe",
    executablePath: path.join(current.layout.serviceRoot, "runtime", "node.exe"),
    commandLine: `"${path.join(current.layout.serviceRoot, "runtime", "node.exe")}" server.mjs`,
    creationDate: "20260902130000.000000+000"
  };
  await assert.rejects(
    handoffUpdate({
      gameRoot: current.gameRoot,
      installerPath: current.installerPath,
      expectedSha256: current.installerSha256,
      servicePid: identity.pid,
      platform: "win32",
      queryProcessImpl: () => identity,
      shutdownImpl: async () => ({ ok: true }),
      processListImpl: () => { throw new Error("tasklist unavailable"); },
      spawnImpl: () => { spawnCalls += 1; return { unref() {} }; },
      logPath
    }),
    (error) => error?.code === "process_list_failed"
  );
  assert.equal(terminateCalls, 0);
  assert.equal(spawnCalls, 0);
  assert.match(fs.readFileSync(logPath, "utf8"), /更新交接安全失败/u);
});

test("prepare stops the recorded service gracefully before preparing the transaction", async (t) => {
  const current = fixture();
  t.after(() => fs.rmSync(current.root, { recursive: true, force: true }));
  const pidPath = path.join(current.layout.serviceRoot, "data", "service.pid.json");
  const identity = {
    pid: 4321,
    name: "node.exe",
    executablePath: path.join(current.layout.serviceRoot, "runtime", "node.exe"),
    commandLine: `"${path.join(current.layout.serviceRoot, "runtime", "node.exe")}" server.mjs`,
    creationDate: "20260902130000.000000+000"
  };
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, JSON.stringify({ pid: identity.pid, serverPath: path.join(current.layout.serviceRoot, "server.mjs") }));
  const events = [];
  let queryCalls = 0;
  let prepared = 0;
  const result = await prepareInstallTransaction({
    gameRoot: current.gameRoot,
    manifestPath: "ignored-manifest.json",
    transactionFile: "ignored-transaction.json",
    platform: "win32",
    processListImpl: () => [],
    queryProcessImpl: () => {
      queryCalls += 1;
      events.push(`query:${queryCalls}`);
      return queryCalls < 3 ? identity : null;
    },
    shutdownImpl: async (options) => {
      events.push("shutdown");
      assert.deepEqual(
        { host: options.host, port: options.port, expectedVersion: options.expectedVersion },
        { host: "127.0.0.1", port: 27149, expectedVersion: null }
      );
      return { ok: true };
    },
    sleepImpl: async () => events.push("sleep"),
    prepareImpl: async (options) => {
      prepared += 1;
      events.push("prepare");
      assert.equal(options.skipProcessCheck, undefined);
      return { ok: true, prepared: true };
    }
  });
  assert.deepEqual(result, { ok: true, prepared: true });
  assert.equal(prepared, 1);
  assert.ok(events.indexOf("shutdown") < events.indexOf("prepare"));
  assert.equal(events.filter((entry) => entry.startsWith("query:")).length, 3);
});

test("prepare accepts one UTF-8 BOM in the recorded service PID and still stops gracefully", async (t) => {
  const current = fixture();
  t.after(() => fs.rmSync(current.root, { recursive: true, force: true }));
  const pidPath = path.join(current.layout.serviceRoot, "data", "service.pid.json");
  const identity = {
    pid: 4321,
    name: "node.exe",
    executablePath: path.join(current.layout.serviceRoot, "runtime", "node.exe"),
    commandLine: `"${path.join(current.layout.serviceRoot, "runtime", "node.exe")}" server.mjs`,
    creationDate: "20260902130000.000000+000"
  };
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(
    pidPath,
    Buffer.from(`\uFEFF${JSON.stringify({ pid: identity.pid, serverPath: path.join(current.layout.serviceRoot, "server.mjs") })}`, "utf8")
  );
  const events = [];
  let queryCalls = 0;
  let prepared = 0;
  const result = await prepareInstallTransaction({
    gameRoot: current.gameRoot,
    manifestPath: "ignored-manifest.json",
    transactionFile: "ignored-transaction.json",
    platform: "win32",
    processListImpl: () => [],
    queryProcessImpl: () => {
      queryCalls += 1;
      events.push(`query:${queryCalls}`);
      return queryCalls < 3 ? identity : null;
    },
    shutdownImpl: async () => {
      events.push("shutdown");
      return { ok: true };
    },
    sleepImpl: async () => events.push("sleep"),
    prepareImpl: async () => {
      prepared += 1;
      events.push("prepare");
      return { ok: true, prepared: true };
    }
  });
  assert.deepEqual(result, { ok: true, prepared: true });
  assert.equal(prepared, 1);
  assert.ok(events.indexOf("shutdown") < events.indexOf("prepare"));
  assert.equal(events.filter((entry) => entry.startsWith("query:")).length, 3);
});

test("prepare still rejects malformed service PID JSON", async (t) => {
  const current = fixture();
  t.after(() => fs.rmSync(current.root, { recursive: true, force: true }));
  const pidPath = path.join(current.layout.serviceRoot, "data", "service.pid.json");
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, Buffer.from("\uFEFF{not-json}", "utf8"));
  let prepared = 0;
  await assert.rejects(
    prepareInstallTransaction({
      gameRoot: current.gameRoot,
      manifestPath: "ignored-manifest.json",
      transactionFile: "ignored-transaction.json",
      platform: "win32",
      processListImpl: () => [],
      queryProcessImpl: () => { throw new Error("must not query malformed record"); },
      shutdownImpl: async () => { throw new Error("must not stop malformed record"); },
      prepareImpl: async () => { prepared += 1; return { ok: true }; }
    }),
    (error) => error?.code === "invalid_json"
  );
  assert.equal(prepared, 0);
});

test("prepare refuses to prepare when graceful service shutdown is not confirmed", async (t) => {
  const current = fixture();
  t.after(() => fs.rmSync(current.root, { recursive: true, force: true }));
  const pidPath = path.join(current.layout.serviceRoot, "data", "service.pid.json");
  const identity = {
    pid: 4321,
    name: "node.exe",
    executablePath: path.join(current.layout.serviceRoot, "runtime", "node.exe"),
    commandLine: `"${path.join(current.layout.serviceRoot, "runtime", "node.exe")}" server.mjs`,
    creationDate: "20260902130000.000000+000"
  };
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, JSON.stringify({ pid: identity.pid, serverPath: path.join(current.layout.serviceRoot, "server.mjs") }));
  let prepared = 0;
  await assert.rejects(
    prepareInstallTransaction({
      gameRoot: current.gameRoot,
      manifestPath: "ignored-manifest.json",
      transactionFile: "ignored-transaction.json",
      platform: "win32",
      processListImpl: () => [],
      queryProcessImpl: () => identity,
      shutdownImpl: async () => ({ ok: false, reason: "shutdown_http_503" }),
      prepareImpl: async () => { prepared += 1; return { ok: true }; }
    }),
    (error) => error?.code === "service_shutdown_failed" && /拒绝继续安装/u.test(error.message)
  );
  assert.equal(prepared, 0);
});

test("prepare does not request service shutdown while a selected game process is running", async (t) => {
  const current = fixture();
  t.after(() => fs.rmSync(current.root, { recursive: true, force: true }));
  const pidPath = path.join(current.layout.serviceRoot, "data", "service.pid.json");
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, JSON.stringify({
    pid: 4321,
    serverPath: path.join(current.layout.serviceRoot, "server.mjs")
  }));
  let queryCalls = 0;
  let shutdownCalls = 0;
  let prepared = 0;
  await assert.rejects(
    prepareInstallTransaction({
      gameRoot: current.gameRoot,
      manifestPath: "ignored-manifest.json",
      transactionFile: "ignored-transaction.json",
      platform: "win32",
      processListImpl: () => ["Olivia.exe"],
      queryProcessImpl: () => { queryCalls += 1; return null; },
      shutdownImpl: async () => { shutdownCalls += 1; return { ok: true }; },
      prepareImpl: async () => { prepared += 1; return { ok: true }; }
    }),
    (error) => error?.code === "launcher_running" && /不会强制结束进程/u.test(error.message)
  );
  assert.equal(queryCalls, 0);
  assert.equal(shutdownCalls, 0);
  assert.equal(prepared, 0);
});
