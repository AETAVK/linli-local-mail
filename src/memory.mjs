import { estimateTextTokens } from "./context-budget.mjs";

function tokenSet(value) {
  const text = String(value || "").toLowerCase().replace(/\s+/g, "");
  const tokens = new Set();
  for (const match of text.matchAll(/[a-z0-9]{2,}|[\p{Script=Han}]{2}/gu)) tokens.add(match[0]);
  for (let index = 0; index < text.length - 1; index += 1) {
    const pair = text.slice(index, index + 2);
    if (/^[\p{Script=Han}]{2}$/u.test(pair)) tokens.add(pair);
  }
  return tokens;
}

function relevanceScore(contentTokens, row) {
  const historyTokens = tokenSet(`${row.content || ""}\n${row.reply_text || row.replyText || ""}`);
  let overlap = 0;
  for (const token of contentTokens) if (historyTokens.has(token)) overlap += token.length > 2 ? 2 : 1;
  return overlap;
}

function rowTime(row) {
  return Number(row.created_at ?? row.createdAt ?? 0);
}

function rowHasContent(row) {
  return String(row.content || "").trim() || String(row.reply_text || row.replyText || "").trim();
}

function rowKey(row, index) {
  const id = row.letter_id ?? row.letterId;
  return id == null || String(id).trim() === "" ? `history-row-${index}` : String(id);
}

function historyEntries(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row, index) => ({ row, index, key: rowKey(row, index) }))
    .filter((entry) => rowHasContent(entry.row))
    .sort((left, right) => rowTime(left.row) - rowTime(right.row) || left.index - right.index);
}

function isStandaloneEvent(row) {
  return !String(row.content || "").trim()
    && String(row.reply_text || row.replyText || "").trim();
}

function isImportedEvent(row) {
  return Boolean(String(row.source || "").trim()) && String(row.source).trim() !== "local";
}

function eventTokenCost(row) {
  const content = String(row.content || "");
  const reply = String(row.reply_text || row.replyText || "");
  const messageCount = Number(Boolean(content)) + Number(Boolean(reply));
  // 保留每个角色消息的格式开销；这里的值只用于排序和预算，不是供应商 usage。
  return Math.max(1, estimateTextTokens(content) + estimateTextTokens(reply) + messageCount * 8 + 4);
}

function sumEventTokens(entries) {
  return entries.reduce((total, entry) => total + eventTokenCost(entry.row), 0);
}

function withTotalCount(selection, totalCount) {
  return { ...selection, omittedCount: Math.max(0, totalCount - selection.rows.length) };
}

function selectContinuityByCount(entries, currentContent, limit) {
  if (entries.length <= limit) return entries;
  const selected = new Set(entries.slice(-limit));
  const first = entries[0];
  const standaloneEvents = entries.filter((entry) => isStandaloneEvent(entry.row));
  for (const entry of standaloneEvents) selected.add(entry);
  selected.add(first);

  const currentTokens = tokenSet(currentContent);
  for (const entry of entries) {
    if (selected.has(entry)) continue;
    if (relevanceScore(currentTokens, entry.row) >= 4) selected.add(entry);
  }
  return entries.filter((entry) => selected.has(entry));
}

function selectContinuityByBudget(entries, currentContent, budgetTokens) {
  const selected = new Set();
  let remaining = Math.max(0, Math.floor(Number(budgetTokens) || 0));
  const add = (entry) => {
    if (!entry || selected.has(entry)) return false;
    const cost = eventTokenCost(entry.row);
    if (cost > remaining) return false;
    selected.add(entry);
    remaining -= cost;
    return true;
  };

  // 起点、停服告别信和前几封官方通信组成“关系地基”。告别等主动来信先占位，避免在极窄预算下
  // 被一组普通官方通信挤掉；官方通信很多时只锚定最早的少量事件，其余空间留给最近连续来往。
  add(entries[0]);
  for (const entry of entries.filter((entry) => isStandaloneEvent(entry.row))) add(entry);
  const officialFoundation = entries.filter((entry) => isImportedEvent(entry.row)).slice(0, 6);
  for (const entry of officialFoundation) add(entry);

  // 最近通信优先，并尽量保持从末尾向前的连续性；锚点已占用的空间自然会减少该段长度。
  const recentTarget = Math.max(1, Math.floor(remaining * 0.65));
  let recentUsed = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (selected.has(entry)) continue;
    const cost = eventTokenCost(entry.row);
    if (recentUsed > 0 && recentUsed + cost > recentTarget) break;
    if (!add(entry)) break;
    recentUsed += cost;
  }

  // 当前来信提到的旧事件再补回；同分时偏向较新的事件，但最终仍恢复时间顺序。
  const currentTokens = tokenSet(currentContent);
  const relevant = entries
    .filter((entry) => !selected.has(entry))
    .map((entry, index) => ({
      entry,
      score: relevanceScore(currentTokens, entry.row),
      recency: index
    }))
    .filter((candidate) => candidate.score >= 4)
    .sort((left, right) => right.score - left.score || right.recency - left.recency);
  for (const candidate of relevant) add(candidate.entry);

  // 若预算仍有余量，继续从新到旧填充，避免只留下几个离散的锚点。
  for (let index = entries.length - 1; index >= 0; index -= 1) add(entries[index]);
  return entries.filter((entry) => selected.has(entry));
}

