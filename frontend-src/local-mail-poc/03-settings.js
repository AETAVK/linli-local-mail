
  function applyMailboxDebugVisibility() {
    var tools = document.getElementById(MAILBOX_TOOLS_ID);
    if (!tools) return;
    Array.prototype.forEach.call(tools.querySelectorAll("[data-mailbox-action]"), function (button) {
      if (button.dataset.mailboxAction === "import") return;
      button.hidden = !state.debugMode;
    });
  }

  function formatServiceVersion(value) {
    var text = String(value == null ? "" : value).trim();
    if (!text) return "未知";
    return /^v/i.test(text) ? text : "v" + text;
  }

  function patchVersionSectionHtml() {
    return '<div class="lm-card lm-patch-version-card">' +
      '<div class="lm-card-head"><div class="lm-card-title">补丁版本</div>' +
      '<div class="lm-actions"><span class="lm-patch-version" data-role="service-version">正在读取…</span>' +
      '<button class="lm-button lm-button-small" type="button" data-action="check-update">检查更新</button></div></div>' +
      '<div class="lm-note">当前本地回信服务版本；点击“检查更新”后会查询公开发布源。</div>' +
      '</div>';
  }

  function renderPatchVersion(value) {
    var section = document.getElementById(PATCH_VERSION_SECTION_ID);
    var version = section && section.querySelector('[data-role="service-version"]');
    if (version) version.textContent = formatServiceVersion(value);
  }

  function bindPatchVersionSection(section) {
    if (!section || section.dataset.updateBound === "true") return;
    var button = section.querySelector('[data-action="check-update"]');
    if (!button) return;
    section.dataset.updateBound = "true";
    button.addEventListener("click", function () { checkForUpdate(true); });
  }

  function sectionHtml() {
    return [
      '<div class="lm-title-row"><div class="lm-title">本地回信</div><div class="lm-badge" data-role="service-badge">连接中</div></div>',
      '<div class="lm-subtitle">由本机服务保存信件、编排林离的人设与历史，并调用所选模型生成文本回信。API Key 使用当前 Windows 用户的 DPAPI 加密。</div>',
      '<div class="lm-card">',
      '  <div class="lm-card-head"><div class="lm-card-title">模型配置</div><button class="lm-button lm-button-small" type="button" data-action="open-model-manager">模型管理</button></div>',
      '  <div class="lm-grid">',
      '    <label class="lm-field"><span>供应商</span><select class="lm-select" data-role="active-provider"></select></label>',
      '    <label class="lm-field"><span>模型</span><select class="lm-select" data-role="active-model"></select></label>',
      '  </div>',
      '  <div class="lm-advanced">',
      '    <button class="lm-advanced-toggle" type="button" data-action="toggle-advanced" aria-expanded="false">高级参数<span class="lm-advanced-arrow">▸</span></button>',
      '    <div class="lm-advanced-panel" data-role="advanced-panel" hidden>',
      '      <div class="lm-advanced-group">',
      '        <div class="lm-advanced-group-title">通用请求参数</div>',
      '        <div class="lm-advanced-group-note">带“可选”的字段留空时不会发送；不同供应商支持范围不同，不再由内置预设强行禁用。</div>',
      '        <div class="lm-parameter-grid">',
      '        <label class="lm-field"><span>思考档位</span><select class="lm-select" data-role="reasoning">',
      '          <option value="default">跟随模型默认</option><option value="none">不启用</option><option value="minimal">最少</option>',
      '          <option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">极高</option>',
      '        </select></label>',
      '        <label class="lm-field"><span>模型超时（秒）</span><input class="lm-input" type="number" min="5" max="600" required data-role="timeout-seconds"></label>',
      '        <label class="lm-field"><span>最大输出 Token</span><input class="lm-input" type="number" min="128" max="1000000" required data-role="max-output-tokens"></label>',
      '        <label class="lm-field"><span>Temperature（可选）</span><input class="lm-input" type="number" min="0" max="2" step="0.01" data-role="temperature" placeholder="留空=不发送"></label>',
      '        <label class="lm-field"><span>Top P（可选）</span><input class="lm-input" type="number" min="0" max="1" step="0.01" data-role="top-p" placeholder="留空=不发送"></label>',
      '        <label class="lm-field"><span>Top K（可选）</span><input class="lm-input" type="number" min="1" max="1000000" step="1" data-role="top-k" placeholder="留空=不发送"></label>',
      '        <label class="lm-field"><span>Min P（可选）</span><input class="lm-input" type="number" min="0" max="1" step="0.01" data-role="min-p" placeholder="留空=不发送"></label>',
      '        <label class="lm-field"><span>频率惩罚（可选）</span><input class="lm-input" type="number" min="-2" max="2" step="0.01" data-role="frequency-penalty" placeholder="留空=不发送"></label>',
      '        <label class="lm-field"><span>存在惩罚（可选）</span><input class="lm-input" type="number" min="-2" max="2" step="0.01" data-role="presence-penalty" placeholder="留空=不发送"></label>',
      '        <label class="lm-field"><span>重复惩罚（可选）</span><input class="lm-input" type="number" min="0" max="2" step="0.01" data-role="repetition-penalty" placeholder="留空=不发送"></label>',
      '        <label class="lm-field"><span>随机种子（可选）</span><input class="lm-input" type="number" min="0" max="2147483647" step="1" data-role="seed" placeholder="留空=不发送"></label>',
      '        <label class="lm-field"><span>思考预算 Token（可选）</span><input class="lm-input" type="number" min="256" max="1000000" step="1" data-role="thinking-budget" placeholder="Anthropic 通常至少 1024"></label>',
      '        <label class="lm-field"><span>输出详略（可选）</span><select class="lm-select" data-role="verbosity"><option value="default">跟随模型默认</option><option value="low">简洁</option><option value="medium">适中</option><option value="high">详细</option></select></label>',
      '        <label class="lm-check"><input type="checkbox" data-role="logprobs">请求 logprobs（供应商支持时）</label>',
      '        <label class="lm-field"><span>Top Logprobs（可选）</span><input class="lm-input" type="number" min="0" max="20" step="1" data-role="top-logprobs" placeholder="留空=不发送"></label>',
      '        <label class="lm-check"><input type="checkbox" data-role="parallel-tool-calls">允许并行工具调用（供应商支持时）</label>',
      '        </div>',
      '      </div>',
      '      <div class="lm-advanced-group">',
      '        <div class="lm-advanced-group-title">文本与供应商扩展</div>',
      '        <div class="lm-advanced-group-note">停止序列每行一个。附加参数会按所选协议合并到请求中；可用于填写供应商专用字段、模型别名或安全设置。</div>',
      '        <div class="lm-parameter-grid">',
      '          <label class="lm-field lm-parameter-wide"><span>停止序列（可选，每行一个）</span><textarea class="lm-textarea" rows="3" data-role="stop-sequences" placeholder="留空=不发送"></textarea></label>',
      '          <label class="lm-field lm-parameter-wide"><span>供应商原生附加参数 JSON（可选）</span><textarea class="lm-textarea lm-raw-json" rows="5" data-role="extra-params" spellcheck="false" placeholder="例如：{\n  &quot;service_tier&quot;: &quot;flex&quot;\n}"></textarea></label>',
      '        </div>',
      '      </div>',
      '      <div class="lm-note" data-role="param-support-note"></div>',
      '    </div>',
      '  </div>',
      '  <div class="lm-toolbar">',
      '    <div class="lm-status" data-role="model-status">正在读取本地配置…</div>',
      '    <div class="lm-actions"><button class="lm-button" type="button" data-action="test-model">测试当前模型</button><button class="lm-button lm-button-primary" type="button" data-action="save-all">保存本地回信设置</button></div>',
      '  </div>',
      '</div>',
      '<div class="lm-card">',
      '  <div class="lm-card-title">调试模式</div>',
      '  <label class="lm-check"><input type="checkbox" data-role="debug-mode">启用调试模式</label>',
      '  <div class="lm-note">打开后信箱页“导入”按钮左侧显示“导出”和“删除”按钮，可勾选信件后批量导出为 .json 或批量删除，并解锁下方每日写信上限调整。删除不可恢复；如需保留信件，请先在信箱页使用“导出”按钮导出所选信件。开关会立即保存到本地服务。</div>',
      '  <div data-debug-only hidden>',
      '    <div class="lm-grid" style="margin-top:12px">',
      '      <label class="lm-field"><span>每日写信上限（3~99）</span><input class="lm-input" type="number" min="3" max="99" step="1" data-role="daily-letter-limit"></label>',
      '    </div>',
      '    <div class="lm-note">默认每天 3 封，恢复原版限制。写满后当天无法再寄信，次日自动恢复；只统计在本机寄出的信，导入的历史信件不占用额度。修改会立即保存，关闭调试模式后上限保持当前值但不能再调整。</div>',
      '  </div>',
      '</div>'
    ].join("");
  }

  function setStatus(role, text, kind) {
    var section = document.getElementById(SECTION_ID);
    var target = section && section.querySelector('[data-role="' + role + '"]');
    if (!target) return;
    target.textContent = text;
    target.dataset.kind = kind || "";
  }

  function providerById(id) {
    return state.config && state.config.providers.find(function (provider) { return provider.id === id; });
  }

  function modelById(provider, id) {
    return provider && provider.models.find(function (model) { return model.id === id; });
  }

  function ensureConfigShape() {
    if (!state.config) return;
    if (!state.config.generation) state.config.generation = {};
    var generation = state.config.generation;
    if (!generation.characterId) generation.characterId = "linli";
    if (!generation.memoryStrategy) generation.memoryStrategy = "relevant";
    if (generation.historyLimit == null) generation.historyLimit = 6;
    if (generation.relationshipSummary == null) generation.relationshipSummary = "";
    if (generation.timeoutMs == null) generation.timeoutMs = 120000;
    if (generation.maxOutputTokens == null) generation.maxOutputTokens = 1800;
    if (generation.temperature === undefined) generation.temperature = null;
    if (generation.topP === undefined) generation.topP = null;
    if (generation.topK === undefined) generation.topK = null;
    if (generation.minP === undefined) generation.minP = null;
    if (generation.frequencyPenalty === undefined) generation.frequencyPenalty = null;
    if (generation.presencePenalty === undefined) generation.presencePenalty = null;
    if (generation.repetitionPenalty === undefined) generation.repetitionPenalty = null;
    if (generation.seed === undefined) generation.seed = null;
    if (!Array.isArray(generation.stop)) generation.stop = [];
    if (generation.thinkingBudget === undefined) generation.thinkingBudget = null;
    if (!generation.verbosity) generation.verbosity = "default";
    if (generation.logprobs === undefined) generation.logprobs = false;
    if (generation.topLogprobs === undefined) generation.topLogprobs = null;
    if (generation.parallelToolCalls === undefined) generation.parallelToolCalls = null;
    if (!generation.extraParams || typeof generation.extraParams !== "object" || Array.isArray(generation.extraParams)) generation.extraParams = {};
    if (generation.retryOnValidation == null) generation.retryOnValidation = true;
  }

  function applyDebugVisibility() {
    var section = document.getElementById(SECTION_ID);
    if (section) {
      Array.prototype.forEach.call(section.querySelectorAll("[data-debug-card]"), function (card) {
        card.hidden = !state.debugMode;
      });
      Array.prototype.forEach.call(section.querySelectorAll("[data-debug-only]"), function (block) {
        block.hidden = !state.debugMode;
      });
      var toggle = section.querySelector('[data-role="debug-mode"]');
      if (toggle) toggle.checked = state.debugMode;
    }
    applyMailboxDebugVisibility();
  }

  function applyParamSupport() {
    var section = document.getElementById(SECTION_ID);
    if (!section || !state.config) return;
    var provider = providerById(state.config.activeProviderId);
    var model = modelById(provider, state.config.activeModelId);
    var reasoningSelect = section.querySelector('[data-role="reasoning"]');
    var maxTokensInput = section.querySelector('[data-role="max-output-tokens"]');
    var note = section.querySelector('[data-role="param-support-note"]');
    if (!reasoningSelect || !maxTokensInput || !note) return;

    Array.prototype.forEach.call(reasoningSelect.options, function (option) {
      option.disabled = false;
    });
    var selected = reasoningSelect.selectedOptions[0];
    if (selected && selected.disabled) {
      reasoningSelect.value = "default";
      state.config.reasoningEffort = "default";
    }
    maxTokensInput.max = "1000000";
    note.textContent = model
      ? "当前为完全自定义接入：通用参数会按所选协议转换；供应商不支持的字段可能被拒绝，可用附加参数 JSON 调整。"
      : "选择模型后可填写通用参数；供应商专用字段请放入附加参数 JSON。";
  }

  function syncActiveSelectors() {
    var section = document.getElementById(SECTION_ID);
    if (!section || !state.config) return;
    ensureConfigShape();
    var providerSelect = section.querySelector('[data-role="active-provider"]');
    var modelSelect = section.querySelector('[data-role="active-model"]');
    var reasoningSelect = section.querySelector('[data-role="reasoning"]');
    providerSelect.innerHTML = "";
    if (!state.config.providers.length) {
      providerSelect.appendChild(new Option("尚未接入供应商", ""));
      providerSelect.disabled = true;
      state.config.activeProviderId = null;
    } else {
      providerSelect.disabled = false;
      state.config.providers.forEach(function (provider) {
        providerSelect.appendChild(new Option(provider.name || "未命名供应商", provider.id));
      });
      if (!providerById(state.config.activeProviderId)) state.config.activeProviderId = state.config.providers[0].id;
      providerSelect.value = state.config.activeProviderId;
    }
    var activeProvider = providerById(state.config.activeProviderId);
    modelSelect.innerHTML = "";
    if (!activeProvider || !activeProvider.models.length) {
      modelSelect.appendChild(new Option("尚未添加模型", ""));
      modelSelect.disabled = true;
      state.config.activeModelId = null;
    } else {
      modelSelect.disabled = false;
      activeProvider.models.forEach(function (model) {
        modelSelect.appendChild(new Option(model.name || model.modelId || "未命名模型", model.id));
      });
      if (!modelById(activeProvider, state.config.activeModelId)) state.config.activeModelId = activeProvider.models[0].id;
      modelSelect.value = state.config.activeModelId;
    }
    reasoningSelect.value = state.config.reasoningEffort || "default";
    var generation = state.config.generation;
    function setValue(role, value) {
      var control = section.querySelector('[data-role="' + role + '"]');
      if (control) control.value = value == null ? "" : String(value);
    }
    setValue("timeout-seconds", Math.round(generation.timeoutMs / 1000));
    setValue("max-output-tokens", generation.maxOutputTokens);
    setValue("temperature", generation.temperature);
    setValue("top-p", generation.topP);
    setValue("top-k", generation.topK);
    setValue("min-p", generation.minP);
    setValue("frequency-penalty", generation.frequencyPenalty);
    setValue("presence-penalty", generation.presencePenalty);
    setValue("repetition-penalty", generation.repetitionPenalty);
    setValue("seed", generation.seed);
    setValue("thinking-budget", generation.thinkingBudget);
    setValue("verbosity", generation.verbosity);
    setValue("top-logprobs", generation.topLogprobs);
    setValue("stop-sequences", generation.stop.join("\n"));
    setValue("extra-params", Object.keys(generation.extraParams).length ? JSON.stringify(generation.extraParams, null, 2) : "");
    var logprobs = section.querySelector('[data-role="logprobs"]');
    if (logprobs) logprobs.checked = Boolean(generation.logprobs);
    var parallelToolCalls = section.querySelector('[data-role="parallel-tool-calls"]');
    if (parallelToolCalls) parallelToolCalls.checked = generation.parallelToolCalls === true;
    if (state.runtime) {
      state.debugMode = Boolean(state.runtime.debugMode);
      var dailyLimit = section.querySelector('[data-role="daily-letter-limit"]');
      if (dailyLimit && document.activeElement !== dailyLimit) {
        dailyLimit.value = state.runtime.dailyLetterLimit;
      }
    }
    applyDebugVisibility();
    applyParamSupport();
  }

  function renderDiagnostics() {
    var section = document.getElementById(SECTION_ID);
    if (!state.diagnostics) return;
    var data = state.diagnostics;
    var database = data.database || {};
    var badge = section && section.querySelector('[data-role="service-badge"]');
    if (badge) badge.textContent = database.integrity === "ok" ? "服务正常" : "需要检查";
    renderPatchVersion(data.serviceVersion);
  }

  var API_STYLE_LABELS = {
    "responses": "Responses（Responses API）",
    "openai-compatible": "Chat Completions（OpenAI 兼容）",
    "anthropic": "Messages（Anthropic API）",
    "gemini": "Gemini（generateContent）"
  };
  var API_STYLE_ORDER = ["responses", "anthropic", "openai-compatible", "gemini"];

  function managerItemHtml(provider) {
    var isActive = state.config && state.config.activeProviderId === provider.id;
    var isSelected = state.modal.providerId === provider.id;
    var style = API_STYLE_LABELS[provider.apiStyle] || provider.apiStyle || "未知协议";
    var meta = provider.models.length + " 个模型 · " + style;
    return '<button class="lm-provider-nav-item" type="button" data-provider-id="' + escapeHtml(provider.id) + '" data-modal-action="select-provider" data-selected="' + String(isSelected) + '">' +
      '<span class="lm-provider-nav-name-row"><span class="lm-provider-nav-name">' + escapeHtml(provider.name || "未命名供应商") + '</span>' +
      (isActive ? '<span class="lm-provider-nav-badge">使用中</span>' : '') + '</span>' +
      '<span class="lm-provider-nav-meta">' + escapeHtml(meta) + '</span></button>';
  }

  function renderManagerList() {
    var backdrop = document.getElementById("local-mail-config-modal");
    if (!backdrop || !state.config) return;
    var list = backdrop.querySelector('[data-role="manager-list"]');
    list.innerHTML = state.config.providers.length
      ? state.config.providers.map(managerItemHtml).join("")
      : '<div class="lm-provider-nav-empty">尚未接入模型服务。<br>从“添加供应商”开始。</div>';
    var addButton = backdrop.querySelector('[data-modal-action="add-provider"]');
    if (addButton) addButton.dataset.selected = String(!state.modal.providerId);
    syncActiveSelectors();
  }

  function renderModalHeading() {
    var backdrop = document.getElementById("local-mail-config-modal");
    var draft = state.modal.draft;
    if (!backdrop || !draft) return;
    var isEdit = Boolean(state.modal.providerId);
    var isActive = isEdit && state.config && state.config.activeProviderId === state.modal.providerId;
    backdrop.querySelector('[data-role="form-title"]').textContent = isEdit ? (draft.name || "未命名供应商") : "添加供应商";
    backdrop.querySelector('[data-role="form-subtitle"]').textContent = isEdit
      ? "编辑接入地址、API 格式、密钥和可用模型。"
      : "手动填写一个兼容服务，再添加可用模型。";
    backdrop.querySelector('[data-role="active-provider-badge"]').hidden = !isActive;
    backdrop.querySelector('[data-modal-action="activate-provider"]').hidden = !isEdit || isActive;
    backdrop.querySelector('[data-modal-action="delete-current-provider"]').hidden = !isEdit;
    backdrop.querySelector('[data-modal-action="save"]').textContent = isEdit ? "保存更改" : "添加供应商";
  }

  function validateProvider(provider) {
    if (!String(provider.name || "").trim()) throw new Error("Provider 名称不能为空");
    if (!String(provider.baseUrl || "").trim()) throw new Error(provider.name + " 的 API 地址不能为空");
    for (var i = 0; i < provider.models.length; i += 1) {
      var model = provider.models[i];
      if (!String(model.modelId || "").trim()) throw new Error(provider.name + " 中存在模型 ID 为空的模型");
      if (!String(model.name || "").trim()) model.name = model.modelId;
    }
  }

  function validateConfig() {
    for (var i = 0; i < state.config.providers.length; i += 1) validateProvider(state.config.providers[i]);
  }

  async function saveConfig(message) {
    try {
      validateConfig();
      setStatus("model-status", "正在保存…", "");
      var saved = await callApi("/api/model-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.config)
      });
      state.config = saved;
      renderManagerList();
      setStatus("model-status", message || "已保存到本机 SQLite。", "success");
      return true;
    } catch (error) {
      setStatus("model-status", error.message, "error");
      return false;
    }
  }

  function readNumberControl(section, role, label, optional) {
    var control = section.querySelector('[data-role="' + role + '"]');
    var raw = control ? String(control.value || "").trim() : "";
    if (!raw && optional) return null;
    if (!raw) throw new Error(label + "不能为空");
    var value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(label + "必须是数字");
    return value;
  }

  function readJsonObjectControl(section, role) {
    var control = section.querySelector('[data-role="' + role + '"]');
    var raw = control ? String(control.value || "").trim() : "";
    if (!raw) return {};
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error("供应商原生附加参数 JSON 格式错误");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("供应商原生附加参数必须是 JSON 对象");
    }
    return parsed;
  }

  function readSettingsControls() {
    var section = document.getElementById(SECTION_ID);
    if (!section || !state.config || !state.runtime) throw new Error("本地设置尚未载入");
    ensureConfigShape();
    var generation = state.config.generation;
    state.config.reasoningEffort = section.querySelector('[data-role="reasoning"]').value;
    generation.timeoutMs = readNumberControl(section, "timeout-seconds", "模型超时", false) * 1000;
    generation.maxOutputTokens = readNumberControl(section, "max-output-tokens", "最大输出 Token", false);
    generation.temperature = readNumberControl(section, "temperature", "Temperature", true);
    generation.topP = readNumberControl(section, "top-p", "Top P", true);
    generation.topK = readNumberControl(section, "top-k", "Top K", true);
    generation.minP = readNumberControl(section, "min-p", "Min P", true);
    generation.frequencyPenalty = readNumberControl(section, "frequency-penalty", "频率惩罚", true);
    generation.presencePenalty = readNumberControl(section, "presence-penalty", "存在惩罚", true);
    generation.repetitionPenalty = readNumberControl(section, "repetition-penalty", "重复惩罚", true);
    generation.seed = readNumberControl(section, "seed", "随机种子", true);
    generation.thinkingBudget = readNumberControl(section, "thinking-budget", "思考预算 Token", true);
    generation.topLogprobs = readNumberControl(section, "top-logprobs", "Top Logprobs", true);
    generation.verbosity = section.querySelector('[data-role="verbosity"]').value;
    generation.stop = section.querySelector('[data-role="stop-sequences"]').value.split(/\r?\n/).map(function (item) { return item.trim(); }).filter(Boolean);
    generation.extraParams = readJsonObjectControl(section, "extra-params");
    generation.logprobs = section.querySelector('[data-role="logprobs"]').checked;
    generation.parallelToolCalls = section.querySelector('[data-role="parallel-tool-calls"]').checked ? true : null;
    if (!state.config.activeProviderId || !state.config.activeModelId) {
      throw new Error("请先在模型管理中添加并选择供应商和模型");
    }
  }

  async function saveAllSettings(message) {
    try {
      readSettingsControls();
      validateConfig();
      setStatus("model-status", "正在保存…", "");
      state.runtime = await callApi("/api/settings", {
        method: "POST",
        body: JSON.stringify(state.runtime)
      });
      var saved = await callApi("/api/model-config", {
        method: "POST",
        body: JSON.stringify(state.config)
      });
      state.config = saved;
      renderManagerList();
      setStatus("model-status", message || "回信、记忆和模型设置已保存。", "success");
      return true;
    } catch (error) {
      setStatus("model-status", error.message, "error");
      return false;
    }
  }

  async function saveDebugMode() {
    if (!state.runtime) return;
    try {
      state.runtime = await callApi("/api/settings", {
        method: "POST",
        body: JSON.stringify(state.runtime)
      });
      state.debugMode = Boolean(state.runtime.debugMode);
      applyDebugVisibility();
      setStatus("model-status", state.debugMode
        ? "调试模式已开启：信箱页多出导出/删除按钮，并解锁每日写信上限调整。"
        : "调试模式已关闭。", "success");
    } catch (error) {
      setStatus("model-status", "调试模式保存失败：" + error.message, "error");
    }
  }

  async function saveDailyLetterLimit() {
    if (!state.runtime) return;
    try {
      state.runtime = await callApi("/api/settings", {
        method: "POST",
        body: JSON.stringify(state.runtime)
      });
      var limit = sectionQueryDailyLimit();
      if (limit) limit.value = state.runtime.dailyLetterLimit;
      setStatus("model-status", "每日写信上限已保存：每天 " + state.runtime.dailyLetterLimit + " 封。", "success");
    } catch (error) {
      setStatus("model-status", "每日上限保存失败：" + error.message, "error");
    }
  }

  function sectionQueryDailyLimit() {
    var section = document.getElementById(SECTION_ID);
    return section && section.querySelector('[data-role="daily-letter-limit"]');
  }

  async function testCurrentModel() {
    if (!await saveAllSettings("设置已保存，正在测试模型…")) return;
    setStatus("model-status", "正在请求当前模型；这不会写入邮箱…", "");
    try {
      var result = await callApi("/api/model-test", { method: "POST", body: "{}" });
      var message = "连接成功（" + result.elapsedMs + " ms）";
      if (result.warning) message += "；" + result.warning;
      if (result.preview) message += "；预览：" + result.preview.replace(/\s+/g, " ").slice(0, 120);
      setStatus("model-status", message, result.validation && !result.validation.ok ? "error" : "success");
    } catch (error) {
      setStatus("model-status", "模型测试失败：" + error.message, "error");
    }
    await refreshDiagnostics();
  }

  async function refreshDiagnostics() {
    try {
      state.diagnostics = await callApi("/api/diagnostics");
      renderDiagnostics();
    } catch (error) {
      var section = document.getElementById(SECTION_ID);
      var badge = section && section.querySelector('[data-role="service-badge"]');
      if (badge) badge.textContent = "服务断开";
      renderPatchVersion(null);
    }
  }

  function newDraftProvider() {
    return { id: null, name: "", apiStyle: "openai-compatible", baseUrl: "", apiKey: "", apiKeyConfigured: false, clearApiKey: false, models: [] };
  }

  function draftFromProvider(provider) {
    return {
      id: provider.id,
      name: provider.name || "",
      apiStyle: provider.apiStyle || "openai-compatible",
      baseUrl: provider.baseUrl || "",
      apiKey: provider.apiKey || "",
      apiKeyConfigured: Boolean(provider.apiKeyConfigured),
      clearApiKey: false,
      models: provider.models.map(function (model) {
        return {
          id: model.id,
          name: model.name || "",
          modelId: model.modelId || ""
        };
      })
    };
  }

  function modalHtml() {
    return '<div class="lm-modal lm-model-manager" role="dialog" aria-modal="true" aria-labelledby="lm-model-manager-title">' +
      '<div class="lm-model-manager-header"><div><div class="lm-modal-title" id="lm-model-manager-title">模型设置</div>' +
      '<div class="lm-model-manager-intro">管理模型供应商与模型列表，保存后可在设置页切换当前使用项。</div></div>' +
      '<button class="lm-button lm-button-small" type="button" data-modal-action="cancel">关闭</button></div>' +
      '<div class="lm-model-manager-body">' +
      '<aside class="lm-provider-nav"><div class="lm-provider-nav-title">供应商</div>' +
      '<div class="lm-manager-list" data-role="manager-list"></div>' +
      '<button class="lm-button lm-provider-nav-add" type="button" data-modal-action="add-provider">添加供应商</button></aside>' +
      '<section class="lm-provider-detail"><div class="lm-provider-detail-scroll">' +
      '<div class="lm-provider-detail-head"><div><div class="lm-provider-detail-title" data-role="form-title">添加供应商</div>' +
      '<div class="lm-provider-detail-subtitle" data-role="form-subtitle"></div></div>' +
      '<div class="lm-provider-detail-actions"><span class="lm-config-active" data-role="active-provider-badge" hidden>使用中</span>' +
      '<button class="lm-button lm-button-small" type="button" data-modal-action="activate-provider" hidden>设为当前</button>' +
      '<button class="lm-button lm-button-small lm-button-danger" type="button" data-modal-action="delete-current-provider" hidden>删除供应商</button></div></div>' +
      '<div class="lm-provider-section"><div class="lm-provider-grid">' +
      '<div class="lm-note lm-wide">完全自定义接入：选择接口协议、填写 Base URL 和 API Key，再手动添加模型 ID；不提供内置供应商或模型预设。</div>' +
      '<label class="lm-field"><span>供应商名称</span><input class="lm-input" data-modal-field="name" placeholder="例如：DeepSeek 或 本地 LM Studio"></label>' +
      '<label class="lm-field"><span>API 格式</span><select class="lm-select" data-modal-field="apiStyle"></select></label>' +
      '<label class="lm-field lm-wide"><span>Base URL</span><input class="lm-input" data-modal-field="baseUrl" placeholder="例如：https://api.example.com/v1"></label>' +
      '<label class="lm-field lm-wide"><span>API Key（由当前 Windows 用户的 DPAPI 加密）</span><input class="lm-input" type="password" data-modal-field="apiKey" autocomplete="off" placeholder="可留空"></label>' +
      '<label class="lm-check lm-wide" data-role="clear-key-row" hidden><input type="checkbox" data-modal-field="clearApiKey">清除已保存的 API Key</label></div></div>' +
      '<div class="lm-provider-section"><div class="lm-provider-section-head"><div><div class="lm-provider-section-title">模型列表</div>' +
      '<div class="lm-provider-section-meta" data-role="model-count"></div></div>' +
      '<button class="lm-button lm-button-small" type="button" data-modal-action="fetch-models">获取模型列表</button></div>' +
      '<div class="lm-model-list-card" data-role="modal-models"></div>' +
      '<button class="lm-button lm-button-small lm-model-add-toggle" type="button" data-modal-action="toggle-model-add">添加模型</button>' +
      '<div class="lm-model-add-panel" data-role="model-add-panel" hidden>' +
      '<div class="lm-import-row"><select class="lm-select" data-role="model-suggest"></select>' +
      '<button class="lm-button lm-button-small" type="button" data-modal-action="add-suggested">添加所选</button></div>' +
      '<div class="lm-import-row" style="margin-top:8px"><input class="lm-input" data-role="manual-model-id" placeholder="手动填写模型 ID，例如 deepseek-chat">' +
      '<input class="lm-input" data-role="manual-model-name" placeholder="显示名称（可选）">' +
      '<button class="lm-button lm-button-small" type="button" data-modal-action="add-manual">添加</button></div>' +
      '<div class="lm-note">模型列表只来自你填写的远端接口或手动输入；参数兼容性由供应商文档和附加参数 JSON 决定。</div></div></div>' +
      '</div><div class="lm-model-manager-footer"><span class="lm-modal-status" data-role="modal-status"></span>' +
      '<button class="lm-button" type="button" data-modal-action="cancel">取消</button>' +
      '<button class="lm-button lm-button-primary" type="button" data-modal-action="save">保存更改</button></div>' +
      '</section></div></div>';
  }

  function ensureModal() {
    var backdrop = document.getElementById("local-mail-config-modal");
    if (backdrop) return backdrop;
    backdrop = document.createElement("div");
    backdrop.id = "local-mail-config-modal";
    backdrop.className = "lm-modal-backdrop";
    backdrop.hidden = true;
    backdrop.innerHTML = modalHtml();
    document.body.appendChild(backdrop);
    bindModal(backdrop);
    return backdrop;
  }

  function modalStatus() {
    var backdrop = document.getElementById("local-mail-config-modal");
    return backdrop && backdrop.querySelector('[data-role="modal-status"]');
  }

  function setModalStatus(message, kind) {
    var status = modalStatus();
    if (!status) return;
    status.textContent = message;
    status.dataset.kind = kind || "";
  }

  function renderApiStyleOptions() {
    var backdrop = document.getElementById("local-mail-config-modal");
    if (!backdrop || !state.modal.draft) return;
    var draft = state.modal.draft;
    var select = backdrop.querySelector('[data-modal-field="apiStyle"]');
    var styles = API_STYLE_ORDER.slice();
    select.innerHTML = "";
    styles.forEach(function (style) {
      select.appendChild(new Option(API_STYLE_LABELS[style] || style, style));
    });
    if (styles.indexOf(draft.apiStyle) === -1) draft.apiStyle = styles[0] || "openai-compatible";
    select.value = draft.apiStyle;
  }

  function renderSuggestSelect() {
    var backdrop = document.getElementById("local-mail-config-modal");
    if (!backdrop) return;
    var select = backdrop.querySelector('[data-role="model-suggest"]');
    var addButton = backdrop.querySelector('[data-modal-action="add-suggested"]');
    select.innerHTML = "";
    if (!state.modal.suggestions.length) {
      select.appendChild(new Option("暂无可选模型；可点“获取模型列表”或手动填写", ""));
      select.disabled = true;
      addButton.disabled = true;
      return;
    }
    select.disabled = false;
    addButton.disabled = false;
    state.modal.suggestions.forEach(function (model, index) {
      select.appendChild(new Option((model.name || model.modelId || model.id) + "（" + (model.modelId || model.id) + "）", String(index)));
    });
  }

  function fillModalForm() {
    var backdrop = document.getElementById("local-mail-config-modal");
    var draft = state.modal.draft;
    if (!backdrop || !draft) return;
    renderApiStyleOptions();
    backdrop.querySelector('[data-modal-field="name"]').value = draft.name;
    backdrop.querySelector('[data-modal-field="baseUrl"]').value = draft.baseUrl;
    backdrop.querySelector('[data-modal-field="apiKey"]').value = draft.apiKey;
    backdrop.querySelector('[data-modal-field="clearApiKey"]').checked = false;
    backdrop.querySelector('[data-role="clear-key-row"]').hidden = !(state.modal.providerId && draft.apiKeyConfigured);
    renderSuggestSelect();
    renderModalHeading();
    renderModelAddPanel();
  }

  function renderModelAddPanel() {
    var backdrop = document.getElementById("local-mail-config-modal");
    if (!backdrop) return;
    var panel = backdrop.querySelector('[data-role="model-add-panel"]');
    var toggle = backdrop.querySelector('[data-modal-action="toggle-model-add"]');
    panel.hidden = !state.modal.addModelOpen;
    toggle.textContent = state.modal.addModelOpen ? "收起添加" : "添加模型";
    if (state.modal.addModelOpen) {
      window.requestAnimationFrame(function () { panel.scrollIntoView({ block: "nearest" }); });
    }
  }

  function modalModelRowsHtml() {
    var rows = state.modal.draft.models.map(function (model) {
      var isEditing = state.modal.editingModelId === model.id;
      var isActive = Boolean(state.modal.providerId && state.config.activeProviderId === state.modal.providerId && state.config.activeModelId === model.id);
      var persistedProvider = state.modal.providerId ? providerById(state.modal.providerId) : null;
      var canActivate = Boolean(persistedProvider && persistedProvider.models.some(function (item) { return item.id === model.id; }));
      if (isEditing) {
        return '<div class="lm-model-row" data-model-index="' + escapeHtml(model.id) + '"><div class="lm-model-edit-grid">' +
          '<input class="lm-input" aria-label="模型显示名称" data-model-field="name" data-model-id="' + escapeHtml(model.id) + '" value="' + escapeHtml(model.name || "") + '" placeholder="显示名称">' +
          '<input class="lm-input" aria-label="模型 ID" data-model-field="modelId" data-model-id="' + escapeHtml(model.id) + '" value="' + escapeHtml(model.modelId || "") + '" placeholder="模型 ID"></div>' +
          '<div class="lm-model-row-actions"><button class="lm-model-row-action" type="button" data-modal-action="finish-model-edit">完成</button>' +
          '<button class="lm-model-row-action lm-model-row-action-danger" type="button" data-modal-action="remove-model">移除</button></div></div>';
      }
      return '<div class="lm-model-row" data-model-index="' + escapeHtml(model.id) + '">' +
        '<div class="lm-model-row-main"><div class="lm-model-row-title"><span class="lm-model-row-name">' + escapeHtml(model.name || model.modelId) + '</span>' +
        (isActive ? '<span class="lm-model-active">当前模型</span>' : '') + '</div><div class="lm-model-row-id">' + escapeHtml(model.modelId) + '</div></div>' +
        '<div class="lm-model-row-actions">' +
        (!isActive && canActivate ? '<button class="lm-model-row-action" type="button" data-modal-action="activate-model">设为当前</button>' : '') +
        '<button class="lm-model-row-action" type="button" data-modal-action="edit-model">编辑</button>' +
        '<button class="lm-model-row-action lm-model-row-action-danger" type="button" data-modal-action="remove-model">移除</button></div></div>';
    }).join("");
    if (!rows) rows = '<div class="lm-provider-nav-empty">还没有模型。可获取远端列表，或手动添加模型 ID。</div>';
    return rows;
  }

  function renderModalModels() {
    var backdrop = document.getElementById("local-mail-config-modal");
    if (!backdrop || !state.modal.draft) return;
    backdrop.querySelector('[data-role="modal-models"]').innerHTML = modalModelRowsHtml();
    backdrop.querySelector('[data-role="model-count"]').textContent = state.modal.draft.models.length + " 个已添加模型";
  }

  function openModelManager(providerId) {
    if (!state.config) return;
    installStyles();
    var provider = providerId ? providerById(providerId) : null;
    state.modal.providerId = providerId || null;
    state.modal.draft = provider ? draftFromProvider(provider) : newDraftProvider();
    state.modal.addModelOpen = false;
    state.modal.editingModelId = null;
    state.modal.suggestions = [];
    var backdrop = ensureModal();
    renderManagerList();
    fillModalForm();
    renderModalModels();
    setModalStatus(provider && provider.apiKeyConfigured ? "已保存过 API Key；留空或保留掩码将沿用原值。" : "", "");
    backdrop.hidden = false;
  }

  function closeConfigModal() {
    var backdrop = document.getElementById("local-mail-config-modal");
    if (backdrop) backdrop.hidden = true;
    state.modal.providerId = null;
    state.modal.draft = null;
    state.modal.suggestions = [];
    state.modal.addModelOpen = false;
    state.modal.editingModelId = null;
  }

  function addModelToDraft(model) {
    var draft = state.modal.draft;
    if (!draft) return false;
    var modelId = String(model.modelId || model.id || "").trim();
    if (!modelId) return false;
    if (draft.models.some(function (item) { return item.modelId === modelId; })) return false;
    draft.models.push({
      id: createId("model"),
      name: String(model.name || "").trim() || modelId,
      modelId: modelId
    });
    return true;
  }

  async function fetchRemoteModels() {
    var backdrop = document.getElementById("local-mail-config-modal");
    var draft = state.modal.draft;
    if (!backdrop || !draft) return;
    var button = backdrop.querySelector('[data-modal-action="fetch-models"]');
    if (!String(draft.baseUrl || "").trim()) {
      setModalStatus("请先填写 API 地址。", "error");
      return;
    }
    state.modal.addModelOpen = true;
    renderModelAddPanel();
    button.disabled = true;
    setModalStatus("正在向该地址请求模型列表…", "");
    try {
      var result = await callApi("/api/models/list", {
        method: "POST",
        body: JSON.stringify({
          providerId: state.modal.providerId || undefined,
          provider: {
            apiStyle: draft.apiStyle,
            baseUrl: draft.baseUrl,
            apiKey: draft.apiKey
          }
        })
      });
      var models = Array.isArray(result.models) ? result.models : [];
      state.modal.suggestions = models.map(function (model) {
        return { modelId: model.id, name: model.name || model.id };
      });
      renderSuggestSelect();
      setModalStatus("从远端读取到 " + models.length + " 个模型，可在建议列表中选择添加。", "success");
    } catch (error) {
      setModalStatus("获取模型列表失败：" + error.message, "error");
    } finally {
      button.disabled = false;
    }
  }

  async function saveModalDraft() {
    var draft = state.modal.draft;
    if (!draft) return;
    try {
      validateProvider(draft);
      var isEdit = Boolean(state.modal.providerId);
      if (isEdit) {
        var index = state.config.providers.findIndex(function (provider) { return provider.id === state.modal.providerId; });
        if (index === -1) throw new Error("该配置已不存在，请关闭后重试。");
        draft.id = state.modal.providerId;
        state.config.providers[index] = draft;
      } else {
        draft.id = createId("provider");
        state.modal.providerId = draft.id;
        state.config.providers.push(draft);
        if (!state.config.activeProviderId) {
          state.config.activeProviderId = draft.id;
          if (draft.models.length) state.config.activeModelId = draft.models[0].id;
        }
      }
      renderManagerList();
      var saved = await saveConfig(isEdit ? "配置已更新并保存。" : "配置已添加并保存。");
      if (!saved) {
        setModalStatus("保存失败，详情见设置页状态栏，修正后可重试。", "error");
        return;
      }
      closeConfigModal();
    } catch (error) {
      setModalStatus(error.message, "error");
    }
  }

  async function removeProvider(providerId) {
    var provider = providerById(providerId);
    if (!provider) return;
    var confirmed = window.confirm('确定删除配置“' + (provider.name || "未命名供应商") + "”？此操作会立即保存。");
    if (!confirmed) return;
    state.config.providers = state.config.providers.filter(function (item) { return item.id !== providerId; });
    if (state.config.activeProviderId === providerId) {
      state.config.activeProviderId = state.config.providers[0] ? state.config.providers[0].id : null;
      state.config.activeModelId = null;
    }
    renderManagerList();
    await saveConfig("配置已删除并保存。");
    if (state.modal.providerId === providerId) {
      var nextProvider = state.config.providers[0] || null;
      openModelManager(nextProvider ? nextProvider.id : null);
    }
  }

  function bindModal(backdrop) {
    backdrop.addEventListener("input", function (event) {
      var modelField = event.target.dataset.modelField;
      if (modelField && state.modal.draft) {
        var model = state.modal.draft.models.find(function (item) { return item.id === event.target.dataset.modelId; });
        if (model) model[modelField] = event.target.value;
        return;
      }
      var field = event.target.dataset.modalField;
      if (!field || !state.modal.draft) return;
      if (field === "apiStyle") return;
      state.modal.draft[field] = event.target.type === "checkbox" ? event.target.checked : event.target.value;
      if (field === "name") renderModalHeading();
    });
    backdrop.addEventListener("change", function (event) {
      var target = event.target;
      var field = target.dataset.modalField;
      if (!field || !state.modal.draft) return;
      if (field === "apiStyle") {
        state.modal.draft.apiStyle = target.value;
      } else if (field === "clearApiKey") {
        state.modal.draft.clearApiKey = target.checked;
      }
    });
    backdrop.addEventListener("click", async function (event) {
      if (event.target === backdrop) { closeConfigModal(); return; }
      var button = event.target.closest("[data-modal-action]");
      if (!button || !state.modal.draft) return;
      var action = button.dataset.modalAction;
      var providerElement = button.closest("[data-provider-id]");
      if (action === "cancel") closeConfigModal();
      else if (action === "save") saveModalDraft();
      else if (action === "fetch-models") fetchRemoteModels();
      else if (action === "select-provider" && providerElement) openModelManager(providerElement.dataset.providerId);
      else if (action === "add-provider") openModelManager(null);
      else if (action === "delete-current-provider" && state.modal.providerId) removeProvider(state.modal.providerId);
      else if (action === "activate-provider" && state.modal.providerId) {
        state.config.activeProviderId = state.modal.providerId;
        var storedProvider = providerById(state.modal.providerId);
        if (!storedProvider) return;
        if (!storedProvider.models.some(function (model) { return model.id === state.config.activeModelId; })) {
          state.config.activeModelId = storedProvider.models[0] ? storedProvider.models[0].id : null;
        }
        var providerSaved = await saveConfig("当前供应商已更新并保存。");
        renderManagerList();
        renderModalHeading();
        renderModalModels();
        setModalStatus(providerSaved ? "已设为当前供应商并保存。" : "设置当前供应商失败，请检查设置页状态。", providerSaved ? "success" : "error");
      } else if (action === "toggle-model-add") {
        state.modal.addModelOpen = !state.modal.addModelOpen;
        renderModelAddPanel();
      } else if (action === "add-suggested") {
        var select = backdrop.querySelector('[data-role="model-suggest"]');
        var suggestion = state.modal.suggestions[Number(select.value)];
        if (!suggestion) return;
        if (addModelToDraft(suggestion)) {
          renderModalModels();
          setModalStatus("", "");
        } else {
          setModalStatus("该模型已在列表中。", "error");
        }
      } else if (action === "add-manual") {
        var idInput = backdrop.querySelector('[data-role="manual-model-id"]');
        var nameInput = backdrop.querySelector('[data-role="manual-model-name"]');
        var modelId = idInput.value.trim();
        if (!modelId) {
          setModalStatus("请先填写模型 ID。", "error");
          idInput.focus();
          return;
        }
        if (addModelToDraft({ modelId: modelId, name: nameInput.value.trim() })) {
          idInput.value = "";
          nameInput.value = "";
          renderModalModels();
          setModalStatus("", "");
        } else {
          setModalStatus("该模型已在列表中。", "error");
        }
      } else if (action === "activate-model") {
        var activeRow = button.closest("[data-model-index]");
        if (activeRow && state.modal.providerId) {
          state.config.activeProviderId = state.modal.providerId;
          state.config.activeModelId = activeRow.dataset.modelIndex;
          var modelSaved = await saveConfig("当前模型已更新并保存。");
          renderManagerList();
          renderModalHeading();
          renderModalModels();
          setModalStatus(modelSaved ? "已设为当前模型并保存。" : "设置当前模型失败，请检查设置页状态。", modelSaved ? "success" : "error");
        }
      } else if (action === "edit-model") {
        var editRow = button.closest("[data-model-index]");
        if (editRow) {
          state.modal.editingModelId = editRow.dataset.modelIndex;
          renderModalModels();
          var editContainer = Array.prototype.find.call(backdrop.querySelectorAll("[data-model-index]"), function (row) {
            return row.dataset.modelIndex === state.modal.editingModelId;
          });
          var editInput = editContainer && editContainer.querySelector("[data-model-field]");
          if (editInput) editInput.focus();
        }
      } else if (action === "finish-model-edit") {
        var editingModel = state.modal.draft.models.find(function (model) { return model.id === state.modal.editingModelId; });
        if (editingModel && !String(editingModel.modelId || "").trim()) {
          setModalStatus("模型 ID 不能为空。", "error");
          return;
        }
        if (editingModel && !String(editingModel.name || "").trim()) editingModel.name = editingModel.modelId;
        state.modal.editingModelId = null;
        renderModalModels();
        setModalStatus("", "");
      } else if (action === "remove-model") {
        var row = button.closest("[data-model-index]");
        if (row) {
          state.modal.draft.models = state.modal.draft.models.filter(function (model) { return model.id !== row.dataset.modelIndex; });
          if (state.modal.editingModelId === row.dataset.modelIndex) state.modal.editingModelId = null;
          renderModalModels();
        }
      }
    });
    backdrop.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeConfigModal();
    });
  }

  function bindSection(section) {
    section.addEventListener("change", function (event) {
      var target = event.target;
      if (target.dataset.role === "active-provider") {
        state.config.activeProviderId = target.value || null;
        state.config.activeModelId = null;
        syncActiveSelectors();
      } else if (target.dataset.role === "active-model") {
        state.config.activeModelId = target.value || null;
        applyParamSupport();
      } else if (target.dataset.role === "reasoning") {
        state.config.reasoningEffort = target.value;
      } else if (target.dataset.role === "timeout-seconds") {
        ensureConfigShape(); state.config.generation.timeoutMs = Number(target.value) * 1000;
      } else if (target.dataset.role === "max-output-tokens") {
        ensureConfigShape(); state.config.generation.maxOutputTokens = Number(target.value);
      } else if (target.dataset.role === "temperature") {
        ensureConfigShape(); state.config.generation.temperature = target.value === "" ? null : Number(target.value);
      } else if (target.dataset.role === "top-p") {
        ensureConfigShape(); state.config.generation.topP = target.value === "" ? null : Number(target.value);
      } else if (target.dataset.role === "top-k") {
        ensureConfigShape(); state.config.generation.topK = target.value === "" ? null : Number(target.value);
      } else if (target.dataset.role === "min-p") {
        ensureConfigShape(); state.config.generation.minP = target.value === "" ? null : Number(target.value);
      } else if (target.dataset.role === "frequency-penalty") {
        ensureConfigShape(); state.config.generation.frequencyPenalty = target.value === "" ? null : Number(target.value);
      } else if (target.dataset.role === "presence-penalty") {
        ensureConfigShape(); state.config.generation.presencePenalty = target.value === "" ? null : Number(target.value);
      } else if (target.dataset.role === "repetition-penalty") {
        ensureConfigShape(); state.config.generation.repetitionPenalty = target.value === "" ? null : Number(target.value);
      } else if (target.dataset.role === "seed") {
        ensureConfigShape(); state.config.generation.seed = target.value === "" ? null : Number(target.value);
      } else if (target.dataset.role === "thinking-budget") {
        ensureConfigShape(); state.config.generation.thinkingBudget = target.value === "" ? null : Number(target.value);
      } else if (target.dataset.role === "top-logprobs") {
        ensureConfigShape(); state.config.generation.topLogprobs = target.value === "" ? null : Number(target.value);
      } else if (target.dataset.role === "verbosity") {
        ensureConfigShape(); state.config.generation.verbosity = target.value;
      } else if (target.dataset.role === "logprobs") {
        ensureConfigShape(); state.config.generation.logprobs = target.checked;
      } else if (target.dataset.role === "parallel-tool-calls") {
        ensureConfigShape(); state.config.generation.parallelToolCalls = target.checked ? true : null;
      } else if (target.dataset.role === "debug-mode" && state.runtime) {
        state.debugMode = target.checked;
        state.runtime.debugMode = target.checked;
        applyDebugVisibility();
        saveDebugMode();
      } else if (target.dataset.role === "daily-letter-limit" && state.runtime) {
        var requested = Number(target.value);
        if (Number.isFinite(requested) && requested > 0) {
          state.runtime.dailyLetterLimit = Math.min(99, Math.max(3, Math.round(requested)));
          saveDailyLetterLimit();
        }
      }
    });
    section.addEventListener("click", function (event) {
      var button = event.target.closest("[data-action]");
      if (!button) return;
      var action = button.dataset.action;
      if (action === "open-model-manager") openModelManager(state.config.activeProviderId || (state.config.providers[0] && state.config.providers[0].id) || null);
      else if (action === "toggle-advanced") {
        var panel = section.querySelector('[data-role="advanced-panel"]');
        var expanded = button.getAttribute("aria-expanded") === "true";
        button.setAttribute("aria-expanded", String(!expanded));
        panel.hidden = expanded;
      }
      else if (action === "save-all") saveAllSettings();
      else if (action === "test-model") testCurrentModel();
    });
  }

  async function loadConfig() {
    try {
      var loaded = await Promise.all([
        callApi("/api/model-config"),
        callApi("/api/settings"),
        callApi("/api/diagnostics"),
        callApi("/api/remote-import/detect").catch(function () { return { found: false, prompt: {} }; })
      ]);
      state.config = loaded[0];
      state.runtime = loaded[1];
      state.diagnostics = loaded[2];
      state.remotePromptSettings = (loaded[3] && loaded[3].prompt) || {};
      state.debugMode = Boolean(state.runtime && state.runtime.debugMode);
      syncOfficialSettingsStore();
      syncActiveSelectors();
      renderDiagnostics();
      setStatus("model-status", "配置已从本机 SQLite 读取；模型调用与关系时间线已接入。", "success");
    } catch (error) {
      setStatus("model-status", "无法连接本地回信服务：" + error.message, "error");
      var section = document.getElementById(SECTION_ID);
      var badge = section && section.querySelector('[data-role="service-badge"]');
      if (badge) badge.textContent = "服务断开";
      renderPatchVersion(null);
    }
  }

  function findSettingsContainer() {
    var items = Array.prototype.slice.call(document.querySelectorAll("main .tp-settings-item"));
    if (!items.length) return null;
    var first = items[0];
    return first.parentElement && first.parentElement.children.length ? first.parentElement : null;
  }

  function mountSettingsSection() {
    if (!isSettingsRoute() || state.mounting) return;
    var container = findSettingsContainer();
    if (!container) return;
    var localSection = document.getElementById(SECTION_ID);
    var patchSection = document.getElementById(PATCH_VERSION_SECTION_ID);
    if (localSection && patchSection) return;
    state.mounting = true;
    installStyles();
    var createdLocal = false;
    if (!localSection) {
      localSection = document.createElement("section");
      localSection.id = SECTION_ID;
      localSection.className = "tp-settings-item";
      localSection.innerHTML = sectionHtml();
      var account = Array.prototype.slice.call(container.children).find(function (child) {
        return child.querySelector && child.querySelector(".tp-settings-user-icon");
      });
      if (account && account.nextSibling) container.insertBefore(localSection, account.nextSibling);
      else container.insertBefore(localSection, container.firstChild);
      bindSection(localSection);
      createdLocal = true;
    }
    if (!patchSection) {
      patchSection = document.createElement("section");
      patchSection.id = PATCH_VERSION_SECTION_ID;
      patchSection.className = "tp-settings-item";
      patchSection.innerHTML = patchVersionSectionHtml();
    }
    bindPatchVersionSection(patchSection);
    container.insertBefore(patchSection, localSection);
    state.mounting = false;
    if (createdLocal) loadConfig();
    else if (state.diagnostics) renderDiagnostics();
  }

  var LOCAL_NAVIGATION_ID = "local-mail-local-navigation";
  var LOCAL_NAVIGATION_ROUTES = Object.freeze({ mail: "/collection", music: "/studio" });
