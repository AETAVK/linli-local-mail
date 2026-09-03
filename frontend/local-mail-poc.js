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
      ".lm-import-backdrop{overflow:auto}",
      ".lm-import-workspace{display:grid;grid-template-columns:minmax(0,620px) minmax(320px,390px);align-items:stretch;gap:14px;width:min(1024px,calc(100vw - 48px));max-height:86vh}",
      ".lm-import-workspace>.lm-modal{box-sizing:border-box;margin:0}",
      ".lm-import-dialog{width:auto;max-height:86vh;padding:24px}",
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
      ".lm-import-queue-dialog{width:auto;max-height:86vh;min-height:0;overflow:hidden;padding:0;display:flex;flex-direction:column}",
      ".lm-import-queue-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:20px 18px 14px;border-bottom:1px solid rgba(255,255,255,.08)}",
      ".lm-import-queue-heading{min-width:0}",
      ".lm-import-queue-header .lm-modal-title{margin:0;font-size:18px}",
      ".lm-import-queue-description{margin-top:5px;color:var(--tp-text-tertiary,#7d818c);font-size:11px;line-height:1.45}",
      ".lm-import-queue-header .lm-status{flex:0 0 auto;padding-top:3px;white-space:nowrap}",
      ".lm-import-queue-dialog .lm-draft-list{flex:1;min-height:0;max-height:none;margin:0;padding:14px 16px;overflow:auto}",
      ".lm-import-queue-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding:14px 16px;border-top:1px solid rgba(255,255,255,.08)}",
      ".lm-import-queue-select-all{margin:0 auto 0 0}",
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
      "@media(max-width:1100px){.lm-import-backdrop{align-items:flex-start}.lm-import-workspace{grid-template-columns:1fr;width:min(680px,calc(100vw - 48px));max-height:none}.lm-import-dialog,.lm-import-queue-dialog{width:100%;max-height:none}.lm-import-queue-dialog{min-height:280px}.lm-import-queue-dialog .lm-draft-list{max-height:40vh}}",
      "@media(max-width:900px){.lm-grid,.lm-provider-grid,.lm-parameter-grid{grid-template-columns:1fr}.lm-provider-grid .lm-wide,.lm-parameter-wide{grid-column:auto}.lm-toolbar{align-items:flex-start;flex-direction:column}.lm-config-item{flex-direction:column;align-items:flex-start}.lm-import-methods{grid-template-columns:1fr}.lm-model-manager-body{grid-template-columns:210px minmax(0,1fr)}.lm-provider-detail-scroll{padding:18px}.lm-model-edit-grid{grid-template-columns:1fr}}",
      "@media(max-width:680px){#local-mail-local-navigation{top:10px}.lm-modal.lm-model-manager{height:90vh}.lm-model-manager-body{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}.lm-provider-nav{max-height:190px;border-right:0;border-bottom:1px solid rgba(255,255,255,.09)}.lm-provider-detail-head{flex-direction:column}.lm-provider-detail-actions{justify-content:flex-start}}"
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
    current.textContent = "";
    latest.textContent = "";
    version.hidden = true;
    releases.querySelector('[data-role="update-release-list"]').textContent = "";
    releases.hidden = true;
    warning.textContent = "";
    warning.hidden = true;
    status.textContent = "";
    status.dataset.kind = "";
    meta.textContent = "";
    apply.hidden = true;
    apply.disabled = false;
    apply.textContent = "更新到最新版";
    close.hidden = false;
    close.disabled = false;
    close.textContent = "关闭";

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
      var deferred = Boolean(result && (result.deferred || result.scheduled));
      title.textContent = deferred ? "更新已准备" : "更新程序已启动";
      copy.textContent = deferred
        ? "更新已准备，完全退出游戏后会自动安装。"
        : "安装程序已经打开，本地回信服务将自动退出。请按安装程序提示完成更新，然后重新启动游戏。";
      warning.textContent = deferred
        ? "请完全退出游戏；退出后更新程序会自动安装准备好的版本。"
        : "如果安装窗口被其他窗口遮挡，请在任务栏中查找“林离本地回信”安装程序。";
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

  function scheduleAutomaticUpdateCheck() {
    if (state.update.autoStarted) return;
    state.update.autoStarted = true;
    window.setTimeout(function () { checkForUpdate(false); }, 8000);
  }

  function mailboxImportModalHtml() {
    return '<div class="lm-import-workspace">' +
      '<div class="lm-modal lm-import-dialog" role="dialog" aria-modal="true" aria-labelledby="lm-import-title">' +
      '<div class="lm-import-title-row"><div class="lm-modal-title" id="lm-import-title">导入信件</div>' +
      '<button class="lm-import-close" type="button" aria-label="关闭" data-import-action="close">×</button></div>' +
      '<div class="lm-import-description">选择导入方式。导入后的信件会保存在本机，并显示在原信箱列表中。</div>' +
      '<div class="lm-import-methods lm-import-methods-four">' +
      '<button class="lm-import-method" type="button" data-import-mode="manual"><span class="lm-import-method-icon">文字</span>' +
      '<span class="lm-import-method-copy"><span class="lm-import-method-title">文字录入</span>' +
      '<span class="lm-import-method-desc">手动填写去信或回信，并保存为待导入草稿</span><span class="lm-import-method-note">默认方式，可稍后批量导入</span></span></button>' +
      '<button class="lm-import-method" type="button" data-import-mode="official"><span class="lm-import-method-icon">官方</span>' +
      '<span class="lm-import-method-copy"><span class="lm-import-method-title">一键导入官方历史</span>' +
      '<span class="lm-import-method-desc">直接读取官方服务器的全部信箱记录并导入</span><span class="lm-import-method-note">官方关服前可用；需本机官方客户端登录过</span></span></button>' +
      '<button class="lm-import-method" type="button" data-import-mode="file"><span class="lm-import-method-icon">文件</span>' +
      '<span class="lm-import-method-copy"><span class="lm-import-method-title">文件导入</span>' +
      '<span class="lm-import-method-desc">一次选择多个 JSON 或图片文件</span><span class="lm-import-method-note">JSON 可导入；图片 OCR 尚未实现</span></span></button>' +
       '<button class="lm-import-method" type="button" data-import-mode="share"><span class="lm-import-method-icon">链接</span>' +
       '<span class="lm-import-method-copy"><span class="lm-import-method-title">分享链接导入</span>' +
       '<span class="lm-import-method-desc">读取官方分享页对应的去信与回信</span><span class="lm-import-method-note">官方清理数据前可用</span></span></button>' +
       '</div>' +
       '<div class="lm-import-panel" data-import-panel="official">' +
       '<div class="lm-note" data-role="official-import-state">未检测到可用的官方登录状态时此方式不可用；检测与导入都只使用本机官方客户端日志中的会话，不占用每日写信额度，也不会触发模型回复。重复导入同一封信会更新现有记录。</div></div>' +
       '<div class="lm-import-panel" data-import-panel="share">' +
       '<label class="lm-field"><span>信件分享链接（一个链接一行）</span><textarea class="lm-textarea lm-share-import-input" data-role="share-import-url" rows="4" autocomplete="off" spellcheck="false" placeholder="https://web-…/single-pages/letterShare.html?uid=…&shareId=…\nhttps://web-…/single-pages/letterShare.html?uid=…&shareId=…"></textarea></label>' +
       '<div class="lm-note">支持一次粘贴多个链接，也支持从 Markdown 文本中逐行识别链接。重复导入同一封信会更新现有记录。</div></div>' +
       '<div class="lm-import-panel" data-import-panel="file">' +
       '<label class="lm-field"><span>选择文件（JSON / PNG / JPG / WEBP，可多选混合）</span><input class="lm-file" type="file" accept=".json,application/json,.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" multiple data-role="file-import-files"></label>' +
       '<div class="lm-file-import-list" data-role="file-import-list"></div>' +
       '<div class="lm-note">JSON 支持单封、数组或 { "letters": [...] }；重复导入同一封信会更新原记录。图片识别尚未实现：选择图片会在结果中明确标注“未导入”，不会影响同批 JSON 的导入。</div></div>' +
       '<div class="lm-import-panel" data-import-panel="manual">' +
       '<div class="lm-manual-import-grid">' +
       '<section class="lm-manual-import-side"><label class="lm-manual-import-side-head"><input type="checkbox" data-role="manual-sent-enabled">去信</label>' +
       '<label class="lm-field"><span>正文</span><textarea class="lm-textarea" data-role="manual-sent-text" rows="5" placeholder="可选：填写去信内容"></textarea></label>' +
       '<div class="lm-manual-import-grid"><label class="lm-field"><span>日期</span><input class="lm-input" type="date" data-role="manual-sent-date"></label>' +
       '<label class="lm-field"><span>时间（可选）</span><input class="lm-input" type="time" data-role="manual-sent-time"></label></div></section>' +
       '<section class="lm-manual-import-side"><label class="lm-manual-import-side-head"><input type="checkbox" data-role="manual-reply-enabled">来信</label>' +
       '<label class="lm-field"><span>正文</span><textarea class="lm-textarea" data-role="manual-reply-text" rows="5" placeholder="可选：填写来信内容"></textarea></label>' +
       '<div class="lm-manual-import-grid"><label class="lm-field"><span>日期</span><input class="lm-input" type="date" data-role="manual-reply-date"></label>' +
       '<label class="lm-field"><span>时间（可选）</span><input class="lm-input" type="time" data-role="manual-reply-time"></label></div></section>' +
       '</div><div class="lm-note">至少启用一侧并填写非空正文。去信启用时必须填写去信日期；仅录入来信时必须填写来信日期。同时录入去信和来信时，来信日期可留空表示未知。</div>' +
       '</div>' +
       '<div class="lm-modal-actions"><span class="lm-modal-status" data-role="share-import-status">等待导入</span>' +
       '<button class="lm-button" type="button" data-import-action="close">取消</button>' +
       '<button class="lm-button lm-button-primary" type="button" data-import-action="submit">加入待导入</button></div>' +
       '</div>' +
       '<section class="lm-modal lm-import-queue-dialog" role="region" aria-labelledby="lm-import-queue-title">' +
       '<div class="lm-import-queue-header"><div class="lm-import-queue-heading">' +
       '<div class="lm-modal-title" id="lm-import-queue-title">待导入队列</div>' +
       '<div class="lm-import-queue-description">选择草稿后可批量导入或删除</div></div>' +
       '<span class="lm-status" data-role="draft-queue-status">正在读取…</span></div>' +
       '<div class="lm-draft-list" data-role="draft-list"></div>' +
       '<div class="lm-import-queue-actions">' +
       '<label class="lm-check lm-import-queue-select-all"><input type="checkbox" data-role="draft-select-all" disabled>全选</label>' +
       '<button class="lm-button" type="button" data-import-action="delete-drafts" disabled>删除所选</button>' +
       '<button class="lm-button lm-button-primary" type="button" data-import-action="commit-drafts" disabled>导入所选（0）</button>' +
       '</div></section></div>';
  }

  function setMailboxImportStatus(message, kind) {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    var status = modal && modal.querySelector('[data-role="share-import-status"]');
    if (!status) return;
    status.textContent = message;
    status.dataset.kind = kind || "";
  }

  function manualImportField(modal, role) {
    return modal && modal.querySelector('[data-role="' + role + '"]');
  }

  function manualImportSnapshot(modal) {
    if (!modal) return "";
    return JSON.stringify({
      sentEnabled: Boolean(manualImportField(modal, "manual-sent-enabled") && manualImportField(modal, "manual-sent-enabled").checked),
      sentText: String((manualImportField(modal, "manual-sent-text") || {}).value || ""),
      sentDate: String((manualImportField(modal, "manual-sent-date") || {}).value || ""),
      sentTime: String((manualImportField(modal, "manual-sent-time") || {}).value || ""),
      replyEnabled: Boolean(manualImportField(modal, "manual-reply-enabled") && manualImportField(modal, "manual-reply-enabled").checked),
      replyText: String((manualImportField(modal, "manual-reply-text") || {}).value || ""),
      replyDate: String((manualImportField(modal, "manual-reply-date") || {}).value || ""),
      replyTime: String((manualImportField(modal, "manual-reply-time") || {}).value || "")
    });
  }

  function manualImportHasUnsavedData(modal) {
    var snapshot = manualImportSnapshot(modal);
    if (!snapshot) return false;
    if (snapshot === state.importManualBaseline) return false;
    if (state.importEditingDraftId) return true;
    var values = JSON.parse(snapshot);
    return values.sentEnabled || values.sentText.trim() || values.sentDate || values.sentTime ||
      values.replyEnabled || values.replyText.trim() || values.replyDate || values.replyTime;
  }

  function manualImportSection(modal, side) {
    var enabled = manualImportField(modal, "manual-" + side + "-enabled");
    var text = manualImportField(modal, "manual-" + side + "-text");
    var date = manualImportField(modal, "manual-" + side + "-date");
    var time = manualImportField(modal, "manual-" + side + "-time");
    var available = Boolean(enabled && enabled.checked);
    var dateValue = available && date && date.value ? String(date.value) : null;
    var timeValue = available && time && time.value ? String(time.value) : null;
    return {
      available: available,
      text: available ? String(text && text.value || "").trim() : "",
      date: dateValue,
      time: timeValue,
      precision: dateValue ? (timeValue ? "minute" : "date") : null
    };
  }

  function readManualImportDraft(modal) {
    return { sent: manualImportSection(modal, "sent"), reply: manualImportSection(modal, "reply") };
  }

  function validateManualImportDraft(draft) {
    var sent = draft.sent;
    var reply = draft.reply;
    if ((!sent.available || !sent.text.trim()) && (!reply.available || !reply.text.trim())) return "请至少启用去信或回信，并填写非空正文";
    if (sent.available && !sent.text.trim()) return "去信已启用，请填写去信正文";
    if (reply.available && !reply.text.trim()) return "来信已启用，请填写来信正文";
    if (sent.available && !/^\d{4}-\d{2}-\d{2}$/.test(sent.date)) return "去信启用时必须填写去信日期";
    if (!sent.available && reply.available && !/^\d{4}-\d{2}-\d{2}$/.test(reply.date)) return "仅录入来信时必须填写来信日期";
    if (sent.available && sent.time && !sent.date || reply.available && reply.time && !reply.date) return "填写时间前必须先填写对应日期";
    if (sent.available && reply.available && sent.date && reply.date) {
      if (reply.date < sent.date) return "来信日期不能早于去信日期";
      if (reply.date === sent.date && sent.time && reply.time && reply.time < sent.time) return "同一天的来信时间不能早于去信时间";
    }
    return "";
  }

  function syncManualImportSideControls(modal) {
    ["sent", "reply"].forEach(function (side) {
      var enabled = manualImportField(modal, "manual-" + side + "-enabled");
      ["text", "date", "time"].forEach(function (kind) {
        var field = manualImportField(modal, "manual-" + side + "-" + kind);
        if (field) field.disabled = !enabled || !enabled.checked || state.importBusy;
      });
    });
  }

  function setManualImportForm(modal, draft) {
    var value = draft || { sent: {}, reply: {} };
    ["sent", "reply"].forEach(function (side) {
      var section = value[side] || {};
      var enabled = manualImportField(modal, "manual-" + side + "-enabled");
      var text = manualImportField(modal, "manual-" + side + "-text");
      var date = manualImportField(modal, "manual-" + side + "-date");
      var time = manualImportField(modal, "manual-" + side + "-time");
      if (enabled) enabled.checked = Boolean(section.available);
      if (text) text.value = String(section.text || "");
      if (date) date.value = String(section.date || "");
      if (time) time.value = String(section.time || "");
    });
    syncManualImportSideControls(modal);
    state.importManualBaseline = manualImportSnapshot(modal);
  }

  function setImportModalBusy(modal, busy) {
    if (!modal) return;
    Array.prototype.forEach.call(modal.querySelectorAll("button, input, textarea"), function (node) {
      node.disabled = Boolean(busy) || (node.dataset.role && /manual-(sent|reply)-(text|date|time)/.test(node.dataset.role) && !(manualImportField(modal, node.dataset.role.replace(/-(text|date|time)$/, "-enabled")) || {}).checked);
    });
    if (!busy) syncManualImportSideControls(modal);
  }

  function draftSelectedIds(modal) {
    return Array.prototype.map.call(modal.querySelectorAll('[data-role="draft-select"]'), function (input) {
      return input.checked ? input.dataset.draftId : null;
    }).filter(Boolean);
  }

  function draftSectionDate(draft) {
    var sent = draft && draft.sent || {};
    var reply = draft && draft.reply || {};
    var parts = [];
    if (sent.available) parts.push("去信 " + (sent.date || "日期未知") + (sent.time ? " " + sent.time : ""));
    if (reply.available) parts.push("来信 " + (reply.date || "时间未知") + (reply.time ? " " + reply.time : ""));
    return parts.join(" · ") || "日期未填写";
  }

  function draftPreview(draft) {
    var parts = [];
    if (draft && draft.sent && draft.sent.available && draft.sent.text) parts.push("去信：" + draft.sent.text);
    if (draft && draft.reply && draft.reply.available && draft.reply.text) parts.push("来信：" + draft.reply.text);
    return parts.join(" · ") || "暂无正文";
  }

  function draftSourceLabel(draft) {
    var sourceType = String(draft && (draft.sourceType || draft.source) || "manual-entry");
    return sourceType === "manual-entry" || sourceType === "manual" || sourceType === "手动" ? "文字录入" : sourceType;
  }

  function draftStatusLabel(draft) {
    return String(draft && draft.status || "ready") === "error" ? "需修正" : "待导入";
  }

  function renderImportDraftQueue() {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    var list = modal && modal.querySelector('[data-role="draft-list"]');
    var status = modal && modal.querySelector('[data-role="draft-queue-status"]');
    if (!list) return;
    var drafts = Array.isArray(state.importDrafts) ? state.importDrafts : [];
    if (status) status.textContent = drafts.length ? drafts.length + " 条草稿" : "暂无草稿";
    list.innerHTML = drafts.length ? drafts.map(function (draft) {
      var error = draft.lastError || draft.error || draft.errorMessage || draft.message;
      return '<article class="lm-draft-card"><input type="checkbox" data-role="draft-select" data-draft-id="' + escapeHtml(draft.draftId || draft.id || "") + '">' +
        '<div class="lm-draft-main"><div class="lm-draft-head"><span>' + escapeHtml(draftSourceLabel(draft)) + '</span><span class="lm-draft-state" data-kind="' + (draft.status === "error" ? "error" : "ready") + '">' + escapeHtml(draftStatusLabel(draft)) + '</span></div>' +
        '<div class="lm-draft-meta">' + escapeHtml(draftSectionDate(draft)) + '</div>' +
        '<div class="lm-draft-meta">草稿编号：' + escapeHtml(draft.draftId || draft.id || "未知") + '</div>' +
        '<div class="lm-draft-preview">' + escapeHtml(draftPreview(draft)) + '</div>' +
        (error ? '<div class="lm-draft-error">' + escapeHtml(error) + '</div>' : "") + '</div>' +
        '<div class="lm-draft-actions"><button class="lm-button lm-button-small" type="button" data-import-action="edit-draft" data-draft-id="' + escapeHtml(draft.draftId || draft.id || "") + '">编辑</button></div></article>';
    }).join("") : '<div class="lm-empty">待导入队列为空</div>';
    updateDraftQueueActions(modal);
  }

  function updateDraftQueueActions(modal) {
    if (!modal) return;
    var ids = draftSelectedIds(modal);
    var selections = modal.querySelectorAll('[data-role="draft-select"]');
    var selectAll = modal.querySelector('[data-role="draft-select-all"]');
    var commit = modal.querySelector('[data-import-action="commit-drafts"]');
    var remove = modal.querySelector('[data-import-action="delete-drafts"]');
    if (selectAll) {
      selectAll.checked = selections.length > 0 && ids.length === selections.length;
      selectAll.indeterminate = ids.length > 0 && ids.length < selections.length;
      selectAll.disabled = state.importDraftBusy || selections.length === 0;
    }
    if (commit) { commit.disabled = state.importDraftBusy || !ids.length; commit.textContent = "导入所选（" + ids.length + "）"; }
    if (remove) remove.disabled = state.importDraftBusy || !ids.length;
  }

  async function loadImportDrafts() {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    var status = modal && modal.querySelector('[data-role="draft-queue-status"]');
    if (status) status.textContent = "正在读取…";
    try {
      var data = await callApi("/api/import-drafts");
      state.importDrafts = Array.isArray(data && data.drafts) ? data.drafts : [];
      renderImportDraftQueue();
    } catch (error) {
      state.importDrafts = [];
      renderImportDraftQueue();
      if (status) status.textContent = "读取失败：" + (error && error.message ? error.message : "未知错误");
    }
  }

  async function submitManualImport() {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    if (!modal || state.importBusy || state.importMode !== "manual") return;
    var draft = readManualImportDraft(modal);
    var validation = validateManualImportDraft(draft);
    if (validation) { setMailboxImportStatus(validation, "error"); return; }
    var editing = state.importEditingDraftId;
    state.importBusy = true;
    setImportModalBusy(modal, true);
    setMailboxImportStatus(editing ? "正在保存修改…" : "正在加入待导入队列…", "");
    try {
      var result = await callApi(editing ? "/api/import-drafts/update" : "/api/import-drafts/create", {
        method: "POST",
        body: editing ? { draftId: editing, revision: state.importDraftRevision, sent: draft.sent, reply: draft.reply } : { sent: draft.sent, reply: draft.reply }
      });
      state.importEditingDraftId = null;
      state.importDraftRevision = null;
      setManualImportForm(modal, null);
      setMailboxImportStatus(editing ? "修改已保存" : "已加入待导入队列", "success");
      await loadImportDrafts();
      return result;
    } catch (error) {
      setMailboxImportStatus((editing ? "保存失败：" : "加入失败：") + error.message, "error");
    } finally {
      state.importBusy = false;
      setImportModalBusy(modal, false);
      renderManualImportControls(modal);
    }
  }

  async function deleteSelectedImportDrafts() {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    var ids = draftSelectedIds(modal);
    if (!modal || !ids.length || state.importDraftBusy) return;
    if (!window.confirm("确定删除选中的 " + ids.length + " 条待导入草稿？")) return;
    state.importDraftBusy = true;
    setImportModalBusy(modal, true);
    try {
      await callApi("/api/import-drafts/delete", { method: "POST", body: { draftIds: ids } });
      if (ids.indexOf(String(state.importEditingDraftId || "")) !== -1) {
        state.importEditingDraftId = null;
        state.importDraftRevision = null;
        setManualImportForm(modal, null);
      }
      await loadImportDrafts();
      setMailboxImportStatus("已删除选中的草稿", "success");
    } catch (error) {
      setMailboxImportStatus("删除失败：" + error.message, "error");
    } finally {
      state.importDraftBusy = false;
      setImportModalBusy(modal, false);
      updateDraftQueueActions(modal);
    }
  }

  function commitSuccessCount(result, requested) {
    var failed = Number(result && (result.failed != null ? result.failed : result.failedCount));
    if (result && Array.isArray(result.results)) {
      failed = result.results.filter(function (item) { return !item.ok; }).length;
      return result.results.filter(function (item) { return item.ok; }).length;
    }
    if (result && Array.isArray(result.items)) {
      failed = result.items.filter(function (item) { return !item.ok; }).length;
      return result.items.filter(function (item) { return item.ok; }).length;
    }
    if (!Number.isFinite(failed)) failed = 0;
    var count = Number(result && (result.committed != null ? result.committed : result.imported != null ? result.imported : result.successful));
    return Number.isFinite(count) ? count : failed ? 0 : requested;
  }

  async function commitSelectedImportDrafts() {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    var ids = draftSelectedIds(modal);
    if (!modal || !ids.length || state.importDraftBusy) return;
    if (state.importMode === "manual" && manualImportHasUnsavedData(modal)) {
      setMailboxImportStatus("请先保存或清空当前文字录入内容，再导入队列中的草稿。", "error");
      return;
    }
    state.importDraftBusy = true;
    setImportModalBusy(modal, true);
    setMailboxImportStatus("正在导入所选草稿…", "");
    try {
      var result = await callApi("/api/import-drafts/commit", { method: "POST", body: { draftIds: ids } });
      var successCount = commitSuccessCount(result, ids.length);
      var successfulIds = result && Array.isArray(result.results)
        ? result.results.filter(function (item) { return item.ok; }).map(function (item) { return String(item.draftId || ""); })
        : successCount === ids.length ? ids : [];
      if (successfulIds.indexOf(String(state.importEditingDraftId || "")) !== -1) {
        state.importEditingDraftId = null;
        state.importDraftRevision = null;
        setManualImportForm(modal, null);
      }
      await loadImportDrafts();
      if (successCount > 0) {
        setMailboxImportStatus("导入完成：成功 " + successCount + " 条" + (successCount < ids.length ? "，失败项仍保留在队列中" : "") + "。", successCount < ids.length ? "error" : "success");
        await refreshDiagnostics();
        if (mailboxHeader()) {
          try { window.location.reload(); } catch (error) { /* 刷新失败不阻塞 */ }
        }
      } else {
        setMailboxImportStatus("导入失败：失败项仍保留在队列中，请编辑后重试。", "error");
      }
    } catch (error) {
      setMailboxImportStatus("导入失败：" + error.message + "。草稿仍保留在队列中。", "error");
      await loadImportDrafts();
    } finally {
      state.importDraftBusy = false;
      setImportModalBusy(modal, false);
      updateDraftQueueActions(modal);
    }
  }

  function editImportDraft(draftId) {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    var draft = (state.importDrafts || []).find(function (item) { return String(item.draftId || item.id) === String(draftId); });
    if (!modal || !draft || state.importBusy || state.importDraftBusy) return;
    if (state.importMode === "manual" && manualImportHasUnsavedData(modal) &&
      !window.confirm("当前文字录入内容尚未保存，切换编辑会丢失这些修改，确定继续吗？")) return;
    state.importEditingDraftId = draft.draftId || draft.id;
    state.importDraftRevision = draft.revision;
    setManualImportForm(modal, draft);
    setMailboxImportMode("manual");
    setMailboxImportStatus("正在编辑草稿，可保存修改或取消编辑。", "");
    renderManualImportControls(modal);
  }

  function renderManualImportControls(modal) {
    if (!modal) return;
    var submit = modal.querySelector('[data-import-action="submit"]');
    var draftActions = modal.querySelectorAll('[data-import-action="delete-drafts"], [data-import-action="commit-drafts"]');
    var isManual = state.importMode === "manual";
    if (submit) {
      submit.textContent = isManual
        ? (state.importEditingDraftId ? "保存修改" : "加入待导入")
        : state.importMode === "official" ? "一键导入" : "导入";
      submit.hidden = false;
      submit.disabled = state.importBusy;
    }
    Array.prototype.forEach.call(draftActions, function (button) { button.hidden = !isManual; });
    syncManualImportSideControls(modal);
    updateDraftQueueActions(modal);
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
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    if (!modal) return;
    var requestedMode = mode === "manual" ? "manual" : mode === "file" ? "file" : mode === "official" ? "official" : "share";
    if (state.importMode === "manual" && requestedMode !== "manual" && manualImportHasUnsavedData(modal)) {
      if (!window.confirm("切换导入方式会丢失尚未保存的文字录入内容，确定继续吗？")) return;
      setManualImportForm(modal, null);
      state.importEditingDraftId = null;
      state.importDraftRevision = null;
    }
    state.importMode = requestedMode;
    Array.prototype.forEach.call(modal.querySelectorAll("[data-import-mode]"), function (button) {
      button.dataset.active = String(button.dataset.importMode === state.importMode);
    });
    Array.prototype.forEach.call(modal.querySelectorAll("[data-import-panel]"), function (panel) {
      panel.hidden = panel.dataset.importPanel !== state.importMode;
    });
    var submit = modal.querySelector('[data-import-action="submit"]');
    var status = modal.querySelector('[data-role="official-import-state"]');
    renderManualImportControls(modal);
    if (state.importMode === "manual") {
      setMailboxImportStatus(state.importEditingDraftId ? "正在编辑草稿" : "填写后加入待导入队列", "");
      return;
    }
    if (state.importMode === "official") {
      // 一键导入没有额外输入：按钮文案与状态提示都在此设置，检测不阻塞选择
      submit.textContent = "一键导入";
      submit.disabled = state.importBusy;
      setMailboxImportStatus(state.importBusy ? "导入进行中…" : "点击“一键导入”后才会访问官方接口", "");
      if (status) {
        refreshOfficialImportState(status);
      }
      return;
    }
    submit.textContent = "导入";
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

  // 本地只读检测（无网络请求）：更新官方面板的可用性提示
  async function refreshOfficialImportState(statusBox) {
    try {
      var data = await callApi("/api/remote-import/detect");
      var prompt = data.prompt || {};
      var disabled = prompt.promptDisabled || Number(prompt.snoozedUntil) > Date.now() / 1000;
      if (!data.found) {
        statusBox.textContent = "当前未检测到可用的官方登录状态（" + (data.message || data.code || "未找到凭证") + "）。请先启动官方游戏并登录，再回到此页面。";
        return;
      }
      var localCount = Number(data.importedOfficialCount);
      var line = "已检测到官方登录状态（账户 " + (data.account || "未知") + "），可以一键导入。";
      if (Number.isFinite(localCount) && localCount > 0) {
        line += "本地已有 " + localCount + " 封官方信件，重复导入会更新原记录。";
      }
      if (disabled) line += "（提示已按你的选择关闭，不影响手动导入。）";
      statusBox.textContent = line;
    } catch (error) {
      statusBox.textContent = "本地服务检测失败：" + (error && error.message ? error.message : "未知错误") + "。请确认本地服务已启动。";
    }
  }

  async function startOfficialOneClickImport() {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    if (!modal || state.importBusy) return;
    var submit = modal.querySelector('[data-import-action="submit"]');
    state.importBusy = true;
    submit.disabled = true;
    submit.textContent = "导入中…";
    setMailboxImportStatus("正在开始官方导入…", "");
    try {
      await callApi("/api/remote-import/start", { method: "POST", body: "{}" });
      // 复用小窗的轮询；完成后结果会写回弹窗状态行
      await pollOfficialImportInModal();
    } catch (error) {
      setMailboxImportStatus("导入失败：" + (error && error.message ? error.message : "未知错误") + "\n可以稍后重试。", "error");
      state.importBusy = false;
      submit.disabled = false;
      submit.textContent = "一键导入";
    }
  }

  function pollOfficialImportInModal() {
    return new Promise(function (resolve) {
      var timer = window.setInterval(async function () {
        var status;
        try {
          status = await callApi("/api/remote-import/status");
        } catch (error) {
          return; // 瞬时失败继续轮询
        }
        if (REMOTE_ACTIVE_STATES.indexOf(status.state) !== -1) {
          var text = status.message || "正在导入…";
          if (Number.isFinite(status.percent) && status.percent > 0) text += "（" + status.percent + "%）";
          setMailboxImportStatus(text, "");
          return;
        }
        window.clearInterval(timer);
        var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
        var submit = modal && modal.querySelector('[data-import-action="submit"]');
        if (submit) {
          submit.disabled = false;
          submit.textContent = "一键导入";
        }
        state.importBusy = false;
        if (status.state === "completed" || status.state === "partial") {
          var summary = "导入完成：新增 " + status.inserted + " 封，更新 " + status.updated + " 封";
          if (status.conflicts) summary += "，重复 " + status.conflicts + " 封（本地已有，内容已保留）";
          if (status.failed) summary += "，失败 " + status.failed + " 封";
          if (status.videoSaved) summary += "，已保存视频 " + status.videoSaved + " 个";
          setMailboxImportStatus(summary + "。信箱即将自动刷新…", Number(status.failed) && !Number(status.imported) ? "error" : "success");
          window.setTimeout(function () {
            if (!mailboxHeader()) return;
            try { window.location.reload(); } catch (error) { /* 刷新失败不阻塞 */ }
          }, 3500);
        } else {
          setMailboxImportStatus((status.message || "导入失败。") + "\n可以稍后重试。", "error");
        }
        resolve(status);
      }, 800);
    });
  }

  function closeMailboxImportModal() {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    if (!modal || state.importBusy || state.importDraftBusy) return;
    if (state.importMode === "manual" && manualImportHasUnsavedData(modal) && !window.confirm("尚未保存的文字录入内容会丢失，确定关闭吗？")) return;
    if (state.importMode === "manual") {
      state.importEditingDraftId = null;
      state.importDraftRevision = null;
      setManualImportForm(modal, null);
    }
    modal.hidden = true;
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
      if (event.target === modal || event.target === modal.querySelector(".lm-import-workspace")) { closeMailboxImportModal(); return; }
      var modeButton = event.target.closest("[data-import-mode]");
      if (modeButton) { setMailboxImportMode(modeButton.dataset.importMode); return; }
      var actionButton = event.target.closest("[data-import-action]");
      if (!actionButton) return;
      if (actionButton.dataset.importAction === "close") closeMailboxImportModal();
       else if (actionButton.dataset.importAction === "delete-drafts") deleteSelectedImportDrafts();
       else if (actionButton.dataset.importAction === "commit-drafts") commitSelectedImportDrafts();
       else if (actionButton.dataset.importAction === "edit-draft") editImportDraft(actionButton.dataset.draftId);
       else if (actionButton.dataset.importAction === "submit") {
         if (state.importMode === "file") submitFileImport();
         else if (state.importMode === "official") startOfficialOneClickImport();
         else if (state.importMode === "share") submitShareLinkImport();
         else submitManualImport();
       }
     });
    modal.addEventListener("input", function (event) {
      if (event.target.dataset && /^manual-(sent|reply)-/.test(event.target.dataset.role || "")) {
        if (event.target.dataset.role.indexOf("enabled") !== -1) syncManualImportSideControls(modal);
        if (state.importMode === "manual") renderManualImportControls(modal);
      }
    });
    modal.addEventListener("change", function (event) {
      if (event.target.dataset.role === "draft-select-all") {
        Array.prototype.forEach.call(modal.querySelectorAll('[data-role="draft-select"]'), function (input) {
          input.checked = event.target.checked;
        });
        updateDraftQueueActions(modal);
        return;
      }
      if (event.target.dataset.role === "draft-select") { updateDraftQueueActions(modal); return; }
      if (/^manual-(sent|reply)-enabled$/.test(event.target.dataset.role || "")) {
        syncManualImportSideControls(modal);
        return;
      }
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
    modal.className = "lm-modal-backdrop lm-import-backdrop";
    modal.hidden = true;
    modal.innerHTML = mailboxImportModalHtml();
    document.body.appendChild(modal);
    bindMailboxImportModal(modal);
    setMailboxImportMode("manual");
    return modal;
  }

  function openMailboxImportModal() {
    installStyles();
    var modal = ensureMailboxImportModal();
    modal.hidden = false;
    setMailboxImportMode("manual");
    loadImportDrafts();
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
        if (status.conflicts) summary += "，重复 " + status.conflicts + " 封（本地已有，内容已保留）";
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
      ? "勾选要删除的信件。去信、回信与生成记录会一并删除，且不可恢复；如需保留这些信件，请先在信箱页使用“导出”按钮导出所选信件。"
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

  function formatServiceVersion(value) {
    var text = String(value == null ? "" : value).trim();
    if (!text) return "未知";
    return /^v/i.test(text) ? text : "v" + text;
  }

  function patchVersionSectionHtml() {
    return '<div class="lm-card lm-patch-version-card">' +
      '<div class="lm-card-head"><div class="lm-card-title">补丁版本</div>' +
      '<div class="lm-actions"><span class="lm-patch-version" data-role="service-version">正在读取…</span>' +
      '<button class="lm-button lm-button-small" type="button" data-action="check-update">检查更新</button></div></div>' +
      '<div class="lm-note">当前本地回信服务版本；点击“检查更新”后会查询公开发布源。</div>' +
      '</div>';
  }

  function renderPatchVersion(value) {
    var section = document.getElementById(PATCH_VERSION_SECTION_ID);
    var version = section && section.querySelector('[data-role="service-version"]');
    if (version) version.textContent = formatServiceVersion(value);
  }

  function bindPatchVersionSection(section) {
    if (!section || section.dataset.updateBound === "true") return;
    var button = section.querySelector('[data-action="check-update"]');
    if (!button) return;
    section.dataset.updateBound = "true";
    button.addEventListener("click", function () { checkForUpdate(true); });
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
      '  <div class="lm-card-title">调试模式</div>',
      '  <label class="lm-check"><input type="checkbox" data-role="debug-mode">启用调试模式</label>',
      '  <div class="lm-note">打开后信箱页“导入”按钮左侧显示“导出”和“删除”按钮，可勾选信件后批量导出为 .json 或批量删除，并解锁下方每日写信上限调整。删除不可恢复；如需保留信件，请先在信箱页使用“导出”按钮导出所选信件。开关会立即保存到本地服务。</div>',
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
    if (!state.diagnostics) return;
    var data = state.diagnostics;
    var database = data.database || {};
    var badge = section && section.querySelector('[data-role="service-badge"]');
    if (badge) badge.textContent = database.integrity === "ok" ? "服务正常" : "需要检查";
    renderPatchVersion(data.serviceVersion);
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
      var badge = section && section.querySelector('[data-role="service-badge"]');
      if (badge) badge.textContent = "服务断开";
      renderPatchVersion(null);
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
      syncOfficialSettingsStore();
      syncActiveSelectors();
      renderDiagnostics();
      setStatus("model-status", "配置已从本机 SQLite 读取；模型调用与关系时间线已接入。", "success");
    } catch (error) {
      setStatus("model-status", "无法连接本地回信服务：" + error.message, "error");
      var section = document.getElementById(SECTION_ID);
      var badge = section && section.querySelector('[data-role="service-badge"]');
      if (badge) badge.textContent = "服务断开";
      renderPatchVersion(null);
    }
  }

  function findSettingsContainer() {
    var items = Array.prototype.slice.call(document.querySelectorAll("main .tp-settings-item"));
    if (!items.length) return null;
    var first = items[0];
    return first.parentElement && first.parentElement.children.length ? first.parentElement : null;
  }

  function mountSettingsSection() {
    if (!isSettingsRoute() || state.mounting) return;
    var container = findSettingsContainer();
    if (!container) return;
    var localSection = document.getElementById(SECTION_ID);
    var patchSection = document.getElementById(PATCH_VERSION_SECTION_ID);
    if (localSection && patchSection) return;
    state.mounting = true;
    installStyles();
    var createdLocal = false;
    if (!localSection) {
      localSection = document.createElement("section");
      localSection.id = SECTION_ID;
      localSection.className = "tp-settings-item";
      localSection.innerHTML = sectionHtml();
      var account = Array.prototype.slice.call(container.children).find(function (child) {
        return child.querySelector && child.querySelector(".tp-settings-user-icon");
      });
      if (account && account.nextSibling) container.insertBefore(localSection, account.nextSibling);
      else container.insertBefore(localSection, container.firstChild);
      bindSection(localSection);
      createdLocal = true;
    }
    if (!patchSection) {
      patchSection = document.createElement("section");
      patchSection.id = PATCH_VERSION_SECTION_ID;
      patchSection.className = "tp-settings-item";
      patchSection.innerHTML = patchVersionSectionHtml();
    }
    bindPatchVersionSection(patchSection);
    container.insertBefore(patchSection, localSection);
    state.mounting = false;
    if (createdLocal) loadConfig();
    else if (state.diagnostics) renderDiagnostics();
  }

  var LOCAL_NAVIGATION_ID = "local-mail-local-navigation";
  var LOCAL_NAVIGATION_ROUTES = Object.freeze({ mail: "/collection", music: "/studio" });

  function localVueApp() {
    var appRoot = document.getElementById("app");
    return appRoot && appRoot.__vue_app__ ? appRoot.__vue_app__ : null;
  }

  function localAppGlobalProperties() {
    var app = localVueApp();
    return app && app.config && app.config.globalProperties ? app.config.globalProperties : null;
  }

  var DESKTOP_COMMAND_ROUTES = Object.freeze({ mail: "/collection", music: "/studio" });
  var DESKTOP_COMMAND_POLL_INTERVAL_MS = 1000;
  var SETTINGS_STORE_IDS = Object.freeze(["settings", "setting", "user-settings", "app-settings"]);

  function hasOwn(object, key) {
    return Boolean(object && Object.prototype.hasOwnProperty.call(object, key));
  }

  function localVueRouter() {
    if (window.__LINLI_VUE_ROUTER__) return window.__LINLI_VUE_ROUTER__;
    var globals = localAppGlobalProperties();
    return globals && globals.$router ? globals.$router : null;
  }

  function piniaLike(value) {
    return Boolean(value && typeof value === "object" && (value._s || value.state));
  }

  function findOfficialPinia() {
    var app = localVueApp();
    var globals = localAppGlobalProperties();
    var provides = app && app._context && app._context.provides;
    var candidates = [
      globals && globals.$pinia,
      provides && provides.pinia,
      window.__pinia,
      window.__PINIA__
    ];
    if (provides && typeof provides === "object") {
      Object.keys(provides).forEach(function (key) { candidates.push(provides[key]); });
      if (typeof Object.getOwnPropertySymbols === "function") {
        Object.getOwnPropertySymbols(provides).forEach(function (key) { candidates.push(provides[key]); });
      }
    }
    for (var index = 0; index < candidates.length; index += 1) {
      if (piniaLike(candidates[index])) return candidates[index];
    }
    return null;
  }

  function piniaStoreEntries(pinia) {
    var stores = pinia && pinia._s;
    if (!stores) return [];
    var entries = [];
    if (typeof stores.forEach === "function") {
      stores.forEach(function (store, key) { entries.push({ key: key, store: store }); });
      return entries;
    }
    if (typeof stores === "object") {
      Object.keys(stores).forEach(function (key) { entries.push({ key: key, store: stores[key] }); });
    }
    return entries;
  }

  function officialStoreLooksLikeSettings(store) {
    if (!store || typeof store !== "object") return false;
    var id = String(store.$id || store.id || "").trim().toLowerCase();
    if (SETTINGS_STORE_IDS.indexOf(id) !== -1) return true;
    return Boolean(readOfficialWidgetSettings(store));
  }

  function findOfficialSettingsStore() {
    var app = localVueApp();
    var globals = localAppGlobalProperties();
    var pinia = findOfficialPinia();
    var direct = [
      globals && globals.$settingsStore,
      globals && globals.settingsStore,
      app && app.config && app.config.globalProperties && app.config.globalProperties.$settings
    ];
    for (var directIndex = 0; directIndex < direct.length; directIndex += 1) {
      if (officialStoreLooksLikeSettings(direct[directIndex])) return direct[directIndex];
    }
    var entries = piniaStoreEntries(pinia);
    for (var index = 0; index < SETTINGS_STORE_IDS.length; index += 1) {
      var preferredId = SETTINGS_STORE_IDS[index];
      var preferred = entries.find(function (entry) {
        return String(entry.key || entry.store && (entry.store.$id || entry.store.id) || "").toLowerCase() === preferredId;
      });
      if (preferred && preferred.store) return preferred.store;
    }
    return entries.map(function (entry) { return entry.store; }).find(officialStoreLooksLikeSettings) || null;
  }

  function officialWidgetValue(value) {
    if (value && typeof value === "object" && hasOwn(value, "value")) value = value.value;
    if (typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
    if (typeof value === "string") {
      var normalized = value.trim().toLowerCase();
      if (["1", "true", "yes", "on", "enabled"].indexOf(normalized) !== -1) return true;
      if (["0", "false", "no", "off", "disabled"].indexOf(normalized) !== -1) return false;
    }
    return null;
  }

  function officialWidgetCandidates(store) {
    var candidates = [];
    function add(value) {
      if (!value || typeof value !== "object") return;
      candidates.push(value);
      if (value.value && typeof value.value === "object") candidates.push(value.value);
    }
    add(store && store.settingsData);
    add(store && store.$state && store.$state.settingsData);
    add(store && store.settings);
    add(store && store.$state && store.$state.settings);
    add(store && store.$state);
    add(store);
    return candidates;
  }

  function readOfficialWidgetSettings(store) {
    if (!store || typeof store !== "object") return null;
    var result = {};
    ["mailWidget", "musicWidget"].forEach(function (key) {
      var candidates = officialWidgetCandidates(store);
      for (var index = 0; index < candidates.length; index += 1) {
        var candidate = candidates[index];
        if (!hasOwn(candidate, key)) continue;
        var value = officialWidgetValue(candidate[key]);
        if (value == null) continue;
        result[key] = value;
        break;
      }
    });
    return Object.keys(result).length ? result : null;
  }

  function widgetSettingsSignature(values) {
    return ["mailWidget", "musicWidget"].map(function (key) {
      return hasOwn(values, key) ? key + "=" + String(values[key]) : "";
    }).join("|");
  }

  function applyWidgetValuesToLocalRuntime(values) {
    if (!state.runtime || !values) return;
    ["mailWidget", "musicWidget"].forEach(function (key) {
      if (hasOwn(values, key)) state.runtime[key] = values[key];
    });
  }

  async function flushWidgetSettings() {
    if (state.settingsSync.flushing) return;
    state.settingsSync.flushing = true;
    try {
      while (state.settingsSync.desired) {
        var desired = state.settingsSync.desired;
        if (desired.signature === state.settingsSync.lastSentSignature) {
          if (state.settingsSync.desired.signature === desired.signature) state.settingsSync.desired = null;
          continue;
        }
        try {
          var saved = await callApi("/api/settings", { method: "POST", body: desired.payload });
          state.settingsSync.lastSentSignature = desired.signature;
          var savedValues = saved && typeof saved === "object"
            && (hasOwn(saved, "mailWidget") || hasOwn(saved, "musicWidget"))
            ? saved
            : desired.payload;
          applyWidgetValuesToLocalRuntime(savedValues);
          if (state.settingsSync.desired && state.settingsSync.desired.signature === desired.signature) {
            state.settingsSync.desired = null;
          }
        } catch (error) {
          // Keep the desired value so the discovery pass can retry after a transient service failure.
          break;
        }
      }
    } finally {
      state.settingsSync.flushing = false;
    }
  }

  function queueWidgetSettingsSync(values) {
    if (!values || typeof values !== "object") return;
    var payload = {};
    ["mailWidget", "musicWidget"].forEach(function (key) {
      if (hasOwn(values, key)) payload[key] = Boolean(values[key]);
    });
    if (!Object.keys(payload).length) return;
    var signature = widgetSettingsSignature(payload);
    if (state.settingsSync.desired && state.settingsSync.desired.signature === signature) {
      if (!state.settingsSync.flushing) void flushWidgetSettings();
      return;
    }
    if (signature === state.settingsSync.lastSentSignature) return;
    state.settingsSync.desired = { payload: payload, signature: signature };
    void flushWidgetSettings();
  }

  function disconnectOfficialSettingsStore() {
    if (typeof state.settingsSync.unsubscribe === "function") {
      try { state.settingsSync.unsubscribe(); } catch (error) { /* stale Pinia store */ }
    }
    state.settingsSync.unsubscribe = null;
    state.settingsSync.store = null;
  }

  function watchOfficialSettingsStore(store) {
    if (!store || state.settingsSync.store === store) return;
    disconnectOfficialSettingsStore();
    state.settingsSync.store = store;
    if (typeof store.$subscribe === "function") {
      try {
        var unsubscribe = store.$subscribe(function (_mutation, snapshot) {
          var source = snapshot && typeof snapshot === "object" ? { $state: snapshot } : store;
          queueWidgetSettingsSync(readOfficialWidgetSettings(source) || readOfficialWidgetSettings(store));
        }, { detached: true });
        if (typeof unsubscribe === "function") state.settingsSync.unsubscribe = unsubscribe;
      } catch (error) {
        // Some production builds expose the store without the detached option.
        try {
          var fallbackUnsubscribe = store.$subscribe(function () {
            queueWidgetSettingsSync(readOfficialWidgetSettings(store));
          });
          if (typeof fallbackUnsubscribe === "function") state.settingsSync.unsubscribe = fallbackUnsubscribe;
        } catch (fallbackError) { /* discovery polling remains the fallback */ }
      }
    }
  }

  function syncOfficialSettingsStore() {
    var store = findOfficialSettingsStore();
    if (!store) return false;
    watchOfficialSettingsStore(store);
    queueWidgetSettingsSync(readOfficialWidgetSettings(store));
    return true;
  }

  function startOfficialSettingsDiscovery() {
    if (state.settingsSync.discoveryStarted) return;
    state.settingsSync.discoveryStarted = true;
    state.settingsSync.discoveryTimer = window.setInterval(syncOfficialSettingsStore, 1000);
    syncOfficialSettingsStore();
  }

  function secondaryRendererMarker(value) {
    return /(^|[\s:/_.-])(video|pip|picture[-_ ]?in[-_ ]?picture|player|playback|media-player)(?=$|[\s:/?&#_.=-])/i.test(String(value || ""));
  }

  function mainRendererMarker(value) {
    return /^(main|primary|game|shell|default)(?:[-_ ]?(?:renderer|window))?$/i.test(String(value || "").trim());
  }

  function explicitRendererMarker() {
    var app = localVueApp();
    var root = document.documentElement;
    var body = document.body;
    var values = [
      window.__LINLI_RENDERER_KIND__,
      window.__LINLI_RENDERER_ROLE__,
      window.__LINLI_RENDERER__,
      window.__LOCAL_MAIL_RENDERER_KIND__,
      window.__LOCAL_MAIL_RENDERER_ROLE__,
      window.__LOCAL_MAIL_RENDERER__,
      window.__LOCAL_MAIL_WINDOW_KIND__,
      root && root.getAttribute && root.getAttribute("data-renderer"),
      root && root.getAttribute && root.getAttribute("data-renderer-kind"),
      body && body.getAttribute && body.getAttribute("data-renderer"),
      body && body.getAttribute && body.getAttribute("data-renderer-kind"),
      app && app.config && app.config.globalProperties && app.config.globalProperties.$rendererKind
    ];
    for (var index = 0; index < values.length; index += 1) {
      if (values[index] != null && String(values[index]).trim()) return String(values[index]).trim();
    }
    return "";
  }

  function isMainRenderer() {
    var location = window.location || {};
    var locationMarker = [location.pathname, location.search, location.hash].join(" ");
    if (secondaryRendererMarker(window.name) || secondaryRendererMarker(locationMarker)) return false;
    var explicit = explicitRendererMarker();
    if (explicit) return mainRendererMarker(explicit) && !secondaryRendererMarker(explicit);
    return Boolean(localVueRouter());
  }

  async function navigateDesktopCommand(route) {
    if (route !== DESKTOP_COMMAND_ROUTES.mail && route !== DESKTOP_COMMAND_ROUTES.music) return false;
    if (!isMainRenderer()) return false;
    var router = localVueRouter();
    if (!router) return false;
    var navigate = typeof router.push === "function" ? router.push : typeof router.replace === "function" ? router.replace : null;
    if (!navigate) return false;
    try {
      await Promise.resolve(navigate.call(router, route));
      return true;
    } catch (error) {
      return false;
    }
  }

  async function acknowledgeDesktopCommand(commandId) {
    try {
      var result = await callApi("/api/desktop-command/ack", {
        method: "POST",
        body: { commandId: commandId }
      });
      return Boolean(result && result.cleared === true);
    } catch (error) {
      return false;
    }
  }

  async function pollDesktopCommand() {
    if (state.desktopCommand.inFlight || !isMainRenderer()) return null;
    state.desktopCommand.inFlight = true;
    try {
      var command = await callApi("/api/desktop-command");
      var commandId = command && String(command.commandId || "").trim();
      var route = command && command.route;
      if (!commandId || (route !== DESKTOP_COMMAND_ROUTES.mail && route !== DESKTOP_COMMAND_ROUTES.music)) return null;
      state.desktopCommand.lastCommandId = commandId;
      if (state.desktopCommand.lastAckedCommandId === commandId) return command;
      var navigated = state.desktopCommand.lastNavigatedCommandId === commandId
        || await navigateDesktopCommand(route);
      if (!navigated) return command;
      state.desktopCommand.lastNavigatedCommandId = commandId;
      if (await acknowledgeDesktopCommand(commandId)) state.desktopCommand.lastAckedCommandId = commandId;
      return command;
    } catch (error) {
      return null;
    } finally {
      state.desktopCommand.inFlight = false;
    }
  }

  function startDesktopCommandPolling() {
    if (state.desktopCommand.started) return;
    state.desktopCommand.started = true;
    state.desktopCommand.timer = window.setInterval(function () { void pollDesktopCommand(); }, DESKTOP_COMMAND_POLL_INTERVAL_MS);
    void pollDesktopCommand();
  }

  function currentLocalRoutePath() {
    var hash = String(window.location.hash || "");
    var path = /^#\//.test(hash)
      ? hash.slice(1).split(/[?#]/)[0]
      : String(window.location.pathname || "/");
    return path.replace(/\/+$/, "") || "/";
  }

  function localRouteFallback(path) {
    try {
      var targetHash = "#" + path;
      if (String(window.location.hash || "") !== targetHash) window.location.hash = targetHash;
      queueMount();
      return true;
    } catch (error) {
      return false;
    }
  }

  function navigateLocalRoute(path) {
    if (path !== LOCAL_NAVIGATION_ROUTES.mail && path !== LOCAL_NAVIGATION_ROUTES.music) return false;
    var router = localVueRouter();
    if (router) {
      var method = typeof router.replace === "function" ? "replace"
        : typeof router.push === "function" ? "push" : null;
      if (method) {
        try {
          var result = router[method].call(router, path);
          if (result && typeof result.then === "function") {
            result.then(function () {}, function () {
              localRouteFallback(path);
            });
          }
          return true;
        } catch (error) {
          return localRouteFallback(path);
        }
      }
    }
    return localRouteFallback(path);
  }

  function localNavigationElementVisible(element) {
    if (!element || element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    var style = element.style;
    if (!style || typeof style.getPropertyValue !== "function") return true;
    return style.getPropertyValue("display") !== "none"
      && style.getPropertyValue("visibility") !== "hidden";
  }

  function localNavigationTitleLike(element) {
    var tag = String(element && element.tagName || "").toUpperCase();
    var className = String(element && element.className || "");
    return /^H[1-6]$/.test(tag)
      || /(^|[\s_-])(title|heading|header|page-title|section-title)([\s_-]|$)/i.test(className);
  }

  function findLocalNavigationTitle(navigation, expectedLabel) {
    var labels = expectedLabel ? [expectedLabel] : ["曲库", "信箱"];
    var mains = document.querySelectorAll("main");
    var best = null;
    var bestScore = -1;
    var bestDepth = -1;
    Array.prototype.forEach.call(mains, function (main) {
      Array.prototype.forEach.call(main.querySelectorAll("*"), function (element) {
        if (navigation && (element === navigation || navigation.contains(element))) return;
        if (!localNavigationElementVisible(element)) return;
        var text = String(element.textContent || "").replace(/\s+/g, " ").trim();
        if (labels.indexOf(text) < 0) return;
        var parent = element.parentElement;
        var score = localNavigationTitleLike(element) ? 10 : 0;
        if (parent && localNavigationTitleLike(parent)) score += 7;
        if (/^H[1-6]$/.test(String(element.tagName || "").toUpperCase())) score += 4;
        if (!element.children || element.children.length === 0) score += 2;
        var depth = 0;
        var cursor = element;
        while (cursor && cursor !== main) {
          depth += 1;
          cursor = cursor.parentElement;
        }
        if (score > bestScore || score === bestScore && depth > bestDepth) {
          best = element;
          bestScore = score;
          bestDepth = depth;
        }
      });
    });
    return best;
  }

  function localNavigationTitleLabel(path) {
    if (path === LOCAL_NAVIGATION_ROUTES.music) return "曲库";
    if (path === LOCAL_NAVIGATION_ROUTES.mail) return "信箱";
    return "";
  }

  var LOCAL_NAVIGATION_FALLBACK_TOP = 18;
  var LOCAL_NAVIGATION_FALLBACK_LEFT = 18;

  function setLocalNavigationStyle(navigation, property, value) {
    if (!navigation || !navigation.style || typeof navigation.style.setProperty !== "function") return;
    if (typeof navigation.style.getPropertyValue === "function"
      && navigation.style.getPropertyValue(property) === value) return;
    navigation.style.setProperty(property, value);
  }

  function localNavigationStyleValue(style, property) {
    if (!style) return "";
    if (typeof style.getPropertyValue === "function") return style.getPropertyValue(property);
    return String(style[property] || "");
  }

  function localNavigationStylePriority(style, property) {
    if (!style || typeof style.getPropertyPriority !== "function") return "";
    return style.getPropertyPriority(property);
  }

  function setLocalNavigationTitleStyle(style, property, value, priority) {
    if (!style || typeof style.setProperty !== "function") return;
    if (localNavigationStyleValue(style, property) === value
      && localNavigationStylePriority(style, property) === priority) return;
    style.setProperty(property, value, priority);
  }

  function restoreLocalNavigationTitle(navigation) {
    var state = navigation && navigation.__linliNavigationTitleState;
    if (!state) {
      if (navigation) navigation.__linliNavigationTitle = null;
      return;
    }
    var style = state.element && state.element.style;
    setLocalNavigationTitleStyle(style, "visibility", state.visibility, state.visibilityPriority);
    setLocalNavigationTitleStyle(style, "pointer-events", state.pointerEvents, state.pointerEventsPriority);
    navigation.__linliNavigationTitleState = null;
    navigation.__linliNavigationTitle = null;
  }

  function hideLocalNavigationTitle(navigation, title) {
    if (!navigation || !title) {
      restoreLocalNavigationTitle(navigation);
      return;
    }
    var state = navigation.__linliNavigationTitleState;
    if (state && state.element !== title) {
      restoreLocalNavigationTitle(navigation);
      state = null;
    }
    if (!state) {
      var style = title.style;
      state = {
        element: title,
        visibility: localNavigationStyleValue(style, "visibility"),
        visibilityPriority: localNavigationStylePriority(style, "visibility"),
        pointerEvents: localNavigationStyleValue(style, "pointer-events"),
        pointerEventsPriority: localNavigationStylePriority(style, "pointer-events")
      };
      navigation.__linliNavigationTitleState = state;
    }
    navigation.__linliNavigationTitle = title;
    setLocalNavigationTitleStyle(title.style, "visibility", "hidden", "important");
    setLocalNavigationTitleStyle(title.style, "pointer-events", "none", "important");
  }

  function positionLocalNavigation(navigation, path) {
    var left = LOCAL_NAVIGATION_FALLBACK_LEFT;
    var top = LOCAL_NAVIGATION_FALLBACK_TOP;
    var placement = "fallback";
    var expectedLabel = localNavigationTitleLabel(path);
    var title = navigation && navigation.__linliNavigationTitle;
    if (!title || !title.isConnected
      || String(title.textContent || "").replace(/\s+/g, " ").trim() !== expectedLabel) {
      title = findLocalNavigationTitle(navigation, expectedLabel);
    }
    if (title && typeof title.getBoundingClientRect === "function") {
      try {
        var rect = title.getBoundingClientRect();
        var rectLeft = Number(rect && rect.left);
        var rectTop = Number(rect && rect.top);
        if (Number.isFinite(rectLeft) && Number.isFinite(rectTop)) {
          left = rectLeft;
          top = rectTop;
          placement = "body";
        }
      } catch (error) {
        // The title can be replaced between discovery and layout; keep the safe fixed fallback.
      }
    }
    hideLocalNavigationTitle(navigation, placement === "body" ? title : null);
    setLocalNavigationStyle(navigation, "left", left + "px");
    setLocalNavigationStyle(navigation, "top", top + "px");
    if (navigation.getAttribute("data-local-navigation-placement") !== placement) {
      navigation.setAttribute("data-local-navigation-placement", placement);
    }
  }

  function ensureLocalNavigation() {
    var navigation = document.getElementById(LOCAL_NAVIGATION_ID);
    installStyles();
    if (!navigation) {
      navigation = document.createElement("nav");
      navigation.id = LOCAL_NAVIGATION_ID;
    }
    if (document.body && navigation.parentElement !== document.body) document.body.appendChild(navigation);
    if (navigation.getAttribute("aria-label") !== "曲库与信箱") navigation.setAttribute("aria-label", "曲库与信箱");
    var buttons = navigation.querySelectorAll("[data-local-route]");
    var hasStableTabs = buttons.length === 2
      && buttons[0].dataset.localTab === "music"
      && buttons[1].dataset.localTab === "mail";
    if (!hasStableTabs) {
      navigation.innerHTML =
        '<button type="button" class="lm-local-nav-button" data-local-tab="music" data-local-route="/studio">曲库</button>' +
        '<button type="button" class="lm-local-nav-button" data-local-tab="mail" data-local-route="/collection">信箱</button>';
    }
    Array.prototype.forEach.call(navigation.querySelectorAll("[data-local-route]"), function (button) {
      if (button.style && typeof button.style.setProperty === "function") {
        if (button.style.getPropertyValue("-webkit-app-region") !== "no-drag") {
          button.style.setProperty("-webkit-app-region", "no-drag", "important");
        }
        if (button.style.getPropertyValue("pointer-events") !== "auto") {
          button.style.setProperty("pointer-events", "auto", "important");
        }
      }
    });
    if (!navigation.__linliNavigationBound) {
      navigation.addEventListener("click", function (event) {
        var button = event.target && event.target.closest ? event.target.closest("[data-local-route]") : null;
        if (!button || !navigation.contains(button)) return;
        if (event.preventDefault) event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        navigateLocalRoute(button.dataset.localRoute);
      }, true);
      navigation.__linliNavigationBound = true;
    }
    return navigation;
  }

  function renderLocalNavigation() {
    var navigation = ensureLocalNavigation();
    var currentPath = currentLocalRoutePath();
    var isTargetRoute = Boolean(localNavigationTitleLabel(currentPath));
    if (!isTargetRoute) {
      restoreLocalNavigationTitle(navigation);
      if (!navigation.hidden) navigation.hidden = true;
      if (navigation.getAttribute("data-local-navigation-placement") !== "hidden") {
        navigation.setAttribute("data-local-navigation-placement", "hidden");
      }
    } else {
      positionLocalNavigation(navigation, currentPath);
      if (navigation.hidden) navigation.hidden = false;
    }
    Array.prototype.forEach.call(navigation.querySelectorAll("[data-local-route]"), function (button) {
      var active = isTargetRoute && button.dataset.localRoute === currentPath;
      if (button.dataset.active !== String(active)) button.dataset.active = String(active);
      if (active && button.getAttribute("aria-current") !== "page") button.setAttribute("aria-current", "page");
      else if (!active && button.getAttribute("aria-current") != null) button.removeAttribute("aria-current");
    });
  }

  function mountLocalNavigation() {
    renderLocalNavigation();
  }

  var MUSIC_CUSTOM_LIST_ID = "local-mail-music-custom-list";
  var MUSIC_CUSTOM_TABS_ID = "local-mail-music-playlists";
  var MUSIC_TOOLBAR_ID = "local-mail-music-toolbar";
  var MUSIC_MODAL_ID = "local-mail-music-modal";
  var MUSIC_BEHAVIOR_SETTING_ID = "local-mail-music-behavior-setting";
  var MUSIC_NATIVE_TAB_NAMES = ["古典", "ACG", "轻音乐", "我的上传"];
  var MUSIC_EXPERIMENTAL_UI_ENABLED = false;

  function musicHeaderIn(root) {
    if (!root) return null;
    return Array.prototype.slice.call(root.querySelectorAll("div")).find(function (element) {
      var text = element.textContent.replace(/\s+/g, " ").trim();
      return element.classList.contains("border-b")
        && text.indexOf("曲目") !== -1
        && text.indexOf("模式") !== -1;
    }) || null;
  }

  function musicTabControlIn(root, label) {
    if (!root) return null;
    var nativeList = document.getElementById("tour-song-list");
    var customList = document.getElementById(MUSIC_CUSTOM_LIST_ID);
    var customTabs = document.getElementById(MUSIC_CUSTOM_TABS_ID);
    var leaf = Array.prototype.slice.call(root.querySelectorAll("*")).find(function (element) {
      if (element.children.length !== 0 || element.textContent.trim() !== label) return false;
      if (nativeList && nativeList.contains(element)) return false;
      if (customList && customList.contains(element)) return false;
      if (customTabs && customTabs.contains(element)) return false;
      return true;
    });
    if (!leaf) return null;
    var control = leaf;
    while (control.parentElement && control.parentElement !== root
      && control.parentElement.textContent.trim() === label) control = control.parentElement;
    return control;
  }

  function musicSection() {
    var list = document.getElementById("tour-song-list");
    if (!list) return null;
    var candidate = list.parentElement;
    var headerFallback = null;
    while (candidate && candidate !== document) {
      var header = musicHeaderIn(candidate);
      if (header && !headerFallback) headerFallback = candidate;
      var hasNativeTab = MUSIC_NATIVE_TAB_NAMES.some(function (name) {
        return Boolean(musicTabControlIn(candidate, name));
      });
      if (header && hasNativeTab) return candidate;
      candidate = candidate.parentElement;
    }
    return headerFallback || list.parentElement;
  }

  function musicHeader() {
    var section = musicSection();
    return musicHeaderIn(section);
  }

  function musicTabControlForLabel(label) {
    var section = musicSection();
    return musicTabControlIn(section, label);
  }

  function musicNativeTabs() {
    return MUSIC_NATIVE_TAB_NAMES.map(function (name) {
      return { name: name, control: musicTabControlForLabel(name) };
    }).filter(function (item) { return item.control; });
  }

  function musicNativeTabFromTarget(target) {
    return musicNativeTabs().find(function (item) {
      return item.control.contains(target);
    }) || null;
  }

  function isCustomMusicView() {
    return Boolean(state.music.activePlaylistId);
  }

  function selectedMusicEntries() {
    return Object.keys(state.music.selected).map(function (key) { return state.music.selected[key]; });
  }

  function clearMusicSelection() {
    state.music.selected = {};
  }

  function musicEntryFromSong(song, sourceType, component) {
    var id = String((song && (song.id || song.itemId)) || "").trim();
    if (!id) return null;
    var normalizedSourceType = Number(sourceType) === 3 ? 3 : 2;
    return {
      key: normalizedSourceType + ":" + id,
      sourceType: normalizedSourceType,
      song: song,
      component: component || null
    };
  }

  function musicSongComponent(row) {
    var node = row;
    while (node) {
      var component = node.__vueParentComponent;
      if (component && component.props && component.props.song) return component;
      node = node.parentElement;
    }
    return null;
  }

  function musicSourceTypeForSong(song) {
    if (state.music.nativeViewName === "我的上传" || song.userSongId != null || song.shareCode !== undefined) return 3;
    return 2;
  }

  function nativeMusicEntries() {
    return Array.prototype.slice.call(document.querySelectorAll("#tour-song-list .song-item")).map(function (row) {
      var component = musicSongComponent(row);
      var song = component && component.props && component.props.song;
      var entry = song ? musicEntryFromSong(song, musicSourceTypeForSong(song), component) : null;
      if (entry) entry.row = row;
      return entry;
    }).filter(Boolean);
  }

  function customMusicEntries() {
    return (state.music.playlistItems || []).map(function (item) {
      return musicEntryFromSong(item.song || {}, item.sourceType, null);
    }).filter(Boolean);
  }

  function visibleMusicEntries() {
    return isCustomMusicView() ? customMusicEntries() : nativeMusicEntries();
  }

  function serializeMusicSong(entry) {
    var source = entry && entry.song && typeof entry.song === "object" ? entry.song : {};
    var song = Object.assign({}, source);
    var id = song.id != null ? song.id : song.itemId != null ? song.itemId : song.songId;
    if (id != null) {
      song.id = id;
      if (song.itemId == null) song.itemId = id;
    }
    if (entry && entry.sourceType != null) {
      song.sourceType = entry.sourceType;
      if (song.itemType == null) song.itemType = entry.sourceType;
    }
    var cover = song.coverUrl || song.iconUrl || song.cover || song.icon;
    if (cover) {
      if (song.coverUrl == null) song.coverUrl = cover;
      if (song.iconUrl == null) song.iconUrl = cover;
      if (song.cover == null) song.cover = cover;
      if (song.icon == null) song.icon = cover;
    }
    var nameKey = song.nameKey || song.songNameKey;
    if (nameKey) {
      if (song.nameKey == null) song.nameKey = nameKey;
      if (song.songNameKey == null) song.songNameKey = nameKey;
    }
    if (song.videoUrl == null && song.videoURL != null) song.videoUrl = song.videoURL;
    if (song.audioUrl == null && song.audioURL != null) song.audioUrl = song.audioURL;
    if (song.duration == null) {
      if (song.videoDuration != null) song.duration = song.videoDuration;
      else if (song.audioDuration != null) song.duration = song.audioDuration;
    }
    return song;
  }

  async function addMusicEntryToDesktop(entry, button) {
    if (!entry || state.music.busy) return;
    if (button) {
      button.disabled = true;
      button.textContent = "加入中…";
    }
    try {
      await callNativeMusicAdd(entry);
      musicNotice("已加入音乐桌面。", "success");
    } catch (error) {
      musicNotice("加入音乐桌面失败：" + (error.message || error), "error");
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "加播单";
      }
    }
  }

  function musicNotice(text, kind) {
    var toolbar = document.getElementById(MUSIC_TOOLBAR_ID);
    var status = toolbar && toolbar.querySelector("[data-role='music-status']");
    if (!status) return;
    status.textContent = text || "";
    status.dataset.kind = kind || "";
    if (state.music.noticeTimer) clearTimeout(state.music.noticeTimer);
    if (text) {
      state.music.noticeTimer = setTimeout(function () {
        if (status.isConnected) status.textContent = "";
      }, 4200);
    }
  }

  async function ensureMusicLibraryLoaded() {
    if (state.music.loaded || state.music.loading) return;
    state.music.loading = true;
    try {
      var data = await callApi("/api/music-library");
      state.music.playlists = Array.isArray(data.playlists) ? data.playlists : [];
      state.music.confirmSelectionClear = !data.preferences || data.preferences.confirmSelectionClear !== false;
      state.music.loaded = true;
    } catch (error) {
      console.warn("[local-mail] unable to load music library", error);
    } finally {
      state.music.loading = false;
      renderMusicEnhancements();
      mountMusicBehaviorSetting();
    }
  }

  async function reloadMusicLibrary() {
    state.music.loaded = false;
    await ensureMusicLibraryLoaded();
  }

  async function loadMusicPlaylist(playlistId) {
    var detail = await callApi("/api/music-library/playlists/" + encodeURIComponent(playlistId));
    state.music.activePlaylistId = detail.playlist.playlistId;
    state.music.playlistItems = Array.isArray(detail.items) ? detail.items : [];
  }

  function nextLocalElement(node) {
    var sibling = node && node.nextSibling;
    while (sibling) {
      if (sibling.tagName) return sibling;
      sibling = sibling.nextSibling;
    }
    return null;
  }

  function placeLocalElementAfter(anchor, node) {
    if (!anchor || !node || !anchor.parentElement) return;
    if (node.parentElement === anchor.parentElement && nextLocalElement(anchor) === node) return;
    anchor.insertAdjacentElement("afterend", node);
  }

  function setLocalElementText(element, value) {
    if (!element) return;
    var text = value == null ? "" : String(value);
    if (element.textContent !== text) element.textContent = text;
  }

  function setLocalElementHidden(element, hidden) {
    if (element && element.hidden !== Boolean(hidden)) element.hidden = Boolean(hidden);
  }

  function setLocalElementDisabled(element, disabled) {
    if (element && element.disabled !== Boolean(disabled)) element.disabled = Boolean(disabled);
  }

  function setLocalElementChecked(element, checked) {
    if (element && element.checked !== Boolean(checked)) element.checked = Boolean(checked);
  }

  function renderMusicTabs() {
    var nativeTabs = musicNativeTabs();
    if (!nativeTabs.length) return;
    var anchorTab = nativeTabs[nativeTabs.length - 1].control;
    var tabs = document.getElementById(MUSIC_CUSTOM_TABS_ID);
    if (!tabs) {
      tabs = document.createElement("div");
      tabs.id = MUSIC_CUSTOM_TABS_ID;
      tabs.className = "lm-music-playlists";
      tabs.setAttribute("aria-label", "本地自定义歌单");
    }
    placeLocalElementAfter(anchorTab, tabs);
    if (!tabs.__linliMusicTabsBound) {
      tabs.onclick = function (event) {
        var action = event.target.closest("[data-music-action]");
        if (!action) return;
        if (action.dataset.musicAction === "new-playlist") openMusicCreateDialog();
        else if (action.dataset.musicAction === "switch-playlist") {
          requestMusicViewSwitch({ kind: "custom", playlistId: action.dataset.playlistId });
        }
      };
      tabs.__linliMusicTabsBound = true;
    }
    var playlists = state.music.playlists || [];
    var signature = JSON.stringify({
      active: state.music.activePlaylistId || "",
      playlists: playlists.map(function (playlist) { return [playlist.playlistId, playlist.name]; })
    });
    if (tabs.__linliMusicTabsSignature === signature) return;
    var newPlaylistButton = tabs.querySelector("[data-music-action='new-playlist']");
    if (!newPlaylistButton) {
      newPlaylistButton = document.createElement("button");
      newPlaylistButton.type = "button";
      newPlaylistButton.className = "lm-music-new-playlist";
      newPlaylistButton.setAttribute("data-music-action", "new-playlist");
      tabs.insertBefore(newPlaylistButton, tabs.firstElementChild);
    } else if (tabs.firstElementChild !== newPlaylistButton) {
      tabs.insertBefore(newPlaylistButton, tabs.firstElementChild);
    }
    setLocalElementText(newPlaylistButton, "＋ 自定义歌单");
    var cursor = newPlaylistButton;
    var retained = [];
    playlists.forEach(function (playlist) {
      var playlistId = String(playlist.playlistId == null ? "" : playlist.playlistId);
      var button = Array.prototype.slice.call(tabs.querySelectorAll("[data-music-action='switch-playlist']")).find(function (candidate) {
        return candidate.getAttribute("data-playlist-id") === playlistId;
      });
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "lm-music-tab";
        button.setAttribute("data-music-action", "switch-playlist");
      }
      button.setAttribute("data-playlist-id", playlistId);
      button.setAttribute("data-active", String(state.music.activePlaylistId === playlist.playlistId));
      setLocalElementText(button, playlist.name || "未命名歌单");
      if (nextLocalElement(cursor) !== button) tabs.insertBefore(button, nextLocalElement(cursor));
      cursor = button;
      retained.push(button);
    });
    Array.prototype.forEach.call(tabs.querySelectorAll("[data-music-action='switch-playlist']"), function (button) {
      if (retained.indexOf(button) < 0) button.remove();
    });
    tabs.__linliMusicTabsSignature = signature;
  }

  function renderMusicToolbar() {
    var header = musicHeader();
    if (!header) return;
    var toolbar = document.getElementById(MUSIC_TOOLBAR_ID);
    if (!toolbar) {
      toolbar = document.createElement("div");
      toolbar.id = MUSIC_TOOLBAR_ID;
      toolbar.className = "lm-music-toolbar";
      header.appendChild(toolbar);
    }
    if (!toolbar.querySelector("[data-role='select-all-wrap']")
      || !toolbar.querySelector("[data-role='selected-count']")) {
      toolbar.innerHTML =
        '<button type="button" class="lm-music-action" data-music-action="begin-batch">批量选择</button>' +
        '<label class="lm-music-header-checkbox" data-role="select-all-wrap" title="全选当前列表"><input class="lm-music-checkbox" type="checkbox" data-music-action="select-all"></label>' +
        '<button type="button" class="lm-music-action" data-music-action="add-desktop">加播单</button>' +
        '<button type="button" class="lm-music-action" data-music-action="add-playlist">加入歌单</button>' +
        '<button type="button" class="lm-music-action" data-music-action="remove-playlist">移出歌单</button>' +
        '<span class="lm-music-selected-count" data-role="selected-count"></span>' +
        '<button type="button" class="lm-music-action lm-music-action-primary" data-music-action="end-batch">完成</button>' +
        '<span class="lm-music-status" data-role="music-status"></span>';
    }
    if (!toolbar.__linliMusicToolbarBound) {
      toolbar.onclick = function (event) {
        var button = event.target.closest("[data-music-action]");
        if (!button || button.disabled) return;
        var action = button.dataset.musicAction;
        if (action === "begin-batch") {
          state.music.batchMode = true;
          renderMusicEnhancements();
        } else if (action === "end-batch") {
          state.music.batchMode = false;
          clearMusicSelection();
          renderMusicEnhancements();
        } else if (action === "add-desktop") addSelectedToMusicDesktop();
        else if (action === "add-playlist") openMusicPlaylistPicker();
        else if (action === "remove-playlist") removeSelectedFromMusicPlaylist();
      };
      var boundAllCheckbox = toolbar.querySelector("[data-music-action='select-all']");
      if (boundAllCheckbox) {
        boundAllCheckbox.onchange = function () {
          visibleMusicEntries().forEach(function (entry) {
            if (boundAllCheckbox.checked) state.music.selected[entry.key] = entry;
            else delete state.music.selected[entry.key];
          });
          renderMusicEnhancements();
        };
      }
      toolbar.__linliMusicToolbarBound = true;
    }
    var selectedCount = selectedMusicEntries().length;
    var actionDisabled = selectedCount === 0 || state.music.busy;
    var all = visibleMusicEntries();
    var selectedKeys = Object.keys(state.music.selected).sort();
    var signature = JSON.stringify({
      batch: state.music.batchMode,
      custom: isCustomMusicView(),
      selected: selectedKeys,
      visible: all.map(function (entry) { return entry.key; }),
      busy: state.music.busy
    });
    if (toolbar.__linliMusicToolbarSignature === signature) return;
    var begin = toolbar.querySelector("[data-music-action='begin-batch']");
    var selectAllWrap = toolbar.querySelector("[data-role='select-all-wrap']");
    var addDesktop = toolbar.querySelector("[data-music-action='add-desktop']");
    var addPlaylist = toolbar.querySelector("[data-music-action='add-playlist']");
    var removePlaylist = toolbar.querySelector("[data-music-action='remove-playlist']");
    var selectedLabel = toolbar.querySelector("[data-role='selected-count']");
    var end = toolbar.querySelector("[data-music-action='end-batch']");
    var inBatch = Boolean(state.music.batchMode);
    setLocalElementHidden(begin, inBatch);
    setLocalElementHidden(selectAllWrap, !inBatch);
    setLocalElementHidden(addDesktop, !inBatch);
    setLocalElementHidden(addPlaylist, !inBatch);
    setLocalElementHidden(removePlaylist, !inBatch || !isCustomMusicView());
    setLocalElementHidden(selectedLabel, !inBatch);
    setLocalElementHidden(end, !inBatch);
    setLocalElementDisabled(addDesktop, !inBatch || actionDisabled);
    setLocalElementDisabled(addPlaylist, !inBatch || actionDisabled);
    setLocalElementDisabled(removePlaylist, !inBatch || actionDisabled);
    setLocalElementText(selectedLabel, "已选 " + selectedCount + " 首");
    if (inBatch) {
      var checkbox = toolbar.querySelector("[data-music-action='select-all']");
      var selectedVisible = all.filter(function (entry) { return state.music.selected[entry.key]; }).length;
      setLocalElementChecked(checkbox, all.length > 0 && selectedVisible === all.length);
      if (checkbox && checkbox.indeterminate !== (selectedVisible > 0 && selectedVisible < all.length)) {
        checkbox.indeterminate = selectedVisible > 0 && selectedVisible < all.length;
      }
    }
    toolbar.__linliMusicToolbarSignature = signature;
  }

  function decorateNativeMusicRows() {
    nativeMusicEntries().forEach(function (entry) {
      var row = entry.row;
      Array.prototype.forEach.call(row.querySelectorAll(".lm-music-row-add[data-music-action='add-desktop-one']"), function (button) {
        button.remove();
      });
      var existing = row.querySelector(".lm-music-row-checkbox");
      if (!state.music.batchMode) {
        if (existing) existing.remove();
        return;
      }
      if (!existing) {
        existing = document.createElement("label");
        existing.className = "lm-music-row-checkbox";
        existing.innerHTML = '<input class="lm-music-checkbox" type="checkbox" aria-label="选择曲目">';
        row.insertBefore(existing, row.firstElementChild);
        existing.addEventListener("click", function (event) { event.stopPropagation(); });
        existing.addEventListener("dblclick", function (event) { event.stopPropagation(); });
      }
      var checkbox = existing.querySelector("input");
      checkbox.__linliMusicEntry = entry;
      setLocalElementChecked(checkbox, Boolean(state.music.selected[entry.key]));
      if (!checkbox.__linliMusicChangeBound) {
        checkbox.onchange = function () {
          var currentEntry = checkbox.__linliMusicEntry;
          if (!currentEntry) return;
          if (checkbox.checked) state.music.selected[currentEntry.key] = currentEntry;
          else delete state.music.selected[currentEntry.key];
          renderMusicEnhancements();
        };
        checkbox.__linliMusicChangeBound = true;
      }
    });
  }

  function customMusicList() {
    var original = document.getElementById("tour-song-list");
    if (!original) return null;
    var list = document.getElementById(MUSIC_CUSTOM_LIST_ID);
    if (!list) {
      list = document.createElement("div");
      list.id = MUSIC_CUSTOM_LIST_ID;
      list.className = "lm-music-custom-list";
    }
    placeLocalElementAfter(original, list);
    return list;
  }

  function musicCoverValue(song) {
    if (!song || typeof song !== "object") return "";
    return song.coverUrl || song.iconUrl || song.cover || song.icon || "";
  }

  function customMusicRowMarkup() {
    return '<label class="lm-music-row-checkbox" data-role="row-checkbox"><input class="lm-music-checkbox" type="checkbox" data-role="music-checkbox" aria-label="选择曲目"></label>' +
      '<div class="lm-music-custom-index" data-role="music-index"></div>' +
      '<div class="lm-music-cover" data-role="music-cover"></div>' +
      '<div class="lm-music-song"><div class="lm-music-song-name" data-role="music-name"></div><div class="lm-music-song-meta" data-role="music-meta"></div></div>' +
      '<div class="lm-music-mode" data-role="music-mode"></div>' +
      '<button type="button" class="lm-music-row-add" data-music-action="add-desktop-one">加播单</button>' +
      '<button type="button" class="lm-music-row-remove" data-music-action="remove-one">移出</button>';
  }

  function bindCustomMusicRow(row) {
    if (row.__linliMusicRowBound) return;
    row.onclick = function (event) {
      var action = event.target.closest("[data-music-action]");
      if (!action || action.disabled) return;
      var entry = row.__linliMusicEntry;
      if (!entry) return;
      if (action.dataset.musicAction === "add-desktop-one") {
        addMusicEntryToDesktop(entry, action);
        return;
      }
      if (action.dataset.musicAction === "remove-one") {
        clearMusicSelection();
        state.music.selected[entry.key] = entry;
        removeSelectedFromMusicPlaylist();
      }
    };
    row.onchange = function (event) {
      var checkbox = event.target.closest("[data-role='music-checkbox']");
      var entry = row.__linliMusicEntry;
      if (!checkbox || !entry) return;
      if (checkbox.checked) state.music.selected[entry.key] = entry;
      else delete state.music.selected[entry.key];
      renderMusicEnhancements();
    };
    row.__linliMusicRowBound = true;
  }

  function updateCustomMusicCover(host, song) {
    var cover = musicCoverValue(song);
    var coverValue = String(cover || "");
    if (host.__linliMusicCoverValue === coverValue && host.firstElementChild) return;
    host.__linliMusicCoverValue = coverValue;
    host.innerHTML = "";
    if (coverValue) {
      var image = document.createElement("img");
      image.className = "lm-music-cover";
      image.setAttribute("src", coverValue);
      image.setAttribute("alt", "");
      host.appendChild(image);
    } else {
      var placeholder = document.createElement("div");
      placeholder.className = "lm-music-cover-placeholder";
      placeholder.textContent = "♪";
      host.appendChild(placeholder);
    }
  }

  function renderCustomMusicList() {
    var original = document.getElementById("tour-song-list");
    var list = customMusicList();
    if (!original || !list) return;
    if (!isCustomMusicView()) {
      setLocalElementHidden(original, false);
      setLocalElementHidden(list, true);
      return;
    }
    setLocalElementHidden(original, true);
    setLocalElementHidden(list, false);
    var items = customMusicEntries();
    var signature = JSON.stringify({
      items: items.map(function (entry) {
        var song = entry.song || {};
        return [entry.key, song.name, musicCoverValue(song), song.nameKey, song.songNameKey, song.styleTypeDisplayName, song.performanceTypeDisplayShortName, song.performanceType];
      }),
      batch: state.music.batchMode,
      busy: state.music.busy,
      selected: Object.keys(state.music.selected).sort()
    });
    if (list.__linliMusicListSignature === signature) return;
    var empty = list.querySelector("[data-role='music-empty']");
    if (!empty) {
      empty = document.createElement("div");
      empty.className = "lm-music-empty";
      empty.setAttribute("data-role", "music-empty");
      empty.textContent = "这个自定义歌单还没有曲目";
      list.appendChild(empty);
    }
    if (!items.length) {
      Array.prototype.forEach.call(list.querySelectorAll(".lm-music-custom-row"), function (row) { row.remove(); });
      setLocalElementHidden(empty, false);
      list.__linliMusicListSignature = signature;
      return;
    }
    setLocalElementHidden(empty, true);
    var rows = Array.prototype.slice.call(list.querySelectorAll(".lm-music-custom-row"));
    var cursor = null;
    var retained = [];
    items.forEach(function (entry, index) {
      var row = rows.find(function (candidate) { return candidate.getAttribute("data-music-item-key") === entry.key; });
      if (!row) {
        row = document.createElement("div");
        row.className = "lm-music-custom-row";
        row.innerHTML = customMusicRowMarkup();
      }
      bindCustomMusicRow(row);
      var song = entry.song || {};
      var mode = song.performanceTypeDisplayShortName || song.styleTypeDisplayName || song.performanceType || "";
      row.__linliMusicEntry = entry;
      row.setAttribute("data-music-item-key", entry.key);
      var checkbox = row.querySelector("[data-role='music-checkbox']");
      var checkboxLabel = row.querySelector("[data-role='row-checkbox']");
      var addButton = row.querySelector("[data-music-action='add-desktop-one']");
      var removeButton = row.querySelector("[data-music-action='remove-one']");
      if (checkbox) {
        checkbox.setAttribute("data-music-item-key", entry.key);
        setLocalElementChecked(checkbox, Boolean(state.music.selected[entry.key]));
      }
      if (addButton) addButton.setAttribute("data-music-item-key", entry.key);
      if (removeButton) removeButton.setAttribute("data-music-item-key", entry.key);
      setLocalElementHidden(checkboxLabel, !state.music.batchMode);
      setLocalElementText(row.querySelector("[data-role='music-index']"), index + 1);
      setLocalElementText(row.querySelector("[data-role='music-name']"), song.name || "未命名曲目");
      setLocalElementText(row.querySelector("[data-role='music-meta']"), song.styleTypeDisplayName || song.nameKey || song.songNameKey || "");
      setLocalElementText(row.querySelector("[data-role='music-mode']"), mode);
      setLocalElementDisabled(addButton, state.music.busy);
      setLocalElementDisabled(removeButton, state.music.busy);
      updateCustomMusicCover(row.querySelector("[data-role='music-cover']"), song);
      if (!cursor) {
        if (list.firstElementChild !== row) list.insertBefore(row, list.firstElementChild);
      } else if (nextLocalElement(cursor) !== row) {
        list.insertBefore(row, nextLocalElement(cursor));
      }
      cursor = row;
      retained.push(row);
    });
    rows.forEach(function (row) {
      if (retained.indexOf(row) < 0) row.remove();
    });
    if (nextLocalElement(cursor) !== empty) list.appendChild(empty);
    list.__linliMusicListSignature = signature;
  }

  function renderMusicEnhancements() {
    if (!document.getElementById("tour-song-list")) return;
    installStyles();
    if (!MUSIC_EXPERIMENTAL_UI_ENABLED) {
      state.music.batchMode = false;
      clearMusicSelection();
      var original = document.getElementById("tour-song-list");
      setLocalElementHidden(original, false);
      [MUSIC_CUSTOM_TABS_ID, MUSIC_TOOLBAR_ID, MUSIC_CUSTOM_LIST_ID, MUSIC_MODAL_ID].forEach(function (id) {
        var node = document.getElementById(id);
        if (node) node.remove();
      });
      Array.prototype.forEach.call(document.querySelectorAll("#tour-song-list .lm-music-row-checkbox"), function (node) {
        node.remove();
      });
      return;
    }
    renderMusicTabs();
    renderCustomMusicList();
    renderMusicToolbar();
    if (!isCustomMusicView()) decorateNativeMusicRows();
  }

  function ensureMusicModal() {
    var modal = document.getElementById(MUSIC_MODAL_ID);
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = MUSIC_MODAL_ID;
    modal.className = "lm-modal-backdrop";
    modal.hidden = true;
    modal.addEventListener("click", function (event) {
      if (event.target === modal && !state.music.busy) closeMusicModal();
      var action = event.target.closest("[data-music-modal-action]");
      if (!action || action.disabled) return;
      var kind = action.dataset.musicModalAction;
      if (kind === "close") closeMusicModal();
      else if (kind === "create") submitMusicPlaylistCreate();
      else if (kind === "pick") addSelectionToMusicPlaylist(action.dataset.playlistId);
      else if (kind === "create-from-picker") openMusicCreateDialog("add-selected");
      else if (kind === "confirm-switch") confirmMusicViewSwitch();
    });
    document.body.appendChild(modal);
    return modal;
  }

  function closeMusicModal(force) {
    if (state.music.busy && !force) return;
    var modal = document.getElementById(MUSIC_MODAL_ID);
    if (modal) modal.hidden = true;
    state.music.pendingSwitch = null;
    state.music.createAfter = null;
  }

  function openMusicCreateDialog(afterCreate) {
    state.music.createAfter = afterCreate || null;
    var modal = ensureMusicModal();
    modal.innerHTML = '<div class="lm-modal lm-music-dialog" role="dialog" aria-modal="true">' +
      '<div class="lm-modal-title">新建自定义歌单</div><div class="lm-music-dialog-copy">歌单保存在本机 SQLite 中。之后可从曲库批量加入或移出曲目。</div>' +
      '<label class="lm-field"><span>歌单名称</span><input class="lm-input" data-role="music-playlist-name" maxlength="40" placeholder="例如：夜晚练琴"></label>' +
      '<div class="lm-modal-actions"><span class="lm-modal-status" data-role="music-modal-status"></span><button type="button" class="lm-button" data-music-modal-action="close">取消</button><button type="button" class="lm-button lm-button-primary" data-music-modal-action="create">创建</button></div></div>';
    modal.hidden = false;
    setTimeout(function () {
      var input = modal.querySelector("[data-role='music-playlist-name']");
      if (input) input.focus();
    }, 0);
  }

  function openMusicPlaylistPicker() {
    var modal = ensureMusicModal();
    var playlists = state.music.playlists || [];
    var choices = playlists.length
      ? '<div class="lm-music-playlist-picker">' + playlists.map(function (playlist) {
        return '<button type="button" class="lm-music-playlist-choice" data-music-modal-action="pick" data-playlist-id="' + escapeHtml(playlist.playlistId) + '"><span>' + escapeHtml(playlist.name) + '</span><span class="lm-music-playlist-choice-meta">' + Number(playlist.itemCount || 0) + ' 首</span></button>';
      }).join("") + '</div>'
      : '<div class="lm-empty">还没有自定义歌单。先创建一个吧。</div>';
    modal.innerHTML = '<div class="lm-modal lm-music-dialog" role="dialog" aria-modal="true">' +
      '<div class="lm-modal-title">加入自定义歌单</div><div class="lm-music-dialog-copy">选择要加入的歌单；重复曲目会更新为当前曲目信息，不会重复出现。</div>' + choices +
      '<div class="lm-modal-actions"><span class="lm-modal-status" data-role="music-modal-status"></span><button type="button" class="lm-button" data-music-modal-action="close">取消</button><button type="button" class="lm-button" data-music-modal-action="create-from-picker">新建歌单</button></div></div>';
    modal.hidden = false;
  }

  function setMusicModalStatus(text, kind) {
    var modal = document.getElementById(MUSIC_MODAL_ID);
    var status = modal && modal.querySelector("[data-role='music-modal-status']");
    if (status) {
      status.textContent = text || "";
      status.dataset.kind = kind || "";
    }
  }

  async function submitMusicPlaylistCreate() {
    var modal = ensureMusicModal();
    var input = modal.querySelector("[data-role='music-playlist-name']");
    var name = input ? input.value : "";
    state.music.busy = true;
    setMusicModalStatus("正在创建…");
    try {
      var playlist = await callApi("/api/music-library/playlists", { method: "POST", body: JSON.stringify({ name: name }) });
      await reloadMusicLibrary();
      if (state.music.createAfter === "add-selected") {
        await addSelectionToMusicPlaylist(playlist.playlistId);
      } else {
        await loadMusicPlaylist(playlist.playlistId);
        clearMusicSelection();
        renderMusicEnhancements();
        closeMusicModal(true);
        musicNotice("已创建“" + playlist.name + "”。", "success");
      }
    } catch (error) {
      setMusicModalStatus(error.message || String(error), "error");
    } finally {
      state.music.busy = false;
      renderMusicToolbar();
    }
  }

  async function addSelectionToMusicPlaylist(playlistId, options) {
    var entries = selectedMusicEntries();
    if (!entries.length) return;
    state.music.busy = true;
    renderMusicToolbar();
    setMusicModalStatus("正在加入歌单…");
    try {
      var result = await callApi("/api/music-library/playlists/" + encodeURIComponent(playlistId) + "/items", {
        method: "POST",
        body: JSON.stringify({ songs: entries.map(serializeMusicSong) })
      });
      await reloadMusicLibrary();
      if (state.music.activePlaylistId === playlistId) await loadMusicPlaylist(playlistId);
      clearMusicSelection();
      renderMusicEnhancements();
      if (!(options && options.keepModal)) closeMusicModal(true);
      musicNotice("已加入 " + result.added + " 首曲目" + (result.updated ? "，更新 " + result.updated + " 首" : "") + "。", "success");
    } catch (error) {
      setMusicModalStatus(error.message || String(error), "error");
      musicNotice("加入歌单失败：" + (error.message || error), "error");
    } finally {
      state.music.busy = false;
      renderMusicToolbar();
    }
  }

  async function removeSelectedFromMusicPlaylist() {
    var playlistId = state.music.activePlaylistId;
    var entries = selectedMusicEntries();
    if (!playlistId || !entries.length) return;
    state.music.busy = true;
    renderMusicToolbar();
    try {
      var result = await callApi("/api/music-library/playlists/" + encodeURIComponent(playlistId) + "/remove", {
        method: "POST",
        body: JSON.stringify({ itemKeys: entries.map(function (entry) { return entry.key; }) })
      });
      await reloadMusicLibrary();
      await loadMusicPlaylist(playlistId);
      clearMusicSelection();
      renderMusicEnhancements();
      musicNotice("已从歌单移出 " + result.removed + " 首曲目。", "success");
    } catch (error) {
      musicNotice("移出歌单失败：" + (error.message || error), "error");
    } finally {
      state.music.busy = false;
      renderMusicToolbar();
    }
  }

  async function callNativeMusicAdd(entry) {
    if (!entry || !entry.song) throw new Error("本地音乐桌面请求缺少曲目资料");
    var song = serializeMusicSong(entry);
    return window.__LOCAL_MUSIC_API__.addToPlaylist({
      itemType: entry.sourceType,
      itemId: song.id != null ? song.id : song.itemId,
      song: song
    });
  }

  async function addSelectedToMusicDesktop() {
    var entries = selectedMusicEntries();
    if (!entries.length) return;
    state.music.busy = true;
    renderMusicToolbar();
    try {
      var completed = 0;
      for (var index = 0; index < entries.length; index += 1) {
        await callNativeMusicAdd(entries[index]);
        completed += 1;
      }
      clearMusicSelection();
      renderMusicEnhancements();
      musicNotice("已加入音乐桌面 " + completed + " 首曲目。", "success");
    } catch (error) {
      musicNotice("加播单在第 " + (completed + 1) + " 首停止：" + (error.message || error), "error");
    } finally {
      state.music.busy = false;
      renderMusicToolbar();
    }
  }

  async function persistMusicSelectionPreference(value) {
    state.music.confirmSelectionClear = Boolean(value);
    try {
      await callApi("/api/music-library/preferences", {
        method: "POST",
        body: JSON.stringify({ confirmSelectionClear: state.music.confirmSelectionClear })
      });
    } catch (error) {
      console.warn("[local-mail] unable to save music library preference", error);
    }
    mountMusicBehaviorSetting();
  }

  function openMusicSwitchConfirm(target) {
    state.music.pendingSwitch = target;
    var modal = ensureMusicModal();
    modal.innerHTML = '<div class="lm-modal lm-music-dialog" role="dialog" aria-modal="true">' +
      '<div class="lm-modal-title">切换曲库</div><div class="lm-music-dialog-copy">切换歌单或曲库分类不会保留当前选中的歌曲，是否继续？</div>' +
      '<label class="lm-music-confirm-check"><input type="checkbox" data-role="music-disable-switch-prompt">不再提示 <span>（可在“设置 - 应用行为”中重新开启）</span></label>' +
      '<div class="lm-modal-actions"><button type="button" class="lm-button" data-music-modal-action="close">取消</button><button type="button" class="lm-button lm-button-primary" data-music-modal-action="confirm-switch">继续切换</button></div></div>';
    modal.hidden = false;
  }

  async function confirmMusicViewSwitch() {
    var modal = ensureMusicModal();
    var disablePrompt = modal.querySelector("[data-role='music-disable-switch-prompt']");
    if (disablePrompt && disablePrompt.checked) await persistMusicSelectionPreference(false);
    var target = state.music.pendingSwitch;
    closeMusicModal();
    performMusicViewSwitch(target);
  }

  function requestMusicViewSwitch(target) {
    var current = isCustomMusicView()
      ? "custom:" + state.music.activePlaylistId
      : "native:" + (state.music.nativeViewName || "");
    var next = target.kind === "custom" ? "custom:" + target.playlistId : "native:" + target.name;
    if (current === next) return;
    if (selectedMusicEntries().length && state.music.confirmSelectionClear) {
      openMusicSwitchConfirm(target);
      return;
    }
    performMusicViewSwitch(target);
  }

  async function performMusicViewSwitch(target) {
    if (!target) return;
    clearMusicSelection();
    if (target.kind === "custom") {
      try {
        await loadMusicPlaylist(target.playlistId);
        renderMusicEnhancements();
      } catch (error) {
        musicNotice("无法打开歌单：" + (error.message || error), "error");
      }
      return;
    }
    state.music.activePlaylistId = null;
    state.music.playlistItems = [];
    state.music.nativeViewName = target.name;
    renderMusicEnhancements();
    state.music.allowNativeTab = target.control;
    target.control.click();
    setTimeout(function () { state.music.allowNativeTab = null; }, 0);
  }

  function ensureMusicNativeTabGuard() {
    if (window.__LOCAL_MAIL_MUSIC_TAB_GUARD__) return;
    window.__LOCAL_MAIL_MUSIC_TAB_GUARD__ = true;
    document.addEventListener("click", function (event) {
      var tab = musicNativeTabFromTarget(event.target);
      if (!tab) return;
      if (state.music.allowNativeTab === tab.control) {
        state.music.activePlaylistId = null;
        state.music.playlistItems = [];
        state.music.nativeViewName = tab.name;
        return;
      }
      var current = isCustomMusicView()
        ? "custom:" + state.music.activePlaylistId
        : "native:" + (state.music.nativeViewName || "");
      var next = "native:" + tab.name;
      if (current === next) return;
      if (selectedMusicEntries().length && state.music.confirmSelectionClear) {
        event.preventDefault();
        event.stopImmediatePropagation();
        openMusicSwitchConfirm({ kind: "native", name: tab.name, control: tab.control });
        return;
      }
      clearMusicSelection();
      state.music.activePlaylistId = null;
      state.music.playlistItems = [];
      state.music.nativeViewName = tab.name;
      renderMusicEnhancements();
    }, true);
  }

  function mountMusicBehaviorSetting() {
    if (!MUSIC_EXPERIMENTAL_UI_ENABLED) {
      var existing = document.getElementById(MUSIC_BEHAVIOR_SETTING_ID);
      if (existing) existing.remove();
      return;
    }
    if (!isSettingsRoute()) return;
    var section = Array.prototype.slice.call(document.querySelectorAll(".tp-settings-item")).find(function (item) {
      var heading = item.firstElementChild;
      return heading && heading.textContent.trim() === "应用行为";
    });
    if (!section) return;
    var row = document.getElementById(MUSIC_BEHAVIOR_SETTING_ID);
    if (!row) {
      row = document.createElement("div");
      row.id = MUSIC_BEHAVIOR_SETTING_ID;
      row.className = "flex items-center justify-between px-0 py-3 rounded-3 lm-music-preference-row";
      row.innerHTML = '<div class="flex flex-col gap-0 flex-1 min-w-0"><div class="text-text-body text-label-l">切换曲库时提醒清空批量选择</div><div class="text-text-secondary text-body-m font-regular">关闭后，切换歌单或曲库分类会直接清空已选曲目。</div></div><label class="lm-music-switch"><input type="checkbox" data-role="music-confirm-selection-clear" aria-label="切换曲库时提醒清空批量选择"></label>';
      section.appendChild(row);
      var checkbox = row.querySelector("[data-role='music-confirm-selection-clear']");
      checkbox.addEventListener("change", function () { persistMusicSelectionPreference(checkbox.checked); });
    }
    var input = row.querySelector("[data-role='music-confirm-selection-clear']");
    if (input) input.checked = state.music.confirmSelectionClear;
    ensureMusicLibraryLoaded();
  }

  function mountDesktopPreferenceStatus() {
    if (!isSettingsRoute()) return;
    var section = Array.prototype.slice.call(document.querySelectorAll(".tp-settings-item")).find(function (item) {
      var heading = item.firstElementChild;
      return heading && heading !== item && String(heading.textContent || "").replace(/\s+/g, " ").trim() === "桌面偏好";
    });
    if (!section) return;
    Array.prototype.slice.call(section.children).slice(1).forEach(function (row) {
      if (row.querySelector("[data-local-desktop-preference-status]")) return;
      var label = Array.prototype.slice.call(row.querySelectorAll("div,label")).find(function (candidate) {
        var text = String(candidate.textContent || "").replace(/\s+/g, " ").trim();
        return candidate.children.length === 0 && (text === "写信" || text === "音乐");
      });
      if (!label) return;
      var marker = document.createElement("span");
      marker.setAttribute("data-local-desktop-preference-status", "true");
      marker.className = "lm-desktop-preference-status";
      marker.textContent = "当前版本未修复";
      label.appendChild(marker);
    });
  }

  function mountMusicEnhancements() {
    if (!document.getElementById("tour-song-list")) return;
    if (!MUSIC_EXPERIMENTAL_UI_ENABLED) {
      renderMusicEnhancements();
      return;
    }
    ensureMusicNativeTabGuard();
    ensureMusicLibraryLoaded();
    renderMusicEnhancements();
  }

  function localMountOwnedNode(node, navigation) {
    if (!node) return false;
    if (navigation && (node === navigation || navigation.contains(node))) return true;
    var id = String(node.id || "");
    if (id === LOCAL_NAVIGATION_ID || id === "local-mail-settings-style" || id === "local-mail-watermark-style") return true;
    return String(node.className || "").split(/\s+/).indexOf("watermark-overlay") !== -1;
  }

  function localMountMutationIgnored(record) {
    var navigation = document.getElementById(LOCAL_NAVIGATION_ID);
    if (!record) return true;
    if (localMountOwnedNode(record.target, navigation)) return true;
    if (record.type === "attributes") return false;
    var addedNodes = record.addedNodes ? Array.prototype.slice.call(record.addedNodes) : [];
    var removedNodes = record.removedNodes ? Array.prototype.slice.call(record.removedNodes) : [];
    if (navigation && removedNodes.indexOf(navigation) !== -1) return false;
    if (navigation && addedNodes.indexOf(navigation) !== -1) {
      return record.target === document.body && navigation.parentElement === document.body
        && removedNodes.length === 0;
    }
    var changedNodes = addedNodes.concat(removedNodes);
    return changedNodes.length > 0 && changedNodes.every(function (node) {
      return localMountOwnedNode(node, navigation) && !(navigation && node === navigation);
    });
  }

  function queueMountForMutations(records) {
    if (!records || !records.length || Array.prototype.some.call(records, function (record) {
      return !localMountMutationIgnored(record);
    })) queueMount();
  }

  var mountQueued = false;
  function queueMount() {
    if (mountQueued) return;
    mountQueued = true;
    window.requestAnimationFrame(function () {
      mountQueued = false;
      startOfficialSettingsDiscovery();
      startDesktopCommandPolling();
      hideWatermark();
      mountLocalNavigation();
      mountDesktopPreferenceStatus();
      mountSettingsSection();
      mountMusicBehaviorSetting();
      mountMusicEnhancements();
      mountMailboxTools();
      scheduleAutomaticUpdateCheck();
    });
  }

  function exposeTestHook() {
    var hook = window.__LOCAL_MAIL_TEST_HOOK__;
    if (!hook || typeof hook !== "object") return;
    hook.renderUpdateModal = renderUpdateModal;
    hook.mountSettingsSection = mountSettingsSection;
    hook.patchVersionSectionHtml = patchVersionSectionHtml;
    hook.sectionHtml = sectionHtml;
    hook.hideWatermark = hideWatermark;
    hook.mountLocalNavigation = mountLocalNavigation;
    hook.queueMount = queueMount;
    hook.navigateLocalRoute = navigateLocalRoute;
    hook.mountDesktopPreferenceStatus = mountDesktopPreferenceStatus;
    hook.findOfficialSettingsStore = findOfficialSettingsStore;
    hook.syncOfficialSettingsStore = syncOfficialSettingsStore;
    hook.pollDesktopCommand = pollDesktopCommand;
    hook.startDesktopCommandPolling = startDesktopCommandPolling;
    hook.isMainRenderer = isMainRenderer;
    hook.navigateDesktopCommand = navigateDesktopCommand;
    hook.renderMusicEnhancements = renderMusicEnhancements;
    hook.addMusicEntryToDesktop = addMusicEntryToDesktop;
    hook.serializeMusicSong = serializeMusicSong;
    hook.callNativeMusicAdd = callNativeMusicAdd;
    hook.localMusicApi = window.__LOCAL_MUSIC_API__;
    hook.localCapabilities = window.__LINLI_LOCAL_CAPABILITIES__;
    hook.musicState = state.music;
  }

  exposeTestHook();

  var observer = new MutationObserver(queueMountForMutations);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("popstate", queueMount);
  window.addEventListener("hashchange", queueMount);
  window.addEventListener("resize", queueMount);
  window.addEventListener("scroll", queueMount, true);
  if (document.head) hideWatermark();
  startOfficialSettingsDiscovery();
  startDesktopCommandPolling();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", queueMount, { once: true });
  else queueMount();
})();
