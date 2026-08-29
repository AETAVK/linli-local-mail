import {
  ALLOWED_API_STYLES,
  API_KEY_MASK,
  DEFAULT_MODEL_CONFIG,
  MEMORY_STRATEGIES,
  REASONING_EFFORTS
} from "./constants.mjs";
import { ORCHESTRATION_VERSION } from "./character.mjs";
import { capacityKnown, resolveModelCapacity } from "./model-capabilities.mjs";
import { clampNumber, clone, normalizeHttpUrl, parseJson } from "./utils.mjs";

function uniqueId(candidate, prefix, used, index) {
  const requested = String(candidate || "").trim();
  const base = requested || `${prefix}-${Date.now()}-${index}`;
  let value = base;
  let suffix = 2;
  while (used.has(value)) value = `${base}-${suffix++}`;
  used.add(value);
  return value;
}

function optionalNumber(value, previous, minimum, maximum) {
  if (value === "" || value === null) return null;
  if (value === undefined) return previous == null ? null : previous;
  const number = Number(value);
  if (!Number.isFinite(number)) return previous == null ? null : previous;
  return clampNumber(number, minimum, maximum, previous == null ? null : previous);
}

function normalizeStop(value, previous = []) {
  if (value === undefined) return Array.isArray(previous) ? previous.slice(0, 16) : [];
  if (value === null || value === "") return [];
  const values = Array.isArray(value) ? value : String(value).split(/\r?\n/);
  return values.map((item) => String(item).trim()).filter(Boolean).slice(0, 16);
}

function normalizeExtraParams(value, previous = {}) {
  const source = value === undefined ? previous : value;
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  try {
    const serialized = JSON.stringify(source);
    if (serialized.length > 128 * 1024) throw new Error("extraParams is too large");
    return JSON.parse(serialized);
  } catch (error) {
    if (error.message === "extraParams is too large") throw error;
    return {};
  }
}

function normalizeGeneration(input = {}, previous = DEFAULT_MODEL_CONFIG.generation) {
  const source = input && typeof input === "object" ? input : {};
  const memoryStrategy = MEMORY_STRATEGIES.has(String(source.memoryStrategy))
    ? String(source.memoryStrategy)
    : previous.memoryStrategy;
  return {
    characterId: String(source.characterId ?? previous.characterId ?? "linli").trim() || "linli",
    memoryStrategy,
    historyLimit: Math.round(clampNumber(source.historyLimit, 0, 50, previous.historyLimit ?? 6)),
    historyBudgetTokens: source.historyBudgetTokens === "" || source.historyBudgetTokens === null
      ? null
      : source.historyBudgetTokens === undefined
        ? previous.historyBudgetTokens == null ? null : Math.round(previous.historyBudgetTokens)
        : Math.round(clampNumber(source.historyBudgetTokens, 0, 100000000, previous.historyBudgetTokens == null ? 0 : previous.historyBudgetTokens)),
    relationshipSummary: String(source.relationshipSummary ?? previous.relationshipSummary ?? "").trim(),
    timeoutMs: Math.round(clampNumber(source.timeoutMs, 5000, 600000, previous.timeoutMs ?? 120000)),
    maxOutputTokens: Math.round(clampNumber(source.maxOutputTokens, 128, 1000000, previous.maxOutputTokens ?? 1800)),
    temperature: optionalNumber(source.temperature, previous.temperature, 0, 2),
    topP: optionalNumber(source.topP, previous.topP, 0, 1),
    topK: optionalNumber(source.topK, previous.topK, 1, 1000000),
    minP: optionalNumber(source.minP, previous.minP, 0, 1),
    frequencyPenalty: optionalNumber(source.frequencyPenalty, previous.frequencyPenalty, -2, 2),
    presencePenalty: optionalNumber(source.presencePenalty, previous.presencePenalty, -2, 2),
    repetitionPenalty: optionalNumber(source.repetitionPenalty, previous.repetitionPenalty, 0, 2),
    seed: source.seed === "" || source.seed === null
      ? null
      : source.seed === undefined
        ? previous.seed == null ? null : Math.round(previous.seed)
        : Math.round(clampNumber(source.seed, 0, 2147483647, previous.seed == null ? 0 : previous.seed)),
    stop: normalizeStop(source.stop, previous.stop),
    thinkingBudget: source.thinkingBudget === "" || source.thinkingBudget === null
      ? null
      : source.thinkingBudget === undefined
        ? previous.thinkingBudget == null ? null : Math.round(previous.thinkingBudget)
        : Math.round(clampNumber(source.thinkingBudget, 256, 1000000, previous.thinkingBudget == null ? 256 : previous.thinkingBudget)),
    verbosity: new Set(["default", "low", "medium", "high"]).has(String(source.verbosity ?? previous.verbosity ?? "default"))
      ? String(source.verbosity ?? previous.verbosity ?? "default")
      : "default",
    logprobs: source.logprobs == null ? Boolean(previous.logprobs) : Boolean(source.logprobs),
    topLogprobs: optionalNumber(source.topLogprobs, previous.topLogprobs, 0, 20) == null
      ? null
      : Math.round(optionalNumber(source.topLogprobs, previous.topLogprobs, 0, 20)),
    parallelToolCalls: source.parallelToolCalls == null
      ? previous.parallelToolCalls == null ? null : Boolean(previous.parallelToolCalls)
      : Boolean(source.parallelToolCalls),
    extraParams: normalizeExtraParams(source.extraParams, previous.extraParams),
    retryOnValidation: source.retryOnValidation == null
      ? Boolean(previous.retryOnValidation)
      : Boolean(source.retryOnValidation)
  };
}

