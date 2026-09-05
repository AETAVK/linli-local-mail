import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GAME_ROOT = path.resolve(ROOT, "..");
const BASELINE_PATH = path.join(ROOT, "backups", "required", "official-compatible-0.0.9.627", "feapp.dat");
const TARGET_PATH = path.join(GAME_ROOT, "0.0.9.627", "resources", "feapp.dat");
const WEBPLAYER_BASELINE_PATH = path.join(ROOT, "backups", "required", "official-compatible-0.0.9.627", "webplayer.dat");
const WEBPLAYER_TARGET_PATH = path.join(GAME_ROOT, "0.0.9.627", "resources", "webplayer.dat");
const FRONTEND_SCRIPT_PATH = path.join(ROOT, "frontend", "local-mail-poc.js");
const LOG_PATH = path.join(ROOT, "logs", "last-patch.json");
const EXPECTED_BASELINE_SHA256 = "c88f1dd4cb7c95e4902d74dd0c247962ffd65559e3907497b416078d3a6698b5";
const EXPECTED_WEBPLAYER_BASELINE_SHA256 = "565b5e3e113c2a9dfb90d5fa4f2a0ccda9b0151c118ae3365e6ee0c8624a451d";
const INDEX_ENTRY = "index.html";
const MAIN_ENTRY = "assets/main-31595bd3.js";
const LOCAL_SCRIPT_ENTRY = "assets/local-mail-poc.js";
const WEBPLAYER_MAIN_ENTRY = "assets/main-95684bf7.js";
const MUSIC_BRIDGE_EXTRAS = 'getQueueElement:()=>Ut.value&&Ut.value.$el,getQueue:()=>K.value,notify:(q,me)=>window.__LINLI_NATIVE_NOTIFY__(q,me),stopRemoved: q=>{const me=h.currentSong;if(h.playSource==="playlist"&&me&&q.some(Be=>Number(Be.itemType)===Number(me.itemType)&&String(Be.itemId)===String(me.itemId)))h.stopCurrentSong()},';

