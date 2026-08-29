const CAPACITY_SOURCES = new Set([
  "provider-api",
  "official-catalog",
  "manual",
  "unknown"
]);

const DEEPSEEK_OFFICIAL_CAPABILITIES = Object.freeze({
  "deepseek-v4-flash": Object.freeze({
    contextWindowTokens: 1_000_000,
    outputTokenLimit: 384_000,
    source: "official-catalog",
    verifiedAt: "2026-08-29"
  })
});

function positiveInteger(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number);
}

function firstNumber(source, keys) {
  for (const key of keys) {
    const value = positiveInteger(source?.[key]);
    if (value != null) return value;
  }
  return null;
}

function hasNumericCapacity(capacity) {
  return Boolean(
    capacity?.contextWindowTokens != null
      || capacity?.inputTokenLimit != null
      || capacity?.outputTokenLimit != null
  );
}

export function normalizeCapacity(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const contextWindowTokens = firstNumber(source, [
    "contextWindowTokens",
    "context_window_tokens",
    "contextWindow",
    "context_window",
    "contextLength",
    "context_length",
    "maxContextLength",
    "max_context_length",
    "maxModelLen",
    "max_model_len"
  ]);
  const inputTokenLimit = firstNumber(source, [
    "inputTokenLimit",
    "input_token_limit",
    "maxInputTokens",
    "max_input_tokens"
  ]);
  const outputTokenLimit = firstNumber(source, [
    "outputTokenLimit",
    "output_token_limit",
    "maxOutputTokens",
    "max_output_tokens"
  ]);
  const requestedSource = String(source.source || "").trim();
  const capacitySource = CAPACITY_SOURCES.has(requestedSource)
    ? requestedSource
    : hasNumericCapacity({ contextWindowTokens, inputTokenLimit, outputTokenLimit })
      ? "manual"
      : "unknown";
  const verifiedAt = source.verifiedAt == null || source.verifiedAt === ""
    ? null
    : String(source.verifiedAt).trim() || null;
  return {
    contextWindowTokens,
    inputTokenLimit,
    outputTokenLimit,
    source: capacitySource,
    verifiedAt
  };
}

function providerHostname(provider) {
  try {
    return new URL(String(provider?.baseUrl || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function officialModelCapacity(provider, modelId) {
  const hostname = providerHostname(provider);
  const normalizedModelId = String(modelId || "").trim().replace(/^models\//, "");
  if (hostname === "api.deepseek.com" && DEEPSEEK_OFFICIAL_CAPABILITIES[normalizedModelId]) {
    return { ...DEEPSEEK_OFFICIAL_CAPABILITIES[normalizedModelId] };
  }
  return null;
}

export function capacityFromModelListItem(provider, item = {}) {
  const raw = item && typeof item === "object" ? item : {};
  const providerCapacity = normalizeCapacity({
    contextWindowTokens: raw.contextWindowTokens
      ?? raw.context_window_tokens
      ?? raw.contextWindow
      ?? raw.context_window
      ?? raw.contextLength
      ?? raw.context_length
      ?? raw.maxContextLength
      ?? raw.max_context_length
      ?? raw.maxModelLen
      ?? raw.max_model_len,
    inputTokenLimit: raw.inputTokenLimit
      ?? raw.input_token_limit
      ?? raw.maxInputTokens
      ?? raw.max_input_tokens,
    outputTokenLimit: raw.outputTokenLimit
      ?? raw.output_token_limit
      ?? raw.maxOutputTokens
      ?? raw.max_output_tokens,
    source: "provider-api",
    verifiedAt: new Date().toISOString()
  });
  if (hasNumericCapacity(providerCapacity)) return providerCapacity;
  return officialModelCapacity(provider, raw.id ?? raw.name)
    || normalizeCapacity();
}

export function resolveModelCapacity(provider, model = {}) {
  const rawModel = model && typeof model === "object" ? model : {};
  const rawCapacity = rawModel.capacity && typeof rawModel.capacity === "object"
    ? { ...rawModel, ...rawModel.capacity }
    : { ...rawModel };
  const manualContextWindowTokens = positiveInteger(rawModel.manualContextWindowTokens);
  if (manualContextWindowTokens != null) {
    rawCapacity.contextWindowTokens = manualContextWindowTokens;
    rawCapacity.source = "manual";
    rawCapacity.verifiedAt = null;
  }
  const normalized = normalizeCapacity(rawCapacity);
  if (normalized.source === "manual" && hasNumericCapacity(normalized)) return normalized;

  const official = officialModelCapacity(provider, rawModel.modelId ?? rawModel.model);
  if (!official) return normalized;
  return normalizeCapacity({
    ...official,
    ...normalized,
    contextWindowTokens: normalized.contextWindowTokens ?? official.contextWindowTokens,
    inputTokenLimit: normalized.inputTokenLimit ?? official.inputTokenLimit,
    outputTokenLimit: normalized.outputTokenLimit ?? official.outputTokenLimit,
    source: hasNumericCapacity(normalized) ? normalized.source : official.source,
    verifiedAt: normalized.verifiedAt || official.verifiedAt
  });
}

export function capacityKnown(capacity) {
  return hasNumericCapacity(normalizeCapacity(capacity));
}
