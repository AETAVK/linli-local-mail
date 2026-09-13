// Names are persisted separately from video-period mappings.

// Shared folded limits in both configuration entry points. No rerender on toggle.
function songRecognitionLimitHtml(prefix,includeSamples) {
  var help='注册后有14天免费试用，不是永久免费。2026-09-13核对的中国站试用限制：每天5000次识别请求、QPS 2、最多1个AVR项目；以个人控制台为准。每个片段算一次请求，每首最多5段。本地上限不是服务商剩余额度，修改它不能增加服务商配额。';
  return '<div class="lm-recognition-limits"><div class="lm-recognition-limit-heading">'+
    '<button class="lm-recognition-limit-toggle" type="button" data-'+prefix+'-limits-toggle aria-expanded="false" aria-controls="lm-'+prefix+'-limits-body"><span data-limit-arrow>▸</span> 请求额度</button>'+
    '<span class="lm-recognition-help"><button type="button" class="lm-song-help" data-trial-help aria-label="免费试用说明" aria-describedby="lm-'+prefix+'-trial-help">?</button>'+
    '<span id="lm-'+prefix+'-trial-help" class="lm-recognition-trial-tooltip" role="tooltip">'+help+'</span></span></div>'+
    '<div id="lm-'+prefix+'-limits-body" data-'+prefix+'-limits-body hidden><div class="lm-name-budgets">'+
    '<label>单次请求上限<input type="number" class="lm-input" min="1" max="5000" value="5000" data-'+prefix+'-budget aria-label="单次请求上限"></label>'+
    '<label>每日请求上限<input type="number" class="lm-input" min="1" max="5000" value="5000" data-'+prefix+'-daily aria-label="每日请求上限"></label>'+
    (includeSamples?'<label>每首最多片段<select class="lm-select" data-name-max aria-label="每首最多片段"><option>3</option><option>4</option><option selected>5</option></select></label>':'')+
    '</div><p class="lm-modal-status">达到上限后暂停，保留已识别结果；继续前可调整额度。</p></div></div>';
}
var songRecognitionHelpBindings = {};
function bindSongRecognitionLimits(scope,prefix) {
  var toggle=scope.querySelector('[data-'+prefix+'-limits-toggle]'),panel=scope.querySelector('[data-'+prefix+'-limits-body]');
  toggle.onclick=function(){panel.hidden=!panel.hidden;toggle.setAttribute('aria-expanded',String(!panel.hidden));toggle.querySelector('[data-limit-arrow]').textContent=panel.hidden?'▸':'▾';};
  if(songRecognitionHelpBindings[prefix])songRecognitionHelpBindings[prefix].dispose();
  var button=scope.querySelector('[data-trial-help]'),tip=scope.querySelector('[role="tooltip"]'),pinned=false;
  document.body.appendChild(tip);tip.style.position='fixed';
  function hide(){pinned=false;tip.setAttribute('data-visible','false');button.setAttribute('aria-expanded','false');}
  function show(){
    tip.setAttribute('data-visible','true');button.setAttribute('aria-expanded','true');
    var anchor=button.getBoundingClientRect(),box=tip.getBoundingClientRect(),width=window.innerWidth||800,height=window.innerHeight||600;
    tip.style.left=Math.max(8,Math.min(anchor.left,width-box.width-8))+'px';
    var below=anchor.bottom+8;
    tip.style.top=Math.max(8,Math.min(below+box.height<=height-8?below:anchor.top-box.height-8,height-box.height-8))+'px';
  }
  button.onmouseenter=show;button.onfocus=show;button.onblur=hide;
  button.onmouseleave=function(){if(!pinned&&document.activeElement!==button)hide();};
  button.onclick=function(event){if(event&&event.stopPropagation)event.stopPropagation();if(pinned)hide();else{show();pinned=true;}};
  button.onkeydown=function(event){if(event.key==='Escape'){event.preventDefault();hide();}};
  function outside(event){if(event.target!==button&&!tip.contains(event.target))hide();}
  document.addEventListener('click',outside);document.addEventListener('scroll',hide,true);
  window.addEventListener('resize',hide);window.addEventListener('hashchange',hide);window.addEventListener('popstate',hide);
  hide();
  var binding={hide:hide,dispose:function(){hide();tip.remove();document.removeEventListener('click',outside);document.removeEventListener('scroll',hide,true);window.removeEventListener('resize',hide);window.removeEventListener('hashchange',hide);window.removeEventListener('popstate',hide);}};
  songRecognitionHelpBindings[prefix]=binding;return binding;
}


