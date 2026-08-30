// 文件导入：一次选择多个 JSON 与图片文件，逐文件分类、解析和导入。
// 单个文件失败不会回滚其他成功文件；图片 OCR 尚未实现时明确报告未支持。

export const MAX_FILE_COUNT = 20;
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const MAX_FILE_NAME_LENGTH = 128;

export const JSON_EXTENSIONS = new Set(["json"]);
export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);

export const OCR_NOT_IMPLEMENTED_MESSAGE = "图片识别功能尚未实现，文件未导入";

export function fileExtension(name) {
  const index = String(name || "").lastIndexOf(".");
  return index === -1 ? "" : String(name).slice(index + 1).toLowerCase();
}

export function sanitizeFileName(name) {
  const base = String(name || "")
    .split(/[\\/]/)
    .pop()
    .trim();
  const safe = base.replace(/[\u0000-\u001f"<>|?*]/g, "").slice(0, MAX_FILE_NAME_LENGTH);
  return safe || "unnamed-file";
}

export function classifyImportFile(name) {
  const extension = fileExtension(name);
  if (JSON_EXTENSIONS.has(extension)) return "json";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  return "unsupported";
}

// 单个 JSON 对象、JSON 数组和 { "letters": [...] } 都归一为条目数组。
export function parseLetterItems(content, fileName) {
  let parsed;
  try {
    parsed = JSON.parse(String(content ?? ""));
  } catch (error) {
    const wrapped = new Error(`${sanitizeFileName(fileName)} 不是有效的 JSON`);
    wrapped.cause = error;
    throw wrapped;
  }
  const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.letters) ? parsed.letters : [parsed];
  return items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    if (!item.fileName) item.fileName = sanitizeFileName(fileName);
    return item;
  });
}

function emptySummary() {
  return {
    selected: 0,
    imported: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    unsupported: 0,
    failed: 0,
    results: []
  };
}

function addCounts(summary, other) {
  summary.imported += other.imported || 0;
  summary.inserted += other.inserted || 0;
  summary.updated += other.updated || 0;
  summary.skipped += other.skipped || 0;
  return summary;
}

// importFn(items, fileName) -> { imported, inserted, updated, skipped, errors }
export function importFileEntries(entries, { importFn, maximumBytes = MAX_TOTAL_BYTES, maximumFiles = MAX_FILE_COUNT } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const summary = emptySummary();
  summary.selected = list.length;
  if (list.length > maximumFiles) {
    const error = new Error(`单次最多导入 ${maximumFiles} 个文件`);
    error.status = 400;
    throw error;
  }
  let totalBytes = 0;
  for (const entry of list) {
    const name = entry && typeof entry === "object" ? entry.name : String(entry ?? "");
    const content = entry && typeof entry === "object" ? entry.content : null;
    const fileName = sanitizeFileName(name);
    const kind = classifyImportFile(fileName);
    const bytes = Buffer.byteLength(String(content ?? ""), "utf8");
    totalBytes += bytes;
    if (totalBytes > maximumBytes) {
      const error = new Error(`文件总大小超过 ${Math.round(maximumBytes / 1024 / 1024)} MB 限制`);
      error.status = 400;
      throw error;
    }
    if (kind === "unsupported") {
      summary.unsupported += 1;
      summary.results.push({
        fileName,
        ok: false,
        kind,
        code: "unsupported_file_type",
        message: `不支持的文件类型（.${fileExtension(fileName) || "?"}），请选择 JSON 或图片文件`
      });
      continue;
    }
    if (kind === "image") {
      summary.unsupported += 1;
      summary.results.push({
        fileName,
        ok: false,
        kind,
        code: "ocr_not_implemented",
        message: OCR_NOT_IMPLEMENTED_MESSAGE
      });
      continue;
    }
    try {
      if (bytes > MAX_FILE_BYTES) {
        throw new Error(`文件超过 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB 限制`);
      }
      const items = parseLetterItems(content, fileName);
      const result = importFn(items, fileName) || {};
      addCounts(summary, result);
      const imported = Number(result.imported || 0);
      const inserted = Number(result.inserted || 0);
      const updated = Number(result.updated || 0);
      const skipped = Number(result.skipped || 0);
      const errors = Array.isArray(result.errors) ? result.errors : [];
      const hasRecordErrors = skipped > 0 || errors.length > 0;
      const noValidLetters = imported === 0 && hasRecordErrors;
      if (noValidLetters) summary.failed += 1;
      summary.results.push({
        fileName,
        ok: !noValidLetters,
        partial: !noValidLetters && hasRecordErrors,
        kind,
        imported,
        inserted,
        updated,
        skipped,
        errors,
        code: noValidLetters ? "no_valid_letters" : null,
        message: noValidLetters
          ? String(errors[0]?.message || "文件中没有可导入的有效信件")
          : null
      });
    } catch (error) {
      summary.failed += 1;
      summary.results.push({
        fileName,
        ok: false,
        kind,
        code: "file_import_error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return summary;
}
