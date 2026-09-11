import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {gunzipSync} from 'node:zlib';
import {preserveEvidence,extractSafePrefix} from './custom-song-debug-evidence.mjs';
import {credentialKey} from './custom-song-fragment-redact.mjs';

export const NAME_SOURCE_LIMITS = Object.freeze({paths:32,files:256,depth:4,rows:20000,
  sourceBytes:64*1024*1024,totalBytes:256*1024*1024,retainedBytes:6*1024*1024,lineBytes:1024*1024,retries:1});
const safeFields = (value,keys) => Object.fromEntries(keys.filter(key=>Object.hasOwn(value||{},key)).map(key=>[key,value[key]]));
const stamp = stat => ({size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs,ino:stat.ino});
const same = (a,b) => JSON.stringify(a)===JSON.stringify(b);
const gap = (source,reason,keys=null) => {
  source.complete=false;
  const previous=source.gaps.find(g=>g.reason===reason&&JSON.stringify(g.keys)===JSON.stringify(keys));
  if(previous){previous.count=(previous.count||1)+1;return;}
  if(source.gaps.length>=128){source.omittedGapCount=(source.omittedGapCount||0)+1;
    if(!source.gaps.some(g=>g.reason==='gap-detail-budget'))source.gaps.push({reason:'gap-detail-budget',keys:null});return;}
  source.gaps.push({reason,keys,count:1});
};
export function newNameSource(id,kind,locator) {return {id,kind,locator,snapshot:null,complete:true,state:'read',gaps:[],records:[]};}
export function boundNameSources(sources,maxBytes=6*1024*1024) {
  let bytes=0;
  return sources.map(source=>{
    const result={...source,gaps:(source.gaps||[]).map(g=>({...g})),records:[]};
    bytes+=Buffer.byteLength(JSON.stringify(result));
    for(const record of source.records||[]){
      const size=Buffer.byteLength(JSON.stringify(record));
      if(bytes+size>maxBytes){gap(result,'combined-name-evidence-budget');result.omittedRecords=(result.omittedRecords||0)+1;continue;}
      result.records.push(record);bytes+=size;
    }
    return result;
  });
}
export function projectSongFiles(files) {
  return (Array.isArray(files)?files:[]).map(file=>safeFields(file,[
    'fileName','filePath','relativePath','tod','view','evidence','automaticEvidence','provenance','resourceSet','fileRevision','size','duration']));
}
function retain(source,record,limit=NAME_SOURCE_LIMITS.retainedBytes) {
  const safe=preserveEvidence(record,{maxBytes:128*1024});
  if(safe.gaps.length)for(const reason of safe.gaps)gap(source,reason,record.nameKey?[record.nameKey]:null);
  const bytes=Buffer.byteLength(JSON.stringify(safe.value));
  if(safe.value===null || source.records.length>=NAME_SOURCE_LIMITS.rows || (source.retainedBytes||0)+bytes>limit){gap(source,'retention-budget');return;}
  source.records.push(safe.value);source.retainedBytes=(source.retainedBytes||0)+bytes;
}
function jsonField(value,source,key,fallback) {
  try {if(typeof value!=='string')throw Error();return JSON.parse(value);}catch{gap(source,'song-field-json-invalid',key?[key]:null);return fallback;}
}
// Only these two tables and these columns are read; no letters, settings, tokens or entire DB export.
export function snapshotSongDatabase(db,{id='current-db',locator='running-database',kind='current-db'}={}) {
  const sources=[];
  db.exec('SAVEPOINT song_name_diagnostic_read');
  try {
    for(const table of ['custom_songs','custom_song_catalog_cache']){
      const source=newNameSource(id+'/'+table,kind+(table==='custom_songs'?'-songs':'-cache'),locator);
      source.snapshot={capturedAt:Date.now(),basis:'read-transaction'};sources.push(source);
      const exists=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if(!exists){source.state='known-older-schema-no-song-data';continue;}
      const columns=new Set(db.prepare('PRAGMA table_info('+table+')').all().map(r=>r.name));
      const wanted=table==='custom_songs'?['name_key','name','custom_name','root','available','files_json','overrides_json','metadata_source','updated_at']:['root','revision','updated_at','snapshot_json'];
      const required=table==='custom_songs'?['name_key','name']:['snapshot_json'];
      if(required.some(key=>!columns.has(key))){gap(source,'unsupported-song-table-schema');continue;}
      const selected=wanted.filter(key=>columns.has(key)).map(key=>key.endsWith('_json')?
        'CASE WHEN length('+key+')<='+(key==='snapshot_json'?4194304:65536)+' THEN '+key+' END AS '+key:key);
      if(table==='custom_song_catalog_cache')selected.push('length(snapshot_json)>4194304 AS snapshot_omitted');
      let rowIndex=0,inspectedBytes=0;
      for(const row of db.prepare('SELECT '+selected.join(',')+' FROM '+table+' LIMIT 20001').iterate()){
        if(++rowIndex>20000){gap(source,'row-budget');break;}
        inspectedBytes+=Buffer.byteLength(JSON.stringify(row));
        if(inspectedBytes>8*1024*1024){gap(source,'database-component-read-budget');break;}
        if(table==='custom_songs'){
          const files=jsonField(row.files_json,source,row.name_key,[]);
          const overrides=row.overrides_json==null?{}:jsonField(row.overrides_json,source,row.name_key,{});
          retain(source,{nameKey:row.name_key,name:row.name,customName:row.custom_name,root:row.root,available:row.available,
            files:projectSongFiles(files),overrides,metadataSource:row.metadata_source,updatedAt:row.updated_at,
            provenance:'saved-display-not-proof-of-official-name'});
        }else{
          if(row.snapshot_json==null){if(row.snapshot_omitted)gap(source,'catalog-snapshot-byte-budget');else source.state='no-saved-snapshot';continue;}
          const saved=jsonField(row.snapshot_json,source,null,null);
          if(!Array.isArray(saved?.list)){gap(source,'unsupported-catalog-snapshot');continue;}
          if(saved.list.length>20000)gap(source,'cache-song-budget');
          for(const item of saved.list.slice(0,20000))retain(source,{nameKey:item.nameKey||item.songNameKey,name:item.name,
            root:row.root,revision:row.revision,updatedAt:row.updated_at,files:projectSongFiles(item.localFiles),
            metadataSource:item.metadataSource,provenance:'historical-catalog-display'});
        }
      }
    }
  } finally {db.exec('RELEASE song_name_diagnostic_read');}
  return sources;
}
function resources(value) {
  const found=[];
  for(const item of Array.isArray(value)?value:[]){
    try{
      const url=new URL(item?.url);
      if(url.protocol!=='https:'||url.hostname!=='static-cnbeta01.olivia.miyoushe.com'||url.port||url.username||url.password)continue;
      const match=url.pathname.match(/^\/midiPerf\/(\d+)\/(\d+)\/([^/]+\.mp4)$/i);if(!match)continue;
      const fileName=decodeURIComponent(match[3]);if(/[\\/:\0]/.test(fileName))continue;
      found.push({fileName,resourceSet:crypto.createHash('sha256').update(url.origin+url.pathname.slice(0,url.pathname.lastIndexOf('/'))).digest('hex'),
        resourceKey:'midi_'+match[1]+'_'+match[2],basis:'explicit-official-resource'});
    }catch{}
  }
  return found;
}
function probeSongFields(input) {
  const queue=[input];let nodes=0,bytes=0,limited=false;
  while(queue.length&&nodes++<128){
    let value=queue.pop();
    for(let depth=0;typeof value==='string'&&/^\s*[\[{"']/.test(value)&&depth<4;depth++){
      bytes+=value.length;if(bytes>1024*1024){limited=true;value=null;break;}
      value=extractSafePrefix(value).value;
    }
    if(!value||typeof value!=='object')continue;
    if(Object.hasOwn(value,'nameKey')||Object.hasOwn(value,'videoByTodView'))return{found:true,limited};
    const entries=Object.entries(value);if(entries.length>128)limited=true;
    for(const [key,child] of entries.slice(0,128))if(!credentialKey(key))queue.push(child);
  }
  return{found:false,limited:limited||queue.length>0};
}
// Actual OTEL envelope and inner JSON string; damaged strings are never regex-salvaged past the first error.
export function observeNameLogLine(source,line,lineNumber) {
  const marker=line.indexOf('[OTEL Logger]');if(marker<0)return;
  const outer=extractSafePrefix(line.slice(marker+13)),attrs=outer.value?.attributes||outer.value;
  const action=attrs?.['query.action'];
  if(typeof action==='string'&&/letter|mail/i.test(action))return;
  const unsupportedAction=!['checkLocalSongs','startSongDownload'].includes(action);
  if(unsupportedAction){
    const probe=probeSongFields(attrs);
    if(probe.found||/nameKey|videoByTodView/.test(line)){gap(source,'unsupported-song-action');}
    else {if(probe.limited&&/song/i.test(action||''))gap(source,'song-action-probe-budget');return;}
  }
  let request=attrs?.['query.request'],complete=outer.complete,consumedGeneratedSuffix=false;
  if(request===undefined && Object.hasOwn(attrs||{},'query.response'))return;
  const generated=typeof request==='string'&&/\[truncated(?:\s+\d+\s+chars)?\]\s*$/i.test(request);
  const derived=typeof request==='string'&&/\/custom-song-media\/|"localCustomSong"\s*:\s*true|"localEvidenceVersion"/.test(request);
  for(let i=0;typeof request==='string'&&i<4;i++){
    if(i===0&&generated){
      const original=request.replace(/(?:\.\.\.)?\[truncated(?:\s+\d+\s+chars)?\]\s*$/i,'');
      const parsed=extractSafePrefix(original);
      consumedGeneratedSuffix=outer.complete&&!parsed.complete&&!parsed.omittedCharacters&&parsed.inspectedCharacters>=original.length;
      complete=complete&&parsed.complete;request=parsed.value;continue;
    }
    const parsed=extractSafePrefix(request);complete=complete&&parsed.complete;request=parsed.value;
  }
  const keys=[],pending=[request];let nodes=0;
  while(pending.length && nodes++<20000){
    const value=pending.pop();if(!value||typeof value!=='object')continue;
    if(typeof value.nameKey==='string'){
      keys.push(value.nameKey);
      retain(source,{nameKey:value.nameKey,name:value.name,alternateName:value.songName??value.title,
        nameKind:derived?'derived-fallback':unsupportedAction?'unknown-origin':'official-original',files:resources(value.videoByTodView),
        location:{line:lineNumber,action},generatedTruncation:generated,completeRecord:complete,
        exclusion:unsupportedAction?'parser-support-required':typeof value.name!=='string'&&(value.songName||value.title)?'unsupported-name-field':null});
    }
    for(const [key,child] of Object.entries(value))if(!credentialKey(key)&&child&&typeof child==='object')pending.push(child);
  }
  if(pending.length)gap(source,'log-structure-budget');
  // A cut list may hide a later song's key, so the missing suffix is globally relevant for negative findings.
  if(consumedGeneratedSuffix){source.historyKnownIncomplete=true;source.generatedTruncationEvents=(source.generatedTruncationEvents||0)+1;}
  else if(!complete||!request||typeof request!=='object')gap(source,'unparsed-song-fragment');
}
export function mappingNameSource(entries,{id='current-mappings',locator='current-mapping',kind='mapping'}={}) {
  const source=newNameSource(id,kind,locator);
  if(!Array.isArray(entries)){gap(source,'unsupported-mapping-schema');return source;}
  for(const entry of entries.slice(0,20000)){
    if(!entry||typeof entry!=='object'){gap(source,'invalid-mapping-entry');continue;}
    const filePath=typeof entry.filePath==='string'?entry.filePath.replace(/\\/g,'/'):'';
    retain(source,{nameKey:/^midi_\d+_\d+\//i.test(filePath)?filePath.split('/')[0]:null,name:entry.name,
      files:[safeFields(entry,['fileName','filePath','tod','view'])],nameKind:'historical-display',rawFilePath:entry.filePath});
  }
  if(entries.length>20000)gap(source,'mapping-entry-budget');
  return source;
}
export async function stableNameRead(file,read,{retries=1,stat=fs.promises.lstat}={}) {
  let changed=false;
  for(let attempt=0;attempt<=retries;attempt++){
    const before=await stat(file);if(before.isSymbolicLink()||!before.isFile())throw Object.assign(Error('not-regular-file'),{code:'UNSAFE_SOURCE'});
    const value=await read(before),after=await stat(file);
    if(!after.isSymbolicLink()&&after.isFile()&&same(stamp(before),stamp(after)))return{value,snapshot:stamp(after),attempts:attempt+1,changedDuringEarlierAttempt:changed};
    changed=true;
  }
  throw Object.assign(Error('source-changed'),{code:'INPUT_CHANGED'});
}
export function validateExtraSourcePaths(paths=[]) {
  if(!Array.isArray(paths)||paths.length>32||paths.some(p=>typeof p!=='string'||p.length>4096||p.includes('\0')||!path.isAbsolute(p)))throw Object.assign(Error('额外资料路径无效，最多32项'),{status:400});
  return [...new Set(paths.map(p=>path.resolve(p)))];
}
export async function collectExtraNameSources({extraPaths=[],logRoot,backupRoot,signal,limits={},io={}}={}) {
  const cap={...NAME_SOURCE_LIMITS,...limits},sources=[],queue=[];
  let remaining=cap.totalBytes,retained=0,files=0,visited=0;
  const stat=io.lstat||fs.promises.lstat,readFile=io.readFile||fs.promises.readFile,readdir=io.readdir||fs.promises.readdir;
  const add=source=>{const bytes=Buffer.byteLength(JSON.stringify(source));if(retained+bytes>cap.retainedBytes){source.records=[];gap(source,'total-retention-budget');}else retained+=bytes;sources.push(source);};
  for(const file of validateExtraSourcePaths(extraPaths))queue.push({file,depth:0,explicit:true});
  if(logRoot)queue.push({file:logRoot,depth:0,logs:true});
  if(backupRoot)for(const relative of ['user-data',path.join('recovery','pre-restore')])queue.push({file:path.join(backupRoot,relative),depth:0,known:true});
  while(queue.length){
    if(signal?.aborted)throw Object.assign(Error('cancelled'),{code:'ABORT_ERR'});
    const item=queue.shift(),{file}=item,source=newNameSource('extra-'+sources.length,'extra-source',file);
    if(++visited>cap.files*2||sources.length>=cap.files*2){gap(source,'source-entry-budget');add(source);break;}
    if(files>=cap.files){gap(source,'source-file-budget');add(source);break;}
    let info;
    try{info=await stat(file);}catch(error){if(item.known&&error.code==='ENOENT'){source.state='known-location-absent';add(source);continue;}gap(source,'source-access-'+(error.code||'failed'));add(source);continue;}
    if(info.isSymbolicLink()){gap(source,'symbolic-link-excluded');add(source);continue;}
    if(info.isDirectory()){
      if(item.depth>=cap.depth){gap(source,'directory-depth-budget');add(source);continue;}
      try{
        const children=await readdir(file,{withFileTypes:true});
        if(children.length>cap.files)gap(source,'directory-entry-budget');
        for(const child of children.slice(0,cap.files)){
          // Known backups: only backup snapshots and their data/ subdirectory, never media/config/letters.
          const allowedDir=item.logs?false:item.known?(item.depth===0||child.name==='data'):true;
          if(child.isDirectory()&&allowedDir || child.isFile()&&(/\.(?:log|bak|old|txt|gz|sqlite3?|db)$/i.test(child.name)||
            (item.known?/^custom-song-mappings.*\.json$/i:/\.json$/i).test(child.name))){
            if(queue.length>=cap.files)gap(source,'pending-source-budget');
            else queue.push({file:path.join(file,child.name),depth:item.depth+1,known:item.known,logs:item.logs});
          }
          else if(!item.known&&/\.(?:zip|7z|rar)$/i.test(child.name)){const unsupported=newNameSource('unsupported-'+sources.length,'unsupported-container',path.join(file,child.name));gap(unsupported,'unsupported-container');add(unsupported);}
        }
        source.state='directory-enumerated';source.snapshot=stamp(info);source.directory=true;add(source);
      }catch(error){gap(source,'directory-read-'+(error.code||'failed'));add(source);}
      continue;
    }
    if(!info.isFile()){gap(source,'non-file-excluded');add(source);continue;}
    files++;
    const sqlite=/\.(?:sqlite3?|db)(?:\.bak)?$/i.test(file);
    if(info.size>(sqlite?cap.totalBytes:cap.sourceBytes)||info.size>remaining){gap(source,'source-byte-budget');add(source);continue;}
    remaining-=info.size;
    try {
      const stable=await stableNameRead(file,async before=>{
        if(before.size>(sqlite?cap.totalBytes:cap.sourceBytes))throw Object.assign(Error('size'),{code:'SOURCE_LIMIT'});
        if(sqlite){
          for(const suffix of ['-wal','-journal']){try{if((await stat(file+suffix)).size)throw Object.assign(Error('needs-sidecar'),{code:'NON_STANDALONE_SQLITE'});}catch(error){if(error.code!=='ENOENT')throw error;}}
          const db=new DatabaseSync(file,{readOnly:true});try{db.exec('PRAGMA trusted_schema=OFF');return snapshotSongDatabase(db,{id:source.id,kind:'backup-db',locator:file});}finally{db.close();}
        }
        let bytes=await readFile(file);
        if(/\.gz$/i.test(file))bytes=gunzipSync(bytes,{maxOutputLength:cap.sourceBytes});
        if(bytes.length>cap.sourceBytes)throw Object.assign(Error('size'),{code:'SOURCE_LIMIT'});
        const text=bytes.toString('utf8');
        if(/\.json$/i.test(file)){
          const document=JSON.parse(text);const result=mappingNameSource(document?.entries,{id:source.id,locator:file,kind:'backup-mapping'});
          if(document?.schemaVersion!==1)gap(result,'unsupported-mapping-version');
          return [result];
        }
        if(!/\.(?:log|bak|old|txt|gz)$/i.test(file))throw Object.assign(Error('format'),{code:'UNSUPPORTED_FORMAT'});
        const result=newNameSource(source.id,'additional-log',file);
        let observed=false,number=0;
        for(const line of text.split('\n')){
          if(++number%256===0&&signal?.aborted)throw Object.assign(Error('cancelled'),{code:'ABORT_ERR'});
          if(Buffer.byteLength(line)>cap.lineBytes){gap(result,'line-byte-budget');continue;}
          if(line.includes('[OTEL Logger]'))observed=true;
          if(line.includes('\ufffd')||line.includes('\0'))gap(result,'unknown-text-encoding');
          observeNameLogLine(result,line,number);
        }
        if(text.trim()&&!observed)gap(result,'unsupported-log-format');return [result];
      },{retries:cap.retries,stat});
      for(const result of stable.value){result.snapshot=stable.snapshot;result.readAttempts=stable.attempts;result.changedDuringEarlierAttempt=stable.changedDuringEarlierAttempt;add(result);}
    }catch(error){gap(source,error.code||'source-parse-failed');add(source);}
  }
  await verifyNameSourceGroup(sources,{stat});
  return {schemaVersion:1,sources,limits:cap,scope:'known-patch-backups-and-explicit-selections-only',complete:sources.every(s=>s.complete)};
}

// Each read can be stable while rotation between reads loses an older member. Check the whole group again.
export async function verifyNameSourceGroup(sources,{stat=fs.promises.lstat}={}) {
  let changed=false;
  for(const source of sources){
    if(!source.snapshot||!source.locator)continue;
    try{const after=await stat(source.locator);
      if(after.isSymbolicLink()||!same(source.snapshot,stamp(after))){gap(source,'source-changed-after-read');changed=true;}
    }catch{gap(source,'source-unavailable-after-read');changed=true;}
  }
  if(changed)for(const source of sources)gap(source,'source-group-changed-during-capture');
  return !changed;
}

// Enumerate identity, not playable status: unindexed/empty/renamed directories remain visible.
export async function captureNameInventory(root,{io={},limit=10000}={}) {
  const stat=io.lstat||fs.promises.lstat,readdir=io.readdir||fs.promises.readdir;
  const inventory={root,songs:[],gaps:[],complete:true};
  const missing=(reason,keys=null)=>{inventory.complete=false;inventory.gaps.push({reason,keys});};
  try{
    const before=await stat(root);if(before.isSymbolicLink()||!before.isDirectory())throw Error('invalid-root');
    const children=await readdir(root,{withFileTypes:true});if(children.length>limit)missing('inventory-entry-budget');
    for(const child of children.slice(0,limit)){
      if(!child.isDirectory()&&!child.isSymbolicLink())continue;
      const song={nameKey:child.name,root,files:[],exclusion:null};inventory.songs.push(song);
      if(child.isSymbolicLink()){song.exclusion='symbolic-directory-not-opened';missing(song.exclusion,[child.name]);continue;}
      if(!/^midi_\d+_\d+$/.test(child.name))song.exclusion='directory-name-does-not-establish-song-key';
      try{
        const folder=path.join(root,child.name),prior=await stat(folder),entries=await readdir(folder,{withFileTypes:true});
        if(entries.length>10000)missing('song-file-budget',[child.name]);
        song.files=entries.slice(0,10000).filter(e=>e.isFile()&&!e.isSymbolicLink()&&/\.mp4$/i.test(e.name)).map(e=>({fileName:e.name}));
        if(!song.files.length)song.exclusion=song.exclusion||'no-mp4-files-in-current-directory';
        if(!same(stamp(prior),stamp(await stat(folder))))missing('song-directory-changed',[child.name]);
      }catch{missing('song-directory-unreadable',[child.name]);}
    }
    if(!same(stamp(before),stamp(await stat(root))))missing('inventory-root-changed');
  }catch{missing('inventory-root-unreadable');}
  return inventory;
}
