// Independent page-lifetime worker. The manager panel is a view, not the owner of the task.
function createVisionTaskController(options) {
  var clientId = 'vision-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  var data = null, selected = null, cursor = 0, root = options.getRoot(), autoEnabled = false, pendingAuto = false;
  var timer = null, heartbeat = null, running = false, lease = null, aborter = null, epoch = 0, disposed = false;
  var lastSignal = '', environmentHold = false, panelOpen = false, requestBusy = false, message = '', preparedRoot = null, decodeFlight = null, viewSequence = 0, pendingInput = null;
  var now = options.now || Date.now;
  var evidenceStartedAt=now(), errorScope=0, requestSequence=0, latestRequests={}, currentFailures={}, recentFailures=[];
  function clearScope(){errorScope++;currentFailures={};latestRequests={};message='';}
  function failureEvidence(item){var copy=Object.assign({},item);copy.scope=item.scopeEpoch===errorScope&&item.applicable?'current':'previous';delete copy.scopeEpoch;delete copy.applicable;return copy;}
  function failureText(item){return item.category==='busy'?'曲库或识别任务暂忙，稍后重试。':item.category==='access-denied'?'识别请求未获授权，请重新连接本地服务。':item.category==='invalid-request'?'识别请求未完成，请检查当前任务后重试。':'识别任务暂不可用，请确认本地服务后重试。';}
  async function observed(endpoint,operation,body,run){
    var scope=errorScope, sequence=++requestSequence, key=endpoint+':'+operation, started=now();
    var requestedRoot=body&&body.mediaRoot||root, requestedJob=body&&body.jobId||selected;
    var applies=function(){return scope===errorScope&&requestedRoot===root&&(!requestedJob||!selected||requestedJob===selected);};
    if(applies())latestRequests[key]=sequence;
    try {var result=await run();if(applies()&&latestRequests[key]===sequence){
      if(currentFailures[key])currentFailures[key].recoveredAt=now();delete currentFailures[key];
    }return result;}catch(error){
      var status=Number.isInteger(error&&error.status)?error.status:Number.isInteger(error&&error.statusCode)?error.statusCode:0;
      if(status<100||status>599)status=0;
      var item={endpoint:endpoint,operation:operation,httpStatus:status,category:status===409?'busy':status===401||status===403?'access-denied':status===429?'rate-limited':status>=500?'service-error':status>=400?'invalid-request':'unknown-no-status',at:now(),durationMs:Math.max(0,Math.min(300000,now()-started)),scopeEpoch:scope,applicable:applies()};
      if(options.failureInfo)Object.assign(item,options.failureInfo(error,'vision-request',{root:requestedRoot,jobId:requestedJob,nameKey:body&&body.nameKey,fileName:body&&body.fileName}));
      recentFailures.push(item);if(recentFailures.length>16)recentFailures.shift();
      if(applies()&&latestRequests[key]===sequence){currentFailures[key]=item;var keys=Object.keys(currentFailures);if(keys.length>8)delete currentFailures[keys[0]];}
      throw error;
    }
  }
  function request(action, body, scopeBody) { return observed('vision/'+action,action==='control'?String(body&&body.action||'unknown'):action,scopeBody||body,function(){return options.request('/api/custom-songs/vision/' + action, { method: 'POST', body: body || {} });}); }
  function render() { var failures=Object.values(currentFailures), failure=failures[failures.length-1];options.render({ data: data, job: data && data.job, message: failure?failureText(failure):message, busy: requestBusy, decoding: running }); }
  function schedule(delay) {
    if (disposed || timer !== null) return;
    timer = options.setTimeout(function () { timer = null; void tick(); }, delay === undefined ? 1500 : delay);
  }
  function stopDecode() { epoch++; if (aborter) aborter.abort(); }
  async function release(value) { if (value) try { await request('control', { action: 'release', token: value.token, clientId: clientId },{mediaRoot:value.root,jobId:value.jobId}); } catch (ignored) {} }
  function environment() { try { return options.environment(); } catch (ignored) { return { visible: false, canvas: false, rvfc: false }; } }
  function evidenceEnvironment(){try{return options.environment();}catch(ignored){return{visible:null,canvas:null,rvfc:null};}}
  function capable(value) { return value.visible === true && value.canvas === true && value.rvfc === true; }
  async function refresh() {
    var sequence=++viewSequence, requestedRoot=root, requestedJob=selected, requestedCursor=cursor;
    var current=function(){return !disposed&&sequence===viewSequence&&root===requestedRoot&&options.getRoot()===requestedRoot&&selected===requestedJob&&cursor===requestedCursor;};
    try {
      var next=await request('status', { mediaRoot: requestedRoot || undefined, jobId: requestedJob || undefined, cursor: requestedCursor });
      if(current()){data=next;if(!next.job||['completed','stopped','undone'].indexOf(next.job.status)>=0){message='';environmentHold=false;}render();}return data;
    } catch(error){if(current())throw error;return data;}
  }
  async function handleEnvironment() {
    var job = lease ? { id: lease.jobId, mediaRoot: lease.root, status: 'running' } : data && data.job, env = environment();
    if (data && data.decoder && data.decoder.clientId !== clientId) return capable(env) && !environmentHold;
    if (job && ['queued','running'].indexOf(job.status) >= 0 && !capable(env)) {
      stopDecode();
      await request('control', { mediaRoot: job.mediaRoot, jobId: job.id, action: 'environment', clientId: clientId, reason: env.visible ? 'unsupported' : 'hidden' });
      message = env.visible ? '当前前端缺少可靠取帧能力（Canvas / RVFC），任务已暂停；可手工校正。' : '前端不可见，等待恢复可见后继续。';
      await refresh();
    }
    return capable(env) && !environmentHold;
  }
  async function tick() {
    if (disposed || requestBusy || running) return;
    requestBusy = true;
    try {
      if (options.getRoot() !== root) { await changeRoot(options.getRoot()); return; }
      if (options.isHumanBusy()) { schedule(); return; }
      if (!capable(environment())) { await refresh(); await handleEnvironment(); return; }
      if (pendingAuto && autoEnabled) {
        pendingAuto = false;
        if (options.prepareAuto && preparedRoot !== root) { var prepared=await observed('catalog/search','prepare',null,options.prepareAuto); pendingInput=prepared&&prepared.refresh||null; preparedRoot = root; }
        if (!autoEnabled) return;
        if(pendingInput&&(pendingInput.refreshing||pendingInput.error)&&options.inputStatus){
          var inputRoot=pendingInput.mediaRoot||root;pendingInput=await observed('catalog/status','refresh',null,function(){return options.inputStatus(inputRoot);});
          if(!autoEnabled)return;
          if(pendingInput.refreshing){pendingAuto=true;message='等待曲库检查完成后处理新索引。';schedule(1000);return;}
          if(pendingInput.error){message='曲库检查未完成，请重新扫描后再试。';pendingAuto=true;return;}
          pendingInput=null;message='';
        }
        await request('start', { mediaRoot: root || undefined, mode: 'auto', retryUnknown: false });
      }
      await refresh();
      if (!await handleEnvironment()) return;
      if (data && data.job && data.job.status === 'waiting-environment' &&
        ((data.job.mode === 'auto' && data.job.reason === 'decoder-disconnected' && autoEnabled) ||
          ['hidden','unsupported'].indexOf(data.job.reason) >= 0 && (!data.job.inventory.ownerClientId || data.job.inventory.ownerClientId === clientId))) {
        await request('control', { mediaRoot: data.job.mediaRoot, jobId: data.job.id, action: 'resume', clientId: clientId }); await refresh();
      }
      var claimed = await request('claim', { mediaRoot: root || undefined, clientId: clientId, capabilities: environment() });
      if(!environmentHold)message='';
      if (claimed.state === 'claimed') { requestBusy = false; decodeFlight = decode(claimed); await decodeFlight; decodeFlight = null; return; }
      if (claimed.state === 'manual-resume-required') message = '上次手动任务需明确继续或接管，不会因自动开关自行重启。';
      var job = data && data.job;
      if (panelOpen || job && ['queued','running'].indexOf(job.status) >= 0 || claimed.state === 'retry' || claimed.state === 'busy') schedule();
    } catch (error) {
      message = Object.keys(currentFailures).length?'':'本次前端处理未完成，请重试。';
      if (autoEnabled && error && error.status === 409) { pendingAuto = true; schedule(2000); }
      else if(panelOpen)schedule(3000);
      render();
    }
    finally { requestBusy = false; render(); }
  }
  async function decode(claimed) {
    var current = ++epoch, reports = []; lease = claimed.lease; running = true; aborter = new AbortController();
    var ownedLease = lease;
    function stillCurrent() { return current === epoch && !disposed && capable(environment()) && now() < ownedLease.expiresAt && (!autoEnabled ? ownedLease.mode !== 'auto' : true); }
    heartbeat = options.setInterval(function () {
      void request('heartbeat', { token: ownedLease.token, clientId: clientId, generation: ownedLease.generation },{mediaRoot:ownedLease.root,jobId:ownedLease.jobId}).then(function (answer) {
        if (!answer.accepted) stopDecode(); else ownedLease.expiresAt = answer.expiresAt;
      }).catch(stopDecode);
    }, 5000);
    try {
      for (var i = 0; i < ownedLease.targets.length; i++) {
        if (!stillCurrent() || options.isHumanBusy()) throw new Error('interrupted');
        var target = ownedLease.targets[i], frames = [], errorCode = null;
        if (!target.cached) {
          try {
            await options.capture({ url: target.url, signal: aborter.signal, thumbnail: false, onFrame: function (frame) {
              if (!stillCurrent() || options.isHumanBusy()) throw new Error('interrupted');
              frames.push({ time: frame.time, target: frame.target, verified: frame.verified === true,
                feature: options.features(frame.imageData, frame.sourceWidth, frame.sourceHeight) });
              return false;
            } });
          } catch (error) {
            if (!stillCurrent() || aborter.signal.aborted || error.message === 'interrupted') throw error;
            errorCode = error.name === 'MediaError' ? 'media-error' : error.name === 'TimeoutError' ? 'timeout' : 'environment';
          }
        }
        reports.push({ fileName: target.fileName, fileRevision: target.fileRevision, useCache: target.cached === true,
          algorithm: claimed.algorithm, policy: claimed.policy, frames: frames, errorCode: errorCode });
        await options.yieldTurn();
      }
      if (!stillCurrent() || options.isHumanBusy()) throw new Error('interrupted');
      var result = await request('submit', { token: ownedLease.token, clientId: clientId, generation: ownedLease.generation, reports: reports });
      if (result.waiting) { environmentHold = true; message = '当前取帧不可靠，已暂停。恢复可用环境或点击继续后再试。'; }
      if (result.saved && options.onSaved && current === epoch) options.onSaved(result.saved, result.applied || []);
    } catch (error) { message = '本组未继续提交；已保存的结果保留，待环境或人工操作结束后重试。'; }
    finally {
      options.clearInterval(heartbeat); heartbeat = null; await release(ownedLease);
      lease = null; aborter = null; running = false;
      await refresh().catch(function () {}); render();
      if (!disposed && !environmentHold) schedule();
    }
  }
  async function startManual() {
    if (requestBusy || options.isHumanBusy()) return;
    clearScope();
    requestBusy = true; environmentHold = false; stopDecode(); render();
    try {
      var result = await request('start', { mediaRoot: root || undefined, mode: 'manual', retryUnknown: true });
      selected = result.job && result.job.id; cursor = 0; message = '';
      await refresh(); schedule(0);
    } catch (error) { message = ''; }
    finally { requestBusy = false; render(); }
  }
  async function control(action) {
    var job = data && data.job; if (!job) return;
    stopDecode(); environmentHold = false;
    try { await request(action === 'undo' ? 'undo' : 'control', { mediaRoot: job.mediaRoot, jobId: job.id, action: action, clientId: clientId }); message='';await refresh(); }
    catch (error) { message = '';render(); }
    if (action === 'resume' || action === 'stop' || action === 'undo') schedule(0);
  }
  var stoppingCurrent=false;
  async function stopCurrent() {
    if(stoppingCurrent)return;stoppingCurrent=true;
    var requestedRoot=options.getRoot();
    try {
      var latest=await request('status',{mediaRoot:requestedRoot||undefined});
      if(disposed||options.getRoot()!==requestedRoot)return;
      var current=latest&&latest.job;
      if(!current||['queued','running','waiting-environment','paused','interrupted'].indexOf(current.status)<0)return;
      data=latest;selected=current.id;cursor=0;pendingAuto=false;
      await control('stop');
    }catch(error){message='';render();}
    finally{stoppingCurrent=false;}
  }
  async function changeRoot(next) {
    stopDecode();viewSequence++;clearScope();
    var job = data && data.job;
    root = next; selected = null; data = null; cursor = 0; lastSignal = ''; preparedRoot = null; pendingInput=null; environmentHold = false; pendingAuto = autoEnabled; render();
    if (job && ['queued','running'].indexOf(job.status) >= 0) await request('control', { mediaRoot: job.mediaRoot, jobId: job.id, action: 'pause', reason: 'root-changed' }).catch(function () {});
    if(root===next)schedule(0);
  }
  function sync(enabled, signal) {
    var prior = autoEnabled; autoEnabled = enabled === true;
    if (prior && !autoEnabled && lease && lease.mode === 'auto') stopDecode();
    if (!autoEnabled) pendingAuto = false;
    if (autoEnabled && (!prior || signal !== lastSignal)) { if (!prior) preparedRoot = null; pendingAuto = true; lastSignal = signal; schedule(0); }
    if (options.getRoot() !== root) { void changeRoot(options.getRoot()); }
  }
  async function environmentChanged() {
    if (!capable(environment())) { stopDecode(); await refresh().catch(function () {}); await handleEnvironment().catch(function () {}); return; }
    environmentHold = false; message='';await refresh().catch(function () {});
    var job = data && data.job;
    if (job && job.status === 'waiting-environment' && (job.mode !== 'auto' || autoEnabled) &&
      (!job.inventory.ownerClientId || job.inventory.ownerClientId === clientId)) await control('resume');
    schedule(0);
  }
  return { startManual: startManual, control: control, stopCurrent: stopCurrent, sync: sync, environmentChanged: environmentChanged,
    open: function () { panelOpen = true; schedule(0); }, closePanel: function () { panelOpen = false; },
    select: function (id) { clearScope();selected = id; cursor = 0; void refresh().catch(function(){render();}); }, next: function () { cursor = data && data.job && data.job.nextCursor || 0; void refresh().catch(function(){render();}); },
    diagnostic: function(){return {startedAt:evidenceStartedAt,historyScope:'current-renderer-memory-only',currentFailures:Object.values(currentFailures).map(failureEvidence),recentFailures:recentFailures.map(failureEvidence),capabilities:evidenceEnvironment(),autoEnabled:autoEnabled,environmentHold:environmentHold,decoding:running};},
    status: function () { return data; }, isDecoding: function () { return running; },
    humanActivity: function () { stopDecode(); return decodeFlight || Promise.resolve(); },
    clientId: clientId,
    dispose: function () {
      disposed = true;
      var job = data && data.job;
      if (job) void request('control', { action: 'disconnect', mediaRoot: job.mediaRoot, jobId: job.id,
        token: lease && lease.token, generation: lease ? lease.generation : job.generation, clientId: clientId }).catch(function () {});
      stopDecode(); if (timer !== null) options.clearTimeout(timer);
    },
    refresh: refresh, tick: tick
  };
}
