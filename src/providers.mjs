import { fetchJson, joinEndpoint } from "./utils.mjs";
import { capacityFromModelListItem, capacityKnown } from "./model-capabilities.mjs";

function providerHeaders(apiKey, extra = {}) {
  return {
    "content-type": "application/json",
    ...extra,
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
  };
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => typeof part === "string" ? part : part?.text ?? part?.content ?? "")
    .filter(Boolean)
    .join("");
}

function anthropicEndpoint(baseUrl) {
  const base = baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/v1/messages")) return base;
  if (base.endsWith("/v1")) return `${base}/messages`;
  return `${base}/v1/messages`;
}

function geminiEndpoint(baseUrl, modelId) {
  const base = baseUrl.replace(/\/+$/, "");
  if (/:generateContent$/.test(base)) return base;
  return `${base}/models/${encodeURIComponent(modelId)}:generateContent`;
}

function openAIReasoning(effort) {
  return effort && effort !== "default" ? effort : null;
}

function extraParams(generation) {
  const value = generation?.extraParams;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return structuredClone(value);
}

function finite(value) {
  if (value === undefined || value === null || value === "") return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function stopValues(generation) {
  return Array.isArray(generation?.stop)
    ? generation.stop.map((value) => String(value).trim()).filter(Boolean)
    : [];
}

function openAICommonParams(generation, { effort = null, responses = false } = {}) {
  const maxOutputTokens = finite(generation?.maxOutputTokens);
  const topP = finite(generation?.topP);
  const topK = finite(generation?.topK);
  const minP = finite(generation?.minP);
  const frequencyPenalty = finite(generation?.frequencyPenalty);
  const presencePenalty = finite(generation?.presencePenalty);
  const repetitionPenalty = finite(generation?.repetitionPenalty);
  const seed = finite(generation?.seed);
  const topLogprobs = finite(generation?.topLogprobs);
  const stop = stopValues(generation);
  const params = {
    ...(maxOutputTokens != null ? { [responses ? "max_output_tokens" : "max_tokens"]: maxOutputTokens } : {}),
    ...(effort ? { ...(responses ? { reasoning: { effort } } : { reasoning_effort: effort }) } : {}),
    ...(!effort && !responses && finite(generation?.temperature) != null
      ? { temperature: finite(generation.temperature) }
      : {}),
    ...(!effort && responses && finite(generation?.temperature) != null
      ? { temperature: finite(generation.temperature) }
      : {}),
    ...(topP != null ? { top_p: topP } : {}),
    ...(topK != null && !responses ? { top_k: topK } : {}),
    ...(minP != null && !responses ? { min_p: minP } : {}),
    ...(frequencyPenalty != null ? { frequency_penalty: frequencyPenalty } : {}),
    ...(presencePenalty != null ? { presence_penalty: presencePenalty } : {}),
    ...(repetitionPenalty != null ? { repetition_penalty: repetitionPenalty } : {}),
    ...(seed != null ? { seed: Math.round(seed) } : {}),
    ...(stop.length && !responses ? { stop } : {}),
    ...(generation?.logprobs ? { logprobs: true } : {}),
    ...(generation?.logprobs && topLogprobs != null ? { top_logprobs: Math.round(topLogprobs) } : {}),
    ...(generation?.parallelToolCalls != null ? { parallel_tool_calls: Boolean(generation.parallelToolCalls) } : {})
  };
  return params;
}

function normalizeMessages(messages) {
  const list = (Array.isArray(messages) ? messages : [])
    .map((message) => ({ role: String(message?.role || ""), content: String(message?.content ?? "") }))
    .filter((message) => message.role && message.content.trim());
  if (!list.length) throw new Error("Provider request requires a non-empty messages array");
  const system = list.filter((message) => message.role === "system").map((message) => message.content);
  const turns = list.filter((message) => message.role !== "system");
  if (!turns.length) throw new Error("Provider request requires at least one non-system message");
  return { system, turns };
}

// 相邻同角色轮次合并：只把紧邻的同角色消息合进同一条消息的多个文本段，保持原文与顺序，
// 用于满足 Gemini/Anthropic 对轮次交替的要求；这不是把历史重新压成一整块提示词。
function mergeAdjacentTurns(turns) {
  const merged = [];
  for (const turn of turns) {
    const previous = merged[merged.length - 1];
    if (previous && previous.role === turn.role) previous.parts.push(turn.content);
    else merged.push({ role: turn.role, parts: [turn.content] });
  }
  return merged;
}

function adjacencyWarning(turns) {
  for (let index = 1; index < turns.length; index += 1) {
    if (turns[index].role === turns[index - 1].role) {
      return "Timeline contains adjacent same-role messages (e.g. the standalone farewell letter); provider may merge or reject them";
    }
  }
  return null;
}

async function callOpenAICompatible({ provider, model, messages, reasoningEffort, generation }) {
  const endpoint = joinEndpoint(provider.baseUrl, "chat/completions");
  const effort = openAIReasoning(reasoningEffort);
  const { system, turns } = normalizeMessages(messages);
  const body = {
    ...extraParams(generation),
    model: model.modelId,
    messages: [
      ...system.map((content) => ({ role: "system", content })),
      ...turns.map((turn) => ({ role: turn.role, content: turn.content }))
    ],
    ...openAICommonParams(generation, { effort })
  };
  const raw = await fetchJson(
    endpoint,
    {
      method: "POST",
      headers: providerHeaders(provider.apiKey),
      body: JSON.stringify(body)
    },
    generation.timeoutMs
  );
  const text = textFromContent(raw?.choices?.[0]?.message?.content);
  if (!text) throw new Error("OpenAI-compatible provider returned no message text");
  return {
    text,
    raw,
    usage: raw.usage ?? null,
    reasoningApplied: Boolean(effort),
    warning: adjacencyWarning(turns),
    endpoint
  };
}

function responsesText(raw) {
  if (typeof raw?.output_text === "string" && raw.output_text.trim()) return raw.output_text;
  const parts = [];
  for (const item of Array.isArray(raw?.output) ? raw.output : []) {
    if (item?.type !== "message") continue;
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (typeof part?.text === "string") parts.push(part.text);
    }
  }
  return parts.join("");
}

