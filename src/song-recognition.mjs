import crypto from 'node:crypto';
import {SongRecognitionStore} from './song-recognition-store.mjs';
import {SongRecognitionConfig} from './song-recognition-config.mjs';
import {aggregateCandidates,sampleOffsets,POLICY_VERSION} from './song-recognition-policy.mjs';
import {recognizeAcr} from './song-recognition-provider.mjs';
import {probeAacTrack,extractAacSample} from './song-audio-sample.mjs';
import {baseSongName,normalizeSongRename,planSongRename} from './custom-song-name-policy.mjs';

const fail=(message,code='SONG_NAME_INVALID',status=400)=>Object.assign(Error(message),{code,status,phase:'song-name-recognition'});
const keyPattern=/^midi_\d+_\d+$/;
const rootKey=v=>String(v||'').replace(/\\/g,'/').replace(/\/$/,'').toLowerCase();
const sameRoot=(a,b)=>rootKey(a)===rootKey(b);
const protectedSource=s=>['manual','native','legacy'].includes(s.source);
const knownName=(name,key)=>typeof name==='string'&&!!name.trim()&&name!==key;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class SongNameRecognition{
 constructor({catalog,secretStore,recognize=recognizeAcr,probe=probeAacTrack,extract=extractAacSample,intervalMs=700}={}){
  this.catalog=catalog;this.db=catalog.db;this.store=new SongRecognitionStore(this.db);this.config=new SongRecognitionConfig(this.db,secretStore);
  this.recognize=recognize;this.probe=probe;this.extract=extract;this.intervalMs=intervalMs;this.running=null;this.controller=null;this.autoTimer=null;this.autoPending=null;this.closed=false;this.undoEntries=new Map();
 }
 root(input){return this.catalog.root(input);}
 rows(root){return this.db.prepare('SELECT * FROM custom_songs WHERE root=? AND available=1 ORDER BY name_key').all(root);}
 row(key,root){if(!keyPattern.test(String(key)))throw fail('歌曲编号无效');const row=this.db.prepare('SELECT * FROM custom_songs WHERE name_key=?').get(key);if(!row||row.available!==1||!sameRoot(row.root,root))throw fail('歌曲已移出当前曲库','SONG_NAME_NOT_FOUND',404);return row;}
 ensure(row){
  const name=baseSongName(row)||row.name_key;let state=this.store.state(row.name_key);
  if(!state){state={nameKey:row.name_key,root:row.root,source:knownName(name,row.name_key)?'legacy':'none',originalName:name,displayName:name,confidence:null,applied:knownName(name,row.name_key),nameRevision:0,candidates:[],samples:[],history:null,confirmedAt:null};return this.store.save(state);}
  if(!sameRoot(state.root,row.root)||state.displayName!==name){state={...state,root:row.root,displayName:name,source:state.displayName!==name?(knownName(name,row.name_key)?'legacy':'auto'):state.source,confidence:state.displayName!==name?null:state.confidence,applied:knownName(name,row.name_key),nameRevision:state.nameRevision+1};this.store.save(state);}
  return state;
 }
 observeScan(songs,root){for(const song of songs){const row=this.db.prepare('SELECT * FROM custom_songs WHERE name_key=?').get(song.nameKey);if(!row||!sameRoot(row.root,root))continue;const s=this.ensure(row);const e=song.nameEvidence;if(e?.name===s.displayName&&e?.sources?.some(p=>p.kind==='official-log')&&['none','legacy'].includes(s.source))this.store.save({...s,source:'native',nameEvidence:e,applied:true});}this.queueAuto(root);}
 eligible(state){return!protectedSource(state)&&!state.history&&state.source==='none';}
 publicState(s){return{nameKey:s.nameKey,name:s.displayName,originalName:s.originalName,source:s.source,confirmed:s.source==='manual',confidence:s.source==='auto'?s.confidence:null,applied:s.applied,revision:s.nameRevision,hasRecognition:Boolean(s.history)||protectedSource(s),history:s.history,candidates:s.candidates||[]};}
 list(input={}){
  const root=this.root(input.mediaRoot),status=input.status||'all',level=input.confidence||'all',review=input.review||'all',search=String(input.search||'').trim().toLowerCase();
  if(search.length>240||!['all','manual','native','legacy','auto','none'].includes(status)||!['all','high','medium','low'].includes(level)||!['all','suggestions','low','unresolved','failed'].includes(review))throw fail('歌曲筛选条件无效');
  const cursor=input.cursor??0,pageSize=input.pageSize??100;if(!Number.isInteger(cursor)||cursor<0||!Number.isInteger(pageSize)||pageSize<1||pageSize>100)throw fail('分页参数无效');
  const all=this.rows(root).map(row=>this.ensure(row));
  const jobs=new Map(),flags=new Map(),summary={total:all.length,suggestions:0,low:0,unresolved:0,failed:0,processing:0,confirmed:0};
  for(const s of all){
   const history=s.history,jobId=history?.jobId;
   if(jobId&&!jobs.has(jobId))jobs.set(jobId,this.store.job(jobId));
   const processing=Boolean(history&&['queued','running'].includes(history.status)&&['queued','running'].includes(jobs.get(jobId)?.status));
   const failed=!protectedSource(s)&&history?.status==='failed';
   const suggestions=s.source==='auto'&&Boolean(s.candidates?.length)&&!failed&&!processing;
   const record={suggestions,low:suggestions&&s.confidence==='low',unresolved:!protectedSource(s)&&!processing&&(failed||!s.candidates?.length),failed,processing,confirmed:s.source==='manual'};
   flags.set(s.nameKey,record);for(const name of Object.keys(record))if(record[name])summary[name]++;
  }
  const filtered=all.filter(s=>(review==='all'||flags.get(s.nameKey)[review])&&(status==='all'||s.source===status)&&(level==='all'||s.source==='auto'&&s.confidence===level)&&(!search||[s.displayName,s.originalName,...(s.candidates||[]).map(c=>c.name)].some(n=>String(n).toLowerCase().includes(search))));
  return{mediaRoot:root,list:filtered.slice(cursor,cursor+pageSize).map(s=>this.publicState(s)),total:filtered.length,nextCursor:Math.min(cursor+pageSize,filtered.length),hasMore:cursor+pageSize<filtered.length,summary,eligible:all.filter(s=>this.eligible(s)).length,job:this.store.summary(this.store.latest(root)),config:this.config.public(),usage:this.store.usage()};
 }
 status(input={}){const root=this.root(input.mediaRoot);return{config:this.config.public(),usage:this.store.usage(),job:this.store.summary(this.store.latest(root)),running:Boolean(this.running)};}
 async configure(input){const generation=this.config.read().generation;const result=await this.config.update(input);if(this.running&&(!result.configured||input?.allowAudioUpload===false||result.generation!==generation))this.controller?.abort();return{...result,updating:false};}
 assertWritable(root){if(this.catalog.debugPackages?.hasPriority())throw fail('请完成或取消诊断后再识别或改名','SONG_NAME_DIAGNOSTIC_BUSY',409);if(this.catalog.inFlight||this.catalog.mappingMutation||this.catalog.visionTasks?.userMutation)throw fail('曲库正在更新，请稍后再试','SONG_NAME_BUSY',409);const current=this.catalog.refresh?.root||this.catalog.scannedRoot;if(current&&!sameRoot(current,root))throw fail('当前歌曲文件夹已变化','SONG_NAME_ROOT_CHANGED',409);}
 writeMany(root,changes,{rememberUndo=true}={}){
  this.assertWritable(root);let entries=this.catalog.mappings?.read()||[];const before=[],after=[];
  for(const change of changes){const row=this.row(change.key,root),s=this.ensure(row);if(change.revision!==undefined&&change.revision!==s.nameRevision)throw fail('歌曲名已变化，请刷新后重试','SONG_NAME_CHANGED',409);
   const name=normalizeSongRename(change.name),plan=planSongRename(row,entries,name);entries=plan.nextEntries;before.push({...s});after.push({...s,...change.fields,displayName:name,applied:true,nameRevision:s.nameRevision+1});
  }
  this.catalog.commitMappings(this.catalog.mappings?entries:undefined,()=>{for(const s of after){this.db.prepare('UPDATE custom_songs SET custom_name=?,updated_at=? WHERE name_key=?').run(s.displayName,Date.now(),s.nameKey);this.store.save(s);}});
  this.catalog.invalidatePresentationCache();this.catalog.refresh?.invalidate();
  let undoId=null;if(rememberUndo&&after.length){undoId=crypto.randomUUID();this.undoEntries.set(undoId,{root,before,after,expiresAt:Date.now()+5*60e3});while(this.undoEntries.size>20)this.undoEntries.delete(this.undoEntries.keys().next().value);}
  return{changed:after.length,items:after.map(s=>this.publicState(s)),undoId};
 }
 update(input={}){const root=this.root(input.mediaRoot),row=this.row(input.nameKey,root),s=this.ensure(row);const action=input.action||'confirm';
  if(action==='provisional'){if(s.source!=='auto'||s.confidence!=='low'||!s.candidates.length)throw fail('当前歌曲没有可暂用的低可信建议');if(input.confirmProvisional!==true)throw fail('请确认暂用低可信建议');return this.writeMany(root,[{key:s.nameKey,name:s.candidates[0].name,revision:input.expectedRevision,fields:{}}]);}
  if(!['confirm','restore'].includes(action))throw fail('不支持的名称操作');const name=action==='restore'?s.originalName:input.name??s.displayName;
  return this.writeMany(root,[{key:s.nameKey,name,revision:input.expectedRevision,fields:{source:'manual',confidence:null,confirmedAt:Date.now()}}]);
 }
 batch(input={}){const root=this.root(input.mediaRoot),keys=this.validateKeys(input.nameKeys);if(!['confirm','provisional'].includes(input.action))throw fail('批量操作无效');if(input.action==='provisional'&&input.confirmProvisional!==true)throw fail('请确认暂用低可信建议');const changes=[];
  for(const key of keys){const s=this.ensure(this.row(key,root));if(input.action==='provisional'){if(s.source==='auto'&&s.confidence==='low'&&s.candidates.length)changes.push({key,name:s.candidates[0].name,revision:input.expectedRevisions?.[key],fields:{}});}else if(knownName(s.displayName,key)&&s.source!=='manual')changes.push({key,name:s.displayName,revision:input.expectedRevisions?.[key],fields:{source:'manual',confidence:null,confirmedAt:Date.now()}});}
  if(!changes.length)return{changed:0,skipped:keys.length,items:[]};return{...this.writeMany(root,changes),skipped:keys.length-changes.length};
 }
 undo(input={}){const entry=this.undoEntries.get(input.undoId);if(!entry||entry.expiresAt<Date.now()||!sameRoot(entry.root,this.root(input.mediaRoot)))throw fail('撤销记录已失效','SONG_NAME_UNDO_EXPIRED',409);const changes=[];for(const before of entry.before){const current=this.store.state(before.nameKey),after=entry.after.find(s=>s.nameKey===before.nameKey);if(current?.nameRevision===after.nameRevision)changes.push({key:before.nameKey,name:before.displayName,revision:current.nameRevision,fields:{...before}});}const result=changes.length?this.writeMany(entry.root,changes,{rememberUndo:false}):{changed:0,items:[]};this.undoEntries.delete(input.undoId);return result;}
 noteManualName(key,name){const row=this.db.prepare('SELECT * FROM custom_songs WHERE name_key=?').get(key);if(!row)return;const previous=this.store.state(key)||this.ensure(row);this.store.save({...previous,root:row.root,displayName:name,source:'manual',confidence:null,applied:true,nameRevision:previous.nameRevision+1,confirmedAt:Date.now()});}
 validateKeys(keys){if(!Array.isArray(keys)||!keys.length||keys.length>1000||keys.some(k=>typeof k!=='string'||!keyPattern.test(k)))throw fail('请选择1—1000首歌曲');return[...new Set(keys)];}
 async start(input={}){
  const root=this.root(input.mediaRoot),mode=input.mode||'missing';if(!['auto','missing','manual'].includes(mode))throw fail('识别模式无效');this.assertWritable(root);
  const config=this.config.public();if(!config.configured)throw fail('请先配置识曲服务密钥','SONG_NAME_NOT_CONFIGURED',409);if(mode==='auto'&&!config.autoEnabled)return{started:false,reason:'auto-disabled',job:null};
  if(this.running||this.store.unfinished(root))throw fail('已有识别任务，请先继续或停止','SONG_NAME_BUSY',409);
  const all=this.rows(root).map(r=>this.ensure(r)),keys=input.nameKeys?this.validateKeys(input.nameKeys):null;
  const chosen=all.filter(s=>(!keys||keys.includes(s.nameKey))&&(mode==='manual'||this.eligible(s)));
  if(chosen.length>1000)throw fail('单次最多识别1000首，请先选择歌曲');
  if(!chosen.length)return{started:false,reason:'already-recognized',checkedSongs:all.length,eligibleSongs:0,job:this.store.summary(this.store.latest(root))};
  const budget=input.requestBudget??config.requestBudget;if(!Number.isInteger(budget)||budget<1||budget>5000)throw fail('本次请求上限无效');
  const job=this.store.create(root,mode,budget,chosen);this.launch(job.id);return{started:true,checkedSongs:all.length,eligibleSongs:chosen.length,job:this.store.summary(job)};
 }
 async control(input={}){const root=this.root(input.mediaRoot),job=this.store.job(input.jobId);if(!job||!sameRoot(job.root,root))throw fail('识别任务不存在','SONG_NAME_JOB_MISSING',404);
  if(input.action==='pause'){if(['queued','running'].includes(job.status)){this.store.setJob(job.id,'paused','user');this.controller?.abort();}}
  else if(input.action==='stop'){this.store.setJob(job.id,'stopped','user');this.controller?.abort();for(const item of this.store.items(job.id)){if(item.status==='done')continue;item.status='stopped';this.store.saveItem(item);const s=this.store.state(item.name_key);if(s?.history?.jobId===job.id)this.store.save({...s,history:{...s.history,status:'stopped'}});}}
  else if(input.action==='resume'){
   if(this.running)throw fail('正在停止上一次请求，请稍后继续','SONG_NAME_BUSY',409);if(!['paused','interrupted'].includes(job.status))throw fail('当前任务无需继续');
   if(job.reason==='budget'){const extra=input.additionalBudget;if(!Number.isInteger(extra)||extra<1||extra>5000||job.budget+extra>20000)throw fail('请确认追加的请求上限');this.db.prepare('UPDATE song_name_jobs SET budget=budget+? WHERE id=?').run(extra,job.id);}
   this.store.setJob(job.id,'queued');this.launch(job.id);
  }else throw fail('任务操作无效');return{job:this.store.summary(this.store.job(job.id))};
 }
 queueAuto(root){if(this.closed)return;const c=this.config.public();if(!c.autoEnabled||!c.configured)return;this.autoPending=root;if(this.autoTimer)return;this.autoTimer=setTimeout(()=>{this.autoTimer=null;if(this.running||this.store.unfinished(root))return;this.autoPending=null;this.start({mediaRoot:root,mode:'auto'}).catch(()=>{});},400);this.autoTimer.unref?.();}
 launch(id){if(this.running||this.closed)return;this.running=this.run(id).catch(()=>{const j=this.store.job(id);if(j?.status==='running')this.store.setJob(id,'paused','internal-error');}).finally(()=>{this.running=null;this.controller=null;const pending=this.autoPending;this.autoPending=null;if(pending&&!this.store.unfinished(pending))this.queueAuto(pending);});}
 async run(id){
  this.controller=new AbortController();const signal=this.controller.signal;this.store.setJob(id,'running');
  const configStart=this.config.read();let credentials;try{credentials=await this.config.credentials();}catch{this.store.setJob(id,'paused','credentials');return;}
  try{while(!this.closed){
   let job=this.store.job(id);if(job?.status!=='running')break;const config=this.config.read();if(!this.config.public().configured||config.generation!==configStart.generation||this.config.updating){this.store.setJob(id,'paused','settings-changed');break;}
   try{this.assertWritable(job.root);}catch(e){if(e.code==='SONG_NAME_BUSY'){await wait(100);continue;}this.store.setJob(id,'paused',e.code==='SONG_NAME_DIAGNOSTIC_BUSY'?'diagnostic':'root-changed');break;}
   const item=this.store.items(id).find(i=>i.status==='pending');if(!item){this.store.setJob(id,'complete');break;}
   const row=this.row(item.name_key,job.root);let state=this.ensure(row);
   try{
    if(!item.details.fileName){const files=JSON.parse(row.files_json||'[]');if(!files.length)throw fail('没有可用音轨','SONG_AUDIO_UNSUPPORTED');const chosen=files.find(f=>f.tod==='TOD12')||files[0];const resolved=await this.catalog.resolveFile(row,chosen.fileName),probe=await this.probe(resolved.path,{signal});item.details={...item.details,fileName:chosen.fileName,fingerprint:probe.fingerprint,offsets:sampleOffsets(probe.durationSeconds,{maxSamples:config.maxSamples,durationSeconds:10})};this.store.saveItem(item);}
    const offset=item.details.offsets[item.phase];if(!offset){item.status='done';this.store.saveItem(item);continue;}
    const resolved=await this.catalog.resolveFile(row,item.details.fileName),clip=await this.extract(resolved.path,{startSeconds:offset.startSeconds,durationSeconds:offset.durationSeconds,signal});
    if(clip.sourceFingerprint!==item.details.fingerprint)throw fail('音频文件已变化','SONG_AUDIO_CHANGED',409);
    const cacheKey=crypto.createHash('sha256').update(POLICY_VERSION+'\n'+config.generation+'\n').update(clip.buffer).digest('hex');let result=this.store.cache(cacheKey);
    if(!result){job=this.store.job(id);if(job.status!=='running')break;const limit=this.store.reserve(job,config);if(limit){this.store.setJob(id,'paused',limit);break;}result=await this.recognize({audio:clip.buffer,mimeType:clip.mimeType,...credentials,signal});this.store.saveCache(cacheKey,result);await wait(this.intervalMs);}
    if(this.store.job(id).status!=='running')break;
    if(this.catalog.debugPackages?.hasPriority()){this.store.setJob(id,'paused','diagnostic');break;}
    item.details.samples.push({offsetSeconds:offset.startSeconds,candidates:result.candidates||[]});item.phase++;
    state=this.ensure(this.row(item.name_key,job.root));const aggregate=aggregateCandidates(item.details.samples,{currentName:state.displayName});
    const done=item.phase>=item.details.offsets.length||aggregate.stable;const next={...state,candidates:aggregate.candidates,samples:item.details.samples,confidence:protectedSource(state)?null:aggregate.confidence,source:protectedSource(state)?state.source:'auto',history:{jobId:id,status:done?'complete':'running',samples:item.phase,outcome:result.status,updatedAt:Date.now(),policy:POLICY_VERSION}};
    this.store.save(next);item.status=done?'done':'pending';this.store.saveItem(item);
    if(done&&!protectedSource(next)&&next.nameRevision===item.details.nameRevision&&aggregate.suggestedName&&config.autoApply[aggregate.confidence]){
     try{this.writeMany(job.root,[{key:next.nameKey,name:aggregate.suggestedName,revision:next.nameRevision,fields:{source:'auto',confidence:aggregate.confidence}}],{rememberUndo:false});}
     catch(e){this.store.save({...next,history:{...next.history,applyError:e.code||'SONG_NAME_WRITE_FAILED'}});}
    }
   }catch(e){
    if(signal.aborted||this.store.job(id)?.status!=='running'){if(this.store.job(id)?.status==='running')this.store.setJob(id,'paused','settings-changed');break;}
    const code=typeof e.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(e.code)?e.code:'SONG_RECOGNITION_FAILED';
    state=this.store.state(item.name_key)||state;this.store.save({...state,source:protectedSource(state)?state.source:'auto',history:{jobId:id,status:'failed',samples:item.phase,error:code,providerCode:Number.isSafeInteger(e.providerCode)?e.providerCode:null,updatedAt:Date.now()}});
    if(/AUTH|QUOTA|RATE_LIMIT|NOT_CONFIGURED|SECRET|SERVICE|TIMEOUT|NETWORK|WRONG_ENGINE|RECOGNITION_INPUT/.test(code)){this.store.setJob(id,'paused',/AUTH|SECRET|NOT_CONFIGURED/.test(code)?'credentials':/RATE/.test(code)?'rate-limit':/QUOTA/.test(code)?'quota':/WRONG_ENGINE/.test(code)?'wrong-engine':'service');break;}
    item.status='failed';item.details.error=code;this.store.saveItem(item);
   }
  }}finally{credentials=null;}
 }
 diagnostics(){const root=this.catalog.refresh?.root||this.catalog.root();return{config:this.config.public(),usage:this.store.usage(),job:this.store.summary(this.store.latest(root)),stateCount:this.db.prepare('SELECT COUNT(*) AS n FROM song_name_states').get().n};}
 async close(){this.closed=true;clearTimeout(this.autoTimer);this.controller?.abort();if(this.running)await this.running;}
}