const PATCH_RULES = [
  // Stable row identity survives production builds without Vue dev metadata.
  ['onDblclick:L,onContextmenu:Oe(he,["prevent"])', 'onDblclick:L,"data-linli-song-id":a.song.id,onContextmenu:Oe(he,["prevent"])'],
  ['loading:Nl}),Bn=', 'loading:Nl}),lmNativeNotify=window.__LINLI_NATIVE_NOTIFY__=(q,me)=>ze({message:String(q),type:me==="error"?"error":"success",duration:3000}),Bn='],
  // One component-owned bridge: catalog data remains native truth and playlist
  // writes must replace the reactive queue, not just persist HTTP rows. Reset
  // the native pager first so an in-flight fetch cannot append stale results.
  [
    '{list:K,fetchList:W,initInfiniteScroll:ue,addItem:re,deleteItem:ye,total:Ee}=Mt(Us,{pageSize:200}),ee=q=>',
    '{list:K,fetchList:W,initInfiniteScroll:ue,addItem:re,deleteItem:ye,total:Ee,handleReset:lmQueueReset}=Mt(Us,{pageSize:200}),lmMusicBridge={getView:()=>({sourceType:Fe.value,songs:Ce.value,viewKey:String(J.value)}),getCatalog:()=>oe.songs.map(q=>({sourceType:2,itemId:String(q.id),song:q,available:f.isDownloaded(q.id)})),switchView:async q=>{if(q==="我的上传"){await M(so);return}const me=D.value.find(Be=>Be.displayName===q||String(Be.type)===q);if(!me)throw new Error("曲库分类不存在");await M(me.type)},replaceQueue:async q=>{if(window.__LINLI_MUSIC_BRIDGE__!==lmMusicBridge)throw new Error("曲库页面已关闭");lmQueueReset();K.value=q;Ee.value=q.length;await qe();await Po()}},lmMusicLifecycle=(He(()=>{window.__LINLI_MUSIC_BRIDGE__=lmMusicBridge;window.dispatchEvent(new Event("linli-music-view-ready"))}),jt(()=>{if(window.__LINLI_MUSIC_BRIDGE__===lmMusicBridge)delete window.__LINLI_MUSIC_BRIDGE__})),ee=q=>'
  ],
  // Restore the existing user-song component with a local catalog. Offline
  // catalog selection must prioritize this tab even when no PGC is downloaded.
  [
    'async function dm(e,t){return Te.get("/searchUserSongs",{params:e,...t}).then(s=>({...s.data,list:(s.data.list??[]).map(i=>{const l=i;return{...l,id:l.userSongId}})}))}',
    'async function dm(e,t){return window.__LOCAL_MUSIC_API__.searchUserSongs(e,t)}'
  ],
  ['o(w)?Y("",!0):(r(),F(on,{key:0,index:so,class:"h-fit"}', '!1?Y("",!0):(r(),F(on,{key:0,index:so,class:"h-fit"}'],
  ['!o(w)||o(D).length>0?(r(),_("section",H3,', '!0?(r(),_("section",H3,'],
  [
    'Ce=j(()=>w.value?oe.getSongsByStyle(R.value).filter(q=>f.isDownloaded(q.id)):Q.value?te.value:N.value)',
    'Ce=j(()=>Q.value?te.value:w.value?oe.getSongsByStyle(R.value).filter(q=>f.isDownloaded(q.id)):N.value)'
  ],
  [
    'q.filter(Be=>!f.isDownloaded(Be.id)&&!f.isDownloading(Be.id)).forEach(Be=>f.startDownload(Be))',
    'w.value?q.filter(Be=>Be.localCustomSong&&Be.localAvailable).forEach(Be=>f.downloadMap.set(Be.id,{state:"completed",progress:100})):q.filter(Be=>!w.value&&!f.isDownloaded(Be.id)&&!f.isDownloading(Be.id)).forEach(Be=>f.startDownload(Be))'
  ],
  ['Bo=q=>{f.startDownload(q)}', 'Bo=q=>{w.value||f.startDownload(q)}'],
  ['Ma=async q=>{await cm({userSongId:q.id})', 'Ma=async q=>{if(w.value)return;await cm({userSongId:q.id})'],
  [
    'Lt().setOnJobCompleted(()=>{dt()});',
    'Lt().setOnJobCompleted(dt);He(()=>{window.addEventListener("linli-custom-songs-changed",dt);window.__LOCAL_MUSIC_API__.mountUserSongsTools()}),jt(()=>window.removeEventListener("linli-custom-songs-changed",dt));'
  ],
  ["Te.post(\"/letter/send\"", "window.__LOCAL_MAIL_HTTP__.post(\"/letter/send\""],
  ["Te.get(\"/letter/list\"", "window.__LOCAL_MAIL_HTTP__.get(\"/letter/list\""],
  ["Te.get(\"/letter/detail\"", "window.__LOCAL_MAIL_HTTP__.get(\"/letter/detail\""],
  ["Te.get(\"/letter/unread_count\"", "window.__LOCAL_MAIL_HTTP__.get(\"/letter/unread_count\""],
  ["Te.post(\"/letter/share\"", "window.__LOCAL_MAIL_HTTP__.post(\"/letter/share\""],
  ["Te.post(\"/letter/resend\"", "window.__LOCAL_MAIL_HTTP__.post(\"/letter/resend\""],
  // 官方 .627 使用 hash history；在挂载 Vue 应用前暴露同一个 Router，
  // 让 body 外的本地页签走官方路由而不是与 Vue 的 URL 协调竞争。
  [
    "const t=jo(nf);t.use(Rl()),t.use(Ea),t.mount(\"#app\")",
    "const t=jo(nf);t.use(Rl()),t.use(Ea),window.__LINLI_VUE_ROUTER__=Ea,t.mount(\"#app\")"
  ],
  // .627 客户端在停止在线服务后把写信入口绑定到恒为 false 的 N3。
  // 本地回信服务仍提供完整的 /letter/send 链路，因此永不隐藏原生写信入口。
  [
    "\"hide-write\":o(p)||!o(N3)",
    "\"hide-write\":!1"
  ],
  // 右下角 UID 来自独立 UserInfo 组件，不属于 watermark-overlay。
  // 只隐藏该组件的唯一静态根节点，避免误伤其他 fixed 浮层。
  [
    "const n0={class:\"fixed bottom-0 right-0 z-[60]\"},a0={class:\"px-4 py-2 text-text-secondary text-body-s\"},l0={key:0},i0=le({name:\"UserInfo\"",
    "const n0={class:\"fixed bottom-0 right-0 z-[60]\",style:{display:\"none\"}},a0={class:\"px-4 py-2 text-text-secondary text-body-s\"},l0={key:0},i0=le({name:\"UserInfo\""
  ],
  // 水印由独立 renderer 中的组件定义生成，CSS 隐藏无法覆盖组件重建。
  // 在定义层保留同名组件但返回空节点，所有加载该 bundle 的 renderer 都一致禁用。
  [
    "const S1=le({__name:\"WatermarkOverlay\",props:{uid:{}},setup(e){const t=e,s=j(()=>{if(!t.uid)return\"none\";const i=document.createElement(\"canvas\"),l=i.getContext(\"2d\"),a=t.uid,c=14,m=200;l.font=`${c}px sans-serif`;const d=l.measureText(a).width+m,h=c+m;i.width=d*2,i.height=h*2,l.font=`${c}px sans-serif`,l.fillStyle=\"rgba(255, 255, 255, 0.05)\",l.translate(i.width/2,i.height/2),l.rotate(-30*Math.PI/180),l.translate(-i.width/2,-i.height/2);for(let f=-h;f<i.height+h;f+=h)for(let y=-d;y<i.width+d;y+=d)l.fillText(a,y,f);return`url(${i.toDataURL()})`});return(i,l)=>(r(),_(\"div\",{class:\"watermark-overlay\",style:Ae({backgroundImage:o(s)})},null,4))}});",
    "const S1=le({__name:\"WatermarkOverlay\",props:{uid:{}},setup(){return()=>null}});"
  ],
  [
    "const m=()=>{e.isOfflineMode&&(l.value.mailWidget!==!1&&(l.value.mailWidget=!1),l.value.musicWidget!==!1&&(l.value.musicWidget=!1))};",
    "const m=()=>{e.isOfflineMode&&!(window.__LINLI_LOCAL_CAPABILITIES__&&window.__LINLI_LOCAL_CAPABILITIES__.widgets)&&(l.value.mailWidget!==!1&&(l.value.mailWidget=!1),l.value.musicWidget!==!1&&(l.value.musicWidget=!1))};"
  ],
  [
    "l.value={...l.value,...p}};let c={...l.value};",
    "l.value={...l.value,...p};if(e.isOfflineMode&&window.__LINLI_LOCAL_CAPABILITIES__&&window.__LINLI_LOCAL_CAPABILITIES__.widgets&&window.localStorage&&window.localStorage.getItem(\"linli-local-offline-widgets-v1\")!==\"1\"){l.value.mailWidget=!0,l.value.musicWidget=!0,Fm({mailWidget:!0,musicWidget:!0}),window.localStorage.setItem(\"linli-local-offline-widgets-v1\",\"1\")}};let c={...l.value};"
  ],
  [
    "$e=[\"feedback\",\"help-agreement\"],X=[\"mail-widget\",\"music-widget\"],",
    "$e=[\"feedback\",\"help-agreement\"],X=window.__LINLI_LOCAL_CAPABILITIES__&&window.__LINLI_LOCAL_CAPABILITIES__.widgets?[]:[\"mail-widget\",\"music-widget\"],"
  ],
  [
    "He(()=>{p.value||d.fetchMailList(!0)})",
    "He(()=>{(!p.value||window.__LINLI_LOCAL_CAPABILITIES__.mail)&&d.fetchMailList(!0)})"
  ],
  [
    "s.isOfflineMode||(s.appMode===Se.PRO?Lt().proRestoreFromApi():s.appMode===Se.LITE&&(Lt().liteStartPoll(),uo().startPolling()))",
    "(s.isOfflineMode?s.appMode===Se.LITE&&uo().startPolling():s.appMode===Se.PRO?Lt().proRestoreFromApi():s.appMode===Se.LITE&&(Lt().liteStartPoll(),uo().startPolling()))"
  ],
  [
    "async function An(e,t){return Te.post(\"/addToPlaylist\",{itemType:e.itemType,itemId:e.itemId},t).then(s=>{const i=s.data;return{...i,itemId:i.itemId,performanceId:i.performanceId??\"\",songId:i.songId??\"\",id:i.itemId}})}",
    "async function An(e,t){return window.__LOCAL_MUSIC_API__.addToPlaylist(e,t)}"
  ],
  [
    "async function Nn(e,t){return Te.post(\"/delFromPlaylist\",{itemType:e.itemType,itemId:e.itemId},t)}",
    "async function Nn(e,t){return window.__LOCAL_MUSIC_API__.removeFromPlaylist(e,t)}"
  ],
  [
    "async function Us(e,t){return Te.get(\"/searchPlaylist\",{params:e,...t}).then(s=>({...s.data,list:s.data.list.map(i=>({...i,itemId:i.itemId,performanceId:i.performanceId??\"\",songId:i.songId??\"\",id:i.itemId}))}))}",
    "async function Us(e,t){return window.__LOCAL_MUSIC_API__.searchPlaylist(e,t)}"
  ],
  [
    "Pa=async(q,me)=>{const Be=await An({itemType:me,itemId:q.id});",
    "Pa=async(q,me)=>{const Be=await An({itemType:me,itemId:q.id,song:q});"
  ],
  [
    "He(async()=>{if(w.value){a.value=!1;return}await Ua(),await W().finally(()=>{a.value=!1}),Po()});",
    "He(async()=>{if(w.value){await W().finally(()=>{a.value=!1}),Po();return}await Ua(),await W().finally(()=>{a.value=!1}),Po()});"
  ],
  // StudioLite 离线列表只包含 downloadState=completed 的曲目，因此解除这一处
  // hide-actions 会恢复试听区而不会进入 idle/failed/cancelled 的下载按钮分支。
  [
    "F(Qx,{key:at.id,song:at,index:Na,\"type-mode\":\"short\",compact:o(g),\"hide-actions\":o(w),class:\"song-item\"",
    "F(Qx,{key:at.id,song:at,index:Na,\"type-mode\":\"short\",compact:o(g),\"hide-actions\":!1,class:\"song-item\""
  ],
  // 离线时仅渲染本地 addPlaylist；官方 share 仍只在非离线模式出现。
  [
    "$e=[{id:\"share\",icon:\"share\",label:i(\"common_share\"),onClick:R},{id:\"addPlaylist\",icon:\"addplaylist\",label:i(\"common_add_to_playlist\"),onClick:O,disabled:()=>z.value,tooltip:()=>z.value?i(\"common_add_to_playlist_desc\"):\"\"}];",
    "$e=Ie().isOfflineMode?[{id:\"addPlaylist\",icon:\"addplaylist\",label:i(\"common_add_to_playlist\"),onClick:O,disabled:()=>z.value,tooltip:()=>z.value?i(\"common_add_to_playlist_desc\"):\"\"}]:[{id:\"share\",icon:\"share\",label:i(\"common_share\"),onClick:R},{id:\"addPlaylist\",icon:\"addplaylist\",label:i(\"common_add_to_playlist\"),onClick:O,disabled:()=>z.value,tooltip:()=>z.value?i(\"common_add_to_playlist_desc\"):\"\"}];"
  ],
  [
    "o(w)?Y(\"\",!0):(r(),_(se,{key:0},",
    "!1?Y(\"\",!0):(r(),_(se,{key:0},"
  ],
  [
    "o(t)?Y(\"\",!0):(r(),_(\"div\",{key:0,class:\"w-8 h-8 flex items-center justify-center cursor-pointer hover:bg-grey-1 rounded-1\",onClick:g},",
    "!1?Y(\"\",!0):(r(),_(\"div\",{key:0,class:\"w-8 h-8 flex items-center justify-center cursor-pointer hover:bg-grey-1 rounded-1\",onClick:g},"
  ],
  [
    "o(t)?Y(\"\",!0):(r(),_(\"div\",{key:1,class:\"w-8 h-8 flex items-center justify-center cursor-pointer hover:bg-grey-1 rounded-1\",onClick:y},",
    "!1?Y(\"\",!0):(r(),_(\"div\",{key:1,class:\"w-8 h-8 flex items-center justify-center cursor-pointer hover:bg-grey-1 rounded-1\",onClick:y},"
  ],
  [
    "o(t)?Y(\"\",!0):(r(),_(\"div\",{key:2,class:\"w-8 h-8 flex items-center justify-center cursor-pointer hover:bg-grey-1 rounded-1\",onClick:f},",
    "!1?Y(\"\",!0):(r(),_(\"div\",{key:2,class:\"w-8 h-8 flex items-center justify-center cursor-pointer hover:bg-grey-1 rounded-1\",onClick:f},"
  ],
  [
    "o(t)?Y(\"\",!0):(r(),F(A,{key:0,type:\"pip\",class:\"text-body-l text-grey-6 hover:text-grey-8 active:text-grey-9 cursor-pointer\",onClick:o(s).handleOpenWidget},",
    "!1?Y(\"\",!0):(r(),F(A,{key:0,type:\"pip\",class:\"text-body-l text-grey-6 hover:text-grey-8 active:text-grey-9 cursor-pointer\",onClick:o(s).handleOpenWidget},"
  ],
  ["J=async()=>{Q(),await C(),await H(),L=setInterval(H,U)}", "J=async()=>{if(Ie().isOfflineMode)return;Q(),await C(),await H(),L=setInterval(H,U)}"]
];

