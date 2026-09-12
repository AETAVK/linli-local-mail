// Classic-script factory inside the shared frontend IIFE. No music/vision globals.
// The manager supplies only diagnostic DOM nodes, root/visibility/busy readers,
// a busy-control refresh callback, and the request/download capabilities.
// Each controller owns its snapshot, message and export lifetime; replacing a
// snapshot invalidates an in-flight export by identity, even for the same scanId.
function createCustomSongDiagnostics(options) {
  var snapshotState = null;
  var messageState = "";
  var exporting = false;

  function setSnapshot(snapshot, message) {
    snapshotState = snapshot && snapshot.scanId && snapshot.report && snapshot.local ? snapshot : null;
    messageState = message || "";
    options.detail.style.display = "none";
    options.reasons.textContent = "查看原因";
    render();
  }

  var CUSTOM_DIAGNOSTIC_STAGE_LABELS = {
    line: "行",
    outer: "外层 JSON",
    action: "动作",
    request: "请求",
    inner: "内层 JSON",
    prefix: "前缀",
    fields: "字段",
    merge: "合并",
    match: "匹配",
    coverage: "覆盖",
  };

  var CUSTOM_DIAGNOSTIC_REASON_LABELS = {
    NO_MARKER: "未发现标记",
    ENCODING_SUSPECTED: "疑似编码问题",
    UNCLASSIFIED_OUTER_JSON: "外层 JSON 未分类",
    UNKNOWN_ACTION: "其他或未识别动作",
    REQUEST_TYPE_INVALID: "请求类型无效",
    INNER_JSON_FAILED: "内层 JSON 解析失败",
    PREFIX_NO_RECORDS: "前缀未找到记录",
    PREFIX_NAME_MISSING: "前缀记录缺少歌名",
    NAME_KEY_NOT_EXTRACTED: "未提取名称键",
    NAME_FIELD_MISSING: "名称字段缺失",
    NAME_FIELD_TYPE_INVALID: "名称字段类型无效",
    NAME_BLANK: "名称为空",
    NAME_EQUALS_KEY: "名称等于名称键",
    NO_MATCHING_KEY: "没有匹配名称键",
    NAME_REASON_UNCERTAIN: "名称原因不确定",
    MERGED_NAME_UNUSABLE: "合并后的名称不可用",
    NAME_AVAILABLE: "已获得名称",
  };

  var CUSTOM_DIAGNOSTIC_SOURCE_LABELS = {
    scanned: "扫描所得",
    recovered: "恢复所得",
    retained: "沿用已有",
    manual: "手动名称",
    directory: "目录名称",
    unusable: "不可用名称",
    unindexed: "未入库目录",
  };

  var CUSTOM_DIAGNOSTIC_FILE_STAGE_LABELS = {
    totalLines: "总行",
    nonEmptyLines: "非空行",
    markerLines: "含标记行",
    linesWithoutMarker: "无标记行",
    outerJsonParsed: "外层已解析",
    unclassifiedOuterFailures: "外层未分类失败",
    unknownActions: "未知动作",
    requestTypeFailures: "请求类型失败",
    innerJsonParsed: "内层已解析",
    innerJsonFailures: "内层解析失败",
    prefixAttempts: "前缀尝试",
    prefixRecoveredEvents: "前缀恢复事件",
    prefixEmptyEvents: "前缀空事件",
    eventsWithoutNameKey: "无名称键事件",
    invalidNameRecords: "无效名称记录",
    missingNameRecords: "缺失名称记录",
    logFilesIgnored: "忽略日志",
  };

  function customDiagnosticStageLabel(stage) {
    return Object.prototype.hasOwnProperty.call(CUSTOM_DIAGNOSTIC_STAGE_LABELS, stage) ? CUSTOM_DIAGNOSTIC_STAGE_LABELS[stage] : "未知阶段";
  }

  function customDiagnosticReasonLabel(reasonCode) {
    return Object.prototype.hasOwnProperty.call(CUSTOM_DIAGNOSTIC_REASON_LABELS, reasonCode) ? CUSTOM_DIAGNOSTIC_REASON_LABELS[reasonCode] : "未知原因";
  }

  function customDiagnosticSourceLabel(source) {
    return Object.prototype.hasOwnProperty.call(CUSTOM_DIAGNOSTIC_SOURCE_LABELS, source) ? CUSTOM_DIAGNOSTIC_SOURCE_LABELS[source] : "未知来源";
  }

  function customDiagnosticCount(value) {
    return typeof value === "number" && isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  }

  function customDiagnosticLine(value) {
    return typeof value === "number" && isFinite(value) && value >= 1 ? "第 " + Math.floor(value) + " 行" : "行号未知";
  }

  function customDiagnosticFilePointer(value, omitted) {
    if (omitted === true) return "文件明细已省略";
    return typeof value === "string" && value.trim() ? "匿名文件 " + value : "文件标识未知";
  }

  function customDiagnosticEvidenceLines(report, counts) {
    var lines = [];
    lines.push("阶段统计：行（总 " + customDiagnosticCount(counts.totalLines) + "，非空 " +
      customDiagnosticCount(counts.nonEmptyLines) + "，含标记 " + customDiagnosticCount(counts.markerLines) +
      "，无标记 " + customDiagnosticCount(counts.linesWithoutMarker) + "）");
    lines.push("外层解析（已解析 " + customDiagnosticCount(counts.outerJsonParsed) + "，未分类失败 " +
      customDiagnosticCount(counts.unclassifiedOuterFailures) + "）；动作未知 " +
      customDiagnosticCount(counts.unknownActions) + "；请求类型失败 " +
      customDiagnosticCount(counts.requestTypeFailures));
    lines.push("内层解析（已解析 " + customDiagnosticCount(counts.innerJsonParsed) + "，失败 " +
      customDiagnosticCount(counts.innerJsonFailures) + "）；前缀（尝试 " +
      customDiagnosticCount(counts.prefixAttempts) + "，恢复事件 " +
      customDiagnosticCount(counts.prefixRecoveredEvents) + "，空事件 " +
      customDiagnosticCount(counts.prefixEmptyEvents) + "）");
    lines.push("名称字段（无名称键 " + customDiagnosticCount(counts.eventsWithoutNameKey) + "，无效名称记录 " +
      customDiagnosticCount(counts.invalidNameRecords) + "，缺失名称记录 " +
      customDiagnosticCount(counts.missingNameRecords) + "）；忽略日志 " +
      customDiagnosticCount(counts.logFilesIgnored));

    var logFiles = Array.isArray(report.logFiles) ? report.logFiles : [];
    if (logFiles.length) {
      lines.push("\n文件证据（仅匿名文件标识）：");
      logFiles.forEach(function (file) {
        var sparse = [];
        var stages = file && file.stages && typeof file.stages === "object" ? file.stages : {};
        Object.keys(CUSTOM_DIAGNOSTIC_FILE_STAGE_LABELS).forEach(function (stage) {
          var count = customDiagnosticCount(stages[stage]);
          if (count) sparse.push(CUSTOM_DIAGNOSTIC_FILE_STAGE_LABELS[stage] + " " + count);
        });
        lines.push(customDiagnosticFilePointer(file && file.fileId, file && file.fileOmitted) + "：" +
          (sparse.length ? sparse.join("，") : "无阶段计数"));
      });
    }

    var issues = Array.isArray(report.issues) ? report.issues.slice(0, 64) : [];
    if (issues.length) {
      lines.push("\n问题证据：");
      issues.forEach(function (issue) {
        var count = customDiagnosticCount(issue && issue.count);
        var relatedRecords = customDiagnosticCount(issue && issue.relatedRecords);
        lines.push(customDiagnosticFilePointer(issue && issue.fileId, issue && issue.fileOmitted) + " · " +
          customDiagnosticLine(issue && issue.line) + " · " + customDiagnosticStageLabel(issue && issue.stage) +
          " · " + customDiagnosticReasonLabel(issue && issue.reasonCode) +
          "（计数 " + count + "，" + (relatedRecords ? "关联记录" + relatedRecords + "条" : "未建立关联/影响尚不确定") + "）");
      });
    }

    var omitted = report.omitted && typeof report.omitted === "object" ? report.omitted : null;
    if (omitted) {
      var omittedIssues = customDiagnosticCount(omitted.issues);
      var omittedRecordKeys = customDiagnosticCount(omitted.recordKeys);
      if (omittedIssues || omittedRecordKeys)
        lines.push("省略：问题 " + omittedIssues + "，记录键 " + omittedRecordKeys + "。");
    }

    var samples = Array.isArray(report.samples) ? report.samples : [];
    if (samples.length) {
      samples = samples.map(function (sample, index) { return { sample: sample, index: index }; }).sort(function (a, b) {
        var rank = function (entry) { return entry.sample && entry.sample.displaySource === "unindexed" ? 3 : entry.sample && entry.sample.displayHasName === false ? 0 :
          (entry.sample && entry.sample.displayHasName === true ? 2 : 1); };
        return rank(a) - rank(b) || a.index - b.index;
      }).slice(0, 32);
      lines.push("\n名称样本（优先显示未识别名称）：");
      samples.forEach(function (entry, index) {
        var sample = entry.sample || {};
        var sources = Array.isArray(sample.sources) ? sample.sources.slice(0, 2) : [];
        var hasName = sample.displayHasName === false ? "未识别名称" :
          (sample.displayHasName === true ? "已有名称" : "名称状态未知");
        var certainty = sample.certainty === "fact" ? "事实" :
          (sample.certainty === "unknown" ? "不确定" : "确定性未知");
        var pointer = sources.length ? sources.map(function (source) {
          return customDiagnosticFilePointer(source && source.fileId, source && source.fileOmitted) + " · " +
            customDiagnosticLine(source && source.line) + " · " + customDiagnosticStageLabel(source && source.stage) +
            " · " + customDiagnosticReasonLabel(source && source.reasonCode);
        }).join("；") : "无可用匿名指针";
        lines.push("样本 " + (sample.sampleId || ("#" + (index + 1))) + " · " + hasName +
          " · 来源：" + customDiagnosticSourceLabel(sample.displaySource) + " · 原因：" +
          customDiagnosticReasonLabel(sample.reasonCode) + " · 确定性：" + certainty + "\n指针：" + pointer);
      });
    }
    return lines;
  }

  function render() {
    var snapshot = snapshotState;
    var root = options.getRoot();
    if (snapshot && snapshot.local.mediaRoot !== root) snapshot = null;
    var busy = options.isBusy() || exporting;
    options.reasons.disabled = busy || !snapshot;
    options.exportButton.disabled = options.unifiedExport ? false : busy || !snapshot;
    var summary = options.summary;
    var detail = options.detail;
    if (!snapshot) {
      summary.textContent = messageState || "尚无扫描报告。重新扫描后可查看原因或导出诊断。";
      detail.textContent = "";
      detail.style.display = "none";
      return;
    }
    var report = snapshot.report, counts = report.stages || {};
    summary.textContent = (report.complete ? "扫描完成" : "扫描未完整完成") +
      "：发现 " + (counts.songDirectories || 0) + " 首，本次恢复歌名 " + (counts.recoveredNames || 0) +
      " 首，沿用已有名称 " + (counts.retainedNames || 0) + " 首，手动名称 " + (counts.manualNames || 0) +
      " 首，" + (counts.directoryNames || 0) + " 首仍使用目录名。" +
      (counts.unindexedSongs ? "另有 " + counts.unindexedSongs + " 个目录未入库。" : "") +
      (messageState ? " " + messageState : "");
    var lines = ["扫描时间：" + snapshot.startedAt, "扫描标识：" + snapshot.scanId,
      "曲目目录（仅本机显示）：" + snapshot.local.mediaRoot,
      "日志目录（仅本机显示）：" + snapshot.local.logRoot,
      "日志来源：" + (snapshot.local.logRootSource === "default" ? "默认位置" : "环境变量指定"),
      "日志：发现 " + (counts.logFilesDiscovered || 0) + "，支持 " + (counts.logFilesSupported || 0) +
        "，读完 " + (counts.logFilesRead || 0) + "，跳过 " + (counts.logFilesSkipped || 0) + "，读取失败 " + (counts.logFilesFailed || 0),
      "事件：相关 " + (counts.relevantEvents || 0) + "，解析成功 " + (counts.parsedEvents || 0) +
        "；有效名称记录 " + (counts.usableNameRecords || 0) + "，匹配目录 " + (counts.matchedNames || 0),
      "本次恢复、沿用已有、手动名称和目录名互不重复，仅统计此次入库曲目；分页不改变统计。"];
    (report.reasons || []).forEach(function (reason) {
      lines.push("\n[" + reason.code + "] " + reason.message + "（" + reason.count + "）" +
        (reason.certainty === "unknown" ? " · 暂不能确定" : ""));
      if (reason.suggestion) lines.push("建议：" + reason.suggestion);
    });
    if (!(report.reasons || []).length) lines.push("\n本次扫描未发现需要说明的异常；不代表历史数据完整。 ");
    if (report.schemaVersion >= 2) lines = lines.concat(customDiagnosticEvidenceLines(report, counts));
    lines.push("\n导出仅包含脱敏诊断，不包含上述真实路径、曲名、日志正文或私人数据，不会上传。 ");
    detail.textContent = lines.join("\n");
  }

  async function exportReport() {
    if (options.isBusy() || exporting) return;
    var snapshot = snapshotState;
    var root = options.getRoot();
    if (!snapshot || snapshot.local.mediaRoot !== root) return;
    exporting = true;
    options.refreshBusy();
    try {
      var report = await options.request("/api/custom-songs/diagnostics/export", {
        method: "POST", body: { mediaRoot: root, scanId: snapshot.scanId }
      });
      if (!report || report.scanId !== snapshot.scanId || snapshotState !== snapshot || options.isHidden()) {
        throw new Error("扫描报告已变化，请重新查看后导出。");
      }
      options.download(report, "linli-song-scan-" + report.scanId);
      messageState = "已发起脱敏 JSON 下载，请确认文件已保存。";
    } catch (error) {
      setSnapshot(null, error.message || "导出失败，请重新扫描后重试。");
    } finally {
      exporting = false;
      options.refreshBusy();
    }
  }

  options.reasons.onclick = function () {
    if (this.disabled) return;
    var show = options.detail.style.display === "none";
    options.detail.style.display = show ? "" : "none";
    this.textContent = show ? "收起原因" : "查看原因";
  };
  if (!options.unifiedExport) options.exportButton.onclick = function () { void exportReport(); };

  return Object.freeze({
    setSnapshot: setSnapshot,
    render: render,
    exportReport: exportReport,
    isExporting: function () { return exporting; },
    hasSnapshot: function () { return Boolean(snapshotState); }
  });
}