function mountSongRecognitionSettings(container,localSection) {
  var id='local-mail-song-recognition-settings',section=document.getElementById(id);
  if(!section){
    section=document.createElement('section');section.id=id;section.className='tp-settings-item lm-recognition-settings';
    section.innerHTML='<div class="lm-title-row"><div class="lm-title">听音识曲</div><button class="lm-button lm-button-small" data-recognition-guide>注册与配置教程</button></div>'+
      '<p class="lm-modal-status">使用自己的 ACRCloud 中国大陆翻奏识别项目。密钥加密保存在此电脑，不会回显。</p>'+
      '<div class="lm-name-credentials"><label>Access Key<input class="lm-input" type="password" autocomplete="off" data-recognition-key aria-label="识曲 Access Key"></label><label>Secret Key<input class="lm-input" type="password" autocomplete="off" data-recognition-secret aria-label="识曲 Secret Key"></label></div>'+
      '<p class="lm-modal-status lm-recognition-upload-note">开始识别时发送匿名音频片段至 ACRCloud，可能消耗额度或产生费用。</p>'+
      songRecognitionLimitHtml('recognition',false)+
      '<div class="lm-actions"><button class="lm-button lm-button-primary" data-recognition-save>保存识曲设置</button><button class="lm-button" data-recognition-clear>清除识曲密钥</button></div><p class="lm-modal-status" role="status" data-recognition-status>读取中</p>';
    bindSongRecognitionLimits(section,'recognition');
    var q=function(s){return section.querySelector(s);};
    var request=function(action,body){return callApi('/api/custom-songs/names/'+action,{method:'POST',body:body||{}});};
    var render=function(c){q('[data-recognition-budget]').value=c.requestBudget;q('[data-recognition-daily]').value=c.dailyBudget;q('[data-recognition-status]').textContent=c.configured?'已配置识曲服务':'尚未配置识曲服务';};
    var busy=false;
    async function saveSettings(clear){
      if(busy)return;if(clear&&!window.confirm('清除识曲密钥并停止自动识别？已有歌名和候选保留。'))return;
      busy=true;section.querySelectorAll('button').forEach(function(b){b.disabled=true;});
      try{
        var input=clear?{clearCredentials:true}:{requestBudget:Number(q('[data-recognition-budget]').value),dailyBudget:Number(q('[data-recognition-daily]').value)};
        if(!clear&&(q('[data-recognition-key]').value||q('[data-recognition-secret]').value)){input.accessKey=q('[data-recognition-key]').value;input.accessSecret=q('[data-recognition-secret]').value;}
        var result=await request('config',input);q('[data-recognition-key]').value='';q('[data-recognition-secret]').value='';render(result);musicNotice(clear?'识曲密钥已清除':'识曲设置已保存','success');
      }catch(e){q('[data-recognition-status]').textContent=e.message||'识曲设置保存失败';}
      finally{busy=false;section.querySelectorAll('button').forEach(function(b){b.disabled=false;});}
    }
    q('[data-recognition-save]').onclick=function(){return saveSettings(false);};
    q('[data-recognition-clear]').onclick=function(){return saveSettings(true);};
    q('[data-recognition-guide]').onclick=function(){window.open(API_BASE+'/song-recognition-guide','_blank','noopener,noreferrer');};
    request('status').then(function(data){render(data.config);}).catch(function(e){q('[data-recognition-status]').textContent='无法读取识曲设置：'+e.message;});
  }
  if(section.parentElement!==container||nextLocalElement(section)!==localSection)container.insertBefore(section,localSection);
  return section;
}

