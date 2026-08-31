import {
  ORCHESTRATION_VERSION,
  buildConversationMessages,
  buildRepairMessages,
  buildSystemPrompt,
  loadCharacterProfile,
  parseReplyText,
  validateReplyText
} from "./character.mjs";
import { calculateInputBudget } from "./context-budget.mjs";
import { activeSelection, getInternalModelConfig } from "./model-config.mjs";
import { normalizeHistoryRow, selectHistoryDetailed } from "./memory.mjs";
import { callProvider } from "./providers.mjs";
import { safeErrorMessage } from "./utils.mjs";

export class GenerationWorker {
  constructor({ database, configRoot, secretStore, intervalMs = 300 }) {
    this.database = database;
    this.configRoot = configRoot;
    this.secretStore = secretStore;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = false;
    this.lastRunAt = null;
    this.lastError = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  diagnostics() {
    return {
      running: this.running,
      intervalMs: this.intervalMs,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError
    };
  }

  async tick() {
    if (this.running) return;
    const job = this.database.claimNextJob();
    if (!job) return;
    this.running = true;
    this.lastRunAt = new Date().toISOString();
    this.lastError = null;
    try {
      const result = await this.generateForJob(job);
      this.database.completeJob(job, result);
      console.log(`${new Date().toISOString()} generation completed job=${job.job_id} mode=${result.mode}`);
    } catch (error) {
      const message = safeErrorMessage(error);
      this.lastError = message;
      this.database.failJob(job, message);
      console.error(`${new Date().toISOString()} generation failed job=${job.job_id}: ${message}`);
    } finally {
      this.running = false;
      queueMicrotask(() => this.tick());
    }
  }

  // 时间线构建：读取全部已完成并成功保存的通信事件（数据库按旧到新返回），
  // 按策略选择后交给 buildConversationMessages 组装多轮消息；
  // 当前尚未回复的来信由构建器追加为最后一条 user，重试时同一封来信不会重复进入历史
  //（它本身不在 historyRows 结果中，且未保存成功的回复也不会进入）。
  async buildTimeline(letter, config, model = null, generation = config.generation) {
    const profile = loadCharacterProfile(this.configRoot, config.generation.characterId);
    const historyRows = this.database.historyRows(letter.letterId).map(normalizeHistoryRow);
    const curatedMemories = this.database.activeMemories();
    const baseMessages = [
      {
        role: "system",
        content: buildSystemPrompt(profile, {
          relationshipSummary: generation.relationshipSummary,
          curatedMemories
        })
      },
      { role: "user", content: String(letter.content ?? "").trim() }
    ];
    const contextBudget = calculateInputBudget({ model, generation, baseMessages });
    // “all” 只有在确认容量或手工预算后才允许无条件放行；未知容量时沿用 auto 的连续性兜底，
    // 防止旧配置在换成未知模型后把全部历史直接推给供应商。
    const effectiveMemoryStrategy = generation.memoryStrategy === "all" && !contextBudget.known
      ? "auto"
      : generation.memoryStrategy;
    const historySelection = selectHistoryDetailed(
      historyRows,
      letter.content,
      effectiveMemoryStrategy,
      generation.historyLimit,
      { historyBudgetTokens: contextBudget.budgetTokens }
    );
    const selectedHistory = historySelection.rows;
    const messages = buildConversationMessages({
      profile,
      completedHistory: selectedHistory,
      currentLetter: letter,
      relationshipSummary: generation.relationshipSummary,
      curatedMemories
    });
    return {
      profile,
      messages,
      selectedHistory,
      curatedMemories,
      contextBudget,
      historySelection
    };
  }

  async generateForJob(job) {
    const letter = this.database.getLetter(job.letter_id, { includeInternal: true });
    if (!letter) throw new Error(`Letter disappeared before generation: ${job.letter_id}`);
    const config = await getInternalModelConfig(this.database, this.secretStore);
    const { provider, model } = activeSelection(config);
    const { profile, messages, selectedHistory, curatedMemories, contextBudget, historySelection } =
      await this.buildTimeline(letter, config, model);

    this.database.attachJobRequest(job.job_id, {
      providerId: provider.id,
      modelId: model.id,
      request: {
        orchestrationVersion: ORCHESTRATION_VERSION,
        characterId: profile.id,
        characterVersion: profile.version,
        reasoningEffort: config.reasoningEffort,
        memoryStrategy: config.generation.memoryStrategy,
        effectiveMemoryStrategy: historySelection.strategy,
        historyLimit: config.generation.historyLimit,
        historyBudgetTokens: config.generation.historyBudgetTokens,
        modelCapacity: model.capacity,
        contextBudget,
        historySelection: {
          selectionMode: historySelection.selectionMode,
          estimatedTokens: historySelection.estimatedTokens,
          omittedCount: historySelection.omittedCount,
          budgetTokens: historySelection.budgetTokens
        },
        historyLetterIds: selectedHistory.map((item) => item.letterId),
        curatedMemoryIds: curatedMemories.map((item) => item.memoryId),
        messages
      }
    });

    let providerResult = await callProvider({
      provider,
      model,
      messages,
      reasoningEffort: config.reasoningEffort,
      generation: config.generation
    });
    let parsed = parseReplyText(providerResult.text);
    let validation = validateReplyText(parsed, profile);
    const attempts = [{ raw: providerResult.raw, body: parsed.body, validation }];

    if (!validation.ok && config.generation.retryOnValidation) {
      const repairMessages = buildRepairMessages(messages, validation);
      providerResult = await callProvider({
        provider,
        model,
        messages: repairMessages,
        reasoningEffort: config.reasoningEffort,
        generation: config.generation
      });
      parsed = parseReplyText(providerResult.text);
      validation = validateReplyText(parsed, profile);
      attempts.push({ raw: providerResult.raw, body: parsed.body, validation });
    }
    if (!validation.ok) {
      throw new Error(`Generated reply failed hard-boundary validation: ${validation.errors.join("; ")}`);
    }

    return {
      mode: "model",
      body: parsed.body,
      providerId: provider.id,
      modelId: model.id,
      usage: providerResult.usage,
      response: {
        // 标题是服务端固定技术值（客户端与数据库兼容需要）；主生成只产出正文。
        subject: "回信",
        body: parsed.body,
        orchestrationVersion: ORCHESTRATION_VERSION,
        validation,
        reasoningApplied: providerResult.reasoningApplied,
        warning: providerResult.warning,
        endpoint: providerResult.endpoint,
        attempts
      }
    };
  }

  async testActiveModel() {
    const config = await getInternalModelConfig(this.database, this.secretStore);
    const { provider, model } = activeSelection(config);
    // 模型测试使用临时来信，不写入数据库；仍需提供稳定的排除键，
    // 避免 historyRows 将 undefined 绑定到 SQLite 的第一个参数。
    const letter = {
      letterId: "__local_model_test__",
      content: "这是一封本地连接测试信。请用两到三句话自然回应，并明确写到‘连接成功’。"
    };
    const generation = {
      ...config.generation,
      maxOutputTokens: Math.min(800, config.generation.maxOutputTokens)
    };
    const { profile, messages, contextBudget, historySelection } =
      await this.buildTimeline(letter, config, model, generation);
    const startedAt = Date.now();
    const result = await callProvider({
      provider,
      model,
      messages,
      reasoningEffort: config.reasoningEffort,
      generation
    });
    const parsed = parseReplyText(result.text);
    const validation = validateReplyText(parsed, profile);
    return {
      providerId: provider.id,
      providerName: provider.name,
      modelId: model.id,
      modelName: model.name,
      elapsedMs: Date.now() - startedAt,
      reasoningApplied: result.reasoningApplied,
      warning: result.warning,
      preview: parsed.body.slice(0, 500),
      validation,
      contextBudget,
      historySelection: {
        selectionMode: historySelection.selectionMode,
        estimatedTokens: historySelection.estimatedTokens,
        omittedCount: historySelection.omittedCount,
        budgetTokens: historySelection.budgetTokens
      }
    };
  }
}