// One capture, explicit three-way choice, no persistent consent or player mutation.
createCustomSongDiagnostics.createDebugPackage = function (options) {
  var generation = 0, job = null, jobRoot = '', busy = false, ready = null, phase = 'closed', frontSnapshot=null, captureErrors=[];
  function safeFailure(error,stage){var status=Number.isInteger(error&&error.status)&&error.status>=100&&error.status<=599?error.status:0,code=error&&error.code;
    if(typeof code!=='string'||!(/^(E[A-Z0-9_]+|SQLITE_[A-Z0-9_]+|DEBUG_[A-Z0-9_]+)$/.test(code))||code.length>80||/TOKEN|SECRET|PASSWORD|COOKIE/.test(code))code=null;
    return{phase:stage,httpStatus:status,code:code,errno:error&&Number.isInteger(error.errno)&&Math.abs(error.errno)<10000000?error.errno:null,sqliteCode:error&&Number.isInteger(error.sqliteCode)&&error.sqliteCode>=0&&error.sqliteCode<=65535?error.sqliteCode:null,at:Date.now(),summary:'诊断操作未完成，原始异常未导出'};
  }
  function safeFront(input){
    var available=Boolean(input),aliases={},next=0;
    function alias(value){if(typeof value!=='string')return null;var key='$'+value;if(!Object.prototype.hasOwnProperty.call(aliases,key))aliases[key]='ref-'+(++next);return aliases[key];}
    function failures(items){return(Array.isArray(items)?items:[]).slice(-16).map(function(item){
      var record=safeFailure({status:item.httpStatus,code:item.code,errno:item.errno,sqliteCode:item.sqliteCode},/^[a-z][a-z-]{0,60}$/.test(item.phase||'')?item.phase:'unknown-phase');
      record.endpoint=/^(vision\/(status|start|claim|submit|heartbeat|control|undo|locate)|catalog\/(search|status|scan)|music\/preferences|mapping\/(import|export)|folder\/choose)$/.test(item.endpoint||'')?item.endpoint:'unknown';
      record.at=Number.isSafeInteger(item.at)?item.at:null;record.durationMs=Number.isFinite(item.durationMs)?Math.max(0,Math.min(item.durationMs,300000)):null;
      record.scope=item.scope==='current'?'current':item.scope==='previous'?'previous':'unknown';record.links={};
      ['root','jobId','nameKey','fileName'].forEach(function(key){record.links[key]=alias(item.links&&item.links[key]);});return record;
    });}
    input=input||{};var caps={};['visible','canvas','rvfc'].forEach(function(k){caps[k]=typeof(input.capabilities&&input.capabilities[k])==='boolean'?input.capabilities[k]:null;});
    return{available:available,capturedAt:Date.now(),capabilities:caps,currentFailures:failures(input.currentFailures).slice(-8),recentFailures:failures(input.recentFailures),historyScope:'current-renderer-only',build:input.build&&/^[a-f0-9]{64}$/.test(input.build.sha256)?{sha256:input.build.sha256,basis:'running-script-self-report'}:null};
  }
  function minimalFront(){var id='frontend-'+Date.now();return{format:'linli-song-debug',schemaVersion:3,manifest:{scanId:id,minimal:true,summaryOnly:true,complete:false,serviceObserved:false,scope:'frontend-only',context:{frontend:frontSnapshot},failures:captureErrors.slice(-16),limitations:['service-data-not-observed','no-game-or-browser-no-export']},diagnostics:{scanId:id,complete:false},material:{events:[],directories:[],mappings:[]},verification:{events:[],scope:'not-captured'}};}
  function render() {
    options.openButton.disabled = phase !== 'closed';
    options.fragmentButton.disabled = phase !== 'ready' || busy;
    options.basicButton.disabled = !['ready', 'failed'].includes(phase) || busy;
    options.basicButton.textContent = phase === 'failed' ? '导出最小诊断' : '仅导出诊断摘要';
    options.fragmentButton.hidden = phase === 'failed'||phase==='awaiting-choice';
    options.basicButton.hidden = phase==='awaiting-choice';
    options.cancelButton.disabled = false;
    if(options.waitActions){options.waitActions.hidden=phase!=='awaiting-choice';options.waitActions.style.display=phase==='awaiting-choice'?'flex':'none';}
    if(options.continueButton)options.continueButton.disabled=busy||phase!=='awaiting-choice';
    if(options.partialButton)options.partialButton.disabled=busy||phase!=='awaiting-choice';
    [options.filesButton,options.directoryButton,options.clearSourcesButton].forEach(function(button){if(button)button.disabled=busy||!['ready','failed'].includes(phase);});
  }
  function discard(old, root) {
    if (old && old.jobId) return options.request('/api/custom-songs/debug-package/cancel', {
      method: 'POST', body: { jobId: old.jobId, mediaRoot: root }
    }).catch(function () {});
  }
  function cancel() {
    generation++;
    var old = job, root = jobRoot; job = null; ready = null; jobRoot = ''; busy = false; phase = 'closed';
    options.panel.hidden = true;
    frontSnapshot=null;captureErrors=[];extraPaths=[];
    if(options.sourcesStatus)options.sourcesStatus.textContent='未选择补充资料';
    if(options.namesStatus)options.namesStatus.textContent='';
    void discard(old, root); render(); options.refreshBusy();
    if (options.onClose) options.onClose();
  }
  function valid(current, root) { return current === generation && !options.isHidden() && options.getRoot() === root; }
  async function open() {
    if (phase !== 'closed') return;
    var current = ++generation, root = options.getRoot();
    var frontendEvidence,officialRoot;
    captureErrors=[];try{frontendEvidence=options.getEvidence?options.getEvidence():undefined;officialRoot=options.getOfficialRoot?options.getOfficialRoot():undefined;frontSnapshot=safeFront(frontendEvidence);}catch(error){frontSnapshot=safeFront(null);captureErrors.push(safeFailure(error,'frontend-snapshot'));}
    busy = true; phase = 'preparing'; jobRoot = root; options.panel.hidden = false;
    options.status.textContent = '正在准备诊断快照，不修改曲目。完成后请选择导出方式；取消不会下载。';
    if (options.onOpen) options.onOpen(); render(); options.refreshBusy();
    try {
      var requestId='capture-'+Date.now()+'-'+current+'-'+Math.random().toString(36).slice(2);
      var started = await options.request('/api/custom-songs/debug-package/start', { method: 'POST', body: { mediaRoot: root, frontend:frontendEvidence, officialRoot:officialRoot,extraPaths:extraPaths.slice(),requestId:requestId } });
      if (!valid(current, root)) { void discard(started, root); if (current === generation) cancel(); return; }
      job = started;
      await pollCapture(current,root);
    } catch (error) {
      if (current === generation) {
        void discard(job, root); job = null; ready = null; phase = 'failed';
        captureErrors.push(safeFailure(error,'diagnostic-capture'));
        options.status.textContent = '服务诊断未取得。仍可导出本次前端最小现场及失败阶段；服务数据明确未观测，不依赖旧扫描。取消不会下载。';
      }
    } finally { if (current === generation) { busy = false; render(); options.refreshBusy(); } }
  }
  async function pollCapture(current,root){
    while (current === generation) {
        if (!valid(current, root)) { cancel(); return; }
        var status = await options.request('/api/custom-songs/debug-package/status', { method: 'POST', body: { mediaRoot: root, jobId: job.jobId } });
        if (!valid(current, root)) { if (current === generation) cancel(); return; }
        options.status.textContent = status.state === 'waiting' ? '等待曲库刷新或当前写入完成…（已等待 '+Math.floor((status.wait&&status.wait.observedWaitMs||0)/1000)+' 秒，可取消）' :
          status.state === 'verifying' ? '正在离线核对原材料与脱敏材料…' : '正在收集排障材料（已保留 ' + (status.retainedEvents || 0) + ' 条）…';
        if(status.state==='awaiting-choice'){
          phase='awaiting-choice';options.status.textContent='等待尚未完成。可继续等待，或查看已取得的部分排障信息；不会自动下载。';return;
        }
        if (status.state === 'failed' || status.state === 'cancelled') throw new Error(status.failureCode || 'capture-failed');
        if (status.state === 'ready') {
          ready = status; phase = 'ready';
          if(options.namesStatus){var count=status.nameRecovery&&status.nameRecovery.counts;
            options.namesStatus.textContent=count?'逐首名称诊断：原名可恢复 '+(count.recoverable||0)+'；历史显示名 '+(count.historical||0)+'；冲突 '+(count.ambiguous||0)+'；已检查资料无名 '+(count.unrecoverable||0)+'；检查未完成 '+(count.incomplete||0)+'；身份待确认 '+(count.excluded||0)+'。逐首证据及预演随详细诊断导出，不会实际改名。':'逐首名称诊断未取得（旧服务或采集失败）。';}
          options.status.textContent = status.minimal?'部分排障信息已准备，包含已冻结资料及明确的缺口。请选择导出范围；不能把未检查项当作无法恢复。':'摘要用于快速查看，详细模式另含结构化关联证据。可附带 '+status.rawRetainedEvents+' 条去凭据片段，另省略 '+status.rawOmittedEvents+' 条；扫描标识：'+status.scanId+'。';
          return;
        }
        await options.delay();
    }
  }
  async function waitingChoice(action){
    if(busy||phase!=='awaiting-choice'||!job)return;
    var current=generation,root=jobRoot;busy=true;render();options.refreshBusy();
    try{
      await options.request('/api/custom-songs/debug-package/'+action,{method:'POST',body:{mediaRoot:root,jobId:job.jobId}});
      if(!valid(current,root))return;
      phase='preparing';await pollCapture(current,root);
    }catch(error){
      if(current===generation){
        // Retain the known job and its frozen evidence if the choice response was lost.
        try{await pollCapture(current,root);}catch(again){
          phase='awaiting-choice';options.status.textContent='暂时无法确认服务状态，已保留本次诊断标识；可重试或取消。';
        }
      }
    }finally{if(current===generation){busy=false;render();options.refreshBusy();}}
  }
  async function exportChoice(include) {
    if (typeof include !== 'boolean' || busy || (phase !== 'ready' && !(phase === 'failed' && !include))) return;
    var current = generation, root = jobRoot;
    if (!valid(current, root)) { cancel(); return; }
    busy = true; render(); options.refreshBusy();
    try {
      if (phase === 'failed') {
        await options.downloadBasic(minimalFront(),'linli-song-frontend-'+Date.now());
      } else {
        var bundle = await options.request('/api/custom-songs/debug-package/download', { method: 'POST', body: {
          mediaRoot: root, jobId: job.jobId, scanId: ready.scanId, includeRaw: include,
          confirmSensitive: include, confirmationId: include ? ready.confirmationId : undefined
        } });
        if (!valid(current, root)) return;
        await options.download(bundle);
      }
      if (!valid(current, root)) return;
      options.status.textContent = '已发起下载，请检查浏览器下载结果；无法确认文件已保存。原快照保留至关闭、取消或到期，可再次选择导出。';
      if (options.onExport) options.onExport(include);
    } catch (error) {
      if (valid(current, root)) {
        captureErrors.push(safeFailure(error,'diagnostic-download'));
        options.status.textContent = job && ready ? '下载未确认完成，已保留同一份诊断快照。请再次选择摘要或详细诊断重试；不会自动下载。快照到期后需关闭并重新采集。' : '前端最小现场下载未完成，可再次选择重试。';
      }
    } finally { if (current === generation) { busy = false; render(); options.refreshBusy(); } }
  }
  options.openButton.onclick = function () { return open(); };
  if(options.continueButton)options.continueButton.onclick=function(){return waitingChoice('continue');};
  if(options.partialButton)options.partialButton.onclick=function(){return waitingChoice('partial');};
  var extraPaths=[];
  async function chooseSources(mode){
    if(busy||!['ready','failed'].includes(phase))return;
    var current=generation,root=jobRoot;busy=true;render();
    try{
      var picked=mode==='clear'?{cancelled:false,paths:[]}:await options.request('/api/custom-songs/debug-package/choose-sources',{method:'POST',body:{mediaRoot:root,mode:mode}});
      if(!valid(current,root)||picked.cancelled)return;
      var paths=mode==='clear'?[]:Array.from(new Set(extraPaths.concat(picked.paths||[])));
      if(paths.length>32){options.status.textContent='补充资料最多32项，请先清空后重新选择。';return;}
      cancel();extraPaths=paths;
      if(options.sourcesStatus)options.sourcesStatus.textContent='已选择 '+paths.length+' 项补充资料，仅本次只读使用。';
      return await open();
    }catch(error){if(current===generation)options.status.textContent='资料选择未完成，未添加任何来源；可重试或取消。';}
    finally{if(current===generation){busy=false;render();}}
  }
  if(options.filesButton)options.filesButton.onclick=function(){return chooseSources('files');};
  if(options.directoryButton)options.directoryButton.onclick=function(){return chooseSources('directory');};
  if(options.clearSourcesButton)options.clearSourcesButton.onclick=function(){return chooseSources('clear');};
  options.fragmentButton.onclick = function () { return exportChoice(true); };
  options.basicButton.onclick = function () { return exportChoice(false); };
  options.cancelButton.onclick = cancel;
  return Object.freeze({ open: open, exportChoice: exportChoice, cancel: cancel, render: render, isBusy: function () { return phase !== 'closed'; } });
};