// 一行 = 一次完整通信事件（去信与回信存储在同一行），不可拆分。
// 告别信等主动来信在数据库中表现为 content 为空、replyText 非空的独立事件。
// 全部选择以完整事件为单位；最终输出必须恢复为从旧到新。
export function selectHistoryDetailed(
  rows,
  currentContent,
  strategy = "continuity",
  limit = 50,
  { historyBudgetTokens = null } = {}
) {
  const entries = historyEntries(rows);
  const numericLimitValue = Number(limit);
  const numericLimit = Number.isFinite(numericLimitValue) ? Math.floor(numericLimitValue) : 50;
  const budget = Number(historyBudgetTokens);
  const hasBudget = historyBudgetTokens !== null
    && historyBudgetTokens !== undefined
    && Number.isFinite(budget)
    && budget >= 0;
  if (strategy === "none" || numericLimit <= 0) {
    return {
      rows: [],
      strategy,
      selectionMode: "disabled",
      budgetTokens: hasBudget ? budget : null,
      estimatedTokens: 0,
      omittedCount: entries.length
    };
  }

  const budgetAware = hasBudget && ["auto", "all", "continuity"].includes(strategy);
  if (budgetAware) {
    const totalCost = sumEventTokens(entries);
    if (totalCost <= budget) {
      return {
        rows: entries.map((entry) => entry.row),
        strategy,
        selectionMode: "all-fit",
        budgetTokens: budget,
        estimatedTokens: totalCost,
        omittedCount: 0
      };
    }
    const selected = selectContinuityByBudget(entries, currentContent, budget);
    return {
      rows: selected.map((entry) => entry.row),
      strategy,
      selectionMode: "continuity-budget",
      budgetTokens: budget,
      estimatedTokens: sumEventTokens(selected),
      omittedCount: entries.length - selected.length
    };
  }

  if (strategy === "all") {
    return {
      rows: entries.map((entry) => entry.row),
      strategy,
      selectionMode: "all-explicit",
      budgetTokens: null,
      estimatedTokens: sumEventTokens(entries),
      omittedCount: 0
    };
  }

  const recent = entries.slice(-numericLimit);
  if (strategy === "recent") {
    return withTotalCount({
      rows: recent.map((entry) => entry.row),
      strategy,
      selectionMode: "recent-count",
      budgetTokens: null,
      estimatedTokens: sumEventTokens(recent)
    }, entries.length);
  }
  if (strategy === "relevant") {
    const currentTokens = tokenSet(currentContent);
    const selected = entries
      .map((entry, index) => ({
        entry,
        score: relevanceScore(currentTokens, entry.row) + 1 / (index + 1)
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, numericLimit)
      .map((entry) => entry.entry)
      .sort((left, right) => rowTime(left.row) - rowTime(right.row) || left.index - right.index);
    return withTotalCount({
      rows: selected.map((entry) => entry.row),
      strategy,
      selectionMode: "relevant-count",
      budgetTokens: null,
      estimatedTokens: sumEventTokens(selected)
    }, entries.length);
  }

  const selected = selectContinuityByCount(entries, currentContent, numericLimit);
  return withTotalCount({
    rows: selected.map((entry) => entry.row),
    strategy,
    selectionMode: strategy === "auto" ? "count-fallback" : "continuity-count",
    budgetTokens: null,
    estimatedTokens: sumEventTokens(selected)
  }, entries.length);
}

export function selectHistory(rows, currentContent, strategy = "continuity", limit = 50, options = {}) {
  return selectHistoryDetailed(rows, currentContent, strategy, limit, options).rows;
}

export function normalizeHistoryRow(row) {
  return {
    letterId: row.letter_id ?? row.letterId,
    content: row.content || "",
    replyText: row.reply_text ?? row.replyText ?? "",
    createdAt: row.created_at ?? row.createdAt,
    repliedAt: row.replied_at ?? row.repliedAt,
    source: row.source || "local"
  };
}