async function callOpenAIResponses({ provider, model, messages, reasoningEffort, generation }) {
  const endpoint = joinEndpoint(provider.baseUrl, "responses");
  const effort = openAIReasoning(reasoningEffort);
  const extras = extraParams(generation);
  const textOptions = extras.text && typeof extras.text === "object" && !Array.isArray(extras.text)
    ? { ...extras.text }
    : {};
  if (generation?.verbosity && generation.verbosity !== "default") textOptions.verbosity = generation.verbosity;
  delete extras.text;
  const { system, turns } = normalizeMessages(messages);
  const body = {
    ...extras,
    model: model.modelId,
    ...(system.length ? { instructions: system.join("\n\n") } : {}),
    input: turns.map((turn) => ({ role: turn.role, content: turn.content })),
    ...openAICommonParams(generation, { effort, responses: true }),
    ...(Object.keys(textOptions).length ? { text: textOptions } : {})
  };
  const raw = await fetchJson(
    endpoint,
    {
      method: "POST",
      headers: providerHeaders(provider.apiKey),
      body: JSON.stringify(body)
    },
    generation.timeoutMs
  );
  const text = responsesText(raw);
  if (!text) throw new Error("Responses provider returned no output text");
  return {
    text,
    raw,
    usage: raw.usage ?? null,
    reasoningApplied: Boolean(effort),
    warning: adjacencyWarning(turns),
    endpoint
  };
}