// Scoped help for this manager; fixed sibling escapes the independently scrolling body.
createCustomSongDiagnostics.createHelp = function (modal) {
  var tooltip = document.createElement('div'), anchor = null, pinned = false;
  tooltip.id = 'lm-song-help-text'; tooltip.className = 'lm-song-tooltip'; tooltip.setAttribute('role', 'tooltip'); tooltip.hidden = true;
  document.body.appendChild(tooltip);
  function hide() { if (anchor) { anchor.setAttribute('aria-expanded', 'false'); anchor.removeAttribute('aria-describedby'); } anchor = null; pinned = false; tooltip.hidden = true; }
  function show(button) {
    if (anchor !== button) hide(); anchor = button; tooltip.textContent = button.getAttribute('data-song-help'); tooltip.hidden = false;
    button.setAttribute('aria-expanded', 'true'); button.setAttribute('aria-describedby', tooltip.id);
    var rect = button.getBoundingClientRect(), box = tooltip.getBoundingClientRect(), width = window.innerWidth || 800, height = window.innerHeight || 600;
    tooltip.style.left = Math.max(8, Math.min(rect.left, width - box.width - 8)) + 'px';
    tooltip.style.top = Math.max(8, Math.min(rect.bottom + 8, height - box.height - 8)) + 'px';
  }
  function refresh() { modal.querySelectorAll('[data-song-help]').forEach(function (button) {
    if (button.__songHelpBound) return; button.__songHelpBound = true;
    button.setAttribute('aria-expanded', 'false');
    button.onmouseenter = function () { if (!pinned) show(button); };
    button.onmouseleave = function () { if (!pinned && document.activeElement !== button) hide(); };
    button.onfocus = function () { show(button); };
    button.onblur = hide;
    button.onclick = function (event) { if (event && event.stopPropagation) event.stopPropagation(); if (pinned && anchor === button) hide(); else { show(button); pinned = true; } };
    button.onkeydown = function (event) { if (event.key === 'Escape' && anchor) { event.preventDefault(); event.stopPropagation(); hide(); } };
  }); }
  refresh();
  document.addEventListener('click', function (event) { if (anchor && event.target !== anchor) hide(); });
  modal.querySelector('.lm-song-manager-body').addEventListener('scroll', hide);
  window.addEventListener('resize', hide);
  return { hide: hide, refresh: refresh };
};
