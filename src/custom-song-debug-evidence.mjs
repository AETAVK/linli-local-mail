import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { credentialKey,redactDiagnosticValue } from './custom-song-fragment-redact.mjs';
import { diagnosticError,diagnosticCode,diagnosticReason } from './diagnostic-errors.mjs';
const BUSINESS=new Set(['name','title','namekey','id','songid','jobid','itemid','taskid','clientid','filename','filepath','relativepath','root','mediaroot','requestedroot','persistedroot','officialroot','scannedroot','actualpath','queryaction','action','code','reason','stage','phase','evidence','algorithm','policy','filerevision','revision','timestamp','time','createdat','updatedat','savedat','at','eventtime','url','view','tod','status','mode','kind','origin','category','basis','encoding']);
const CONTAINERS=new Set(['queryrequest','queryresponse','request','response','payload','inventoryjson','resultjson','valuejson','filesjson']);
const norm=value=>String(value).toLowerCase().replace(/[_.-]/g,'');
// This parser stops at the first damaged token. It never searches inside an unfinished string.
export function extractSafePrefix(text){
 let i=0,nodes=0,complete=true;const lexemes=[];const limit=Math.min(text.length,1024*1024);
 const ws=()=>{while(i<limit&&/[\x20\x09\x0a\x0d]/.test(text[i]))i++;};
 function string(){const start=i++;while(i<limit){const c=text[i++];if(c==='\\'){i++;continue;}if(c==='"'){const lexical=text.slice(start,i);return{value:JSON.parse(lexical),lexical};}}throw Error('incomplete-string');}
 function value(depth,pointer,sensitive){
  if(++nodes>20000||depth>24)throw Error('budget');ws();const start=i,c=text[i];
  if(c==='"')return string();
  if(c==='{'||c==='['){const array=c==='[',result=array?[]:Object.create(null);i++;ws();
   try{while(i<limit&&text[i]!== (array?']':'}')){
    let key=array?String(result.length):null,spelling=null;
    if(!array){if(text[i]!=='"')throw Error('key');const token=string();key=token.value;spelling=token.lexical;ws();if(text[i++]!==':')throw Error('colon');}
    const secret=sensitive||credentialKey(key),child=value(depth+1,pointer+'/'+key,secret);result[key]=child.value;
    if(!complete)return{value:result};
    if(!secret&&(BUSINESS.has(norm(key))||/(name|title|id|code)$/.test(norm(key))||typeof child.value!=='string')&&child.lexical&&lexemes.length<2000)lexemes.push({pointer:pointer+'/'+key,keyLexeme:spelling,valueLexeme:child.lexical});
    ws();if(text[i]===(array?']':'}'))break;if(text[i++]!==',')throw Error('separator');ws();if(text[i]===(array?']':'}'))throw Error('trailing-comma');
   }if(text[i++]!==(array?']':'}'))throw Error('end');}catch{complete=false;}
   return{value:result};
  }
  while(i<limit&&!/[\s,}\]]/.test(text[i]))i++;if(i===start)throw Error('value');const lexical=text.slice(start,i),parsed=JSON.parse(lexical);
  if(parsed!==null&&typeof parsed==='object')throw Error('primitive');return{value:parsed,lexical};
 }
 let parsed;try{parsed=value(0,'',false).value;ws();if(i!==text.length)complete=false;}catch{complete=false;parsed=null;}
 // JSON.parse is the final grammar authority, including whitespace and primitive spelling.
 if(complete)try{JSON.parse(text);}catch{complete=false;}
 return{value:parsed,complete,lexemes,inspectedCharacters:Math.min(i,limit),omittedCharacters:Math.max(0,text.length-limit),basis:complete?'complete-json':'safe-prefix-not-repaired-json'};
}

