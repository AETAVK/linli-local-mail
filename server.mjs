import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ALLOWED_API_STYLES, ALLOWED_BROWSER_ORIGINS, API_KEY_MASK, HOST, PORT as PORT_FROM_CONSTANTS } from "./src/constants.mjs";
import { MailDatabase } from "./src/database.mjs";
import { importFileEntries } from "./src/file-import.mjs";
import {
  cacheProviderModelCapacities,
  getInternalModelConfig,
  getPublicModelConfig,
  updateModelConfig
} from "./src/model-config.mjs";
import { GenerationWorker } from "./src/orchestrator.mjs";
import { listProviderModels } from "./src/providers.mjs";
import { RemoteImportManager } from "./src/remote-import.mjs";
import { SecretStore } from "./src/secrets.mjs";
import { extractSharedLetters } from "./src/share-import.mjs";
import { normalizeHttpUrl, readJsonBody, safeErrorMessage } from "./src/utils.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// LINLI_MAIL_PORT / LINLI_MAIL_DB_PATH 仅用于并行冒烟测试；日常启动保持默认 27149 与项目数据库。
const PORT = Number(process.env.LINLI_MAIL_PORT) || PORT_FROM_CONSTANTS;
const DB_PATH = process.env.LINLI_MAIL_DB_PATH || path.join(ROOT, "data", "mail-poc.sqlite3");
const LEGACY_JSON_PATH = path.join(ROOT, "imports", "legacy", "data.json");
const CONFIG_ROOT = path.join(ROOT, "config");
const SECRETS_PATH = path.join(ROOT, "data", "secrets.dpapi.json");
const SERVICE_VERSION = "0.7.1";
const SESSION_TOKEN = crypto.randomBytes(32).toString("base64url");

const database = new MailDatabase(DB_PATH, LEGACY_JSON_PATH);
const secretStore = new SecretStore(SECRETS_PATH);
const worker = new GenerationWorker({ database, configRoot: CONFIG_ROOT, secretStore });
const remoteImporter = new RemoteImportManager({ database });

function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  return !origin || ALLOWED_BROWSER_ORIGINS.has(origin);
}

function setCommonHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_BROWSER_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Local-Mail-Session");
  res.setHeader("Access-Control-Max-Age", "600");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

function sendJson(req, res, status, body, extraHeaders = {}) {
  setCommonHeaders(req, res);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders
  });
  res.end(JSON.stringify(body));
}

function sendHtml(req, res, html) {
  setCommonHeaders(req, res);
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'"
  );
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function ok(req, res, data) {
  sendJson(req, res, 200, { code: 0, message: "OK", data });
}

function fail(req, res, status, message) {
  sendJson(req, res, status, { code: status, message, data: null });
}

function hasValidSession(req) {
  const provided = String(req.headers["x-local-mail-session"] || "");
  if (!provided || provided.length !== SESSION_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(SESSION_TOKEN));
}

function isPrivatePath(pathname) {
  if (pathname === "/api/session") return false;
  return pathname.startsWith("/api/") || pathname.startsWith("/letter/");
}

function getLetterId(url, body = {}) {
  return String(
    url.searchParams.get("letter_id")
      || url.searchParams.get("letterId")
      || body.letter_id
      || body.letterId
      || ""
  );
}

async function resolveModelListProvider(body) {
  const draft = body?.provider && typeof body.provider === "object" ? body.provider : {};
  const requestedId = body?.providerId != null ? String(body.providerId) : "";
  const config = await getInternalModelConfig(database, secretStore);
  const existing = requestedId
    ? config.providers.find((provider) => provider.id === requestedId)
    : null;
  if (requestedId && !existing) {
    const error = new Error(`Unknown provider: ${requestedId}`);
    error.status = 404;
    throw error;
  }
  const apiStyle = String(draft.apiStyle || existing?.apiStyle || "").trim();
  if (!ALLOWED_API_STYLES.has(apiStyle)) {
    const error = new Error(`Unsupported API style: ${apiStyle || "(empty)"}`);
    error.status = 400;
    throw error;
  }
  let baseUrl;
  try {
    baseUrl = normalizeHttpUrl(draft.baseUrl ?? existing?.baseUrl);
  } catch (error) {
    error.status = 400;
    throw error;
  }
  const providedKey = String(draft.apiKey ?? "").trim();
  const apiKey = providedKey && providedKey !== API_KEY_MASK ? providedKey : existing?.apiKey || "";
  return { apiStyle, baseUrl, apiKey };
}

function settingsPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>林离本地回信诊断</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, "Microsoft YaHei", sans-serif; }
    body { max-width: 920px; margin: 36px auto; padding: 0 20px 60px; color: #ece7df; background: #171717; }
    section { margin: 16px 0; padding: 20px; border: 1px solid #4b4741; border-radius: 12px; background: #232220; }
    h1, h2 { font-weight: 500; }
    label { display: block; margin: 12px 0 6px; }
    input, textarea { box-sizing: border-box; width: 100%; padding: 10px; color: inherit; background: #191919; border: 1px solid #686157; border-radius: 6px; font: inherit; }
    textarea { min-height: 120px; resize: vertical; }
    button { margin: 12px 8px 0 0; padding: 9px 16px; color: #171717; background: #e5ddd0; border: 0; border-radius: 999px; cursor: pointer; }
    pre { overflow: auto; padding: 12px; background: #161616; border-radius: 8px; white-space: pre-wrap; }
    .muted { color: #aaa297; }
    #status { min-height: 1.5em; color: #b9d7ae; }
  </style>
</head>
<body>
  <h1>林离本地回信诊断</h1>
  <p class="muted">用于服务诊断、运行参数与数据备份。模型与多 Provider 设置也可在游戏原设置页的“本地回信”区域完成。</p>
  <section>
    <h2>服务状态</h2>
    <button id="refresh">刷新诊断</button>
    <button id="export">导出备份</button>
    <pre id="diagnostics">载入中……</pre>
  </section>
  <section>
    <h2>运行参数</h2>
    <label for="delay">异步等待时间（毫秒）</label>
    <input id="delay" type="number" min="0" max="600000">
    <button id="save">保存</button>
    <p class="muted">每日写信上限在游戏设置页“本地回信”的调试模式中调整。</p>
  </section>
  <p id="status"></p>
  <script>
    let session = "";
    const status = document.querySelector("#status");
    async function ensureSession() {
      if (session) return session;
      const response = await fetch("/api/session");
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || "无法取得本地会话");
      session = payload.data.token;
      return session;
    }
    async function api(path, options = {}) {
      await ensureSession();
      const headers = { ...(options.headers || {}), "X-Local-Mail-Session": session };
      const response = await fetch(path, { ...options, headers });
      const payload = await response.json();
      if (!response.ok || payload.code !== 0) throw new Error(payload.message || "本地请求失败");
      return payload.data;
    }
    async function load() {
      const [settings, diagnostics] = await Promise.all([api("/api/settings"), api("/api/diagnostics")]);
      document.querySelector("#delay").value = settings.replyDelayMs;
      document.querySelector("#diagnostics").textContent = JSON.stringify(diagnostics, null, 2);
    }
    document.querySelector("#refresh").onclick = () => load().catch(showError);
    document.querySelector("#save").onclick = async () => {
      try {
        await api("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            replyDelayMs: Number(document.querySelector("#delay").value)
          })
        });
        status.textContent = "设置已保存。";
        await load();
      } catch (error) { showError(error); }
    };
    document.querySelector("#export").onclick = async () => {
      try {
        const data = await api("/api/export");
        const blob = new Blob([JSON.stringify(data, null, 2) + "\\n"], { type: "application/json" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = "linli-local-mail-backup-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        status.textContent = "备份已导出。";
      } catch (error) { showError(error); }
    };
    function showError(error) { status.textContent = error.message || String(error); }
    load().catch(showError);
  </script>
</body>
</html>`;
}

async function diagnostics() {
  const modelConfig = await getPublicModelConfig(database, secretStore);
  const remoteStatus = remoteImporter.status();
  return {
    serviceVersion: SERVICE_VERSION,
    listeningOn: `http://${HOST}:${PORT}`,
    database: database.health(),
    worker: worker.diagnostics(),
    remoteImport: {
      state: remoteStatus.state,
      stage: remoteStatus.stage,
      message: remoteStatus.message,
      errorCode: remoteStatus.errorCode,
      promptDisabled: database.getRemoteImportSettings().promptDisabled
    },
    model: {
      orchestrationVersion: modelConfig.readiness?.orchestrationVersion,
      ready: modelConfig.readiness?.ready ?? false,
      readiness: modelConfig.readiness,
      readinessChecks: modelConfig.readiness?.checks ?? [],
      generation: modelConfig.generation,
      activeProviderId: modelConfig.activeProviderId,
      activeModelId: modelConfig.activeModelId,
      reasoningEffort: modelConfig.reasoningEffort,
      providers: modelConfig.providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        apiStyle: provider.apiStyle,
        baseUrl: provider.baseUrl,
        apiKeyConfigured: provider.apiKeyConfigured,
        models: provider.models
      }))
    }
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

  if (!isAllowedOrigin(req)) {
    console.warn(`${new Date().toISOString()} rejected browser origin ${JSON.stringify(req.headers.origin || "")}`);
    fail(req, res, 403, "Browser origin is not allowed");
    return;
  }
  if (req.method === "OPTIONS") {
    setCommonHeaders(req, res);
    res.writeHead(204);
    res.end();
    return;
  }

  console.log(`${new Date().toISOString()} ${req.method} ${url.pathname}`);

  try {
    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(req, res, 200, {
        ok: true,
        serviceVersion: SERVICE_VERSION,
        database: database.health(),
        worker: worker.diagnostics()
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/settings") {
      sendHtml(req, res, settingsPage());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/session") {
      ok(req, res, { token: SESSION_TOKEN, serviceVersion: SERVICE_VERSION });
      return;
    }
    if (isPrivatePath(url.pathname) && !hasValidSession(req)) {
      fail(req, res, 401, "Missing or invalid local session");
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/diagnostics") {
      ok(req, res, await diagnostics());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/settings") {
      ok(req, res, database.getRuntimeSettings());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/settings") {
      ok(req, res, database.updateRuntimeSettings(await readJsonBody(req)));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/model-config") {
      ok(req, res, await getPublicModelConfig(database, secretStore));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/model-config") {
      ok(req, res, await updateModelConfig(database, secretStore, await readJsonBody(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/model-test") {
      ok(req, res, await worker.testActiveModel());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/models/list") {
      const body = await readJsonBody(req);
      const provider = await resolveModelListProvider(body);
      const models = await listProviderModels(provider, 30000);
      const cachedCapacities = body?.providerId
        ? cacheProviderModelCapacities(database, body.providerId, models)
        : 0;
      ok(req, res, { models, cachedCapacities });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/letters/export") {
      const body = await readJsonBody(req, { maximumBytes: 1024 * 1024 });
      ok(req, res, database.exportLetters(body.letterIds ?? body.letter_ids));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/letters/delete") {
      const body = await readJsonBody(req);
      ok(req, res, database.deleteLetters(body.letterIds ?? body.letter_ids));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/memories") {
      ok(req, res, { memories: database.activeMemories() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/memories") {
      ok(req, res, database.upsertMemory(await readJsonBody(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/import") {
      ok(req, res, database.importLetters(await readJsonBody(req, { maximumBytes: 16 * 1024 * 1024 })));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/import/files") {
      const body = await readJsonBody(req, { maximumBytes: 40 * 1024 * 1024 });
      const entries = Array.isArray(body.files) ? body.files : [];
      ok(req, res, importFileEntries(entries, {
        importFn: (items) => database.importLetters({ letters: items })
      }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/remote-import/detect") {
      ok(req, res, remoteImporter.detect());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/remote-import/start") {
      ok(req, res, remoteImporter.start());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/remote-import/status") {
      ok(req, res, remoteImporter.status());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/remote-import/cancel") {
      ok(req, res, remoteImporter.cancel());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/remote-import/prompt") {
      const body = await readJsonBody(req);
      const action = String(body.action || "");
      ok(req, res, database.updateRemoteImportPrompt(action));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/import/share-link") {
      const body = await readJsonBody(req);
      const rawInputs = Array.isArray(body.urls)
        ? body.urls
        : [body.url ?? body.shareUrl];
      const urls = rawInputs
        .flatMap((value) => String(value ?? "").split(/\r?\n/))
        .map((value) => value.trim())
        .filter(Boolean);
      if (!urls.length) {
        fail(req, res, 400, "请至少提供一个分享链接");
        return;
      }
      if (urls.length > 50) {
        fail(req, res, 400, "单次最多导入 50 个分享链接");
        return;
      }
      const extracted = await extractSharedLetters(urls);
      const results = extracted.map((item) => {
        if (!item.ok) {
          return {
            index: item.index,
            lineNumber: item.index + 1,
            ok: false,
            code: item.code,
            message: item.message
          };
        }
        try {
          const imported = database.importLetters({ letters: [item.record] });
          if (imported.imported !== 1 || imported.skipped) {
            throw new Error(imported.errors?.[0]?.message || "分享信件没有成功写入本地邮箱");
          }
          return {
            index: item.index,
            lineNumber: item.index + 1,
            ok: true,
            action: imported.inserted ? "inserted" : "updated",
            letter: {
              letterId: item.record.letterId,
              shareId: item.record.shareId,
              sourceDate: item.record.sourceDate,
              hasSent: item.record.sent.available,
              hasReply: item.record.reply.available
            }
          };
        } catch (error) {
          return {
            index: item.index,
            lineNumber: item.index + 1,
            ok: false,
            code: "local_import_error",
            message: safeErrorMessage(error)
          };
        }
      });
      const successful = results.filter((item) => item.ok);
      const failed = results.filter((item) => !item.ok);
      const data = {
        requested: urls.length,
        imported: successful.length,
        inserted: successful.filter((item) => item.action === "inserted").length,
        updated: successful.filter((item) => item.action === "updated").length,
        failed: failed.length,
        skipped: failed.length,
        results
      };
      if (results.length === 1) data.letter = results[0].letter || null;
      ok(req, res, data);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/export") {
      ok(req, res, database.exportData());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/shutdown") {
      ok(req, res, { shuttingDown: true });
      setImmediate(closeAndExit);
      return;
    }

    if (req.method === "POST" && url.pathname === "/letter/send") {
      const body = await readJsonBody(req);
      const content = String(body.content || "").trim();
      if (!content) {
        fail(req, res, 400, "Letter content is required");
        return;
      }
      database.assertSendQuota();
      const settings = database.getRuntimeSettings();
      const created = database.createLetter(content, body.material || null, body, settings.replyDelayMs);
      void worker.tick();
      ok(req, res, created);
      return;
    }
    if (req.method === "GET" && url.pathname === "/letter/list") {
      ok(req, res, database.listLetters({
        cursor: url.searchParams.get("cursor") || 0,
        pageSize: url.searchParams.get("page_size") || url.searchParams.get("pageSize") || 20
      }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/letter/detail") {
      const letterId = getLetterId(url);
      const letter = database.getLetter(letterId, { markRead: true, includeInternal: true });
      if (!letter) {
        fail(req, res, 404, `Unknown letter: ${letterId}`);
        return;
      }
      ok(req, res, letter);
      return;
    }
    if (req.method === "GET" && url.pathname === "/letter/unread_count") {
      ok(req, res, { unreadCount: database.unreadCount() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/letter/share") {
      const body = await readJsonBody(req);
      const letterId = getLetterId(url, body);
      if (!database.getLetter(letterId)) {
        fail(req, res, 404, `Unknown letter: ${letterId}`);
        return;
      }
      ok(req, res, { shareId: letterId });
      return;
    }
    if (req.method === "POST" && url.pathname === "/letter/resend") {
      const body = await readJsonBody(req);
      const letterId = getLetterId(url, body);
      const result = database.retryLetter(letterId, database.getRuntimeSettings().replyDelayMs);
      if (!result) {
        fail(req, res, 404, `Unknown letter: ${letterId}`);
        return;
      }
      void worker.tick();
      ok(req, res, result);
      return;
    }

    fail(req, res, 404, `No local route for ${req.method} ${url.pathname}`);
  } catch (error) {
    const message = safeErrorMessage(error);
    console.error(`${new Date().toISOString()} ${req.method} ${url.pathname}: ${message}`);
    const candidateStatus = Number(error?.statusCode ?? error?.status);
    const status = Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus <= 599
      ? candidateStatus
      : error instanceof SyntaxError ? 400 : 500;
    fail(req, res, status, message);
  }
});

let shuttingDown = false;
function closeAndExit() {
  if (shuttingDown) return;
  shuttingDown = true;
  worker.stop();
  server.close(() => {
    database.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", closeAndExit);
process.on("SIGTERM", closeAndExit);

server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.listen(PORT, HOST, () => {
  worker.start();
  console.log(`Linli local mail service ${SERVICE_VERSION} listening on http://${HOST}:${PORT}`);
  console.log(`Settings and diagnostics: http://${HOST}:${PORT}/settings`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Migrated legacy JSON letters: ${database.migratedLegacyLetters}`);
  console.log(`Recovered interrupted jobs: ${database.recoveredJobs}`);
});
