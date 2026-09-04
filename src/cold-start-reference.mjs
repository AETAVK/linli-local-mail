const OFFICIAL_SOURCES = new Set([
  "remote-history",
  "history-share-json",
  "share-link-live"
]);

const DEFAULT_THRESHOLDS = Object.freeze({ fullMax: 1, compactMax: 5 });
const DEFAULT_WEIGHTS = Object.freeze({
  officialPair: 3,
  officialReplyOnly: 1,
  otherPair: 1,
  otherReplyOnly: 0
});

const PHASES = Object.freeze({
  FULL: "full",
  COMPACT: "compact",
  OFF: "off"
});

function emptyCounts() {
  return {
    officialComplete: 0,
    officialReplyOnly: 0,
    otherComplete: 0,
    otherReplyOnly: 0
  };
}

function isConfigObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configVersion(config) {
  return isConfigObject(config) && config.version != null ? config.version : null;
}

function disabledResult(config, reason) {
  return {
    version: configVersion(config),
    phase: PHASES.OFF,
    score: 0,
    counts: emptyCounts(),
    reasons: [reason],
    promptSection: "",
    duplicateCount: 0
  };
}

function isDisabled(config) {
  return config.enabled === false
    || config.disabled === true
    || config.testDisabled === true
    || config.disableForTests === true
    || config.disabledForTests === true;
}

function normalizeBody(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

function numericConfigValue(value, fallback) {
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function scoringOptions(config) {
  const thresholds = isConfigObject(config.thresholds) ? config.thresholds : {};
  const sourceWeights = isConfigObject(config.sourceWeights) ? config.sourceWeights : {};
  const officialSources = Array.isArray(config.officialSources)
    ? new Set(config.officialSources.map((source) => normalizeBody(source)).filter(Boolean))
    : OFFICIAL_SOURCES;
  return {
    thresholds: {
      fullMax: numericConfigValue(thresholds.fullMax, DEFAULT_THRESHOLDS.fullMax),
      compactMax: numericConfigValue(thresholds.compactMax, DEFAULT_THRESHOLDS.compactMax)
    },
    weights: {
      officialPair: numericConfigValue(sourceWeights.officialPair, DEFAULT_WEIGHTS.officialPair),
      officialReplyOnly: numericConfigValue(sourceWeights.officialReplyOnly, DEFAULT_WEIGHTS.officialReplyOnly),
      otherPair: numericConfigValue(sourceWeights.otherPair, DEFAULT_WEIGHTS.otherPair),
      otherReplyOnly: numericConfigValue(sourceWeights.otherReplyOnly, DEFAULT_WEIGHTS.otherReplyOnly)
    },
    officialSources
  };
}

function rowDetails(row, { officialSources, weights }) {
  const content = normalizeBody(row?.content);
  const replyText = normalizeBody(row?.replyText);
  const source = normalizeBody(row?.source);
  const official = officialSources.has(source);
  const complete = Boolean(content && replyText);
  const replyOnly = Boolean(!content && replyText);
  const weight = complete
    ? official ? weights.officialPair : weights.otherPair
    : replyOnly
      ? official ? weights.officialReplyOnly : weights.otherReplyOnly
      : 0;
  return { content, replyText, official, complete, replyOnly, weight };
}

function candidateIsBetter(next, previous) {
  if (next.official !== previous.official) return next.official;
  return next.weight > previous.weight;
}

function uniqueScoringRows(history, options) {
  const unique = new Map();
  let duplicateCount = 0;

  for (const row of Array.isArray(history) ? history : []) {
    const details = rowDetails(row, options);
    if (!details.content && !details.replyText) continue;

    // JSON encoding keeps content and replyText as distinct tuple members and
    // avoids collisions that a plain string concatenation could introduce.
    const key = JSON.stringify([details.content, details.replyText]);
    const previous = unique.get(key);
    if (!previous) {
      unique.set(key, details);
      continue;
    }

    duplicateCount += 1;
    if (candidateIsBetter(details, previous)) unique.set(key, details);
  }

  return { rows: [...unique.values()], duplicateCount };
}

function phaseForScore(score, thresholds) {
  if (score <= thresholds.fullMax) return PHASES.FULL;
  if (score <= thresholds.compactMax) return PHASES.COMPACT;
  return PHASES.OFF;
}

function promptValue(value) {
  return Array.isArray(value) ? value.map((line) => String(line)).join("\n") : value ?? "";
}

function promptForPhase(config, phase) {
  if (phase === PHASES.OFF) return "";
  const compatibleSections = [
    config,
    isConfigObject(config.prompts) ? config.prompts : null,
    isConfigObject(config.promptSection) ? config.promptSection : null
  ];
  for (const section of compatibleSections) {
    if (section?.[phase] !== undefined && section?.[phase] !== null) {
      return promptValue(section[phase]);
    }
  }
  return "";
}

function reasonsFor(counts, score, thresholds) {
  const reasons = [];
  if (counts.officialComplete > 0) reasons.push("official-complete-history");
  if (counts.officialReplyOnly > 0) reasons.push("official-reply-only-history");
  if (counts.otherComplete > 0) reasons.push("other-complete-history");
  if (counts.otherReplyOnly > 0) reasons.push("other-reply-only-history");
  if (reasons.length === 0) reasons.push("no-scoring-history");
  if (score <= thresholds.fullMax) reasons.push("score-in-full-range");
  else if (score <= thresholds.compactMax) reasons.push("score-in-compact-range");
  else reasons.push("score-in-off-range");
  return reasons;
}

/**
 * Evaluate whether a profile should receive its cold-start reference section.
 * The input history is expected to contain normalized, successful history rows.
 * This function only evaluates in memory; it never reads or changes storage.
 */
export function evaluateColdStartReference(config, history = []) {
  if (!isConfigObject(config)) return disabledResult(null, "configuration-missing");
  if (isDisabled(config)) {
    const reason = config.testDisabled === true
      || config.disableForTests === true
      || config.disabledForTests === true
      ? "test-disabled"
      : "configuration-disabled";
    return disabledResult(config, reason);
  }

  const options = scoringOptions(config);
  const { rows, duplicateCount } = uniqueScoringRows(history, options);
  const counts = emptyCounts();
  for (const row of rows) {
    if (row.complete) {
      if (row.official) counts.officialComplete += 1;
      else counts.otherComplete += 1;
    } else if (row.replyOnly) {
      if (row.official) counts.officialReplyOnly += 1;
      else counts.otherReplyOnly += 1;
    }
  }

  const score = counts.officialComplete * options.weights.officialPair
    + counts.officialReplyOnly * options.weights.officialReplyOnly
    + counts.otherComplete * options.weights.otherPair
    + counts.otherReplyOnly * options.weights.otherReplyOnly;
  const phase = phaseForScore(score, options.thresholds);
  return {
    version: configVersion(config),
    phase,
    score,
    counts,
    reasons: reasonsFor(counts, score, options.thresholds),
    promptSection: promptForPhase(config, phase),
    duplicateCount
  };
}

export { OFFICIAL_SOURCES };