export function preserveEvidence(value,{maxBytes=1024*1024}={}){
 let nodes=0;const gaps=[];
 function walk(value,key='',depth=0){
  if(++nodes>20000||depth>24){gaps.push('structure-budget');return{omitted:'structure-budget'};}
  if(credentialKey(key))return'[REDACTED]';
  if(['imagedata','pixels','thumbnail','screenshot','videodata','imagebase64','base64','rawframes'].includes(norm(key))){gaps.push('media-payload-not-exported');return{omitted:'media-payload-not-exported'};}
  if(typeof value==='string'){
   if(value.length>32768&&!CONTAINERS.has(norm(key))){gaps.push('string-budget');return{omitted:'string-budget',characters:value.length};}
   if(CONTAINERS.has(norm(key))&&/^\s*[\[{]/.test(value)){const parsed=extractSafePrefix(value);const cleaned=walk(parsed.value,'',depth+1);
    // Lexemes are retained only for business scalars with no credential-bearing URL/path.
    const lexical=parsed.lexemes.filter(item=>{
      if(item.pointer.split('/').some(credentialKey))return false;
      try{const key=JSON.parse(item.keyLexeme||'"value"'),value=JSON.parse(item.valueLexeme),safe=redactDiagnosticValue({[key]:value},{bytes:131072,stringBytes:65536});return safe.ok&&JSON.stringify(safe.value[key])===JSON.stringify(value);}catch{return false;}
    });
    if(!parsed.complete)gaps.push('partial-json-container');return{encoding:'json-string',basis:parsed.basis,complete:parsed.complete,value:cleaned,businessLexemes:lexical};}
   const result=redactDiagnosticValue({[key]:value},{bytes:131072,stringBytes:65536});
   if(result.ok){if(result.redactionReasons?.['unclassified-query-value'])gaps.push('unclassified-query-value-redacted');return result.value[key];}gaps.push(result.reason);return{omitted:result.reason};
  }
  if(Array.isArray(value)){if(value.length===2&&typeof value[0]==='string'&&credentialKey(value[0]))return[value[0],'[REDACTED]'];if(value.length>20000)gaps.push('array-items-omitted');return value.slice(0,20000).map(item=>walk(item,key,depth+1));}
  if(!value||typeof value!=='object')return value;
  const entries=Object.entries(value),headerPair=entries.some(([k,v])=>['name','key','headername'].includes(norm(k))&&typeof v==='string'&&credentialKey(v));
  if(entries.length>2000)gaps.push('object-fields-omitted');
  const priority=key=>BUSINESS.has(norm(key))||CONTAINERS.has(norm(key))||norm(key)==='attributes'||/(name|title|id|code)$/.test(norm(key))?1:0;
  const selected=entries.map(([key,item],index)=>({key,item,index})).sort((a,b)=>priority(b.key)-priority(a.key)||a.index-b.index).slice(0,2000);
  for(const record of selected)record.clean=headerPair&&['value','values','headervalue'].includes(norm(record.key))?'[REDACTED]':walk(record.item,record.key,depth+1);
  return Object.fromEntries(selected.sort((a,b)=>a.index-b.index).map(r=>[r.key,r.clean]));
 }
 let result=walk(value);if(Buffer.byteLength(JSON.stringify(result))>maxBytes){result=null;gaps.push('record-byte-budget');}
 return{value:result,gaps:[...new Set(gaps)]};
}

export class DetailedSongEvidence {
 constructor({bytes=6*1024*1024,records=20000}={}){this.limitBytes=bytes;this.limitRecords=records;this.bytes=0;this.events=[];this.omitted=0;this.classes={};this.files=[];this.fileBytes=0;this.fileOmitted=0;}
 observe(line,source,outer,order){
  const body=line.slice(line.indexOf('[OTEL Logger]')+13),lexical=extractSafePrefix(body),parsed=outer?{value:outer,complete:true,basis:'complete-json'}:lexical;
  const attrs=parsed.value?.attributes||parsed.value||{},request=attrs['query.request'];
  const derived=typeof request==='string'&&/\/custom-song-media\/|"localCustomSong"\s*:\s*true|"localEvidenceVersion"/.test(request);
  const named=typeof request==='string'&&/"(?:name|nameKey)"\s*:/.test(request)||Boolean(attrs.nameKey||attrs.name);
  const category=derived?'local-derived':named?'song-association':Object.hasOwn(attrs,'query.response')&&!Object.hasOwn(attrs,'query.request')?'response-only':'other-song-event';
  this.classes[category]=(this.classes[category]||0)+1;
  const clean=preserveEvidence(parsed.value),record={order,source,origin:derived?'local-derived-not-official':'log-event',category,complete:parsed.complete,basis:parsed.basis,
   decoded:clean.value,gaps:clean.gaps,businessLexemes:lexical.lexemes.filter(item=>{
    try{const key=JSON.parse(item.keyLexeme||'"value"'),value=JSON.parse(item.valueLexeme),safe=redactDiagnosticValue({[key]:value},{bytes:131072,stringBytes:65536});return safe.ok&&JSON.stringify(safe.value[key])===JSON.stringify(value);}catch{return false;}
   }),lexicalComplete:lexical.complete,eventTime:preserveEvidence({timestamp:attrs.timestamp??parsed.value?.timestamp??null}).value};
  const size=Buffer.byteLength(JSON.stringify(record));
  // Response floods are represented separately and cannot consume the association index.
  const repeated=category==='response-only'&&this.classes[category]>32||category==='local-derived'&&this.classes[category]>64;
  if(repeated||this.events.length>=this.limitRecords||this.bytes+size>this.limitBytes){this.omitted++;return category;}
  this.events.push(record);this.bytes+=size;return category;
 }
 file(record){const clean=preserveEvidence(record,{maxBytes:32768});const size=Buffer.byteLength(JSON.stringify(clean.value));if(this.files.length>=20000||this.fileBytes+size>2*1024*1024){this.fileOmitted++;return;}this.files.push(clean.value);this.fileBytes+=size;}
 snapshot(){return{schemaVersion:1,mode:'detailed-credential-filtered',sourceValues:'decoded-business-values-with-separate-lexemes',events:this.events,files:this.files,
  coverage:{retainedEvents:this.events.length,omittedEvents:this.omitted,classes:this.classes,bytes:this.bytes,omittedFiles:this.fileOmitted,complete:!this.omitted&&!this.fileOmitted&&!this.events.some(e=>e.gaps.length)}};}
}

export function detailedServiceEvidence(catalog,input,mappingEntries,failures=[]){
 const result={schemaVersion:1,capturedAt:Date.now(),failures,environment:{node:process.version,platform:process.platform,arch:process.arch,osRelease:os.release(),basis:'running-process'},components:{}};
 const component=(key,read)=>{try{const data=read();if(Array.isArray(data)){
  const records=[];let bytes=0,omitted=Math.max(0,data.length-20000);for(const item of data.slice(0,20000)){const clean=preserveEvidence(item,{maxBytes:65536}),size=Buffer.byteLength(JSON.stringify(clean));if(clean.value===null||bytes+size>1024*1024){omitted++;continue;}records.push(clean);bytes+=size;}
  result.components[key]={records,omitted,complete:omitted===0};
 }else result.components[key]=preserveEvidence(data,{maxBytes:1024*1024});}catch(error){result.components[key]={available:false,error:diagnosticError(error,'read-'+key)};}};
 component('frontend',()=>input.frontend||{available:false});
 component('paths',()=>({requestedRoot:input.mediaRoot,root:catalog.root(input.mediaRoot),persistedRoot:catalog.db.prepare("SELECT value FROM settings WHERE key='customSongs.mediaRoot'").get()?.value,officialRoot:input.officialRoot,scannedRoot:catalog.scannedRoot}));
 component('mappings',()=>mappingEntries);
 component('mapping-source',()=>{
  if(!catalog.mappings)throw Object.assign(Error('missing'),{code:'MAPPING_MISSING'});
  const stat=fs.statSync(catalog.mappings.filePath);if(stat.size>8*1024*1024)throw Object.assign(Error('limit'),{code:'MAPPING_TOO_LARGE'});
  const raw=JSON.parse(fs.readFileSync(catalog.mappings.filePath,'utf8').replace(/^\uFEFF/,''));
  if(!Array.isArray(raw.entries))throw Object.assign(Error('shape'),{code:'MAPPING_SCHEMA_INVALID'});
  return raw.entries; // Original decoded values, before the production reader trims or rewrites separators.
 });
 component('tasks',()=>{
  return catalog.db.prepare('SELECT id,root,mode,status,reason,generation,created_at,updated_at,CASE WHEN length(inventory_json)<=65536 THEN inventory_json END AS inventory_json,length(inventory_json)>65536 AS inventory_json_omitted FROM song_vision_jobs WHERE root=? ORDER BY created_at DESC LIMIT 32').all(catalog.root(input.mediaRoot));
 });
 component('task-items',()=>catalog.db.prepare('SELECT i.id,i.job_id,i.name_key,i.file_name,i.revision,i.state,i.reason,i.cache_hit,CASE WHEN length(i.result_json)<=65536 THEN i.result_json END AS result_json,length(i.result_json)>65536 AS result_json_omitted FROM song_vision_items i JOIN song_vision_jobs j ON j.id=i.job_id WHERE j.root=? ORDER BY j.created_at DESC,i.name_key,i.file_name LIMIT 10000').all(catalog.root(input.mediaRoot)));
 component('cache',()=>catalog.db.prepare('SELECT root,name_key,file_name,kind,updated_at,CASE WHEN length(value_json)<=65536 THEN value_json END AS value_json,length(value_json)>65536 AS value_json_omitted FROM song_vision_cache WHERE root=? ORDER BY updated_at DESC LIMIT 2000').all(catalog.root(input.mediaRoot)));
 component('inventory-counts',()=>({mappingEntries:mappingEntries.length,jobs:catalog.db.prepare('SELECT COUNT(*) AS n FROM song_vision_jobs WHERE root=?').get(catalog.root(input.mediaRoot)).n,cacheEntries:catalog.db.prepare('SELECT COUNT(*) AS n FROM song_vision_cache WHERE root=?').get(catalog.root(input.mediaRoot)).n,jobLimit:32,taskItemLimit:10000,cacheLimit:2000,componentBytes:1048576}));
 const countSafe=(sql)=>{try{return catalog.db.prepare(sql).get(catalog.root(input.mediaRoot)).n;}catch{return null;}};
 result.coverage={taskItemsTotal:countSafe('SELECT COUNT(*) AS n FROM song_vision_items i JOIN song_vision_jobs j ON j.id=i.job_id WHERE j.root=?'),taskItemLimit:10000,cacheEntriesTotal:countSafe('SELECT COUNT(*) AS n FROM song_vision_cache WHERE root=?'),cacheLimit:2000};
 result.coverage.complete=failures.length===0&&result.coverage.taskItemsTotal!==null&&result.coverage.taskItemsTotal<=10000&&result.coverage.cacheEntriesTotal!==null&&result.coverage.cacheEntriesTotal<=2000&&Object.values(result.components).every(c=>c.available!==false&&!c.omitted&&!(c.gaps&&c.gaps.length)&&!(c.records||[]).some(r=>r.gaps.length||Object.entries(r.value||{}).some(([k,v])=>k.endsWith('_omitted')&&v)));
 return result;
}