export function normalizeModelConfig(input, existingInput = DEFAULT_MODEL_CONFIG) {
  const defaults = clone(DEFAULT_MODEL_CONFIG);
  const existing = existingInput && typeof existingInput === "object" ? existingInput : defaults;
  const source = input && typeof input === "object" ? input : existing;
  const providerIds = new Set();
  const providers = (Array.isArray(source.providers) ? source.providers : [])
    .slice(0, 32)
    .map((provider, providerIndex) => {
      const id = uniqueId(provider.id, "provider", providerIds, providerIndex);
      const apiStyle = String(provider.apiStyle || "openai-compatible").trim();
      if (!ALLOWED_API_STYLES.has(apiStyle)) throw new Error(`Unsupported API style: ${apiStyle}`);
      const name = String(provider.name ?? "").trim();
      if (!name) throw new Error(`Provider ${providerIndex + 1} needs a name`);
      const baseUrl = normalizeHttpUrl(provider.baseUrl);
      const previousProvider = (Array.isArray(existing.providers) ? existing.providers : [])
        .find((item) => String(item?.id || "") === id);
      const modelIds = new Set();
      const models = (Array.isArray(provider.models) ? provider.models : [])
        .slice(0, 128)
        .map((model, modelIndex) => {
          const modelId = String(model.modelId ?? model.model ?? "").trim();
          if (!modelId) throw new Error(`${name}: model ${modelIndex + 1} needs a model id`);
          const normalizedModel = {
            id: uniqueId(model.id, `model-${id}`, modelIds, modelIndex),
            name: String(model.name ?? modelId).trim() || modelId,
            modelId,
          };
          const previousModel = (Array.isArray(previousProvider?.models) ? previousProvider.models : [])
            .find((item) => String(item?.id || "") === normalizedModel.id
              || String(item?.modelId || "") === modelId);
          const carryPreviousCapacity = previousModel?.capacity
            && (previousModel.capacity.source === "manual"
              || (previousProvider.apiStyle === apiStyle && previousProvider.baseUrl === baseUrl));
          return {
            ...normalizedModel,
            capacity: resolveModelCapacity(
              { apiStyle, baseUrl },
              { ...(carryPreviousCapacity ? { capacity: previousModel.capacity } : {}), ...model, modelId }
            )
          };
        });
      return { id, name, apiStyle, baseUrl, models };
    });

  let activeProviderId = source.activeProviderId == null ? null : String(source.activeProviderId);
  if (!providers.some((provider) => provider.id === activeProviderId)) {
    activeProviderId = providers[0]?.id ?? null;
  }
  const activeProvider = providers.find((provider) => provider.id === activeProviderId);
  let activeModelId = source.activeModelId == null ? null : String(source.activeModelId);
  if (!activeProvider?.models.some((model) => model.id === activeModelId)) {
    activeModelId = activeProvider?.models[0]?.id ?? null;
  }
  const requestedEffort = String(source.reasoningEffort ?? existing.reasoningEffort ?? "default");

  return {
    version: 3,
    providers,
    activeProviderId,
    activeModelId,
    reasoningEffort: REASONING_EFFORTS.has(requestedEffort) ? requestedEffort : "default",
    generation: normalizeGeneration(source.generation, existing.generation || defaults.generation)
  };
}

