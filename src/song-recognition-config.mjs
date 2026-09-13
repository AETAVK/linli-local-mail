export const SONG_NAME_CONFIG_KEY='songRecognition.config.v1';
export const SONG_NAME_SECRET_ID='song-recognition:acrcloud-cn';
export const DEFAULT_NAME_CONFIG=Object.freeze({version:2,generation:0,autoEnabled:false,autoApply:{high:true,medium:true,low:false},maxSamples:5,requestBudget:5000,dailyBudget:5000});
const fail=(message,code='SONG_NAME_CONFIG_INVALID')=>Object.assign(Error(message),{code,status:400,phase:'recognition-config'});
export class SongRecognitionConfig{
 constructor(db,secretStore){this.db=db;this.secrets=secretStore;this.updating=false;db.exec('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');}
 read(){
  let raw={};try{raw=JSON.parse(this.db.prepare('SELECT value FROM settings WHERE key=?').get(SONG_NAME_CONFIG_KEY)?.value||'{}')||{};}catch{}
  const value={...DEFAULT_NAME_CONFIG,autoApply:{...DEFAULT_NAME_CONFIG.autoApply}};
  if(typeof raw.autoEnabled==='boolean')value.autoEnabled=raw.autoEnabled;
  for(const [key,min,max] of [['generation',0,Number.MAX_SAFE_INTEGER],['maxSamples',3,5],['requestBudget',1,5000],['dailyBudget',1,5000]])if(Number.isSafeInteger(raw[key])&&raw[key]>=min&&raw[key]<=max)value[key]=raw[key];
  for(const key of ['high','medium','low'])if(typeof raw.autoApply?.[key]==='boolean')value.autoApply[key]=raw.autoApply[key];
  if(raw.version!==2){
   // Preserve an old opt-out: migration alone must never start audio uploads.
   if(raw.allowAudioUpload!==true)value.autoEnabled=false;
   if(raw.requestBudget===300&&raw.dailyBudget===3000){value.requestBudget=5000;value.dailyBudget=5000;}
  }
  return value;
 }
 public(){const v=this.read();return{...v,host:'identify-cn-north-1.acrcloud.cn',configured:Boolean(this.secrets?.has(SONG_NAME_SECRET_ID)),updating:this.updating};}
 async credentials(){if(!this.secrets)throw fail('请先配置识曲服务密钥','SONG_NAME_NOT_CONFIGURED');let v;try{v=JSON.parse(await this.secrets.get(SONG_NAME_SECRET_ID)||'{}');}catch{throw fail('无法读取识曲密钥，请重新配置','SONG_NAME_SECRET_UNAVAILABLE');}if(!v.accessKey||!v.accessSecret)throw fail('请先配置识曲服务密钥','SONG_NAME_NOT_CONFIGURED');return v;}
 async update(input={}){
  if(this.updating)throw Object.assign(fail('识曲设置正在保存'),{status:409});
  if(!input||typeof input!=='object'||Array.isArray(input))throw fail('识曲设置无效');
  const allowed=['autoEnabled','allowAudioUpload','autoApply','maxSamples','requestBudget','dailyBudget','accessKey','accessSecret','clearCredentials'];
  if(Object.keys(input).some(k=>!allowed.includes(k)))throw fail('包含不支持的识曲设置');
  const next=this.read();
  if(Object.hasOwn(input,'autoEnabled')){if(typeof input.autoEnabled!=='boolean')throw fail('开关必须为布尔值');next.autoEnabled=input.autoEnabled;}
  // Accept legacy clients without retaining a second, invisible permission gate.
  if(Object.hasOwn(input,'allowAudioUpload')){if(typeof input.allowAudioUpload!=='boolean')throw fail('开关必须为布尔值');if(!input.allowAudioUpload)next.autoEnabled=false;}
  if(input.autoApply!==undefined){if(!input.autoApply||typeof input.autoApply!=='object'||Array.isArray(input.autoApply))throw fail('自动暂用设置无效');for(const key of Object.keys(input.autoApply)){if(!['high','medium','low'].includes(key)||typeof input.autoApply[key]!=='boolean')throw fail('可信度开关无效');next.autoApply[key]=input.autoApply[key];}}
  for(const[key,min,max]of [['maxSamples',3,5],['requestBudget',1,5000],['dailyBudget',1,5000]])if(input[key]!==undefined){if(!Number.isInteger(input[key])||input[key]<min||input[key]>max)throw fail('请求预算或采样上限无效');next[key]=input[key];}
  if(input.clearCredentials!==undefined&&typeof input.clearCredentials!=='boolean')throw fail('清除密钥设置无效');
  const hasKey=Object.hasOwn(input,'accessKey'),hasSecret=Object.hasOwn(input,'accessSecret');
  if(hasKey!==hasSecret)throw fail('请同时填写 Access Key 和 Secret Key');
  let credentials;
  if(hasKey){if(input.clearCredentials)throw fail('不能同时清除和设置密钥');if(typeof input.accessKey!=='string'||typeof input.accessSecret!=='string'||![input.accessKey,input.accessSecret].every(v=>/^[A-Za-z0-9_-]{8,256}$/.test(v)))throw fail('密钥格式无效');credentials={accessKey:input.accessKey,accessSecret:input.accessSecret};}
  if(next.autoEnabled&&(input.clearCredentials||!credentials&&!this.secrets?.has(SONG_NAME_SECRET_ID))){
   if(input.autoEnabled===true)throw Object.assign(fail('请先配置识曲服务密钥，再开启自动识别','SONG_NAME_NOT_CONFIGURED'),{status:409});
   next.autoEnabled=false;
  }
  this.updating=true;
  try{
   if(credentials||input.clearCredentials){if(!this.secrets)throw fail('安全密钥存储不可用','SONG_NAME_SECRET_UNAVAILABLE');try{await this.secrets.set(SONG_NAME_SECRET_ID,credentials?JSON.stringify(credentials):'');}catch{throw fail('无法安全保存识曲密钥','SONG_NAME_SECRET_WRITE_FAILED');}next.generation++;}
   if(input.clearCredentials)next.autoEnabled=false;
   this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(SONG_NAME_CONFIG_KEY,JSON.stringify(next));
   return this.public();
  }finally{this.updating=false;}
 }
}
