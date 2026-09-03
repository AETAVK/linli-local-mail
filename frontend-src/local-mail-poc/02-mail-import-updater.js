
  function formatUpdateBytes(value) {
    var bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return "大小未知";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function updateSourceLabel(source) {
    if (source === "gitee") return "Gitee 国内镜像";
    if (source === "github") return "GitHub Releases";
    return "公开发布源";
  }

  function ensureUpdateModal() {
    var backdrop = document.getElementById(UPDATE_MODAL_ID);
    if (backdrop) return backdrop;
    installStyles();
    backdrop = document.createElement("div");
    backdrop.id = UPDATE_MODAL_ID;
    backdrop.className = "lm-modal-backdrop";
    backdrop.hidden = true;
    backdrop.innerHTML =
      '<div class="lm-modal lm-update-dialog" role="dialog" aria-modal="true" aria-labelledby="lm-update-title">' +
      '<div class="lm-update-heading"><div class="lm-modal-title" id="lm-update-title" data-role="update-title">检查补丁更新</div></div>' +
      '<div class="lm-update-copy" data-role="update-copy"></div>' +
      '<div class="lm-update-version" data-role="update-version" hidden>' +
      '<span class="lm-update-version-current" data-role="update-current"></span>' +
      '<span class="lm-update-version-arrow">→</span>' +
      '<span class="lm-update-version-latest" data-role="update-latest"></span></div>' +
      '<div class="lm-update-meta" data-role="update-meta"></div>' +
      '<div class="lm-update-releases" data-role="update-releases" hidden>' +
      '<div class="lm-update-releases-title">未更新版本的更新说明</div>' +
      '<div class="lm-update-release-list" data-role="update-release-list"></div></div>' +
      '<div class="lm-update-warning" data-role="update-warning" hidden></div>' +
      '<div class="lm-modal-actions"><span class="lm-modal-status" data-role="update-status"></span>' +
      '<button class="lm-button" type="button" data-update-action="close">稍后</button>' +
      '<button class="lm-button lm-button-primary" type="button" data-update-action="apply" hidden>更新到最新版</button></div>' +
      '</div>';
    backdrop.addEventListener("click", function (event) {
      var button = event.target.closest("[data-update-action]");
      if (button) {
        if (button.dataset.updateAction === "close") closeUpdateModal();
        else if (button.dataset.updateAction === "apply") applyUpdate();
        return;
      }
      if (event.target === backdrop) closeUpdateModal();
    });
    backdrop.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeUpdateModal();
    });
    document.body.appendChild(backdrop);
    return backdrop;
  }

  function renderUpdateReleaseNotes(modal, result) {
    var section = modal.querySelector('[data-role="update-releases"]');
    var list = modal.querySelector('[data-role="update-release-list"]');
    if (!section || !list) return;
    list.textContent = "";
    var releases = result && Array.isArray(result.pendingReleases) ? result.pendingReleases : [];
    if (!releases.length) {
      section.hidden = true;
      return;
    }
    releases.forEach(function (release) {
      var card = document.createElement("div");
      card.className = "lm-update-release";
      var head = document.createElement("div");
      head.className = "lm-update-release-head";
      var version = document.createElement("span");
      version.className = "lm-update-release-version";
      version.textContent = "v" + String(release.version || "");
      var name = document.createElement("span");
      name.className = "lm-update-release-name";
      name.textContent = String(release.name || release.tag || "");
      head.appendChild(version);
      head.appendChild(name);
      card.appendChild(head);
      if (release.publishedAt) {
        var date = document.createElement("div");
        date.className = "lm-update-release-date";
        var parsedDate = new Date(release.publishedAt);
        date.textContent = Number.isNaN(parsedDate.getTime())
          ? String(release.publishedAt)
          : parsedDate.toLocaleDateString();
        card.appendChild(date);
      }
      var notes = document.createElement("div");
      notes.className = "lm-update-release-notes";
      notes.textContent = String(release.notes || "该版本未提供更新说明。");
      card.appendChild(notes);
      list.appendChild(card);
    });
    section.hidden = false;
  }

  function renderUpdateModal(kind, result, errorMessage) {
    var modal = ensureUpdateModal();
    var title = modal.querySelector('[data-role="update-title"]');
    var copy = modal.querySelector('[data-role="update-copy"]');
    var version = modal.querySelector('[data-role="update-version"]');
    var current = modal.querySelector('[data-role="update-current"]');
    var latest = modal.querySelector('[data-role="update-latest"]');
    var meta = modal.querySelector('[data-role="update-meta"]');
    var releases = modal.querySelector('[data-role="update-releases"]');
    var warning = modal.querySelector('[data-role="update-warning"]');
    var status = modal.querySelector('[data-role="update-status"]');
    var close = modal.querySelector('[data-update-action="close"]');
    var apply = modal.querySelector('[data-update-action="apply"]');
    current.textContent = "";
    latest.textContent = "";
    version.hidden = true;
    releases.querySelector('[data-role="update-release-list"]').textContent = "";
    releases.hidden = true;
    warning.textContent = "";
    warning.hidden = true;
    status.textContent = "";
    status.dataset.kind = "";
    meta.textContent = "";
    apply.hidden = true;
    apply.disabled = false;
    apply.textContent = "更新到最新版";
    close.hidden = false;
    close.disabled = false;
    close.textContent = "关闭";

    if (kind === "checking") {
      title.textContent = "检查补丁更新";
      copy.textContent = "正在连接公开发布源，请稍候……";
      close.textContent = "取消显示";
    } else if (kind === "available") {
      title.textContent = "发现补丁更新";
      copy.textContent = "检测到新的林离本地回信补丁。确认后会在本机下载并校验安装包，再启动更新程序。";
      current.textContent = "v" + result.currentVersion;
      latest.textContent = "v" + result.latestVersion;
      version.hidden = false;
      meta.textContent = updateSourceLabel(result.source) + " · " + formatUpdateBytes(result.installer && result.installer.size);
      renderUpdateReleaseNotes(modal, result);
      warning.textContent = "更新会停止本地回信服务。安装完成前请勿寄信；安装成功后需要重新启动游戏。";
      warning.hidden = false;
      close.textContent = "稍后";
      apply.hidden = false;
      apply.disabled = false;
      apply.textContent = "更新到最新版";
    } else if (kind === "current") {
      title.textContent = "补丁已是最新版本";
      copy.textContent = "当前安装的是 v" + result.currentVersion + "，公开发布源没有更高的稳定版本。";
      meta.textContent = "检查时间：" + new Date(result.checkedAt).toLocaleString();
    } else if (kind === "failed") {
      title.textContent = "检查更新失败";
      copy.textContent = "暂时无法完成补丁更新检查。现有本地回信功能不会受到影响。";
      status.textContent = errorMessage || "请稍后重试";
      status.dataset.kind = "error";
    } else if (kind === "applying") {
      title.textContent = "正在准备更新";
      copy.textContent = "正在下载安装包并进行 SHA-256 完整性校验，可能需要几分钟。请保持网络连接。";
      if (result) {
        current.textContent = "v" + result.currentVersion;
        latest.textContent = "v" + result.latestVersion;
        version.hidden = false;
      }
      warning.textContent = "校验通过前不会运行安装包。请不要关闭游戏或本地回信服务。";
      warning.hidden = false;
      close.disabled = true;
      close.textContent = "正在处理";
    } else if (kind === "launched") {
      var deferred = Boolean(result && (result.deferred || result.scheduled));
      title.textContent = deferred ? "更新已准备" : "更新程序已启动";
      copy.textContent = deferred
        ? "更新已准备，完全退出游戏后会自动安装。"
        : "安装程序已经打开，本地回信服务将自动退出。请按安装程序提示完成更新，然后重新启动游戏。";
      warning.textContent = deferred
        ? "请完全退出游戏；退出后更新程序会自动安装准备好的版本。"
        : "如果安装窗口被其他窗口遮挡，请在任务栏中查找“林离本地回信”安装程序。";
      warning.hidden = false;
      status.textContent = "目标版本：v" + (result && result.version ? result.version : "");
      status.dataset.kind = "success";
    }
    modal.hidden = false;
  }

  function closeUpdateModal() {
    if (state.update.applying) return;
    var modal = document.getElementById(UPDATE_MODAL_ID);
    if (modal) modal.hidden = true;
  }

  async function checkForUpdate(manual) {
    if (state.update.checking || state.update.applying) {
      if (manual && state.update.checking) renderUpdateModal("checking");
      return;
    }
    state.update.checking = true;
    if (manual) renderUpdateModal("checking");
    try {
      var result = await callApi("/api/update/check", { params: { force: manual ? 1 : 0 } });
      state.update.result = result;
      if (result.updateAvailable) renderUpdateModal("available", result);
      else if (manual) renderUpdateModal("current", result);
    } catch (error) {
      if (manual) renderUpdateModal("failed", null, error.message);
    } finally {
      state.update.checking = false;
    }
  }

  async function applyUpdate() {
    var result = state.update.result;
    if (!result || !result.updateAvailable || state.update.applying) return;
    state.update.applying = true;
    renderUpdateModal("applying", result);
    try {
      var applied = await callApi("/api/update/apply", {
        method: "POST",
        body: { version: result.latestVersion }
      });
      state.update.applying = false;
      renderUpdateModal("launched", applied);
    } catch (error) {
      state.update.applying = false;
      renderUpdateModal("available", result);
      var modal = document.getElementById(UPDATE_MODAL_ID);
      var status = modal && modal.querySelector('[data-role="update-status"]');
      if (status) {
        status.textContent = "更新失败：" + error.message;
        status.dataset.kind = "error";
      }
    }
  }

  function scheduleAutomaticUpdateCheck() {
    if (state.update.autoStarted) return;
    state.update.autoStarted = true;
    window.setTimeout(function () { checkForUpdate(false); }, 8000);
  }

  function mailboxImportModalHtml() {
    return '<div class="lm-modal lm-import-dialog" role="dialog" aria-modal="true" aria-labelledby="lm-import-title">' +
      '<div class="lm-import-title-row"><div class="lm-modal-title" id="lm-import-title">导入信件</div>' +
      '<button class="lm-import-close" type="button" aria-label="关闭" data-import-action="close">×</button></div>' +
      '<div class="lm-import-description">选择导入方式。导入后的信件会保存在本机，并显示在原信箱列表中。</div>' +
      '<div class="lm-import-methods lm-import-methods-four">' +
      '<button class="lm-import-method" type="button" data-import-mode="manual"><span class="lm-import-method-icon">文字</span>' +
      '<span class="lm-import-method-copy"><span class="lm-import-method-title">文字录入</span>' +
      '<span class="lm-import-method-desc">手动填写去信或回信，并保存为待导入草稿</span><span class="lm-import-method-note">默认方式，可稍后批量导入</span></span></button>' +
      '<button class="lm-import-method" type="button" data-import-mode="official"><span class="lm-import-method-icon">官方</span>' +
      '<span class="lm-import-method-copy"><span class="lm-import-method-title">一键导入官方历史</span>' +
      '<span class="lm-import-method-desc">直接读取官方服务器的全部信箱记录并导入</span><span class="lm-import-method-note">官方关服前可用；需本机官方客户端登录过</span></span></button>' +
      '<button class="lm-import-method" type="button" data-import-mode="file"><span class="lm-import-method-icon">文件</span>' +
      '<span class="lm-import-method-copy"><span class="lm-import-method-title">文件导入</span>' +
      '<span class="lm-import-method-desc">一次选择多个 JSON 或图片文件</span><span class="lm-import-method-note">JSON 可导入；图片 OCR 尚未实现</span></span></button>' +
       '<button class="lm-import-method" type="button" data-import-mode="share"><span class="lm-import-method-icon">链接</span>' +
       '<span class="lm-import-method-copy"><span class="lm-import-method-title">分享链接导入</span>' +
       '<span class="lm-import-method-desc">读取官方分享页对应的去信与回信</span><span class="lm-import-method-note">官方清理数据前可用</span></span></button>' +
       '</div>' +
       '<div class="lm-import-panel" data-import-panel="official">' +
       '<div class="lm-note" data-role="official-import-state">未检测到可用的官方登录状态时此方式不可用；检测与导入都只使用本机官方客户端日志中的会话，不占用每日写信额度，也不会触发模型回复。重复导入同一封信会更新现有记录。</div></div>' +
       '<div class="lm-import-panel" data-import-panel="share">' +
       '<label class="lm-field"><span>信件分享链接（一个链接一行）</span><textarea class="lm-textarea lm-share-import-input" data-role="share-import-url" rows="4" autocomplete="off" spellcheck="false" placeholder="https://web-…/single-pages/letterShare.html?uid=…&shareId=…\nhttps://web-…/single-pages/letterShare.html?uid=…&shareId=…"></textarea></label>' +
       '<div class="lm-note">支持一次粘贴多个链接，也支持从 Markdown 文本中逐行识别链接。重复导入同一封信会更新现有记录。</div></div>' +
       '<div class="lm-import-panel" data-import-panel="file">' +
       '<label class="lm-field"><span>选择文件（JSON / PNG / JPG / WEBP，可多选混合）</span><input class="lm-file" type="file" accept=".json,application/json,.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" multiple data-role="file-import-files"></label>' +
       '<div class="lm-file-import-list" data-role="file-import-list"></div>' +
       '<div class="lm-note">JSON 支持单封、数组或 { "letters": [...] }；重复导入同一封信会更新原记录。图片识别尚未实现：选择图片会在结果中明确标注“未导入”，不会影响同批 JSON 的导入。</div></div>' +
       '<div class="lm-import-panel" data-import-panel="manual">' +
       '<div class="lm-manual-import-grid">' +
       '<section class="lm-manual-import-side"><label class="lm-manual-import-side-head"><input type="checkbox" data-role="manual-sent-enabled">去信</label>' +
       '<label class="lm-field"><span>正文</span><textarea class="lm-textarea" data-role="manual-sent-text" rows="5" placeholder="可选：填写去信内容"></textarea></label>' +
       '<div class="lm-manual-import-grid"><label class="lm-field"><span>日期</span><input class="lm-input" type="date" data-role="manual-sent-date"></label>' +
       '<label class="lm-field"><span>时间（可选）</span><input class="lm-input" type="time" data-role="manual-sent-time"></label></div></section>' +
       '<section class="lm-manual-import-side"><label class="lm-manual-import-side-head"><input type="checkbox" data-role="manual-reply-enabled">来信</label>' +
       '<label class="lm-field"><span>正文</span><textarea class="lm-textarea" data-role="manual-reply-text" rows="5" placeholder="可选：填写来信内容"></textarea></label>' +
       '<div class="lm-manual-import-grid"><label class="lm-field"><span>日期</span><input class="lm-input" type="date" data-role="manual-reply-date"></label>' +
       '<label class="lm-field"><span>时间（可选）</span><input class="lm-input" type="time" data-role="manual-reply-time"></label></div></section>' +
       '</div><div class="lm-note">至少启用一侧并填写非空正文。去信启用时必须填写去信日期；仅录入来信时必须填写来信日期。同时录入去信和来信时，来信日期可留空表示未知。</div>' +
       '</div>' +
       '<div class="lm-draft-toolbar"><span class="lm-card-title" style="margin:0">待导入队列</span><span class="lm-status" data-role="draft-queue-status">正在读取…</span></div>' +
       '<div class="lm-draft-list" data-role="draft-list"></div>' +
       '<div class="lm-modal-actions"><span class="lm-modal-status" data-role="share-import-status">等待导入</span>' +
      '<button class="lm-button" type="button" data-import-action="close">取消</button>' +
      '<button class="lm-button" type="button" data-import-action="delete-drafts" disabled>删除所选</button>' +
      '<button class="lm-button lm-button-primary" type="button" data-import-action="commit-drafts" disabled>导入所选（0）</button>' +
      '<button class="lm-button lm-button-primary" type="button" data-import-action="submit">加入待导入</button></div>' +
      '</div>';
  }

  function setMailboxImportStatus(message, kind) {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    var status = modal && modal.querySelector('[data-role="share-import-status"]');
    if (!status) return;
    status.textContent = message;
    status.dataset.kind = kind || "";
  }

  function manualImportField(modal, role) {
    return modal && modal.querySelector('[data-role="' + role + '"]');
  }

  function manualImportSnapshot(modal) {
    if (!modal) return "";
    return JSON.stringify({
      sentEnabled: Boolean(manualImportField(modal, "manual-sent-enabled") && manualImportField(modal, "manual-sent-enabled").checked),
      sentText: String((manualImportField(modal, "manual-sent-text") || {}).value || ""),
      sentDate: String((manualImportField(modal, "manual-sent-date") || {}).value || ""),
      sentTime: String((manualImportField(modal, "manual-sent-time") || {}).value || ""),
      replyEnabled: Boolean(manualImportField(modal, "manual-reply-enabled") && manualImportField(modal, "manual-reply-enabled").checked),
      replyText: String((manualImportField(modal, "manual-reply-text") || {}).value || ""),
      replyDate: String((manualImportField(modal, "manual-reply-date") || {}).value || ""),
      replyTime: String((manualImportField(modal, "manual-reply-time") || {}).value || "")
    });
  }

  function manualImportHasUnsavedData(modal) {
    var snapshot = manualImportSnapshot(modal);
    if (!snapshot) return false;
    if (snapshot === state.importManualBaseline) return false;
    if (state.importEditingDraftId) return true;
    var values = JSON.parse(snapshot);
    return values.sentEnabled || values.sentText.trim() || values.sentDate || values.sentTime ||
      values.replyEnabled || values.replyText.trim() || values.replyDate || values.replyTime;
  }

  function manualImportSection(modal, side) {
    var enabled = manualImportField(modal, "manual-" + side + "-enabled");
    var text = manualImportField(modal, "manual-" + side + "-text");
    var date = manualImportField(modal, "manual-" + side + "-date");
    var time = manualImportField(modal, "manual-" + side + "-time");
    var available = Boolean(enabled && enabled.checked);
    var dateValue = available && date && date.value ? String(date.value) : null;
    var timeValue = available && time && time.value ? String(time.value) : null;
    return {
      available: available,
      text: available ? String(text && text.value || "").trim() : "",
      date: dateValue,
      time: timeValue,
      precision: dateValue ? (timeValue ? "minute" : "date") : null
    };
  }

  function readManualImportDraft(modal) {
    return { sent: manualImportSection(modal, "sent"), reply: manualImportSection(modal, "reply") };
  }

  function validateManualImportDraft(draft) {
    var sent = draft.sent;
    var reply = draft.reply;
    if ((!sent.available || !sent.text.trim()) && (!reply.available || !reply.text.trim())) return "请至少启用去信或回信，并填写非空正文";
    if (sent.available && !sent.text.trim()) return "去信已启用，请填写去信正文";
    if (reply.available && !reply.text.trim()) return "来信已启用，请填写来信正文";
    if (sent.available && !/^\d{4}-\d{2}-\d{2}$/.test(sent.date)) return "去信启用时必须填写去信日期";
    if (!sent.available && reply.available && !/^\d{4}-\d{2}-\d{2}$/.test(reply.date)) return "仅录入来信时必须填写来信日期";
    if (sent.available && sent.time && !sent.date || reply.available && reply.time && !reply.date) return "填写时间前必须先填写对应日期";
    if (sent.available && reply.available && sent.date && reply.date) {
      if (reply.date < sent.date) return "来信日期不能早于去信日期";
      if (reply.date === sent.date && sent.time && reply.time && reply.time < sent.time) return "同一天的来信时间不能早于去信时间";
    }
    return "";
  }

  function syncManualImportSideControls(modal) {
    ["sent", "reply"].forEach(function (side) {
      var enabled = manualImportField(modal, "manual-" + side + "-enabled");
      ["text", "date", "time"].forEach(function (kind) {
        var field = manualImportField(modal, "manual-" + side + "-" + kind);
        if (field) field.disabled = !enabled || !enabled.checked || state.importBusy;
      });
    });
  }

  function setManualImportForm(modal, draft) {
    var value = draft || { sent: {}, reply: {} };
    ["sent", "reply"].forEach(function (side) {
      var section = value[side] || {};
      var enabled = manualImportField(modal, "manual-" + side + "-enabled");
      var text = manualImportField(modal, "manual-" + side + "-text");
      var date = manualImportField(modal, "manual-" + side + "-date");
      var time = manualImportField(modal, "manual-" + side + "-time");
      if (enabled) enabled.checked = Boolean(section.available);
      if (text) text.value = String(section.text || "");
      if (date) date.value = String(section.date || "");
      if (time) time.value = String(section.time || "");
    });
    syncManualImportSideControls(modal);
    state.importManualBaseline = manualImportSnapshot(modal);
  }

  function setImportModalBusy(modal, busy) {
    if (!modal) return;
    Array.prototype.forEach.call(modal.querySelectorAll("button, input, textarea"), function (node) {
      node.disabled = Boolean(busy) || (node.dataset.role && /manual-(sent|reply)-(text|date|time)/.test(node.dataset.role) && !(manualImportField(modal, node.dataset.role.replace(/-(text|date|time)$/, "-enabled")) || {}).checked);
    });
    if (!busy) syncManualImportSideControls(modal);
  }

  function draftSelectedIds(modal) {
    return Array.prototype.map.call(modal.querySelectorAll('[data-role="draft-select"]'), function (input) {
      return input.checked ? input.dataset.draftId : null;
    }).filter(Boolean);
  }

  function draftSectionDate(draft) {
    var sent = draft && draft.sent || {};
    var reply = draft && draft.reply || {};
    var parts = [];
    if (sent.available) parts.push("去信 " + (sent.date || "日期未知") + (sent.time ? " " + sent.time : ""));
    if (reply.available) parts.push("来信 " + (reply.date || "时间未知") + (reply.time ? " " + reply.time : ""));
    return parts.join(" · ") || "日期未填写";
  }

  function draftPreview(draft) {
    var parts = [];
    if (draft && draft.sent && draft.sent.available && draft.sent.text) parts.push("去信：" + draft.sent.text);
    if (draft && draft.reply && draft.reply.available && draft.reply.text) parts.push("来信：" + draft.reply.text);
    return parts.join(" · ") || "暂无正文";
  }

  function draftSourceLabel(draft) {
    var sourceType = String(draft && (draft.sourceType || draft.source) || "manual-entry");
    return sourceType === "manual-entry" || sourceType === "manual" || sourceType === "手动" ? "文字录入" : sourceType;
  }

  function draftStatusLabel(draft) {
    return String(draft && draft.status || "ready") === "error" ? "需修正" : "待导入";
  }

  function renderImportDraftQueue() {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    var list = modal && modal.querySelector('[data-role="draft-list"]');
    var status = modal && modal.querySelector('[data-role="draft-queue-status"]');
    if (!list) return;
    var drafts = Array.isArray(state.importDrafts) ? state.importDrafts : [];
    if (status) status.textContent = drafts.length ? drafts.length + " 条草稿" : "暂无草稿";
    list.innerHTML = drafts.length ? drafts.map(function (draft) {
      var error = draft.lastError || draft.error || draft.errorMessage || draft.message;
      return '<article class="lm-draft-card"><input type="checkbox" data-role="draft-select" data-draft-id="' + escapeHtml(draft.draftId || draft.id || "") + '">' +
        '<div class="lm-draft-main"><div class="lm-draft-head"><span>' + escapeHtml(draftSourceLabel(draft)) + '</span><span class="lm-draft-state" data-kind="' + (draft.status === "error" ? "error" : "ready") + '">' + escapeHtml(draftStatusLabel(draft)) + '</span></div>' +
        '<div class="lm-draft-meta">' + escapeHtml(draftSectionDate(draft)) + '</div>' +
        '<div class="lm-draft-meta">草稿编号：' + escapeHtml(draft.draftId || draft.id || "未知") + '</div>' +
        '<div class="lm-draft-preview">' + escapeHtml(draftPreview(draft)) + '</div>' +
        (error ? '<div class="lm-draft-error">' + escapeHtml(error) + '</div>' : "") + '</div>' +
        '<div class="lm-draft-actions"><button class="lm-button lm-button-small" type="button" data-import-action="edit-draft" data-draft-id="' + escapeHtml(draft.draftId || draft.id || "") + '">编辑</button></div></article>';
    }).join("") : '<div class="lm-empty">待导入队列为空</div>';
    updateDraftQueueActions(modal);
  }

  function updateDraftQueueActions(modal) {
    if (!modal) return;
    var ids = draftSelectedIds(modal);
    var commit = modal.querySelector('[data-import-action="commit-drafts"]');
    var remove = modal.querySelector('[data-import-action="delete-drafts"]');
    if (commit) { commit.disabled = state.importDraftBusy || !ids.length; commit.textContent = "导入所选（" + ids.length + "）"; }
    if (remove) remove.disabled = state.importDraftBusy || !ids.length;
  }

  async function loadImportDrafts() {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    var status = modal && modal.querySelector('[data-role="draft-queue-status"]');
    if (status) status.textContent = "正在读取…";
    try {
      var data = await callApi("/api/import-drafts");
      state.importDrafts = Array.isArray(data && data.drafts) ? data.drafts : [];
      renderImportDraftQueue();
    } catch (error) {
      state.importDrafts = [];
      renderImportDraftQueue();
      if (status) status.textContent = "读取失败：" + (error && error.message ? error.message : "未知错误");
    }
  }

  async function submitManualImport() {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    if (!modal || state.importBusy || state.importMode !== "manual") return;
    var draft = readManualImportDraft(modal);
    var validation = validateManualImportDraft(draft);
    if (validation) { setMailboxImportStatus(validation, "error"); return; }
    var editing = state.importEditingDraftId;
    state.importBusy = true;
    setImportModalBusy(modal, true);
    setMailboxImportStatus(editing ? "正在保存修改…" : "正在加入待导入队列…", "");
    try {
      var result = await callApi(editing ? "/api/import-drafts/update" : "/api/import-drafts/create", {
        method: "POST",
        body: editing ? { draftId: editing, revision: state.importDraftRevision, sent: draft.sent, reply: draft.reply } : { sent: draft.sent, reply: draft.reply }
      });
      state.importEditingDraftId = null;
      state.importDraftRevision = null;
      setManualImportForm(modal, null);
      setMailboxImportStatus(editing ? "修改已保存" : "已加入待导入队列", "success");
      await loadImportDrafts();
      return result;
    } catch (error) {
      setMailboxImportStatus((editing ? "保存失败：" : "加入失败：") + error.message, "error");
    } finally {
      state.importBusy = false;
      setImportModalBusy(modal, false);
      renderManualImportControls(modal);
    }
  }

  async function deleteSelectedImportDrafts() {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    var ids = draftSelectedIds(modal);
    if (!modal || !ids.length || state.importDraftBusy) return;
    if (!window.confirm("确定删除选中的 " + ids.length + " 条待导入草稿？")) return;
    state.importDraftBusy = true;
    setImportModalBusy(modal, true);
    try {
      await callApi("/api/import-drafts/delete", { method: "POST", body: { draftIds: ids } });
      if (ids.indexOf(String(state.importEditingDraftId || "")) !== -1) {
        state.importEditingDraftId = null;
        state.importDraftRevision = null;
        setManualImportForm(modal, null);
      }
      await loadImportDrafts();
      setMailboxImportStatus("已删除选中的草稿", "success");
    } catch (error) {
      setMailboxImportStatus("删除失败：" + error.message, "error");
    } finally {
      state.importDraftBusy = false;
      setImportModalBusy(modal, false);
      updateDraftQueueActions(modal);
    }
  }

  function commitSuccessCount(result, requested) {
    var failed = Number(result && (result.failed != null ? result.failed : result.failedCount));
    if (result && Array.isArray(result.results)) {
      failed = result.results.filter(function (item) { return !item.ok; }).length;
      return result.results.filter(function (item) { return item.ok; }).length;
    }
    if (result && Array.isArray(result.items)) {
      failed = result.items.filter(function (item) { return !item.ok; }).length;
      return result.items.filter(function (item) { return item.ok; }).length;
    }
    if (!Number.isFinite(failed)) failed = 0;
    var count = Number(result && (result.committed != null ? result.committed : result.imported != null ? result.imported : result.successful));
    return Number.isFinite(count) ? count : failed ? 0 : requested;
  }

  async function commitSelectedImportDrafts() {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    var ids = draftSelectedIds(modal);
    if (!modal || !ids.length || state.importDraftBusy) return;
    if (state.importMode === "manual" && manualImportHasUnsavedData(modal)) {
      setMailboxImportStatus("请先保存或清空当前文字录入内容，再导入队列中的草稿。", "error");
      return;
    }
    state.importDraftBusy = true;
    setImportModalBusy(modal, true);
    setMailboxImportStatus("正在导入所选草稿…", "");
    try {
      var result = await callApi("/api/import-drafts/commit", { method: "POST", body: { draftIds: ids } });
      var successCount = commitSuccessCount(result, ids.length);
      var successfulIds = result && Array.isArray(result.results)
        ? result.results.filter(function (item) { return item.ok; }).map(function (item) { return String(item.draftId || ""); })
        : successCount === ids.length ? ids : [];
      if (successfulIds.indexOf(String(state.importEditingDraftId || "")) !== -1) {
        state.importEditingDraftId = null;
        state.importDraftRevision = null;
        setManualImportForm(modal, null);
      }
      await loadImportDrafts();
      if (successCount > 0) {
        setMailboxImportStatus("导入完成：成功 " + successCount + " 条" + (successCount < ids.length ? "，失败项仍保留在队列中" : "") + "。", successCount < ids.length ? "error" : "success");
        await refreshDiagnostics();
        if (mailboxHeader()) {
          try { window.location.reload(); } catch (error) { /* 刷新失败不阻塞 */ }
        }
      } else {
        setMailboxImportStatus("导入失败：失败项仍保留在队列中，请编辑后重试。", "error");
      }
    } catch (error) {
      setMailboxImportStatus("导入失败：" + error.message + "。草稿仍保留在队列中。", "error");
      await loadImportDrafts();
    } finally {
      state.importDraftBusy = false;
      setImportModalBusy(modal, false);
      updateDraftQueueActions(modal);
    }
  }

  function editImportDraft(draftId) {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    var draft = (state.importDrafts || []).find(function (item) { return String(item.draftId || item.id) === String(draftId); });
    if (!modal || !draft || state.importBusy || state.importDraftBusy) return;
    if (state.importMode === "manual" && manualImportHasUnsavedData(modal) &&
      !window.confirm("当前文字录入内容尚未保存，切换编辑会丢失这些修改，确定继续吗？")) return;
    state.importEditingDraftId = draft.draftId || draft.id;
    state.importDraftRevision = draft.revision;
    setManualImportForm(modal, draft);
    setMailboxImportMode("manual");
    setMailboxImportStatus("正在编辑草稿，可保存修改或取消编辑。", "");
    renderManualImportControls(modal);
  }

  function renderManualImportControls(modal) {
    if (!modal) return;
    var submit = modal.querySelector('[data-import-action="submit"]');
    var draftActions = modal.querySelectorAll('[data-import-action="delete-drafts"], [data-import-action="commit-drafts"]');
    var isManual = state.importMode === "manual";
    if (submit) {
      submit.textContent = isManual
        ? (state.importEditingDraftId ? "保存修改" : "加入待导入")
        : state.importMode === "official" ? "一键导入" : "导入";
      submit.hidden = false;
      submit.disabled = state.importBusy;
    }
    Array.prototype.forEach.call(draftActions, function (button) { button.hidden = !isManual; });
    syncManualImportSideControls(modal);
    updateDraftQueueActions(modal);
  }

  function fileImportKind(file) {
    var match = /\.(json|png|jpe?g|webp)$/i.exec(file.name || "");
    var extension = match ? match[1].toLowerCase() : "";
    if (extension === "json") return { kind: "json", label: "JSON" };
    if (extension === "png" || extension === "jpg" || extension === "jpeg" || extension === "webp") {
      return { kind: "image", label: "图片" };
    }
    return { kind: "unsupported", label: "不支持" };
  }

  function renderFileImportList() {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    var list = modal && modal.querySelector('[data-role="file-import-list"]');
    if (!list) return;
    if (!state.importFiles.length) {
      list.innerHTML = "";
      return;
    }
    list.innerHTML = state.importFiles.map(function (entry) {
      var statusHtml = entry.status
        ? '<span class="lm-file-import-status" data-kind="' + escapeHtml(entry.status) + '">' + escapeHtml(entry.message || "") + '</span>'
        : "";
      return '<div class="lm-file-import-row"><span class="lm-file-import-name">' + escapeHtml(entry.name) + '</span>' +
        '<span class="lm-file-import-kind">' + escapeHtml(entry.label) + '</span>' + statusHtml + '</div>';
    }).join("");
  }

  function setMailboxImportMode(mode) {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    if (!modal) return;
    var requestedMode = mode === "manual" ? "manual" : mode === "file" ? "file" : mode === "official" ? "official" : "share";
    if (state.importMode === "manual" && requestedMode !== "manual" && manualImportHasUnsavedData(modal)) {
      if (!window.confirm("切换导入方式会丢失尚未保存的文字录入内容，确定继续吗？")) return;
      setManualImportForm(modal, null);
      state.importEditingDraftId = null;
      state.importDraftRevision = null;
    }
    state.importMode = requestedMode;
    Array.prototype.forEach.call(modal.querySelectorAll("[data-import-mode]"), function (button) {
      button.dataset.active = String(button.dataset.importMode === state.importMode);
    });
    Array.prototype.forEach.call(modal.querySelectorAll("[data-import-panel]"), function (panel) {
      panel.hidden = panel.dataset.importPanel !== state.importMode;
    });
    var submit = modal.querySelector('[data-import-action="submit"]');
    var status = modal.querySelector('[data-role="official-import-state"]');
    renderManualImportControls(modal);
    if (state.importMode === "manual") {
      setMailboxImportStatus(state.importEditingDraftId ? "正在编辑草稿" : "填写后加入待导入队列", "");
      return;
    }
    if (state.importMode === "official") {
      // 一键导入没有额外输入：按钮文案与状态提示都在此设置，检测不阻塞选择
      submit.textContent = "一键导入";
      submit.disabled = state.importBusy;
      setMailboxImportStatus(state.importBusy ? "导入进行中…" : "点击“一键导入”后才会访问官方接口", "");
      if (status) {
        refreshOfficialImportState(status);
      }
      return;
    }
    submit.textContent = "导入";
    submit.hidden = false;
    submit.disabled = state.importMode === "file" && state.importFiles.length === 0;
    if (state.importMode === "share") {
      setMailboxImportStatus("等待导入", "");
    } else {
      renderFileImportList();
      setMailboxImportStatus(state.importFiles.length
        ? "已选择 " + state.importFiles.length + " 个文件（JSON 会导入，图片暂不支持）"
        : "请选择一个或多个 JSON / 图片文件", "");
    }
  }

  // 本地只读检测（无网络请求）：更新官方面板的可用性提示
  async function refreshOfficialImportState(statusBox) {
    try {
      var data = await callApi("/api/remote-import/detect");
      var prompt = data.prompt || {};
      var disabled = prompt.promptDisabled || Number(prompt.snoozedUntil) > Date.now() / 1000;
      if (!data.found) {
        statusBox.textContent = "当前未检测到可用的官方登录状态（" + (data.message || data.code || "未找到凭证") + "）。请先启动官方游戏并登录，再回到此页面。";
        return;
      }
      var localCount = Number(data.importedOfficialCount);
      var line = "已检测到官方登录状态（账户 " + (data.account || "未知") + "），可以一键导入。";
      if (Number.isFinite(localCount) && localCount > 0) {
        line += "本地已有 " + localCount + " 封官方信件，重复导入会更新原记录。";
      }
      if (disabled) line += "（提示已按你的选择关闭，不影响手动导入。）";
      statusBox.textContent = line;
    } catch (error) {
      statusBox.textContent = "本地服务检测失败：" + (error && error.message ? error.message : "未知错误") + "。请确认本地服务已启动。";
    }
  }

  async function startOfficialOneClickImport() {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    if (!modal || state.importBusy) return;
    var submit = modal.querySelector('[data-import-action="submit"]');
    state.importBusy = true;
    submit.disabled = true;
    submit.textContent = "导入中…";
    setMailboxImportStatus("正在开始官方导入…", "");
    try {
      await callApi("/api/remote-import/start", { method: "POST", body: "{}" });
      // 复用小窗的轮询；完成后结果会写回弹窗状态行
      await pollOfficialImportInModal();
    } catch (error) {
      setMailboxImportStatus("导入失败：" + (error && error.message ? error.message : "未知错误") + "\n可以稍后重试。", "error");
      state.importBusy = false;
      submit.disabled = false;
      submit.textContent = "一键导入";
    }
  }

  function pollOfficialImportInModal() {
    return new Promise(function (resolve) {
      var timer = window.setInterval(async function () {
        var status;
        try {
          status = await callApi("/api/remote-import/status");
        } catch (error) {
          return; // 瞬时失败继续轮询
        }
        if (REMOTE_ACTIVE_STATES.indexOf(status.state) !== -1) {
          var text = status.message || "正在导入…";
          if (Number.isFinite(status.percent) && status.percent > 0) text += "（" + status.percent + "%）";
          setMailboxImportStatus(text, "");
          return;
        }
        window.clearInterval(timer);
        var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
        var submit = modal && modal.querySelector('[data-import-action="submit"]');
        if (submit) {
          submit.disabled = false;
          submit.textContent = "一键导入";
        }
        state.importBusy = false;
        if (status.state === "completed" || status.state === "partial") {
          var summary = "导入完成：新增 " + status.inserted + " 封，更新 " + status.updated + " 封";
          if (status.conflicts) summary += "，重复 " + status.conflicts + " 封（本地已有，内容已保留）";
          if (status.failed) summary += "，失败 " + status.failed + " 封";
          if (status.videoSaved) summary += "，已保存视频 " + status.videoSaved + " 个";
          setMailboxImportStatus(summary + "。信箱即将自动刷新…", Number(status.failed) && !Number(status.imported) ? "error" : "success");
          window.setTimeout(function () {
            if (!mailboxHeader()) return;
            try { window.location.reload(); } catch (error) { /* 刷新失败不阻塞 */ }
          }, 3500);
        } else {
          setMailboxImportStatus((status.message || "导入失败。") + "\n可以稍后重试。", "error");
        }
        resolve(status);
      }, 800);
    });
  }

  function closeMailboxImportModal() {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    if (!modal || state.importBusy || state.importDraftBusy) return;
    if (state.importMode === "manual" && manualImportHasUnsavedData(modal) && !window.confirm("尚未保存的文字录入内容会丢失，确定关闭吗？")) return;
    if (state.importMode === "manual") {
      state.importEditingDraftId = null;
      state.importDraftRevision = null;
      setManualImportForm(modal, null);
    }
    modal.hidden = true;
  }

  async function submitShareLinkImport() {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    if (!modal || state.importBusy || state.importMode !== "share") return;
    var input = modal.querySelector('[data-role="share-import-url"]');
    var submit = modal.querySelector('[data-import-action="submit"]');
    var rawLines = input.value.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
    if (!rawLines.length) {
      setMailboxImportStatus("请先粘贴分享链接", "error");
      input.focus();
      return;
    }
    if (rawLines.length > 50) {
      setMailboxImportStatus("单次最多导入 50 个分享链接", "error");
      return;
    }
    state.importBusy = true;
    submit.disabled = true;
    submit.textContent = "正在导入…";
    setMailboxImportStatus("正在读取官方分享数据…", "");
    try {
      var result = await callApi("/api/import/share-link", {
        method: "POST",
        body: JSON.stringify({ urls: rawLines })
      });
      var results = Array.isArray(result.results) ? result.results : [];
      var failed = results.filter(function (item) { return !item.ok; });
      var successCount = Number(result.imported || 0);
      var message = "处理完成：成功 " + successCount + " 封（新增 " + Number(result.inserted || 0) + "，更新 " + Number(result.updated || 0) + "）";
      if (failed.length) {
        var details = failed.slice(0, 4).map(function (item) { return "第 " + item.lineNumber + " 行：" + item.message; });
        if (failed.length > 4) details.push("其余失败项请检查后重试");
        message += "\n失败 " + failed.length + " 项：" + details.join("；");
        input.value = failed.map(function (item) { return rawLines[item.index]; }).join("\n");
        setMailboxImportStatus(message, successCount ? "success" : "error");
      } else {
        message += "；信箱会自动刷新。";
        input.value = "";
        setMailboxImportStatus(message, "success");
      }
      await refreshDiagnostics();
    } catch (error) {
      setMailboxImportStatus("导入失败：" + error.message, "error");
    } finally {
      state.importBusy = false;
      submit.disabled = false;
      submit.textContent = "导入";
    }
  }

  async function submitFileImport() {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    if (!modal || state.importBusy || state.importMode !== "file") return;
    var input = modal.querySelector('[data-role="file-import-files"]');
    var submit = modal.querySelector('[data-import-action="submit"]');
    if (!state.importFiles.length) {
      setMailboxImportStatus("请先选择一个或多个文件", "error");
      input.focus();
      return;
    }
    state.importBusy = true;
    submit.disabled = true;
    submit.textContent = "正在导入…";
    setMailboxImportStatus("正在读取文件…", "");
    var files = state.importFiles;
    var jsonFiles = files.filter(function (entry) { return entry.kind === "json"; });
    files.forEach(function (entry) {
      entry.status = entry.kind === "json" ? "pending" : entry.kind;
      entry.message = "";
    });
    renderFileImportList();
    try {
      var server = null;
      if (jsonFiles.length) {
        var entries = [];
        for (var i = 0; i < jsonFiles.length; i += 1) {
          entries.push({ name: jsonFiles[i].file.name, content: await jsonFiles[i].file.text() });
        }
        server = await callApi("/api/import/files", {
          method: "POST",
          body: JSON.stringify({ files: entries })
        });
      }
      if (server && Array.isArray(server.results)) {
        server.results.forEach(function (item, index) {
          var entry = jsonFiles[index];
          if (!entry) return;
          if (item.ok) {
            if (item.partial || Number(item.skipped || 0) > 0) {
              entry.status = "partial";
              entry.message = "部分导入（新增 " + Number(item.inserted || 0) + "，更新 " + Number(item.updated || 0) +
                "，跳过 " + Number(item.skipped || 0) + "）";
            } else {
              entry.status = "success";
              entry.message = "已导入（新增 " + Number(item.inserted || 0) + "，更新 " + Number(item.updated || 0) + "）";
            }
          } else {
            entry.status = "error";
            entry.message = item.message || "导入失败";
          }
        });
      }
      files.forEach(function (entry) {
        if (entry.kind === "image") {
          entry.status = "unsupported";
          entry.message = "图片识别功能尚未实现，文件未导入";
        } else if (entry.kind === "unsupported") {
          entry.status = "error";
          entry.message = "不支持的文件类型";
        }
      });
      renderFileImportList();
      var counts = server || { imported: 0, inserted: 0, updated: 0, skipped: 0, unsupported: 0, failed: 0 };
      var unsupportedCount = files.filter(function (entry) { return entry.kind === "image" || entry.kind === "unsupported"; }).length;
      var message = "处理完成：共 " + files.length + " 个文件，导入 " + Number(counts.imported || 0) + " 封（新增 " +
        Number(counts.inserted || 0) + "，更新 " + Number(counts.updated || 0) + "）";
      if (unsupportedCount) message += "，未支持 " + unsupportedCount + " 个（图片 OCR 尚未实现）";
      if (counts.failed) message += "，失败 " + counts.failed + " 个";
      if (counts.skipped) message += "，跳过 " + counts.skipped + " 封";
      message += "；信箱会自动刷新。";
      setMailboxImportStatus(message, Number(counts.failed) && !Number(counts.imported) ? "error" : "success");
      await refreshDiagnostics();
    } catch (error) {
      setMailboxImportStatus("导入失败：" + error.message, "error");
    } finally {
      state.importBusy = false;
      submit.disabled = state.importFiles.length === 0;
      submit.textContent = "导入";
    }
  }

  function bindMailboxImportModal(modal) {
    modal.addEventListener("click", function (event) {
      if (event.target === modal) { closeMailboxImportModal(); return; }
      var modeButton = event.target.closest("[data-import-mode]");
      if (modeButton) { setMailboxImportMode(modeButton.dataset.importMode); return; }
      var actionButton = event.target.closest("[data-import-action]");
      if (!actionButton) return;
      if (actionButton.dataset.importAction === "close") closeMailboxImportModal();
       else if (actionButton.dataset.importAction === "delete-drafts") deleteSelectedImportDrafts();
       else if (actionButton.dataset.importAction === "commit-drafts") commitSelectedImportDrafts();
       else if (actionButton.dataset.importAction === "edit-draft") editImportDraft(actionButton.dataset.draftId);
       else if (actionButton.dataset.importAction === "submit") {
         if (state.importMode === "file") submitFileImport();
         else if (state.importMode === "official") startOfficialOneClickImport();
         else if (state.importMode === "share") submitShareLinkImport();
         else submitManualImport();
       }
     });
    modal.addEventListener("input", function (event) {
      if (event.target.dataset && /^manual-(sent|reply)-/.test(event.target.dataset.role || "")) {
        if (event.target.dataset.role.indexOf("enabled") !== -1) syncManualImportSideControls(modal);
        if (state.importMode === "manual") renderManualImportControls(modal);
      }
    });
    modal.addEventListener("change", function (event) {
      if (event.target.dataset.role === "draft-select") { updateDraftQueueActions(modal); return; }
      if (/^manual-(sent|reply)-enabled$/.test(event.target.dataset.role || "")) {
        syncManualImportSideControls(modal);
        return;
      }
      if (event.target.dataset.role !== "file-import-files") return;
      state.importFiles = Array.prototype.slice.call(event.target.files || []).map(function (file) {
        var kind = fileImportKind(file);
        return { file: file, name: file.name, kind: kind.kind, label: kind.label, status: "", message: "" };
      });
      renderFileImportList();
      setMailboxImportMode("file");
    });
    modal.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && event.ctrlKey && event.target.matches('[data-role="share-import-url"]')) {
        event.preventDefault();
        submitShareLinkImport();
      } else if (event.key === "Escape") {
        closeMailboxImportModal();
      }
    });
  }

  function ensureMailboxImportModal() {
    var modal = document.getElementById(MAILBOX_IMPORT_MODAL_ID);
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = MAILBOX_IMPORT_MODAL_ID;
    modal.className = "lm-modal-backdrop";
    modal.hidden = true;
    modal.innerHTML = mailboxImportModalHtml();
    document.body.appendChild(modal);
    bindMailboxImportModal(modal);
    setMailboxImportMode("manual");
    return modal;
  }

  function openMailboxImportModal() {
    installStyles();
    var modal = ensureMailboxImportModal();
    modal.hidden = false;
    setMailboxImportMode("manual");
    loadImportDrafts();
  }

  var REMOTE_TOAST_ID = "local-mail-remote-import-toast";
  var REMOTE_ACTIVE_STATES = ["detecting", "authenticating", "fetching_letters", "fetching_details", "importing"];

  function mailboxHeader() {
    var header = document.querySelector("main .mail-header");
    return header && header.querySelector(".text-text-title.text-title-m") ? header : null;
  }

  function syncRemoteToastVisibility() {
    var toast = document.getElementById(REMOTE_TOAST_ID);
    if (!toast) return;
    toast.hidden = !mailboxHeader() || !state.remoteImport.candidate;
  }

  function remoteToastHtml() {
    return '<div class="local-mail-remote-import-title">检测到本机可能存在官方信箱历史记录</div>' +
      '<button class="local-mail-remote-import-close" type="button" aria-label="关闭" data-remote-action="close">×</button>' +
      '<div class="local-mail-remote-import-body">可以读取官方客户端的最近信箱记录并写入本地邮箱；已有视频回信会同时保存到本机供原邮箱播放。导入不占用每日写信额度，也不会自动触发模型回复；只有点击“导入历史”后才会访问官方接口。</div>' +
      '<div class="local-mail-remote-import-body" data-role="remote-local-state" hidden></div>' +
      '<div class="local-mail-remote-import-actions" data-role="remote-actions">' +
      '<button class="local-mail-remote-import-button local-mail-remote-import-button-primary" type="button" data-remote-action="start">导入历史</button>' +
      '<button class="local-mail-remote-import-button" type="button" data-remote-action="snooze">稍后</button>' +
      '<button class="local-mail-remote-import-button" type="button" data-remote-action="disable">不再提示</button>' +
      '</div>' +
      '<div class="local-mail-remote-import-status" data-role="remote-status"></div>';
  }

  function ensureRemoteImportToast() {
    var toast = document.getElementById(REMOTE_TOAST_ID);
    if (toast) return toast;
    toast = document.createElement("div");
    toast.id = REMOTE_TOAST_ID;
    toast.className = "local-mail-remote-import-toast";
    toast.hidden = true;
    toast.innerHTML = remoteToastHtml();
    document.body.appendChild(toast);
    bindRemoteImportToast(toast);
    return toast;
  }

  function setRemoteStatus(message, kind) {
    var toast = document.getElementById(REMOTE_TOAST_ID);
    var status = toast && toast.querySelector('[data-role="remote-status"]');
    if (!status) return;
    status.textContent = message;
    status.dataset.kind = kind || "";
  }

  function renderRemoteActions(mode) {
    var toast = document.getElementById(REMOTE_TOAST_ID);
    var actions = toast && toast.querySelector('[data-role="remote-actions"]');
    if (!actions) return;
    if (mode === "running") {
      actions.innerHTML = '<button class="local-mail-remote-import-button" type="button" data-remote-action="cancel">取消</button>';
    } else if (mode === "retry") {
      actions.innerHTML = '<button class="local-mail-remote-import-button local-mail-remote-import-button-primary" type="button" data-remote-action="retry">重试</button>' +
        '<button class="local-mail-remote-import-button" type="button" data-remote-action="snooze">稍后</button>' +
        '<button class="local-mail-remote-import-button" type="button" data-remote-action="disable">不再提示</button>';
    } else if (mode === "done") {
      actions.innerHTML = "";
    } else {
      actions.innerHTML = '<button class="local-mail-remote-import-button local-mail-remote-import-button-primary" type="button" data-remote-action="start">导入历史</button>' +
        '<button class="local-mail-remote-import-button" type="button" data-remote-action="snooze">稍后</button>' +
        '<button class="local-mail-remote-import-button" type="button" data-remote-action="disable">不再提示</button>';
    }
  }

  function hideRemoteToast() {
    var toast = document.getElementById(REMOTE_TOAST_ID);
    if (toast) toast.hidden = true;
  }

  function stopRemotePolling() {
    if (state.remoteImport.pollTimer) {
      window.clearInterval(state.remoteImport.pollTimer);
      state.remoteImport.pollTimer = null;
    }
  }

  async function setRemotePrompt(action) {
    try {
      await callApi("/api/remote-import/prompt", {
        method: "POST",
        body: JSON.stringify({ action: action })
      });
    } catch (error) {
      // 非阻塞：提示偏好保存失败不打断用户
    }
  }

  async function startRemoteImport() {
    var toast = document.getElementById(REMOTE_TOAST_ID);
    if (!toast || state.remoteImport.running) return;
    state.remoteImport.candidate = true;
    state.remoteImport.running = true;
    renderRemoteActions("running");
    setRemoteStatus("正在开始导入…", "");
    try {
      await callApi("/api/remote-import/start", { method: "POST", body: "{}" });
      pollRemoteStatus();
    } catch (error) {
      state.remoteImport.running = false;
      setRemoteStatus(error.message + "\n可以点击“重试”再次尝试。", "error");
      renderRemoteActions("retry");
    }
  }

  function pollRemoteStatus() {
    stopRemotePolling();
    state.remoteImport.pollTimer = window.setInterval(async function () {
      var status;
      try {
        status = await callApi("/api/remote-import/status");
      } catch (error) {
        setRemoteStatus("读取导入状态失败：" + error.message, "error");
        return;
      }
      state.remoteImport.lastStatus = status;
      if (REMOTE_ACTIVE_STATES.indexOf(status.state) !== -1) {
        var text = status.message || "正在导入…";
        if (Number.isFinite(status.percent) && status.percent > 0) text += "（" + status.percent + "%）";
        setRemoteStatus(text, "");
        return;
      }
      stopRemotePolling();
      state.remoteImport.running = false;
      if (status.state === "completed" || status.state === "partial") {
        var summary = "已导入 " + status.imported + " 封，新增 " + status.inserted + " 封，更新 " + status.updated +
          " 封，跳过 " + status.skipped + " 封，失败 " + status.failed + " 封";
        if (status.conflicts) summary += "，重复 " + status.conflicts + " 封（本地已有，内容已保留）";
        if (status.videoSaved) summary += "，已保存视频 " + status.videoSaved + " 个";
        if (status.videoFailed) summary += "，视频保存失败 " + status.videoFailed + " 个";
        setRemoteStatus(summary + "\n邮箱即将自动刷新…", "success");
        renderRemoteActions("done");
        window.setTimeout(function () {
          if (!mailboxHeader()) return;
          try { window.location.reload(); } catch (error) { /* 刷新失败不阻塞 */ }
        }, 4000);
      } else {
        setRemoteStatus((status.message || "导入失败。") + "\n可以点击“重试”再次尝试。", "error");
        renderRemoteActions("retry");
      }
    }, 800);
  }

  function bindRemoteImportToast(toast) {
    toast.addEventListener("click", function (event) {
      var button = event.target.closest("[data-remote-action]");
      if (!button) return;
      var action = button.dataset.remoteAction;
      if (action === "start") startRemoteImport();
      else if (action === "retry") startRemoteImport();
      else if (action === "cancel") {
        callApi("/api/remote-import/cancel", { method: "POST", body: "{}" }).catch(function () {});
        setRemoteStatus("正在取消…", "");
      } else if (action === "snooze") {
        setRemotePrompt("snooze");
        stopRemotePolling();
        state.remoteImport.running = false;
        state.remoteImport.candidate = false;
        hideRemoteToast();
      } else if (action === "disable") {
        setRemotePrompt("disable");
        stopRemotePolling();
        state.remoteImport.running = false;
        state.remoteImport.candidate = false;
        hideRemoteToast();
        state.remotePromptSettings = { promptDisabled: true };
      } else if (action === "close") {
        state.remoteImport.candidate = false;
        hideRemoteToast();
      }
    });
  }

  // 把"本地已有多少封官方信件"写进小窗：官方仍未关服时，用户可能已导入过
  // 一部分；导入完成数（importedOfficialCount）与远端 found 数在任务开始/结束
  // 时都会刷新，帮助判断是否还需要再导入。foundCount 可为 null（检测阶段还没
  // 有远端数字，不额外发网络请求）。
  function setRemoteLocalState(foundCount, localCount) {
    var toast = document.getElementById(REMOTE_TOAST_ID);
    var box = toast && toast.querySelector('[data-role="remote-local-state"]');
    if (!box) return;
    var foundNumber = foundCount == null ? null : Number(foundCount);
    var localNumber = Number(localCount);
    if (!Number.isFinite(localNumber) || localNumber < 0) {
      box.hidden = true;
      box.textContent = "";
      return;
    }
    box.hidden = false;
    if (localNumber === 0) {
      box.textContent = "本地邮箱中还没有来自官方服务器的信件；下面的导入会把官方历史写入本地。";
    } else if (foundNumber != null && Number.isFinite(foundNumber) && foundNumber > 0) {
      box.textContent = "本地邮箱已有 " + localCount + " 封来自官方服务器的信件；本次检测到官方仍有 " + foundNumber + " 封可读取。重复导入同一封信会更新原记录，不会产生重复。";
    } else {
      box.textContent = "本地邮箱已有 " + localCount + " 封来自官方服务器的信件；重复导入同一封信会更新原记录，不会产生重复。";
    }
  }

  // 只在信箱页检测；网络或本地服务的瞬时失败不会锁死本次 CEF 会话，之后重新
  // 进入信箱仍可再试。候选状态与 DOM 节点分离，离开信箱时节点会立即隐藏。
  async function detectRemoteHistoryOnce() {
    if (state.remoteImport.checked || state.remoteImport.checking || Date.now() < state.remoteImport.retryAfter || !mailboxHeader()) return;
    state.remoteImport.checking = true;
    try {
      var data = await callApi("/api/remote-import/detect");
      state.remoteImport.checked = true;
      state.remoteImport.retryAfter = 0;
      state.remotePromptSettings = data.prompt || {};
      state.remoteImport.candidate = false;
      if (!data.found) return;
      var prompt = data.prompt || {};
      if (prompt.promptDisabled) return;
      if (Number(prompt.snoozedUntil) > Date.now() / 1000) return;
      if (prompt.lastSuccessAt && prompt.lastImportedAccount && prompt.lastImportedAccount === data.account) {
        var lastAt = Date.parse(prompt.lastSuccessAt);
        if (Number.isFinite(lastAt) && Date.now() - lastAt < 24 * 3600 * 1000) return;
      }
      ensureRemoteImportToast();
      renderRemoteActions("idle");
      setRemoteStatus("", "");
      // 远端 found 数要等"导入历史"真正访问官方接口才知道；检测阶段只用
      // 本地已导入数区分"从未导入"与"已导入过"，不额外发网络请求。
      var localCount = Number(data.importedOfficialCount);
      if (Number.isFinite(localCount)) {
        setRemoteLocalState(null, localCount);
      }
      state.remoteImport.candidate = true;
      syncRemoteToastVisibility();
    } catch (error) {
      // 检测失败不打扰邮箱其他功能
      state.remoteImport.checked = false;
      state.remoteImport.retryAfter = Date.now() + 5000;
    } finally {
      state.remoteImport.checking = false;
    }
  }

  var LETTER_STATUS_LABELS = {
    1: "等待回信",
    2: "审核中",
    3: "生成中",
    4: "已回复",
    5: "生成失败"
  };

  function lettersModalHtml() {
    return '<div class="lm-modal lm-import-dialog" role="dialog" aria-modal="true">' +
      '<div class="lm-import-title-row"><div class="lm-modal-title" data-role="letters-title">批量导出信件</div>' +
      '<button class="lm-import-close" type="button" aria-label="关闭" data-letters-action="close">×</button></div>' +
      '<div class="lm-import-description" data-role="letters-description"></div>' +
      '<div class="lm-letter-toolbar"><label class="lm-check"><input type="checkbox" data-role="letters-select-all">全选</label>' +
      '<button class="lm-button lm-button-small" type="button" data-letters-action="reload">刷新</button>' +
      '<span data-role="letters-count"></span></div>' +
      '<div class="lm-letter-list" data-role="letters-list"></div>' +
      '<div class="lm-modal-actions"><span class="lm-modal-status" data-role="letters-status"></span>' +
      '<button class="lm-button" type="button" data-letters-action="close">取消</button>' +
      '<button class="lm-button lm-button-primary" type="button" data-letters-action="submit" data-role="letters-submit">导出所选</button></div>' +
      '</div>';
  }

  function setLettersStatus(message, kind) {
    var modal = document.getElementById(LETTERS_MODAL_ID);
    var status = modal && modal.querySelector('[data-role="letters-status"]');
    if (!status) return;
    status.textContent = message;
    status.dataset.kind = kind || "";
  }

  function updateLettersCount() {
    var modal = document.getElementById(LETTERS_MODAL_ID);
    var counter = modal && modal.querySelector('[data-role="letters-count"]');
    if (!counter) return;
    var selected = Object.keys(state.lettersModal.selected).length;
    counter.textContent = "共 " + state.lettersModal.items.length + " 封 · 已选 " + selected + " 封";
  }

  function letterRowHtml(item) {
    var checked = state.lettersModal.selected[item.letterId] ? " checked" : "";
    var date = item.createdAt ? new Date(item.createdAt * 1000).toLocaleString() : "未知时间";
    return '<label class="lm-letter-row"><input type="checkbox" data-letter-id="' + escapeHtml(item.letterId) + '"' + checked + '>' +
      '<span class="lm-letter-meta"><span class="lm-letter-summary">' + escapeHtml(item.summary || item.letterId) + '</span>' +
      '<span class="lm-letter-sub">' + escapeHtml(date) + (item.isRead ? "" : " · 未读") + '</span></span>' +
      '<span class="lm-letter-status">' + escapeHtml(LETTER_STATUS_LABELS[item.letterStatus] || "未知状态") + '</span></label>';
  }

  function renderLettersList() {
    var modal = document.getElementById(LETTERS_MODAL_ID);
    var list = modal && modal.querySelector('[data-role="letters-list"]');
    if (!list) return;
    list.innerHTML = state.lettersModal.items.length
      ? state.lettersModal.items.map(letterRowHtml).join("")
      : '<div class="lm-empty">信箱里还没有信件。</div>';
    var selectAll = modal.querySelector('[data-role="letters-select-all"]');
    if (selectAll) {
      var total = state.lettersModal.items.length;
      var selected = state.lettersModal.items.filter(function (item) { return state.lettersModal.selected[item.letterId]; }).length;
      selectAll.checked = total > 0 && selected === total;
      selectAll.indeterminate = selected > 0 && selected < total;
    }
    updateLettersCount();
  }

  async function fetchAllLetters() {
    var letters = [];
    var cursor = 0;
    for (var guard = 0; guard < 50; guard += 1) {
      var page = await callApi("/letter/list", { params: { cursor: cursor, page_size: 100 } });
      var items = Array.isArray(page.list) ? page.list : [];
      letters = letters.concat(items);
      if (!page.hasMore || !items.length) break;
      cursor = page.nextCursor || cursor + items.length;
    }
    return letters;
  }

  async function reloadLettersModal() {
    setLettersStatus("正在读取信件…", "");
    try {
      state.lettersModal.items = await fetchAllLetters();
      var existing = {};
      state.lettersModal.items.forEach(function (item) { existing[item.letterId] = true; });
      Object.keys(state.lettersModal.selected).forEach(function (id) {
        if (!existing[id]) delete state.lettersModal.selected[id];
      });
      renderLettersList();
      setLettersStatus("勾选信件后执行操作。", "");
    } catch (error) {
      setLettersStatus("读取失败：" + error.message, "error");
    }
  }

  function selectedLetterIds() {
    return state.lettersModal.items
      .filter(function (item) { return state.lettersModal.selected[item.letterId]; })
      .map(function (item) { return item.letterId; });
  }

  function downloadJson(data, prefix) {
    var blob = new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" });
    var link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = prefix + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
    link.click();
    window.setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
  }

  async function submitLettersModal() {
    var modal = document.getElementById(LETTERS_MODAL_ID);
    if (!modal || state.lettersModal.busy) return;
    var ids = selectedLetterIds();
    if (!ids.length) {
      setLettersStatus("请先勾选信件。", "error");
      return;
    }
    var mode = state.lettersModal.mode;
    var submit = modal.querySelector('[data-role="letters-submit"]');
    if (mode === "delete") {
      var confirmed = window.confirm("确定删除选中的 " + ids.length + " 封信？去信、回信和生成记录会一并删除，且不可恢复。");
      if (!confirmed) return;
    }
    state.lettersModal.busy = true;
    submit.disabled = true;
    setLettersStatus(mode === "export" ? "正在导出…" : "正在删除…", "");
    try {
      if (mode === "export") {
        var exported = await callApi("/api/letters/export", {
          method: "POST",
          body: JSON.stringify({ letterIds: ids })
        });
        downloadJson(exported, "linli-letters-export");
        var message = "已导出 " + exported.exported + " 封信。";
        if (exported.missing && exported.missing.length) message += "有 " + exported.missing.length + " 封未找到，已跳过。";
        setLettersStatus(message, "success");
      } else {
        var deleted = await callApi("/api/letters/delete", {
          method: "POST",
          body: JSON.stringify({ letterIds: ids })
        });
        var deleteMessage = "已删除 " + deleted.deleted + " 封信。";
        if (deleted.missing && deleted.missing.length) deleteMessage += "有 " + deleted.missing.length + " 封未找到。";
        setLettersStatus(deleteMessage, "success");
        state.lettersModal.selected = {};
        await reloadLettersModal();
        await refreshDiagnostics();
      }
    } catch (error) {
      setLettersStatus((mode === "export" ? "导出失败：" : "删除失败：") + error.message, "error");
    } finally {
      state.lettersModal.busy = false;
      submit.disabled = false;
    }
  }

  function closeLettersModal() {
    var modal = document.getElementById(LETTERS_MODAL_ID);
    if (modal && !state.lettersModal.busy) modal.hidden = true;
  }

  function bindLettersModal(modal) {
    modal.addEventListener("click", function (event) {
      if (event.target === modal) { closeLettersModal(); return; }
      var actionButton = event.target.closest("[data-letters-action]");
      if (!actionButton) return;
      var action = actionButton.dataset.lettersAction;
      if (action === "close") closeLettersModal();
      else if (action === "reload") reloadLettersModal();
      else if (action === "submit") submitLettersModal();
    });
    modal.addEventListener("change", function (event) {
      var target = event.target;
      if (target.dataset.role === "letters-select-all") {
        state.lettersModal.items.forEach(function (item) {
          if (target.checked) state.lettersModal.selected[item.letterId] = true;
          else delete state.lettersModal.selected[item.letterId];
        });
        renderLettersList();
        return;
      }
      var letterId = target.dataset && target.dataset.letterId;
      if (letterId) {
        if (target.checked) state.lettersModal.selected[letterId] = true;
        else delete state.lettersModal.selected[letterId];
        renderLettersList();
      }
    });
    modal.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeLettersModal();
    });
  }

  function ensureLettersModal() {
    var modal = document.getElementById(LETTERS_MODAL_ID);
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = LETTERS_MODAL_ID;
    modal.className = "lm-modal-backdrop";
    modal.hidden = true;
    modal.innerHTML = lettersModalHtml();
    document.body.appendChild(modal);
    bindLettersModal(modal);
    return modal;
  }

  function openLettersModal(mode) {
    installStyles();
    var modal = ensureLettersModal();
    state.lettersModal.mode = mode === "delete" ? "delete" : "export";
    state.lettersModal.selected = {};
    modal.querySelector('[data-role="letters-title"]').textContent = state.lettersModal.mode === "delete" ? "批量删除信件" : "批量导出信件";
    modal.querySelector('[data-role="letters-description"]').textContent = state.lettersModal.mode === "delete"
      ? "勾选要删除的信件。去信、回信与生成记录会一并删除，且不可恢复；如需保留这些信件，请先在信箱页使用“导出”按钮导出所选信件。"
      : "勾选要导出的信件，会连同内部调试字段（生成状态、Provider、错误等）下载为一个 .json 文件。";
    var submit = modal.querySelector('[data-role="letters-submit"]');
    submit.textContent = state.lettersModal.mode === "delete" ? "删除所选" : "导出所选";
    submit.classList.toggle("lm-button-danger-solid", state.lettersModal.mode === "delete");
    submit.classList.toggle("lm-button-primary", state.lettersModal.mode !== "delete");
    modal.hidden = false;
    reloadLettersModal();
  }

  function mountMailboxTools() {
    var header = mailboxHeader();
    if (!header) {
      hideRemoteToast();
      return;
    }
    installStyles();
    if (!document.getElementById(MAILBOX_TOOLS_ID)) {
      var tools = document.createElement("div");
      tools.id = MAILBOX_TOOLS_ID;
      tools.className = "lm-mailbox-tools";
      tools.innerHTML =
        '<button class="lm-mailbox-import-button" type="button" data-mailbox-action="delete" hidden>删除</button>' +
        '<button class="lm-mailbox-import-button" type="button" data-mailbox-action="export" hidden>导出</button>' +
        '<button class="lm-mailbox-import-button" id="' + MAILBOX_IMPORT_BUTTON_ID + '" type="button" data-mailbox-action="import">导入</button>';
      tools.addEventListener("click", function (event) {
        var button = event.target.closest("[data-mailbox-action]");
        if (!button) return;
        if (button.dataset.mailboxAction === "import") openMailboxImportModal();
        else if (button.dataset.mailboxAction === "export") openLettersModal("export");
        else if (button.dataset.mailboxAction === "delete") openLettersModal("delete");
      });
      header.appendChild(tools);
    }
    applyMailboxDebugVisibility();
    if (state.remoteImport.candidate) syncRemoteToastVisibility();
    else detectRemoteHistoryOnce();
  }
