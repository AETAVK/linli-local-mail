// Shared display/update rules. This module has no IO and is safe for diagnostic dry runs.
export function baseSongName(row) { return row?.custom_name || row?.customName || row?.name; }
export function savedSongName(row, files, entries) {
  const key = row.name_key ?? row.nameKey;
  const table = new Map(entries.map(entry => [String(entry.fileName).toLowerCase(), entry]));
  let name = baseSongName(row);
  for (const file of files) {
    const entry = table.get(String(file.fileName).toLowerCase());
    if (entry?.name && (!entry.filePath || entry.filePath.toLowerCase() === (key + '/' + file.fileName).toLowerCase())) name = entry.name;
  }
  return name;
}
export function normalizeSongRename(value) {
  const name = String(value).trim();
  if (!name || name.length > 240 || /[\0\r\n]/.test(name)) throw Object.assign(Error('曲名应为 1～240 个单行字符'), {status:400});
  return name;
}
export function planSongRename(row,entries,name) {
  const nextName=normalizeSongRename(name),key=row.name_key??row.nameKey;
  const files=row.files||JSON.parse(row.files_json||'[]');
  const names=new Set(files.map(f=>String(f.fileName).toLowerCase()));
  const nextEntries=entries.map(entry=>names.has(String(entry.fileName).toLowerCase())&&
    (!entry.filePath||entry.filePath.toLowerCase()===(key+'/'+entry.fileName).toLowerCase())?{...entry,name:nextName}:{...entry});
  return {nextRow:{...row,custom_name:nextName,customName:nextName},nextEntries};
}
export function previewSongRename({song, row, entries = [], name}) {
  const prerequisites = [];
  let nextName;
  try { nextName = normalizeSongRename(name); } catch { prerequisites.push('name-not-supported-by-current-write-rule'); }
  if (/[\0\r\n]/.test(name)) prerequisites.push('mapping-name-format-not-supported');
  if (!row) prerequisites.push('register-current-song-before-existing-updateMapping');
  if(row&&(String(row.root||'').replace(/\\/g,'/').replace(/\/$/,'').toLowerCase()!==String(song.root||'').replace(/\\/g,'/').replace(/\/$/,'').toLowerCase()||row.available!==1))
    prerequisites.push('register-current-root-and-availability-without-erasing-history');
  const files = song.files || [];
  if (!files.length) prerequisites.push('current-file-list-required');
  if(row&&JSON.stringify((row.files||[]).map(f=>String(f.fileName).toLowerCase()).sort())!==JSON.stringify(files.map(f=>String(f.fileName).toLowerCase()).sort()))
    prerequisites.push('reconcile-current-index-file-list-before-rename');
  const before = structuredClone({row:row || null, entries});
  const planInput=row||{nameKey:song.nameKey,files};
  const planned=nextName?planSongRename(planInput,entries,nextName):{nextRow:planInput,nextEntries:entries};
  const nextRow=planned.nextRow;
  for (const file of files) {
    const old = entries.find(entry=>String(entry.fileName).toLowerCase()===String(file.fileName).toLowerCase());
    if (old?.filePath && old.filePath.toLowerCase() !== (song.nameKey + '/' + file.fileName).toLowerCase())
      prerequisites.push('mapping-basename-collision-requires-resolution');
  }
  const plannedEntries = planned.nextEntries;
  const displayed = savedSongName(nextRow, files, plannedEntries);
  const omitName=entry=>Object.fromEntries(Object.entries(entry).filter(([key])=>!['name','custom_name','customName'].includes(key)));
  const nonNameDataPreserved=JSON.stringify(entries.map(omitName))===JSON.stringify(plannedEntries.map(omitName))&&
    JSON.stringify(omitName(planInput))===JSON.stringify(omitName(nextRow));
  return {schemaVersion:1,mode:'pure-memory-no-write',method:'updateMapping-name-only',
    arguments:{nameKey:song.nameKey,name:nextName}, prerequisites:[...new Set(prerequisites)],
    applicable:!prerequisites.length && displayed===nextName && nonNameDataPreserved, expectedDisplayedName:displayed,
    normalizationChanged:nextName!==name, cacheAction:'invalidate-derived-presentation-after-explicit-future-write',
    nameOnly:true, nonNameDataPreserved,
    plan:{rowName:nextName,mappingNames:files.map(file=>({fileName:file.fileName,name:nextName}))},
    inputUnchanged:JSON.stringify(before)===JSON.stringify({row:row || null,entries})};
}
