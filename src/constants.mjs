export const HOST = "127.0.0.1";
export const PORT = 27149;
export const SERVICE_VERSION = "0.11.1";

export const LETTER_STATUS = Object.freeze({
  PENDING: 1,
  AUDITING: 2,
  LLM_PROCESSING: 3,
  REPLIED: 4,
  FAILED: 5
});

export const AUDIT_STATUS = Object.freeze({
  PENDING: 1,
  PASSED: 2,
  REJECTED: 3
});

export const REPLY_TYPE = Object.freeze({
  NONE: 0,
  TEXT: 1,
  SPEECH: 2,
  MIX_PLAY: 3,
  MIX_SVS: 4
});

export const JOB_STATUS = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed"
});

export const API_KEY_MASK = "••••••••";

export const ALLOWED_API_STYLES = new Set([
  "responses",
  "openai-compatible",
  "anthropic",
  "gemini"
]);

export const REASONING_EFFORTS = new Set([
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
]);

export const MEMORY_STRATEGIES = new Set([
  "none",
  "auto",
  "continuity",
  "recent",
  "relevant",
  "all"
]);

// 每日写信上限：默认恢复原版的每天 3 封；只在调试模式开启时可调整，范围 3~99。
export const DAILY_LETTER_LIMIT = Object.freeze({
  DEFAULT: 3,
  MIN: 3,
  MAX: 99
});

export const DEFAULT_MODEL_CONFIG = Object.freeze({
  version: 3,
  providers: [],
  activeProviderId: null,
  activeModelId: null,
  reasoningEffort: "default",
  generation: {
    characterId: "linli",
    memoryStrategy: "auto",
    historyLimit: 50,
    historyBudgetTokens: null,
    relationshipSummary: "",
    timeoutMs: 120000,
    maxOutputTokens: 1800,
    temperature: null,
    topP: null,
    topK: null,
    minP: null,
    frequencyPenalty: null,
    presencePenalty: null,
    repetitionPenalty: null,
    seed: null,
    stop: [],
    thinkingBudget: null,
    verbosity: "default",
    logprobs: false,
    topLogprobs: null,
    parallelToolCalls: null,
    extraParams: {},
    retryOnValidation: true
  }
});

export const ALLOWED_BROWSER_ORIGINS = new Set([
  "https://olivia.local",
  "https://toy-cnbeta01.olivia.miyoushe.com",
  `http://${HOST}:${PORT}`,
  `http://localhost:${PORT}`
]);
