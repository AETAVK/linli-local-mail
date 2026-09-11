import {baseSongName,savedSongName,previewSongRename} from './custom-song-name-policy.mjs';
const fold = value => String(value||'').toLowerCase();
const usable = (name,key) => typeof name==='string'&&Boolean(name.trim())&&name!==key&&!/^midi_\d+_\d+$/i.test(name);
const LABELS={recoverable:'可以恢复原名',historical:'只能恢复历史显示名',ambiguous:'无法唯一恢复',unrecoverable:'已检查资料中无法恢复',incomplete:'检查未完成',excluded:'无法建立当前歌曲身份'};
function connection(song,record) {
  if(fold(song.nameKey)===fold(record.nameKey))return {strength:'exact',basis:'same-nameKey-independent-of-outer-root'};
  for(const left of song.files||[])for(const right of record.files||[]){
    const sets=[left.resourceSet,...(left.provenance||[]).map(p=>p.resourceSet)].filter(Boolean);
    if(fold(left.fileName)===fold(right.fileName)&&right.resourceSet&&sets.includes(right.resourceSet))
      return{strength:'exact',basis:'same-explicit-resource-and-file'};
  }
  if((song.files||[]).some(left=>(record.files||[]).some(right=>fold(left.fileName)===fold(right.fileName))))
    return{strength:'candidate',basis:'basename-only-not-identity'};
  return null;
}
function relevantGaps(source,key) {
  return (source.gaps||[]).filter(g=>!Array.isArray(g.keys)||g.keys.some(k=>fold(k)===fold(key))).map(g=>({sourceId:source.id,...g}));
}
export function assessSongNames({inventory,sources=[],mappingEntries=[],capturedAt=Date.now()}={}) {
  const results=[];
  const byKey=new Map(),byFile=new Map();
  const index=(map,key,value)=>{if(!key)return;if(!map.has(key))map.set(key,[]);map.get(key).push(value);};
  for(const source of sources)for(let i=0;i<(source.records||[]).length;i++){
    const record=source.records[i],ref={source,record,index:i};index(byKey,fold(record.nameKey),ref);
    for(const file of record.files||[])index(byFile,fold(file.fileName),ref);
  }
  let reportBytes=0;
  for(const inputSong of inventory?.songs||[]){
    const sameKey=byKey.get(fold(inputSong.nameKey))||[];
    const row=sameKey.find(ref=>ref.source.kind==='current-db-songs')?.record;
    const song={...inputSong,files:(inputSong.files||[]).map(file=>({...row?.files?.find(f=>fold(f.fileName)===fold(file.fileName)),...file}))};
    const candidates=[],excluded=[],gaps=[],originalValues=new Set(),historicalValues=new Set(),candidateGroups=new Map();
    let currentRow=row;
    for(const source of sources){
      gaps.push(...relevantGaps(source,song.nameKey));
      if(source.complete!==true&&!(source.gaps||[]).length)gaps.push({sourceId:source.id,reason:'source-completeness-unknown'});
    }
    const matches=new Set([...sameKey,...song.files.flatMap(file=>byFile.get(fold(file.fileName))||[])]);
    for(const {source,record,index} of matches){
        const link=connection(song,record);if(!link)continue;
        if(source.kind==='current-db-songs'&&fold(record.nameKey)===fold(song.nameKey))currentRow=record;
        for(const field of ['name','customName','alternateName']){
          const name=record[field];if(name==null)continue;
          const value={name,field,sourceId:source.id,sourceKind:source.kind,locator:source.locator,
            snapshot:source.snapshot,recordIndex:index,location:record.location||null,sourceNameKey:record.nameKey,
            link,root:record.root,revision:record.revision,updatedAt:record.updatedAt};
          let reason=!usable(name,record.nameKey)?'derived-or-empty-name':link.strength!=='exact'?'identity-link-unconfirmed':
            field==='alternateName'?'parser-support-required':record.nameKind==='derived-fallback'?'local-derived-not-original':null;
          if(source.unstableRead)reason='unstable-source-read';
          if(record.exclusion==='parser-support-required')reason='parser-support-required';
          // A legacy metadata_source=log flag is not an official-name certificate.
          value.kind=field==='name'&&record.nameKind==='official-original'&&(record.files||[]).some(f=>f.basis==='explicit-official-resource')?'official-original':'historical-display';
          if(!reason){
            (value.kind==='official-original'?originalValues:historicalValues).add(name);
            const group=JSON.stringify([value.kind,name]),previous=candidateGroups.get(group);
            if(previous){previous.occurrences++;if(previous.additionalLocations.length<8)previous.additionalLocations.push({sourceId:source.id,recordIndex:index,location:record.location});continue;}
            value.occurrences=1;value.additionalLocations=[];candidateGroups.set(group,value);
          }
          if(candidates.length+excluded.length>=256){if(!gaps.some(g=>g.reason==='song-candidate-budget'))gaps.push({reason:'song-candidate-budget'});continue;}
          if(reason){excluded.push({...value,reason});continue;}
          candidates.push(value);
        }
    }
    gaps.push(...(inventory.gaps||[]).filter(g=>!g.keys||g.keys.includes(song.nameKey)));
    const originals=candidates.filter(c=>c.kind==='official-original');
    const unique=[...(originalValues.size?originalValues:historicalValues)];
    let status,selectedName=null,preview=null;
    if(song.exclusion)status='excluded';
    else if(unique.length>1)status='ambiguous';
    else if(unique.length===1){
      selectedName=unique[0];status=originalValues.size?'recoverable':'historical';
      preview=previewSongRename({song,row:currentRow,entries:mappingEntries,name:selectedName});
      if(sources.some(s=>s.id==='current-mapping-original'&&!s.complete)){
        preview.prerequisites.push('repair-current-mapping-store-before-updateMapping');preview.applicable=false;
      }
    }else status=gaps.length||excluded.some(c=>['identity-link-unconfirmed','parser-support-required'].includes(c.reason))?'incomplete':'unrecoverable';
    const rowCurrent=currentRow?.available===1&&String(currentRow.root||'').replace(/\\/g,'/').toLowerCase()===String(song.root||'').replace(/\\/g,'/').toLowerCase();
    const result={nameKey:song.nameKey,root:song.root,files:song.files,currentName:rowCurrent?savedSongName(currentRow,song.files||[],mappingEntries):song.name||song.nameKey,
      currentStoredName:currentRow?baseSongName(currentRow):null,status,label:LABELS[status],selectedName,
      candidates,excludedCandidates:excluded,conflicts:unique.length>1?unique:[],gaps,preview,exclusion:song.exclusion||null,
      conclusionScope:'provided-and-checked-material-only',relatedCoverageComplete:!gaps.length,
      originalNameProven:originalValues.size===1&&status==='recoverable',
      positiveEvidenceDoesNotProveAbsentUnseenConflicts:Boolean(selectedName&&gaps.length)};
    reportBytes+=Buffer.byteLength(JSON.stringify(result));
    if(reportBytes>4*1024*1024){result.candidates=[];result.excludedCandidates=[];result.preview=null;result.selectedName=null;result.conflicts=[];result.originalNameProven=false;result.status='incomplete';result.label=LABELS.incomplete;result.gaps=[{reason:'report-detail-budget'}];result.relatedCoverageComplete=false;}
    results.push(result);
  }
  const counts={};for(const item of results)counts[item.status]=(counts[item.status]||0)+1;
  const report={schemaVersion:1,algorithm:'song-name-evidence-v1',capturedAt,readOnly:true,
    scope:'current-inventory-and-provided-sources-not-all-history',counts,songs:results,
    inventoryComplete:inventory?.complete===true,inventoryGaps:inventory?.gaps||[],
    sources:sources.map(({records,...source})=>({...source,records:records?.length||0})),
    complete:inventory?.complete===true&&sources.every(s=>s.complete===true)&&results.every(s=>s.relatedCoverageComplete&&s.status!=='incomplete'),limitations:[
      'No disk access or repair is performed by this assessment or preview.',
      'Missing unprovided backups and overwritten or originally clipped logs cannot be reconstructed.',
      'Basename/size/duration similarity alone never proves identity.',
      'An applicable plan still requires a future explicit write and recheck of the captured inputs.']};
  const text=renderSongNameReport(report);
  report.readableComplete=Buffer.byteLength(text)<=1024*1024;
  report.readable=report.readableComplete?text:text.slice(0,250000)+'\n可读文本达到容量上限，完整逐首机器记录见 songs。';
  return report;
}
export function renderSongNameReport(report) {
  const quote=value=>JSON.stringify(value??'');
  const lines=['逐首歌曲名称恢复诊断','范围：仅本次当前歌曲清单和已提供资料；不是对所有历史资料的保证。','本报告未执行恢复、改名、映射或时段修改。',''];
  for(const song of report.songs){
    lines.push(quote(song.nameKey)+' — '+song.label,'当前名称：'+quote(song.currentName));
    if(song.selectedName&&song.preview)lines.push('建议名称：'+quote(song.selectedName),'方法：'+song.preview.method,
      '内存预演：'+(song.preview.applicable?'通过；显式确认后可按仅名称计划执行':'需要满足前置条件：'+song.preview.prerequisites.join('、')));
    if(song.conflicts.length)lines.push('冲突名称：'+song.conflicts.map(quote).join(' / '));
    for(const c of song.candidates)lines.push('证据：'+quote(c.name)+'；'+c.sourceId+'；'+c.link.basis+'；'+quote(c.location));
    if(song.excludedCandidates.length)lines.push('未采用候选：'+song.excludedCandidates.map(c=>quote(c.name)+' ('+c.reason+')').join(' / '));
    if(song.gaps.length)lines.push('相关资料缺口：'+[...new Set(song.gaps.map(g=>g.reason))].join('、'));
    if(song.exclusion)lines.push('身份说明：'+song.exclusion);
    lines.push('');
  }
  return lines.join('\n');
}
