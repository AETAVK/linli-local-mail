import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const MAPPING_MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const PERIODS = ["TOD12", "TOD1730", "TOD20"];
const fail = (message) => Object.assign(new Error(message), { status: 400 });
export const mappingKey = (fileName) => fileName.toLowerCase();

// Paths are portable, relative to the selected studiovideo directory. Never use
// imported paths to open arbitrary local files or fetch remote resources.
export function validateMappingDocument(document) {
  if (!document || document.schemaVersion !== 1 || !Array.isArray(document.entries)
    || document.entries.length > MAX_ENTRIES) throw fail("映射 JSON 格式无效：需要 schemaVersion: 1 和 entries 数组（最多 10000 项）");
  if (Buffer.byteLength(JSON.stringify(document), "utf8") > MAPPING_MAX_BYTES) throw fail("映射 JSON 不能超过 8 MiB");
  return document.entries.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.fileName !== "string"
      || entry.fileName.length > 255 || /[\\/:\0]/.test(entry.fileName) || !/\.mp4$/i.test(entry.fileName)) throw fail("映射中包含无效的视频文件名");
    const filePath = typeof entry.filePath === "string" ? entry.filePath.replaceAll("\\", "/") : "";
    if (filePath && (!/^midi_[0-9]+_[0-9]+\/[^/]+$/i.test(filePath)
      || mappingKey(filePath.split("/")[1]) !== mappingKey(entry.fileName))) throw fail("文件路径必须是 midi_数字_数字/文件名.mp4，且与文件名一致");
    const name = entry.name == null ? "" : entry.name;
    if (typeof name !== "string" || name.length > 240 || /[\0\r\n]/.test(name)) throw fail("歌曲名应为不超过 240 个字符的单行文字");
    const tod = entry.tod ?? null;
    if (tod !== null && !PERIODS.includes(tod)) throw fail("时段仅支持 TOD12、TOD1730、TOD20 或 null");
    if (entry.manualUnknown !== undefined && typeof entry.manualUnknown !== "boolean") throw fail("manualUnknown 必须是布尔值");
    if (entry.manualUnknown === true && tod !== null) throw fail("手动未知时段的 tod 必须为 null");
    if (entry.view != null && !["NI", "WI"].includes(entry.view)) throw fail("视频视角无效");
    return { fileName: entry.fileName, filePath, name: name.trim(), tod, view: entry.view ?? null,
      ...(entry.manualUnknown === true ? { manualUnknown: true } : {}) };
  });
}

export class CustomSongMappings {
  constructor(filePath) { this.filePath = filePath; }

  read() {
    try {
      if (fs.statSync(this.filePath).size > MAPPING_MAX_BYTES) throw fail("本地映射表不能超过 8 MiB");
      const document = JSON.parse(fs.readFileSync(this.filePath, "utf8").replace(/^\uFEFF/, ""));
      const entries = validateMappingDocument(document);
      // Only locally persisted evidence is retained. Import strips this field.
      return entries.map((entry, index) => ({ ...entry, ...(document.entries[index].automatic
        ? { automatic: document.entries[index].automatic } : {}) }));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw fail(`无法读取歌曲映射表，请先备份并修复 JSON：${error.message}`);
    }
  }

  write(entries) {
    const document = { schemaVersion: 1, entries };
    validateMappingDocument(document);
    const serialized = JSON.stringify(document, null, 2) + "\n";
    if (Buffer.byteLength(serialized, "utf8") > MAPPING_MAX_BYTES) throw fail("本地映射表不能超过 8 MiB");
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = path.join(directory, `.${path.basename(this.filePath)}.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, serialized, { flag: "wx" });
      fs.renameSync(temporary, this.filePath);
    } finally { fs.rmSync(temporary, { force: true }); }
  }

  export() { return { schemaVersion: 1, entries: validateMappingDocument({ schemaVersion: 1, entries: this.read() }) }; }

  mergeImport(document) {
    const incoming = validateMappingDocument(document);
    const entries = new Map(this.read().map((entry) => [mappingKey(entry.fileName), entry]));
    const imported = new Map(incoming.map((entry) => [mappingKey(entry.fileName), entry]));
    const songNames = new Map();
    for (const entry of imported.values()) {
      if (!entry.filePath || !entry.name) continue;
      const songKey = entry.filePath.split("/")[0].toLowerCase();
      if (songNames.has(songKey) && songNames.get(songKey) !== entry.name) throw fail("同一歌曲的导入记录包含不同曲名，请统一后重试");
      songNames.set(songKey, entry.name);
    }
    let overwritten = 0;
    for (const [key, entry] of imported) {
      if (entries.has(key)) overwritten += 1;
      const old = entries.get(key);
      entries.set(key, { ...entry, ...(old?.automatic && entry.filePath && old.filePath?.toLowerCase() === entry.filePath.toLowerCase()
        ? { automatic: old.automatic } : {}) });
    }
    const merged = [...entries.values()];
    // A title belongs to the song. A partial-file import can rename it without
    // letting a stale sibling record win merely because its filename sorts first.
    for (const entry of merged) {
      const name = songNames.get(entry.filePath.split("/")[0].toLowerCase());
      if (name) entry.name = name;
    }
    // Validate the merged table too, before any write or catalog mutation.
    validateMappingDocument({ schemaVersion: 1, entries: merged });
    return { entries: merged, incoming: [...imported.values()], imported: imported.size, overwritten };
  }
}
