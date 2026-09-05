
  function mountMusicEnhancements() {
    if (isSettingsRoute() || (!document.getElementById("tour-song-list") && !musicBridgeAvailable())) return;
    if (!musicBridgeAvailable()) {
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
    hook.setMusicFeature = setMusicFeature;
    hook.mountMusicEnhancementSettings = mountMusicEnhancementSettings;
    hook.openMusicDesktopClearConfirm = openMusicDesktopClearConfirm;
    hook.confirmMusicDesktopClear = confirmMusicDesktopClear;
    hook.musicNotice = musicNotice;
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
  window.addEventListener("linli-music-view-ready", queueMount);
  window.addEventListener("resize", queueMount);
  window.addEventListener("scroll", queueMount, true);
  if (document.head) hideWatermark();
  startOfficialSettingsDiscovery();
  startDesktopCommandPolling();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", queueMount, { once: true });
  else queueMount();
})();
