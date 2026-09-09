import crypto from 'node:crypto';
import { VISION_ALGORITHM, VISION_POLICY, VISION_PERIODS } from './custom-song-vision-policy.mjs';

export function revisionForResolvedFile(resolved) {
  const stat = resolved.stat;
  const metadata = { path: resolved.path, size: String(stat.size),
    mtimeNs: stat.mtimeNs === undefined ? String(stat.mtimeMs) : String(stat.mtimeNs),
    ctimeNs: stat.ctimeNs === undefined ? String(stat.ctimeMs) : String(stat.ctimeNs), ino: String(stat.ino), dev: String(stat.dev) };
  return `v1:${crypto.createHash('sha256').update(JSON.stringify(metadata)).digest('hex')}`;
}
export function isVisionFile(file) { return file?.evidence === 'vision'; }
export function validVisionFile(file, revision) {
  return isVisionFile(file) && file.vision?.schemaVersion === 1 && file.vision.algorithm === VISION_ALGORITHM && file.vision.policy === VISION_POLICY &&
    typeof revision === 'string' && /^v1:[a-f0-9]{64}$/.test(revision) && file.vision.fileRevision === revision && VISION_PERIODS.includes(file.tod);
}
export function visionStateHash(row, file, entry, { includeRowVersion = true } = {}) {
  const overrides = JSON.parse(row.overrides_json || '{}');
  return crypto.createHash('sha256').update(JSON.stringify({ file, entry: entry || null,
    override: Object.hasOwn(overrides, file.fileName) ? [overrides[file.fileName]] : [],
    ...(includeRowVersion ? { updatedAt: row.updated_at } : {}) })).digest('hex');
}
export function visionEligibility(row, raw, shown, entry) {
  if (!shown?.fileRevision) return 'missing-file';
  const overrides = JSON.parse(row.overrides_json || '{}');
  if (Object.hasOwn(overrides, raw.fileName) || raw.manualUnknown === true || raw.mappingManual || entry?.manualUnknown === true || shown.evidence === 'manual') return 'protected-manual';
  if (raw.conflict || shown.conflict) return 'conflict';
  if (raw.evidence === 'original' || shown.evidence === 'original') return 'protected-original';
  const staleVision = isVisionFile(raw) && !validVisionFile(raw, shown.fileRevision);
  const entryVision = isVisionFile(entry?.automatic) && entry.tod === entry.automatic.tod;
  if (entry?.tod && !entryVision) return 'protected-mapping';
  if (VISION_PERIODS.includes(shown.tod) || VISION_PERIODS.includes(raw.tod) && !staleVision || entryVision && validVisionFile(entry.automatic, shown.fileRevision)) return 'already-labelled';
  return null;
}
export function occupiedVisionPeriods(files) {
  const result = new Set();
  for (const file of files) {
    if (VISION_PERIODS.includes(file.display?.tod)) result.add(file.display.tod);
    if (VISION_PERIODS.includes(file.raw?.tod) && (!isVisionFile(file.raw) || validVisionFile(file.raw, file.display?.fileRevision))) result.add(file.raw.tod);
    const entry = file.entry;
    const staleVisual = isVisionFile(entry?.automatic) && entry.tod === entry.automatic.tod && !validVisionFile(entry.automatic, file.display?.fileRevision);
    if (VISION_PERIODS.includes(entry?.tod) && !staleVisual) result.add(entry.tod);
  }
  return result;
}
