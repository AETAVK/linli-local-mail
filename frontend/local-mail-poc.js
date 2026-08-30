(function () {
  "use strict";

  var API_BASE = "http://127.0.0.1:27149";
  var SECTION_ID = "local-mail-settings-section";
  var MAILBOX_TOOLS_ID = "local-mail-mailbox-tools";
  var MAILBOX_IMPORT_BUTTON_ID = "local-mail-mailbox-import-button";
  var MAILBOX_IMPORT_MODAL_ID = "local-mail-import-modal";
  var LETTERS_MODAL_ID = "local-mail-letters-modal";
  var UPDATE_MENU_ITEM_ID = "local-mail-check-update-menu-item";
  var UPDATE_MODAL_ID = "local-mail-update-modal";
  var state = {
    config: null,
    runtime: null,
    diagnostics: null,
    debugMode: false,
    mounting: false,
    importMode: "file",
    importFiles: [],
    importBusy: false,
    modal: { providerId: null, draft: null, suggestions: [], addModelOpen: false, editingModelId: null },
    lettersModal: { mode: "export", items: [], selected: {}, busy: false },
    remoteImport: { checked: false, checking: false, candidate: false, running: false, pollTimer: null, lastStatus: null, retryAfter: 0 },
    remotePromptSettings: null,
    update: { autoStarted: false, checking: false, applying: false, result: null }
  };
  var sessionPromise = null;

  async function localSession() {
    if (!sessionPromise) {
      sessionPromise = fetch(API_BASE + "/api/session", {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer"
      }).then(async function (response) {
        var payload = await response.json();
        if (!response.ok || payload.code !== 0 || !payload.data || !payload.data.token) {
          throw new Error(payload.message || "无法建立本地回信会话");
        }
        return payload.data.token;
      }).catch(function (error) {
        sessionPromise = null;
        throw error;
      });
    }
    return sessionPromise;
  }

  function queryString(params) {
    var query = new URLSearchParams();
    Object.keys(params || {}).forEach(function (key) {
      var value = params[key];
      if (value == null) return;
      if (Array.isArray(value)) value.forEach(function (item) { query.append(key, String(item)); });
      else query.set(key, String(value));
    });
    var text = query.toString();
    return text ? "?" + text : "";
  }

  async function localRequest(method, path, data, config, retrying) {
    var token = await localSession();
    var url = API_BASE + path + (method === "GET" ? queryString(config && config.params) : "");
    var response = await fetch(url, {
      method: method,
      headers: {
        "X-Local-Mail-Session": token,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {})
      },
      body: method === "POST" ? JSON.stringify(data == null ? {} : data) : undefined,
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: config && config.signal
    });
    if (response.status === 401 && !retrying) {
      sessionPromise = null;
      return localRequest(method, path, data, config, true);
    }
    var payload = await response.json();
    if (!response.ok || payload.code !== 0) throw new Error(payload.message || "本地服务请求失败");
    return { data: payload.data, status: response.status, headers: response.headers };
  }

  window.__LOCAL_MAIL_HTTP__ = Object.freeze({
    get: function (path, config) { return localRequest("GET", path, null, config || {}, false); },
    post: function (path, data, config) { return localRequest("POST", path, data, config || {}, false); }
  });

  var nativeSetInterval = window.setInterval.bind(window);
  window.setInterval = function (handler, delay) {
    var args = Array.prototype.slice.call(arguments, 2);
    var effectiveDelay = delay;
    if (delay === 60000 && typeof handler === "function") {
      var source = Function.prototype.toString.call(handler);
      if (source.indexOf("Failed to poll letters") !== -1) effectiveDelay = 2000;
    }
    return nativeSetInterval.apply(window, [handler, effectiveDelay].concat(args));
  };

  function createId(prefix) {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return prefix + "-" + window.crypto.randomUUID();
    }
    return prefix + "-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  async function callApi(path, options) {
    var request = options || {};
    var method = String(request.method || "GET").toUpperCase();
    if (method === "GET") return (await window.__LOCAL_MAIL_HTTP__.get(path, request)).data;
    var body = request.body == null ? {} : typeof request.body === "string" ? JSON.parse(request.body) : request.body;
    return (await window.__LOCAL_MAIL_HTTP__.post(path, body, request)).data;
  }

  function isSettingsRoute() {
    return /\/settings\/?$/.test(window.location.pathname) || /#\/settings\/?$/.test(window.location.hash);
  }

  function hideWatermark() {
    if (!document.getElementById("local-mail-watermark-style")) {
      var style = document.createElement("style");
      style.id = "local-mail-watermark-style";
      style.textContent = ".watermark-overlay{display:none!important}";
      (document.head || document.documentElement).appendChild(style);
    }
  }

  function installStyles() {
    if (document.getElementById("local-mail-settings-style")) return;
    var style = document.createElement("style");
    style.id = "local-mail-settings-style";
    style.textContent = [
      "#" + SECTION_ID + "{padding:0 0 12px;color:var(--tp-text-body,#ced2d4);color-scheme:dark}",
      ".lm-title-row{display:flex;align-items:center;justify-content:space-between;gap:16px}",
      ".lm-title{font-size:20px;font-weight:600;color:var(--tp-text-title,#e8e9eb)}",
      ".lm-subtitle{font-size:13px;line-height:1.6;color:var(--tp-text-secondary,#a1a5ad)}",
      ".lm-badge{padding:4px 10px;border-radius:999px;background:rgba(129,196,164,.14);color:#a9d9c0;font-size:12px;white-space:nowrap}",
      ".lm-card{padding:16px;border:1px solid rgba(255,255,255,.09);border-radius:12px;background:rgba(255,255,255,.035);margin-top:12px}",
      ".lm-card[hidden]{display:none}",
      ".lm-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}",
      ".lm-card-head .lm-card-title{margin-bottom:0}",
      ".lm-card-title{font-size:15px;font-weight:600;margin-bottom:12px;color:var(--tp-text-title,#e8e9eb)}",
      ".lm-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}",
      ".lm-field{display:flex;flex-direction:column;gap:6px;min-width:0}",
      ".lm-field>span{font-size:12px;color:var(--tp-text-tertiary,#7d818c)}",
      ".lm-input,.lm-select{box-sizing:border-box;width:100%;height:38px;padding:0 11px;border:1px solid rgba(255,255,255,.13);border-radius:8px;background:rgba(0,0,0,.18);color:var(--tp-text-body,#ced2d4);font:inherit;outline:none}",
      ".lm-textarea{box-sizing:border-box;width:100%;min-height:92px;padding:10px 11px;border:1px solid rgba(255,255,255,.13);border-radius:8px;background:rgba(0,0,0,.18);color:var(--tp-text-body,#ced2d4);font:inherit;line-height:1.55;resize:vertical;outline:none}",
      ".lm-input:focus,.lm-select:focus{border-color:rgba(255,255,255,.35)}",
      ".lm-textarea:focus{border-color:rgba(255,255,255,.35)}",
      ".lm-input::placeholder{color:var(--tp-text-disabled,#63656e)}",
      ".lm-select:disabled,.lm-input:disabled{color:var(--tp-text-disabled,#63656e)}",
      ".lm-select option{background:var(--tp-surface-1,#232529);color:var(--tp-text-title,#e8e9eb)}",
      ".lm-select option:disabled{color:var(--tp-text-disabled,#63656e)}",
      ".lm-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px}",
      ".lm-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".lm-button{height:36px;padding:0 16px;border:1px solid rgba(255,255,255,.18);border-radius:999px;background:transparent;color:var(--tp-text-body,#ced2d4);font:inherit;cursor:pointer}",
      ".lm-button:hover{background:rgba(255,255,255,.08)}",
      ".lm-button-primary{background:#ece8df;color:#27251f;border-color:#ece8df;font-weight:600}",
      ".lm-button-primary:hover{background:#fffaf0}",
      ".lm-button-danger{color:#e5aaa5}",
      ".lm-button-danger-solid{background:#5a2f2c;color:#f3d6d3;border-color:#5a2f2c;font-weight:600}",
      ".lm-button-danger-solid:hover{background:#6d3a36;border-color:#6d3a36}",
      ".lm-button-small{height:30px;padding:0 12px;font-size:12px}",
      ".lm-button:disabled{opacity:.45;cursor:not-allowed}",
      ".lm-status{font-size:12px;min-height:18px;color:var(--tp-text-secondary,#a1a5ad)}",
      ".lm-status[data-kind='success']{color:#a9d9c0}",
      ".lm-status[data-kind='error']{color:#e5aaa5}",
      ".lm-config-item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:rgba(0,0,0,.12)}",
      ".lm-config-info{min-width:0;flex:1}",
      ".lm-config-name{font-size:14px;font-weight:600;color:var(--tp-text-title,#e8e9eb)}",
      ".lm-config-active{margin-left:8px;padding:2px 8px;border-radius:999px;background:rgba(129,196,164,.14);color:#a9d9c0;font-size:11px;font-weight:400}",
      ".lm-config-meta{margin-top:3px;font-size:12px;color:var(--tp-text-secondary,#a1a5ad);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".lm-config-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}",
      ".lm-provider-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}",
      ".lm-provider-grid .lm-wide{grid-column:1/-1}",
      ".lm-modal.lm-model-manager{width:min(1080px,94vw);height:min(840px,94vh);max-height:94vh;overflow:hidden;padding:0;display:flex;flex-direction:column}",
      ".lm-model-manager-header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:22px 26px 18px;border-bottom:1px solid rgba(255,255,255,.09)}",
      ".lm-model-manager-header .lm-modal-title{margin:0;font-size:20px}",
      ".lm-model-manager-intro{margin-top:5px;font-size:12px;line-height:1.55;color:var(--tp-text-secondary,#a1a5ad)}",
      ".lm-model-manager-body{display:grid;grid-template-columns:250px minmax(0,1fr);min-height:0;flex:1}",
      ".lm-provider-nav{display:flex;min-height:0;flex-direction:column;padding:18px 14px;border-right:1px solid rgba(255,255,255,.09);background:rgba(0,0,0,.1)}",
      ".lm-provider-nav-title{padding:0 8px 9px;font-size:11px;letter-spacing:.04em;color:var(--tp-text-tertiary,#7d818c)}",
      ".lm-manager-list{display:flex;min-height:0;flex:1;flex-direction:column;gap:7px;overflow:auto}",
      ".lm-provider-nav-item{box-sizing:border-box;width:100%;padding:11px 12px;border:1px solid transparent;border-radius:9px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}",
      ".lm-provider-nav-item:hover{background:rgba(255,255,255,.05)}",
      ".lm-provider-nav-item[data-selected='true']{border-color:rgba(255,255,255,.14);background:rgba(255,255,255,.075)}",
      ".lm-provider-nav-name-row{display:flex;align-items:center;justify-content:space-between;gap:8px}",
      ".lm-provider-nav-name{min-width:0;overflow:hidden;color:var(--tp-text-title,#e8e9eb);font-size:14px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}",
      ".lm-provider-nav-meta{display:block;margin-top:4px;overflow:hidden;color:var(--tp-text-tertiary,#7d818c);font-size:11px;text-overflow:ellipsis;white-space:nowrap}",
      ".lm-provider-nav-badge{flex:0 0 auto;padding:2px 6px;border-radius:999px;background:rgba(129,196,164,.14);color:#a9d9c0;font-size:10px}",
      ".lm-provider-nav-empty{padding:14px 10px;color:var(--tp-text-tertiary,#7d818c);font-size:12px;line-height:1.55;text-align:center}",
      ".lm-provider-nav-add{width:100%;margin-top:12px;border-radius:9px}",
      ".lm-provider-nav-add[data-selected='true']{border-color:rgba(216,209,197,.38);background:rgba(216,209,197,.08);color:var(--tp-text-title,#e8e9eb)}",
      ".lm-provider-detail{display:flex;min-width:0;min-height:0;flex-direction:column}",
      ".lm-provider-detail-scroll{min-height:0;flex:1;overflow:auto;padding:20px 30px 24px}",
      ".lm-provider-detail-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:18px}",
      ".lm-provider-detail-title{font-size:18px;font-weight:600;color:var(--tp-text-title,#e8e9eb)}",
      ".lm-provider-detail-subtitle{margin-top:4px;font-size:12px;color:var(--tp-text-tertiary,#7d818c)}",
      ".lm-provider-detail-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}",
      ".lm-provider-section{margin-top:20px}",
      ".lm-provider-detail-head+.lm-provider-section{margin-top:0}",
      ".lm-provider-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}",
      ".lm-provider-section-title{font-size:14px;font-weight:600;color:var(--tp-text-title,#e8e9eb)}",
      ".lm-provider-section-meta{font-size:11px;color:var(--tp-text-tertiary,#7d818c)}",
      ".lm-model-list-card{overflow:hidden;border:1px solid rgba(255,255,255,.1);border-radius:10px;background:rgba(0,0,0,.1)}",
      ".lm-model-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:14px;padding:9px 12px;border-bottom:1px solid rgba(255,255,255,.075)}",
      ".lm-model-row:last-child{border-bottom:0}",
      ".lm-model-row-main{min-width:0}",
      ".lm-model-row-title{display:flex;align-items:center;gap:8px;min-width:0}",
      ".lm-model-row-name{overflow:hidden;color:var(--tp-text-title,#e8e9eb);font-size:13px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}",
      ".lm-model-row-id{margin-top:3px;overflow:hidden;color:var(--tp-text-tertiary,#7d818c);font-size:11px;text-overflow:ellipsis;white-space:nowrap}",
      ".lm-model-row-actions{display:flex;align-items:center;gap:4px}",
      ".lm-model-row-action{height:28px;padding:0 9px;border:0;border-radius:7px;background:transparent;color:var(--tp-text-secondary,#a1a5ad);font:inherit;font-size:11px;cursor:pointer}",
      ".lm-model-row-action:hover{background:rgba(255,255,255,.07);color:var(--tp-text-title,#e8e9eb)}",
      ".lm-model-row-action-danger{color:#e5aaa5}",
      ".lm-model-active{padding:2px 7px;border-radius:999px;background:rgba(129,196,164,.14);color:#a9d9c0;font-size:10px;font-weight:400;white-space:nowrap}",
      ".lm-model-edit-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.35fr);gap:8px}",
      ".lm-model-edit-grid .lm-input{height:34px;font-size:12px}",
      ".lm-model-add-toggle{margin-top:10px;border-radius:8px}",
      ".lm-model-add-panel{margin-top:10px;padding:13px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:rgba(0,0,0,.13)}",
      ".lm-model-add-panel[hidden]{display:none}",
      ".lm-model-manager-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:14px 22px;border-top:1px solid rgba(255,255,255,.09);background:rgba(0,0,0,.08)}",
      ".lm-model-manager-footer .lm-modal-status{margin-right:auto}",
      ".lm-models{margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,.07)}",
      ".lm-model-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;color:var(--tp-text-title,#e8e9eb)}",
      ".lm-model-rows{display:flex;flex-direction:column;gap:8px;margin-top:10px}",
      ".lm-advanced{margin-top:12px}",
      ".lm-advanced-toggle{display:inline-flex;align-items:center;gap:6px;padding:0;border:0;background:transparent;color:var(--tp-text-secondary,#a1a5ad);font:inherit;font-size:13px;cursor:pointer}",
      ".lm-advanced-toggle:hover{color:var(--tp-text-title,#e8e9eb)}",
      ".lm-advanced-arrow{display:inline-block;transition:transform .15s}",
      ".lm-advanced-toggle[aria-expanded='true'] .lm-advanced-arrow{transform:rotate(90deg)}",
      ".lm-advanced-panel{margin-top:10px;padding-top:12px;border-top:1px solid rgba(255,255,255,.07)}",
      ".lm-modal-backdrop{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);padding:24px}",
      ".lm-modal-backdrop[hidden]{display:none}",
      ".lm-modal{width:min(680px,92vw);max-height:86vh;overflow:auto;padding:20px;border:1px solid rgba(255,255,255,.12);border-radius:14px;background:var(--tp-surface-1,#232529);color:var(--tp-text-body,#ced2d4);box-shadow:0 18px 48px rgba(0,0,0,.45)}",
      ".lm-modal-title{font-size:16px;font-weight:600;color:var(--tp-text-title,#e8e9eb);margin-bottom:14px}",
      ".lm-modal-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:16px}",
      ".lm-modal-status{min-width:0;margin-right:auto;font-size:12px;line-height:1.45;white-space:pre-line;color:var(--tp-text-secondary,#a1a5ad)}",
      ".lm-modal-status[data-kind='error']{color:#e5aaa5}",
      ".lm-modal-status[data-kind='success']{color:#a9d9c0}",
      ".lm-empty{padding:16px;text-align:center;border:1px dashed rgba(255,255,255,.12);border-radius:10px;color:var(--tp-text-secondary,#a1a5ad);font-size:13px}",
      ".lm-import-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".lm-import-row .lm-select,.lm-import-row .lm-input{flex:1;min-width:0}",
      ".lm-file{max-width:360px;color:var(--tp-text-secondary,#a1a5ad);font:inherit;font-size:12px}",
      ".lm-file::file-selector-button{height:32px;margin-right:10px;padding:0 12px;border:1px solid rgba(255,255,255,.18);border-radius:999px;background:transparent;color:var(--tp-text-body,#ced2d4);cursor:pointer}",
      ".lm-note{margin-top:8px;font-size:12px;line-height:1.55;color:var(--tp-text-tertiary,#7d818c)}",
      ".lm-check{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;color:var(--tp-text-secondary,#a1a5ad)}",
      ".lm-check[hidden]{display:none}",
      ".lm-check input{width:16px;height:16px;accent-color:#d8d1c5}",
      ".lm-diagnostics{margin-top:10px;padding:10px 12px;border-radius:8px;background:rgba(0,0,0,.16);font-size:12px;line-height:1.65;color:var(--tp-text-secondary,#a1a5ad);white-space:pre-wrap}",
      ".lm-mailbox-tools{display:flex;align-items:center;gap:8px;margin-left:auto;margin-right:12px}",
      ".lm-mailbox-import-button{height:24px;padding:0 11px;border:1px solid var(--tp-grey-5,rgba(255,255,255,.22));border-radius:999px;background:transparent;color:var(--tp-text-secondary,#a1a5ad);font-size:12px;line-height:22px;cursor:pointer;transition:background-color .15s,color .15s,border-color .15s}",
      ".lm-mailbox-import-button:hover{border-color:var(--tp-grey-7,rgba(255,255,255,.42));background:var(--tp-surface-1,rgba(255,255,255,.07));color:var(--tp-text-title,#e8e9eb)}",
      ".lm-mailbox-import-button[hidden]{display:none}",
      ".lm-import-dialog{width:min(620px,92vw);padding:24px}",
      ".lm-import-title-row{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:6px}",
      ".lm-import-title-row .lm-modal-title{margin:0;font-size:18px}",
      ".lm-import-close{display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;color:var(--tp-text-secondary,#a1a5ad);font-size:20px;line-height:1;cursor:pointer}",
      ".lm-import-close:hover{background:rgba(255,255,255,.08);color:var(--tp-text-title,#e8e9eb)}",
      ".lm-import-description{margin-bottom:16px;color:var(--tp-text-secondary,#a1a5ad);font-size:13px;line-height:1.55}",
      ".lm-import-methods{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}",
      ".lm-import-methods-two{grid-template-columns:repeat(2,minmax(0,1fr))}",
      ".lm-import-method{display:flex;align-items:flex-start;gap:12px;min-height:92px;padding:14px;border:1px solid rgba(255,255,255,.1);border-radius:10px;background:rgba(0,0,0,.12);text-align:left;cursor:pointer}",
      ".lm-import-method:hover{border-color:rgba(255,255,255,.24);background:rgba(255,255,255,.04)}",
      ".lm-import-method[data-active='true']{border-color:var(--tp-primary-2,#d8d1c5);background:rgba(216,209,197,.08)}",
      ".lm-import-method-icon{display:flex;align-items:center;justify-content:center;flex:0 0 34px;width:34px;height:34px;border-radius:8px;background:var(--tp-surface-2,#191a1d);color:var(--tp-text-title,#e8e9eb);font-size:13px}",
      ".lm-import-method-copy{min-width:0}",
      ".lm-import-method-title{display:block;color:var(--tp-text-title,#e8e9eb);font-size:14px;font-weight:600}",
      ".lm-import-method-desc{display:block;margin-top:3px;color:var(--tp-text-secondary,#a1a5ad);font-size:12px;line-height:1.4}",
      ".lm-import-method-note{display:block;margin-top:5px;color:var(--tp-text-tertiary,#7d818c);font-size:11px}",
      ".lm-import-panel{margin-top:14px;padding:14px;border-radius:10px;background:rgba(0,0,0,.13)}",
      ".lm-import-panel[hidden]{display:none}",
      ".lm-advanced-group{margin-top:16px;padding-top:14px;border-top:1px solid rgba(255,255,255,.07)}",
      ".lm-advanced-group:first-child{margin-top:0;padding-top:0;border-top:0}",
      ".lm-advanced-group-title{margin-bottom:10px;color:var(--tp-text-title,#e8e9eb);font-size:13px;font-weight:600}",
      ".lm-advanced-group-note{margin:-4px 0 10px;color:var(--tp-text-tertiary,#7d818c);font-size:11px;line-height:1.5}",
      ".lm-parameter-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}",
      ".lm-parameter-wide{grid-column:1/-1}",
      ".lm-raw-json{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}",
      ".lm-import-placeholder{display:flex;min-height:72px;align-items:center;justify-content:center;flex-direction:column;gap:4px;color:var(--tp-text-secondary,#a1a5ad);font-size:13px;text-align:center}",
      ".lm-import-placeholder small{color:var(--tp-text-tertiary,#7d818c);font-size:11px}",
      ".lm-file-import-list{margin-top:10px;display:flex;flex-direction:column;gap:6px;max-height:190px;overflow:auto}",
      ".lm-file-import-row{display:flex;align-items:center;gap:10px;padding:7px 10px;border:1px solid rgba(255,255,255,.08);border-radius:8px;background:rgba(0,0,0,.12);font-size:12px}",
      ".lm-file-import-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--tp-text-title,#e8e9eb)}",
      ".lm-file-import-kind{flex:0 0 auto;padding:1px 7px;border-radius:999px;background:rgba(255,255,255,.08);color:var(--tp-text-secondary,#a1a5ad);font-size:11px}",
      ".lm-file-import-status{flex:0 0 auto;max-width:48%;color:var(--tp-text-secondary,#a1a5ad);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".lm-file-import-status[data-kind='success']{color:#a9d9c0}",
      ".lm-file-import-status[data-kind='partial']{color:#d8b98f}",
      ".lm-file-import-status[data-kind='error']{color:#e5aaa5}",
      ".lm-file-import-status[data-kind='unsupported']{color:#d8b98f}",
      ".local-mail-remote-import-toast{position:fixed;right:18px;bottom:18px;z-index:999999;width:min(360px,calc(100vw - 36px));padding:14px 16px;border:1px solid rgba(255,255,255,.14);border-radius:12px;background:rgba(30,31,35,.97);color:var(--tp-text-body,#ced2d4);box-shadow:0 12px 32px rgba(0,0,0,.5);font-size:13px;line-height:1.55;color-scheme:dark}",
      ".local-mail-remote-import-toast[hidden]{display:none}",
      ".local-mail-remote-import-title{font-size:14px;font-weight:600;color:var(--tp-text-title,#e8e9eb);margin-bottom:6px;padding-right:18px}",
      ".local-mail-remote-import-body{margin-bottom:10px;color:var(--tp-text-secondary,#a1a5ad)}",
      ".local-mail-remote-import-actions{display:flex;gap:8px;flex-wrap:wrap}",
      ".local-mail-remote-import-button{height:30px;padding:0 12px;border:1px solid rgba(255,255,255,.22);border-radius:999px;background:transparent;color:var(--tp-text-body,#ced2d4);font:inherit;font-size:12px;cursor:pointer}",
      ".local-mail-remote-import-button:hover{background:rgba(255,255,255,.08)}",
      ".local-mail-remote-import-button-primary{background:#ece8df;color:#27251f;border-color:#ece8df;font-weight:600}",
      ".local-mail-remote-import-button-primary:hover{background:#fffaf0}",
      ".local-mail-remote-import-close{position:absolute;top:10px;right:10px;display:flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:50%;background:transparent;color:var(--tp-text-secondary,#a1a5ad);font-size:16px;line-height:1;cursor:pointer}",
      ".local-mail-remote-import-close:hover{background:rgba(255,255,255,.08);color:var(--tp-text-title,#e8e9eb)}",
      ".local-mail-remote-import-status{margin-top:9px;font-size:12px;color:var(--tp-text-secondary,#a1a5ad);white-space:pre-line}",
      ".local-mail-remote-import-status[data-kind='success']{color:#a9d9c0}",
      ".local-mail-remote-import-status[data-kind='error']{color:#e5aaa5}",
      ".lm-letter-toolbar{display:flex;align-items:center;gap:12px;margin:12px 0 4px;font-size:12px;color:var(--tp-text-secondary,#a1a5ad)}",
      ".lm-letter-toolbar .lm-check{margin-top:0}",
      ".lm-letter-list{margin-top:8px;max-height:44vh;overflow:auto;display:flex;flex-direction:column;gap:6px}",
      ".lm-letter-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid rgba(255,255,255,.08);border-radius:8px;background:rgba(0,0,0,.12);cursor:pointer}",
      ".lm-letter-row:hover{border-color:rgba(255,255,255,.2)}",
      ".lm-letter-row input{flex:0 0 auto;width:15px;height:15px;accent-color:#d8d1c5}",
      ".lm-letter-meta{min-width:0;flex:1}",
      ".lm-letter-summary{display:block;font-size:13px;color:var(--tp-text-title,#e8e9eb);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".lm-letter-sub{display:block;margin-top:2px;font-size:11px;color:var(--tp-text-tertiary,#7d818c)}",
      ".lm-letter-status{flex:0 0 auto;font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,.07);color:var(--tp-text-secondary,#a1a5ad)}",
      ".lm-update-menu-item{user-select:none}",
      ".lm-update-menu-icon{display:inline-flex;width:18px;height:18px;align-items:center;justify-content:center;flex:0 0 auto;color:currentColor}",
      ".lm-update-menu-icon svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}",
      ".lm-update-dialog{width:min(520px,92vw);padding:24px}",
      ".lm-update-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}",
      ".lm-update-heading .lm-modal-title{margin:0;font-size:18px}",
      ".lm-update-version{display:flex;align-items:center;gap:10px;margin:14px 0;padding:12px 14px;border:1px solid rgba(255,255,255,.09);border-radius:10px;background:rgba(0,0,0,.14)}",
      ".lm-update-version-current,.lm-update-version-latest{font-size:14px;font-weight:600;color:var(--tp-text-title,#e8e9eb)}",
      ".lm-update-version-arrow{color:var(--tp-text-tertiary,#7d818c)}",
      ".lm-update-copy{font-size:13px;line-height:1.65;color:var(--tp-text-secondary,#a1a5ad);white-space:pre-line}",
      ".lm-update-meta{margin-top:9px;font-size:11px;color:var(--tp-text-tertiary,#7d818c)}",
      ".lm-update-warning{margin-top:14px;padding:10px 12px;border-left:2px solid #d8b98f;background:rgba(216,185,143,.08);color:#d7c3a6;font-size:12px;line-height:1.6}",
      ".lm-update-releases{margin-top:16px;padding-top:13px;border-top:1px solid rgba(255,255,255,.08)}",
      ".lm-update-releases[hidden]{display:none}",
      ".lm-update-releases-title{margin-bottom:8px;color:var(--tp-text-title,#e8e9eb);font-size:13px;font-weight:600}",
      ".lm-update-release-list{display:flex;max-height:220px;flex-direction:column;gap:8px;overflow:auto;padding-right:4px}",
      ".lm-update-release{padding:10px 11px;border:1px solid rgba(255,255,255,.08);border-radius:9px;background:rgba(0,0,0,.13)}",
      ".lm-update-release-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px}",
      ".lm-update-release-version{color:var(--tp-text-title,#e8e9eb);font-size:12px;font-weight:600}",
      ".lm-update-release-name{min-width:0;overflow:hidden;color:var(--tp-text-tertiary,#7d818c);font-size:11px;text-align:right;text-overflow:ellipsis;white-space:nowrap}",
      ".lm-update-release-date{margin-top:3px;color:var(--tp-text-tertiary,#7d818c);font-size:10px}",
      ".lm-update-release-notes{margin-top:6px;color:var(--tp-text-secondary,#a1a5ad);font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word}",
      "@media(max-width:900px){.lm-grid,.lm-provider-grid,.lm-parameter-grid{grid-template-columns:1fr}.lm-provider-grid .lm-wide,.lm-parameter-wide{grid-column:auto}.lm-toolbar{align-items:flex-start;flex-direction:column}.lm-config-item{flex-direction:column;align-items:flex-start}.lm-import-methods{grid-template-columns:1fr}.lm-model-manager-body{grid-template-columns:210px minmax(0,1fr)}.lm-provider-detail-scroll{padding:18px}.lm-model-edit-grid{grid-template-columns:1fr}}",
      "@media(max-width:680px){.lm-modal.lm-model-manager{height:90vh}.lm-model-manager-body{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}.lm-provider-nav{max-height:190px;border-right:0;border-bottom:1px solid rgba(255,255,255,.09)}.lm-provider-detail-head{flex-direction:column}.lm-provider-detail-actions{justify-content:flex-start}}"
    ].join("");
    document.head.appendChild(style);
  }

  function formatUpdateBytes(value) {
    var bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return "大小未知";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function updateSourceLabel(source) {
    if (source === "gitee") return "Gitee 国内镜像";
    if (source === "github") return "GitHub Releases";
    return "公开发布源";
  }

  function ensureUpdateModal() {
    var backdrop = document.getElementById(UPDATE_MODAL_ID);
    if (backdrop) return backdrop;
    installStyles();
    backdrop = document.createElement("div");
    backdrop.id = UPDATE_MODAL_ID;
    backdrop.className = "lm-modal-backdrop";
    backdrop.hidden = true;
    backdrop.innerHTML =
      '<div class="lm-modal lm-update-dialog" role="dialog" aria-modal="true" aria-labelledby="lm-update-title">' +
      '<div class="lm-update-heading"><div class="lm-modal-title" id="lm-update-title" data-role="update-title">检查补丁更新</div></div>' +
      '<div class="lm-update-copy" data-role="update-copy"></div>' +
      '<div class="lm-update-version" data-role="update-version" hidden>' +
      '<span class="lm-update-version-current" data-role="update-current"></span>' +
      '<span class="lm-update-version-arrow">→</span>' +
      '<span class="lm-update-version-latest" data-role="update-latest"></span></div>' +
      '<div class="lm-update-meta" data-role="update-meta"></div>' +
      '<div class="lm-update-releases" data-role="update-releases" hidden>' +
      '<div class="lm-update-releases-title">未更新版本的更新说明</div>' +
      '<div class="lm-update-release-list" data-role="update-release-list"></div></div>' +
      '<div class="lm-update-warning" data-role="update-warning" hidden></div>' +
      '<div class="lm-modal-actions"><span class="lm-modal-status" data-role="update-status"></span>' +
      '<button class="lm-button" type="button" data-update-action="close">稍后</button>' +
      '<button class="lm-button lm-button-primary" type="button" data-update-action="apply" hidden>更新到最新版</button></div>' +
      '</div>';
    backdrop.addEventListener("click", function (event) {
      var button = event.target.closest("[data-update-action]");
      if (button) {
        if (button.dataset.updateAction === "close") closeUpdateModal();
        else if (button.dataset.updateAction === "apply") applyUpdate();
        return;
      }
      if (event.target === backdrop) closeUpdateModal();
    });
    backdrop.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeUpdateModal();
    });
    document.body.appendChild(backdrop);
    return backdrop;
  }

  function renderUpdateReleaseNotes(modal, result) {
    var section = modal.querySelector('[data-role="update-releases"]');
    var list = modal.querySelector('[data-role="update-release-list"]');
    if (!section || !list) return;
    list.textContent = "";
    var releases = result && Array.isArray(result.pendingReleases) ? result.pendingReleases : [];
    if (!releases.length) {
      section.hidden = true;
      return;
    }
    releases.forEach(function (release) {
      var card = document.createElement("div");
      card.className = "lm-update-release";
      var head = document.createElement("div");
      head.className = "lm-update-release-head";
      var version = document.createElement("span");
      version.className = "lm-update-release-version";
      version.textContent = "v" + String(release.version || "");
      var name = document.createElement("span");
      name.className = "lm-update-release-name";
      name.textContent = String(release.name || release.tag || "");
      head.appendChild(version);
      head.appendChild(name);
      card.appendChild(head);
      if (release.publishedAt) {
        var date = document.createElement("div");
        date.className = "lm-update-release-date";
        var parsedDate = new Date(release.publishedAt);
        date.textContent = Number.isNaN(parsedDate.getTime())
          ? String(release.publishedAt)
          : parsedDate.toLocaleDateString();
        card.appendChild(date);
      }
      var notes = document.createElement("div");
      notes.className = "lm-update-release-notes";
      notes.textContent = String(release.notes || "该版本未提供更新说明。");
      card.appendChild(notes);
      list.appendChild(card);
    });
    section.hidden = false;
  }

  function renderUpdateModal(kind, result, errorMessage) {
    var modal = ensureUpdateModal();
    var title = modal.querySelector('[data-role="update-title"]');
    var copy = modal.querySelector('[data-role="update-copy"]');
    var version = modal.querySelector('[data-role="update-version"]');
    var current = modal.querySelector('[data-role="update-current"]');
    var latest = modal.querySelector('[data-role="update-latest"]');
    var meta = modal.querySelector('[data-role="update-meta"]');
    var releases = modal.querySelector('[data-role="update-releases"]');
    var warning = modal.querySelector('[data-role="update-warning"]');
    var status = modal.querySelector('[data-role="update-status"]');
    var close = modal.querySelector('[data-update-action="close"]');
    var apply = modal.querySelector('[data-update-action="apply"]');
    version.hidden = true;
    releases.hidden = true;
    warning.hidden = true;
    apply.hidden = true;
    close.hidden = false;
    close.disabled = false;
    close.textContent = "关闭";
    status.textContent = "";
    status.dataset.kind = "";
    meta.textContent = "";

    if (kind === "checking") {
      title.textContent = "检查补丁更新";
      copy.textContent = "正在连接公开发布源，请稍候……";
      close.textContent = "取消显示";
    } else if (kind === "available") {
      title.textContent = "发现补丁更新";
      copy.textContent = "检测到新的林离本地回信补丁。确认后会在本机下载并校验安装包，再启动更新程序。";
      current.textContent = "v" + result.currentVersion;
      latest.textContent = "v" + result.latestVersion;
      version.hidden = false;
      meta.textContent = updateSourceLabel(result.source) + " · " + formatUpdateBytes(result.installer && result.installer.size);
      renderUpdateReleaseNotes(modal, result);
      warning.textContent = "更新会停止本地回信服务。安装完成前请勿寄信；安装成功后需要重新启动游戏。";
      warning.hidden = false;
      close.textContent = "稍后";
      apply.hidden = false;
      apply.disabled = false;
      apply.textContent = "更新到最新版";
    } else if (kind === "current") {
      title.textContent = "补丁已是最新版本";
      copy.textContent = "当前安装的是 v" + result.currentVersion + "，公开发布源没有更高的稳定版本。";
      meta.textContent = "检查时间：" + new Date(result.checkedAt).toLocaleString();
    } else if (kind === "failed") {
      title.textContent = "检查更新失败";
      copy.textContent = "暂时无法完成补丁更新检查。现有本地回信功能不会受到影响。";
      status.textContent = errorMessage || "请稍后重试";
      status.dataset.kind = "error";
    } else if (kind === "applying") {
      title.textContent = "正在准备更新";
      copy.textContent = "正在下载安装包并进行 SHA-256 完整性校验，可能需要几分钟。请保持网络连接。";
      if (result) {
        current.textContent = "v" + result.currentVersion;
        latest.textContent = "v" + result.latestVersion;
        version.hidden = false;
      }
      warning.textContent = "校验通过前不会运行安装包。请不要关闭游戏或本地回信服务。";
      warning.hidden = false;
      close.disabled = true;
      close.textContent = "正在处理";
    } else if (kind === "launched") {
      title.textContent = "更新程序已启动";
      copy.textContent = "安装程序已经打开，本地回信服务将自动退出。请按安装程序提示完成更新，然后重新启动游戏。";
      warning.textContent = "如果安装窗口被其他窗口遮挡，请在任务栏中查找“林离本地回信”安装程序。";
      warning.hidden = false;
      status.textContent = "目标版本：v" + (result && result.version ? result.version : "");
      status.dataset.kind = "success";
    }
    modal.hidden = false;
  }

  function closeUpdateModal() {
    if (state.update.applying) return;
    var modal = document.getElementById(UPDATE_MODAL_ID);
    if (modal) modal.hidden = true;
  }

  async function checkForUpdate(manual) {
    if (state.update.checking || state.update.applying) {
      if (manual && state.update.checking) renderUpdateModal("checking");
      return;
    }
    state.update.checking = true;
    if (manual) renderUpdateModal("checking");
    try {
      var result = await callApi("/api/update/check", { params: { force: manual ? 1 : 0 } });
      state.update.result = result;
      if (result.updateAvailable) renderUpdateModal("available", result);
      else if (manual) renderUpdateModal("current", result);
    } catch (error) {
      if (manual) renderUpdateModal("failed", null, error.message);
    } finally {
      state.update.checking = false;
    }
  }

  async function applyUpdate() {
    var result = state.update.result;
    if (!result || !result.updateAvailable || state.update.applying) return;
    state.update.applying = true;
    renderUpdateModal("applying", result);
    try {
      var applied = await callApi("/api/update/apply", {
        method: "POST",
        body: { version: result.latestVersion }
      });
      state.update.applying = false;
      renderUpdateModal("launched", applied);
    } catch (error) {
      state.update.applying = false;
      renderUpdateModal("available", result);
      var modal = document.getElementById(UPDATE_MODAL_ID);
      var status = modal && modal.querySelector('[data-role="update-status"]');
      if (status) {
        status.textContent = "更新失败：" + error.message;
        status.dataset.kind = "error";
      }
    }
  }

  function findUserMenu() {
    var trigger = document.querySelector('button[aria-label="User menu"]');
    if (!trigger || !trigger.parentElement) return null;
    var menu = Array.prototype.slice.call(trigger.parentElement.children).find(function (child) {
      return child !== trigger && child.matches && child.matches("div.absolute");
    });
    if (!menu) return null;
    return { trigger: trigger, menu: menu };
  }

  function mountUpdateMenuItem() {
    if (document.getElementById(UPDATE_MENU_ITEM_ID)) return;
    var context = findUserMenu();
    if (!context) return;
    var settingsItem = Array.prototype.slice.call(context.menu.querySelectorAll("div")).find(function (item) {
      return item.textContent.trim() === "设置" && item.classList.contains("cursor-pointer");
    });
    if (!settingsItem || !settingsItem.parentElement) return;
    installStyles();
    var item = document.createElement("div");
    item.id = UPDATE_MENU_ITEM_ID;
    item.className = settingsItem.className + " lm-update-menu-item";
    item.setAttribute("role", "menuitem");
    item.innerHTML = '<span class="lm-update-menu-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 0 1-14.8 4.2"></path><path d="M4 12A8 8 0 0 1 18.8 7.8"></path><path d="m5 20 .2-3.8L9 16"></path><path d="m19 4-.2 3.8L15 8"></path></svg></span><span>检查补丁更新</span>';
    item.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      context.trigger.click();
      checkForUpdate(true);
    });
    settingsItem.insertAdjacentElement("afterend", item);
  }

  function scheduleAutomaticUpdateCheck() {
    if (state.update.autoStarted) return;
    state.update.autoStarted = true;
    window.setTimeout(function () { checkForUpdate(false); }, 8000);
  }

  function mailboxImportModalHtml() {
    return '<div class="lm-modal lm-import-dialog" role="dialog" aria-modal="true" aria-labelledby="lm-import-title">' +
      '<div class="lm-import-title-row"><div class="lm-modal-title" id="lm-import-title">导入信件</div>' +
      '<button class="lm-import-close" type="button" aria-label="关闭" data-import-action="close">×</button></div>' +
      '<div class="lm-import-description">选择导入方式。导入后的信件会保存在本机，并显示在原信箱列表中。</div>' +
      '<div class="lm-import-methods lm-import-methods-two">' +
      '<button class="lm-import-method" type="button" data-import-mode="file"><span class="lm-import-method-icon">文件</span>' +
      '<span class="lm-import-method-copy"><span class="lm-import-method-title">文件导入</span>' +
      '<span class="lm-import-method-desc">一次选择多个 JSON 或图片文件</span><span class="lm-import-method-note">JSON 可导入；图片 OCR 尚未实现</span></span></button>' +
       '<button class="lm-import-method" type="button" data-import-mode="share"><span class="lm-import-method-icon">链接</span>' +
       '<span class="lm-import-method-copy"><span class="lm-import-method-title">分享链接导入</span>' +
       '<span class="lm-import-method-desc">读取官方分享页对应的去信与回信</span><span class="lm-import-method-note">官方清理数据前可用</span></span></button>' +
       '</div>' +
       '<div class="lm-import-panel" data-import-panel="share">' +
       '<label class="lm-field"><span>信件分享链接（一个链接一行）</span><textarea class="lm-textarea lm-share-import-input" data-role="share-import-url" rows="4" autocomplete="off" spellcheck="false" placeholder="https://web-…/single-pages/letterShare.html?uid=…&shareId=…\nhttps://web-…/single-pages/letterShare.html?uid=…&shareId=…"></textarea></label>' +
       '<div class="lm-note">支持一次粘贴多个链接，也支持从 Markdown 文本中逐行识别链接。重复导入同一封信会更新现有记录。</div></div>' +
       '<div class="lm-import-panel" data-import-panel="file">' +
       '<label class="lm-field"><span>选择文件（JSON / PNG / JPG / WEBP，可多选混合）</span><input class="lm-file" type="file" accept=".json,application/json,.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" multiple data-role="file-import-files"></label>' +
       '<div class="lm-file-import-list" data-role="file-import-list"></div>' +
       '<div class="lm-note">JSON 支持单封、数组或 { "letters": [...] }；重复导入同一封信会更新原记录。图片识别尚未实现：选择图片会在结果中明确标注“未导入”，不会影响同批 JSON 的导入。</div></div>' +
       '<div class="lm-modal-actions"><span class="lm-modal-status" data-role="share-import-status">等待导入</span>' +
      '<button class="lm-button" type="button" data-import-action="close">取消</button>' +
      '<button class="lm-button lm-button-primary" type="button" data-import-action="submit">导入</button></div>' +
      '</div>';
  }

  function setMailboxImportStatus(message, kind) {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    var status = modal && modal.querySelector('[data-role="share-import-status"]');
    if (!status) return;
    status.textContent = message;
    status.dataset.kind = kind || "";
  }

  function fileImportKind(file) {
    var match = /\.(json|png|jpe?g|webp)$/i.exec(file.name || "");
    var extension = match ? match[1].toLowerCase() : "";
    if (extension === "json") return { kind: "json", label: "JSON" };
    if (extension === "png" || extension === "jpg" || extension === "jpeg" || extension === "webp") {
      return { kind: "image", label: "图片" };
    }
    return { kind: "unsupported", label: "不支持" };
  }

  function renderFileImportList() {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    var list = modal && modal.querySelector('[data-role="file-import-list"]');
    if (!list) return;
    if (!state.importFiles.length) {
      list.innerHTML = "";
      return;
    }
    list.innerHTML = state.importFiles.map(function (entry) {
      var statusHtml = entry.status
        ? '<span class="lm-file-import-status" data-kind="' + escapeHtml(entry.status) + '">' + escapeHtml(entry.message || "") + '</span>'
        : "";
      return '<div class="lm-file-import-row"><span class="lm-file-import-name">' + escapeHtml(entry.name) + '</span>' +
        '<span class="lm-file-import-kind">' + escapeHtml(entry.label) + '</span>' + statusHtml + '</div>';
    }).join("");
  }

  function setMailboxImportMode(mode) {
    state.importMode = mode === "file" ? "file" : "share";
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    if (!modal) return;
    Array.prototype.forEach.call(modal.querySelectorAll("[data-import-mode]"), function (button) {
      button.dataset.active = String(button.dataset.importMode === state.importMode);
    });
    Array.prototype.forEach.call(modal.querySelectorAll("[data-import-panel]"), function (panel) {
      panel.hidden = panel.dataset.importPanel !== state.importMode;
    });
    var submit = modal.querySelector('[data-import-action="submit"]');
    submit.hidden = false;
    submit.disabled = state.importMode === "file" && state.importFiles.length === 0;
    if (state.importMode === "share") {
      setMailboxImportStatus("等待导入", "");
    } else {
      renderFileImportList();
      setMailboxImportStatus(state.importFiles.length
        ? "已选择 " + state.importFiles.length + " 个文件（JSON 会导入，图片暂不支持）"
        : "请选择一个或多个 JSON / 图片文件", "");
    }
  }

  function closeMailboxImportModal() {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    if (modal && !state.importBusy) modal.hidden = true;
  }

  async function submitShareLinkImport() {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    if (!modal || state.importBusy || state.importMode !== "share") return;
    var input = modal.querySelector('[data-role="share-import-url"]');
    var submit = modal.querySelector('[data-import-action="submit"]');
    var rawLines = input.value.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
    if (!rawLines.length) {
      setMailboxImportStatus("请先粘贴分享链接", "error");
      input.focus();
      return;
    }
    if (rawLines.length > 50) {
      setMailboxImportStatus("单次最多导入 50 个分享链接", "error");
      return;
    }
    state.importBusy = true;
    submit.disabled = true;
    submit.textContent = "正在导入…";
    setMailboxImportStatus("正在读取官方分享数据…", "");
    try {
      var result = await callApi("/api/import/share-link", {
        method: "POST",
        body: JSON.stringify({ urls: rawLines })
      });
      var results = Array.isArray(result.results) ? result.results : [];
      var failed = results.filter(function (item) { return !item.ok; });
      var successCount = Number(result.imported || 0);
      var message = "处理完成：成功 " + successCount + " 封（新增 " + Number(result.inserted || 0) + "，更新 " + Number(result.updated || 0) + "）";
      if (failed.length) {
        var details = failed.slice(0, 4).map(function (item) { return "第 " + item.lineNumber + " 行：" + item.message; });
        if (failed.length > 4) details.push("其余失败项请检查后重试");
        message += "\n失败 " + failed.length + " 项：" + details.join("；");
        input.value = failed.map(function (item) { return rawLines[item.index]; }).join("\n");
        setMailboxImportStatus(message, successCount ? "success" : "error");
      } else {
        message += "；信箱会自动刷新。";
        input.value = "";
        setMailboxImportStatus(message, "success");
      }
      await refreshDiagnostics();
    } catch (error) {
      setMailboxImportStatus("导入失败：" + error.message, "error");
    } finally {
      state.importBusy = false;
      submit.disabled = false;
      submit.textContent = "导入";
    }
  }

  async function submitFileImport() {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    if (!modal || state.importBusy || state.importMode !== "file") return;
    var input = modal.querySelector('[data-role="file-import-files"]');
    var submit = modal.querySelector('[data-import-action="submit"]');
    if (!state.importFiles.length) {
      setMailboxImportStatus("请先选择一个或多个文件", "error");
      input.focus();
      return;
    }
    state.importBusy = true;
    submit.disabled = true;
    submit.textContent = "正在导入…";
    setMailboxImportStatus("正在读取文件…", "");
    var files = state.importFiles;
    var jsonFiles = files.filter(function (entry) { return entry.kind === "json"; });
    files.forEach(function (entry) {
      entry.status = entry.kind === "json" ? "pending" : entry.kind;
      entry.message = "";
    });
    renderFileImportList();
    try {
      var server = null;
      if (jsonFiles.length) {
        var entries = [];
        for (var i = 0; i < jsonFiles.length; i += 1) {
          entries.push({ name: jsonFiles[i].file.name, content: await jsonFiles[i].file.text() });
        }
        server = await callApi("/api/import/files", {
          method: "POST",
          body: JSON.stringify({ files: entries })
        });
      }
      if (server && Array.isArray(server.results)) {
        server.results.forEach(function (item, index) {
          var entry = jsonFiles[index];
          if (!entry) return;
          if (item.ok) {
            if (item.partial || Number(item.skipped || 0) > 0) {
              entry.status = "partial";
              entry.message = "部分导入（新增 " + Number(item.inserted || 0) + "，更新 " + Number(item.updated || 0) +
                "，跳过 " + Number(item.skipped || 0) + "）";
            } else {
              entry.status = "success";
              entry.message = "已导入（新增 " + Number(item.inserted || 0) + "，更新 " + Number(item.updated || 0) + "）";
            }
          } else {
            entry.status = "error";
            entry.message = item.message || "导入失败";
          }
        });
      }
      files.forEach(function (entry) {
        if (entry.kind === "image") {
          entry.status = "unsupported";
          entry.message = "图片识别功能尚未实现，文件未导入";
        } else if (entry.kind === "unsupported") {
          entry.status = "error";
          entry.message = "不支持的文件类型";
        }
      });
      renderFileImportList();
      var counts = server || { imported: 0, inserted: 0, updated: 0, skipped: 0, unsupported: 0, failed: 0 };
      var unsupportedCount = files.filter(function (entry) { return entry.kind === "image" || entry.kind === "unsupported"; }).length;
      var message = "处理完成：共 " + files.length + " 个文件，导入 " + Number(counts.imported || 0) + " 封（新增 " +
        Number(counts.inserted || 0) + "，更新 " + Number(counts.updated || 0) + "）";
      if (unsupportedCount) message += "，未支持 " + unsupportedCount + " 个（图片 OCR 尚未实现）";
      if (counts.failed) message += "，失败 " + counts.failed + " 个";
      if (counts.skipped) message += "，跳过 " + counts.skipped + " 封";
      message += "；信箱会自动刷新。";
      setMailboxImportStatus(message, Number(counts.failed) && !Number(counts.imported) ? "error" : "success");
      await refreshDiagnostics();
    } catch (error) {
      setMailboxImportStatus("导入失败：" + error.message, "error");
    } finally {
      state.importBusy = false;
      submit.disabled = state.importFiles.length === 0;
      submit.textContent = "导入";
    }
  }

  function bindMailboxImportModal(modal) {
    modal.addEventListener("click", function (event) {
      if (event.target === modal) { closeMailboxImportModal(); return; }
      var modeButton = event.target.closest("[data-import-mode]");
      if (modeButton) { setMailboxImportMode(modeButton.dataset.importMode); return; }
      var actionButton = event.target.closest("[data-import-action]");
      if (!actionButton) return;
      if (actionButton.dataset.importAction === "close") closeMailboxImportModal();
       else if (actionButton.dataset.importAction === "submit") {
         if (state.importMode === "file") submitFileImport();
         else submitShareLinkImport();
       }
     });
    modal.addEventListener("change", function (event) {
      if (event.target.dataset.role !== "file-import-files") return;
      state.importFiles = Array.prototype.slice.call(event.target.files || []).map(function (file) {
        var kind = fileImportKind(file);
        return { file: file, name: file.name, kind: kind.kind, label: kind.label, status: "", message: "" };
      });
      renderFileImportList();
      setMailboxImportMode("file");
    });
    modal.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && event.ctrlKey && event.target.matches('[data-role="share-import-url"]')) {
        event.preventDefault();
        submitShareLinkImport();
      } else if (event.key === "Escape") {
        closeMailboxImportModal();
      }
    });
  }

  function ensureMailboxImportModal() {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = MAILBOX_IMPORT_MODAL_ID;
    modal.className = "lm-modal-backdrop";
    modal.hidden = true;
    modal.innerHTML = mailboxImportModalHtml();
    document.body.appendChild(modal);
    bindMailboxImportModal(modal);
    setMailboxImportMode("file");
    return modal;
  }

  function openMailboxImportModal() {
    installStyles();
    var modal = ensureMailboxImportModal();
    modal.hidden = false;
    setMailboxImportMode("file");
  }

  var REMOTE_TOAST_ID = "local-mail-remote-import-toast";
  var REMOTE_ACTIVE_STATES = ["detecting", "authenticating", "fetching_letters", "fetching_details", "importing"];

  function mailboxHeader() {
    var header = document.querySelector("main .mail-header");
    return header && header.querySelector(".text-text-title.text-title-m") ? header : null;
  }

  function syncRemoteToastVisibility() {
    var toast = document.getElementById(REMOTE_TOAST_ID);
    if (!toast) return;
    toast.hidden = !mailboxHeader() || !state.remoteImport.candidate;
  }

  function remoteToastHtml() {
    return '<div class="local-mail-remote-import-title">检测到本机可能存在官方信箱历史记录</div>' +
      '<button class="local-mail-remote-import-close" type="button" aria-label="关闭" data-remote-action="close">×</button>' +
      '<div class="local-mail-remote-import-body">可以读取官方客户端的最近信箱记录并写入本地邮箱；已有视频回信会同时保存到本机供原邮箱播放。导入不占用每日写信额度，也不会自动触发模型回复；只有点击“导入历史”后才会访问官方接口。</div>' +
      '<div class="local-mail-remote-import-body" data-role="remote-local-state" hidden></div>' +
      '<div class="local-mail-remote-import-actions" data-role="remote-actions">' +
      '<button class="local-mail-remote-import-button local-mail-remote-import-button-primary" type="button" data-remote-action="start">导入历史</button>' +
      '<button class="local-mail-remote-import-button" type="button" data-remote-action="snooze">稍后</button>' +
      '<button class="local-mail-remote-import-button" type="button" data-remote-action="disable">不再提示</button>' +
      '</div>' +
      '<div class="local-mail-remote-import-status" data-role="remote-status"></div>';
  }

  function ensureRemoteImportToast() {
    var toast = document.getElementById(REMOTE_TOAST_ID);
    if (toast) return toast;
    toast = document.createElement("div");
    toast.id = REMOTE_TOAST_ID;
    toast.className = "local-mail-remote-import-toast";
    toast.hidden = true;
    toast.innerHTML = remoteToastHtml();
    document.body.appendChild(toast);
    bindRemoteImportToast(toast);
    return toast;
  }

  function setRemoteStatus(message, kind) {
    var toast = document.getElementById(REMOTE_TOAST_ID);
    var status = toast && toast.querySelector('[data-role="remote-status"]');
    if (!status) return;
    status.textContent = message;
    status.dataset.kind = kind || "";
  }

  function renderRemoteActions(mode) {
    var toast = document.getElementById(REMOTE_TOAST_ID);
    var actions = toast && toast.querySelector('[data-role="remote-actions"]');
    if (!actions) return;
    if (mode === "running") {
      actions.innerHTML = '<button class="local-mail-remote-import-button" type="button" data-remote-action="cancel">取消</button>';
    } else if (mode === "retry") {
      actions.innerHTML = '<button class="local-mail-remote-import-button local-mail-remote-import-button-primary" type="button" data-remote-action="retry">重试</button>' +
        '<button class="local-mail-remote-import-button" type="button" data-remote-action="snooze">稍后</button>' +
        '<button class="local-mail-remote-import-button" type="button" data-remote-action="disable">不再提示</button>';
    } else if (mode === "done") {
      actions.innerHTML = "";
    } else {
      actions.innerHTML = '<button class="local-mail-remote-import-button local-mail-remote-import-button-primary" type="button" data-remote-action="start">导入历史</button>' +
        '<button class="local-mail-remote-import-button" type="button" data-remote-action="snooze">稍后</button>' +
        '<button class="local-mail-remote-import-button" type="button" data-remote-action="disable">不再提示</button>';
    }
  }

  function hideRemoteToast() {
    var toast = document.getElementById(REMOTE_TOAST_ID);
    if (toast) toast.hidden = true;
  }

  function stopRemotePolling() {
    if (state.remoteImport.pollTimer) {
      window.clearInterval(state.remoteImport.pollTimer);
      state.remoteImport.pollTimer = null;
    }
  }

  async function setRemotePrompt(action) {
    try {
      await callApi("/api/remote-import/prompt", {
        method: "POST",
        body: JSON.stringify({ action: action })
      });
    } catch (error) {
      // 非阻塞：提示偏好保存失败不打断用户
    }
  }

  async function startRemoteImport() {
    var toast = document.getElementById(REMOTE_TOAST_ID);
    if (!toast || state.remoteImport.running) return;
    state.remoteImport.candidate = true;
    state.remoteImport.running = true;
    renderRemoteActions("running");
    setRemoteStatus("正在开始导入…", "");
    try {
      await callApi("/api/remote-import/start", { method: "POST", body: "{}" });
      pollRemoteStatus();
    } catch (error) {
      state.remoteImport.running = false;
      setRemoteStatus(error.message + "\n可以点击“重试”再次尝试。", "error");
      renderRemoteActions("retry");
    }
  }

  function pollRemoteStatus() {
    stopRemotePolling();
    state.remoteImport.pollTimer = window.setInterval(async function () {
      var status;
      try {
        status = await callApi("/api/remote-import/status");
      } catch (error) {
        setRemoteStatus("读取导入状态失败：" + error.message, "error");
        return;
      }
      state.remoteImport.lastStatus = status;
      if (REMOTE_ACTIVE_STATES.indexOf(status.state) !== -1) {
        var text = status.message || "正在导入…";
        if (Number.isFinite(status.percent) && status.percent > 0) text += "（" + status.percent + "%）";
        setRemoteStatus(text, "");
        return;
      }
      stopRemotePolling();
      state.remoteImport.running = false;
      if (status.state === "completed" || status.state === "partial") {
        var summary = "已导入 " + status.imported + " 封，新增 " + status.inserted + " 封，更新 " + status.updated +
          " 封，跳过 " + status.skipped + " 封，失败 " + status.failed + " 封";
        if (status.conflicts) summary += "，冲突 " + status.conflicts + " 封（本地内容已保留）";
        if (status.videoSaved) summary += "，已保存视频 " + status.videoSaved + " 个";
        if (status.videoFailed) summary += "，视频保存失败 " + status.videoFailed + " 个";
        setRemoteStatus(summary + "\n邮箱即将自动刷新…", "success");
        renderRemoteActions("done");
        window.setTimeout(function () {
          if (!mailboxHeader()) return;
          try { window.location.reload(); } catch (error) { /* 刷新失败不阻塞 */ }
        }, 4000);
      } else {
        setRemoteStatus((status.message || "导入失败。") + "\n可以点击“重试”再次尝试。", "error");
        renderRemoteActions("retry");
      }
    }, 800);
  }

  function bindRemoteImportToast(toast) {
    toast.addEventListener("click", function (event) {
      var button = event.target.closest("[data-remote-action]");
      if (!button) return;
      var action = button.dataset.remoteAction;
      if (action === "start") startRemoteImport();
      else if (action === "retry") startRemoteImport();
      else if (action === "cancel") {
        callApi("/api/remote-import/cancel", { method: "POST", body: "{}" }).catch(function () {});
        setRemoteStatus("正在取消…", "");
      } else if (action === "snooze") {
        setRemotePrompt("snooze");
        stopRemotePolling();
        state.remoteImport.running = false;
        state.remoteImport.candidate = false;
        hideRemoteToast();
      } else if (action === "disable") {
        setRemotePrompt("disable");
        stopRemotePolling();
        state.remoteImport.running = false;
        state.remoteImport.candidate = false;
        hideRemoteToast();
        state.remotePromptSettings = { promptDisabled: true };
        applyRemotePromptVisibility();
      } else if (action === "close") {
        state.remoteImport.candidate = false;
        hideRemoteToast();
      }
    });
  }

  // 把"本地已有多少封官方信件"写进小窗：官方仍未关服时，用户可能已导入过
  // 一部分；导入完成数（importedOfficialCount）与远端 found 数在任务开始/结束
  // 时都会刷新，帮助判断是否还需要再导入。foundCount 可为 null（检测阶段还没
  // 有远端数字，不额外发网络请求）。
  function setRemoteLocalState(foundCount, localCount) {
    var toast = document.getElementById(REMOTE_TOAST_ID);
    var box = toast && toast.querySelector('[data-role="remote-local-state"]');
    if (!box) return;
    var foundNumber = foundCount == null ? null : Number(foundCount);
    var localNumber = Number(localCount);
    if (!Number.isFinite(localNumber) || localNumber < 0) {
      box.hidden = true;
      box.textContent = "";
      return;
    }
    box.hidden = false;
    if (localNumber === 0) {
      box.textContent = "本地邮箱中还没有来自官方服务器的信件；下面的导入会把官方历史写入本地。";
    } else if (foundNumber != null && Number.isFinite(foundNumber) && foundNumber > 0) {
      box.textContent = "本地邮箱已有 " + localCount + " 封来自官方服务器的信件；本次检测到官方仍有 " + foundNumber + " 封可读取。重复导入同一封信会更新原记录，不会产生重复。";
    } else {
      box.textContent = "本地邮箱已有 " + localCount + " 封来自官方服务器的信件；重复导入同一封信会更新原记录，不会产生重复。";
    }
  }

  // 只在信箱页检测；网络或本地服务的瞬时失败不会锁死本次 CEF 会话，之后重新
  // 进入信箱仍可再试。候选状态与 DOM 节点分离，离开信箱时节点会立即隐藏。
  async function detectRemoteHistoryOnce() {
    if (state.remoteImport.checked || state.remoteImport.checking || Date.now() < state.remoteImport.retryAfter || !mailboxHeader()) return;
    state.remoteImport.checking = true;
    try {
      var data = await callApi("/api/remote-import/detect");
      state.remoteImport.checked = true;
      state.remoteImport.retryAfter = 0;
      state.remotePromptSettings = data.prompt || {};
      state.remoteImport.candidate = false;
      if (!data.found) return;
      var prompt = data.prompt || {};
      if (prompt.promptDisabled) return;
      if (Number(prompt.snoozedUntil) > Date.now() / 1000) return;
      if (prompt.lastSuccessAt && prompt.lastImportedAccount && prompt.lastImportedAccount === data.account) {
        var lastAt = Date.parse(prompt.lastSuccessAt);
        if (Number.isFinite(lastAt) && Date.now() - lastAt < 24 * 3600 * 1000) return;
      }
      ensureRemoteImportToast();
      renderRemoteActions("idle");
      setRemoteStatus("", "");
      // 远端 found 数要等"导入历史"真正访问官方接口才知道；检测阶段只用
      // 本地已导入数区分"从未导入"与"已导入过"，不额外发网络请求。
      var localCount = Number(data.importedOfficialCount);
      if (Number.isFinite(localCount)) {
        setRemoteLocalState(null, localCount);
      }
      state.remoteImport.candidate = true;
      syncRemoteToastVisibility();
    } catch (error) {
      // 检测失败不打扰邮箱其他功能
      state.remoteImport.checked = false;
      state.remoteImport.retryAfter = Date.now() + 5000;
    } finally {
      state.remoteImport.checking = false;
    }
  }

  function applyRemotePromptVisibility() {
    var section = document.getElementById(SECTION_ID);
    var button = section && section.querySelector('[data-action="restore-remote-prompt"]');
    if (!button) return;
    var disabled = Boolean(state.remotePromptSettings && state.remotePromptSettings.promptDisabled);
    button.hidden = !disabled;
  }

  var LETTER_STATUS_LABELS = {
    1: "等待回信",
    2: "审核中",
    3: "生成中",
    4: "已回复",
    5: "生成失败"
  };

  function lettersModalHtml() {
    return '<div class="lm-modal lm-import-dialog" role="dialog" aria-modal="true">' +
      '<div class="lm-import-title-row"><div class="lm-modal-title" data-role="letters-title">批量导出信件</div>' +
      '<button class="lm-import-close" type="button" aria-label="关闭" data-letters-action="close">×</button></div>' +
      '<div class="lm-import-description" data-role="letters-description"></div>' +
      '<div class="lm-letter-toolbar"><label class="lm-check"><input type="checkbox" data-role="letters-select-all">全选</label>' +
      '<button class="lm-button lm-button-small" type="button" data-letters-action="reload">刷新</button>' +
      '<span data-role="letters-count"></span></div>' +
      '<div class="lm-letter-list" data-role="letters-list"></div>' +
      '<div class="lm-modal-actions"><span class="lm-modal-status" data-role="letters-status"></span>' +
      '<button class="lm-button" type="button" data-letters-action="close">取消</button>' +
      '<button class="lm-button lm-button-primary" type="button" data-letters-action="submit" data-role="letters-submit">导出所选</button></div>' +
      '</div>';
  }

  function setLettersStatus(message, kind) {
    var modal = document.getElementById(LETTERS_MODAL_ID);
    var status = modal && modal.querySelector('[data-role="letters-status"]');
    if (!status) return;
    status.textContent = message;
    status.dataset.kind = kind || "";
  }

  function updateLettersCount() {
    var modal = document.getElementById(LETTERS_MODAL_ID);
    var counter = modal && modal.querySelector('[data-role="letters-count"]');
    if (!counter) return;
    var selected = Object.keys(state.lettersModal.selected).length;
    counter.textContent = "共 " + state.lettersModal.items.length + " 封 · 已选 " + selected + " 封";
  }

  function letterRowHtml(item) {
    var checked = state.lettersModal.selected[item.letterId] ? " checked" : "";
    var date = item.createdAt ? new Date(item.createdAt * 1000).toLocaleString() : "未知时间";
    return '<label class="lm-letter-row"><input type="checkbox" data-letter-id="' + escapeHtml(item.letterId) + '"' + checked + '>' +
      '<span class="lm-letter-meta"><span class="lm-letter-summary">' + escapeHtml(item.summary || item.letterId) + '</span>' +
      '<span class="lm-letter-sub">' + escapeHtml(date) + (item.isRead ? "" : " · 未读") + '</span></span>' +
      '<span class="lm-letter-status">' + escapeHtml(LETTER_STATUS_LABELS[item.letterStatus] || "未知状态") + '</span></label>';
  }

  function renderLettersList() {
    var modal = document.getElementById(LETTERS_MODAL_ID);
    var list = modal && modal.querySelector('[data-role="letters-list"]');
    if (!list) return;
    list.innerHTML = state.lettersModal.items.length
      ? state.lettersModal.items.map(letterRowHtml).join("")
      : '<div class="lm-empty">信箱里还没有信件。</div>';
    var selectAll = modal.querySelector('[data-role="letters-select-all"]');
    if (selectAll) {
      var total = state.lettersModal.items.length;
      var selected = state.lettersModal.items.filter(function (item) { return state.lettersModal.selected[item.letterId]; }).length;
      selectAll.checked = total > 0 && selected === total;
      selectAll.indeterminate = selected > 0 && selected < total;
    }
    updateLettersCount();
  }

  async function fetchAllLetters() {
    var letters = [];
    var cursor = 0;
    for (var guard = 0; guard < 50; guard += 1) {
      var page = await callApi("/letter/list", { params: { cursor: cursor, page_size: 100 } });
      var items = Array.isArray(page.list) ? page.list : [];
      letters = letters.concat(items);
      if (!page.hasMore || !items.length) break;
      cursor = page.nextCursor || cursor + items.length;
    }
    return letters;
  }

  async function reloadLettersModal() {
    setLettersStatus("正在读取信件…", "");
    try {
      state.lettersModal.items = await fetchAllLetters();
      var existing = {};
      state.lettersModal.items.forEach(function (item) { existing[item.letterId] = true; });
      Object.keys(state.lettersModal.selected).forEach(function (id) {
        if (!existing[id]) delete state.lettersModal.selected[id];
      });
      renderLettersList();
      setLettersStatus("勾选信件后执行操作。", "");
    } catch (error) {
      setLettersStatus("读取失败：" + error.message, "error");
    }
  }

  function selectedLetterIds() {
    return state.lettersModal.items
      .filter(function (item) { return state.lettersModal.selected[item.letterId]; })
      .map(function (item) { return item.letterId; });
  }

  function downloadJson(data, prefix) {
    var blob = new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" });
    var link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = prefix + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
    link.click();
    window.setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
  }

  async function submitLettersModal() {
    var modal = document.getElementById(LETTERS_MODAL_ID);
    if (!modal || state.lettersModal.busy) return;
    var ids = selectedLetterIds();
    if (!ids.length) {
      setLettersStatus("请先勾选信件。", "error");
      return;
    }
    var mode = state.lettersModal.mode;
    var submit = modal.querySelector('[data-role="letters-submit"]');
    if (mode === "delete") {
      var confirmed = window.confirm("确定删除选中的 " + ids.length + " 封信？去信、回信和生成记录会一并删除，且不可恢复。");
      if (!confirmed) return;
    }
    state.lettersModal.busy = true;
    submit.disabled = true;
    setLettersStatus(mode === "export" ? "正在导出…" : "正在删除…", "");
    try {
      if (mode === "export") {
        var exported = await callApi("/api/letters/export", {
          method: "POST",
          body: JSON.stringify({ letterIds: ids })
        });
        downloadJson(exported, "linli-letters-export");
        var message = "已导出 " + exported.exported + " 封信。";
        if (exported.missing && exported.missing.length) message += "有 " + exported.missing.length + " 封未找到，已跳过。";
        setLettersStatus(message, "success");
      } else {
        var deleted = await callApi("/api/letters/delete", {
          method: "POST",
          body: JSON.stringify({ letterIds: ids })
        });
        var deleteMessage = "已删除 " + deleted.deleted + " 封信。";
        if (deleted.missing && deleted.missing.length) deleteMessage += "有 " + deleted.missing.length + " 封未找到。";
        setLettersStatus(deleteMessage, "success");
        state.lettersModal.selected = {};
        await reloadLettersModal();
        await refreshDiagnostics();
      }
    } catch (error) {
      setLettersStatus((mode === "export" ? "导出失败：" : "删除失败：") + error.message, "error");
    } finally {
      state.lettersModal.busy = false;
      submit.disabled = false;
    }
  }

  function closeLettersModal() {
    var modal = document.getElementById(LETTERS_MODAL_ID);
    if (modal && !state.lettersModal.busy) modal.hidden = true;
  }

  function bindLettersModal(modal) {
    modal.addEventListener("click", function (event) {
      if (event.target === modal) { closeLettersModal(); return; }
      var actionButton = event.target.closest("[data-letters-action]");
      if (!actionButton) return;
      var action = actionButton.dataset.lettersAction;
      if (action === "close") closeLettersModal();
      else if (action === "reload") reloadLettersModal();
      else if (action === "submit") submitLettersModal();
    });
    modal.addEventListener("change", function (event) {
      var target = event.target;
      if (target.dataset.role === "letters-select-all") {
        state.lettersModal.items.forEach(function (item) {
          if (target.checked) state.lettersModal.selected[item.letterId] = true;
          else delete state.lettersModal.selected[item.letterId];
        });
        renderLettersList();
        return;
      }
      var letterId = target.dataset && target.dataset.letterId;
      if (letterId) {
        if (target.checked) state.lettersModal.selected[letterId] = true;
        else delete state.lettersModal.selected[letterId];
        renderLettersList();
      }
    });
    modal.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeLettersModal();
    });
  }

  function ensureLettersModal() {
    var modal = document.getElementById(LETTERS_MODAL_ID);
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = LETTERS_MODAL_ID;
    modal.className = "lm-modal-backdrop";
    modal.hidden = true;
    modal.innerHTML = lettersModalHtml();
    document.body.appendChild(modal);
    bindLettersModal(modal);
    return modal;
  }

  function openLettersModal(mode) {
    installStyles();
    var modal = ensureLettersModal();
    state.lettersModal.mode = mode === "delete" ? "delete" : "export";
    state.lettersModal.selected = {};
    modal.querySelector('[data-role="letters-title"]').textContent = state.lettersModal.mode === "delete" ? "批量删除信件" : "批量导出信件";
    modal.querySelector('[data-role="letters-description"]').textContent = state.lettersModal.mode === "delete"
      ? "勾选要删除的信件。去信、回信与生成记录会一并删除，且不可恢复；建议先在设置页“服务与数据”中导出备份。"
      : "勾选要导出的信件，会连同内部调试字段（生成状态、Provider、错误等）下载为一个 .json 文件。";
    var submit = modal.querySelector('[data-role="letters-submit"]');
    submit.textContent = state.lettersModal.mode === "delete" ? "删除所选" : "导出所选";
    submit.classList.toggle("lm-button-danger-solid", state.lettersModal.mode === "delete");
    submit.classList.toggle("lm-button-primary", state.lettersModal.mode !== "delete");
    modal.hidden = false;
    reloadLettersModal();
  }

  function mountMailboxTools() {
    var header = mailboxHeader();
    if (!header) {
      hideRemoteToast();
      return;
    }
    installStyles();
    if (!document.getElementById(MAILBOX_TOOLS_ID)) {
      var tools = document.createElement("div");
      tools.id = MAILBOX_TOOLS_ID;
      tools.className = "lm-mailbox-tools";
      tools.innerHTML =
        '<button class="lm-mailbox-import-button" type="button" data-mailbox-action="delete" hidden>删除</button>' +
        '<button class="lm-mailbox-import-button" type="button" data-mailbox-action="export" hidden>导出</button>' +
        '<button class="lm-mailbox-import-button" id="' + MAILBOX_IMPORT_BUTTON_ID + '" type="button" data-mailbox-action="import">导入</button>';
      tools.addEventListener("click", function (event) {
        var button = event.target.closest("[data-mailbox-action]");
        if (!button) return;
        if (button.dataset.mailboxAction === "import") openMailboxImportModal();
        else if (button.dataset.mailboxAction === "export") openLettersModal("export");
        else if (button.dataset.mailboxAction === "delete") openLettersModal("delete");
      });
      header.appendChild(tools);
    }
    applyMailboxDebugVisibility();
    if (state.remoteImport.candidate) syncRemoteToastVisibility();
    else detectRemoteHistoryOnce();
  }

  function applyMailboxDebugVisibility() {
    var tools = document.getElementById(MAILBOX_TOOLS_ID);
    if (!tools) return;
    Array.prototype.forEach.call(tools.querySelectorAll("[data-mailbox-action]"), function (button) {
      if (button.dataset.mailboxAction === "import") return;
      button.hidden = !state.debugMode;
    });
  }

  function sectionHtml() {
    return [
      '<div class="lm-title-row"><div class="lm-title">本地回信</div><div class="lm-badge" data-role="service-badge">连接中</div></div>',
      '<div class="lm-subtitle">由本机服务保存信件、编排林离的人设与历史，并调用所选模型生成文本回信。API Key 使用当前 Windows 用户的 DPAPI 加密。</div>',
      '<div class="lm-card">',
      '  <div class="lm-card-head"><div class="lm-card-title">模型配置</div><button class="lm-button lm-button-small" type="button" data-action="open-model-manager">模型管理</button></div>',
      '  <div class="lm-grid">',
      '    <label class="lm-field"><span>供应商</span><select class="lm-select" data-role="active-provider"></select></label>',
      '    <label class="lm-field"><span>模型</span><select class="lm-select" data-role="active-model"></select></label>',
      '  </div>',
      '  <div class="lm-advanced">',
      '    <button class="lm-advanced-toggle" type="button" data-action="toggle-advanced" aria-expanded="false">高级参数<span class="lm-advanced-arrow">▸</span></button>',
      '    <div class="lm-advanced-panel" data-role="advanced-panel" hidden>',
      '      <div class="lm-advanced-group">',
      '        <div class="lm-advanced-group-title">通用请求参数</div>',
      '        <div class="lm-advanced-group-note">带“可选”的字段留空时不会发送；不同供应商支持范围不同，不再由内置预设强行禁用。</div>',
      '        <div class="lm-parameter-grid">',
      '        <label class="lm-field"><span>思考档位</span><select class="lm-select" data-role="reasoning">',
      '          <option value="default">跟随模型默认</option><option value="none">不启用</option><option value="minimal">最少</option>',
      '          <option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">极高</option>',
      '        </select></label>',
      '        <label class="lm-field"><span>模型超时（秒）</span><input class="lm-input" type="number" min="5" max="600" required data-role="timeout-seconds"></label>',
      '        <label class="lm-field"><span>最大输出 Token</span><input class="lm-input" type="number" min="128" max="1000000" required data-role="max-output-tokens"></label>',
      '        <label class="lm-field"><span>Temperature（可选）</span><input class="lm-input" type="number" min="0" max="2" step="0.01" data-role="temperature" placeholder="留空=不发送"></label>',
      '        <label class="lm-field"><span>Top P（可选）</span><input class="lm-input" type="number" min="0" max="1" step="0.01" data-role="top-p" placeholder="留空=不发送"></label>',
      '        <label class="lm-field"><span>Top K（可选）</span><input class="lm-input" type="number" min="1" max="1000000" step="1" data-role="top-k" placeholder="留空=不发送"></label>',
      '        <label class="lm-field"><span>Min P（可选）</span><input class="lm-input" type="number" min="0" max="1" step="0.01" data-role="min-p" placeholder="留空=不发送"></label>',
      '        <label class="lm-field"><span>频率惩罚（可选）</span><input class="lm-input" type="number" min="-2" max="2" step="0.01" data-role="frequency-penalty" placeholder="留空=不发送"></label>',
      '        <label class="lm-field"><span>存在惩罚（可选）</span><input class="lm-input" type="number" min="-2" max="2" step="0.01" data-role="presence-penalty" placeholder="留空=不发送"></label>',
      '        <label class="lm-field"><span>重复惩罚（可选）</span><input class="lm-input" type="number" min="0" max="2" step="0.01" data-role="repetition-penalty" placeholder="留空=不发送"></label>',
      '        <label class="lm-field"><span>随机种子（可选）</span><input class="lm-input" type="number" min="0" max="2147483647" step="1" data-role="seed" placeholder="留空=不发送"></label>',
      '        <label class="lm-field"><span>思考预算 Token（可选）</span><input class="lm-input" type="number" min="256" max="1000000" step="1" data-role="thinking-budget" placeholder="Anthropic 通常至少 1024"></label>',
      '        <label class="lm-field"><span>输出详略（可选）</span><select class="lm-select" data-role="verbosity"><option value="default">跟随模型默认</option><option value="low">简洁</option><option value="medium">适中</option><option value="high">详细</option></select></label>',
      '        <label class="lm-check"><input type="checkbox" data-role="logprobs">请求 logprobs（供应商支持时）</label>',
      '        <label class="lm-field"><span>Top Logprobs（可选）</span><input class="lm-input" type="number" min="0" max="20" step="1" data-role="top-logprobs" placeholder="留空=不发送"></label>',
      '        <label class="lm-check"><input type="checkbox" data-role="parallel-tool-calls">允许并行工具调用（供应商支持时）</label>',
      '        </div>',
      '      </div>',
      '      <div class="lm-advanced-group">',
      '        <div class="lm-advanced-group-title">文本与供应商扩展</div>',
      '        <div class="lm-advanced-group-note">停止序列每行一个。附加参数会按所选协议合并到请求中；可用于填写供应商专用字段、模型别名或安全设置。</div>',
      '        <div class="lm-parameter-grid">',
      '          <label class="lm-field lm-parameter-wide"><span>停止序列（可选，每行一个）</span><textarea class="lm-textarea" rows="3" data-role="stop-sequences" placeholder="留空=不发送"></textarea></label>',
      '          <label class="lm-field lm-parameter-wide"><span>供应商原生附加参数 JSON（可选）</span><textarea class="lm-textarea lm-raw-json" rows="5" data-role="extra-params" spellcheck="false" placeholder="例如：{\n  &quot;service_tier&quot;: &quot;flex&quot;\n}"></textarea></label>',
      '        </div>',
      '      </div>',
      '      <div class="lm-note" data-role="param-support-note"></div>',
      '    </div>',
      '  </div>',
      '  <div class="lm-toolbar">',
      '    <div class="lm-status" data-role="model-status">正在读取本地配置…</div>',
      '    <div class="lm-actions"><button class="lm-button" type="button" data-action="test-model">测试当前模型</button><button class="lm-button lm-button-primary" type="button" data-action="save-all">保存本地回信设置</button></div>',
      '  </div>',
      '</div>',
      '<div class="lm-card">',
      '  <div class="lm-card-head"><div class="lm-card-title">服务与数据</div><div class="lm-actions"><button class="lm-button lm-button-small" type="button" data-action="refresh-diagnostics">刷新</button><button class="lm-button lm-button-small" type="button" data-action="export-backup">导出 JSON 备份</button><button class="lm-button lm-button-small" type="button" data-action="restore-remote-prompt" hidden>恢复历史导入提示</button></div></div>',
      '  <div class="lm-diagnostics" data-role="diagnostics">正在读取服务状态…</div>',
      '</div>',
      '<div class="lm-card">',
      '  <div class="lm-card-title">调试模式</div>',
      '  <label class="lm-check"><input type="checkbox" data-role="debug-mode">启用调试模式</label>',
      '  <div class="lm-note">打开后信箱页“导入”按钮左侧显示“导出”和“删除”按钮，可勾选信件后批量导出为 .json 或批量删除，并解锁下方每日写信上限调整。删除不可恢复，建议先在“服务与数据”中导出备份。开关会立即保存到本地服务。</div>',
      '  <div data-debug-only hidden>',
      '    <div class="lm-grid" style="margin-top:12px">',
      '      <label class="lm-field"><span>每日写信上限（3~99）</span><input class="lm-input" type="number" min="3" max="99" step="1" data-role="daily-letter-limit"></label>',
      '    </div>',
      '    <div class="lm-note">默认每天 3 封，恢复原版限制。写满后当天无法再寄信，次日自动恢复；只统计在本机寄出的信，导入的历史信件不占用额度。修改会立即保存，关闭调试模式后上限保持当前值但不能再调整。</div>',
      '  </div>',
      '</div>'
    ].join("");
  }

  function setStatus(role, text, kind) {
    var section = document.getElementById(SECTION_ID);
    var target = section && section.querySelector('[data-role="' + role + '"]');
    if (!target) return;
    target.textContent = text;
    target.dataset.kind = kind || "";
  }

  function providerById(id) {
    return state.config && state.config.providers.find(function (provider) { return provider.id === id; });
  }

  function modelById(provider, id) {
    return provider && provider.models.find(function (model) { return model.id === id; });
  }

  function ensureConfigShape() {
    if (!state.config) return;
    if (!state.config.generation) state.config.generation = {};
    var generation = state.config.generation;
    if (!generation.characterId) generation.characterId = "linli";
    if (!generation.memoryStrategy) generation.memoryStrategy = "relevant";
    if (generation.historyLimit == null) generation.historyLimit = 6;
    if (generation.relationshipSummary == null) generation.relationshipSummary = "";
    if (generation.timeoutMs == null) generation.timeoutMs = 120000;
    if (generation.maxOutputTokens == null) generation.maxOutputTokens = 1800;
    if (generation.temperature === undefined) generation.temperature = null;
    if (generation.topP === undefined) generation.topP = null;
    if (generation.topK === undefined) generation.topK = null;
    if (generation.minP === undefined) generation.minP = null;
    if (generation.frequencyPenalty === undefined) generation.frequencyPenalty = null;
    if (generation.presencePenalty === undefined) generation.presencePenalty = null;
    if (generation.repetitionPenalty === undefined) generation.repetitionPenalty = null;
    if (generation.seed === undefined) generation.seed = null;
    if (!Array.isArray(generation.stop)) generation.stop = [];
    if (generation.thinkingBudget === undefined) generation.thinkingBudget = null;
    if (!generation.verbosity) generation.verbosity = "default";
    if (generation.logprobs === undefined) generation.logprobs = false;
    if (generation.topLogprobs === undefined) generation.topLogprobs = null;
    if (generation.parallelToolCalls === undefined) generation.parallelToolCalls = null;
    if (!generation.extraParams || typeof generation.extraParams !== "object" || Array.isArray(generation.extraParams)) generation.extraParams = {};
    if (generation.retryOnValidation == null) generation.retryOnValidation = true;
  }

  function applyDebugVisibility() {
    var section = document.getElementById(SECTION_ID);
    if (section) {
      Array.prototype.forEach.call(section.querySelectorAll("[data-debug-card]"), function (card) {
        card.hidden = !state.debugMode;
      });
      Array.prototype.forEach.call(section.querySelectorAll("[data-debug-only]"), function (block) {
        block.hidden = !state.debugMode;
      });
      var toggle = section.querySelector('[data-role="debug-mode"]');
      if (toggle) toggle.checked = state.debugMode;
    }
    applyMailboxDebugVisibility();
  }

  function applyParamSupport() {
    var section = document.getElementById(SECTION_ID);
    if (!section || !state.config) return;
    var provider = providerById(state.config.activeProviderId);
    var model = modelById(provider, state.config.activeModelId);
    var reasoningSelect = section.querySelector('[data-role="reasoning"]');
    var maxTokensInput = section.querySelector('[data-role="max-output-tokens"]');
    var note = section.querySelector('[data-role="param-support-note"]');
    if (!reasoningSelect || !maxTokensInput || !note) return;

    Array.prototype.forEach.call(reasoningSelect.options, function (option) {
      option.disabled = false;
    });
    var selected = reasoningSelect.selectedOptions[0];
    if (selected && selected.disabled) {
      reasoningSelect.value = "default";
      state.config.reasoningEffort = "default";
    }
    maxTokensInput.max = "1000000";
    note.textContent = model
      ? "当前为完全自定义接入：通用参数会按所选协议转换；供应商不支持的字段可能被拒绝，可用附加参数 JSON 调整。"
      : "选择模型后可填写通用参数；供应商专用字段请放入附加参数 JSON。";
  }

  function syncActiveSelectors() {
    var section = document.getElementById(SECTION_ID);
    if (!section || !state.config) return;
    ensureConfigShape();
    var providerSelect = section.querySelector('[data-role="active-provider"]');
    var modelSelect = section.querySelector('[data-role="active-model"]');
    var reasoningSelect = section.querySelector('[data-role="reasoning"]');
    providerSelect.innerHTML = "";
    if (!state.config.providers.length) {
      providerSelect.appendChild(new Option("尚未接入供应商", ""));
      providerSelect.disabled = true;
      state.config.activeProviderId = null;
    } else {
      providerSelect.disabled = false;
      state.config.providers.forEach(function (provider) {
        providerSelect.appendChild(new Option(provider.name || "未命名供应商", provider.id));
      });
      if (!providerById(state.config.activeProviderId)) state.config.activeProviderId = state.config.providers[0].id;
      providerSelect.value = state.config.activeProviderId;
    }
    var activeProvider = providerById(state.config.activeProviderId);
    modelSelect.innerHTML = "";
    if (!activeProvider || !activeProvider.models.length) {
      modelSelect.appendChild(new Option("尚未添加模型", ""));
      modelSelect.disabled = true;
      state.config.activeModelId = null;
    } else {
      modelSelect.disabled = false;
      activeProvider.models.forEach(function (model) {
        modelSelect.appendChild(new Option(model.name || model.modelId || "未命名模型", model.id));
      });
      if (!modelById(activeProvider, state.config.activeModelId)) state.config.activeModelId = activeProvider.models[0].id;
      modelSelect.value = state.config.activeModelId;
    }
    reasoningSelect.value = state.config.reasoningEffort || "default";
    var generation = state.config.generation;
    function setValue(role, value) {
      var control = section.querySelector('[data-role="' + role + '"]');
      if (control) control.value = value == null ? "" : String(value);
    }
    setValue("timeout-seconds", Math.round(generation.timeoutMs / 1000));
    setValue("max-output-tokens", generation.maxOutputTokens);
    setValue("temperature", generation.temperature);
    setValue("top-p", generation.topP);
    setValue("top-k", generation.topK);
    setValue("min-p", generation.minP);
    setValue("frequency-penalty", generation.frequencyPenalty);
    setValue("presence-penalty", generation.presencePenalty);
    setValue("repetition-penalty", generation.repetitionPenalty);
    setValue("seed", generation.seed);
    setValue("thinking-budget", generation.thinkingBudget);
    setValue("verbosity", generation.verbosity);
    setValue("top-logprobs", generation.topLogprobs);
    setValue("stop-sequences", generation.stop.join("\n"));
    setValue("extra-params", Object.keys(generation.extraParams).length ? JSON.stringify(generation.extraParams, null, 2) : "");
    var logprobs = section.querySelector('[data-role="logprobs"]');
    if (logprobs) logprobs.checked = Boolean(generation.logprobs);
    var parallelToolCalls = section.querySelector('[data-role="parallel-tool-calls"]');
    if (parallelToolCalls) parallelToolCalls.checked = generation.parallelToolCalls === true;
    if (state.runtime) {
      state.debugMode = Boolean(state.runtime.debugMode);
      var dailyLimit = section.querySelector('[data-role="daily-letter-limit"]');
      if (dailyLimit && document.activeElement !== dailyLimit) {
        dailyLimit.value = state.runtime.dailyLetterLimit;
      }
    }
    applyDebugVisibility();
    applyParamSupport();
  }

  function renderDiagnostics() {
    var section = document.getElementById(SECTION_ID);
    if (!section || !state.diagnostics) return;
    var data = state.diagnostics;
    var database = data.database || {};
    var worker = data.worker || {};
    var jobs = database.jobs || {};
    section.querySelector('[data-role="service-badge"]').textContent = database.integrity === "ok" ? "服务正常" : "需要检查";
    section.querySelector('[data-role="diagnostics"]').textContent = [
      "服务版本：" + (data.serviceVersion || "未知"),
      "SQLite：" + (database.integrity || "未知") + " · 共 " + (database.letters == null ? "?" : database.letters) + " 封信",
      "生成队列：等待 " + (jobs.queued || 0) + " · 处理中 " + (jobs.running || 0) + " · 失败 " + (jobs.failed || 0),
      "工作器：" + (worker.running ? "正在处理" : "空闲") + (worker.lastError ? " · 最近错误：" + worker.lastError : "")
    ].join("\n");
  }

  var API_STYLE_LABELS = {
    "responses": "Responses（Responses API）",
    "openai-compatible": "Chat Completions（OpenAI 兼容）",
    "anthropic": "Messages（Anthropic API）",
    "gemini": "Gemini（generateContent）"
  };
  var API_STYLE_ORDER = ["responses", "anthropic", "openai-compatible", "gemini"];

  function managerItemHtml(provider) {
    var isActive = state.config && state.config.activeProviderId === provider.id;
    var isSelected = state.modal.providerId === provider.id;
    var style = API_STYLE_LABELS[provider.apiStyle] || provider.apiStyle || "未知协议";
    var meta = provider.models.length + " 个模型 · " + style;
    return '<button class="lm-provider-nav-item" type="button" data-provider-id="' + escapeHtml(provider.id) + '" data-modal-action="select-provider" data-selected="' + String(isSelected) + '">' +
      '<span class="lm-provider-nav-name-row"><span class="lm-provider-nav-name">' + escapeHtml(provider.name || "未命名供应商") + '</span>' +
      (isActive ? '<span class="lm-provider-nav-badge">使用中</span>' : '') + '</span>' +
      '<span class="lm-provider-nav-meta">' + escapeHtml(meta) + '</span></button>';
  }

  function renderManagerList() {
    var backdrop = document.getElementById("local-mail-config-modal");
    if (!backdrop || !state.config) return;
    var list = backdrop.querySelector('[data-role="manager-list"]');
    list.innerHTML = state.config.providers.length
      ? state.config.providers.map(managerItemHtml).join("")
      : '<div class="lm-provider-nav-empty">尚未接入模型服务。<br>从“添加供应商”开始。</div>';
    var addButton = backdrop.querySelector('[data-modal-action="add-provider"]');
    if (addButton) addButton.dataset.selected = String(!state.modal.providerId);
    syncActiveSelectors();
  }

  function renderModalHeading() {
    var backdrop = document.getElementById("local-mail-config-modal");
    var draft = state.modal.draft;
    if (!backdrop || !draft) return;
    var isEdit = Boolean(state.modal.providerId);
    var isActive = isEdit && state.config && state.config.activeProviderId === state.modal.providerId;
    backdrop.querySelector('[data-role="form-title"]').textContent = isEdit ? (draft.name || "未命名供应商") : "添加供应商";
    backdrop.querySelector('[data-role="form-subtitle"]').textContent = isEdit
      ? "编辑接入地址、API 格式、密钥和可用模型。"
      : "手动填写一个兼容服务，再添加可用模型。";
    backdrop.querySelector('[data-role="active-provider-badge"]').hidden = !isActive;
    backdrop.querySelector('[data-modal-action="activate-provider"]').hidden = !isEdit || isActive;
    backdrop.querySelector('[data-modal-action="delete-current-provider"]').hidden = !isEdit;
    backdrop.querySelector('[data-modal-action="save"]').textContent = isEdit ? "保存更改" : "添加供应商";
  }

  function validateProvider(provider) {
    if (!String(provider.name || "").trim()) throw new Error("Provider 名称不能为空");
    if (!String(provider.baseUrl || "").trim()) throw new Error(provider.name + " 的 API 地址不能为空");
    for (var i = 0; i < provider.models.length; i += 1) {
      var model = provider.models[i];
      if (!String(model.modelId || "").trim()) throw new Error(provider.name + " 中存在模型 ID 为空的模型");
      if (!String(model.name || "").trim()) model.name = model.modelId;
    }
  }

  function validateConfig() {
    for (var i = 0; i < state.config.providers.length; i += 1) validateProvider(state.config.providers[i]);
  }

  async function saveConfig(message) {
    try {
      validateConfig();
      setStatus("model-status", "正在保存…", "");
      var saved = await callApi("/api/model-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.config)
      });
      state.config = saved;
      renderManagerList();
      setStatus("model-status", message || "已保存到本机 SQLite。", "success");
      return true;
    } catch (error) {
      setStatus("model-status", error.message, "error");
      return false;
    }
  }

  function readNumberControl(section, role, label, optional) {
    var control = section.querySelector('[data-role="' + role + '"]');
    var raw = control ? String(control.value || "").trim() : "";
    if (!raw && optional) return null;
    if (!raw) throw new Error(label + "不能为空");
    var value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(label + "必须是数字");
    return value;
  }

  function readJsonObjectControl(section, role) {
    var control = section.querySelector('[data-role="' + role + '"]');
    var raw = control ? String(control.value || "").trim() : "";
    if (!raw) return {};
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error("供应商原生附加参数 JSON 格式错误");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("供应商原生附加参数必须是 JSON 对象");
    }
    return parsed;
  }

  function readSettingsControls() {
    var section = document.getElementById(SECTION_ID);
    if (!section || !state.config || !state.runtime) throw new Error("本地设置尚未载入");
    ensureConfigShape();
    var generation = state.config.generation;
    state.config.reasoningEffort = section.querySelector('[data-role="reasoning"]').value;
    generation.timeoutMs = readNumberControl(section, "timeout-seconds", "模型超时", false) * 1000;
    generation.maxOutputTokens = readNumberControl(section, "max-output-tokens", "最大输出 Token", false);
    generation.temperature = readNumberControl(section, "temperature", "Temperature", true);
    generation.topP = readNumberControl(section, "top-p", "Top P", true);
    generation.topK = readNumberControl(section, "top-k", "Top K", true);
    generation.minP = readNumberControl(section, "min-p", "Min P", true);
    generation.frequencyPenalty = readNumberControl(section, "frequency-penalty", "频率惩罚", true);
    generation.presencePenalty = readNumberControl(section, "presence-penalty", "存在惩罚", true);
    generation.repetitionPenalty = readNumberControl(section, "repetition-penalty", "重复惩罚", true);
    generation.seed = readNumberControl(section, "seed", "随机种子", true);
    generation.thinkingBudget = readNumberControl(section, "thinking-budget", "思考预算 Token", true);
    generation.topLogprobs = readNumberControl(section, "top-logprobs", "Top Logprobs", true);
    generation.verbosity = section.querySelector('[data-role="verbosity"]').value;
    generation.stop = section.querySelector('[data-role="stop-sequences"]').value.split(/\r?\n/).map(function (item) { return item.trim(); }).filter(Boolean);
    generation.extraParams = readJsonObjectControl(section, "extra-params");
    generation.logprobs = section.querySelector('[data-role="logprobs"]').checked;
    generation.parallelToolCalls = section.querySelector('[data-role="parallel-tool-calls"]').checked ? true : null;
    if (!state.config.activeProviderId || !state.config.activeModelId) {
      throw new Error("请先在模型管理中添加并选择供应商和模型");
    }
  }

  async function saveAllSettings(message) {
    try {
      readSettingsControls();
      validateConfig();
      setStatus("model-status", "正在保存…", "");
      state.runtime = await callApi("/api/settings", {
        method: "POST",
        body: JSON.stringify(state.runtime)
      });
      var saved = await callApi("/api/model-config", {
        method: "POST",
        body: JSON.stringify(state.config)
      });
      state.config = saved;
      renderManagerList();
      setStatus("model-status", message || "回信、记忆和模型设置已保存。", "success");
      return true;
    } catch (error) {
      setStatus("model-status", error.message, "error");
      return false;
    }
  }

  async function saveDebugMode() {
    if (!state.runtime) return;
    try {
      state.runtime = await callApi("/api/settings", {
        method: "POST",
        body: JSON.stringify(state.runtime)
      });
      state.debugMode = Boolean(state.runtime.debugMode);
      applyDebugVisibility();
      setStatus("model-status", state.debugMode
        ? "调试模式已开启：信箱页多出导出/删除按钮，并解锁每日写信上限调整。"
        : "调试模式已关闭。", "success");
    } catch (error) {
      setStatus("model-status", "调试模式保存失败：" + error.message, "error");
    }
  }

  async function saveDailyLetterLimit() {
    if (!state.runtime) return;
    try {
      state.runtime = await callApi("/api/settings", {
        method: "POST",
        body: JSON.stringify(state.runtime)
      });
      var limit = sectionQueryDailyLimit();
      if (limit) limit.value = state.runtime.dailyLetterLimit;
      setStatus("model-status", "每日写信上限已保存：每天 " + state.runtime.dailyLetterLimit + " 封。", "success");
    } catch (error) {
      setStatus("model-status", "每日上限保存失败：" + error.message, "error");
    }
  }

  function sectionQueryDailyLimit() {
    var section = document.getElementById(SECTION_ID);
    return section && section.querySelector('[data-role="daily-letter-limit"]');
  }

  async function testCurrentModel() {
    if (!await saveAllSettings("设置已保存，正在测试模型…")) return;
    setStatus("model-status", "正在请求当前模型；这不会写入邮箱…", "");
    try {
      var result = await callApi("/api/model-test", { method: "POST", body: "{}" });
      var message = "连接成功（" + result.elapsedMs + " ms）";
      if (result.warning) message += "；" + result.warning;
      if (result.preview) message += "；预览：" + result.preview.replace(/\s+/g, " ").slice(0, 120);
      setStatus("model-status", message, result.validation && !result.validation.ok ? "error" : "success");
    } catch (error) {
      setStatus("model-status", "模型测试失败：" + error.message, "error");
    }
    await refreshDiagnostics();
  }

  async function refreshDiagnostics() {
    try {
      state.diagnostics = await callApi("/api/diagnostics");
      renderDiagnostics();
    } catch (error) {
      var section = document.getElementById(SECTION_ID);
      if (section) {
        section.querySelector('[data-role="service-badge"]').textContent = "服务断开";
        section.querySelector('[data-role="diagnostics"]').textContent = error.message;
      }
    }
  }

  async function exportBackup() {
    try {
      var data = await callApi("/api/export");
      downloadJson(data, "linli-local-mail-backup");
      setStatus("model-status", "本地信件、记忆与非敏感设置已导出；API Key 不会写入备份。", "success");
    } catch (error) {
      setStatus("model-status", "导出失败：" + error.message, "error");
    }
  }

  function newDraftProvider() {
    return { id: null, name: "", apiStyle: "openai-compatible", baseUrl: "", apiKey: "", apiKeyConfigured: false, clearApiKey: false, models: [] };
  }

  function draftFromProvider(provider) {
    return {
      id: provider.id,
      name: provider.name || "",
      apiStyle: provider.apiStyle || "openai-compatible",
      baseUrl: provider.baseUrl || "",
      apiKey: provider.apiKey || "",
      apiKeyConfigured: Boolean(provider.apiKeyConfigured),
      clearApiKey: false,
      models: provider.models.map(function (model) {
        return {
          id: model.id,
          name: model.name || "",
          modelId: model.modelId || ""
        };
      })
    };
  }

  function modalHtml() {
    return '<div class="lm-modal lm-model-manager" role="dialog" aria-modal="true" aria-labelledby="lm-model-manager-title">' +
      '<div class="lm-model-manager-header"><div><div class="lm-modal-title" id="lm-model-manager-title">模型设置</div>' +
      '<div class="lm-model-manager-intro">管理模型供应商与模型列表，保存后可在设置页切换当前使用项。</div></div>' +
      '<button class="lm-button lm-button-small" type="button" data-modal-action="cancel">关闭</button></div>' +
      '<div class="lm-model-manager-body">' +
      '<aside class="lm-provider-nav"><div class="lm-provider-nav-title">供应商</div>' +
      '<div class="lm-manager-list" data-role="manager-list"></div>' +
      '<button class="lm-button lm-provider-nav-add" type="button" data-modal-action="add-provider">添加供应商</button></aside>' +
      '<section class="lm-provider-detail"><div class="lm-provider-detail-scroll">' +
      '<div class="lm-provider-detail-head"><div><div class="lm-provider-detail-title" data-role="form-title">添加供应商</div>' +
      '<div class="lm-provider-detail-subtitle" data-role="form-subtitle"></div></div>' +
      '<div class="lm-provider-detail-actions"><span class="lm-config-active" data-role="active-provider-badge" hidden>使用中</span>' +
      '<button class="lm-button lm-button-small" type="button" data-modal-action="activate-provider" hidden>设为当前</button>' +
      '<button class="lm-button lm-button-small lm-button-danger" type="button" data-modal-action="delete-current-provider" hidden>删除供应商</button></div></div>' +
      '<div class="lm-provider-section"><div class="lm-provider-grid">' +
      '<div class="lm-note lm-wide">完全自定义接入：选择接口协议、填写 Base URL 和 API Key，再手动添加模型 ID；不提供内置供应商或模型预设。</div>' +
      '<label class="lm-field"><span>供应商名称</span><input class="lm-input" data-modal-field="name" placeholder="例如：DeepSeek 或 本地 LM Studio"></label>' +
      '<label class="lm-field"><span>API 格式</span><select class="lm-select" data-modal-field="apiStyle"></select></label>' +
      '<label class="lm-field lm-wide"><span>Base URL</span><input class="lm-input" data-modal-field="baseUrl" placeholder="例如：https://api.example.com/v1"></label>' +
      '<label class="lm-field lm-wide"><span>API Key（由当前 Windows 用户的 DPAPI 加密）</span><input class="lm-input" type="password" data-modal-field="apiKey" autocomplete="off" placeholder="可留空"></label>' +
      '<label class="lm-check lm-wide" data-role="clear-key-row" hidden><input type="checkbox" data-modal-field="clearApiKey">清除已保存的 API Key</label></div></div>' +
      '<div class="lm-provider-section"><div class="lm-provider-section-head"><div><div class="lm-provider-section-title">模型列表</div>' +
      '<div class="lm-provider-section-meta" data-role="model-count"></div></div>' +
      '<button class="lm-button lm-button-small" type="button" data-modal-action="fetch-models">获取模型列表</button></div>' +
      '<div class="lm-model-list-card" data-role="modal-models"></div>' +
      '<button class="lm-button lm-button-small lm-model-add-toggle" type="button" data-modal-action="toggle-model-add">添加模型</button>' +
      '<div class="lm-model-add-panel" data-role="model-add-panel" hidden>' +
      '<div class="lm-import-row"><select class="lm-select" data-role="model-suggest"></select>' +
      '<button class="lm-button lm-button-small" type="button" data-modal-action="add-suggested">添加所选</button></div>' +
      '<div class="lm-import-row" style="margin-top:8px"><input class="lm-input" data-role="manual-model-id" placeholder="手动填写模型 ID，例如 deepseek-chat">' +
      '<input class="lm-input" data-role="manual-model-name" placeholder="显示名称（可选）">' +
      '<button class="lm-button lm-button-small" type="button" data-modal-action="add-manual">添加</button></div>' +
      '<div class="lm-note">模型列表只来自你填写的远端接口或手动输入；参数兼容性由供应商文档和附加参数 JSON 决定。</div></div></div>' +
      '</div><div class="lm-model-manager-footer"><span class="lm-modal-status" data-role="modal-status"></span>' +
      '<button class="lm-button" type="button" data-modal-action="cancel">取消</button>' +
      '<button class="lm-button lm-button-primary" type="button" data-modal-action="save">保存更改</button></div>' +
      '</section></div></div>';
  }

  function ensureModal() {
    var backdrop = document.getElementById("local-mail-config-modal");
    if (backdrop) return backdrop;
    backdrop = document.createElement("div");
    backdrop.id = "local-mail-config-modal";
    backdrop.className = "lm-modal-backdrop";
    backdrop.hidden = true;
    backdrop.innerHTML = modalHtml();
    document.body.appendChild(backdrop);
    bindModal(backdrop);
    return backdrop;
  }

  function modalStatus() {
    var backdrop = document.getElementById("local-mail-config-modal");
    return backdrop && backdrop.querySelector('[data-role="modal-status"]');
  }

  function setModalStatus(message, kind) {
    var status = modalStatus();
    if (!status) return;
    status.textContent = message;
    status.dataset.kind = kind || "";
  }

  function renderApiStyleOptions() {
    var backdrop = document.getElementById("local-mail-config-modal");
    if (!backdrop || !state.modal.draft) return;
    var draft = state.modal.draft;
    var select = backdrop.querySelector('[data-modal-field="apiStyle"]');
    var styles = API_STYLE_ORDER.slice();
    select.innerHTML = "";
    styles.forEach(function (style) {
      select.appendChild(new Option(API_STYLE_LABELS[style] || style, style));
    });
    if (styles.indexOf(draft.apiStyle) === -1) draft.apiStyle = styles[0] || "openai-compatible";
    select.value = draft.apiStyle;
  }

  function renderSuggestSelect() {
    var backdrop = document.getElementById("local-mail-config-modal");
    if (!backdrop) return;
    var select = backdrop.querySelector('[data-role="model-suggest"]');
    var addButton = backdrop.querySelector('[data-modal-action="add-suggested"]');
    select.innerHTML = "";
    if (!state.modal.suggestions.length) {
      select.appendChild(new Option("暂无可选模型；可点“获取模型列表”或手动填写", ""));
      select.disabled = true;
      addButton.disabled = true;
      return;
    }
    select.disabled = false;
    addButton.disabled = false;
    state.modal.suggestions.forEach(function (model, index) {
      select.appendChild(new Option((model.name || model.modelId || model.id) + "（" + (model.modelId || model.id) + "）", String(index)));
    });
  }

  function fillModalForm() {
    var backdrop = document.getElementById("local-mail-config-modal");
    var draft = state.modal.draft;
    if (!backdrop || !draft) return;
    renderApiStyleOptions();
    backdrop.querySelector('[data-modal-field="name"]').value = draft.name;
    backdrop.querySelector('[data-modal-field="baseUrl"]').value = draft.baseUrl;
    backdrop.querySelector('[data-modal-field="apiKey"]').value = draft.apiKey;
    backdrop.querySelector('[data-modal-field="clearApiKey"]').checked = false;
    backdrop.querySelector('[data-role="clear-key-row"]').hidden = !(state.modal.providerId && draft.apiKeyConfigured);
    renderSuggestSelect();
    renderModalHeading();
    renderModelAddPanel();
  }

  function renderModelAddPanel() {
    var backdrop = document.getElementById("local-mail-config-modal");
    if (!backdrop) return;
    var panel = backdrop.querySelector('[data-role="model-add-panel"]');
    var toggle = backdrop.querySelector('[data-modal-action="toggle-model-add"]');
    panel.hidden = !state.modal.addModelOpen;
    toggle.textContent = state.modal.addModelOpen ? "收起添加" : "添加模型";
    if (state.modal.addModelOpen) {
      window.requestAnimationFrame(function () { panel.scrollIntoView({ block: "nearest" }); });
    }
  }

  function modalModelRowsHtml() {
    var rows = state.modal.draft.models.map(function (model) {
      var isEditing = state.modal.editingModelId === model.id;
      var isActive = Boolean(state.modal.providerId && state.config.activeProviderId === state.modal.providerId && state.config.activeModelId === model.id);
      var persistedProvider = state.modal.providerId ? providerById(state.modal.providerId) : null;
      var canActivate = Boolean(persistedProvider && persistedProvider.models.some(function (item) { return item.id === model.id; }));
      if (isEditing) {
        return '<div class="lm-model-row" data-model-index="' + escapeHtml(model.id) + '"><div class="lm-model-edit-grid">' +
          '<input class="lm-input" aria-label="模型显示名称" data-model-field="name" data-model-id="' + escapeHtml(model.id) + '" value="' + escapeHtml(model.name || "") + '" placeholder="显示名称">' +
          '<input class="lm-input" aria-label="模型 ID" data-model-field="modelId" data-model-id="' + escapeHtml(model.id) + '" value="' + escapeHtml(model.modelId || "") + '" placeholder="模型 ID"></div>' +
          '<div class="lm-model-row-actions"><button class="lm-model-row-action" type="button" data-modal-action="finish-model-edit">完成</button>' +
          '<button class="lm-model-row-action lm-model-row-action-danger" type="button" data-modal-action="remove-model">移除</button></div></div>';
      }
      return '<div class="lm-model-row" data-model-index="' + escapeHtml(model.id) + '">' +
        '<div class="lm-model-row-main"><div class="lm-model-row-title"><span class="lm-model-row-name">' + escapeHtml(model.name || model.modelId) + '</span>' +
        (isActive ? '<span class="lm-model-active">当前模型</span>' : '') + '</div><div class="lm-model-row-id">' + escapeHtml(model.modelId) + '</div></div>' +
        '<div class="lm-model-row-actions">' +
        (!isActive && canActivate ? '<button class="lm-model-row-action" type="button" data-modal-action="activate-model">设为当前</button>' : '') +
        '<button class="lm-model-row-action" type="button" data-modal-action="edit-model">编辑</button>' +
        '<button class="lm-model-row-action lm-model-row-action-danger" type="button" data-modal-action="remove-model">移除</button></div></div>';
    }).join("");
    if (!rows) rows = '<div class="lm-provider-nav-empty">还没有模型。可获取远端列表，或手动添加模型 ID。</div>';
    return rows;
  }

  function renderModalModels() {
    var backdrop = document.getElementById("local-mail-config-modal");
    if (!backdrop || !state.modal.draft) return;
    backdrop.querySelector('[data-role="modal-models"]').innerHTML = modalModelRowsHtml();
    backdrop.querySelector('[data-role="model-count"]').textContent = state.modal.draft.models.length + " 个已添加模型";
  }

  function openModelManager(providerId) {
    if (!state.config) return;
    installStyles();
    var provider = providerId ? providerById(providerId) : null;
    state.modal.providerId = providerId || null;
    state.modal.draft = provider ? draftFromProvider(provider) : newDraftProvider();
    state.modal.addModelOpen = false;
    state.modal.editingModelId = null;
    state.modal.suggestions = [];
    var backdrop = ensureModal();
    renderManagerList();
    fillModalForm();
    renderModalModels();
    setModalStatus(provider && provider.apiKeyConfigured ? "已保存过 API Key；留空或保留掩码将沿用原值。" : "", "");
    backdrop.hidden = false;
  }

  function closeConfigModal() {
    var backdrop = document.getElementById("local-mail-config-modal");
    if (backdrop) backdrop.hidden = true;
    state.modal.providerId = null;
    state.modal.draft = null;
    state.modal.suggestions = [];
    state.modal.addModelOpen = false;
    state.modal.editingModelId = null;
  }

  function addModelToDraft(model) {
    var draft = state.modal.draft;
    if (!draft) return false;
    var modelId = String(model.modelId || model.id || "").trim();
    if (!modelId) return false;
    if (draft.models.some(function (item) { return item.modelId === modelId; })) return false;
    draft.models.push({
      id: createId("model"),
      name: String(model.name || "").trim() || modelId,
      modelId: modelId
    });
    return true;
  }

  async function fetchRemoteModels() {
    var backdrop = document.getElementById("local-mail-config-modal");
    var draft = state.modal.draft;
    if (!backdrop || !draft) return;
    var button = backdrop.querySelector('[data-modal-action="fetch-models"]');
    if (!String(draft.baseUrl || "").trim()) {
      setModalStatus("请先填写 API 地址。", "error");
      return;
    }
    state.modal.addModelOpen = true;
    renderModelAddPanel();
    button.disabled = true;
    setModalStatus("正在向该地址请求模型列表…", "");
    try {
      var result = await callApi("/api/models/list", {
        method: "POST",
        body: JSON.stringify({
          providerId: state.modal.providerId || undefined,
          provider: {
            apiStyle: draft.apiStyle,
            baseUrl: draft.baseUrl,
            apiKey: draft.apiKey
          }
        })
      });
      var models = Array.isArray(result.models) ? result.models : [];
      state.modal.suggestions = models.map(function (model) {
        return { modelId: model.id, name: model.name || model.id };
      });
      renderSuggestSelect();
      setModalStatus("从远端读取到 " + models.length + " 个模型，可在建议列表中选择添加。", "success");
    } catch (error) {
      setModalStatus("获取模型列表失败：" + error.message, "error");
    } finally {
      button.disabled = false;
    }
  }

  async function saveModalDraft() {
    var draft = state.modal.draft;
    if (!draft) return;
    try {
      validateProvider(draft);
      var isEdit = Boolean(state.modal.providerId);
      if (isEdit) {
        var index = state.config.providers.findIndex(function (provider) { return provider.id === state.modal.providerId; });
        if (index === -1) throw new Error("该配置已不存在，请关闭后重试。");
        draft.id = state.modal.providerId;
        state.config.providers[index] = draft;
      } else {
        draft.id = createId("provider");
        state.modal.providerId = draft.id;
        state.config.providers.push(draft);
        if (!state.config.activeProviderId) {
          state.config.activeProviderId = draft.id;
          if (draft.models.length) state.config.activeModelId = draft.models[0].id;
        }
      }
      renderManagerList();
      var saved = await saveConfig(isEdit ? "配置已更新并保存。" : "配置已添加并保存。");
      if (!saved) {
        setModalStatus("保存失败，详情见设置页状态栏，修正后可重试。", "error");
        return;
      }
      closeConfigModal();
    } catch (error) {
      setModalStatus(error.message, "error");
    }
  }

  async function removeProvider(providerId) {
    var provider = providerById(providerId);
    if (!provider) return;
    var confirmed = window.confirm('确定删除配置“' + (provider.name || "未命名供应商") + "”？此操作会立即保存。");
    if (!confirmed) return;
    state.config.providers = state.config.providers.filter(function (item) { return item.id !== providerId; });
    if (state.config.activeProviderId === providerId) {
      state.config.activeProviderId = state.config.providers[0] ? state.config.providers[0].id : null;
      state.config.activeModelId = null;
    }
    renderManagerList();
    await saveConfig("配置已删除并保存。");
    if (state.modal.providerId === providerId) {
      var nextProvider = state.config.providers[0] || null;
      openModelManager(nextProvider ? nextProvider.id : null);
    }
  }

  function bindModal(backdrop) {
    backdrop.addEventListener("input", function (event) {
      var modelField = event.target.dataset.modelField;
      if (modelField && state.modal.draft) {
        var model = state.modal.draft.models.find(function (item) { return item.id === event.target.dataset.modelId; });
        if (model) model[modelField] = event.target.value;
        return;
      }
      var field = event.target.dataset.modalField;
      if (!field || !state.modal.draft) return;
      if (field === "apiStyle") return;
      state.modal.draft[field] = event.target.type === "checkbox" ? event.target.checked : event.target.value;
      if (field === "name") renderModalHeading();
    });
    backdrop.addEventListener("change", function (event) {
      var target = event.target;
      var field = target.dataset.modalField;
      if (!field || !state.modal.draft) return;
      if (field === "apiStyle") {
        state.modal.draft.apiStyle = target.value;
      } else if (field === "clearApiKey") {
        state.modal.draft.clearApiKey = target.checked;
      }
    });
    backdrop.addEventListener("click", async function (event) {
      if (event.target === backdrop) { closeConfigModal(); return; }
      var button = event.target.closest("[data-modal-action]");
      if (!button || !state.modal.draft) return;
      var action = button.dataset.modalAction;
      var providerElement = button.closest("[data-provider-id]");
      if (action === "cancel") closeConfigModal();
      else if (action === "save") saveModalDraft();
      else if (action === "fetch-models") fetchRemoteModels();
      else if (action === "select-provider" && providerElement) openModelManager(providerElement.dataset.providerId);
      else if (action === "add-provider") openModelManager(null);
      else if (action === "delete-current-provider" && state.modal.providerId) removeProvider(state.modal.providerId);
      else if (action === "activate-provider" && state.modal.providerId) {
        state.config.activeProviderId = state.modal.providerId;
        var storedProvider = providerById(state.modal.providerId);
        if (!storedProvider) return;
        if (!storedProvider.models.some(function (model) { return model.id === state.config.activeModelId; })) {
          state.config.activeModelId = storedProvider.models[0] ? storedProvider.models[0].id : null;
        }
        var providerSaved = await saveConfig("当前供应商已更新并保存。");
        renderManagerList();
        renderModalHeading();
        renderModalModels();
        setModalStatus(providerSaved ? "已设为当前供应商并保存。" : "设置当前供应商失败，请检查设置页状态。", providerSaved ? "success" : "error");
      } else if (action === "toggle-model-add") {
        state.modal.addModelOpen = !state.modal.addModelOpen;
        renderModelAddPanel();
      } else if (action === "add-suggested") {
        var select = backdrop.querySelector('[data-role="model-suggest"]');
        var suggestion = state.modal.suggestions[Number(select.value)];
        if (!suggestion) return;
        if (addModelToDraft(suggestion)) {
          renderModalModels();
          setModalStatus("", "");
        } else {
          setModalStatus("该模型已在列表中。", "error");
        }
      } else if (action === "add-manual") {
        var idInput = backdrop.querySelector('[data-role="manual-model-id"]');
        var nameInput = backdrop.querySelector('[data-role="manual-model-name"]');
        var modelId = idInput.value.trim();
        if (!modelId) {
          setModalStatus("请先填写模型 ID。", "error");
          idInput.focus();
          return;
        }
        if (addModelToDraft({ modelId: modelId, name: nameInput.value.trim() })) {
          idInput.value = "";
          nameInput.value = "";
          renderModalModels();
          setModalStatus("", "");
        } else {
          setModalStatus("该模型已在列表中。", "error");
        }
      } else if (action === "activate-model") {
        var activeRow = button.closest("[data-model-index]");
        if (activeRow && state.modal.providerId) {
          state.config.activeProviderId = state.modal.providerId;
          state.config.activeModelId = activeRow.dataset.modelIndex;
          var modelSaved = await saveConfig("当前模型已更新并保存。");
          renderManagerList();
          renderModalHeading();
          renderModalModels();
          setModalStatus(modelSaved ? "已设为当前模型并保存。" : "设置当前模型失败，请检查设置页状态。", modelSaved ? "success" : "error");
        }
      } else if (action === "edit-model") {
        var editRow = button.closest("[data-model-index]");
        if (editRow) {
          state.modal.editingModelId = editRow.dataset.modelIndex;
          renderModalModels();
          var editContainer = Array.prototype.find.call(backdrop.querySelectorAll("[data-model-index]"), function (row) {
            return row.dataset.modelIndex === state.modal.editingModelId;
          });
          var editInput = editContainer && editContainer.querySelector("[data-model-field]");
          if (editInput) editInput.focus();
        }
      } else if (action === "finish-model-edit") {
        var editingModel = state.modal.draft.models.find(function (model) { return model.id === state.modal.editingModelId; });
        if (editingModel && !String(editingModel.modelId || "").trim()) {
          setModalStatus("模型 ID 不能为空。", "error");
          return;
        }
        if (editingModel && !String(editingModel.name || "").trim()) editingModel.name = editingModel.modelId;
        state.modal.editingModelId = null;
        renderModalModels();
        setModalStatus("", "");
      } else if (action === "remove-model") {
        var row = button.closest("[data-model-index]");
        if (row) {
          state.modal.draft.models = state.modal.draft.models.filter(function (model) { return model.id !== row.dataset.modelIndex; });
          if (state.modal.editingModelId === row.dataset.modelIndex) state.modal.editingModelId = null;
          renderModalModels();
        }
      }
    });
    backdrop.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeConfigModal();
    });
  }

  function bindSection(section) {
    section.addEventListener("change", function (event) {
      var target = event.target;
      if (target.dataset.role === "active-provider") {
        state.config.activeProviderId = target.value || null;
        state.config.activeModelId = null;
        syncActiveSelectors();
      } else if (target.dataset.role === "active-model") {
        state.config.activeModelId = target.value || null;
        applyParamSupport();
      } else if (target.dataset.role === "reasoning") {
        state.config.reasoningEffort = target.value;
      } else if (target.dataset.role === "timeout-seconds") {
        ensureConfigShape(); state.config.generation.timeoutMs = Number(target.value) * 1000;
      } else if (target.dataset.role === "max-output-tokens") {
        ensureConfigShape(); state.config.generation.maxOutputTokens = Number(target.value);
      } else if (target.dataset.role === "temperature") {
        ensureConfigShape(); state.config.generation.temperature = target.value === "" ? null : Number(target.value);
      } else if (target.dataset.role === "top-p") {
        ensureConfigShape(); state.config.generation.topP = target.value === "" ? null : Number(target.value);
      } else if (target.dataset.role === "top-k") {
        ensureConfigShape(); state.config.generation.topK = target.value === "" ? null : Number(target.value);
      } else if (target.dataset.role === "min-p") {
        ensureConfigShape(); state.config.generation.minP = target.value === "" ? null : Number(target.value);
      } else if (target.dataset.role === "frequency-penalty") {
        ensureConfigShape(); state.config.generation.frequencyPenalty = target.value === "" ? null : Number(target.value);
      } else if (target.dataset.role === "presence-penalty") {
        ensureConfigShape(); state.config.generation.presencePenalty = target.value === "" ? null : Number(target.value);
      } else if (target.dataset.role === "repetition-penalty") {
        ensureConfigShape(); state.config.generation.repetitionPenalty = target.value === "" ? null : Number(target.value);
      } else if (target.dataset.role === "seed") {
        ensureConfigShape(); state.config.generation.seed = target.value === "" ? null : Number(target.value);
      } else if (target.dataset.role === "thinking-budget") {
        ensureConfigShape(); state.config.generation.thinkingBudget = target.value === "" ? null : Number(target.value);
      } else if (target.dataset.role === "top-logprobs") {
        ensureConfigShape(); state.config.generation.topLogprobs = target.value === "" ? null : Number(target.value);
      } else if (target.dataset.role === "verbosity") {
        ensureConfigShape(); state.config.generation.verbosity = target.value;
      } else if (target.dataset.role === "logprobs") {
        ensureConfigShape(); state.config.generation.logprobs = target.checked;
      } else if (target.dataset.role === "parallel-tool-calls") {
        ensureConfigShape(); state.config.generation.parallelToolCalls = target.checked ? true : null;
      } else if (target.dataset.role === "debug-mode" && state.runtime) {
        state.debugMode = target.checked;
        state.runtime.debugMode = target.checked;
        applyDebugVisibility();
        saveDebugMode();
      } else if (target.dataset.role === "daily-letter-limit" && state.runtime) {
        var requested = Number(target.value);
        if (Number.isFinite(requested) && requested > 0) {
          state.runtime.dailyLetterLimit = Math.min(99, Math.max(3, Math.round(requested)));
          saveDailyLetterLimit();
        }
      }
    });
    section.addEventListener("click", function (event) {
      var button = event.target.closest("[data-action]");
      if (!button) return;
      var action = button.dataset.action;
      if (action === "open-model-manager") openModelManager(state.config.activeProviderId || (state.config.providers[0] && state.config.providers[0].id) || null);
      else if (action === "toggle-advanced") {
        var panel = section.querySelector('[data-role="advanced-panel"]');
        var expanded = button.getAttribute("aria-expanded") === "true";
        button.setAttribute("aria-expanded", String(!expanded));
        panel.hidden = expanded;
      }
      else if (action === "save-all") saveAllSettings();
      else if (action === "test-model") testCurrentModel();
      else if (action === "refresh-diagnostics") refreshDiagnostics();
      else if (action === "export-backup") exportBackup();
      else if (action === "restore-remote-prompt") {
        callApi("/api/remote-import/prompt", { method: "POST", body: JSON.stringify({ action: "enable" }) })
          .then(function (prompt) {
            state.remotePromptSettings = prompt;
            state.remoteImport.checked = false;
            state.remoteImport.candidate = false;
            state.remoteImport.retryAfter = 0;
            applyRemotePromptVisibility();
            setStatus("model-status", "已恢复官方历史导入提示。", "success");
            if (mailboxHeader()) detectRemoteHistoryOnce();
          })
          .catch(function (error) {
            setStatus("model-status", "恢复失败：" + error.message, "error");
          });
      }
    });
  }

  async function loadConfig() {
    try {
      var loaded = await Promise.all([
        callApi("/api/model-config"),
        callApi("/api/settings"),
        callApi("/api/diagnostics"),
        callApi("/api/remote-import/detect").catch(function () { return { found: false, prompt: {} }; })
      ]);
      state.config = loaded[0];
      state.runtime = loaded[1];
      state.diagnostics = loaded[2];
      state.remotePromptSettings = (loaded[3] && loaded[3].prompt) || {};
      state.debugMode = Boolean(state.runtime && state.runtime.debugMode);
      syncActiveSelectors();
      renderDiagnostics();
      applyRemotePromptVisibility();
      setStatus("model-status", "配置已从本机 SQLite 读取；模型调用与关系时间线已接入。", "success");
    } catch (error) {
      setStatus("model-status", "无法连接本地回信服务：" + error.message, "error");
      var section = document.getElementById(SECTION_ID);
      if (section) section.querySelector('[data-role="service-badge"]').textContent = "服务断开";
    }
  }

  function findSettingsContainer() {
    var items = Array.prototype.slice.call(document.querySelectorAll("main .tp-settings-item"));
    if (!items.length) return null;
    var first = items[0];
    return first.parentElement && first.parentElement.children.length ? first.parentElement : null;
  }

  function mountSettingsSection() {
    if (!isSettingsRoute() || document.getElementById(SECTION_ID) || state.mounting) return;
    var container = findSettingsContainer();
    if (!container) return;
    state.mounting = true;
    installStyles();
    var section = document.createElement("section");
    section.id = SECTION_ID;
    section.className = "tp-settings-item";
    section.innerHTML = sectionHtml();
    var account = Array.prototype.slice.call(container.children).find(function (child) {
      return child.querySelector && child.querySelector(".tp-settings-user-icon");
    });
    if (account && account.nextSibling) container.insertBefore(section, account.nextSibling);
    else container.insertBefore(section, container.firstChild);
    bindSection(section);
    state.mounting = false;
    loadConfig();
  }

  var mountQueued = false;
  function queueMount() {
    if (mountQueued) return;
    mountQueued = true;
    window.requestAnimationFrame(function () {
      mountQueued = false;
      hideWatermark();
      mountSettingsSection();
      mountMailboxTools();
      mountUpdateMenuItem();
      scheduleAutomaticUpdateCheck();
    });
  }

  var observer = new MutationObserver(queueMount);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("popstate", queueMount);
  window.addEventListener("hashchange", queueMount);
  if (document.head) hideWatermark();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", queueMount, { once: true });
  else queueMount();
})();
