var customSongsState = {
  busy: false,
  data: null,
  error: "",
  page: 0,
  selected: null,
};

function officialSongStoragePath() {
  var store = findOfficialSettingsStore();
  var candidates = officialWidgetCandidates(store);
  for (var index = 0; index < candidates.length; index += 1) {
    var value = candidates[index].songStoragePath;
    if (value && typeof value === "object") value = value.value;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

async function localCustomSongSearch(params, config) {
  try {
    var data = await callApi("/api/custom-songs/search", {
      method: "POST",
      body: Object.assign({}, params || {}, {
        detectedRoot: officialSongStoragePath(),
      }),
      signal: config && config.signal,
    });
    customSongsState.data = data;
    customSongsState.error = "";
    return data;
  } catch (error) {
    customSongsState.error = error.message || String(error);
    throw error;
  } finally {
    mountCustomSongTools();
  }
}

function mountCustomSongTools() {
  var route = window.location.hash || window.location.pathname;
  var existing = document.getElementById("local-mail-custom-song-tools");
  var view = musicView();
  var visible = /\/studio\/?(?:[?#].*)?$/.test(route.replace(/^#/, "")) && !isCustomMusicView()
    && view && Number(view.sourceType) === 3;
  if (existing) setLocalElementHidden(existing, !visible);
  if (!visible) return;
  var main =
    document.querySelector("#app main") || document.querySelector("main");
  if (!main) return;
  installStyles();
  var toolbar = document.getElementById("local-mail-custom-song-tools");
  if (!toolbar) {
    toolbar = document.createElement("div");
    toolbar.id = "local-mail-custom-song-tools";
    toolbar.className = "lm-import-row";
    toolbar.style.cssText = "padding:8px 16px;gap:12px;flex-wrap:wrap";
    toolbar.innerHTML =
      '<button type="button" class="lm-button lm-button-small" data-custom-manage>管理本地演奏</button><span class="lm-modal-status" role="status"></span>';
    main.appendChild(toolbar);
    toolbar.querySelector("[data-custom-manage]").onclick =
      openCustomSongManager;
  }
  var message =
    customSongsState.error ||
    (customSongsState.data
      ? "本地定制演奏 " +
        customSongsState.data.total +
        " 首" +
        (customSongsState.data.missingPeriods
          ? " · 部分时段复用现有视频，可在管理中校正"
          : "")
      : "“我的上传”可读取已下载的定制演奏");
  setLocalElementText(toolbar.querySelector("[role='status']"), message);
}

function customSongsChanged() {
  window.dispatchEvent(new Event("linli-custom-songs-changed"));
}

async function openCustomSongManager() {
  installStyles();
  var modal = document.getElementById("local-mail-custom-song-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "local-mail-custom-song-modal";
    modal.className = "lm-modal-backdrop";
    modal.innerHTML =
      '<section class="lm-modal" role="dialog" aria-modal="true" aria-labelledby="local-custom-song-title">' +
      '<div class="lm-modal-title" id="local-custom-song-title">本地定制演奏</div>' +
      '<p class="lm-modal-status">读取已下载的演奏视频。曲名和视频时段可手动校正；缺失时段会复用现有视频。</p>' +
      '<label>曲目下载文件夹<input class="lm-input" data-custom-root aria-label="曲目下载文件夹"></label>' +
      '<div class="lm-modal-actions"><button type="button" class="lm-button" data-custom-scan>重新扫描</button></div>' +
      '<label>选择曲目<select class="lm-select" data-custom-song aria-label="选择曲目"></select></label>' +
      '<div class="lm-modal-actions"><button type="button" class="lm-button lm-button-small" data-custom-prev>上一页</button><span data-custom-page></span><button type="button" class="lm-button lm-button-small" data-custom-next>下一页</button></div>' +
      '<label>曲名<input class="lm-input" data-custom-name aria-label="曲名"></label>' +
      '<div data-custom-files></div><p class="lm-modal-status" role="status" data-custom-status></p>' +
      '<div class="lm-modal-actions"><button type="button" class="lm-button" data-custom-close>关闭</button><button type="button" class="lm-button lm-button-primary" data-custom-save>保存</button></div></section>';
    document.body.appendChild(modal);
    modal.querySelector("[data-custom-close]").onclick = function () {
      if (!customSongsState.busy) {
        modal.hidden = true;
        modal.querySelectorAll("video").forEach(function (video) {
          video.pause();
        });
      }
    };
    modal.addEventListener("keydown", function (event) {
      if (event.key === "Escape")
        modal.querySelector("[data-custom-close]").click();
    });
    modal.querySelector("[data-custom-scan]").onclick = function () {
      void loadCustomSongManager(modal, true);
    };
    modal.querySelector("[data-custom-prev]").onclick = function () {
      customSongsState.page = Math.max(0, customSongsState.page - 1);
      void loadCustomSongManager(modal, false);
    };
    modal.querySelector("[data-custom-next]").onclick = function () {
      customSongsState.page += 1;
      void loadCustomSongManager(modal, false);
    };
    modal.querySelector("[data-custom-song]").onchange = function () {
      customSongsState.selected = this.value;
      renderCustomSongEditor(modal);
    };
    modal.querySelector("[data-custom-save]").onclick = function () {
      void saveCustomSongEditor(modal);
    };
  }
  modal.hidden = false;
  modal.querySelector("[data-custom-root]").value =
    (customSongsState.data && customSongsState.data.mediaRoot) || "";
  customSongsState.page = 0;
  await loadCustomSongManager(modal, false);
}

function customSongManagerBusy(modal, busy) {
  customSongsState.busy = busy;
  modal.querySelectorAll("button,input,select").forEach(function (node) {
    node.disabled = busy;
  });
  if (!busy) {
    var data = modal.__customSongsPage;
    modal.querySelector("[data-custom-prev]").disabled =
      !data || customSongsState.page === 0;
    modal.querySelector("[data-custom-next]").disabled = !data || !data.hasMore;
    modal.querySelector("[data-custom-save]").disabled =
      !customSongsState.selected;
  }
}

async function loadCustomSongManager(modal, scan) {
  if (customSongsState.busy) return;
  customSongManagerBusy(modal, true);
  var status = modal.querySelector("[data-custom-status]");
  status.textContent = scan ? "正在扫描本地视频…" : "正在读取曲目…";
  try {
    var root =
      modal.querySelector("[data-custom-root]").value.trim() || undefined;
    if (scan) {
      await callApi("/api/custom-songs/scan", {
        method: "POST",
        body: { mediaRoot: root },
      });
      customSongsState.page = 0;
    }
    var data = await callApi("/api/custom-songs/search", {
      method: "POST",
      body: {
        mediaRoot: root,
        detectedRoot: officialSongStoragePath(),
        cursor: customSongsState.page * 100,
        pageSize: 100,
      },
    });
    modal.__customSongsPage = data;
    customSongsState.data = data;
    customSongsState.error = "";
    modal.querySelector("[data-custom-root]").value = data.mediaRoot;
    var select = modal.querySelector("[data-custom-song]");
    select.innerHTML = "";
    data.list.forEach(function (song) {
      var option = document.createElement("option");
      option.value = song.nameKey;
      option.textContent = song.name;
      select.appendChild(option);
    });
    select.value = data.list.some(function (song) {
      return song.nameKey === customSongsState.selected;
    })
      ? customSongsState.selected
      : (data.list[0] && data.list[0].nameKey) || "";
    customSongsState.selected = select.value;
    modal.querySelector("[data-custom-page]").textContent =
      "共 " + data.total + " 首 · 第 " + (customSongsState.page + 1) + " 页";
    status.textContent = data.list.length
      ? "已读取。关闭管理窗口后，可在“我的上传”中试听或演奏。"
      : "未找到可用的定制演奏视频。请检查下载文件夹。";
    if (data.warnings && data.warnings.length)
      status.textContent += "\n" + data.warnings.join("\n");
    renderCustomSongEditor(modal);
    if (scan) customSongsChanged();
  } catch (error) {
    customSongsState.error = error.message || String(error);
    status.textContent = customSongsState.error;
    modal.__customSongsPage = null;
    customSongsState.selected = null;
    modal.querySelector("[data-custom-song]").innerHTML = "";
    modal.querySelector("[data-custom-page]").textContent = "";
    renderCustomSongEditor(modal);
  } finally {
    customSongManagerBusy(modal, false);
    mountCustomSongTools();
  }
}

function renderCustomSongEditor(modal) {
  var data = modal.__customSongsPage;
  var song =
    data &&
    data.list.find(function (item) {
      return item.nameKey === customSongsState.selected;
    });
  var container = modal.querySelector("[data-custom-files]");
  container.querySelectorAll("video").forEach(function (video) {
    video.pause();
  });
  container.innerHTML = "";
  modal.querySelector("[data-custom-name]").value = song ? song.name : "";
  if (!song) return;
  var note = document.createElement("p");
  note.className = "lm-modal-status";
  note.textContent = song.fallbackPeriods.length
    ? "部分时段未确认或缺失，当前复用现有视频。可预览后设置对应时段。"
    : "各时段已匹配。";
  container.appendChild(note);
  song.localFiles.forEach(function (file) {
    var row = document.createElement("div");
    row.style.cssText = "margin-top:12px";
    var label = document.createElement("label");
    label.className = "lm-modal-status";
    label.textContent = file.fileName;
    var select = document.createElement("select");
    select.className = "lm-select";
    select.setAttribute("data-custom-file", file.fileName);
    select.setAttribute("aria-label", "视频时段 " + file.fileName);
    [
      ["", "时段未知"],
      ["TOD12", "白天"],
      ["TOD1730", "傍晚"],
      ["TOD20", "夜晚"],
    ].forEach(function (period) {
      var option = document.createElement("option");
      option.value = period[0];
      option.textContent = period[1];
      select.appendChild(option);
    });
    select.value = file.tod || "";
    var details = document.createElement("details");
    var summary = document.createElement("summary");
    summary.textContent = "预览视频";
    var video = document.createElement("video");
    video.controls = true;
    video.preload = "none";
    video.src = file.url;
    video.style.cssText = "width:100%;max-height:200px";
    details.appendChild(summary);
    details.appendChild(video);
    row.appendChild(label);
    row.appendChild(select);
    row.appendChild(details);
    container.appendChild(row);
  });
}

async function saveCustomSongEditor(modal) {
  if (customSongsState.busy || !customSongsState.selected) return;
  customSongManagerBusy(modal, true);
  try {
    var saved = await callApi("/api/custom-songs/update", {
      method: "POST",
      body: {
        nameKey: customSongsState.selected,
        name: modal.querySelector("[data-custom-name]").value,
        mappings: Array.prototype.map.call(
          modal.querySelectorAll("[data-custom-file]"),
          function (select) {
            return {
              fileName: select.getAttribute("data-custom-file"),
              tod: select.value || null,
            };
          },
        ),
      },
    });
    if (!saved) throw new Error("本地视频已移动或无法读取，请重新扫描。");
    var page = modal.__customSongsPage;
    if (page)
      page.list = page.list.map(function (song) {
        return song.nameKey === saved.nameKey ? saved : song;
      });
    Array.prototype.forEach.call(
      modal.querySelector("[data-custom-song]").options,
      function (option) {
        if (option.value === saved.nameKey) option.textContent = saved.name;
      },
    );
    customSongsChanged();
    modal.querySelector("[data-custom-status]").textContent = "已保存。";
  } catch (error) {
    modal.querySelector("[data-custom-status]").textContent =
      error.message || String(error);
  } finally {
    customSongManagerBusy(modal, false);
  }
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
  if (
    state.music.nativeViewName === "我的上传" ||
    song.userSongId != null ||
    song.shareCode !== undefined
  )
    return 3;
  return 2;
}

async function addMusicEntryToDesktop(entry) {
  if (entry) return addMusicEntriesToDesktop([entry]);
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
  if (
    node.parentElement === anchor.parentElement &&
    nextLocalElement(anchor) === node
  )
    return;
  anchor.insertAdjacentElement("afterend", node);
}

function updateCustomMusicCover(host, song) {
  var cover = musicCoverValue(song);
  var coverValue = String(cover || "");
  if (host.__linliMusicCoverValue === coverValue && host.firstElementChild)
    return;
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

function setMusicModalStatus(text, kind) {
  var modal = document.getElementById(MUSIC_MODAL_ID);
  var status = modal && modal.querySelector("[data-role='music-modal-status']");
  if (status) {
    status.textContent = text || "";
    status.dataset.kind = kind || "";
  }
}

async function callNativeMusicAdd(entry) {
  if (!entry || !entry.song) throw new Error("本地音乐桌面请求缺少曲目资料");
  return musicApi().addToDesktopBatch([entry]);
}

async function addSelectedToMusicDesktop() {
  return addMusicEntriesToDesktop(selectedMusicEntries());
}
async function addMusicEntriesToDesktop(entries) {
  if (!entries.length || !beginMusicOperation()) return;
  try {
    var result = await musicApi().addToDesktopBatch(entries);
    (result.completedKeys || []).forEach(function (key) {
      delete musicShape().selected[key];
    });
    (result.failedKeys || []).forEach(function (key) {
      var entry = entries.find(function (item) {
        return item.key === key;
      });
      if (entry) musicShape().selected[key] = entry;
    });
    if ((result.failedKeys || []).length) musicShape().batchMode = true;
    musicNotice(
      result.error ||
        "已加入播放队列 " + (result.completedKeys || []).length + " 首曲目。",
      result.error ? "error" : "success",
    );
  } catch (error) {
    musicNotice(
      "加播单失败：" + (error.message || error) + "；未完成选择已保留。",
      "error",
    );
  } finally {
    endMusicOperation();
  }
}

async function persistMusicSelectionPreference(value) {
  var previous = state.music.confirmSelectionClear;
  state.music.confirmSelectionClear = Boolean(value);
  try {
    await callApi("/api/music-library/preferences", {
      method: "POST",
      body: { confirmSelectionClear: state.music.confirmSelectionClear },
    });
  } catch (error) {
    state.music.confirmSelectionClear = previous;
    musicNotice("偏好保存失败：" + (error.message || error), "error");
  }
  mountMusicBehaviorSetting();
}

function openMusicSwitchConfirm(target) {
  state.music.pendingSwitch = target;
  var modal = ensureMusicModal();
  modal.innerHTML =
    '<div class="lm-modal lm-music-dialog" role="dialog" aria-modal="true">' +
    '<div class="lm-modal-title">切换曲库</div><div class="lm-music-dialog-copy">切换歌单或曲库分类不会保留当前选中的歌曲，是否继续？</div>' +
    '<label class="lm-music-confirm-check"><input type="checkbox" data-role="music-disable-switch-prompt">不再提示 <span>（可在“设置 - 应用行为”中重新开启）</span></label>' +
    '<div class="lm-modal-actions"><button type="button" class="lm-button" data-music-modal-action="close">取消</button><button type="button" class="lm-button lm-button-primary" data-music-modal-action="confirm-switch">继续切换</button></div></div>';
  modal.hidden = false;
}

async function confirmMusicViewSwitch() {
  var modal = ensureMusicModal();
  var disablePrompt = modal.querySelector(
    "[data-role='music-disable-switch-prompt']",
  );
  if (disablePrompt && disablePrompt.checked)
    await persistMusicSelectionPreference(false);
  var target = state.music.pendingSwitch;
  closeMusicModal();
  performMusicViewSwitch(target);
}

function requestMusicViewSwitch(target) {
  var current = isCustomMusicView()
    ? "custom:" + state.music.activePlaylistId
    : "native:" + (state.music.nativeViewName || "");
  var next =
    target.kind === "custom"
      ? "custom:" + target.playlistId
      : "native:" + target.name;
  if (musicShape().busy || current === next) return;
  if (selectedMusicEntries().length && state.music.confirmSelectionClear) {
    openMusicSwitchConfirm(target);
    return;
  }
  performMusicViewSwitch(target);
}

async function performMusicViewSwitch(target) {
  if (!target || !musicBridgeAvailable() || !beginMusicOperation()) return;
  var music = musicShape(),
    generation = ++music.viewGeneration;
  try {
    if (target.kind === "custom")
      await loadMusicPlaylist(target.playlistId, generation);
    else {
      await window.__LINLI_MUSIC_BRIDGE__.switchView(target.name);
      music.activePlaylistId = null;
      music.playlistItems = [];
      music.nativeViewName = target.name;
      music.selectableEntries = [];
      music.selectableViewKey = "";
    }
    clearMusicSelection();
  } catch (error) {
    musicNotice("无法切换列表：" + (error.message || error), "error");
  } finally {
    endMusicOperation();
  }
}

function ensureMusicNativeTabGuard() {
  if (window.__LOCAL_MAIL_MUSIC_TAB_GUARD__) return;
  window.__LOCAL_MAIL_MUSIC_TAB_GUARD__ = true;
  document.addEventListener(
    "click",
    function (event) {
      if (!musicBridgeAvailable()) return;
      var tab = musicNativeTabFromTarget(event.target);
      if (!tab) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!musicShape().busy)
        requestMusicViewSwitch({ kind: "native", name: tab.name });
    },
    true,
  );
}

function mountMusicBehaviorSetting() {
  if (!musicShape().loaded && !musicBridgeAvailable()) {
    var existing = document.getElementById(MUSIC_BEHAVIOR_SETTING_ID);
    if (existing) existing.remove();
    return;
  }
  if (!isSettingsRoute()) return;
  var section = Array.prototype.slice
    .call(document.querySelectorAll(".tp-settings-item"))
    .find(function (item) {
      var heading = item.firstElementChild;
      return heading && heading.textContent.trim() === "应用行为";
    });
  if (!section) return;
  var row = document.getElementById(MUSIC_BEHAVIOR_SETTING_ID);
  if (!row) {
    row = document.createElement("div");
    row.id = MUSIC_BEHAVIOR_SETTING_ID;
    row.className =
      "flex items-center justify-between px-0 py-3 rounded-3 lm-music-preference-row";
    row.innerHTML =
      '<div class="flex flex-col gap-0 flex-1 min-w-0"><div class="text-text-body text-label-l">切换曲库时提醒清空批量选择</div><div class="text-text-secondary text-body-m font-regular">关闭后，切换歌单或曲库分类会直接清空已选曲目。</div></div><label class="lm-music-switch"><input type="checkbox" data-role="music-confirm-selection-clear" aria-label="切换曲库时提醒清空批量选择"></label>';
    section.appendChild(row);
    var checkbox = row.querySelector(
      "[data-role='music-confirm-selection-clear']",
    );
    checkbox.addEventListener("change", function () {
      persistMusicSelectionPreference(checkbox.checked);
    });
  }
  var input = row.querySelector("[data-role='music-confirm-selection-clear']");
  if (input) input.checked = state.music.confirmSelectionClear;
  ensureMusicLibraryLoaded();
}

function mountDesktopPreferenceStatus() {
  if (!isSettingsRoute()) return;
  var section = Array.prototype.slice
    .call(document.querySelectorAll(".tp-settings-item"))
    .find(function (item) {
      var heading = item.firstElementChild;
      return (
        heading &&
        heading !== item &&
        String(heading.textContent || "")
          .replace(/\s+/g, " ")
          .trim() === "桌面偏好"
      );
    });
  if (!section) return;
  Array.prototype.slice
    .call(section.children)
    .slice(1)
    .forEach(function (row) {
      if (row.querySelector("[data-local-desktop-preference-status]")) return;
      var label = Array.prototype.slice
        .call(row.querySelectorAll("div,label"))
        .find(function (candidate) {
          var text = String(candidate.textContent || "")
            .replace(/\s+/g, " ")
            .trim();
          return (
            candidate.children.length === 0 &&
            (text === "写信" || text === "音乐")
          );
        });
      if (!label) return;
      var marker = document.createElement("span");
      marker.setAttribute("data-local-desktop-preference-status", "true");
      marker.className = "lm-desktop-preference-status";
      marker.textContent = "当前版本未修复";
      label.appendChild(marker);
    });
}

// Ordered reference playlists; live catalogs remain the authority for playback.
function musicSection() {
  var list = document.getElementById("tour-song-list");
  var candidate = list
    ? list.parentElement
    : musicTabControlIn(document, "我的上传");
  var fallback = null;
  while (candidate && candidate !== document) {
    var header = musicHeaderIn(candidate);
    if (header && !fallback) fallback = candidate;
    if (
      header &&
      MUSIC_NATIVE_TAB_NAMES.some(function (name) {
        return Boolean(musicTabControlIn(candidate, name));
      })
    )
      return candidate;
    candidate = candidate.parentElement;
  }
  return fallback || (list && list.parentElement) || document.body;
}

function musicHeader() {
  return musicHeaderIn(musicSection());
}
function musicTabControlForLabel(label) {
  return musicTabControlIn(musicSection(), label);
}
function musicNativeTabs() {
  return MUSIC_NATIVE_TAB_NAMES.map(function (name) {
    return { name: name, control: musicTabControlForLabel(name) };
  }).filter(function (item) {
    return item.control;
  });
}
function musicNativeTabFromTarget(target) {
  return (
    musicNativeTabs().find(function (item) {
      return item.control && item.control.contains(target);
    }) || null
  );
}

function musicShape() {
  var music = state.music;
  if (!music.selected) music.selected = {};
  if (!hasOwn(music, "libraryGeneration")) music.libraryGeneration = 0;
  if (!hasOwn(music, "viewGeneration")) music.viewGeneration = 0;
  if (!hasOwn(music, "selectableEntries")) music.selectableEntries = [];
  if (!hasOwn(music, "selectableViewKey")) music.selectableViewKey = "";
  if (!hasOwn(music, "pendingSwitch")) music.pendingSwitch = null;
  if (!hasOwn(music, "modalMode")) music.modalMode = "";
  if (!hasOwn(music, "createAfter")) music.createAfter = null;
  return music;
}
var MUSIC_FEATURE_KEYS = ["customPlaylistsEnabled", "batchOperationsEnabled", "desktopClearEnabled"];
function musicFeatureEnabled(key) {
  return !musicShape().features || musicShape().features[key] !== false;
}
async function setMusicFeature(key, value) {
  if (MUSIC_FEATURE_KEYS.indexOf(key) < 0) throw new Error("增强功能选项无效");
  var music = musicShape();
  music.featureSaving = music.featureSaving || {};
  if (music.featureSaving[key]) return;
  if (music.busy) throw new Error("请等待当前音乐操作完成后再更改设置");
  var previous = musicFeatureEnabled(key);
  var patch = {}; patch[key] = Boolean(value);
  // Keep the clicked state visible during persistence. Each request owns one key.
  music.features = Object.assign({}, music.features || {}, patch);
  music.featureSaving[key] = true;
  if (typeof mountMusicEnhancementSettings === "function") mountMusicEnhancementSettings();
  try {
    await callApi("/api/music-library/preferences", { method: "POST", body: patch });
    music.features = Object.assign({}, music.features || {}, patch);
    if (key === "batchOperationsEnabled" && !value) { music.batchMode = false; clearMusicSelection(); }
    if (key === "customPlaylistsEnabled" && !value && isCustomMusicView()) {
      music.viewGeneration += 1;
      music.activePlaylistId = null;
      music.playlistItems = [];
      music.selectableViewKey = "";
      music.selectableEntries = [];
      clearMusicSelection();
      closeMusicModal(true);
    }
    renderMusicEnhancements();
  } catch (error) {
    music.features[key] = previous;
    renderMusicEnhancements();
    throw error;
  } finally {
    music.featureSaving[key] = false;
    if (typeof mountMusicEnhancementSettings === "function") mountMusicEnhancementSettings();
  }
}
function musicApi() {
  return window.__LOCAL_MUSIC_API__ || {};
}
function musicView() {
  var bridge = window.__LINLI_MUSIC_BRIDGE__;
  if (!bridge || typeof bridge.getView !== "function") return null;
  try {
    return bridge.getView() || null;
  } catch (error) {
    return null;
  }
}
function musicViewKey() {
  var view = musicView();
  return view && view.viewKey != null ? String(view.viewKey) : "";
}
function musicItemId(song) {
  return (
    song &&
    (song.itemId != null
      ? song.itemId
      : song.id != null
        ? song.id
        : song.userSongId != null
          ? song.userSongId
          : song.songId)
  );
}
function musicEntryFromSong(song, sourceType, extra) {
  if (!song || typeof song !== "object") return null;
  var id = musicItemId(song);
  if (id == null || String(id).trim() === "") return null;
  var data = extra || {};
  var key =
    data.key ||
    data.itemKey ||
    song.itemKey ||
    String(sourceType) + ":" + String(id);
  var normalized = Object.assign({}, song, { itemId: id });
  if (normalized.id == null) normalized.id = id;
  if (normalized.sourceType == null) normalized.sourceType = sourceType;
  return {
    key: String(key),
    itemKey: String(data.itemKey || key),
    sourceType: sourceType,
    itemId: id,
    song: normalized,
    available: data.available !== false,
    reason: data.reason || "",
    displayCache: data.displayCache || null,
    row: data.row || null,
  };
}
function bridgeEntries() {
  var view = musicView();
  return view && Array.isArray(view.songs)
    ? view.songs
        .map(function (song) {
          return musicEntryFromSong(song, view.sourceType, {
            itemKey: song && song.itemKey,
          });
        })
        .filter(Boolean)
    : [];
}
function nativeRows() {
  var list = document.getElementById("tour-song-list");
  if (!list) return [];
  var rows = Array.prototype.slice.call(list.querySelectorAll(".song-item"));
  if (rows.length) return rows;
  rows = Array.prototype.slice.call(list.children || []);
  return rows.length
    ? rows
    : Array.prototype.slice.call(
        list.querySelectorAll(".song-item, [data-song-id], [class*='song']"),
      );
}
function nativeMusicEntries() {
  var rows = nativeRows(),
    view = musicView(),
    currentKey = view && String(view.viewKey || "");
  var source =
    musicShape().selectableViewKey === currentKey
      ? musicShape().selectableEntries
      : bridgeEntries();
  return source.map(function (entry) {
    var row =
      rows.find(function (candidate) {
        if (candidate.getAttribute("data-linli-song-id") != null)
          return String(candidate.getAttribute("data-linli-song-id")) === String(entry.itemId);
        var component = musicSongComponent(candidate);
        return (
          component &&
          String(musicItemId(component.props.song)) === String(entry.itemId)
        );
      }) || null;
    return Object.assign({}, entry, { row: row });
  });
}
function isCustomMusicView() {
  return Boolean(musicShape().activePlaylistId);
}
function customMusicEntries() {
  return (musicShape().playlistItems || [])
    .map(function (item) {
      var cache =
        item.displayCache && typeof item.displayCache === "object"
          ? item.displayCache
          : {};
      return musicEntryFromSong(item.song || cache, item.sourceType, {
        key: item.key || item.itemKey,
        itemKey: item.itemKey || item.key,
        available: item.available,
        reason: item.reason,
        displayCache: cache,
      });
    })
    .filter(Boolean);
}
function visibleMusicEntries() {
  return isCustomMusicView() ? customMusicEntries() : nativeMusicEntries();
}
function selectedMusicEntries() {
  var selected = musicShape().selected;
  return visibleMusicEntries().filter(function (entry) {
    return Boolean(selected[entry.key]);
  });
}
function clearMusicSelection() {
  musicShape().selected = {};
}

function serializeMusicSong(entry) {
  var song = Object.assign({}, (entry && entry.song) || {}),
    id = entry && entry.itemId != null ? entry.itemId : musicItemId(song);
  if (id == null || String(id).trim() === "")
    throw new Error("本地音乐曲目缺少编号");
  song.itemId = id;
  if (song.id == null) song.id = id;
  if (entry && entry.sourceType != null && song.sourceType == null)
    song.sourceType = entry.sourceType;
  var cover = song.coverUrl || song.iconUrl || song.cover || song.icon;
  if (cover)
    ["coverUrl", "iconUrl", "cover", "icon"].forEach(function (key) {
      if (!song[key]) song[key] = cover;
    });
  var nameKey = song.nameKey || song.songNameKey;
  if (nameKey) {
    if (!song.nameKey) song.nameKey = nameKey;
    if (!song.songNameKey) song.songNameKey = nameKey;
  }
  return song;
}
function setLocalElementText(element, value) {
  var text = value == null ? "" : String(value);
  if (element && element.textContent !== text) element.textContent = text;
}
function setLocalElementHidden(element, value) {
  if (element) element.hidden = Boolean(value);
}
function setLocalElementDisabled(element, value) {
  if (element) element.disabled = Boolean(value);
}
function setLocalElementChecked(element, value) {
  if (element) element.checked = Boolean(value);
}
function musicNotice(text, kind) {
  if (!text) return;
  var bridge = window.__LINLI_MUSIC_BRIDGE__;
  if (bridge && typeof bridge.notify === "function") { bridge.notify(String(text), kind || "success"); return; }
  var nativeNotify = window.__LINLI_NATIVE_NOTIFY__;
  if (typeof nativeNotify === "function") { nativeNotify(String(text), kind || "success"); return; }
  // Compatibility fallback for a renderer using an older native bridge.
  var toast = document.getElementById("local-mail-music-toast");
  if (!toast) { toast = document.createElement("div"); toast.id = "local-mail-music-toast";
    toast.className = "lm-music-toast"; toast.setAttribute("role", "status"); document.body.appendChild(toast); }
  setLocalElementText(toast, text); toast.hidden = false;
  clearTimeout(musicShape().noticeTimer);
  musicShape().noticeTimer = setTimeout(function () { toast.hidden = true; }, 3000);
  var modal = document.getElementById(MUSIC_MODAL_ID);
  if (kind === "error" && modal && !modal.hidden && modal.firstElementChild) {
    var alert = modal.querySelector("[data-music-error]");
    if (!alert) { alert = document.createElement("div"); alert.setAttribute("data-music-error", "true"); alert.setAttribute("role", "alert"); modal.firstElementChild.appendChild(alert); }
    setLocalElementText(alert, text);
  }
}
function musicByteLength(value) {
  var text = JSON.stringify(value);
  if (typeof TextEncoder === "function")
    return new TextEncoder().encode(text).length;
  try {
    return unescape(encodeURIComponent(text)).length;
  } catch (error) {
    return text.length;
  }
}
function musicChunks(entries, mapper) {
  var chunks = [],
    current = [],
    limit = 1024 * 1024;
  entries.forEach(function (entry) {
    var next = current.concat([entry]);
    var bytes = musicByteLength({ songs: next.map(mapper) });
    if (current.length && (current.length >= 200 || bytes > limit)) {
      chunks.push(current);
      current = [entry];
    } else current = next;
  });
  if (current.length) chunks.push(current);
  return chunks;
}
function beginMusicOperation() {
  var music = musicShape();
  if (music.busy) return false;
  music.busy = true;
  renderMusicEnhancements();
  return true;
}
function endMusicOperation() {
  musicShape().busy = false;
  renderMusicEnhancements();
  mountMusicBehaviorSetting();
}

async function ensureMusicLibraryLoaded(force) {
  if (!musicBridgeAvailable() && !isSettingsRoute()) return;
  var music = musicShape();
  if ((music.loaded && !force) || (music.loading && !force)) return;
  var generation = ++music.libraryGeneration;
  music.loading = true;
  try {
    var data = await callApi("/api/music-library");
    if (generation !== music.libraryGeneration) return;
    music.playlists = Array.isArray(data.playlists) ? data.playlists : [];
    music.confirmSelectionClear =
      !data.preferences || data.preferences.confirmSelectionClear !== false;
    music.features = Object.assign({}, data.preferences || {}, music.featureSaving && MUSIC_FEATURE_KEYS.reduce(function (kept, key) {
      if (music.featureSaving[key]) kept[key] = musicFeatureEnabled(key); return kept;
    }, {}));
    music.loaded = true;
  } catch (error) {
    if (generation === music.libraryGeneration)
      musicNotice("自定义歌单读取失败：" + (error.message || error), "error");
  } finally {
    if (generation === music.libraryGeneration) {
      music.loading = false;
      renderMusicEnhancements();
      mountMusicBehaviorSetting();
      if (typeof mountMusicEnhancementSettings === "function") mountMusicEnhancementSettings();
    }
  }
}
async function reloadMusicLibrary() {
  musicShape().loaded = false;
  return ensureMusicLibraryLoaded(true);
}
async function resolvePlaylistEntries(items) {
  var api = musicApi();
  if (typeof api.resolveReferences !== "function")
    throw new Error("歌曲引用解析器尚未就绪");
  var resolved = await api.resolveReferences(Array.isArray(items) ? items : []);
  return Array.isArray(resolved)
    ? resolved
    : resolved && Array.isArray(resolved.items)
      ? resolved.items
      : [];
}
async function loadMusicPlaylist(playlistId, generation) {
  var detail = await callApi(
    "/api/music-library/playlists/" + encodeURIComponent(playlistId),
  );
  var items = await resolvePlaylistEntries(detail && detail.items);
  if (generation != null && generation !== musicShape().viewGeneration)
    return false;
  var music = musicShape();
  music.activePlaylistId = detail.playlist.playlistId;
  music.nativeViewName = null;
  music.playlistItems = items;
  music.selectableEntries = customMusicEntries();
  music.selectableViewKey = "custom:" + String(playlistId);
  return true;
}
async function loadSelectableEntries(generation, force) {
  var music = musicShape(),
    key = musicViewKey();
  if (
    !force &&
    music.selectableViewKey === key &&
    music.selectableEntries.length
  )
    return music.selectableEntries;
  var api = musicApi(),
    entries =
      typeof api.listSelectableSongs === "function"
        ? await api.listSelectableSongs()
        : bridgeEntries();
  if (generation != null && generation !== music.viewGeneration) return [];
  music.selectableEntries = (Array.isArray(entries) ? entries : [])
    .map(function (entry) {
      return musicEntryFromSong(entry.song || {}, entry.sourceType, entry);
    })
    .filter(Boolean);
  music.selectableViewKey = key;
  return music.selectableEntries;
}

function renderMusicUnavailableTab() {
  if (!musicFeatureEnabled("customPlaylistsEnabled")) return;
  var nativeTabs = musicNativeTabs();
  if (!nativeTabs.length) return;
  var tabs = document.getElementById(MUSIC_CUSTOM_TABS_ID);
  if (!tabs) {
    tabs = document.createElement("div");
    tabs.id = MUSIC_CUSTOM_TABS_ID;
    tabs.className = "lm-music-playlists";
  }
  placeLocalElementAfter(nativeTabs[nativeTabs.length - 1].control, tabs);
  var markup =
    '<button type="button" class="lm-music-tab" disabled title="需要原生音乐桥接才能使用自定义歌单">＋ 自定义歌单（需要音乐桥接）</button>';
  if (tabs.dataset.unavailable !== "true") {
    tabs.innerHTML = markup;
    tabs.dataset.unavailable = "true";
    tabs.onclick = null;
  }
}
function renderMusicTabs() {
  var nativeTabs = musicNativeTabs();
  if (!nativeTabs.length) return;
  var tabs = document.getElementById(MUSIC_CUSTOM_TABS_ID);
  if (!tabs) {
    tabs = document.createElement("div");
    tabs.id = MUSIC_CUSTOM_TABS_ID;
    tabs.className = "lm-music-playlists";
    tabs.setAttribute("aria-label", "自定义歌单");
  }
  placeLocalElementAfter(nativeTabs[nativeTabs.length - 1].control, tabs);
  setLocalElementHidden(tabs, !musicFeatureEnabled("customPlaylistsEnabled"));
  if (tabs.parentElement) {
    tabs.parentElement.setAttribute("data-lm-music-tab-parent", "true");
    var menu = tabs.closest("[role='menubar']");
    if (menu) menu.setAttribute("data-lm-music-tab-menu", "true");
  }
  if (tabs.dataset.unavailable === "true") {
    tabs.innerHTML = "";
    delete tabs.dataset.unavailable;
  }
  tabs.onclick = function (event) {
    var action = event.target.closest("[data-music-action]");
    if (!action || action.disabled) return;
    if (action.dataset.musicAction === "new-playlist") openMusicCreateDialog();
    if (action.dataset.musicAction === "switch-playlist")
      requestMusicViewSwitch({
        kind: "custom",
        playlistId: action.dataset.playlistId,
      });
  };
  var newButton = tabs.querySelector("[data-music-action='new-playlist']");
  if (!newButton) {
    newButton = document.createElement("button");
    newButton.type = "button";
    newButton.className = "lm-music-new-playlist";
    newButton.dataset.musicAction = "new-playlist";
    tabs.insertBefore(newButton, tabs.firstElementChild);
  }
  setLocalElementText(newButton, "＋ 自定义歌单");
  setLocalElementDisabled(newButton, musicShape().busy);
  var cursor = newButton,
    retained = [],
    playlists = musicShape().playlists || [];
  playlists.forEach(function (playlist) {
    var id = String(playlist.playlistId),
      button = Array.prototype.slice
        .call(tabs.querySelectorAll("[data-music-action='switch-playlist']"))
        .find(function (item) {
          return item.dataset.playlistId === id;
        });
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "lm-music-tab";
      button.dataset.musicAction = "switch-playlist";
    }
    button.dataset.playlistId = id;
    button.dataset.active = String(
      String(musicShape().activePlaylistId || "") === id,
    );
    setLocalElementText(button, playlist.name || "未命名歌单");
    setLocalElementDisabled(button, musicShape().busy);
    if (nextLocalElement(cursor) !== button)
      tabs.insertBefore(button, nextLocalElement(cursor));
    cursor = button;
    retained.push(button);
  });
  Array.prototype.forEach.call(
    tabs.querySelectorAll("[data-music-action='switch-playlist']"),
    function (button) {
      if (retained.indexOf(button) < 0) button.remove();
    },
  );
}
function renderMusicToolbar() {
  var header = musicHeader();
  if (!header) return;
  var toolbar = document.getElementById(MUSIC_TOOLBAR_ID);
  if (!toolbar) {
    toolbar = document.createElement("div");
    toolbar.id = MUSIC_TOOLBAR_ID;
    toolbar.className = "lm-music-toolbar";
    header.parentElement.insertBefore(toolbar, header);
  }
  if (toolbar.parentElement !== header.parentElement || nextLocalElement(toolbar) !== header)
    header.parentElement.insertBefore(toolbar, header);
  if (!toolbar.querySelector("[data-role='selected-count']"))
    toolbar.innerHTML =
      '<button type="button" class="lm-music-action" data-music-action="begin-batch">批量选择</button><label data-role="select-all-wrap">全选<input class="lm-music-checkbox" type="checkbox" aria-label="全选曲目" data-music-action="select-all"></label><button type="button" class="lm-music-action" data-music-action="add-desktop">加播单</button><button type="button" class="lm-music-action" data-music-action="add-playlist">加入歌单</button><button type="button" class="lm-music-action" data-music-action="remove-playlist">移出歌单</button><button type="button" class="lm-music-action" data-music-action="rename-playlist">重命名</button><button type="button" class="lm-music-action" data-music-action="delete-playlist">删除歌单</button><span data-role="selected-count"></span><button type="button" class="lm-music-action" data-music-action="end-batch">完成</button>';
  toolbar.onclick = function (event) {
    var button = event.target.closest("[data-music-action]");
    if (!button || button.disabled || musicShape().busy) return;
    var action = button.dataset.musicAction;
    if (action === "begin-batch") {
      musicShape().batchMode = true;
      renderMusicEnhancements();
    } else if (action === "end-batch") {
      musicShape().batchMode = false;
      clearMusicSelection();
      renderMusicEnhancements();
    } else if (action === "add-desktop") void addSelectedToMusicDesktop();
    else if (action === "add-playlist") openMusicPlaylistPicker();
    else if (action === "remove-playlist")
      void removeSelectedFromMusicPlaylist();
    else if (action === "rename-playlist") openMusicRenameDialog();
    else if (action === "delete-playlist") openMusicDeleteDialog();
  };
  toolbar.onchange = async function (event) {
    var checkbox = event.target.closest("[data-music-action='select-all']");
    if (!checkbox || musicShape().busy) return;
    var checked = checkbox.checked,
      generation = musicShape().viewGeneration;
    if (!beginMusicOperation()) return;
    try {
      var entries = isCustomMusicView()
        ? customMusicEntries()
        : await loadSelectableEntries(generation, true);
      entries.forEach(function (entry) {
        if (checked) musicShape().selected[entry.key] = entry;
        else delete musicShape().selected[entry.key];
      });
    } catch (error) {
      musicNotice("选择失败：" + (error.message || error), "error");
    } finally {
      endMusicOperation();
    }
  };
  var music = musicShape(),
    entries = visibleMusicEntries(),
    selected = selectedMusicEntries().length,
    batch = Boolean(music.batchMode),
    disabled = music.busy || !selected;
  setLocalElementHidden(
    toolbar.querySelector("[data-music-action='begin-batch']"),
    batch || !musicFeatureEnabled("batchOperationsEnabled"),
  );
  setLocalElementHidden(
    toolbar.querySelector("[data-role='select-all-wrap']"),
    !batch,
  );
  setLocalElementHidden(
    toolbar.querySelector("[data-music-action='add-desktop']"),
    !batch,
  );
  setLocalElementHidden(
    toolbar.querySelector("[data-music-action='add-playlist']"),
    !batch || !musicFeatureEnabled("customPlaylistsEnabled"),
  );
  setLocalElementHidden(
    toolbar.querySelector("[data-music-action='remove-playlist']"),
    !batch || !isCustomMusicView(),
  );
  setLocalElementHidden(
    toolbar.querySelector("[data-music-action='rename-playlist']"),
    !isCustomMusicView(),
  );
  setLocalElementHidden(
    toolbar.querySelector("[data-music-action='delete-playlist']"),
    !isCustomMusicView(),
  );
  setLocalElementHidden(
    toolbar.querySelector("[data-role='selected-count']"),
    !batch,
  );
  setLocalElementHidden(
    toolbar.querySelector("[data-music-action='end-batch']"),
    !batch,
  );
  ["add-desktop", "add-playlist", "remove-playlist"].forEach(function (action) {
    setLocalElementDisabled(
      toolbar.querySelector("[data-music-action='" + action + "']"),
      !batch || disabled,
    );
  });
  setLocalElementDisabled(
    toolbar.querySelector("[data-music-action='rename-playlist']"),
    music.busy,
  );
  setLocalElementDisabled(
    toolbar.querySelector("[data-music-action='delete-playlist']"),
    music.busy,
  );
  setLocalElementText(
    toolbar.querySelector("[data-role='selected-count']"),
    "已选 " + selected + " 首",
  );
  var all = toolbar.querySelector("[data-music-action='select-all']"),
    selectedVisible = entries.filter(function (entry) {
      return music.selected[entry.key];
    }).length;
  setLocalElementChecked(
    all,
    entries.length > 0 && selectedVisible === entries.length,
  );
  if (all)
    all.indeterminate = selectedVisible > 0 && selectedVisible < entries.length;
  setLocalElementDisabled(all, music.busy);
  setLocalElementHidden(toolbar, !musicFeatureEnabled("batchOperationsEnabled") && !isCustomMusicView());
}

function decorateNativeMusicRows() {
  nativeMusicEntries().forEach(function (entry) {
    if (!entry.row) return;
    var row = entry.row,
      label = row.querySelector(".lm-music-row-checkbox");
    if (!musicShape().batchMode) {
      if (label) { if (label.parentElement) label.parentElement.removeAttribute("data-lm-batch-index"); label.remove(); }
      return;
    }
    if (!label) {
      label = document.createElement("label");
      label.className = "lm-music-row-checkbox";
      label.innerHTML =
        '<input class="lm-music-checkbox" type="checkbox" aria-label="选择曲目">';
      var indexCell = row.firstElementChild;
      if (!indexCell) return;
      indexCell.setAttribute("data-lm-batch-index", "true");
      indexCell.appendChild(label);
    }
    label.onclick = function (event) {
      event.stopPropagation();
    };
    label.ondblclick = function (event) { event.stopPropagation(); };
    var checkbox = label.querySelector("input");
    checkbox.__linliMusicEntry = entry;
    checkbox.checked = Boolean(musicShape().selected[entry.key]);
    checkbox.disabled = musicShape().busy;
    checkbox.onchange = function () {
      if (musicShape().busy) return;
      var current = checkbox.__linliMusicEntry;
      if (checkbox.checked) musicShape().selected[current.key] = current;
      else delete musicShape().selected[current.key];
      renderMusicEnhancements();
    };
  });
}

function musicCoverValue(song) {
  return (
    (song && (song.coverUrl || song.iconUrl || song.cover || song.icon)) || ""
  );
}
function customMusicList() {
  var original = document.getElementById("tour-song-list");
  if (!original) {
    var header = musicHeader();
    if (!header || !musicBridgeAvailable()) return null;
    original = document.createElement("div");
    original.id = "tour-song-list";
    original.dataset.localPlaceholder = "true";
    header.insertAdjacentElement("afterend", original);
  }
  var list = document.getElementById(MUSIC_CUSTOM_LIST_ID);
  if (!list) {
    list = document.createElement("div");
    list.id = MUSIC_CUSTOM_LIST_ID;
    list.className = "lm-music-custom-list";
  }
  placeLocalElementAfter(original, list);
  return list;
}
function customMusicRowMarkup() {
  return '<div class="lm-music-custom-index"><span data-role="music-index"></span><label class="lm-music-row-checkbox" data-role="row-checkbox"><input class="lm-music-checkbox" type="checkbox" data-role="music-checkbox" aria-label="选择曲目"></label></div><div data-role="music-cover"></div><div class="lm-music-song"><div data-role="music-name"></div><div data-role="music-missing"></div></div><div class="lm-music-mode" data-role="music-meta"></div><div class="lm-music-row-actions"><button type="button" class="lm-music-order-button" data-music-action="move-up" aria-label="上移">↑</button><button type="button" class="lm-music-order-button" data-music-action="move-down" aria-label="下移">↓</button><button type="button" class="lm-music-row-add" data-music-action="add-desktop-one">加播单</button><button type="button" class="lm-music-row-remove" data-music-action="remove-one">移出</button></div>';
}
function updateMusicCover(host, song) {
  if (!host) return;
  var value = String(musicCoverValue(song) || "");
  if (host.__musicCover === value && host.firstElementChild) return;
  host.__musicCover = value;
  host.innerHTML = "";
  if (value) {
    var image = document.createElement("img");
    image.className = "lm-music-cover";
    image.src = value;
    image.alt = "";
    host.appendChild(image);
  } else {
    var placeholder = document.createElement("span");
    placeholder.textContent = "♪";
    host.appendChild(placeholder);
  }
}
function bindCustomMusicRow(row) {
  row.onclick = function (event) {
    var action = event.target.closest("[data-music-action]");
    if (!action || action.disabled || musicShape().busy) return;
    var entry = row.__musicEntry;
    if (!entry) return;
    if (action.dataset.musicAction === "add-desktop-one")
      void addMusicEntryToDesktop(entry, action);
    else if (action.dataset.musicAction === "remove-one")
      void removeMusicEntriesFromPlaylist([entry]);
    else if (action.dataset.musicAction === "move-up")
      void movePlaylistItem(entry.key, -1);
    else if (action.dataset.musicAction === "move-down")
      void movePlaylistItem(entry.key, 1);
  };
  row.onchange = function (event) {
    var checkbox = event.target.closest("[data-role='music-checkbox']");
    if (!checkbox || musicShape().busy || !row.__musicEntry) return;
    if (checkbox.checked)
      musicShape().selected[row.__musicEntry.key] = row.__musicEntry;
    else delete musicShape().selected[row.__musicEntry.key];
    renderMusicEnhancements();
  };
}
function renderCustomMusicList() {
  var list = customMusicList(),
    original = document.getElementById("tour-song-list");
  if (!original || !list) return;
  if (!isCustomMusicView()) {
    setLocalElementHidden(original, false);
    setLocalElementHidden(list, true);
    return;
  }
  setLocalElementHidden(original, true);
  setLocalElementHidden(list, false);
  var items = customMusicEntries(),
    empty = list.querySelector("[data-role='music-empty']");
  if (!empty) {
    empty = document.createElement("div");
    empty.dataset.role = "music-empty";
    empty.textContent = "这个自定义歌单还没有曲目";
    list.appendChild(empty);
  }
  setLocalElementHidden(empty, items.length > 0);
  var rows = Array.prototype.slice.call(
      list.querySelectorAll(".lm-music-custom-row"),
    ),
    retained = [];
  items.forEach(function (entry, index) {
    var row = rows.find(function (candidate) {
      return candidate.dataset.musicItemKey === entry.key;
    });
    if (!row) {
      row = document.createElement("div");
      row.className = "lm-music-custom-row";
      row.innerHTML = customMusicRowMarkup();
    }
    bindCustomMusicRow(row);
    row.__musicEntry = entry;
    row.dataset.musicItemKey = entry.key;
    row.dataset.available = String(entry.available !== false);
    var song = entry.song || {},
      checkbox = row.querySelector("[data-role='music-checkbox']");
    setLocalElementHidden(
      row.querySelector("[data-role='row-checkbox']"),
      !musicShape().batchMode,
    );
    setLocalElementChecked(checkbox, Boolean(musicShape().selected[entry.key]));
    setLocalElementDisabled(checkbox, musicShape().busy);
    setLocalElementDisabled(
      row.querySelector("[data-music-action='add-desktop-one']"),
      musicShape().busy || entry.available === false,
    );
    setLocalElementDisabled(
      row.querySelector("[data-music-action='remove-one']"),
      musicShape().busy,
    );
    setLocalElementDisabled(
      row.querySelector("[data-music-action='move-up']"),
      musicShape().busy || index === 0,
    );
    setLocalElementDisabled(
      row.querySelector("[data-music-action='move-down']"),
      musicShape().busy || index === items.length - 1,
    );
    setLocalElementText(
      row.querySelector("[data-role='music-index']"),
      index + 1,
    );
    setLocalElementText(
      row.querySelector("[data-role='music-name']"),
      song.name || "未命名曲目",
    );
    setLocalElementText(
      row.querySelector("[data-role='music-meta']"),
      song.performanceTypeDisplayName || "独奏",
    );
    setLocalElementText(
      row.querySelector("[data-role='music-missing']"),
      entry.available === false ? entry.reason || "曲目不可用" : "",
    );
    updateMusicCover(row.querySelector("[data-role='music-cover']"), song);
    var previous = retained[retained.length - 1];
    var next = previous ? nextLocalElement(previous) : list.firstElementChild;
    if (next !== row) list.insertBefore(row, next);
    retained.push(row);
  });
  rows.forEach(function (row) {
    if (retained.indexOf(row) < 0) row.remove();
  });
  if (
    retained.length &&
    nextLocalElement(retained[retained.length - 1]) !== empty
  )
    list.appendChild(empty);
}

function renderMusicEnhancements() {
  musicShape();
  if (!musicFeatureEnabled("customPlaylistsEnabled") && isCustomMusicView()) {
    musicShape().viewGeneration += 1;
    musicShape().activePlaylistId = null;
    musicShape().playlistItems = [];
    musicShape().selectableEntries = [];
    musicShape().selectableViewKey = "";
    clearMusicSelection();
  }
  if (!musicFeatureEnabled("batchOperationsEnabled")) {
    musicShape().batchMode = false;
    clearMusicSelection();
  }
  mountCustomSongTools();
  installStyles();
  var nativeLists = Array.prototype.slice.call(document.querySelectorAll("#tour-song-list"));
  if (nativeLists.some(function (list) { return !list.dataset.localPlaceholder; })) {
    nativeLists.forEach(function (list) { if (list.dataset.localPlaceholder) list.remove(); });
  }
  if (isSettingsRoute() || !musicBridgeAvailable()) {
    musicShape().batchMode = false;
    clearMusicSelection();
    var original = document.getElementById("tour-song-list");
    if (original) setLocalElementHidden(original, false);
    (isSettingsRoute()
      ? [MUSIC_CUSTOM_TABS_ID, MUSIC_TOOLBAR_ID, MUSIC_CUSTOM_LIST_ID, MUSIC_MODAL_ID, "local-mail-music-clear"]
      : [MUSIC_TOOLBAR_ID, MUSIC_CUSTOM_LIST_ID, MUSIC_MODAL_ID, "local-mail-music-clear"]).forEach(
      function (id) {
        var node = document.getElementById(id);
        if (node) node.remove();
      },
    );
    Array.prototype.forEach.call(
      document.querySelectorAll("#tour-song-list .lm-music-row-checkbox"),
      function (node) {
        if (node.parentElement) node.parentElement.removeAttribute("data-lm-batch-index");
        node.remove();
      },
    );
    if (!isSettingsRoute()) renderMusicUnavailableTab();
    return;
  }
  renderMusicTabs();
  renderCustomMusicList();
  renderMusicToolbar();
  renderMusicDesktopClear();
  if (!isCustomMusicView()) decorateNativeMusicRows();
}

function renderMusicDesktopClear() {
  var bridge = window.__LINLI_MUSIC_BRIDGE__;
  var button = document.getElementById("local-mail-music-clear");
  if (!musicFeatureEnabled("desktopClearEnabled") || !bridge || typeof bridge.getQueueElement !== "function") {
    if (button) button.remove(); return;
  }
  var root = bridge.getQueueElement(), header = root && root.firstElementChild;
  if (!header) { if (button) button.remove(); return; }
  if (!button) {
    button = document.createElement("button"); button.id = "local-mail-music-clear";
    button.type = "button"; button.className = "lm-music-action"; button.textContent = "清空";
    button.setAttribute("aria-label", "清空音乐桌面");
    button.onclick = function () { void openMusicDesktopClearConfirm(); };
  }
  if (button.parentElement !== header) header.appendChild(button);
  setLocalElementDisabled(button, musicShape().busy || (typeof bridge.getQueue === "function" && !bridge.getQueue().length));
}

async function openMusicDesktopClearConfirm() {
  if (!musicFeatureEnabled("desktopClearEnabled") || !beginMusicOperation()) return;
  try {
    var data = await musicApi().searchPlaylist();
    if (!data.list.length) { musicNotice("音乐桌面已经是空的。", "success"); return; }
    var modal = ensureMusicModal();
    musicShape().clearSnapshot = data.list;
    modal.innerHTML = '<div class="lm-modal lm-music-dialog" role="dialog" aria-modal="true"><div class="lm-modal-title">清空音乐桌面</div><div class="lm-music-dialog-copy">将移除当前播单中的 ' + data.list.length + ' 首曲目；正在播放的播单曲目会停止。不会删除音乐文件或自定义歌单。</div><div class="lm-modal-actions"><button type="button" data-music-modal-action="close">取消</button><button type="button" data-music-modal-action="clear-desktop">清空</button></div></div>';
    modal.hidden = false;
  } catch (error) { musicNotice("读取播单失败：" + (error.message || error), "error"); }
  finally { endMusicOperation(); }
}

async function confirmMusicDesktopClear() {
  var snapshot = musicShape().clearSnapshot;
  if (!snapshot || !musicFeatureEnabled("desktopClearEnabled") || !beginMusicOperation()) return;
  try {
    var result = await musicApi().clearDesktop(snapshot);
    closeMusicModal(true);
    musicNotice(result.error || "已从音乐桌面移除 " + result.removed + " 首曲目。", result.error ? "error" : "success");
  } catch (error) { musicNotice("清空失败：" + (error.message || error), "error"); }
  finally { endMusicOperation(); }
}

function ensureMusicModal() {
  var modal = document.getElementById(MUSIC_MODAL_ID);
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = MUSIC_MODAL_ID;
  modal.className = "lm-modal-backdrop";
  modal.hidden = true;
  modal.onclick = function (event) {
    if (event.target === modal && !musicShape().busy) closeMusicModal();
    var action = event.target.closest("[data-music-modal-action]");
    if (!action || action.disabled || musicShape().busy) return;
    var kind = action.dataset.musicModalAction;
    if (kind === "close") closeMusicModal();
    else if (kind === "create") void submitMusicPlaylistCreate();
    else if (kind === "rename") void submitMusicPlaylistRename();
    else if (kind === "delete") void submitMusicPlaylistDelete();
    else if (kind === "pick")
      void addSelectionToMusicPlaylist(action.dataset.playlistId);
    else if (kind === "create-from-picker")
      openMusicCreateDialog("add-selected");
    else if (kind === "confirm-switch") void confirmMusicViewSwitch();
    else if (kind === "clear-desktop") void confirmMusicDesktopClear();
  };
  document.body.appendChild(modal);
  return modal;
}
function closeMusicModal(force) {
  if (musicShape().busy && !force) return;
  var modal = document.getElementById(MUSIC_MODAL_ID);
  if (modal) modal.hidden = true;
  musicShape().pendingSwitch = null;
  musicShape().modalMode = "";
  musicShape().createAfter = null;
  musicShape().clearSnapshot = null;
}
function openMusicCreateDialog(afterCreate) {
  musicShape().modalMode = "create";
  musicShape().createAfter = afterCreate || null;
  var modal = ensureMusicModal();
  modal.innerHTML =
    '<div class="lm-modal lm-music-dialog" role="dialog" aria-modal="true"><div class="lm-modal-title">新建自定义歌单</div><div class="lm-music-dialog-copy">歌单只保存曲目引用，不会删除或复制本地文件。</div><label class="lm-field"><span>歌单名称</span><input class="lm-input" data-role="music-playlist-name" maxlength="40"></label><div class="lm-modal-actions"><button type="button" data-music-modal-action="close">取消</button><button type="button" data-music-modal-action="create">创建</button></div></div>';
  modal.hidden = false;
}
function openMusicRenameDialog() {
  if (!musicShape().activePlaylistId || musicShape().busy) return;
  var playlist =
    (musicShape().playlists || []).find(function (item) {
      return String(item.playlistId) === String(musicShape().activePlaylistId);
    }) || {};
  var modal = ensureMusicModal();
  musicShape().modalMode = "rename";
  modal.innerHTML =
    '<div class="lm-modal lm-music-dialog" role="dialog" aria-modal="true"><div class="lm-modal-title">重命名自定义歌单</div><label>歌单名称<input class="lm-input" data-role="music-playlist-name" maxlength="40"></label><div class="lm-modal-actions"><button type="button" data-music-modal-action="close">取消</button><button type="button" data-music-modal-action="rename">保存</button></div></div>';
  modal.querySelector("[data-role='music-playlist-name']").value =
    playlist.name || "";
  modal.hidden = false;
}
function openMusicDeleteDialog() {
  if (!musicShape().activePlaylistId || musicShape().busy) return;
  var playlist =
    (musicShape().playlists || []).find(function (item) {
      return String(item.playlistId) === String(musicShape().activePlaylistId);
    }) || {};
  var modal = ensureMusicModal();
  musicShape().modalMode = "delete";
  modal.innerHTML =
    '<div class="lm-modal lm-music-dialog" role="dialog" aria-modal="true"><div class="lm-modal-title">删除自定义歌单</div><div>确定删除“' +
    escapeHtml(playlist.name || "未命名歌单") +
    '”？只删除歌单引用，不会删除音乐文件。</div><div class="lm-modal-actions"><button type="button" data-music-modal-action="close">取消</button><button type="button" data-music-modal-action="delete">删除歌单</button></div></div>';
  modal.hidden = false;
}
function openMusicPlaylistPicker() {
  var modal = ensureMusicModal(),
    playlists = musicShape().playlists || [];
  modal.innerHTML =
    '<div class="lm-modal lm-music-dialog" role="dialog" aria-modal="true"><div class="lm-modal-title">加入自定义歌单</div>' +
    (playlists.length
      ? playlists
          .map(function (playlist) {
            return (
              '<button type="button" data-music-modal-action="pick" data-playlist-id="' +
              escapeHtml(playlist.playlistId) +
              '">' +
              escapeHtml(playlist.name) +
              "</button>"
            );
          })
          .join("")
      : "<div>还没有自定义歌单。</div>") +
    '<div><button type="button" data-music-modal-action="close">取消</button><button type="button" data-music-modal-action="create-from-picker">新建歌单</button></div></div>';
  modal.hidden = false;
}

async function submitMusicPlaylistCreate() {
  if (!beginMusicOperation()) return;
  var modal = ensureMusicModal(),
    input = modal.querySelector("[data-role='music-playlist-name']");
  try {
    var playlist = await callApi("/api/music-library/playlists", {
      method: "POST",
      body: { name: input ? input.value : "" },
    });
    await reloadMusicLibrary();
    if (musicShape().createAfter === "add-selected")
      await addSelectionToMusicPlaylistInternal(playlist.playlistId);
    await reloadMusicLibrary();
    await loadMusicPlaylist(playlist.playlistId, musicShape().viewGeneration);
    clearMusicSelection();
    closeMusicModal(true);
    musicNotice("已创建“" + (playlist.name || "自定义歌单") + "”。", "success");
  } catch (error) {
    if (playlist) closeMusicModal(true);
    musicNotice((playlist ? "歌单已创建，但后续操作未完成；可将保留的选择加入该歌单：" : "创建歌单失败：") + (error.message || error), "error");
  } finally {
    endMusicOperation();
  }
}
async function submitMusicPlaylistRename() {
  if (!musicShape().activePlaylistId || !beginMusicOperation()) return;
  var modal = ensureMusicModal(),
    input = modal.querySelector("[data-role='music-playlist-name']");
  try {
    await callApi(
      "/api/music-library/playlists/" +
        encodeURIComponent(musicShape().activePlaylistId) +
        "/rename",
      { method: "POST", body: { name: input ? input.value : "" } },
    );
    await reloadMusicLibrary();
    closeMusicModal(true);
    musicNotice("歌单名称已更新。", "success");
  } catch (error) {
    musicNotice("重命名失败：" + (error.message || error), "error");
  } finally {
    endMusicOperation();
  }
}
async function submitMusicPlaylistDelete() {
  var id = musicShape().activePlaylistId;
  if (!id || !beginMusicOperation()) return;
  try {
    await callApi(
      "/api/music-library/playlists/" + encodeURIComponent(id) + "/delete",
      { method: "POST", body: {} },
    );
    await reloadMusicLibrary();
    var music = musicShape();
    music.viewGeneration += 1;
    music.activePlaylistId = null;
    music.playlistItems = [];
    music.selectableEntries = [];
    clearMusicSelection();
    closeMusicModal(true);
    musicNotice("歌单已删除，音乐文件未受影响。", "success");
  } catch (error) {
    musicNotice("删除歌单失败：" + (error.message || error), "error");
  } finally {
    endMusicOperation();
  }
}

async function addSelectionToMusicPlaylistInternal(playlistId) {
  var entries = selectedMusicEntries(),
    music = musicShape();
  if (!entries.length) return;
  var chunks = musicChunks(entries, serializeMusicSong),
    completed = 0,
    updated = 0;
  for (var index = 0; index < chunks.length; index += 1) {
    var result = await callApi(
      "/api/music-library/playlists/" +
        encodeURIComponent(playlistId) +
        "/items",
      {
        method: "POST",
        body: { songs: chunks[index].map(serializeMusicSong) },
      },
    );
    completed += Number((result && result.added) || 0);
    updated += Number((result && result.updated) || 0);
    chunks[index].forEach(function (entry) {
      delete music.selected[entry.key];
    });
  }
  await reloadMusicLibrary();
  if (String(music.activePlaylistId) === String(playlistId))
    await loadMusicPlaylist(playlistId, music.viewGeneration);
  musicNotice(
    "已加入 " +
      completed +
      " 首曲目" +
      (updated ? "，更新 " + updated + " 首" : "") +
      "。",
    "success",
  );
}
async function addSelectionToMusicPlaylist(playlistId) {
  if (!beginMusicOperation()) return;
  try {
    await addSelectionToMusicPlaylistInternal(playlistId);
    closeMusicModal(true);
  } catch (error) {
    musicNotice(
      "加入歌单失败：" + (error.message || error) + "；失败选择已保留。",
      "error",
    );
  } finally {
    endMusicOperation();
  }
}
async function removeMusicEntriesFromPlaylist(entries) {
  var id = musicShape().activePlaylistId;
  if (!id || !entries.length || !beginMusicOperation()) return;
  try {
    var removed = 0;
    for (var offset = 0; offset < entries.length; offset += 200) {
      var chunk = entries.slice(offset, offset + 200);
      var keys = chunk.map(function (entry) { return entry.itemKey || entry.key; });
      var result = await callApi("/api/music-library/playlists/" + encodeURIComponent(id) + "/remove", { method: "POST", body: { itemKeys: keys } });
      removed += Number(result.removed || 0);
      chunk.forEach(function (entry) { delete musicShape().selected[entry.key]; });
      musicShape().playlistItems = musicShape().playlistItems.filter(function (entry) { return keys.indexOf(entry.itemKey || entry.key) < 0; });
    }
    await reloadMusicLibrary();
    await loadMusicPlaylist(id, musicShape().viewGeneration);
    entries.forEach(function (entry) {
      delete musicShape().selected[entry.key];
    });
    musicNotice(
      "已从歌单移出 " +
        removed +
        " 首曲目。",
      "success",
    );
  } catch (error) {
    musicNotice("移出歌单失败：" + (error.message || error), "error");
  } finally {
    endMusicOperation();
  }
}
async function removeSelectedFromMusicPlaylist() {
  await removeMusicEntriesFromPlaylist(selectedMusicEntries());
}
async function movePlaylistItem(key, delta) {
  var music = musicShape(),
    items = customMusicEntries(),
    index = items.findIndex(function (entry) {
      return entry.key === key;
    }),
    target = index + delta;
  if (
    !music.activePlaylistId ||
    music.busy ||
    index < 0 ||
    target < 0 ||
    target >= items.length ||
    !beginMusicOperation()
  )
    return;
  try {
    var keys = items.map(function (entry) {
        return entry.itemKey || entry.key;
      }),
      swap = keys[index];
    keys[index] = keys[target];
    keys[target] = swap;
    var result = await callApi(
      "/api/music-library/playlists/" +
        encodeURIComponent(music.activePlaylistId) +
        "/order",
      { method: "POST", body: { itemKeys: keys } },
    );
    if (result && Array.isArray(result.items))
      music.playlistItems = await resolvePlaylistEntries(result.items);
    else await loadMusicPlaylist(music.activePlaylistId, music.viewGeneration);
  } catch (error) {
    musicNotice("保存歌单顺序失败：" + (error.message || error), "error");
  } finally {
    endMusicOperation();
  }
}
