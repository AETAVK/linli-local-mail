export const POLICY_VERSION = 'song-recognition-policy-v1';

const TITLE_LIMIT = 240;
const MAX_CLIPS = 5;
const MAX_NAMES_PER_CLIP = 20;
const VALID_SUPPORT = 0.45;
const STRONG_SUPPORT = 0.8;
const MEDIUM_SUPPORT = 0.65;
const SPECIAL_FAMILY_ID = 'family:爱情转移-富士山下';
const PREFERRED_CENTERS = [0.3, 0.7, 0.5, 0.1, 0.9];
const PERFORMANCE_SUFFIX = /\s*[([{]\s*(?:live|现场版|女生版|男生版|钢琴版|吉他版|伴奏版|纯音乐版|演奏版|acoustic|instrumental|karaoke)\s*[)\]}]\s*$/iu;

function finiteNumber(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeString(value) {
  if (value === null || value === undefined) return '';
  try { return String(value); } catch { return ''; }
}

function titleFamilyId(name) {
  const key = name.toLowerCase();
  if (key === '爱情转移' || key === '富士山下') return SPECIAL_FAMILY_ID;
  return `title:${key}`;
}

function scoreValue(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const score = finiteNumber(value);
  if (score === null) return null;
  return Math.max(0, Math.min(1, score));
}

export function normalizeTitle(value) {
  let title = safeString(value);
  try { title = title.normalize('NFKC'); } catch { /* String values normally support NFKC. */ }
  title = title
    .replace(/[\p{Cc}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  while (title) {
    const next = title.replace(PERFORMANCE_SUFFIX, '').trim();
    if (next === title) break;
    title = next;
  }
  return Array.from(title).slice(0, TITLE_LIMIT).join('').trim();
}

export function sampleOffsets(durationSeconds, { maxSamples = 5, durationSeconds: clipSeconds = 10 } = {}) {
  const duration = finiteNumber(durationSeconds);
  if (duration === null || duration <= 0) return [];
  const requestedMax = finiteNumber(maxSamples);
  const count = Math.min(MAX_CLIPS, Math.max(0, Math.floor(requestedMax === null ? 5 : requestedMax)));
  if (!count) return [];
  const requestedClip = finiteNumber(clipSeconds);
  const clip = Math.min(duration, requestedClip === null || requestedClip <= 0 ? 10 : requestedClip);

  if (duration <= clip) return [{ startSeconds: 0, durationSeconds: duration, ordinal: 1 }];

  const selected = [];
  const startLimit = duration - clip;
  for (const centerRatio of PREFERRED_CENTERS) {
    if (selected.length >= count) break;
    const start = Math.max(0, Math.min(startLimit, duration * centerRatio - clip / 2));
    const end = start + clip;
    const duplicate = selected.some(sample => Math.abs(sample.startSeconds - start) < 1e-9 &&
      Math.abs(sample.durationSeconds - clip) < 1e-9);
    if (duplicate) continue;
    const overlapsTooMuch = selected.some(sample => {
      const overlap = Math.max(0, Math.min(end, sample.startSeconds + sample.durationSeconds) -
        Math.max(start, sample.startSeconds));
      return overlap > Math.min(clip, sample.durationSeconds) * 0.2 + 1e-9;
    });
    if (overlapsTooMuch) continue;
    selected.push({ startSeconds: start, durationSeconds: clip, ordinal: selected.length + 1 });
  }
  return selected;
}

function familyTier(stats) {
  if (stats.support >= 2 && stats.strongSupport >= 1) return 2;
  if (stats.topSupport >= MEDIUM_SUPPORT || stats.support >= 2) return 1;
  return 0;
}

function candidateRecord(stats, displayName, aliases) {
  return {
    name: displayName,
    score: stats.score,
    support: stats.support,
    strongSupport: stats.strongSupport,
    topSupport: stats.topSupport,
    aliases,
    familyId: stats.familyId,
  };
}

export function aggregateCandidates(samples, { currentName = '' } = {}) {
  const clips = Array.isArray(samples) ? samples.slice(0, MAX_CLIPS) : [];
  const families = new Map();

  clips.forEach((sample, clipIndex) => {
    const perClip = new Map();
    const candidates = Array.isArray(sample?.candidates) ? sample.candidates.slice(0, MAX_NAMES_PER_CLIP) : [];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      const name = normalizeTitle(candidate.name);
      const score = scoreValue(candidate.score);
      if (!name || score === null) continue;
      const familyId = titleFamilyId(name);
      const key = `${familyId}\u0000${name.toLowerCase()}`;
      const previousTitle = perClip.get(key);
      if (!previousTitle || score > previousTitle.score) perClip.set(key, { name, score, familyId });
    }

    const perClipFamily = new Map();
    for (const evidence of perClip.values()) {
      let stats = families.get(evidence.familyId);
      if (!stats) {
        stats = { familyId: evidence.familyId, firstSeen: families.size, observations: [], names: new Map() };
        families.set(evidence.familyId, stats);
      }
      const nameKey = evidence.name.toLowerCase();
      if (!stats.names.has(nameKey)) stats.names.set(nameKey, evidence.name);
      const previous = perClipFamily.get(evidence.familyId);
      if (!previous || evidence.score > previous.score) perClipFamily.set(evidence.familyId, evidence);
    }
    for (const evidence of perClipFamily.values()) {
      const stats = families.get(evidence.familyId);
      stats.observations.push({ clipIndex, score: evidence.score });
    }
  });

  for (const stats of families.values()) {
    stats.support = stats.observations.filter(item => item.score >= VALID_SUPPORT).length;
    stats.strongSupport = stats.observations.filter(item => item.score >= STRONG_SUPPORT).length;
    stats.topSupport = stats.observations.reduce((top, item) => Math.max(top, item.score), 0);
    stats.score = stats.observations.length
      ? stats.observations.reduce((sum, item) => sum + item.score, 0) / stats.observations.length
      : 0;
  }

  if (!families.size) {
    return {
      candidates: [], confidence: null, suggestedName: null, stable: false,
      reason: clips.length ? 'no-usable-candidates' : 'no-samples',
    };
  }

  const ranked = [...families.values()].sort((a, b) =>
    familyTier(b) - familyTier(a) || b.strongSupport - a.strongSupport || b.support - a.support ||
    b.topSupport - a.topSupport || a.firstSeen - b.firstSeen);
  const winner = ranked[0];
  const conflictingStrong = ranked.some(stats => stats !== winner && stats.strongSupport > 0);
  const confidence = winner.support >= 2 && winner.strongSupport >= 1 && !conflictingStrong
    ? 'high'
    : (winner.topSupport >= MEDIUM_SUPPORT || winner.support >= 2 ? 'medium' : 'low');
  const current = normalizeTitle(currentName);
  const currentFamily = current ? titleFamilyId(current) : null;
  if (winner.familyId === SPECIAL_FAMILY_ID) {
    for (const name of ['爱情转移', '富士山下']) {
      if (!winner.names.has(name.toLowerCase())) winner.names.set(name.toLowerCase(), name);
    }
  }
  const familyNames = [...winner.names.values()];
  const suggestedName = current && currentFamily === winner.familyId ? current : familyNames[0] ?? null;
  // The provisional consumer displays the first candidate, including retained current spelling.
  if (suggestedName) winner.names.set(suggestedName.toLowerCase(), suggestedName);
  const stable = confidence === 'high'
    ? clips.length >= 2
    : confidence === 'medium'
      ? clips.length >= 3 && winner.support >= 2 && !conflictingStrong
      : false;
  const candidates = ranked.flatMap(stats => {
    const names = [...stats.names.values()];
    if (stats === winner && suggestedName) {
      names.splice(names.indexOf(suggestedName), 1);
      names.unshift(suggestedName);
    }
    return names.map(name => candidateRecord(stats, name, names.filter(alias => alias !== name)));
  });

  return {
    candidates,
    confidence,
    suggestedName,
    stable,
    reason: `${confidence}-confidence${stable ? '-stable' : '-unstable'}`,
  };
}
