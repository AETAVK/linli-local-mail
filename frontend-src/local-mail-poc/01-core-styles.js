(function () {
  "use strict";

  var API_BASE = "http://127.0.0.1:27149";
  var LOCAL_CAPABILITIES = Object.freeze({ mail: true, music: true, widgets: true, midi: false });
  Object.defineProperty(window, "__LINLI_LOCAL_CAPABILITIES__", {
    value: LOCAL_CAPABILITIES,
    configurable: false,
    enumerable: false,
    writable: false
  });
  var SECTION_ID = "local-mail-settings-section";
  var MAILBOX_TOOLS_ID = "local-mail-mailbox-tools";
  var MAILBOX_IMPORT_BUTTON_ID = "local-mail-mailbox-import-button";
  var MAILBOX_IMPORT_MODAL_ID = "local-mail-import-modal";
  var LETTERS_MODAL_ID = "local-mail-letters-modal";
  var PATCH_VERSION_SECTION_ID = "local-mail-patch-version-section";
  var UPDATE_MODAL_ID = "local-mail-update-modal";
  var state = {
    config: null,
    runtime: null,
    diagnostics: null,
    debugMode: false,
    mounting: false,
    importMode: "manual",
    importFiles: [],
    importDrafts: [],
    importDraftBusy: false,
    importEditingDraftId: null,
    importDraftRevision: null,
    importManualBaseline: "",
    importBusy: false,
    modal: { providerId: null, draft: null, suggestions: [], addModelOpen: false, editingModelId: null },
    lettersModal: { mode: "export", items: [], selected: {}, busy: false },
    remoteImport: { checked: false, checking: false, candidate: false, running: false, pollTimer: null, lastStatus: null, retryAfter: 0 },
    remotePromptSettings: null,
    update: { autoStarted: false, checking: false, applying: false, result: null },
    settingsSync: {
      store: null,
      unsubscribe: null,
      discoveryStarted: false,
      discoveryTimer: null,
      lastSentSignature: "",
      desired: null,
      flushing: false
    },
    desktopCommand: {
      started: false,
      timer: null,
      inFlight: false,
      lastCommandId: "",
      lastNavigatedCommandId: "",
      lastAckedCommandId: ""
    },
    music: {
      loaded: false,
      loading: false,
      playlists: [],
      activePlaylistId: null,
      playlistItems: [],
      batchMode: false,
      selected: {},
      busy: false,
      confirmSelectionClear: true,
      allowNativeTab: null,
      nativeViewName: null,
      noticeTimer: null
    }
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

  function localMusicRequest(input) {
    var request = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    var rawSong = request.song && typeof request.song === "object" && !Array.isArray(request.song)
      ? request.song
      : request;
    var itemId = request.itemId != null ? request.itemId : rawSong.itemId != null ? rawSong.itemId : rawSong.id;
    var itemType = request.itemType != null
      ? request.itemType
      : request.sourceType != null
        ? request.sourceType
        : rawSong.sourceType;
    if (itemId == null || String(itemId).trim() === "") throw new Error("本地音乐桌面请求缺少曲目编号");
    var song = Object.assign({}, rawSong);
    if (song.id == null) song.id = itemId;
    if (song.itemId == null) song.itemId = itemId;
    if (itemType != null && song.sourceType == null) song.sourceType = itemType;
    return { itemType: itemType, itemId: itemId, song: song };
  }

  function localMusicIds(input) {
    var request = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    var values;
    if (Array.isArray(input)) values = input;
    else values = request.itemIds != null
      ? request.itemIds
      : request.ids != null
        ? request.ids
        : request.itemId != null
          ? request.itemId
          : request.id;
    if (values == null && request.song && typeof request.song === "object") {
      values = request.song.itemId != null ? request.song.itemId : request.song.id;
    }
    if (!Array.isArray(values)) values = values == null ? [] : [values];
    return values.filter(function (value) { return value != null && String(value).trim() !== ""; });
  }

  function normalizeNativeMusicItem(value, fallback) {
    var raw = value && typeof value === "object" ? value : {};
    var nested = raw.item && typeof raw.item === "object" ? raw.item
      : raw.nativeItem && typeof raw.nativeItem === "object" ? raw.nativeItem
        : raw.song && typeof raw.song === "object" ? raw.song
          : raw.data && typeof raw.data === "object" ? raw.data
            : raw;
    // /api/music-desktop returns both a native-looking top-level row and the
    // original song object. Keep both layers: Rt/Mt need row metadata while
    // SongLiteItem/VideoTodViewItem need the original media fields.
    var normalized = nested !== raw ? Object.assign({}, nested, raw) : Object.assign({}, raw);
    var source = fallback && typeof fallback === "object" ? fallback : {};
    var sourceSong = source.song && typeof source.song === "object" ? source.song : source;
    var itemId = raw.itemId != null ? raw.itemId
      : raw.id != null ? raw.id
        : normalized.itemId != null ? normalized.itemId
          : normalized.id != null ? normalized.id
            : source.itemId != null ? source.itemId
              : source.id != null ? source.id
                : sourceSong.itemId != null ? sourceSong.itemId : sourceSong.id;
    if (itemId != null) {
      normalized.itemId = itemId;
      normalized.id = itemId;
    }
    var itemType = normalized.itemType != null ? normalized.itemType
      : normalized.sourceType != null ? normalized.sourceType
        : source.itemType != null ? source.itemType : source.sourceType;
    if (itemType != null) {
      if (normalized.itemType == null) normalized.itemType = itemType;
      if (normalized.sourceType == null) normalized.sourceType = itemType;
    }
    if (normalized.performanceId == null) normalized.performanceId = "";
    if (normalized.songId == null) normalized.songId = "";
    var firstValue = function (keys) {
      for (var index = 0; index < keys.length; index += 1) {
        var candidate = normalized[keys[index]];
        if (candidate != null && candidate !== "") return candidate;
      }
      return null;
    };
    var cover = firstValue(["coverUrl", "iconUrl", "cover", "icon"]);
    if (cover != null) {
      ["coverUrl", "iconUrl", "cover", "icon"].forEach(function (key) {
        if (normalized[key] == null || normalized[key] === "") normalized[key] = cover;
      });
    }
    var nameKey = firstValue(["nameKey", "songNameKey"]);
    if (nameKey != null) {
      if (normalized.nameKey == null || normalized.nameKey === "") normalized.nameKey = nameKey;
      if (normalized.songNameKey == null || normalized.songNameKey === "") normalized.songNameKey = nameKey;
    }
    if (normalized.videoUrl == null && normalized.videoURL != null) normalized.videoUrl = normalized.videoURL;
    if (normalized.audioUrl == null && normalized.audioURL != null) normalized.audioUrl = normalized.audioURL;
    if (normalized.duration == null) {
      if (normalized.videoDuration != null) normalized.duration = normalized.videoDuration;
      else if (normalized.audioDuration != null) normalized.duration = normalized.audioDuration;
    }
    return normalized;
  }

  async function localMusicAdd(input, config) {
    var request = localMusicRequest(input);
    var result = await callApi("/api/music-desktop/items", {
      method: "POST",
      body: JSON.stringify({ itemType: request.itemType, itemId: request.itemId, song: request.song }),
      signal: config && config.signal
    });
    return normalizeNativeMusicItem(result && result.item, request);
  }

  async function localMusicRemove(input, config) {
    var request = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    var itemIds = localMusicIds(input);
    if (!itemIds.length) throw new Error("本地音乐桌面移除请求缺少曲目编号");
    var itemType = request.itemType != null ? request.itemType : request.sourceType;
    if (itemType == null && request.song && typeof request.song === "object") itemType = request.song.sourceType;
    var results = [];
    for (var index = 0; index < itemIds.length; index += 1) {
      results.push(await callApi("/api/music-desktop/remove", {
        method: "POST",
        body: JSON.stringify({ itemType: itemType, itemId: itemIds[index] }),
        signal: config && config.signal
      }));
    }
    return results.length === 1 ? results[0] : results;
  }

  async function localMusicSearch(params, config) {
    var result = await callApi("/api/music-desktop", {
      params: params || {},
      signal: config && config.signal
    });
    var data = Array.isArray(result) ? { list: result } : result && typeof result === "object" ? result : {};
    var list = Array.isArray(data.list) ? data.list : Array.isArray(data.items) ? data.items : [];
    return Object.assign({}, data, {
      list: list.map(function (item) { return normalizeNativeMusicItem(item); })
    });
  }

  async function localMusicOrder(input, config) {
    return callApi("/api/music-desktop/order", {
      method: "POST",
      body: JSON.stringify(input == null ? {} : input),
      signal: config && config.signal
    });
  }

  window.__LOCAL_MUSIC_API__ = Object.freeze({
    addToPlaylist: localMusicAdd,
    removeFromPlaylist: localMusicRemove,
    searchPlaylist: localMusicSearch,
    order: localMusicOrder
  });

  function isSettingsRoute() {
    return /\/settings\/?$/.test(window.location.pathname) || /#\/settings\/?$/.test(window.location.hash);
  }

  function hideWatermark() {
    Array.prototype.forEach.call(document.querySelectorAll(".watermark-overlay"), function (node) {
      if (node.style && typeof node.style.setProperty === "function") {
        var priority = typeof node.style.getPropertyPriority === "function"
          ? node.style.getPropertyPriority("display")
          : node.style.priorities && node.style.priorities.display;
        if (node.style.getPropertyValue("display") !== "none" || priority !== "important") {
          node.style.setProperty("display", "none", "important");
        }
      } else if (node.style) {
        if (node.style.display !== "none") node.style.display = "none";
      }
    });
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
      "#" + SECTION_ID + ",#" + PATCH_VERSION_SECTION_ID + "{padding:0 0 12px;color:var(--tp-text-body,#ced2d4);color-scheme:dark}",
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
      ".lm-import-methods-three{grid-template-columns:repeat(3,minmax(0,1fr))}",
      ".lm-import-methods-four{grid-template-columns:repeat(2,minmax(0,1fr))}",
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
      ".lm-manual-import-side{padding:12px;border:1px solid rgba(255,255,255,.08);border-radius:9px;background:rgba(0,0,0,.12)}",
      ".lm-manual-import-side-head{display:flex;align-items:center;gap:8px;margin-bottom:9px;color:var(--tp-text-title,#e8e9eb);font-size:13px;font-weight:600}",
      ".lm-manual-import-side-head input{width:16px;height:16px;accent-color:#d8d1c5}",
      ".lm-manual-import-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}",
      ".lm-manual-import-grid .lm-textarea{grid-column:1/-1}",
      ".lm-draft-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:16px}",
      ".lm-draft-list{display:flex;flex-direction:column;gap:8px;margin-top:10px;max-height:250px;overflow:auto}",
      ".lm-draft-card{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:start;gap:10px;padding:10px;border:1px solid rgba(255,255,255,.08);border-radius:9px;background:rgba(0,0,0,.12)}",
      ".lm-draft-card input{width:16px;height:16px;margin-top:3px;accent-color:#d8d1c5}",
      ".lm-draft-main{min-width:0}",
      ".lm-draft-head{display:flex;align-items:center;gap:7px;color:var(--tp-text-title,#e8e9eb);font-size:12px;font-weight:600}",
      ".lm-draft-state{padding:1px 6px;border-radius:999px;background:rgba(169,217,192,.1);color:#a9d9c0;font-size:10px;font-weight:400}",
      ".lm-draft-state[data-kind='error']{background:rgba(229,170,165,.1);color:#e5aaa5}",
      ".lm-draft-meta{margin-top:3px;color:var(--tp-text-tertiary,#7d818c);font-size:11px}",
      ".lm-draft-preview{margin-top:5px;overflow:hidden;color:var(--tp-text-secondary,#a1a5ad);font-size:12px;line-height:1.4;text-overflow:ellipsis;white-space:nowrap}",
      ".lm-draft-error{margin-top:5px;color:#e5aaa5;font-size:11px;line-height:1.4}",
      ".lm-draft-actions{display:flex;gap:4px}",
      ".lm-import-dialog .lm-modal-actions{flex-wrap:wrap}",
      ".lm-import-dialog .lm-modal-status{flex:1 1 100%;margin-right:0}",
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
      ".lm-update-dialog{width:min(520px,92vw);padding:24px}",
      ".lm-update-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}",
      ".lm-update-heading .lm-modal-title{margin:0;font-size:18px}",
      ".lm-update-version{display:flex;align-items:center;gap:10px;margin:14px 0;padding:12px 14px;border:1px solid rgba(255,255,255,.09);border-radius:10px;background:rgba(0,0,0,.14)}",
      ".lm-update-version[hidden]{display:none}",
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
      "#local-mail-local-navigation{position:fixed;top:18px;left:18px;z-index:45;display:flex;align-items:center;gap:5px;padding:5px;border:1px solid rgba(255,255,255,.1);border-radius:12px;background:rgba(28,29,33,.94);box-shadow:0 8px 24px rgba(0,0,0,.24);color-scheme:dark;backdrop-filter:blur(10px);-webkit-app-region:no-drag;pointer-events:auto}",
      "#local-mail-local-navigation[hidden]{display:none!important}",
      ".lm-local-nav-button{display:flex;align-items:center;gap:6px;height:42px;padding:0 18px;border:0;border-radius:8px;background:transparent;color:var(--tp-text-secondary,#a1a5ad);font:inherit;font-size:16px;font-weight:600;cursor:pointer;white-space:nowrap;-webkit-app-region:no-drag;pointer-events:auto}",
      ".lm-local-nav-button:hover,.lm-local-nav-button[data-active='true']{background:var(--tp-surface-1,rgba(255,255,255,.07));color:var(--tp-text-title,#e8e9eb)}",
      ".lm-local-nav-button[hidden]{display:none!important}",
      ".lm-local-nav-mark{display:flex;align-items:center;justify-content:center;width:20px;height:20px;border:1px solid rgba(255,255,255,.12);border-radius:6px;background:rgba(255,255,255,.04);color:var(--tp-text-title,#e8e9eb);font-size:11px}",
      ".lm-music-toolbar{display:flex;align-items:center;justify-content:flex-end;gap:7px;margin-left:auto;min-width:0;white-space:nowrap}",
      ".lm-music-action{height:30px;padding:0 10px;border:1px solid var(--tp-grey-5,rgba(255,255,255,.22));border-radius:999px;background:transparent;color:var(--tp-text-secondary,#a1a5ad);font:inherit;font-size:12px;line-height:28px;cursor:pointer;transition:background-color .15s,color .15s,border-color .15s}",
      ".lm-music-action:hover:not(:disabled){border-color:var(--tp-grey-7,rgba(255,255,255,.42));background:var(--tp-surface-1,rgba(255,255,255,.07));color:var(--tp-text-title,#e8e9eb)}",
      ".lm-music-action-primary{border-color:rgba(216,209,197,.45);background:rgba(216,209,197,.1);color:var(--tp-text-title,#e8e9eb)}",
      ".lm-music-action:disabled{opacity:.42;cursor:not-allowed}",
      ".lm-music-selected-count{max-width:112px;overflow:hidden;color:var(--tp-text-tertiary,#7d818c);font-size:11px;text-overflow:ellipsis}",
      ".lm-music-status{position:absolute;right:0;top:34px;z-index:3;max-width:260px;color:var(--tp-text-secondary,#a1a5ad);font-size:11px;line-height:1.4;text-align:right;white-space:normal}",
      ".lm-music-status[data-kind='error']{color:#e5aaa5}",
      ".lm-music-checkbox{box-sizing:border-box;width:16px;height:16px;margin:0;accent-color:#d8d1c5;cursor:pointer;flex:0 0 auto}",
      ".lm-music-row-checkbox{display:flex;align-items:center;justify-content:center;width:20px;min-width:20px;align-self:stretch}",
      ".lm-music-header-checkbox{display:flex;align-items:center;justify-content:center;width:20px;min-width:20px}",
      ".lm-music-playlists{display:flex;align-items:center;gap:12px;min-width:0;max-width:50vw;overflow-x:auto;padding-bottom:1px}",
      ".lm-music-tab{position:relative;flex:0 0 auto;height:28px;padding:0;border:0;background:transparent;color:var(--tp-text-secondary,#a1a5ad);font:inherit;font-size:14px;font-weight:600;cursor:pointer}",
      ".lm-music-tab:hover{color:var(--tp-text-title,#e8e9eb)}",
      ".lm-music-tab[data-active='true']{color:var(--tp-text-title,#e8e9eb)}",
      ".lm-music-tab[data-active='true']::after{position:absolute;right:0;bottom:-4px;left:0;height:3px;border-radius:999px;background:#e7e1d7;content:''}",
      ".lm-music-new-playlist{display:flex;align-items:center;gap:3px;flex:0 0 auto;height:28px;padding:0 2px;border:0;background:transparent;color:var(--tp-text-secondary,#a1a5ad);font:inherit;font-size:13px;font-weight:600;cursor:pointer}",
      ".lm-music-new-playlist:hover{color:var(--tp-text-title,#e8e9eb)}",
      ".lm-music-custom-list{display:flex;flex-direction:column;gap:0;margin-right:16px}",
      ".lm-music-custom-row{display:flex;align-items:center;gap:12px;padding:12px;border-radius:10px;color:var(--tp-text-body,#ced2d4)}",
      ".lm-music-custom-row:hover{background:var(--tp-surface-1,rgba(255,255,255,.04))}",
      ".lm-music-custom-index{display:flex;align-items:center;justify-content:center;width:44px;min-width:44px;color:var(--tp-text-tertiary,#7d818c);font-size:13px}",
      ".lm-music-cover{width:48px;height:48px;overflow:hidden;border-radius:10px;background:var(--tp-grey-2,#34363c);object-fit:cover;flex:0 0 auto}",
      ".lm-music-cover-placeholder{display:flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:10px;background:var(--tp-grey-2,#34363c);color:var(--tp-text-tertiary,#7d818c);font-size:17px;flex:0 0 auto}",
      ".lm-music-song{min-width:120px;flex:1;overflow:hidden}",
      ".lm-music-song-name{overflow:hidden;color:var(--tp-text-title,#e8e9eb);font-size:15px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}",
      ".lm-music-song-meta{margin-top:3px;overflow:hidden;color:var(--tp-text-secondary,#a1a5ad);font-size:12px;text-overflow:ellipsis;white-space:nowrap}",
      ".lm-music-mode{width:80px;min-width:80px;color:var(--tp-text-secondary,#a1a5ad);font-size:13px}",
      ".lm-music-row-add{height:28px;padding:0 9px;border:0;border-radius:7px;background:transparent;color:var(--tp-text-secondary,#a1a5ad);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}",
      ".lm-music-row-add:hover:not(:disabled){background:rgba(255,255,255,.07);color:var(--tp-text-title,#e8e9eb)}",
      ".lm-music-row-add:disabled{opacity:.45;cursor:not-allowed}",
      ".lm-music-row-remove{height:28px;padding:0 9px;border:0;border-radius:7px;background:transparent;color:var(--tp-text-secondary,#a1a5ad);font:inherit;font-size:12px;cursor:pointer}",
      ".lm-music-row-remove:hover{background:rgba(255,255,255,.07);color:#e5aaa5}",
      ".lm-music-empty{display:flex;min-height:180px;align-items:center;justify-content:center;color:var(--tp-text-secondary,#a1a5ad);font-size:14px}",
      ".lm-music-dialog{width:min(460px,92vw);padding:24px}",
      ".lm-music-dialog-copy{margin-bottom:14px;color:var(--tp-text-secondary,#a1a5ad);font-size:13px;line-height:1.55}",
      ".lm-music-playlist-picker{display:flex;flex-direction:column;gap:8px;max-height:280px;overflow:auto}",
      ".lm-music-playlist-choice{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:11px 13px;border:1px solid rgba(255,255,255,.1);border-radius:9px;background:rgba(0,0,0,.1);color:var(--tp-text-body,#ced2d4);font:inherit;text-align:left;cursor:pointer}",
      ".lm-music-playlist-choice:hover{background:rgba(255,255,255,.07)}",
      ".lm-music-playlist-choice[data-selected='true']{border-color:rgba(216,209,197,.42);background:rgba(216,209,197,.09)}",
      ".lm-music-playlist-choice-meta{color:var(--tp-text-tertiary,#7d818c);font-size:11px;white-space:nowrap}",
      ".lm-music-confirm-check{display:flex;align-items:center;gap:8px;margin-top:14px;color:var(--tp-text-secondary,#a1a5ad);font-size:12px;cursor:pointer}",
      ".lm-music-confirm-check input{width:16px;height:16px;accent-color:#d8d1c5}",
      ".lm-music-switch{display:flex;align-items:center;flex:0 0 auto;width:42px;height:24px}",
      ".lm-music-switch input{width:42px;height:24px;margin:0;appearance:none;border:1px solid rgba(255,255,255,.16);border-radius:999px;background:var(--tp-grey-3,#45474e);cursor:pointer;transition:background-color .16s,border-color .16s}",
      ".lm-music-switch input::after{display:block;width:18px;height:18px;margin:2px;border-radius:50%;background:#f1eee8;content:'';transition:transform .16s}",
      ".lm-music-switch input:checked{border-color:#e7e1d7;background:#d8d1c5}",
      ".lm-music-switch input:checked::after{transform:translateX(18px);background:#2b2926}",
      ".lm-desktop-preference-status{margin-left:8px;color:var(--tp-text-secondary,#a1a5ad);font-size:12px;font-weight:400;white-space:nowrap}",
      "@media(max-width:900px){.lm-grid,.lm-provider-grid,.lm-parameter-grid{grid-template-columns:1fr}.lm-provider-grid .lm-wide,.lm-parameter-wide{grid-column:auto}.lm-toolbar{align-items:flex-start;flex-direction:column}.lm-config-item{flex-direction:column;align-items:flex-start}.lm-import-methods{grid-template-columns:1fr}.lm-model-manager-body{grid-template-columns:210px minmax(0,1fr)}.lm-provider-detail-scroll{padding:18px}.lm-model-edit-grid{grid-template-columns:1fr}}",
      "@media(max-width:680px){#local-mail-local-navigation{top:10px}.lm-modal.lm-model-manager{height:90vh}.lm-model-manager-body{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}.lm-provider-nav{max-height:190px;border-right:0;border-bottom:1px solid rgba(255,255,255,.09)}.lm-provider-detail-head{flex-direction:column}.lm-provider-detail-actions{justify-content:flex-start}}"
    ].join("");
    document.head.appendChild(style);
  }