// Keep the exact previous bridge for upgrades from installed 0.11.5 archives.
const musicBridgeRule = PATCH_RULES.find(([before]) => before.startsWith('{list:K,fetchList:W'));
const previousMusicBridgeAfter = musicBridgeRule[1];
musicBridgeRule[1] = previousMusicBridgeAfter.replace('lmMusicBridge={', 'lmMusicBridge={' + MUSIC_BRIDGE_EXTRAS);

// .627 webplayer.dat 的 WatermarkOverlay 会把 query uid 绘制到全屏 canvas。
// 组件定义是归档内唯一稳定锚点；保留 props 形状但让 setup 返回空渲染函数，
// 这样不会依赖 CSS，也不会误伤 webplayer 的其他浮层。该规则必须独立于
// feapp 的 PATCH_RULES，因为两个归档使用不同的主脚本与变量作用域。
const WEBPLAYER_PATCH_RULES = [
  [
    "const De=U({__name:\"WatermarkOverlay\",props:{uid:{}},setup(o){const n=o,s=D(()=>{if(!n.uid)return\"none\";const r=document.createElement(\"canvas\"),a=r.getContext(\"2d\"),l=n.uid,i=14,v=200;a.font=`${i}px sans-serif`;const f=a.measureText(l).width+v,y=i+v;r.width=f*2,r.height=y*2,a.font=`${i}px sans-serif`,a.fillStyle=\"rgba(255, 255, 255, 0.05)\",a.translate(r.width/2,r.height/2),a.rotate(-30*Math.PI/180),a.translate(-r.width/2,-r.height/2);for(let u=-y;u<r.height+y;u+=y)for(let h=-f;h<r.width+f;h+=f)a.fillText(l,h,u);return`url(${r.toDataURL()})`});return(r,a)=>(k(),I(\"div\",{class:\"watermark-overlay\",style:he({backgroundImage:S(s)})},null,4))}});",
    "const De=U({__name:\"WatermarkOverlay\",props:{uid:{}},setup(){return()=>null}});"
  ]
];

