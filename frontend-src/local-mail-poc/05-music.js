var customSongsState = {
  busy: false,
  data: null,
  error: "",
  page: 0,
  selected: null,
};

// The native pager owns the displayed rows. Retain only enough state to know
// when switching back may reuse those rows; do not create a second song store.
var customSongListState = { epoch: 0, ready: false, pending: 0, root: "", firstId: null, total: 0 };
var customSongRefreshWatch = { epoch: 0, timer: null, value: null, failures: 0, sourceRoot: "" };

function stopCustomSongRefresh(clear) {
  customSongRefreshWatch.epoch++;
  if (customSongRefreshWatch.timer !== null) window.clearTimeout(customSongRefreshWatch.timer);
  customSongRefreshWatch.timer = null;
  if (clear) customSongRefreshWatch.value = null;
}

function customSongRefreshVisible() {
  var route = String(window.location.hash || window.location.pathname).replace(/^#/, "");
  var view = musicView();
  return document.hidden !== true && /\/studio\/?(?:[?#].*)?$/.test(route) && !isCustomMusicView()
    && view && Number(view.sourceType) === 3;
}

function resumeCustomSongRefresh() {
  var watch = customSongRefreshWatch;
  if (!watch.value || !watch.value.refreshing || watch.timer !== null || !customSongRefreshVisible()) return;
  var epoch = watch.epoch;
  watch.timer = window.setTimeout(function () { watch.timer = null; void pollCustomSongRefresh(epoch); }, 500);
}

async function pollCustomSongRefresh(epoch) {
  var watch = customSongRefreshWatch, previous = watch.value;
  if (epoch !== watch.epoch || !previous || !customSongRefreshVisible()) return;
  var rootKey = String(previous.mediaRoot || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  if (customSongRootKey() !== watch.sourceRoot) { stopCustomSongRefresh(true); return; }
  try {
    var current = await callApi("/api/custom-songs/status", { method: "POST", body: { mediaRoot: previous.mediaRoot } });
    if (epoch !== watch.epoch || !customSongRefreshVisible()
      || customSongRootKey() !== watch.sourceRoot
      || String(current.mediaRoot || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() !== rootKey) return;
    watch.failures = 0;
    watch.value = current;
    if (customSongsState.data) customSongsState.data.refresh = current;
    if (current.revision && current.revision !== previous.revision) {
      syncVisionTasks(current.revision);
      customSongsChanged();
    } else resumeCustomSongRefresh();
    mountCustomSongTools();
  } catch (error) {
    if (epoch !== watch.epoch) return;
    watch.failures++;
    if (watch.failures < 3) resumeCustomSongRefresh();
    else {
      watch.value = Object.assign({}, previous, { refreshing: false, error: error.message || "后台检查未完成" });
      if (customSongsState.data) customSongsState.data.refresh = watch.value;
      mountCustomSongTools();
    }
  }
}

function trackCustomSongRefresh(data) {
  stopCustomSongRefresh(true);
  customSongRefreshWatch.value = data && data.refresh || null;
  customSongRefreshWatch.sourceRoot = customSongRootKey();
  customSongRefreshWatch.failures = 0;
  resumeCustomSongRefresh();
  syncVisionTasks(data && data.refresh && data.refresh.revision || 'catalog-loaded');
}

var visionTaskCoordinator = null, visionInputRevision='initial', visionLastCatalogRevision='', visionMutationRevision=0;
function visionTaskRoot() { return customSongsState.data && customSongsState.data.mediaRoot || officialSongStoragePath() || ''; }
function visionTaskHumanBusy() {
  var modal = document.getElementById('local-mail-custom-song-modal');
  return customSongsState.busy || Boolean(customSongVisionState.run) || Boolean(modal && !modal.hidden && (modal.__visionDirty ||
    modal.querySelector('[data-custom-root]').value.trim() !== visionTaskRoot() || modal.__songDebugPackage && modal.__songDebugPackage.isBusy())) ||
    Boolean(modal && modal.__songDiagnostics && modal.__songDiagnostics.isExporting());
}
function getVisionTaskCoordinator() {
  if (!visionTaskCoordinator) visionTaskCoordinator = createVisionTaskController({
    getRoot: visionTaskRoot, request: callApi, isHumanBusy: visionTaskHumanBusy,
    environment: function () {
      var video = document.createElement('video'), canvas = document.createElement('canvas');
      return { visible: document.hidden !== true && document.visibilityState !== 'hidden',
        rvfc: typeof video.requestVideoFrameCallback === 'function',
        canvas: typeof canvas.getContext === 'function' && typeof AbortController === 'function' };
    },
    capture: function (options) { return customSongFrameReader.capture(options); },
    features: function (image, width, height) { return customSongVision.features(image, width, height); },
    setTimeout: function (fn, delay) { return window.setTimeout(fn, delay); }, clearTimeout: function (id) { window.clearTimeout(id); },
    setInterval: function (fn, delay) { return window.setInterval(fn, delay); }, clearInterval: function (id) { window.clearInterval(id); },
    yieldTurn: function () { return new Promise(function (resolve) { window.setTimeout(resolve, 0); }); },
    prepareAuto: async function () { return callApi('/api/custom-songs/search', { method: 'POST', body: { mediaRoot: visionTaskRoot() || undefined, cached: true, pageSize: 1 } }); },
    inputStatus: function(root){return callApi('/api/custom-songs/status',{method:'POST',body:{mediaRoot:root||undefined}});},
    render: renderVisionTaskPanel,
    onSaved: function (count, applied) {
      var modal = document.getElementById('local-mail-custom-song-modal'), song = modal && currentCustomSong(modal);
      if (modal && !modal.hidden && !modal.__visionDirty && song) {
        var changed = false;
        applied.forEach(function (item) {
          if (item.nameKey !== song.nameKey) return;
          var file = song.localFiles.find(function (value) { return value.fileName === item.fileName; });
          if (!file || file.fileRevision !== item.fileRevision || ['manual','original','mapping'].indexOf(file.evidence) >= 0) return;
          file.tod = item.tod; file.automaticTod = item.tod; file.evidence = file.automaticEvidence = 'vision';
          file.evidenceNote = '画面推测：本地规则判定，可在任务中撤销；不是官方记录。'; changed = true;
        });
        if (changed) renderCustomSongEditor(modal);
      }
      customSongsChanged();
    }
  });
  return visionTaskCoordinator;
}
function syncVisionTasks(signal) {
  if (typeof createVisionTaskController !== 'function') return;
  if(signal&&signal!==visionLastCatalogRevision){visionLastCatalogRevision=signal;visionInputRevision=signal;}
  if (visionTaskCoordinator || musicFeatureEnabled('visionAutoFillEnabled')) getVisionTaskCoordinator().sync(musicFeatureEnabled('visionAutoFillEnabled'), visionInputRevision);
}
function renderVisionTaskPanel(view) {
  var modal = document.getElementById('local-mail-custom-song-modal'); if (!modal || modal.hidden) return;
  var job = view.job, coordinator = visionTaskCoordinator, busy = visionTaskHumanBusy() || view.busy;
  var labels = { queued: '准备中', running: '运行中', paused: '已暂停', 'waiting-environment': '等待可用前端', interrupted: '上次任务中断，请继续', completed: '本次处理完成', stopped: '已停止，保留已保存结果', undone: '撤销处理完成' };
  var counts = job && job.counts;
  var summary = modal.querySelector('[data-vision-batch-status]');
  summary.textContent = view.message || (!job ? '' :
    (job.mode === 'auto' ? '自动补齐 · ' : '手动任务 · ') + (labels[job.status] || job.status) + '：处理 ' + (counts.totalVideos-counts.pending-counts.claimed) + '/' + counts.totalVideos +
    ' 个视频；新增映射 ' + counts.saved + '，待确认 ' + counts.review + '，缺文件 ' + counts.missing + '，失败/跳过 ' + (counts.failed+counts.skipped) + '，复用缓存 ' + counts.cached + '，已撤销 ' + counts.undone +
    (job.status === 'completed' && counts.review+counts.missing+counts.failed+counts.skipped ? '。仍有未补齐项，可查看曲目后手工修正。' : '。'));
  if (modal.__managerView === 'home' && job && ['completed','undone','stopped'].indexOf(job.status)>=0 && !view.message) {
    summary.textContent = counts.review+counts.missing+counts.failed ? '部分信息仍不完整，保留可用播放结果；需要时可手动整理。' : '';
  }
  if (modal.__managerHomeReady) renderCustomSongHome(modal);
  modal.querySelector('[data-vision-batch-start]').disabled = busy || Boolean(job && job.mode === 'manual' && ['queued','running','paused','waiting-environment','interrupted'].indexOf(job.status)>=0);
  modal.querySelector('[data-vision-batch-pause]').disabled = busy || !job || ['queued','running','waiting-environment'].indexOf(job.status)<0;
  modal.querySelector('[data-vision-batch-resume]').disabled = busy || !job || !(['paused','waiting-environment','interrupted'].indexOf(job.status)>=0 || job.mode==='manual' && job.inventory.ownerClientId && job.inventory.ownerClientId!==coordinator.clientId);
  modal.querySelector('[data-vision-batch-stop]').disabled = busy || !job || ['queued','running','paused','waiting-environment','interrupted'].indexOf(job.status)<0;
  modal.querySelector('[data-vision-batch-undo]').disabled = busy || !job || !counts.saved;
  modal.querySelector('[data-vision-batch-next]').disabled = !job || !job.hasMore;
  var select = modal.querySelector('[data-vision-batch-jobs]'), jobs = view.data && view.data.jobs || [];
  var signature = JSON.stringify(jobs);
  if (select.__jobSignature !== signature) {
    select.textContent = ''; jobs.forEach(function (item) { var option = document.createElement('option'); option.value=item.id;
      option.textContent=(item.mode==='auto'?'自动':'手动')+' · '+(labels[item.status]||item.status);select.appendChild(option); });
    select.__jobSignature=signature;
  }
  if (job) select.value=job.id;
  var result = modal.querySelector('[data-vision-batch-results]'), resultKey=JSON.stringify(job && job.items || []);
  if(result.__resultKey!==resultKey){
    result.textContent='';(job&&job.items||[]).forEach(function(item){
      if(['review','missing','failed','skipped'].indexOf(item.state)<0)return;
      var row=document.createElement('div');row.className='lm-modal-status';row.textContent=item.fileName+' · '+visionTaskReason(item.reason)+' ';
      var button=document.createElement('button');button.className='lm-button lm-button-small';button.textContent='查看曲目';
      button.onclick=function(){void locateVisionTaskSong(modal,item.nameKey);};row.appendChild(button);result.appendChild(row);
    });result.__resultKey=resultKey;
  }
}
function visionTaskReason(reason) {
  var names={'duplicate-period':'时段冲突','frame-conflict':'画面结论冲突','unfamiliar-scene':'陌生场景','unclear-frames':'画面不明确','missing-file':'文件不可用','media-error':'解码失败',
    'file-or-mapping-changed':'文件或映射已变化','file-changed':'文件版本已变化','protected-manual':'已有人工设置','protected-mapping':'已有导入映射','protected-original':'已有原始依据',
    'stopped-or-undone':'此前已停止或撤销','conflict-or-too-many-files':'存在冲突或文件过多，需人工核对'};
  return names[reason]||'需人工核对';
}
async function locateVisionTaskSong(modal,nameKey) {
  if(modal.__visionDirty&&!window.confirm('当前表单尚未保存，放弃本次编辑并查看任务曲目？'))return;
  try { var located=await callApi('/api/custom-songs/vision/locate',{method:'POST',body:{mediaRoot:visionTaskRoot(),nameKey:nameKey}});
    modal.__visionDirty=false;customSongsState.page=Math.floor(located.cursor/100);customSongsState.selected=nameKey;await loadCustomSongManager(modal,false);
    if(!customSongsState.error&&currentCustomSong(modal)&&currentCustomSong(modal).nameKey===nameKey)setCustomSongView(modal,'editor');
  } catch(error){musicNotice(error.message||'曲目不可用','error');}
}

function customSongRootKey() {
  return String(officialSongStoragePath() || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function invalidateCustomSongList() {
  stopCustomSongRefresh(true);
  customSongListState.epoch++;
  customSongListState.ready = false;
}

function canReuseCustomSongList(rows) {
  var cache = customSongListState;
  return cache.ready && !cache.pending && !customSongsState.busy && cache.root === customSongRootKey()
    && !(customSongsState.data && customSongsState.data.refresh && customSongsState.data.refresh.error)
    && Array.isArray(rows) && (cache.total === 0 ? rows.length === 0
      : rows.length > 0 && String(rows[0].id || rows[0].userSongId) === cache.firstId);
}

var customSongVisionState = { run: null, epoch: 0, results: {},
  cache: typeof customSongVision !== "undefined" ? customSongVision.createCache(64) : null };

function clearCustomSongVision(modal) {
  customSongVisionState.epoch++;
  if (customSongVisionState.run) customSongVisionState.run.controller.abort();
  customSongVisionState.results = {};
  if (modal) modal.querySelector("[data-custom-vision-status]").textContent = "仅核对当前曲目的待确认视频；建议不会自动保存。";
  if (modal) modal.querySelectorAll("[data-vision-thumbnail]").forEach(function (image) { image.removeAttribute("src"); });
}

function customSongVisionLabel(tod) {
  return { TOD12: "白天", TOD1730: "傍晚", TOD20: "夜晚" }[tod] || "未知";
}

function currentCustomSong(modal) {
  return modal.__customSongsPage && modal.__customSongsPage.list.find(function (song) { return song.nameKey === customSongsState.selected; });
}

function renderCustomSongVision(modal) {
  var song = currentCustomSong(modal);
  if (!song || typeof customSongVision === "undefined") return;
  var results = customSongVisionState.results;
  var collisions = customSongVision.crossCheck(results);
  modal.querySelectorAll("[data-vision-file]").forEach(function (panel) {
    var fileName = panel.getAttribute("data-vision-file");
    var file = song.localFiles.find(function (entry) { return entry.fileName === fileName; });
    var result = results[fileName];
    if (!file) return;
    var message = panel.querySelector("[data-vision-message]");
    var image = panel.querySelector("[data-vision-thumbnail]");
    var apply = panel.querySelector("[data-vision-apply]");
    var current = "当前：" + customSongVisionLabel(file.tod) + " · " + customSongEvidenceLabel(file);
    var detail = "画面只作辅助核对，不会自动修改时段。";
    if (!file.fileRevision) detail = "本地服务尚不支持画面核对，请在更新后重启服务和游戏。";
    else if (result) {
      detail = result.tod ? (result.stable ? "画面建议：" : "初步画面建议：") + customSongVisionLabel(result.tod) +
        (result.stable ? "（两帧一致）" : "（证据不足，暂不采用）") : "画面暂无法判断，请预览后手工选择。";
      if (result.cached) detail += " 已复用本次会话的核对结果。";
      if (result.reason === "frame-conflict") detail += " 不同区域或帧之间存在冲突。";
      if (result.error) detail += " " + result.error;
      if (result.tod && file.tod && result.tod !== file.tod) detail += " 与当前映射不同。";
      if (collisions[fileName]) detail += " 同曲出现相同时段建议，请逐一核对，不会强制分配。";
    }
    if (file.evidence === "original" || file.evidence === "manual") detail += " 已保留原始或手工设置；如需修改，请使用时段下拉框。";
    message.textContent = result || !file.fileRevision || file.conflict ? current + "\n" + detail : '';
    message.hidden = !message.textContent;
    if (result && result.thumbnail) { image.src = result.thumbnail; image.style.display = "block"; }
    else { image.removeAttribute("src"); image.style.display = "none"; }
    apply.disabled = Boolean(customSongVisionState.run) || !customSongVision.canApply(file, result);
    apply.hidden = !result || !result.tod;
    panel.querySelector("[data-vision-one]").disabled = Boolean(customSongVisionState.run) || customSongsState.busy || !file.fileRevision;
  });
}

function applyCustomSongVision(modal, fileName) {
  if (customSongsState.busy || customSongVisionState.run) return;
  var song = currentCustomSong(modal), result = customSongVisionState.results[fileName];
  var file = song && song.localFiles.find(function (entry) { return entry.fileName === fileName; });
  if (!customSongVision.canApply(file, result)) return;
  var selects = Array.prototype.slice.call(modal.querySelectorAll("[data-custom-file]"));
  var occupied = selects.some(function (select) {
    var name = select.getAttribute("data-custom-file");
    if (name === fileName) return false;
    var other = song.localFiles.find(function (entry) { return entry.fileName === name; });
    return (select.value === "__auto__" ? other && other.automaticTod : select.value) === result.tod;
  });
  var status = modal.querySelector("[data-custom-vision-status]");
  if (occupied) { status.textContent = "这个时段已有其他视频，请先手工核对并调整，未改动当前选择。"; return; }
  var select = selects.find(function (entry) { return entry.getAttribute("data-custom-file") === fileName; });
  if (select) select.value = result.tod;
  modal.__visionDirty=true;modal.querySelector('[data-song-unsaved]').hidden=false;if(visionTaskCoordinator)void visionTaskCoordinator.humanActivity();
  status.textContent = "已填入画面建议，尚未保存。核对无误后点击“保存”，将作为手工设置保留。";
}

async function reviewCustomSongVision(modal, onlyFile) {
  if (customSongsState.busy || customSongVisionState.run || modal.hidden || typeof customSongVision === "undefined" || typeof customSongFrameReader === "undefined") return;
  var song = currentCustomSong(modal);
  if (!song) return;
  var targets = song.localFiles.filter(function (file) { return onlyFile ? file.fileName === onlyFile : customSongVision.defaultTarget(file); });
  var status = modal.querySelector("[data-custom-vision-status]");
  if (!targets.length) { status.textContent = "当前曲目没有待核对的视频；原始和手工映射已保留。"; return; }
  if (targets.some(function (file) { return !file.fileRevision; })) { status.textContent = "需要更新本地服务并重启后，才能核对画面。"; return; }
  if (targets.length > 12) { status.textContent = "这首曲目的视频较多，请逐个点击“核对画面”，避免一次读取过多文件。"; return; }
  var run = { controller: new AbortController(), epoch: customSongVisionState.epoch, song: song.nameKey };
  customSongVisionState.run = run;
  customSongManagerBusy(modal, false);
  var current = function () { return !run.controller.signal.aborted && run.epoch === customSongVisionState.epoch && !modal.hidden && song.nameKey === customSongsState.selected; };
  try {
    if(visionTaskCoordinator)await visionTaskCoordinator.humanActivity();
    for (var index = 0; index < targets.length; index++) {
      if (!current()) break;
      var file = targets[index];
      status.textContent = "正在核对画面 " + (index + 1) + "/" + targets.length + "，可随时取消；不会改变播放队列。";
      var cached = onlyFile ? null : customSongVisionState.cache.get(file);
      if (cached) {
        customSongVisionState.results[file.fileName] = Object.assign(customSongVision.summarize(cached), { cached: true });
        renderCustomSongVision(modal);
        continue;
      }
      var frames = [];
      try {
        await customSongFrameReader.capture({ url: file.url, signal: run.controller.signal, onFrame: function (frame) {
          if (!current()) return true;
          var feature = customSongVision.features(frame.imageData, frame.sourceWidth, frame.sourceHeight);
          var result = customSongVision.classify(feature);
          frames.push(Object.assign({}, result, { time: frame.time, verified: frame.verified }));
          var summary = customSongVision.summarize(frames);
          customSongVisionState.results[file.fileName] = Object.assign(summary, { thumbnail: frame.thumbnail });
          renderCustomSongVision(modal);
          return summary.stable || summary.reason === "frame-conflict" || (frames.length >= 2 && summary.reason === "unfamiliar-scene");
        } });
        if (current()) customSongVisionState.cache.set(file, frames);
      } catch (error) {
        if (!current()) break;
        customSongVisionState.results[file.fileName] = { tod: null, stable: false,
          error: error.name === "TimeoutError" ? "取帧超时，可重试或手工核对。" : "取帧未完成，可重试或手工核对。" };
        renderCustomSongVision(modal);
      }
    }
    if (current()) status.textContent = "核对已结束。画面建议不等于原始记录；采用后还需点击“保存”。";
  } finally {
    if (customSongVisionState.run === run) customSongVisionState.run = null;
    if (!modal.hidden) {
      if (run.controller.signal.aborted && status.textContent === "正在取消画面核对…") status.textContent = "已取消画面核对，没有保存任何映射。";
      customSongManagerBusy(modal, customSongsState.busy);
      renderCustomSongVision(modal);
    }
  }
}

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
  var cache = customSongListState, epoch = cache.epoch, root = customSongRootKey();
  var firstPage = !params || !Number(params.cursor || 0);
  if (firstPage) cache.ready = false;
  cache.pending++;
  try {
    var data = await callApi("/api/custom-songs/search", {
      method: "POST",
      body: Object.assign({}, params || {}, {
        detectedRoot: officialSongStoragePath(),
        cached: true,
      }),
      signal: config && config.signal,
    });
    if (epoch !== cache.epoch || root !== customSongRootKey() || (config && config.signal && config.signal.aborted)) {
      var stale = new Error("曲库已刷新，已忽略过期的列表请求。");
      stale.name = "AbortError";
      throw stale;
    }
    if (firstPage) {
      cache.root = root;
      cache.total = Number(data.total);
      cache.firstId = data.list && data.list.length ? String(data.list[0].id || data.list[0].userSongId) : null;
      cache.ready = Array.isArray(data.list) && (data.list.length > 0 || cache.total === 0);
    }
    customSongsState.data = data;
    customSongsState.error = "";
    trackCustomSongRefresh(data);
    return data;
  } catch (error) {
    if (epoch === cache.epoch) {
      cache.ready = false;
      if (error.name !== "AbortError") customSongsState.error = error.message || String(error);
    }
    throw error;
  } finally {
    cache.pending--;
    mountCustomSongTools();
  }
}

localCustomSongSearch.canReuse = canReuseCustomSongList;
localCustomSongSearch.invalidate = invalidateCustomSongList;

function mountCustomSongTools() {
  var route = window.location.hash || window.location.pathname;
  var existing = document.getElementById("local-mail-custom-song-tools");
  var view = musicView();
  var visible = /\/studio\/?(?:[?#].*)?$/.test(route.replace(/^#/, "")) && !isCustomMusicView()
    && view && Number(view.sourceType) === 3;
  if (existing) setLocalElementHidden(existing, !visible);
  if (!visible) { stopCustomSongRefresh(false); return; }
  resumeCustomSongRefresh();
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
  var refresh = customSongsState.data && customSongsState.data.refresh;
  if (refresh && refresh.refreshing) message += " · 已显示保存的曲目，正在后台检查";
  else if (refresh && refresh.error) message += " · 后台检查未完成，可在管理中重新扫描";
  setLocalElementText(toolbar.querySelector("[role='status']"), message);
}

function customSongsChanged() {
  invalidateCustomSongList();
  visionInputRevision='mutation-'+(++visionMutationRevision);syncVisionTasks();
  window.dispatchEvent(new Event("linli-custom-songs-changed"));
}

// This adapter is the only diagnostic boundary that knows manager/vision state.
function customSongDiagnosticsFor(modal) {
  if (!modal.__songDiagnostics) {
    modal.__songDiagnostics = createCustomSongDiagnostics({
      summary: modal.querySelector("[data-custom-diagnostic-summary]"),
      detail: modal.querySelector("[data-custom-diagnostic-detail]"),
      reasons: modal.querySelector("[data-custom-diagnostic-reasons]"),
      exportButton: modal.querySelector("[data-custom-diagnostic-export]"),
      unifiedExport: true,
      getRoot: function () { return modal.querySelector("[data-custom-root]").value.trim(); },
      isHidden: function () { return modal.hidden; },
      isBusy: function () { return customSongsState.busy || Boolean(customSongVisionState.run) || Boolean(modal.__songDebugPackage && modal.__songDebugPackage.isBusy()); },
      refreshBusy: function () { customSongManagerBusy(modal, customSongsState.busy); },
      request: callApi,
      download: downloadJson
    });
  }
  return modal.__songDiagnostics;
}

async function openCustomSongManager() {
  installStyles();
  var modal = document.getElementById("local-mail-custom-song-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "local-mail-custom-song-modal";
    modal.className = "lm-modal-backdrop";
    modal.innerHTML =
      '<section class="lm-modal lm-song-manager" role="dialog" aria-modal="true" aria-labelledby="local-custom-song-title">' +
      '<header class="lm-song-manager-header"><div class="lm-modal-title" id="local-custom-song-title">本地定制演奏</div></header>' +
      '<div class="lm-song-manager-body">' +
      '<label>选择曲目<select class="lm-select" data-custom-song aria-label="选择曲目"></select></label>' +
      '<div class="lm-modal-actions"><button type="button" class="lm-button lm-button-small" data-custom-prev>上一页</button><span data-custom-page></span><button type="button" class="lm-button lm-button-small" data-custom-next>下一页</button></div>' +
      '<label>曲名<input class="lm-input" data-custom-name aria-label="曲名"></label>' +
      '<section class="lm-song-fill"><div class="lm-song-inline"><button class="lm-button lm-button-small" data-vision-batch-start>一键补齐缺失时段</button><button type="button" class="lm-song-help" aria-label="补齐说明" data-song-help="仅补齐当前曲库缺失时段并保存，不覆盖手动校正；可在任务详情查看进度或撤销。">?</button></div>' +
      '<details class="lm-song-disclosure" data-song-task-details><summary>任务详情</summary><select class="lm-select" aria-label="识别任务记录" data-vision-batch-jobs></select>' +
      '<div class="lm-modal-actions"><button class="lm-button lm-button-small" data-vision-batch-pause>暂停</button><button class="lm-button lm-button-small" data-vision-batch-resume>继续 / 接管</button>' +
      '<button class="lm-button lm-button-small" data-vision-batch-stop>停止</button><button class="lm-button lm-button-small" data-vision-batch-undo>撤销本次补齐</button></div>' +
      '<div data-vision-batch-results></div><button class="lm-button lm-button-small" data-vision-batch-next>下一页任务结果</button></details></section>' +
      '<div data-custom-files></div><div class="lm-modal-actions"><button type="button" class="lm-button lm-button-small" data-custom-vision-start>画面辅助核对</button><button type="button" class="lm-button lm-button-small" data-custom-vision-cancel style="display:none">取消核对</button></div>' +
      '<p class="lm-modal-status" role="status" data-custom-vision-status>建议不会自动保存。</p>' +
      '<details class="lm-song-disclosure" data-song-advanced><summary>更多选项</summary>' +
      '<section class="lm-song-group"><div class="lm-song-inline"><h3>目录与扫描</h3><button type="button" class="lm-song-help" aria-label="扫描说明" data-song-help="读取已下载的演奏视频与本地记录。缺失时段暂时复用已有视频；扫描不能找回已删除的历史数据。">?</button></div>' +
      '<label>曲目下载文件夹<input class="lm-input" data-custom-root aria-label="曲目下载文件夹"></label>' +
      '<div class="lm-modal-actions"><button type="button" class="lm-button lm-button-small" data-custom-scan>重新扫描</button></div></section>' +
      '<section class="lm-song-group"><h3>映射备份</h3><p class="lm-modal-status">导入会覆盖相同文件名的映射，建议先导出备份。</p>' +
      '<div class="lm-modal-actions"><button type="button" class="lm-button lm-button-small" data-custom-mapping-export>导出映射 JSON</button><button type="button" class="lm-button lm-button-small" data-custom-mapping-import>导入映射 JSON</button><input type="file" accept=".json,application/json" data-custom-mapping-file aria-label="导入歌曲映射 JSON" hidden></div></section>' +
      '<section class="lm-song-group"><h3>诊断</h3><p class="lm-modal-status" role="status" data-custom-diagnostic-summary></p>' +
      '<div class="lm-modal-actions"><button type="button" class="lm-button lm-button-small" data-custom-diagnostic-reasons disabled>查看原因</button><button type="button" class="lm-button lm-button-small" data-custom-diagnostic-export>导出诊断</button></div>' +
      '<div class="lm-modal-status" data-custom-diagnostic-detail style="display:none;white-space:pre-wrap;overflow-wrap:anywhere"></div></section></details></div>' +
      '<footer class="lm-song-manager-footer"><div class="lm-song-feedback"><span class="lm-modal-status" role="status" data-song-unsaved hidden>有未保存的修改</span><p class="lm-modal-status" role="status" data-vision-batch-status></p><p class="lm-modal-status" role="status" data-custom-status></p></div>' +
      '<div class="lm-modal-actions"><button type="button" class="lm-button" data-custom-close>关闭</button><button type="button" class="lm-button lm-button-primary" data-custom-save>保存</button></div></footer></section>';
    document.body.appendChild(modal);
    var exportDialog = document.createElement('div');
    exportDialog.id = 'local-mail-song-export-dialog'; exportDialog.className = 'lm-modal-backdrop lm-song-export-backdrop'; exportDialog.hidden = true;
    exportDialog.innerHTML = '<section class="lm-modal lm-song-export-dialog" role="dialog" aria-modal="true" aria-labelledby="lm-song-export-title"><div class="lm-modal-title" id="lm-song-export-title">导出诊断</div>' +
      '<p class="lm-modal-status" role="status" data-custom-debug-status></p><p class="lm-song-warning">附带片段已在本地服务中定向移除凭据，但仍可能含曲名、账号、路径及其他私人内容，并非完全匿名。仅私下提供，勿公开发布。片段已改写，不是原始日志字节。不会自动上传。</p>' +
      '<div class="lm-modal-actions"><button type="button" class="lm-button" data-custom-debug-fragments>附带脱敏片段并导出</button><button type="button" class="lm-button lm-button-primary" data-custom-debug-basic>仅导出诊断</button><button type="button" class="lm-button" data-custom-debug-cancel>取消</button></div></section>';
    document.body.appendChild(exportDialog);
    modal.__songHelp = createCustomSongDiagnostics.createHelp(modal);
    modal.querySelector("[data-custom-close]").onclick = function () {
      if (!customSongsState.busy && !customSongDiagnosticsFor(modal).isExporting()) {
        if (modal.__visionDirty && !window.confirm('当前修改尚未保存，放弃修改并关闭？')) return;
        modal.__songDebugPackage.cancel();
        modal.__songHelp.hide();
        modal.__visionDirty=false;if(visionTaskCoordinator)visionTaskCoordinator.closePanel();
        clearCustomSongVision(modal);
        modal.hidden = true;
        modal.querySelectorAll("video").forEach(function (video) {
          video.pause();
          video.removeAttribute("src");
          if (video.load) video.load();
        });
      }
    };
    modal.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        if (modal.__managerView !== 'home') { event.preventDefault(); event.stopPropagation(); leaveCustomSongView(modal); }
        else modal.querySelector("[data-custom-close]").click();
      }
    });
    modal.querySelector("[data-custom-scan]").onclick = function () {
      void loadCustomSongManager(modal, true);
    };
    modal.querySelector("[data-custom-mapping-export]").onclick = function () { void exportCustomSongMappings(modal); };
    modal.querySelector("[data-custom-mapping-import]").onclick = function () {
      if (customSongsState.busy || customSongVisionState.run) return;
      if (!window.confirm("导入会使用 JSON 中的值覆盖相同文件名的映射（包括曲名、文件路径和时段）。建议先取消并点击“导出映射 JSON”，备份自己的映射文件。是否继续选择文件导入？")) return;
      var input = modal.querySelector("[data-custom-mapping-file]");
      input.value = "";
      input.click();
    };
    modal.querySelector("[data-custom-mapping-file]").onchange = function () { void importCustomSongMappings(modal, this.files && this.files[0]); };
    modal.querySelector("[data-custom-root]").oninput = function () {
      modal.__songDebugPackage.cancel();
      invalidateCustomSongList();
      customSongDiagnosticsFor(modal).setSnapshot(null, "目录已更改，请重新扫描以获得此目录的报告。");
    };
    customSongDiagnosticsFor(modal);
    var tasks=getVisionTaskCoordinator();
    modal.__visionTasks=tasks;
    modal.querySelector('[data-vision-batch-start]').onclick=function(){void refreshAndOrganizeCustomSongs(modal);};
    ['pause','resume','stop','undo'].forEach(function(action){modal.querySelector('[data-vision-batch-'+action+']').onclick=function(){
      if(action==='undo'&&!window.confirm('仅撤销仍属于本次任务且未被后来修改的项；已修改项会跳过。继续？'))return;void tasks.control(action);
    };});
    modal.querySelector('[data-vision-batch-jobs]').onchange=function(){tasks.select(this.value);};
    modal.querySelector('[data-vision-batch-next]').onclick=function(){tasks.next();};
    function dirtyVisionForm(event){if(event.target&&event.target.matches&&event.target.matches('[data-custom-name],[data-custom-file]')){modal.__visionDirty=true;modal.querySelector('[data-song-unsaved]').hidden=false;void tasks.humanActivity();}}
    modal.addEventListener('input',dirtyVisionForm);modal.addEventListener('change',dirtyVisionForm);
    modal.__songDebugPackage = createCustomSongDiagnostics.createDebugPackage({
      openButton: modal.querySelector('[data-custom-diagnostic-export]'), panel: exportDialog,
      status: exportDialog.querySelector('[data-custom-debug-status]'),
      fragmentButton: exportDialog.querySelector('[data-custom-debug-fragments]'), basicButton: exportDialog.querySelector('[data-custom-debug-basic]'), cancelButton: exportDialog.querySelector('[data-custom-debug-cancel]'),
      getRoot: function () { return modal.querySelector('[data-custom-root]').value.trim(); },
      isHidden: function () { return modal.hidden; },
      isBusy: function () { return customSongsState.busy || Boolean(customSongVisionState.run) || customSongDiagnosticsFor(modal).isExporting(); },
      refreshBusy: function () { customSongManagerBusy(modal, customSongsState.busy); }, request: callApi,
      onOpen: function () { modal.inert = true; modal.setAttribute('aria-hidden', 'true'); modal.__songHelp.hide(); var button = exportDialog.querySelector('[data-custom-debug-cancel]'); if (button.focus) button.focus(); },
      onClose: function () { modal.inert = false; modal.removeAttribute('aria-hidden'); var button = modal.querySelector('[data-custom-diagnostic-export]'); if (!modal.hidden && button.focus) button.focus(); },
      onExport: function (include) { modal.querySelector('[data-custom-status]').textContent = include ? '已发起下载。附带片段仍含私人信息，仅私下提供。' : '已发起诊断下载，不含私人片段。'; },
      downloadBasic: downloadJson,
      delay: function () { return new Promise(function (resolve) { setTimeout(resolve, 500); }); },
      download: function (bundle) {
        if (!bundle || bundle.mimeType !== 'application/gzip' || !/^linli-song-debug-(SENSITIVE-)?[a-f0-9-]+\.json\.gz$/.test(bundle.fileName) ||
          typeof bundle.base64 !== 'string' || bundle.base64.length > 17 * 1024 * 1024) throw new Error('invalid-package');
        var binary = atob(bundle.base64), bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        var url = URL.createObjectURL(new Blob([bytes], { type: 'application/gzip' }));
        var link = document.createElement('a'); link.href = url; link.download = bundle.fileName; document.body.appendChild(link); link.click(); link.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      }
    });
    exportDialog.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); modal.__songDebugPackage.cancel(); }
      if (event.key === 'Tab') {
        var buttons = Array.prototype.filter.call(exportDialog.querySelectorAll('button'), function (button) { return !button.disabled && !button.hidden; });
        var first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    modal.querySelector("[data-custom-prev]").onclick = function () {
      customSongsState.page = Math.max(0, customSongsState.page - 1);
      void loadCustomSongManager(modal, false);
    };
    modal.querySelector("[data-custom-next]").onclick = function () {
      customSongsState.page += 1;
      void loadCustomSongManager(modal, false);
    };
    modal.querySelector("[data-custom-song]").onchange = function () {
      clearCustomSongVision(modal);
      customSongsState.selected = this.value;
      renderCustomSongEditor(modal);
    };
    modal.querySelector("[data-custom-vision-start]").onclick = function () { void reviewCustomSongVision(modal); };
    modal.querySelector("[data-custom-vision-cancel]").onclick = function () {
      clearCustomSongVision(modal);
      modal.querySelector("[data-custom-vision-status]").textContent = "正在取消画面核对…";
      renderCustomSongVision(modal);
    };
    modal.querySelector("[data-custom-save]").onclick = function () {
      void saveCustomSongEditor(modal);
    };
    installCustomSongHome(modal);
  }
  modal.hidden = false;
  setCustomSongView(modal, 'home');
  modal.__songDebugPackage.cancel();
  clearCustomSongVision(modal);
  modal.querySelector("[data-custom-root]").value =
    (customSongsState.data && customSongsState.data.mediaRoot) || "";
  customSongsState.page = 0;
  customSongDiagnosticsFor(modal).setSnapshot(null);
  await loadCustomSongManager(modal, false);
  if (!musicShape().loaded) { try { await ensureMusicLibraryLoaded(false, true); } catch (ignored) {} }
  syncVisionTasks('manager-opened');
  renderCustomSongHome(modal);
  getVisionTaskCoordinator().open();
}

function installCustomSongHome(modal) {
  var body=modal.querySelector('.lm-song-manager-body'), header=modal.querySelector('.lm-song-manager-header'), footer=modal.querySelector('.lm-song-manager-footer');
  var manual=document.createElement('div');manual.setAttribute('data-song-editor-pane','');
  while(body.firstChild)manual.appendChild(body.firstChild);
  body.appendChild(manual);
  var home=document.createElement('div');home.className='lm-song-home';home.setAttribute('data-song-home','');
  home.innerHTML='<section class="lm-song-home-section"><h3>歌曲文件夹</h3><div class="lm-song-path-row"><span data-song-effective-path class="lm-song-path" aria-label="生效的歌曲文件夹"></span><button class="lm-button lm-button-small" data-song-folder-change>更换歌曲文件夹</button></div></section>'+
    '<section class="lm-song-home-section lm-song-auto-row"><div><h3>自动整理</h3><p class="lm-modal-status">新增歌曲自动识别并保存；不覆盖手工设置。</p></div><label class="lm-music-switch"><input type="checkbox" role="switch" data-song-home-auto aria-label="自动整理"></label></section>'+
    '<section class="lm-song-home-section lm-song-mapping-row"><h3>歌曲映射</h3><div class="lm-modal-actions" data-song-home-mappings></div></section><p class="lm-modal-status" role="status" data-song-home-notice></p><div data-song-home-tasks></div>';
  body.insertBefore(home,manual);
  var list=document.createElement('div');list.setAttribute('data-song-list-pane','');
  list.innerHTML='<div class="lm-song-list-toolbar"><input class="lm-input" data-song-list-search aria-label="搜索本页歌曲" placeholder="搜索本页歌曲"><span class="lm-modal-status" data-song-list-count></span></div><div data-song-list-rows></div>';
  body.insertBefore(list,manual);
  var pager=modal.querySelector('[data-custom-prev]').parentElement;list.appendChild(pager);
  modal.querySelector('[data-custom-song]').parentElement.hidden=true;
  var sourceRoot=modal.querySelector('[data-custom-root]');sourceRoot.parentElement.hidden=true;
  home.appendChild(sourceRoot.parentElement);
  ['export','import','file'].forEach(function(key){home.querySelector('[data-song-home-mappings]').appendChild(modal.querySelector('[data-custom-mapping-'+key+']'));});
  home.querySelector('[data-song-home-tasks]').appendChild(modal.querySelector('[data-song-task-details]'));
  var fill=manual.querySelector('.lm-song-fill');if(fill)fill.hidden=true;
  var advanced=manual.querySelector('[data-song-advanced]');if(advanced)advanced.hidden=true;
  var back=document.createElement('button');back.className='lm-button lm-button-small';back.setAttribute('data-song-view-back','');back.textContent='返回';header.insertBefore(back,header.firstChild);
  back.onclick=function(){leaveCustomSongView(modal);};
  var exportButton=modal.querySelector('[data-custom-diagnostic-export]');footer.insertBefore(exportButton,footer.firstChild);
  var actions=modal.querySelector('[data-custom-save]').parentElement;
  var manualButton=document.createElement('button');manualButton.className='lm-button';manualButton.setAttribute('data-song-manual','');manualButton.textContent='手动整理';actions.insertBefore(manualButton,actions.firstChild);
  manualButton.onclick=function(){setCustomSongView(modal,'list');};
  var organize=modal.querySelector('[data-vision-batch-start]');organize.textContent='重新识别全部歌曲';actions.insertBefore(organize,modal.querySelector('[data-custom-close]'));
  var cancel=document.createElement('button');cancel.className='lm-button';cancel.setAttribute('data-song-edit-cancel','');cancel.textContent='取消';actions.insertBefore(cancel,modal.querySelector('[data-custom-save]'));
  cancel.onclick=function(){leaveCustomSongView(modal);};
  home.querySelector('[data-song-folder-change]').onclick=function(){void changeCustomSongFolder(modal);};
  home.querySelector('[data-song-home-auto]').onchange=async function(){
    var value=this.checked;try{await setMusicFeature('visionAutoFillEnabled',value);modal.querySelector('[data-custom-status]').textContent=value?'自动整理已开启':'自动整理已关闭，已有结果保留';}
    catch(error){modal.querySelector('[data-custom-status]').textContent=error.message||'自动整理设置未保存';}finally{renderCustomSongHome(modal);}
  };
  list.querySelector('[data-song-list-search]').oninput=function(){renderCustomSongList(modal);};
  modal.__managerHomeReady=true;
}
function setCustomSongView(modal, view) {
  if (!modal.__managerHomeReady) return;
  modal.__managerView=view;modal.__songHelp.hide();
  modal.querySelector('[data-song-home]').hidden=view!=='home';
  modal.querySelector('[data-song-list-pane]').hidden=view!=='list';
  modal.querySelector('[data-song-editor-pane]').hidden=view!=='editor';
  modal.querySelector('[data-song-view-back]').hidden=view==='home';
  modal.querySelector('#local-custom-song-title').textContent=view==='home'?'本地演奏':view==='list'?'本地歌曲':'修正这首歌';
  modal.querySelector('.lm-song-manager-footer').hidden=view==='list';
  ['[data-custom-diagnostic-export]','[data-song-manual]','[data-vision-batch-start]','[data-custom-close]'].forEach(function(selector){modal.querySelector(selector).hidden=view!=='home';});
  ['[data-custom-save]','[data-song-edit-cancel]'].forEach(function(selector){modal.querySelector(selector).hidden=view!=='editor';});
  if(view==='list')renderCustomSongList(modal);
  if(view==='home')renderCustomSongHome(modal);
  modal.querySelector('.lm-song-manager-body').scrollTop=0;
}
function leaveCustomSongView(modal) {
  if(customSongsState.busy)return;
  if(modal.__visionDirty&&!window.confirm('这首歌还有未保存的修改，放弃并返回？'))return;
  if(modal.__managerView==='editor'){clearCustomSongVision(modal);renderCustomSongEditor(modal);setCustomSongView(modal,'list');}
  else setCustomSongView(modal,'home');
}
function renderCustomSongList(modal) {
  if(!modal.__managerHomeReady)return;
  var data=modal.__customSongsPage, query=modal.querySelector('[data-song-list-search]').value.trim().toLowerCase(), rows=modal.querySelector('[data-song-list-rows]');rows.textContent='';
  var songs=data&&data.list||[];songs.filter(function(song){return !query||String(song.name).toLowerCase().indexOf(query)>=0;}).forEach(function(song){
    var row=document.createElement('div');row.className='lm-song-list-row';var name=document.createElement('span');name.textContent=song.name;row.appendChild(name);
    var button=document.createElement('button');button.className='lm-button lm-button-small';button.textContent='修正';button.setAttribute('data-song-edit',song.nameKey);
    button.onclick=function(){customSongsState.selected=song.nameKey;modal.querySelector('[data-custom-song]').value=song.nameKey;clearCustomSongVision(modal);renderCustomSongEditor(modal);setCustomSongView(modal,'editor');customSongManagerBusy(modal,false);};row.appendChild(button);rows.appendChild(row);
  });
  if(!rows.childNodes.length)rows.textContent=query?'本页没有匹配的歌曲':'此文件夹尚无可整理的歌曲';
  modal.querySelector('[data-song-list-count]').textContent=data?'共 '+data.total+' 首':'';
}
function renderCustomSongHome(modal) {
  if(!modal.__managerHomeReady)return;
  var root=customSongsState.data&&customSongsState.data.mediaRoot||modal.querySelector('[data-custom-root]').value;
  setLocalElementText(modal.querySelector('[data-song-effective-path]'),root||'尚未找到歌曲文件夹');modal.querySelector('[data-song-effective-path]').title=root;
  var input=modal.querySelector('[data-song-home-auto]');input.checked=musicFeatureEnabled('visionAutoFillEnabled');
  input.disabled=customSongsState.busy||Boolean(musicShape().featureSaving&&musicShape().featureSaving.visionAutoFillEnabled)||!musicShape().loaded;
  var data=customSongsState.data, notice=customSongsState.error||data&&data.refresh&&data.refresh.error||(!data?'':data.total===0?'此文件夹中还没有找到演奏文件。':data.refresh&&data.refresh.refreshing?'正在检查本地演奏，已有曲目可继续使用。':'');
  setLocalElementText(modal.querySelector('[data-song-home-notice]'),notice);setLocalElementHidden(modal.querySelector('[data-song-home-notice]'),!notice);
  var task=visionTaskCoordinator&&visionTaskCoordinator.status();modal.querySelector('[data-song-task-details]').hidden=!(task&&task.job);
}
async function changeCustomSongFolder(modal) {
  if(customSongsState.busy)return;var oldRoot=modal.querySelector('[data-custom-root]').value;customSongManagerBusy(modal,true);
  var changed=false;
  try{
    var result=await callApi('/api/custom-songs/choose-folder',{method:'POST',body:{mediaRoot:oldRoot||undefined}});
    if(result.cancelled===true)return;
    if(typeof result.path!=='string'||!result.path)throw new Error('文件夹选择无效');
    var scan=await callApi('/api/custom-songs/scan',{method:'POST',body:{mediaRoot:result.path}});
    modal.querySelector('[data-custom-root]').value=scan.mediaRoot||result.path;
    customSongsState.data=Object.assign({},customSongsState.data||{},{mediaRoot:scan.mediaRoot||result.path});
    customSongsState.page=0;customSongsState.selected=null;customSongsState.error='';customSongDiagnosticsFor(modal).setSnapshot(scan.diagnostics||null);changed=true;
  }catch(error){modal.querySelector('[data-custom-root]').value=oldRoot;modal.querySelector('[data-custom-status]').textContent=error.message||'文件夹未更换';}
  finally{customSongManagerBusy(modal,false);renderCustomSongHome(modal);}
  if(changed){customSongsChanged();await loadCustomSongManager(modal,false);syncVisionTasks('folder-changed');}
}
async function refreshAndOrganizeCustomSongs(modal) {
  if(customSongsState.busy||modal.__visionDirty)return;
  await loadCustomSongManager(modal,true);
  if(!customSongsState.error)await getVisionTaskCoordinator().startManual();
  renderCustomSongHome(modal);
}

async function exportCustomSongMappings(modal) {
  if (customSongsState.busy || customSongVisionState.run) return;
  customSongManagerBusy(modal, true);
  var status = modal.querySelector("[data-custom-status]");
  try {
    var document = await callApi("/api/custom-songs/mappings/export", { method: "POST",
      body: { mediaRoot: modal.querySelector("[data-custom-root]").value.trim() || undefined } });
    downloadJson(document, "linli-custom-song-mappings");
    status.textContent = "已导出 " + document.entries.length + " 条歌曲映射。";
  } catch (error) { status.textContent = "导出失败：" + (error.message || String(error)); }
  finally { customSongManagerBusy(modal, false); }
}

async function importCustomSongMappings(modal, file) {
  if (!file || customSongsState.busy || customSongVisionState.run) return;
  customSongManagerBusy(modal, true);
  var status = modal.querySelector("[data-custom-status]"), result;
  try {
    if (file.size > 8 * 1024 * 1024) throw new Error("映射 JSON 不能超过 8 MiB");
    var document;
    try { document = JSON.parse((await file.text()).replace(/^\uFEFF/, "")); }
    catch (error) { throw new Error("无法读取有效的 JSON 文件，请检查文件内容。"); }
    result = await callApi("/api/custom-songs/mappings/import", { method: "POST", body: { document: document } });
    clearCustomSongVision(modal);
    customSongDiagnosticsFor(modal).setSnapshot(null, "映射已导入，缺项将在读取曲目时补充。");
    customSongsState.page = 0;
    customSongsChanged();
  } catch (error) { status.textContent = "导入失败：" + (error.message || String(error)); }
  finally {
    modal.querySelector("[data-custom-mapping-file]").value = "";
    customSongManagerBusy(modal, false);
  }
  if (result) {
    await loadCustomSongManager(modal, false);
    status.textContent = "已导入 " + result.imported + " 条映射，其中覆盖 " + result.overwritten + " 条。" +
      (customSongsState.error ? "曲目刷新失败：" + customSongsState.error : "已刷新曲目列表。");
  }
}

function customSongManagerBusy(modal, busy) {
  customSongsState.busy = busy;
  var reviewing = Boolean(customSongVisionState.run);
  modal.querySelectorAll("button,input,select").forEach(function (node) {
    node.disabled = busy || reviewing || Boolean(customSongDiagnosticsFor(modal).isExporting()) || Boolean(modal.__songDebugPackage && modal.__songDebugPackage.isBusy());
  });
  modal.querySelector("[data-custom-close]").disabled = busy || Boolean(customSongDiagnosticsFor(modal).isExporting());
  modal.querySelector("[data-custom-vision-cancel]").disabled = !reviewing;
  modal.querySelector("[data-custom-vision-cancel]").style.display = reviewing ? "" : "none";
  if (!busy && !reviewing && !customSongDiagnosticsFor(modal).isExporting() && !(modal.__songDebugPackage && modal.__songDebugPackage.isBusy())) {
    var data = modal.__customSongsPage;
    modal.querySelector("[data-custom-prev]").disabled =
      !data || customSongsState.page === 0;
    modal.querySelector("[data-custom-next]").disabled = !data || !data.hasMore;
    modal.querySelector("[data-custom-save]").disabled =
      !customSongsState.selected;
    modal.querySelector("[data-custom-vision-start]").disabled = !customSongsState.selected || typeof customSongFrameReader === "undefined";
    renderCustomSongVision(modal);
  }
  customSongDiagnosticsFor(modal).render();
  if (modal.__songDebugPackage) modal.__songDebugPackage.render();
  if(visionTaskCoordinator)renderVisionTaskPanel({data:visionTaskCoordinator.status(),job:visionTaskCoordinator.status()&&visionTaskCoordinator.status().job,busy:false,message:''});
}

async function loadCustomSongManager(modal, scan) {
  if (customSongsState.busy || customSongVisionState.run || customSongDiagnosticsFor(modal).isExporting()) return;
  if (scan) invalidateCustomSongList();
  if (scan) customSongDiagnosticsFor(modal).setSnapshot(null, "正在扫描，报告将在本次扫描结束后生成。");
  clearCustomSongVision(modal);
  customSongManagerBusy(modal, true);
  var status = modal.querySelector("[data-custom-status]");
  status.textContent = scan ? "正在扫描本地视频…" : "正在读取曲目…";
  try {
    var root =
      modal.querySelector("[data-custom-root]").value.trim() || undefined;
    if (scan) {
      var scanResult = await callApi("/api/custom-songs/scan", {
        method: "POST",
        body: { mediaRoot: root },
      });
      if (scanResult.diagnostics) {
        modal.querySelector("[data-custom-root]").value = scanResult.diagnostics.local.mediaRoot;
        customSongDiagnosticsFor(modal).setSnapshot(scanResult.diagnostics);
      }
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
    if (!scan) {
      try {
        customSongDiagnosticsFor(modal).setSnapshot(await callApi("/api/custom-songs/diagnostics", {
          method: "POST", body: { mediaRoot: data.mediaRoot }
        }));
      } catch (diagnosticError) {
        customSongDiagnosticsFor(modal).setSnapshot(null, diagnosticError.message || "尚无扫描报告，请重新扫描。");
      }
    }
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
      ? "已读取"
      : "未找到可用的定制演奏视频。请检查下载文件夹。";
    if (data.warnings && data.warnings.length)
      status.textContent += "\n" + data.warnings.join("\n");
    renderCustomSongEditor(modal);
    customSongsState.error='';
    if(modal.__managerHomeReady){renderCustomSongList(modal);renderCustomSongHome(modal);}
    if (scan) customSongsChanged();
  } catch (error) {
    if (error.scanDiagnostics) {
      modal.querySelector("[data-custom-root]").value = error.scanDiagnostics.local.mediaRoot;
      customSongDiagnosticsFor(modal).setSnapshot(error.scanDiagnostics, "扫描失败，已保留本次收集到的诊断。");
    } else if (!customSongDiagnosticsFor(modal).hasSnapshot() || !scan) {
      customSongDiagnosticsFor(modal).setSnapshot(null, "尚无本次扫描报告：服务不可达或扫描未启动，请确认本地服务后重试。");
    }
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
  modal.__visionDirty=false;
  modal.querySelector('[data-song-unsaved]').hidden=true;
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
  modal.__customInitialName = song ? String(song.name || "") : "";
  if (!song) return;
  var note = document.createElement("p");
  note.className = "lm-modal-status";
  note.textContent = customSongCoverageText(song);
  container.appendChild(note);
  song.localFiles.forEach(function (file) {
    var row = document.createElement("div");
    row.style.cssText = "margin-top:12px";
    var label = document.createElement("label");
    label.className = "lm-modal-status";
    label.textContent = file.fileName;
    var badges = document.createElement("div");
    badges.className = "lm-evidence-badges";
    var evidenceBadge = document.createElement("span");
    evidenceBadge.className = "lm-badge";
    evidenceBadge.textContent = customSongEvidenceLabel(file);
    badges.appendChild(evidenceBadge);
    if (file.conflict === true) {
      var conflictBadge = document.createElement("span");
      conflictBadge.className = "lm-badge";
      conflictBadge.textContent = "原始记录冲突";
      badges.appendChild(conflictBadge);
    }
    var evidenceNote = document.createElement("p");
    evidenceNote.className = "lm-modal-status";
    evidenceNote.textContent = file.evidenceNote ? String(file.evidenceNote) : "";
    var help = document.createElement('button'); help.type = 'button'; help.className = 'lm-song-help'; help.textContent = '?';
    help.setAttribute('aria-label', file.fileName + ' 来源说明');
    help.setAttribute('data-song-help', (evidenceNote.textContent ? evidenceNote.textContent + '。' : '') + '当前：' + customSongVisionLabel(file.tod) + ' · ' + customSongEvidenceLabel(file) + '。原始或手工映射不会被辅助核对覆盖；画面建议需采用并保存。');
    badges.appendChild(help);
    var select = document.createElement("select");
    select.className = "lm-select";
    select.setAttribute("data-custom-file", file.fileName);
    select.setAttribute("aria-label", "视频时段 " + file.fileName);
    [
      ["__auto__", customSongAutomaticOptionLabel(file)],
      ["", "人工设为未知"],
      ["TOD12", "白天06:00–16:00"],
      ["TOD1730", "傍晚16:00–20:00"],
      ["TOD20", "夜晚20:00–06:00"],
    ].forEach(function (period) {
      var option = document.createElement("option");
      option.value = period[0];
      option.textContent = period[1];
      select.appendChild(option);
    });
    var initialSelection = customSongInitialSelection(file);
    select.setAttribute("data-custom-initial-selection", initialSelection);
    select.value = initialSelection;
    var details = document.createElement("details");
    var summary = document.createElement("summary");
    summary.textContent = "画面核对与预览";
    var video = document.createElement("video");
    video.setAttribute('data-custom-song-preview','');
    video.controls = true;
    video.preload = "none";
    video.src = file.url;
    video.style.cssText = "width:100%;max-height:200px";
    details.appendChild(summary);
    details.appendChild(video);
    row.appendChild(label);
    row.appendChild(badges);
    row.appendChild(select);
    var panel = document.createElement("div");
    panel.setAttribute("data-vision-file", file.fileName);
    panel.style.cssText = "display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap";
    var thumbnail = document.createElement("img");
    thumbnail.setAttribute("data-vision-thumbnail", "");
    thumbnail.alt = "本地视频核对画面";
    thumbnail.style.cssText = "display:none;width:160px;max-width:100%;aspect-ratio:16/9;object-fit:contain;border-radius:6px";
    var hint = document.createElement("p");
    hint.setAttribute("data-vision-message", "");
    hint.className = "lm-modal-status";
    hint.style.cssText = "flex:1;min-width:180px;white-space:pre-wrap;margin:0";
    var actions = document.createElement("div");
    actions.className = "lm-modal-actions";
    var review = document.createElement("button");
    review.type = "button"; review.className = "lm-button lm-button-small";
    review.setAttribute("data-vision-one", ""); review.textContent = "核对画面";
    review.onclick = function () { void reviewCustomSongVision(modal, file.fileName); };
    var apply = document.createElement("button");
    apply.type = "button"; apply.className = "lm-button lm-button-small";
    apply.setAttribute("data-vision-apply", ""); apply.textContent = "采用建议"; apply.disabled = true;
    apply.onclick = function () { applyCustomSongVision(modal, file.fileName); };
    actions.appendChild(review); actions.appendChild(apply);
    details.appendChild(thumbnail); details.appendChild(actions);
    panel.appendChild(hint); panel.appendChild(details);
    row.appendChild(panel);
    container.appendChild(row);
  });
  renderCustomSongVision(modal);
  if (modal.__songHelp) modal.__songHelp.refresh();
}

function customSongEvidence(file) {
  return customSongEvidenceValue(file && file.evidence != null
    ? file.evidence
    : file && file.automaticEvidence);
}

function customSongAutomaticEvidence(file) {
  return customSongEvidenceValue(file && file.automaticEvidence != null
    ? file.automaticEvidence
    : file && file.evidence);
}

function customSongEvidenceValue(value) {
  value = String(value || "").toLowerCase();
  return ["original", "inferred", "manual", "mapping", "legacy", "unknown", "missing", "vision", "vision-pending"].indexOf(value) >= 0
    ? value
    : "unknown";
}

function customSongEvidenceLabelValue(value) {
  var labels = {
    original: "原始记录确认",
    inferred: "排除推定",
    manual: "手工设置",
    mapping: "歌曲映射表",
    legacy: "旧记录待确认",
    vision: "画面推测",
    'vision-pending': "画面推测待核验",
    unknown: "未知",
    missing: "未知",
  };
  return labels[value] || "未知";
}

function customSongEvidenceLabel(file) {
  return customSongEvidenceLabelValue(customSongEvidence(file));
}

function customSongAutomaticOptionLabel(file) {
  var hasAutomaticTod = file && Object.prototype.hasOwnProperty.call(file, "automaticTod");
  var tod = hasAutomaticTod
    ? file.automaticTod
    : file && file.tod != null
      ? file.tod
      : "";
  tod = tod == null ? "" : String(tod);
  var periods = {
    TOD12: "白天",
    TOD1730: "傍晚",
    TOD20: "夜晚",
  };
  return "自动识别：" + (periods[tod] || "未知时段") +
    "（" + customSongEvidenceLabelValue(customSongAutomaticEvidence(file)) + "）";
}

function customSongInitialSelection(file) {
  return customSongEvidence(file) === "manual"
    ? (file && file.tod != null ? String(file.tod) : "")
    : "__auto__";
}

function customSongEffectiveTod(file) {
  if (!file) return "";
  if (customSongEvidence(file) === "manual")
    return file.tod != null && String(file.tod) ? String(file.tod) : "";
  if (file.tod != null && String(file.tod)) return String(file.tod);
  return file.automaticTod != null ? String(file.automaticTod) : "";
}

function customSongCoverageText(song) {
  var counts = { original: 0, inferred: 0, manual: 0, mapping: 0, vision: 0, pending: 0 };
  var periods = {};
  (song.localFiles || []).forEach(function (file) {
    var evidence = customSongEvidence(file);
    if (evidence === "original") counts.original += 1;
    if (evidence === "inferred") counts.inferred += 1;
    if (evidence === "manual") counts.manual += 1;
    if (evidence === "mapping") counts.mapping += 1;
    if (evidence === "vision") counts.vision += 1;
    if (evidence === "legacy" || evidence === "unknown" || evidence === "missing" || evidence === "vision-pending" ||
      (evidence === "manual" && !customSongEffectiveTod(file)) || file.conflict === true)
      counts.pending += 1;
    var tod = customSongEffectiveTod(file);
    if (tod) periods[tod] = true;
  });
  var allPeriods = ["TOD12", "TOD1730", "TOD20"].every(function (tod) {
    return periods[tod];
  });
  var confirmed = allPeriods && !(song.fallbackPeriods || []).length &&
    counts.inferred === 0 && counts.manual === 0 && counts.pending === 0 &&
    (song.localFiles || []).every(function (file) {
      return customSongEvidence(file) === "original" && file.conflict !== true;
    });
  var summary = "原始 " + counts.original + " · 推定 " + counts.inferred +
    " · 手工 " + counts.manual + " · 待确认 " + counts.pending;
  if (counts.mapping) summary += " · 映射表 " + counts.mapping;
  if (confirmed) return "各时段已匹配（原始记录确认）。" + summary;
  if (counts.vision) summary += ' · 画面推测 '+counts.vision;
  if (counts.inferred) summary += "。推定不等于原始确认";
  if (counts.vision) summary += "。画面推测不等于原始确认";
  return (allPeriods ? "各时段已设置，证据状态仍需核对。" : "部分时段未确认或缺失，当前复用现有视频。") + summary;
}

async function saveCustomSongEditor(modal) {
  if (customSongsState.busy || customSongVisionState.run || !customSongsState.selected) return;
  customSongManagerBusy(modal, true);
  try {
    if(visionTaskCoordinator)await visionTaskCoordinator.humanActivity();
    var name = modal.querySelector("[data-custom-name]").value;
    var mappings = Array.prototype.map.call(
      modal.querySelectorAll("[data-custom-file]"),
      function (select) {
        if (select.value === select.getAttribute("data-custom-initial-selection")) return null;
        if (select.value === "__auto__")
          return { fileName: select.getAttribute("data-custom-file"), reset: true };
        return {
          fileName: select.getAttribute("data-custom-file"),
          tod: select.value || null,
        };
      },
    ).filter(Boolean);
    var selectedSong = currentCustomSong(modal);
    mappings.forEach(function (entry) {
      var file = selectedSong && selectedSong.localFiles.find(function (item) { return item.fileName === entry.fileName; });
      if (file && file.fileRevision) entry.expectedFileRevision = file.fileRevision;
    });
    var body = { nameKey: customSongsState.selected };
    if (name !== modal.__customInitialName) body.name = name;
    if (mappings.length) body.mappings = mappings;
    var saved = await callApi("/api/custom-songs/update", {
      method: "POST",
      body: body,
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
    renderCustomSongEditor(modal);
    customSongsChanged();
    modal.querySelector("[data-custom-status]").textContent = "已保存。";
    modal.querySelector("[data-custom-vision-status]").textContent = "已保存。当前映射以保存结果为准，画面建议不会自动写入。";
    if(modal.__managerView==='editor')setCustomSongView(modal,'list');
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
var MUSIC_FEATURE_KEYS = ["customPlaylistsEnabled", "batchOperationsEnabled", "desktopClearEnabled", "visionAutoFillEnabled"];
function musicFeatureEnabled(key) {
  if(key==='visionAutoFillEnabled')return Boolean(musicShape().loaded&&musicShape().features&&musicShape().features[key]===true&&!musicShape().visionAutoBlocked);
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
  music.features = Object.assign({}, music.features || {}, key==='visionAutoFillEnabled'?{visionAutoFillEnabled:false}:patch);
  if(key==='visionAutoFillEnabled'){music.visionAutoBlocked=!value;syncVisionTasks();}
  music.featureSaving[key] = true;
  if (typeof mountMusicEnhancementSettings === "function") mountMusicEnhancementSettings();
  try {
    var savedPreferences=await callApi("/api/music-library/preferences", { method: "POST", body: patch });
    if(key==='visionAutoFillEnabled'&&value&&(!savedPreferences||savedPreferences.visionAutoFillEnabled!==true))throw new Error('服务尚未确认自动补齐已开启，请更新或重试。');
    if(key==='visionAutoFillEnabled'){music.visionAutoBlocked=false;music.loaded=true;}
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
    if(key==='visionAutoFillEnabled')syncVisionTasks('preference-changed');
  } catch (error) {
    music.features[key] = key==='visionAutoFillEnabled'?false:previous;
    if(key==='visionAutoFillEnabled'){music.visionAutoBlocked=true;syncVisionTasks();}
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

async function ensureMusicLibraryLoaded(force, localManager) {
  if (!localManager && !musicBridgeAvailable() && !isSettingsRoute()) return;
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
    syncVisionTasks();
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