async function callAnthropic({ provider, model, messages, reasoningEffort, generation }) {
  const endpoint = anthropicEndpoint(provider.baseUrl);
  const { system, turns } = normalizeMessages(messages);
  const merged = mergeAdjacentTurns(turns);
  const topP = finite(generation?.topP);
  const topK = finite(generation?.topK);
  const temperature = finite(generation?.temperature);
  const frequencyPenalty = finite(generation?.frequencyPenalty);
  const presencePenalty = finite(generation?.presencePenalty);
  const stopSequences = stopValues(generation);
  const thinkingBudget = finite(generation?.thinkingBudget);
  const thinking = thinkingBudget != null && thinkingBudget >= 1024
    ? { type: "enabled", budget_tokens: Math.round(thinkingBudget) }
    : null;
  const body = {
    ...extraParams(generation),
    model: model.modelId,
    max_tokens: generation.maxOutputTokens,
    ...(system.length ? { system: system.join("\n\n") } : {}),
    messages: merged.map((turn) => ({ role: turn.role, content: turn.parts.join("\n\n") })),
    ...(temperature != null ? { temperature } : {}),
    ...(topP != null ? { top_p: topP } : {}),
    ...(topK != null ? { top_k: Math.round(topK) } : {}),
    ...(frequencyPenalty != null ? { frequency_penalty: frequencyPenalty } : {}),
    ...(presencePenalty != null ? { presence_penalty: presencePenalty } : {}),
    ...(stopSequences.length ? { stop_sequences: stopSequences } : {}),
    ...(thinking ? { thinking } : {})
  };
  const raw = await fetchJson(
    endpoint,
    {
      method: "POST",
      headers: providerHeaders("", {
        ...(provider.apiKey ? { "x-api-key": provider.apiKey } : {}),
        "anthropic-version": "2023-06-01"
      }),
      body: JSON.stringify(body)
    },
    generation.timeoutMs
  );
  const text = textFromContent(raw?.content?.filter((part) => part?.type === "text"));
  if (!text) throw new Error("Anthropic provider returned no text content block");
  const firstIsAssistant = merged.length && merged[0].role === "assistant";
  return {
    text,
    raw,
    usage: raw.usage ?? null,
    reasoningApplied: Boolean(thinking),
    warning: [
      reasoningEffort !== "default" && !thinking
        ? "Anthropic adapter needs a thinking budget (usually at least 1024 tokens) to enable native thinking"
        : null,
      firstIsAssistant
        ? "Timeline starts with an assistant message (standalone event with no earlier player letters); Anthropic requires the first message to be user, so this shape needs live compatibility verification"
        : adjacencyWarning(turns)
    ].filter(Boolean).join("；") || null,
    endpoint
  };
}

function geminiThinkingConfig(reasoningEffort, thinkingBudget) {
  if (Number.isFinite(Number(thinkingBudget))) {
    return { thinkingBudget: Math.round(Number(thinkingBudget)) };
  }
  if (!reasoningEffort || reasoningEffort === "default") return null;
  if (reasoningEffort === "none") return { thinkingBudget: 0 };
  const mapped = reasoningEffort === "xhigh" ? "HIGH" : reasoningEffort.toUpperCase();
  return { thinkingLevel: mapped };
}

function geminiText(raw) {
  return (raw?.candidates?.[0]?.content?.parts || [])
    .filter((part) => typeof part?.text === "string" && !part.thought)
    .map((part) => part.text)
    .join("");
}

async function callGemini({ provider, model, messages, reasoningEffort, generation }) {
  const endpoint = geminiEndpoint(provider.baseUrl, model.modelId);
  const thinkingConfig = geminiThinkingConfig(reasoningEffort, generation.thinkingBudget);
  const extras = extraParams(generation);
  const extraGenerationConfig = extras.generationConfig && typeof extras.generationConfig === "object" && Array.isArray(extras.generationConfig) === false
    ? { ...extras.generationConfig }
    : {};
  delete extras.generationConfig;
  const { system, turns } = normalizeMessages(messages);
  const merged = mergeAdjacentTurns(turns);
  const temperature = finite(generation?.temperature);
  const topP = finite(generation?.topP);
  const topK = finite(generation?.topK);
  const minP = finite(generation?.minP);
  const frequencyPenalty = finite(generation?.frequencyPenalty);
  const presencePenalty = finite(generation?.presencePenalty);
  const seed = finite(generation?.seed);
  const stopSequences = stopValues(generation);
  const generationConfig = {
    ...extraGenerationConfig,
    maxOutputTokens: generation.maxOutputTokens,
    ...(thinkingConfig ? { thinkingConfig } : {}),
    ...(!/^gemini-3\.5(?:-|$)/i.test(model.modelId) && temperature != null
      ? { temperature }
      : {}),
    ...(topP != null ? { topP } : {}),
    ...(topK != null ? { topK: Math.round(topK) } : {}),
    ...(minP != null ? { minP } : {}),
    ...(frequencyPenalty != null ? { frequencyPenalty } : {}),
    ...(presencePenalty != null ? { presencePenalty } : {}),
    ...(seed != null ? { seed: Math.round(seed) } : {}),
    ...(stopSequences.length ? { stopSequences } : {})
  };
  const requestBody = {
    ...extras,
    ...(system.length ? { systemInstruction: { parts: system.map((text) => ({ text })) } } : {}),
    contents: merged.map((turn) => ({
      role: turn.role === "assistant" ? "model" : "user",
      parts: turn.parts.map((text) => ({ text }))
    })),
    generationConfig
  };
  const request = (body) => fetchJson(
    endpoint,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(provider.apiKey ? { "x-goog-api-key": provider.apiKey } : {})
      },
      body: JSON.stringify(body)
    },
    generation.timeoutMs
  );

  let raw;
  let warning = adjacencyWarning(turns);
  let reasoningApplied = Boolean(thinkingConfig);
  try {
    raw = await request(requestBody);
  } catch (error) {
    if (!thinkingConfig || error?.status !== 400) throw error;
    const fallback = structuredClone(requestBody);
    delete fallback.generationConfig.thinkingConfig;
    raw = await request(fallback);
    reasoningApplied = false;
    warning = [warning, "Selected Gemini model rejected thinkingConfig; request succeeded after retrying with model defaults"]
      .filter(Boolean).join("；");
  }
  const text = geminiText(raw);
  if (!text) {
    const reason = raw?.promptFeedback?.blockReason || raw?.candidates?.[0]?.finishReason || "unknown";
    throw new Error(`Gemini provider returned no text (reason: ${reason})`);
  }
  return {
    text,
    raw,
    usage: raw.usageMetadata ?? null,
    reasoningApplied,
    warning,
    endpoint
  };
}