// 兼容上一版已经安装过的补丁：旧补丁注入了假本地音乐 API、强行显示 MIDI
// 上传入口并在离线点击时弹出警告。这些规则已从当前补丁集合退休，但逆向旧
// 产物时必须剥离它们；当前新增规则若仍是官方基线形态则保持不动。
const RETIRED_PATCH_RULES = [
  [
    "async function Us(e,t){return Te.get(\"/searchPlaylist\",{params:e,...t}).then(s=>({...s.data,list:s.data.list.map(i=>({...i,itemId:i.itemId,performanceId:i.performanceId??\"\",songId:i.songId??\"\",id:i.itemId}))}))}async function Xp",
    "async function Us(e,t){return Te.get(\"/searchPlaylist\",{params:e,...t}).then(s=>({...s.data,list:s.data.list.map(i=>({...i,itemId:i.itemId,performanceId:i.performanceId??\"\",songId:i.songId??\"\",id:i.itemId}))}))}window.__LOCAL_MUSIC_API__=Object.freeze({addToPlaylist:An,removeFromPlaylist:Nn,searchPlaylist:Us});async function Xp"
  ],
  ["!o(w)&&o(Ss)?(r(),F(Be,", "!0?(r(),F(Be,"],
  ["w=()=>{l.value=!0}", "w=()=>{Ie().isOfflineMode?ze.warning(\"离线版尚未接入 MIDI 定制演奏服务\"):l.value=!0}"]
];

// 兼容更早版本只登记过的 hide-write 变体。
const LEGACY_PATCH_AFTERS = new Map([
  [musicBridgeRule[0], [previousMusicBridgeAfter]],
  ["\"hide-write\":o(p)||!o(N3)", ["\"hide-write\":o(p)"]]
]);

function sha256Sync(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("ZIP end-of-central-directory record was not found");
}

function readArchive(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const disk = buffer.readUInt16LE(eocdOffset + 4);
  const centralDisk = buffer.readUInt16LE(eocdOffset + 6);
  const count = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (disk !== 0 || centralDisk !== 0 || count === 0xffff || centralOffset === 0xffffffff) {
    throw new Error("Multi-disk and ZIP64 archives are not supported");
  }
  if (centralOffset + centralSize > eocdOffset) throw new Error("ZIP central directory is out of bounds");

  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error(`Bad central entry signature at ${cursor}`);
    const versionMade = buffer.readUInt16LE(cursor + 4);
    const versionNeeded = buffer.readUInt16LE(cursor + 6);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const dosTime = buffer.readUInt16LE(cursor + 12);
    const dosDate = buffer.readUInt16LE(cursor + 14);
    const expectedCrc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const nameBuffer = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameBuffer.toString(flags & 0x0800 ? "utf8" : "latin1");
    if (flags & 0x0001) throw new Error(`Encrypted ZIP entry is unsupported: ${name}`);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Bad local entry signature: ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = zlib.inflateRawSync(compressed);
    else throw new Error(`Unsupported compression method ${method}: ${name}`);
    if (data.length !== size) throw new Error(`Uncompressed size mismatch: ${name}`);
    if ((zlib.crc32(data) >>> 0) !== expectedCrc) throw new Error(`CRC mismatch: ${name}`);
    entries.push({ name, data, versionMade, versionNeeded, flags, method, dosTime, dosDate, externalAttributes });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== centralOffset + centralSize) throw new Error("ZIP central directory size mismatch");
  return entries;
}

function writeArchive(entries) {
  if (entries.length > 0xffff) throw new Error("Too many ZIP entries");
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const method = entry.method === 0 ? 0 : 8;
    const compressed = method === 0 ? data : zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data) >>> 0;
    const flags = ((entry.flags || 0) | 0x0800) & ~0x0008;
    const dosTime = entry.dosTime || 0;
    const dosDate = entry.dosDate || 0x0021;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(Math.max(20, entry.versionNeeded || 20), 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    localChunks.push(local, nameBuffer, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.versionMade || 20, 4);
    central.writeUInt16LE(Math.max(20, entry.versionNeeded || 20), 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(entry.externalAttributes || 0, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, nameBuffer);

    offset += local.length + nameBuffer.length + compressed.length;
  }

  const central = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localChunks, central, eocd]);
}

function exactReplace(text, before, after) {
  const parts = text.split(before);
  if (parts.length !== 2) throw new Error(`Expected exactly one frontend patch point: ${before}`);
  return parts.join(after);
}

function countOccurrences(text, needle) {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = text.indexOf(needle, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + Math.max(needle.length, 1);
  }
}

function patchEntries(baselineEntries, localScript) {
  const entries = baselineEntries.map((entry) => ({ ...entry, data: Buffer.from(entry.data) }));
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const index = byName.get(INDEX_ENTRY);
  const main = byName.get(MAIN_ENTRY);
  if (!index || !main) throw new Error("Expected .627 frontend entries were not found");

  const marker = '<script type="module" crossorigin src="./assets/main-31595bd3.js"></script>';
  let indexText = index.data.toString("utf8");
  if (!indexText.includes('./assets/local-mail-poc.js')) {
    indexText = exactReplace(indexText, marker, `<script src="./assets/local-mail-poc.js"></script>\n  ${marker}`);
  }
  index.data = Buffer.from(indexText, "utf8");

  let mainText = main.data.toString("utf8");
  for (const [before, after] of PATCH_RULES) mainText = exactReplace(mainText, before, after);
  main.data = Buffer.from(mainText, "utf8");

  entries.push({
    name: LOCAL_SCRIPT_ENTRY,
    data: Buffer.from(localScript),
    versionMade: 20,
    versionNeeded: 20,
    flags: 0x0800,
    method: 8,
    dosTime: 0,
    dosDate: 0x0021,
    externalAttributes: 0
  });
  return entries;
}

function patchWebplayerEntries(baselineEntries) {
  const entries = baselineEntries.map((entry) => ({ ...entry, data: Buffer.from(entry.data) }));
  const byName = entryMap(entries);
  const main = byName.get(WEBPLAYER_MAIN_ENTRY);
  if (!main) throw new Error("Expected .627 webplayer frontend entry was not found");

  let mainText = main.data.toString("utf8");
  for (const [before, after] of WEBPLAYER_PATCH_RULES) {
    if (countOccurrences(mainText, before) !== 1 || countOccurrences(mainText, after) !== 0) {
      throw new Error(`Webplayer baseline rule is missing or non-unique: ${before}`);
    }
    mainText = exactReplace(mainText, before, after);
  }
  main.data = Buffer.from(mainText, "utf8");
  return entries;
}