function storedConfig(database) {
  const parsed = parseJson(database.getSetting("model_config_json"), null);
  return parsed && typeof parsed === "object" ? parsed : clone(DEFAULT_MODEL_CONFIG);
}

async function migrateLegacyKeys(database, secretStore, config) {
  let changed = false;
  for (const provider of Array.isArray(config.providers) ? config.providers : []) {
    if (provider.apiKey && !secretStore.has(provider.id)) {
      await secretStore.set(provider.id, String(provider.apiKey));
      changed = true;
    }
    if (Object.hasOwn(provider, "apiKey")) {
      delete provider.apiKey;
      changed = true;
    }
  }
  if (changed) database.setSetting("model_config_json", JSON.stringify(config));
  return config;
}

export async function getInternalModelConfig(database, secretStore) {
  const raw = await migrateLegacyKeys(database, secretStore, storedConfig(database));
  const normalized = normalizeModelConfig(raw, raw);
  const providers = [];
  for (const provider of normalized.providers) {
    providers.push({ ...provider, apiKey: await secretStore.get(provider.id) });
  }
  return { ...normalized, providers };
}

export async function getPublicModelConfig(database, secretStore) {
  const internal = await getInternalModelConfig(database, secretStore);
  return {
    ...internal,
    readiness: modelReadiness(internal),
    providers: internal.providers.map((provider) => ({
      ...provider,
      apiKey: provider.apiKey ? API_KEY_MASK : "",
      apiKeyConfigured: Boolean(provider.apiKey)
    }))
  };
}

export async function updateModelConfig(database, secretStore, input) {
  const oldRaw = storedConfig(database);
  const oldProviders = new Set((oldRaw.providers || []).map((provider) => String(provider.id)));
  const normalized = normalizeModelConfig(input, oldRaw);
  const incomingProviders = Array.isArray(input?.providers) ? input.providers : [];
  const incomingById = new Map(
    incomingProviders
      .filter((provider) => provider?.id != null && String(provider.id).trim())
      .map((provider) => [String(provider.id), provider])
  );

  for (const [index, provider] of normalized.providers.entries()) {
    const incoming = incomingById.get(provider.id) || incomingProviders[index];
    const providedKey = incoming?.apiKey;
    if (providedKey != null && providedKey !== "" && providedKey !== API_KEY_MASK) {
      await secretStore.set(provider.id, String(providedKey));
    }
    if (incoming?.clearApiKey === true) await secretStore.set(provider.id, "");
    oldProviders.delete(provider.id);
  }
  for (const removedId of oldProviders) secretStore.delete(removedId);

  database.setSetting("model_config_json", JSON.stringify(normalized));
  return getPublicModelConfig(database, secretStore);
}