export async function callProvider(request) {
  if (!request?.provider || !request?.model) throw new Error("Provider and model are required");
  if (request.provider.apiStyle === "responses") return callOpenAIResponses(request);
  if (request.provider.apiStyle === "openai-compatible") return callOpenAICompatible(request);
  if (request.provider.apiStyle === "anthropic") return callAnthropic(request);
  if (request.provider.apiStyle === "gemini") return callGemini(request);
  throw new Error(`Unsupported provider style: ${request.provider.apiStyle}`);
}

function anthropicModelsEndpoint(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (base.endsWith("/v1/models")) return base;
  if (base.endsWith("/v1")) return `${base}/models`;
  return `${base}/v1/models`;
}

function geminiModelsEndpoint(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (base.endsWith("/models")) return base;
  return `${base}/models`;
}

function normalizeModelListItem(provider, id, name, raw = {}) {
  const modelId = String(id || "").trim();
  if (!modelId) return null;
  const label = String(name || "").trim();
  const capacity = capacityFromModelListItem(provider, { ...raw, id: modelId });
  return {
    id: modelId,
    name: label || modelId,
    ...(capacityKnown(capacity) ? { capacity } : {})
  };
}

export async function listProviderModels(provider, timeoutMs = 30000) {
  if (!provider?.apiStyle || !provider?.baseUrl) {
    throw new Error("Provider apiStyle and baseUrl are required");
  }
  let items = [];
  if (provider.apiStyle === "openai-compatible" || provider.apiStyle === "responses") {
    const raw = await fetchJson(
      joinEndpoint(provider.baseUrl, "models"),
      { headers: providerHeaders(provider.apiKey) },
      timeoutMs
    );
    items = (Array.isArray(raw?.data) ? raw.data : [])
      .map((item) => normalizeModelListItem(provider, item?.id, item?.id, item));
  } else if (provider.apiStyle === "anthropic") {
    const raw = await fetchJson(
      anthropicModelsEndpoint(provider.baseUrl),
      {
        headers: providerHeaders("", {
          ...(provider.apiKey ? { "x-api-key": provider.apiKey } : {}),
          "anthropic-version": "2023-06-01"
        })
      },
      timeoutMs
    );
    items = (Array.isArray(raw?.data) ? raw.data : [])
      .map((item) => normalizeModelListItem(provider, item?.id, item?.display_name, item));
  } else if (provider.apiStyle === "gemini") {
    const raw = await fetchJson(
      geminiModelsEndpoint(provider.baseUrl),
      { headers: provider.apiKey ? { "x-goog-api-key": provider.apiKey } : {} },
      timeoutMs
    );
    items = (Array.isArray(raw?.models) ? raw.models : [])
      .map((item) => normalizeModelListItem(
        provider,
        String(item?.name || "").replace(/^models\//, ""),
        item?.displayName,
        item
      ));
  } else {
    throw new Error(`Unsupported provider style: ${provider.apiStyle}`);
  }
  const models = items.filter(Boolean);
  if (!models.length) throw new Error("Provider returned an empty model list");
  return models;
}