function entryMap(entries) {
  return new Map(entries.map((entry) => [entry.name, entry]));
}

// patchEntries 的逆操作：从一份"本项目补丁产物"中剥离注入脚本并反向应用补丁规则，
// 重建它当初构建自的基线。补丁是完全确定性的（无时间戳、无随机量），因此逆向结果
// 与原始基线逐字节一致。任何一步不符合预期都抛错，让调用方拒绝该来源。
function unpatchEntries(patchedEntries) {
  const entries = patchedEntries.map((entry) => ({ ...entry, data: Buffer.from(entry.data) }));
  const byName = entryMap(entries);
  if (byName.has(LOCAL_SCRIPT_ENTRY)) {
    const injected = byName.get(LOCAL_SCRIPT_ENTRY);
    entries.splice(entries.indexOf(injected), 1);
  } else {
    throw new Error("Archive does not look like a local-mail patched archive: local-mail-poc.js entry missing");
  }

  const index = byName.get(INDEX_ENTRY);
  const main = byName.get(MAIN_ENTRY);
  if (!index || !main) throw new Error("Expected .627 frontend entries were not found");

  const marker = '<script type="module" crossorigin src="./assets/main-31595bd3.js"></script>';
  const injection = `<script src="./assets/local-mail-poc.js"></script>\n  ${marker}`;
  let indexText = index.data.toString("utf8");
  indexText = exactReplace(indexText, injection, marker);
  if (indexText.includes("./assets/local-mail-poc.js")) {
    throw new Error("index.html still references local-mail-poc.js after unpatching");
  }
  index.data = Buffer.from(indexText, "utf8");

  let mainText = main.data.toString("utf8");
  for (const [before, after] of PATCH_RULES) {
    const afterCount = countOccurrences(mainText, after);
    if (afterCount === 1) {
      mainText = exactReplace(mainText, after, before);
      continue;
    }
    if (afterCount > 1) throw new Error(`Expected at most one patched frontend rule: ${after}`);
    const baselineCount = countOccurrences(mainText, before);
    if (baselineCount === 1) continue;
    if (baselineCount > 1) throw new Error(`Expected at most one baseline frontend rule: ${before}`);
    const legacyAfter = (LEGACY_PATCH_AFTERS.get(before) || [])
      .find((candidate) => countOccurrences(mainText, candidate) === 1);
    if (legacyAfter) {
      mainText = exactReplace(mainText, legacyAfter, before);
      continue;
    }
    throw new Error(`Expected patched frontend rule was not found: ${after}`);
  }
  for (const [before, after] of RETIRED_PATCH_RULES) {
    const retiredCount = countOccurrences(mainText, after);
    if (retiredCount === 1) mainText = exactReplace(mainText, after, before);
    else if (retiredCount > 1) throw new Error(`Expected at most one retired frontend rule: ${after}`);
  }
  main.data = Buffer.from(mainText, "utf8");
  return entries;
}

function unpatchWebplayerEntries(patchedEntries) {
  const entries = patchedEntries.map((entry) => ({ ...entry, data: Buffer.from(entry.data) }));
  const byName = entryMap(entries);
  const main = byName.get(WEBPLAYER_MAIN_ENTRY);
  if (!main) throw new Error("Expected .627 webplayer frontend entry was not found");

  let mainText = main.data.toString("utf8");
  for (const [before, after] of WEBPLAYER_PATCH_RULES) {
    const afterCount = countOccurrences(mainText, after);
    if (afterCount === 1) {
      const baselineCount = countOccurrences(mainText, before);
      if (baselineCount !== 0) throw new Error(`Webplayer patch contains both baseline and patched rule: ${after}`);
      mainText = exactReplace(mainText, after, before);
      continue;
    }
    if (afterCount > 1) throw new Error(`Expected at most one patched webplayer rule: ${after}`);
    const baselineCount = countOccurrences(mainText, before);
    if (baselineCount === 1) continue;
    if (baselineCount > 1) throw new Error(`Expected at most one baseline webplayer rule: ${before}`);
    throw new Error(`Expected patched webplayer rule was not found: ${after}`);
  }
  main.data = Buffer.from(mainText, "utf8");
  return entries;
}

function verifyPatchedArchive(buffer, baselineBuffer, localScript) {
  const current = readArchive(buffer);
  const baseline = readArchive(baselineBuffer);
  const currentMap = entryMap(current);
  const baselineMap = entryMap(baseline);
  const expectedNames = new Set([...baselineMap.keys(), LOCAL_SCRIPT_ENTRY]);
  const unexpected = [...currentMap.keys()].filter((name) => !expectedNames.has(name));
  const missing = [...expectedNames].filter((name) => !currentMap.has(name));
  if (unexpected.length || missing.length) {
    throw new Error(`Archive entry mismatch; unexpected=${unexpected.join(",")} missing=${missing.join(",")}`);
  }

  const allowedChanged = new Set([INDEX_ENTRY, MAIN_ENTRY]);
  const changed = [];
  for (const [name, baselineEntry] of baselineMap) {
    const currentEntry = currentMap.get(name);
    if (!currentEntry.data.equals(baselineEntry.data)) changed.push(name);
    if (!allowedChanged.has(name) && !currentEntry.data.equals(baselineEntry.data)) {
      throw new Error(`Unrelated frontend entry changed: ${name}`);
    }
  }
  if (!currentMap.get(LOCAL_SCRIPT_ENTRY).data.equals(localScript)) {
    throw new Error("Packed local-mail-poc.js does not match its source file");
  }
  const indexText = currentMap.get(INDEX_ENTRY).data.toString("utf8");
  if ((indexText.match(/assets\/local-mail-poc\.js/g) || []).length !== 1) {
    throw new Error("index.html must load local-mail-poc.js exactly once");
  }
  const mainText = currentMap.get(MAIN_ENTRY).data.toString("utf8");
  for (const [before, after] of PATCH_RULES) {
    if (countOccurrences(mainText, before) !== 0 || countOccurrences(mainText, after) !== 1) {
      throw new Error(`Frontend API wrapper patch is missing or non-unique: ${after}`);
    }
  }
  return {
    entries: current.length,
    baselineEntries: baseline.length,
    changedEntries: changed,
    addedEntries: [LOCAL_SCRIPT_ENTRY]
  };
}