function installSongNameRecognition(modal) {
  var home=modal.querySelector('[data-song-home]'),body=modal.querySelector('.lm-song-manager-body');
  var entry=document.createElement('section');entry.className='lm-song-home-section lm-song-recognition-section';entry.setAttribute('data-name-home','');
  entry.innerHTML='<div class="lm-song-auto-row"><div><div class="lm-song-inline"><h3>曲名自动识别</h3></div><p class="lm-modal-status">自动识别新增歌曲的曲名。</p></div><div class="lm-song-auto-control"><span class="lm-modal-status" data-name-auto-state>读取中</span><label class="lm-music-switch"><input type="checkbox" role="switch" data-name-auto aria-label="曲名自动识别" disabled></label></div></div>'+
    '<div class="lm-song-organize-row"><div class="lm-song-run-context"><p class="lm-modal-status" data-name-home-status role="status"></p></div><div><button class="lm-button" data-name-home-start disabled>立即识别</button></div></div><div class="lm-name-job" data-name-home-job role="status"></div>'+
    '<p class="lm-modal-status" data-name-action-feedback role="status" hidden></p><details class="lm-name-settings-fold" data-name-settings-fold><summary>识别设置</summary></details>';
  home.insertBefore(entry,home.querySelector('[data-song-home-auto]').closest('section'));
  var management=document.createElement('section');management.className='lm-song-home-section lm-song-management-row';management.setAttribute('data-name-management','');
  management.innerHTML='<div class="lm-song-auto-row"><div><h3>歌曲管理</h3><p class="lm-modal-status" data-name-review-summary>查看歌曲、候选与已确认名称</p></div><button class="lm-button" data-name-open>管理歌曲</button></div><div class="lm-name-review-shortcuts" aria-label="快速查看识别结果">'+
    '<button type="button" data-name-review-shortcut="suggestions">待确认建议</button><button type="button" data-name-review-shortcut="low">低可信建议</button><button type="button" data-name-review-shortcut="unresolved">未识别 / 无结果</button><button type="button" data-name-review-shortcut="failed">识别失败</button></div>';
  home.insertBefore(management,home.querySelector('.lm-song-mapping-row'));
  var pane=document.createElement('div');pane.className='lm-name-pane lm-recognition-settings';pane.hidden=true;body.appendChild(pane);
  pane.innerHTML='<p class="lm-modal-status" data-name-pane-feedback role="status" hidden></p><div class="lm-name-job" data-name-job role="status"></div><div data-name-songs><div class="lm-name-review-filter"><label>查看结果 <select class="lm-select" data-name-review aria-label="识别结果筛选"><option value="all">全部结果</option><option value="suggestions">待确认建议</option><option value="low">低可信建议</option><option value="unresolved">未识别 / 无结果</option><option value="failed">识别失败</option></select></label><span class="lm-modal-status">暂用不等于确认；批量操作仅影响所选歌曲。</span></div><div class="lm-name-filters">'+
    '<input class="lm-input" data-name-search aria-label="搜索歌曲名称" placeholder="搜索歌名或候选名称">'+
    '<select class="lm-select" data-name-source aria-label="名称状态筛选"><option value="all">全部状态</option><option value="manual">已手动确认</option><option value="native">原生恢复</option><option value="legacy">已有名称</option><option value="auto">未确认建议</option><option value="none">未识别</option></select>'+
    '<select class="lm-select" data-name-level aria-label="可信度筛选"><option value="all">全部可信度</option><option value="high">高可信度</option><option value="medium">中可信度</option><option value="low">低可信度</option></select><button class="lm-button" data-name-start>立即识别</button></div>'+
    '<div class="lm-name-batch"><label><input type="checkbox" data-name-all aria-label="全选本页"> 全选本页</label><span data-name-count></span><button class="lm-button lm-button-small" data-name-confirm>确认当前名</button><button class="lm-button lm-button-small" data-name-provisional>暂用最强建议</button><button class="lm-button lm-button-small" data-name-retry>重新识别</button></div>'+
    '<div class="lm-name-columns"><span>歌曲名称</span><span>名称状态</span><span>可信度 <button class="lm-song-help" aria-label="可信度说明" data-song-help="可信度取决于服务商曲库和识别服务，实际准确度还受定制歌曲对原曲的还原程度影响。">?</button></span></div>'+
    '<div data-name-rows></div><div class="lm-name-pager"><button class="lm-button" data-name-prev>上一页</button><button class="lm-button" data-name-next>下一页</button></div></div>'+
    '<div class="lm-recognition-settings" data-name-settings hidden><p class="lm-modal-status">自动模式仅处理没有识别记录的新歌曲；失败记录不会自动重跑。</p>'+
    '<section class="lm-song-home-section"><h4>自动暂用建议</h4><p class="lm-modal-status">仅影响后续结果，不更改已保存歌名，也不重新识别。</p><div data-name-levels></div></section>'+
    '<section class="lm-song-home-section"><h4>识曲服务 · ACRCloud 中国大陆</h4><p class="lm-modal-status" data-name-key-state></p><p class="lm-modal-status">使用自己的翻奏识别项目。服务商可能计费；仅发送匿名短音频，不发送歌名、路径或完整视频。</p>'+
    '<div class="lm-name-credentials"><label>Access Key<input class="lm-input" type="password" autocomplete="off" data-name-key aria-label="Access Key"></label><label>Secret Key<input class="lm-input" type="password" autocomplete="off" data-name-secret aria-label="Secret Key"></label></div>'+
    songRecognitionLimitHtml('name',true)+
    '<button class="lm-button" data-name-config-save>保存服务设置</button> <button class="lm-button" data-name-config-clear>清除密钥</button><p class="lm-modal-status">按需增加片段，最多5段。本地请求计数不代表服务商账单。</p></section></div><div data-name-detail hidden></div>';
  var settings=pane.querySelector('[data-name-settings]'),fold=entry.querySelector('[data-name-settings-fold]');
  fold.open=false;settings.hidden=false;fold.appendChild(settings);
  var limitHelp=bindSongRecognitionLimits(settings,'name');
  fold.ontoggle=function(){if(!fold.open)limitHelp.hide();};
  var state={data:null,page:0,selected:new Set(),detail:null,tab:'songs',busy:false,externalBusy:false,epoch:0,timer:null,searchTimer:null,undoId:null,dirty:false};
  var startSequence=0,actionRoot=null;
  var footer=modal.querySelector('.lm-song-manager-footer');
  var save=document.createElement('button');save.className='lm-button lm-button-primary';save.textContent='保存名称';save.hidden=true;save.setAttribute('data-name-save','');footer.querySelector('.lm-modal-actions').appendChild(save);
  var undo=document.createElement('button');undo.className='lm-button';undo.textContent='撤销名称修改';undo.hidden=true;undo.setAttribute('data-name-undo','');footer.insertBefore(undo,footer.firstChild);
  var q=function(s){return pane.querySelector(s)||entry.querySelector(s)||management.querySelector(s);},root=function(){return visionTaskRoot();};
  var api=function(action,input){return callApi('/api/custom-songs/names/'+action,{method:'POST',body:action==='config'?(input||{}):Object.assign({mediaRoot:root()},input||{})});};
  var labels={manual:'已手动确认',native:'原生恢复',legacy:'已有名称',auto:'未确认建议',none:'未识别'},levels={high:'高',medium:'中',low:'低'};
  function message(text,error){musicNotice(text,error?'error':'success');}
  function actionFeedback(text,kind){actionRoot=root();['[data-name-action-feedback]','[data-name-pane-feedback]'].forEach(function(selector){var node=q(selector);node.textContent=text;node.hidden=!text;node.setAttribute('data-kind',kind||'info');});}
  function dirtyLeave(){return!state.dirty||window.confirm('放弃尚未保存的修改？已保存名称和候选不会改变。');}
  function active(){return!modal.hidden&&['names','home'].indexOf(modal.__managerView)>=0;}
  function later(){clearTimeout(state.timer);if(active()&&state.data&&state.data.job&&['queued','running'].indexOf(state.data.job.status)>=0)state.timer=setTimeout(function(){void load(false);},1200);}
  async function load(reset){
    if(reset){state.page=0;state.selected.clear();}
    var epoch=++state.epoch,currentRoot=root();
    try{
      var data=await api('list',{cursor:state.page*50,pageSize:50,search:q('[data-name-search]').value,status:q('[data-name-source]').value,confidence:q('[data-name-level]').value,review:q('[data-name-review]').value||'all'});
      if(epoch!==state.epoch||root()!==currentRoot)return;
      if(!data||!Array.isArray(data.list)||!data.config)throw new Error('识曲列表响应不完整，请检查本地服务版本');
      state.data=data;var visible=new Set(data.list.map(function(s){return s.nameKey;}));
      state.selected.forEach(function(key){if(!visible.has(key))state.selected.delete(key);});
      if(state.page&&data.total<=state.page*50){state.page=0;return load(false);}
      render();later();
    }catch(error){if(epoch===state.epoch){q('[data-name-home-status]').textContent='曲名识别状态读取失败，请重新打开后重试。';message(error.message||'读取歌曲名失败',true);}}
  }
  function renderJob(){
    var boxes=[q('[data-name-job]'),q('[data-name-home-job]')];boxes.forEach(function(box){box.textContent='';});var job=state.data&&state.data.job;if(!job)return;
    var human={queued:'准备中',running:'正在识别',paused:'已暂停',interrupted:'上次识别中断',complete:'本次处理完成',stopped:'已停止'};
    var reasons={budget:'达到本次请求上限','daily-budget':'达到每日请求上限',credentials:'请检查密钥',quota:'额度不足（3003）：请检查试用期限或套餐后手动继续','rate-limit':'服务商限流',service:'服务暂不可用，请检查控制台后重试','wrong-engine':'请把项目引擎设为翻奏识别',diagnostic:'请先完成或取消诊断','root-changed':'歌曲文件夹已变化','settings-changed':'识别设置已变化','internal-error':'任务异常，可继续或停止'};
    boxes.forEach(function(box){
    var counts=job.counts||{},text=document.createElement('span');text.textContent=(human[job.status]||job.status)+' · 已处理 '+((counts.done||0)+(counts.failed||0))+'/'+job.total+' 首'+(counts.failed?' · 失败 '+counts.failed+' 首':'')+' · 请求 '+job.requests+'/'+job.budget+(reasons[job.reason]?' · '+reasons[job.reason]:'')+(job.status==='complete'?'；有无匹配结果请在歌曲管理中查看。':'');box.appendChild(text);
    ['pause','resume','stop'].forEach(function(action){
      if(action==='pause'&&['running','queued'].indexOf(job.status)<0||action==='resume'&&['paused','interrupted'].indexOf(job.status)<0||action==='stop'&&['complete','stopped'].indexOf(job.status)>=0)return;
      var button=document.createElement('button');button.className='lm-button lm-button-small';button.textContent={pause:'暂停',resume:'继续',stop:'停止'}[action];button.disabled=state.busy;
      button.onclick=function(){var input={jobId:job.id,action:action};if(action==='resume'&&job.reason==='budget'){var budget=state.data.config.requestBudget;if(!window.confirm('继续识别并追加最多'+budget+'次请求？服务商可能计费。'))return;input.additionalBudget=budget;}return perform(function(){return api('control',input);},'任务状态已更新');};box.appendChild(button);
    });
    });
  }
  function resultLabel(song){
    if(song.source!=='auto')return labels[song.source];
    if(song.history&&song.history.status==='failed')return '识别失败'+(song.candidates.length?'（已有建议保留）':'');
    if(song.history&&['queued','running'].indexOf(song.history.status)>=0)return '本次尚未完成';
    if(!song.candidates.length)return '无匹配结果';
    return song.applied?'已暂用 · 未确认':'有建议 · 未应用';
  }
  function render(){
    if(actionRoot!==null&&actionRoot!==root())actionFeedback('');
    if(!state.data)return;renderJob();var rows=q('[data-name-rows]');rows.textContent='';
    state.data.list.forEach(function(song){
      var row=document.createElement('div');row.className='lm-name-row';row.setAttribute('data-name-row',song.nameKey);
      var first=document.createElement('div');first.className='lm-name-title';
      var check=document.createElement('input');check.type='checkbox';check.checked=state.selected.has(song.nameKey);check.disabled=state.busy;check.setAttribute('aria-label','选择 '+song.name);
      check.onchange=function(){if(this.checked)state.selected.add(song.nameKey);else state.selected.delete(song.nameKey);renderSelection();};first.appendChild(check);
      var name=document.createElement('button');name.className='lm-name-link';name.textContent=song.name;name.onclick=function(){openDetail(song);};first.appendChild(name);row.appendChild(first);
      var status=document.createElement('span');status.textContent=resultLabel(song);row.appendChild(status);
      var level=document.createElement('span');level.textContent=levels[song.confidence]||'—';row.appendChild(level);rows.appendChild(row);
    });
    if(!state.data.list.length)rows.textContent='没有符合条件的歌曲';
    q('[data-name-count]').textContent=state.data.total+' 首';q('[data-name-prev]').disabled=state.page===0||state.busy;q('[data-name-next]').disabled=!state.data.hasMore||state.busy;
    var hasJob=Boolean(state.data.job&&['queued','running','paused','interrupted'].indexOf(state.data.job.status)>=0);
    q('[data-name-start]').disabled=state.busy||hasJob;q('[data-name-home-start]').disabled=state.busy||hasJob;
    q('[data-name-auto]').checked=state.data.config.autoEnabled;q('[data-name-auto]').disabled=state.busy;
    q('[data-name-auto-state]').textContent=state.data.config.autoEnabled?'已开启':'已关闭';
    q('[data-name-home-status]').textContent=hasJob?'已有识别任务，请在歌曲管理中查看。':state.data.eligible===0?'当前没有待识别的新歌曲；已有名称或识别记录保持不变。':state.data.config.configured?'范围：当前文件夹中尚未识别的歌曲':'请先展开识别设置，配置识曲服务。';
    var summary=state.data.summary;
    q('[data-name-review-summary]').textContent=summary?'待确认 '+summary.suggestions+' 首 · 未识别或无结果 '+summary.unresolved+' 首'+(summary.failed?' · 失败 '+summary.failed+' 首':''):'查看歌曲、候选与已确认名称';
    management.querySelectorAll('[data-name-review-shortcut]').forEach(function(button){var key=button.getAttribute('data-name-review-shortcut'),label={suggestions:'待确认建议',low:'低可信建议',unresolved:'未识别 / 无结果',failed:'识别失败'}[key];button.textContent=label+(summary?' '+summary[key]:'');button.hidden=Boolean(summary&&summary[key]===0);button.disabled=state.busy;});
    renderSelection();
    if(!state.dirty)renderSettings();
    refreshDisabled();
  }
  function refreshDisabled(){
    var busy=state.busy||state.externalBusy;
    [entry,pane,management].forEach(function(scope){scope.querySelectorAll('button,input,select').forEach(function(node){node.disabled=busy;});});
    if(busy)return;
    var data=state.data,hasJob=Boolean(data&&data.job&&['queued','running','paused','interrupted'].indexOf(data.job.status)>=0);
    q('[data-name-home-start]').disabled=!data||hasJob;q('[data-name-start]').disabled=!data||hasJob;q('[data-name-auto]').disabled=!data;
    q('[data-name-prev]').disabled=!data||state.page===0;q('[data-name-next]').disabled=!data||!data.hasMore;
    q('[data-name-level]').disabled=['manual','native','legacy','none'].indexOf(q('[data-name-source]').value)>=0;
    renderSelection();
  }
  function renderSelection(){
    var songs=state.data?state.data.list:[],selected=songs.filter(function(s){return state.selected.has(s.nameKey);});
    var busy=state.busy||state.externalBusy;
    q('[data-name-all]').checked=!!songs.length&&selected.length===songs.length;q('[data-name-all]').indeterminate=selected.length>0&&selected.length<songs.length;q('[data-name-all]').disabled=!songs.length||busy;
    q('[data-name-confirm]').disabled=busy||!selected.some(function(s){return s.applied&&s.source!=='manual';});
    q('[data-name-provisional]').disabled=busy||!selected.some(function(s){return s.source==='auto'&&s.confidence==='low'&&s.candidates.length;});
    q('[data-name-retry]').disabled=busy||!selected.length;
  }
  async function perform(action,notice){
    if(state.busy||state.externalBusy)return;state.busy=true;render();save.disabled=true;
    try{var result=await action();if(result.undoId){state.undoId=result.undoId;undo.hidden=false;}customSongsChanged();if(notice)message(typeof notice==='function'?notice(result):notice);await load(false);return result;}
    catch(error){message(error.message||'操作未完成',true);}
    finally{state.busy=false;save.disabled=false;render();}
  }
  function selectTab(tab){
    if(!dirtyLeave())return;limitHelp.hide();state.dirty=false;state.tab=tab;state.detail=null;
    q('[data-name-songs]').hidden=tab!=='songs';q('[data-name-detail]').hidden=true;save.hidden=true;
    if(tab==='settings'){setCustomSongView(modal,'home');fold.open=true;renderSettings();}
    else if(modal.__managerView!=='names')setCustomSongView(modal,'names');modal.__songHelp.refresh();
  }
  function renderSettings(){
    if(!state.data)return;var c=state.data.config;q('[data-name-auto]').checked=c.autoEnabled;
    ['high','medium','low'].forEach(function(level){q('[data-name-apply="'+level+'"]').checked=c.autoApply[level];});
    q('[data-name-key-state]').textContent=c.configured?'已保存密钥（不会回显）':'尚未配置密钥';
    q('[data-name-max]').value=String(c.maxSamples);q('[data-name-budget]').value=c.requestBudget;q('[data-name-daily]').value=c.dailyBudget;
  }
  function openDetail(song){
    if(!dirtyLeave())return;state.detail=song;state.dirty=false;q('[data-name-songs]').hidden=true;
    var detail=q('[data-name-detail]');detail.hidden=false;detail.textContent='';
    function button(text,action){var b=document.createElement('button');b.className='lm-button';b.textContent=text;b.onclick=action;detail.appendChild(b);return b;}
    button('返回歌曲列表',function(){selectTab('songs');});
    var heading=document.createElement('h3');heading.textContent=song.name;detail.appendChild(heading);
    var status=document.createElement('p');status.className='lm-modal-status';status.textContent=resultLabel(song)+(levels[song.confidence]?' · '+levels[song.confidence]+'可信度':'');detail.appendChild(status);
    var intro=document.createElement('p');intro.textContent='点选候选即手动确认，后台不会覆盖。';detail.appendChild(intro);
    song.candidates.forEach(function(c){var b=button(c.name,function(){return confirm(song,c.name);});b.className+=' lm-name-candidate';});
    if(!song.candidates.length){var empty=document.createElement('p');empty.className='lm-modal-status';empty.textContent='暂无可用候选，可以手动重新识别或输入歌名。';detail.appendChild(empty);}
    if(song.source==='auto'&&song.confidence==='low'&&song.candidates.length)button('暂用最强建议（不确认）',async function(){if(!window.confirm('暂用这个低可信建议？它仍是未确认名称，可以稍后修改。'))return;var result=await perform(function(){return api('update',{nameKey:song.nameKey,action:'provisional',confirmProvisional:true,expectedRevision:song.revision});},'已暂用建议，仍未确认');if(result&&result.items&&result.items[0]){state.dirty=false;openDetail(result.items[0]);}});
    var input=document.createElement('input');input.className='lm-input';input.maxLength=240;input.value=song.name;input.setAttribute('data-name-editor','');input.setAttribute('aria-label','自定义歌曲名称');input.oninput=function(){state.dirty=this.value!==song.name;};detail.appendChild(input);
    var evidence=document.createElement('details'),summary=document.createElement('summary');summary.textContent='查看识别依据';evidence.appendChild(summary);
    var note=document.createElement('p');note.className='lm-modal-status';note.textContent='评分来自服务商，不是准确率。'+(song.history?'已采样 '+song.history.samples+' 段。':'尚无识别记录。');evidence.appendChild(note);
    song.candidates.forEach(function(c){var line=document.createElement('p');line.className='lm-modal-status';line.textContent=c.name+'：'+c.support+'段支持，最高评分 '+Number(c.topSupport||0).toFixed(2);evidence.appendChild(line);});detail.appendChild(evidence);
    button('手动重新识别',function(){return start([song.nameKey],true);});button('恢复原名',function(){return confirm(song,song.originalName);});button('就用当前名称',function(){return confirm(song,song.name);});
    save.hidden=false;save.onclick=function(){return confirm(song,input.value);};
  }
  async function confirm(song,name){var result=await perform(function(){return api('update',{nameKey:song.nameKey,name:name,expectedRevision:song.revision});},'歌名已手动确认');if(result&&result.items[0]){state.dirty=false;openDetail(result.items[0]);}}
  async function start(keys,manual){
    if(state.busy||state.externalBusy){actionFeedback('正在处理当前操作，请稍后再试。');return;}
    var sequence=++startSequence,currentRoot=root(),valid=function(){return sequence===startSequence&&root()===currentRoot&&!modal.hidden;};
    state.busy=true;actionFeedback('正在检查需要识别曲名的歌曲…');render();
    try{
      var inspection=await api('list',{cursor:0,pageSize:1,status:'all',confidence:'all',review:'all'});
      if(!valid())return;
      if(!inspection||!Array.isArray(inspection.list)||!inspection.config)throw new Error('识曲检查结果不完整，请检查本地服务版本');
      if(inspection.job&&['queued','running','paused','interrupted'].indexOf(inspection.job.status)>=0){actionFeedback('已有识别任务，请查看进度或选择继续、停止；本次未创建新任务。');await load(false);return;}
      if(!manual&&inspection.eligible===0){actionFeedback(inspection.total===0?'当前文件夹没有可识别的歌曲，本次未发送音频或消耗请求额度。':'已检查 '+inspection.total+' 首歌曲，本次无需识别：已有名称或识别记录的歌曲保持不变；未发送音频或消耗请求额度。','success');return;}
      var c=inspection.config;
      if(!c.configured){selectTab('settings');actionFeedback('请先配置识曲服务密钥，本次未开始识别。');return;}
      if(!window.confirm('识别会发送匿名音频片段，最多使用'+c.requestBudget+'次请求，服务商可能计费。继续？')){actionFeedback('已取消本次识别，未提交新任务。');return;}
      if(!valid())return;
      actionFeedback('正在提交识曲任务…');
      var result=await api('start',{mode:manual?'manual':'missing',nameKeys:keys,requestBudget:c.requestBudget});
      if(!valid())return;
      if(!result||typeof result.started!=='boolean')throw new Error('未取得明确的任务提交结果，请检查任务状态');
      if(!result.started){actionFeedback(result.reason==='already-recognized'?'本次无需识别：没有符合条件的待处理歌曲，未提交新任务或消耗请求额度。':'本次未开始识别，请检查自动开关或任务状态。');return;}
      actionFeedback('已提交识别任务'+(Number.isInteger(result.eligibleSongs)?'：'+result.eligibleSongs+' 首歌曲':'')+'，处理进度显示在识别区域。','success');
      customSongsChanged();await load(false);return result;
    }catch(error){if(valid())actionFeedback('曲名识别未完成：'+(error.message||'请检查本地服务后重试'),'error');}
    finally{state.busy=false;if(valid())render();else refreshDisabled();}
  }
  q('[data-name-all]').onchange=function(){state.selected.clear();if(this.checked&&state.data)state.data.list.forEach(function(s){state.selected.add(s.nameKey);});render();};
  function batch(action){var revisions={},selectedCount=state.selected.size;state.data.list.forEach(function(s){revisions[s.nameKey]=s.revision;});return perform(function(){return api('batch',{action:action,nameKeys:Array.from(state.selected),expectedRevisions:revisions,confirmProvisional:action==='provisional'});},function(result){var changed=result.changed||0;return(action==='confirm'?'已确认 ':'已暂用 ')+changed+' 首'+(action==='provisional'?'，仍未确认':'')+(changed<selectedCount?'；其余 '+(selectedCount-changed)+' 首未改动':'');});}
  q('[data-name-confirm]').onclick=function(){if(window.confirm('确认所选歌曲的当前名称？确认后后台不会自动覆盖；未适用的歌曲保持不变。'))return batch('confirm');};
  q('[data-name-provisional]').onclick=function(){if(window.confirm('暂用所选低可信歌曲的最强建议？暂用后仍为低可信、未确认。'))return batch('provisional');};
  q('[data-name-retry]').onclick=function(){return start(Array.from(state.selected),true);};q('[data-name-start]').onclick=function(){return start(undefined,false);};
  q('[data-name-home-start]').onclick=function(){return start(undefined,false);};
  q('[data-name-search]').oninput=function(){clearTimeout(state.searchTimer);state.searchTimer=setTimeout(function(){void load(true);},250);};
  q('[data-name-source]').onchange=function(){var disabled=['manual','native','legacy','none'].indexOf(this.value)>=0;if(disabled)q('[data-name-level]').value='all';q('[data-name-level]').disabled=disabled;return load(true);};
  q('[data-name-level]').onchange=function(){return load(true);};q('[data-name-prev]').onclick=function(){state.page--;return load(false);};q('[data-name-next]').onclick=function(){state.page++;return load(false);};
  q('[data-name-review]').onchange=function(){return load(true);};
  q('[data-name-auto]').onchange=function(){var value=this.checked;return perform(function(){return api('config',{autoEnabled:value});},'自动识别设置已保存');};
  ['high','medium','low'].forEach(function(level){
    var row=document.createElement('div');row.className='lm-song-auto-row lm-name-level-setting';row.innerHTML='<span>'+levels[level]+'可信度</span><label class="lm-music-switch"><input type="checkbox" role="switch" data-name-apply="'+level+'" aria-label="'+levels[level]+'可信度自动暂用"></label>';q('[data-name-levels]').appendChild(row);
    row.querySelector('input').onchange=function(){var apply={};apply[level]=this.checked;return perform(function(){return api('config',{autoApply:apply});},'自动暂用设置已保存');};
  });
  q('[data-name-config-save]').onclick=function(){
    var input={maxSamples:Number(q('[data-name-max]').value),requestBudget:Number(q('[data-name-budget]').value),dailyBudget:Number(q('[data-name-daily]').value)};
    if(q('[data-name-key]').value||q('[data-name-secret]').value){input.accessKey=q('[data-name-key]').value;input.accessSecret=q('[data-name-secret]').value;}
    return perform(async function(){var result=await api('config',input);q('[data-name-key]').value='';q('[data-name-secret]').value='';state.dirty=false;return result;},'服务设置已保存');
  };
  ['[data-name-key]','[data-name-secret]','[data-name-max]','[data-name-budget]','[data-name-daily]'].forEach(function(selector){q(selector).oninput=function(){state.dirty=true;};});
  q('[data-name-config-clear]').onclick=function(){if(window.confirm('清除识曲密钥并关闭自动识别？已保存的歌曲名不受影响。'))return perform(function(){return api('config',{clearCredentials:true});},'密钥已清除');};
  undo.onclick=function(){return perform(async function(){var result=await api('undo',{undoId:state.undoId});state.undoId=null;undo.hidden=true;return result;},'已撤销仍可恢复的名称修改');};
  async function openManagement(review){if(!dirtyLeave())return;state.dirty=false;q('[data-name-search]').value='';q('[data-name-source]').value='all';q('[data-name-level]').value='all';q('[data-name-level]').disabled=false;q('[data-name-review]').value=review;setCustomSongView(modal,'names');selectTab('songs');await load(true);}
  management.querySelector('[data-name-open]').onclick=function(){return openManagement('all');};
  management.querySelectorAll('[data-name-review-shortcut]').forEach(function(button){button.onclick=function(){return openManagement(button.getAttribute('data-name-review-shortcut'));};});
  modal.__nameRecognition={pane:pane,leave:dirtyLeave,
    setBusy:function(value){state.externalBusy=Boolean(value);refreshDisabled();},
    changedView:function(view){pane.hidden=view!=='names';save.hidden=view!=='names'||!state.detail;undo.hidden=view!=='names'||!state.undoId;if(view!=='names'){limitHelp.hide();clearTimeout(state.timer);state.epoch++;state.dirty=false;q('[data-name-key]').value='';q('[data-name-secret]').value='';}if(view==='home'){fold.open=false;void load(true);}},
    close:function(){startSequence++;actionFeedback('');limitHelp.hide();fold.open=false;clearTimeout(state.timer);state.epoch++;state.dirty=false;q('[data-name-key]').value='';q('[data-name-secret]').value='';}
  };
}