// 模型列表探测只补充已经存在模型的容量元数据，不新增模型、不覆盖手工容量，也不接触密钥。
// 这样现有前端即使只提交 modelId/name，下一次生成仍能使用刚探测到的供应商限制。
export function cacheProviderModelCapacities(database, providerId, suggestions) {
  const id = String(providerId || "").trim();
  if (!id || !Array.isArray(suggestions)) return 0;
  const raw = storedConfig(database);
  const provider = (Array.isArray(raw.providers) ? raw.providers : [])
    .find((item) => String(item?.id || "") === id);
  if (!provider || !Array.isArray(provider.models)) return 0;
  let updated = 0;
  for (const model of provider.models) {
    const modelId = String(model?.modelId || model?.model || "").trim();
    const suggestion = suggestions.find((item) => String(item?.id || "").trim() === modelId);
    if (!suggestion?.capacity || model?.capacity?.source === "manual" || !capacityKnown(suggestion.capacity)) continue;
    if (JSON.stringify(model.capacity) === JSON.stringify(suggestion.capacity)) continue;
    model.capacity = suggestion.capacity;
    updated += 1;
  }
  if (updated) database.setSetting("model_config_json", JSON.stringify(normalizeModelConfig(raw, raw)));
  return updated;
}

export function activeSelection(config) {
  const provider = config.providers.find((item) => item.id === config.activeProviderId);
  const model = provider?.models.find((item) => item.id === config.activeModelId);
  if (!provider || !model) {
    throw new Error("没有已激活的供应商和模型；请先在模型管理中完成接入并选择当前模型");
  }
  return { provider, model };
}

function isLocalBaseUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

// 模型生成就绪诊断：只做静态检查，不发起真实付费请求。
// 缺少激活模型、密钥未配置时返回 ready=false，由诊断与 doctor 明确报告
// “本地服务可运行 / 模型生成未就绪”，而不是整体正常。
export function modelReadiness(config) {
  const checks = [];
  const warnings = [];
  const push = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail: String(detail || "") });

  const provider = config.providers.find((item) => item.id === config.activeProviderId) || null;
  const model = provider?.models.find((item) => item.id === config.activeModelId) || null;
  push("active-model", Boolean(provider && model), provider && model
    ? `已选择 ${provider.name} / ${model.name}`
    : "未选择当前供应商和模型；在模型管理中接入并选择后才能生成回信");
  push("provider-found", Boolean(provider), provider ? `供应商 ${provider.name}` : "当前供应商不在配置中");
  push("provider-available", Boolean(provider && ALLOWED_API_STYLES.has(provider.apiStyle)),
    provider ? `接口协议 ${provider.apiStyle}` : "无供应商可检查");
  push("model-name", Boolean(model?.name && String(model.modelId || "").trim()),
    model ? `模型 ID ${model.modelId}` : "模型名称为空");
  let baseUrlValid = false;
  try {
    baseUrlValid = Boolean(provider?.baseUrl) && ["http:", "https:"].includes(new URL(provider.baseUrl).protocol);
  } catch {
    baseUrlValid = false;
  }
  push("base-url", baseUrlValid, provider?.baseUrl || "Base URL 缺失或无效");
  if (provider) {
    const credentialOptional = isLocalBaseUrl(provider.baseUrl);
    push("credentials", credentialOptional || Boolean(provider.apiKey),
      credentialOptional
        ? "本地端点，密钥可选"
        : provider.apiKey
          ? "已配置 API Key"
          : "远端端点尚未配置 API Key");
  }
  if (model && !capacityKnown(model.capacity)) {
    warnings.push({
      id: "model-context-unknown",
      detail: "未获得该模型的上下文窗口；auto 将回退到 historyLimit，或可手工填写 historyBudgetTokens/模型容量"
    });
  }
  return {
    ready: checks.every((check) => check.ok),
    orchestrationVersion: ORCHESTRATION_VERSION,
    checks,
    warnings
  };
}
