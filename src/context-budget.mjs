const HAN_PATTERN = /\p{Script=Han}/u;

function finitePositive(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function finiteNonNegative(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

// 这是用于选取历史的保守估算，不把估算值当成供应商计费或 usage 的精确值。
// 中文字符通常比 ASCII 单词更接近一个独立 token；对标点、空白和拉丁文字分别给出较低权重，
// 再由上下文安全余量覆盖不同 tokenizer 的误差。
export function estimateTextTokens(value) {
  const text = String(value ?? "");
  let estimate = 0;
  for (const character of text) {
    if (/\s/u.test(character)) estimate += 0.2;
    else if (HAN_PATTERN.test(character)) estimate += 0.85;
    else if (/[a-z0-9]/iu.test(character)) estimate += 0.35;
    else estimate += 0.75;
  }
  return Math.max(0, Math.ceil(estimate));
}

export function estimateMessageTokens(message) {
  if (!message || typeof message !== "object") return 0;
  return estimateTextTokens(message.content) + 8;
}

export function estimateMessagesTokens(messages) {
  return (Array.isArray(messages) ? messages : [])
    .reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function contextLimit(capacity) {
  const contextWindowTokens = finitePositive(capacity?.contextWindowTokens);
  const inputTokenLimit = finitePositive(capacity?.inputTokenLimit);
  if (contextWindowTokens == null && inputTokenLimit == null) return null;
  return Math.min(
    contextWindowTokens == null ? Number.POSITIVE_INFINITY : contextWindowTokens,
    inputTokenLimit == null ? Number.POSITIVE_INFINITY : inputTokenLimit
  );
}

export function calculateInputBudget({ model = null, generation = {}, baseMessages = [] } = {}) {
  const capacity = model?.capacity || {};
  const hardInputLimit = contextLimit(capacity);
  const configuredHistoryBudget = finiteNonNegative(generation?.historyBudgetTokens);
  const requestedOutput = finitePositive(generation?.maxOutputTokens) || 0;
  const fixedTokens = estimateMessagesTokens(baseMessages);

  if (hardInputLimit == null && configuredHistoryBudget == null) {
    return {
      known: false,
      budgetTokens: null,
      hardInputLimit: null,
      configuredHistoryBudget: null,
      fixedTokens,
      requestedOutput,
      safetyMargin: 0,
      reason: "model-context-unknown"
    };
  }

  const totalInputLimit = hardInputLimit == null
    ? configuredHistoryBudget
    : Math.max(0, hardInputLimit - requestedOutput);
  const cappedInputLimit = configuredHistoryBudget == null
    ? totalInputLimit
    : Math.min(totalInputLimit, configuredHistoryBudget);
  const safetyMargin = Math.max(256, Math.min(8192, Math.ceil(cappedInputLimit * 0.1)));
  const budgetTokens = Math.max(0, Math.floor(cappedInputLimit - fixedTokens - safetyMargin));
  return {
    known: true,
    budgetTokens,
    hardInputLimit,
    configuredHistoryBudget,
    fixedTokens,
    requestedOutput,
    safetyMargin,
    reason: hardInputLimit == null ? "configured-history-budget" : "model-context"
  };
}

export function formatTokenCount(value) {
  const number = finitePositive(value);
  if (number == null) return "未知";
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number % 1_000_000 ? 1 : 0)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(number % 1_000 ? 1 : 0)}K`;
  return String(number);
}