function verifyWebplayerArchive(buffer, baselineBuffer) {
  const current = readArchive(buffer);
  const baseline = readArchive(baselineBuffer);
  const currentMap = entryMap(current);
  const baselineMap = entryMap(baseline);
  const expectedNames = new Set(baselineMap.keys());
  const unexpected = [...currentMap.keys()].filter((name) => !expectedNames.has(name));
  const missing = [...expectedNames].filter((name) => !currentMap.has(name));
  if (unexpected.length || missing.length) {
    throw new Error(`Webplayer archive entry mismatch; unexpected=${unexpected.join(",")} missing=${missing.join(",")}`);
  }

  const allowedChanged = new Set([WEBPLAYER_MAIN_ENTRY]);
  const changed = [];
  for (const [name, baselineEntry] of baselineMap) {
    const currentEntry = currentMap.get(name);
    if (!currentEntry.data.equals(baselineEntry.data)) changed.push(name);
    if (!allowedChanged.has(name) && !currentEntry.data.equals(baselineEntry.data)) {
      throw new Error(`Unrelated webplayer entry changed: ${name}`);
    }
  }
  const mainText = currentMap.get(WEBPLAYER_MAIN_ENTRY)?.data.toString("utf8") || "";
  for (const [before, after] of WEBPLAYER_PATCH_RULES) {
    if (countOccurrences(mainText, before) !== 0 || countOccurrences(mainText, after) !== 1) {
      throw new Error(`Webplayer frontend patch is missing or non-unique: ${after}`);
    }
  }
  return {
    entries: current.length,
    baselineEntries: baseline.length,
    changedEntries: changed,
    addedEntries: []
  };
}

// 当安装目录里的 feapp.dat 不是官方基线（通常已被本补丁打过）且本地没有基线时，
// 从本机已有的文件恢复基线。候选来源按优先级：
//  1. pre-formal-install 备份里哈希等于官方基线的备份；
//  2. 当前安装包本身——本项目的补丁是完全确定性的，逆向剥离（unpatchEntries）
//     可以从任何"本项目补丁产物"逐字节重建基线，因此旧版本安装器打过补丁、
//     且备份已丢失的机器也能恢复。每个候选都必须通过"重打补丁与当前安装包
//     逐字节一致"的验证，无法证明来源的内容一律拒绝。
function restoreBaselineFromBackup(spec, localScript) {
  const candidates = [];
  const directory = path.join(ROOT, "backups", "patch-snapshots", "pre-formal-install");
  try {
    for (const name of fs.readdirSync(directory)) {
      if (name.startsWith(`${spec.name}-`) && name.endsWith(".dat")) candidates.push(path.join(directory, name));
    }
  } catch {
    // 备份目录不存在或不可读；下方还会尝试当前安装包本身
  }
  candidates.push(spec.targetPath);
  for (const candidatePath of candidates) {
    let candidate;
    try {
      candidate = readRegularFile(candidatePath, `${spec.name} candidate`);
    } catch {
      continue;
    }
    const candidateIsBaseline = sha256Sync(candidate) === spec.expectedBaselineSha256;
    try {
      let baselineCandidate;
      if (candidateIsBaseline) {
        baselineCandidate = candidate;
      } else {
        // 只接受"由某个基线 + 某个前端脚本打出的补丁产物"：剥离并验证结构。
        // 注意不要求剥离产物与官方基线逐字节一致——writeArchive 会把 zip 元数据
        //（versionMade、DOS 时间戳、本地头风格）规范化为本项目打包器的形态，与
        // 官方打包器（流式、本地头置零）必然不同；判断依据是内容与可重建性。
        baselineCandidate = writeArchive(unpatchPackage(spec, candidate));
      }
      // 自洽性闸门：剥离出的基线 + 当前前端脚本必须能重打出一份结构合法的补丁包
      //（exactReplace 找不到注入点/条目集合异常都会抛错）。第三方乱改通常无法通过
      // 这一步：改在补丁区域会让 exactReplace 失败；改在条目集合会触发结构不匹配。
      // 注意不能要求"重打结果与当前安装包逐字节一致"：当前安装包可能是旧脚本打的
      //（旧版安装器残留），重打用的是新脚本，注入的 local-mail-poc.js 内容不同。
      const rebuilt = buildPatchedPackage(spec, baselineCandidate, localScript);
      verifyPackage(spec, rebuilt, baselineCandidate, localScript);
      if (sha256Sync(baselineCandidate) !== spec.expectedBaselineSha256) {
        // 逆向产物不等于官方基线（zip 元数据规范化、或旧版补丁还有已废弃的改动）：
        // 不写入 required 基线，仅作为临时基线供本次安装使用。
        return { buffer: baselineCandidate, source: candidatePath, rebuilt: true };
      }
      return { buffer: baselineCandidate, source: candidatePath, rebuilt: false };
    } catch {
      continue;
    }
  }
  return null;
}

function atomicWrite(targetPath, data) {
  const temporary = `${targetPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(temporary, data);
  try {
    fs.renameSync(temporary, targetPath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

const PACKAGE_SPECS = [
  {
    name: "feapp",
    baselinePath: BASELINE_PATH,
    targetPath: TARGET_PATH,
    expectedBaselineSha256: EXPECTED_BASELINE_SHA256
  },
  {
    name: "webplayer",
    baselinePath: WEBPLAYER_BASELINE_PATH,
    targetPath: WEBPLAYER_TARGET_PATH,
    expectedBaselineSha256: EXPECTED_WEBPLAYER_BASELINE_SHA256
  }
];

function packageSpecs(selection = "all") {
  if (!selection || selection === "all") return PACKAGE_SPECS;
  const spec = PACKAGE_SPECS.find((candidate) => candidate.name === selection);
  if (!spec) throw new Error(`Unknown frontend package: ${selection}`);
  return [spec];
}

function argumentValue(name) {
  const exact = `--${name}`;
  const inlinePrefix = `${exact}=`;
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument.startsWith(inlinePrefix)) return argument.slice(inlinePrefix.length);
    if (argument === exact) {
      const value = process.argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${exact}`);
      return value;
    }
  }
  return null;
}

