
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
