
  var customSongsState = { busy: false, data: null, error: "", page: 0, selected: null };

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
        method: "POST", body: Object.assign({}, params || {}, { detectedRoot: officialSongStoragePath() }),
        signal: config && config.signal
      });
      customSongsState.data = data;
      customSongsState.error = "";
      return data;
    } catch (error) {
      customSongsState.error = error.message || String(error);
      throw error;
    } finally { mountCustomSongTools(); }
  }

  function mountCustomSongTools() {
    var route = window.location.hash || window.location.pathname;
    if (!/\/studio\/?(?:[?#].*)?$/.test(route.replace(/^#/, ""))) return;
    var main = document.querySelector("#app main") || document.querySelector("main");
    if (!main) return;
    installStyles();
    var toolbar = document.getElementById("local-mail-custom-song-tools");
    if (!toolbar) {
      toolbar = document.createElement("div");
      toolbar.id = "local-mail-custom-song-tools";
      toolbar.className = "lm-import-row";
      toolbar.style.cssText = "padding:8px 16px;gap:12px;flex-wrap:wrap";
      toolbar.innerHTML = '<button type="button" class="lm-button lm-button-small" data-custom-manage>管理本地演奏</button><span class="lm-modal-status" role="status"></span>';
      main.appendChild(toolbar);
      toolbar.querySelector("[data-custom-manage]").onclick = openCustomSongManager;
    }
    var message = customSongsState.error || (customSongsState.data
      ? "本地定制演奏 " + customSongsState.data.total + " 首" + (customSongsState.data.missingPeriods ? " · 部分时段复用现有视频，可在管理中校正" : "")
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
      modal.innerHTML = '<section class="lm-modal" role="dialog" aria-modal="true" aria-labelledby="local-custom-song-title">'
        + '<div class="lm-modal-title" id="local-custom-song-title">本地定制演奏</div>'
        + '<p class="lm-modal-status">读取已下载的演奏视频。曲名和视频时段可手动校正；缺失时段会复用现有视频。</p>'
        + '<label>曲目下载文件夹<input class="lm-input" data-custom-root aria-label="曲目下载文件夹"></label>'
        + '<div class="lm-modal-actions"><button type="button" class="lm-button" data-custom-scan>重新扫描</button></div>'
        + '<label>选择曲目<select class="lm-select" data-custom-song aria-label="选择曲目"></select></label>'
        + '<div class="lm-modal-actions"><button type="button" class="lm-button lm-button-small" data-custom-prev>上一页</button><span data-custom-page></span><button type="button" class="lm-button lm-button-small" data-custom-next>下一页</button></div>'
        + '<label>曲名<input class="lm-input" data-custom-name aria-label="曲名"></label>'
        + '<div data-custom-files></div><p class="lm-modal-status" role="status" data-custom-status></p>'
        + '<div class="lm-modal-actions"><button type="button" class="lm-button" data-custom-close>关闭</button><button type="button" class="lm-button lm-button-primary" data-custom-save>保存</button></div></section>';
      document.body.appendChild(modal);
      modal.querySelector("[data-custom-close]").onclick = function () { if (!customSongsState.busy) { modal.hidden = true; modal.querySelectorAll("video").forEach(function (video) { video.pause(); }); } };
      modal.addEventListener("keydown", function (event) { if (event.key === "Escape") modal.querySelector("[data-custom-close]").click(); });
      modal.querySelector("[data-custom-scan]").onclick = function () { void loadCustomSongManager(modal, true); };
      modal.querySelector("[data-custom-prev]").onclick = function () { customSongsState.page = Math.max(0, customSongsState.page - 1); void loadCustomSongManager(modal, false); };
      modal.querySelector("[data-custom-next]").onclick = function () { customSongsState.page += 1; void loadCustomSongManager(modal, false); };
      modal.querySelector("[data-custom-song]").onchange = function () { customSongsState.selected = this.value; renderCustomSongEditor(modal); };
      modal.querySelector("[data-custom-save]").onclick = function () { void saveCustomSongEditor(modal); };
    }
    modal.hidden = false;
    modal.querySelector("[data-custom-root]").value = customSongsState.data && customSongsState.data.mediaRoot || "";
    customSongsState.page = 0;
    await loadCustomSongManager(modal, false);
  }

  function customSongManagerBusy(modal, busy) {
    customSongsState.busy = busy;
    modal.querySelectorAll("button,input,select").forEach(function (node) { node.disabled = busy; });
    if (!busy) {
      var data = modal.__customSongsPage;
      modal.querySelector("[data-custom-prev]").disabled = !data || customSongsState.page === 0;
      modal.querySelector("[data-custom-next]").disabled = !data || !data.hasMore;
      modal.querySelector("[data-custom-save]").disabled = !customSongsState.selected;
    }
  }

  async function loadCustomSongManager(modal, scan) {
    if (customSongsState.busy) return;
    customSongManagerBusy(modal, true);
    var status = modal.querySelector("[data-custom-status]");
    status.textContent = scan ? "正在扫描本地视频…" : "正在读取曲目…";
    try {
      var root = modal.querySelector("[data-custom-root]").value.trim() || undefined;
      if (scan) {
        await callApi("/api/custom-songs/scan", { method: "POST", body: { mediaRoot: root } });
        customSongsState.page = 0;
      }
      var data = await callApi("/api/custom-songs/search", { method: "POST", body: {
        mediaRoot: root, detectedRoot: officialSongStoragePath(), cursor: customSongsState.page * 100, pageSize: 100
      } });
      modal.__customSongsPage = data;
      customSongsState.data = data;
      customSongsState.error = "";
      modal.querySelector("[data-custom-root]").value = data.mediaRoot;
      var select = modal.querySelector("[data-custom-song]");
      select.innerHTML = "";
      data.list.forEach(function (song) {
        var option = document.createElement("option");
        option.value = song.nameKey; option.textContent = song.name;
        select.appendChild(option);
      });
      select.value = data.list.some(function (song) { return song.nameKey === customSongsState.selected; })
        ? customSongsState.selected : data.list[0] && data.list[0].nameKey || "";
      customSongsState.selected = select.value;
      modal.querySelector("[data-custom-page]").textContent = "共 " + data.total + " 首 · 第 " + (customSongsState.page + 1) + " 页";
      status.textContent = data.list.length ? "已读取。关闭管理窗口后，可在“我的上传”中试听或演奏。" : "未找到可用的定制演奏视频。请检查下载文件夹。";
      if (data.warnings && data.warnings.length) status.textContent += "\n" + data.warnings.join("\n");
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
    var song = data && data.list.find(function (item) { return item.nameKey === customSongsState.selected; });
    var container = modal.querySelector("[data-custom-files]");
    container.querySelectorAll("video").forEach(function (video) { video.pause(); });
    container.innerHTML = "";
    modal.querySelector("[data-custom-name]").value = song ? song.name : "";
    if (!song) return;
    var note = document.createElement("p");
    note.className = "lm-modal-status";
    note.textContent = song.fallbackPeriods.length ? "部分时段未确认或缺失，当前复用现有视频。可预览后设置对应时段。" : "各时段已匹配。";
    container.appendChild(note);
    song.localFiles.forEach(function (file) {
      var row = document.createElement("div");
      row.style.cssText = "margin-top:12px";
      var label = document.createElement("label");
      label.className = "lm-modal-status"; label.textContent = file.fileName;
      var select = document.createElement("select");
      select.className = "lm-select"; select.setAttribute("data-custom-file", file.fileName);
      select.setAttribute("aria-label", "视频时段 " + file.fileName);
      [["", "时段未知"], ["TOD12", "白天"], ["TOD1730", "傍晚"], ["TOD20", "夜晚"]].forEach(function (period) {
        var option = document.createElement("option");
        option.value = period[0]; option.textContent = period[1]; select.appendChild(option);
      });
      select.value = file.tod || "";
      var details = document.createElement("details");
      var summary = document.createElement("summary"); summary.textContent = "预览视频";
      var video = document.createElement("video");
      video.controls = true; video.preload = "none"; video.src = file.url;
      video.style.cssText = "width:100%;max-height:200px";
      details.appendChild(summary); details.appendChild(video);
      row.appendChild(label); row.appendChild(select); row.appendChild(details);
      container.appendChild(row);
    });
  }

  async function saveCustomSongEditor(modal) {
    if (customSongsState.busy || !customSongsState.selected) return;
    customSongManagerBusy(modal, true);
    try {
      var saved = await callApi("/api/custom-songs/update", { method: "POST", body: {
        nameKey: customSongsState.selected, name: modal.querySelector("[data-custom-name]").value,
        mappings: Array.prototype.map.call(modal.querySelectorAll("[data-custom-file]"), function (select) {
          return { fileName: select.getAttribute("data-custom-file"), tod: select.value || null };
        })
      } });
      if (!saved) throw new Error("本地视频已移动或无法读取，请重新扫描。");
      var page = modal.__customSongsPage;
      if (page) page.list = page.list.map(function (song) { return song.nameKey === saved.nameKey ? saved : song; });
      Array.prototype.forEach.call(modal.querySelector("[data-custom-song]").options, function (option) {
        if (option.value === saved.nameKey) option.textContent = saved.name;
      });
      customSongsChanged();
      modal.querySelector("[data-custom-status]").textContent = "已保存。";
    } catch (error) { modal.querySelector("[data-custom-status]").textContent = error.message || String(error); }
    finally { customSongManagerBusy(modal, false); }
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
    mountCustomSongTools();
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