function readRegularFile(filePath, description) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new Error(`${description} cannot be read: ${filePath} (${error.message})`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${description} is not a regular file: ${filePath}`);
  return fs.readFileSync(filePath);
}

function verifyPackage(spec, currentBuffer, baselineBuffer, localScript) {
  const archiveVerification = spec.name === "feapp"
    ? verifyPatchedArchive(currentBuffer, baselineBuffer, localScript)
    : verifyWebplayerArchive(currentBuffer, baselineBuffer);
  return {
    ...archiveVerification,
    baselineSha256: sha256Sync(baselineBuffer),
    installedSha256: sha256Sync(currentBuffer),
    ...(spec.name === "feapp" ? { sourceScriptSha256: sha256Sync(localScript) } : {})
  };
}

function buildPatchedPackage(spec, baselineBuffer, localScript) {
  const entries = spec.name === "feapp"
    ? patchEntries(readArchive(baselineBuffer), localScript)
    : patchWebplayerEntries(readArchive(baselineBuffer));
  return writeArchive(entries);
}

function unpatchPackage(spec, candidateBuffer) {
  return spec.name === "feapp"
    ? unpatchEntries(readArchive(candidateBuffer))
    : unpatchWebplayerEntries(readArchive(candidateBuffer));
}

function backupCurrentTarget(targetBuffer, packageName = "feapp") {
  const digest = sha256Sync(targetBuffer);
  const directory = path.join(ROOT, "backups", "patch-snapshots", "pre-formal-install");
  const backupPath = path.join(directory, `${packageName}-${digest.slice(0, 16)}.dat`);
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(backupPath)) fs.writeFileSync(backupPath, targetBuffer);
  return backupPath;
}

function existingBaseline(spec) {
  try {
    const buffer = readRegularFile(spec.baselinePath, `${spec.name} compatible baseline`);
    return sha256Sync(buffer) === spec.expectedBaselineSha256 ? buffer : null;
  } catch {
    return null;
  }
}

function planBaselineImport(spec, localScript) {
  const sourceBuffer = readRegularFile(spec.targetPath, `${spec.name} target archive`);
  const sourceHash = sha256Sync(sourceBuffer);
  if (sourceHash === spec.expectedBaselineSha256) {
    if (existingBaseline(spec)) {
      return {
        buffer: sourceBuffer,
        writes: [],
        result: { imported: false, reason: "baseline already present", sha256: sourceHash }
      };
    }
    return {
      buffer: sourceBuffer,
      writes: [{ target: spec.baselinePath, data: sourceBuffer, label: `${spec.name} compatible baseline` }],
      result: {
        imported: true,
        sha256: sourceHash,
        baselinePath: path.relative(GAME_ROOT, spec.baselinePath)
      }
    };
  }

  const restored = restoreBaselineFromBackup(spec, localScript);
  if (!restored) {
    throw new Error(
      `Official ${spec.name}.dat hash mismatch: ${sourceHash}. Expected the untouched .627 baseline `
      + `(${spec.expectedBaselineSha256}), a locally patched archive with its pre-install backup, `
      + `or a ${spec.name} archive whose baseline can be rebuilt.`
    );
  }
  if (!restored.rebuilt && existingBaseline(spec)) {
    return {
      buffer: restored.buffer,
      writes: [],
      result: {
        imported: true,
        sha256: spec.expectedBaselineSha256,
        baselinePath: path.relative(GAME_ROOT, spec.baselinePath),
        source: "restored-from-pre-install-backup",
        backupPath: path.relative(GAME_ROOT, restored.source)
      }
    };
  }
  const outputPath = restored.rebuilt
    ? path.join(ROOT, "logs", `baseline-rebuilt-${spec.name}-${process.pid}.dat`)
    : spec.baselinePath;
  return {
    buffer: restored.buffer,
    writes: [{ target: outputPath, data: restored.buffer, label: `${spec.name} rebuilt baseline` }],
    result: {
      imported: true,
      sha256: sha256Sync(restored.buffer),
      baselinePath: path.relative(GAME_ROOT, outputPath),
      ...(restored.rebuilt
        ? { source: "rebuilt-by-unpatching", sourceArchive: path.relative(GAME_ROOT, restored.source) }
        : { source: "restored-from-pre-install-backup", backupPath: path.relative(GAME_ROOT, restored.source) })
    }
  };
}

function captureFile(filePath, description) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return { existed: false, data: null };
    throw new Error(`${description} cannot be read: ${filePath} (${error.message})`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${description} is not a regular file: ${filePath}`);
  return { existed: true, data: fs.readFileSync(filePath) };
}

function removeFileIfExists(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`not a regular file: ${filePath}`);
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

function restoreCapturedFile(filePath, snapshot) {
  if (snapshot.existed) atomicWrite(filePath, snapshot.data);
  else removeFileIfExists(filePath);
}

// 先在各自目录准备并校验临时文件，再按顺序替换目标。替换中途若失败，
// 所有目标都会用提交前快照恢复；调用方不会把一个包留在新状态而另一个包留在旧状态。
function atomicWriteBatch(items) {
  const seen = new Set();
  const operations = items.map((item) => {
    const target = path.resolve(item.target);
    const key = target.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate atomic target: ${target}`);
    seen.add(key);
    return {
      ...item,
      target,
      original: captureFile(target, item.label || "atomic target"),
      temporary: `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
      committed: false
    };
  });
  const rollbackFailures = [];
  try {
    for (const operation of operations) {
      fs.mkdirSync(path.dirname(operation.target), { recursive: true });
      fs.writeFileSync(operation.temporary, operation.data);
      const staged = readRegularFile(operation.temporary, `${operation.label || "atomic"} temporary file`);
      if (!staged.equals(Buffer.from(operation.data))) throw new Error(`staged file verification failed: ${operation.target}`);
    }
    for (const operation of operations) {
      const current = captureFile(operation.target, operation.label || "atomic target");
      if (current.existed !== operation.original.existed
          || (current.existed && !current.data.equals(operation.original.data))) {
        throw new Error(`target changed during atomic preparation: ${operation.target}`);
      }
    }
    for (const operation of operations) {
      fs.renameSync(operation.temporary, operation.target);
      operation.committed = true;
    }
  } catch (error) {
    if (operations.some((operation) => operation.committed)) {
      for (const operation of [...operations].reverse()) {
        try {
          const current = captureFile(operation.target, operation.label || "atomic target");
          const matchesOriginal = current.existed === operation.original.existed
            && (!current.existed || current.data.equals(operation.original.data));
          if (matchesOriginal) continue;
          const matchesStaged = current.existed && current.data.equals(Buffer.from(operation.data));
          if (!matchesStaged) throw new Error("target changed during atomic rollback");
          restoreCapturedFile(operation.target, operation.original);
        } catch (rollbackError) { rollbackFailures.push(`${operation.target}: ${rollbackError.message}`); }
      }
    }
    if (rollbackFailures.length) {
      throw new Error(`${error.message}; atomic rollback failed: ${rollbackFailures.join("; ")}`);
    }
    throw error;
  } finally {
    for (const operation of operations) {
      try { removeFileIfExists(operation.temporary); } catch {}
    }
  }
}

function writeLog(command, result) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.writeFileSync(LOG_PATH, `${JSON.stringify({ command, at: new Date().toISOString(), ...result }, null, 2)}\n`, "utf8");
}

async function main() {
  const command = process.argv[2] || "verify";
  const selection = argumentValue("package") || "all";
  const localScript = readRegularFile(FRONTEND_SCRIPT_PATH, "local-mail-poc.js");

  if (command === "import-baseline") {
    if (selection !== "all") throw new Error("import-baseline requires both frontend packages");
    const plans = PACKAGE_SPECS.map((spec) => planBaselineImport(spec, localScript));
    const writes = plans.flatMap((plan) => plan.writes);
    atomicWriteBatch(writes);
    const result = { ...plans[0].result, webplayer: plans[1].result };
    writeLog(command, result);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const specs = packageSpecs(selection);
  const baselineOverride = argumentValue("baseline");
  const webplayerBaselineOverride = argumentValue("webplayer-baseline");
  if (baselineOverride && !specs.some((spec) => spec.name === "feapp")) {
    throw new Error("--baseline can only be used with the feapp package");
  }
  if (webplayerBaselineOverride && !specs.some((spec) => spec.name === "webplayer")) {
    throw new Error("--webplayer-baseline can only be used with the webplayer package");
  }
  const overrides = new Map([
    ["feapp", baselineOverride],
    ["webplayer", webplayerBaselineOverride]
  ]);
  const baselines = new Map();
  for (const spec of specs) {
    const baselinePath = overrides.get(spec.name) || spec.baselinePath;
    const baselineBuffer = readRegularFile(baselinePath, `${spec.name} compatible baseline`);
    const baselineHash = sha256Sync(baselineBuffer);
    if (baselineHash !== spec.expectedBaselineSha256 && !overrides.get(spec.name)) {
      throw new Error(`${spec.name} compatible baseline hash mismatch: ${baselineHash}`);
    }
    baselines.set(spec.name, { buffer: baselineBuffer, hash: baselineHash, path: baselinePath });
  }

  if (command === "install") {
    const before = new Map(specs.map((spec) => [spec.name, readRegularFile(spec.targetPath, `${spec.name} target archive`)]));
    const patched = new Map();
    for (const spec of specs) {
      const baseline = baselines.get(spec.name);
      const patchedBuffer = buildPatchedPackage(spec, baseline.buffer, localScript);
      verifyPackage(spec, patchedBuffer, baseline.buffer, localScript);
      patched.set(spec.name, patchedBuffer);
    }
    const backups = new Map();
    for (const spec of specs) backups.set(spec.name, backupCurrentTarget(before.get(spec.name), spec.name));
    try {
      atomicWriteBatch(specs.map((spec) => ({
        target: spec.targetPath,
        data: patched.get(spec.name),
        label: `${spec.name} target archive`
      })));
      for (const spec of specs) {
        const actual = readRegularFile(spec.targetPath, `${spec.name} target archive`);
        verifyPackage(spec, actual, baselines.get(spec.name).buffer, localScript);
      }
    } catch (error) {
      try {
        atomicWriteBatch(specs.map((spec) => ({
          target: spec.targetPath,
          data: before.get(spec.name),
          label: `${spec.name} target rollback`
        })));
      } catch (rollbackError) {
        throw new Error(`${error.message}; package rollback failed: ${rollbackError.message}`);
      }
      throw error;
    }
    const results = specs.map((spec) => {
      const baseline = baselines.get(spec.name);
      const verification = verifyPackage(spec, patched.get(spec.name), baseline.buffer, localScript);
      return {
        ...verification,
        backupPath: path.relative(GAME_ROOT, backups.get(spec.name)),
        ...(overrides.get(spec.name) ? { baselineOverride: path.relative(GAME_ROOT, baseline.path) } : {})
      };
    });
    const result = specs.length === 2 ? { ...results[0], webplayer: results[1] } : results[0];
    writeLog(command, result);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "verify") {
    const results = specs.map((spec) => {
      const target = readRegularFile(spec.targetPath, `${spec.name} target archive`);
      return verifyPackage(spec, target, baselines.get(spec.name).buffer, localScript);
    });
    const result = specs.length === 2 ? { ...results[0], webplayer: results[1] } : results[0];
    writeLog(command, result);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "restore") {
    const before = new Map(specs.map((spec) => [spec.name, readRegularFile(spec.targetPath, `${spec.name} target archive`)]));
    for (const spec of specs) {
      const baseline = baselines.get(spec.name);
      verifyPackage(spec, buildPatchedPackage(spec, baseline.buffer, localScript), baseline.buffer, localScript);
    }
    const backups = new Map();
    for (const spec of specs) backups.set(spec.name, backupCurrentTarget(before.get(spec.name), spec.name));
    try {
      atomicWriteBatch(specs.map((spec) => ({
        target: spec.targetPath,
        data: baselines.get(spec.name).buffer,
        label: `${spec.name} target restore`
      })));
      for (const spec of specs) {
        const actual = readRegularFile(spec.targetPath, `${spec.name} target archive`);
        if (sha256Sync(actual) !== baselines.get(spec.name).hash) {
          throw new Error(`${spec.name} restored archive did not match the compatible baseline`);
        }
      }
    } catch (error) {
      try {
        atomicWriteBatch(specs.map((spec) => ({
          target: spec.targetPath,
          data: before.get(spec.name),
          label: `${spec.name} target rollback`
        })));
      } catch (rollbackError) {
        throw new Error(`${error.message}; package rollback failed: ${rollbackError.message}`);
      }
      throw error;
    }
    const results = specs.map((spec) => ({
      restoredSha256: baselines.get(spec.name).hash,
      backupPath: path.relative(GAME_ROOT, backups.get(spec.name))
    }));
    const result = specs.length === 2 ? { ...results[0], webplayer: results[1] } : results[0];
    writeLog(command, result);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error("Usage: node tools/feapp.mjs <import-baseline|install|verify|restore> [--package feapp|webplayer] [--baseline <path>] [--webplayer-baseline <path>]");
}

export {
  BASELINE_PATH,
  EXPECTED_BASELINE_SHA256,
  EXPECTED_WEBPLAYER_BASELINE_SHA256,
  LEGACY_PATCH_AFTERS,
  PATCH_RULES,
  RETIRED_PATCH_RULES,
  TARGET_PATH,
  WEBPLAYER_BASELINE_PATH,
  WEBPLAYER_MAIN_ENTRY,
  WEBPLAYER_PATCH_RULES,
  WEBPLAYER_TARGET_PATH,
  atomicWriteBatch,
  countOccurrences,
  exactReplace,
  patchEntries,
  patchWebplayerEntries,
  readArchive,
  sha256Sync,
  unpatchEntries,
  unpatchWebplayerEntries,
  verifyPatchedArchive,
  verifyWebplayerArchive,
  writeArchive
};

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
