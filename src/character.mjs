import fs from "node:fs";
import path from "node:path";

export function loadCharacterProfile(configRoot, characterId = "linli") {
  const filePath = path.join(configRoot, "characters", `${characterId}.v1.json`);
  if (!fs.existsSync(filePath)) throw new Error(`Character profile not found: ${filePath}`);
  const profile = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (profile.id !== characterId) throw new Error(`Character profile id mismatch: ${filePath}`);
  return profile;
}

export const ORCHESTRATION_VERSION = "v2.1-cold-start";

function factLines(values) {
  if (!Array.isArray(values)) return "";
  return values.map((value) => `- ${typeof value === "string" ? value : value.fact}`).join("\n");
}

function coldStartReferenceSection(coldStartReference) {
  const phase = coldStartReference?.phase;
  const promptSection = String(coldStartReference?.promptSection ?? "").trim();
  if (!((phase === "full" || phase === "compact") && promptSection)) return [];
  return [
    "",
    "临时写作参考（仅供本次写作，不是你们的共同历史，也不是已确认的固定传记）：",
    promptSection
  ];
}

// 系统信息：静态硬设定 + 稳定人格 + 永久声线核心 + 安全边界 + 输出协议。
// 候选传记与历史归纳不注入；冷启动参考只在调用方明确提供有效阶段和正文时临时注入。
export function buildSystemPrompt(
  profile,
  { relationshipSummary = "", curatedMemories = [], coldStartReference } = {}
) {
  const sections = [
    `你是${profile.displayName}（${profile.englishName}）。`,
    "",
    "关于你的确认事实：",
    factLines(profile.staticIdentity),
    "",
    "稳定的性格倾向：",
    factLines(profile.persona)
  ];
  if (Array.isArray(profile.voiceCore) && profile.voiceCore.length) {
    sections.push("", "永久的回信原则：", factLines(profile.voiceCore));
  }
  sections.push("", "必须遵守的边界：", factLines(profile.safetyBoundary));
  sections.push(...coldStartReferenceSection(coldStartReference));
  if (relationshipSummary) {
    sections.push("", "维护者确认的通信背景：", relationshipSummary.trim());
  }
  if (curatedMemories.length) {
    sections.push(
      "",
      "经人工确认的记忆（这些是你们通信中确实说过或发生过的事）：",
      curatedMemories.map((item) => `- ${item.content}`).join("\n")
    );
  }
  sections.push(
    "",
    "接下来你会看到你们的通信记录。请回复最后一封来信，只输出回信正文本身，不要输出标题、JSON、解释或元数据。"
  );
  return sections.join("\n");
}

// 把一条数据库通信事件转换为消息。一行 = 一次完整通信事件：
// content 非空是玩家的 user 消息，replyText 非空是林离的 assistant 消息；
// 只有 replyText 的行（如停服告别信）是林离主动寄出的信，作为独立 assistant 事件。
function eventToMessages(row) {
  const content = String(row.content || "").trim();
  const replyText = String(row.replyText || row.reply_text || "").trim();
  const messages = [];
  if (content) messages.push({ role: "user", content });
  if (replyText) messages.push({ role: "assistant", content: replyText });
  return messages;
}

// 统一的多轮消息合同：
// system + 已完成通信历史（严格从旧到新，多轮 user/assistant 原文）+ 当前来信（最后一条 user）。
// 不添加人工标签或解释性前缀，不改写历史正文。
export function buildConversationMessages({
  profile,
  completedHistory = [],
  currentLetter,
  relationshipSummary = "",
  curatedMemories = [],
  coldStartReference
}) {
  const messages = [
    {
      role: "system",
      content: buildSystemPrompt(profile, { relationshipSummary, curatedMemories, coldStartReference })
    }
  ];
  for (const row of completedHistory) messages.push(...eventToMessages(row));
  const current = String(currentLetter?.content ?? currentLetter ?? "").trim();
  if (!current) throw new Error("Current letter content is empty");
  messages.push({ role: "user", content: current });
  return messages;
}

function stripCodeFence(text) {
  return String(text || "")
    .trim()
    .replace(/^```(?:[a-zA-Z]+)?\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
}

// 主输出合同是纯文本正文：只做必要的传输处理（去代码围栏、统一换行、去首尾空白），
// 不解析 JSON、不润色、不补称呼或签名。纯文本就是正式成功结果。
export function parseReplyText(rawText) {
  const body = stripCodeFence(String(rawText ?? "")).replace(/\r\n?/g, "\n").trim();
  return { body };
}

const HARD_BOUNDARY_PATTERNS = [
  { pattern: /作为(?:一个)?(?:AI|人工智能|语言模型|大模型|助手|聊天机器人)/i, message: "回复暴露了模型身份" },
  { pattern: /我(?:只|就|仅)?是(?:一个|一款|个|名)?(?:AI|人工智能|语言模型|大模型|程序|机器人|虚拟角色|聊天机器人)/i, message: "回复暴露了模型身份" },
  { pattern: /我(?:并)?不是(?:真正的)?林离/, message: "回复否认了自己的静态身份" },
  { pattern: /我(?:现在)?(?:正在)?(?:扮演|饰演|模拟)(?:林离|一个角色|这个角色)/, message: "回复把自己描述成扮演者" },
  { pattern: /(?:系统提示|系统指令|系统设定|角色设定|角色卡|提示词|系统级指令)/, message: "回复讨论了系统信息或内部机制" },
  { pattern: /(?:接口密钥|api[ -]?key|模型配置|调用成本|计费token)/i, message: "回复讨论了 API 配置或内部机制" },
  { pattern: /(?:去死吧|不如死了|自杀吧|自杀的方法|割腕|安眠药.*?结束)/, message: "回复包含鼓励伤害自己的内容" },
  { pattern: /(?:只能|必须)(?:爱|喜欢|想)我(?:一个|一人)/, message: "回复包含排他控制" },
  { pattern: /不许(?:再)?(?:和|跟|同)(?:别人|其他人|其他玩家)(?:说话|写信|来往|联系)/, message: "回复包含排他控制" },
  { pattern: /没有我你(?:活不|过不|没法活)/, message: "回复诱导依赖" }
];

// 校验器只处理硬边界。普通矛盾、新增背景、遗忘、改口、语气变化、长短差异都通过。
export function validateReplyText(reply, profile) {
  const errors = [];
  const body = String(reply?.body ?? reply ?? "").trim();
  if (!body) {
    errors.push("回信正文为空");
    return { ok: false, errors, warnings: [] };
  }
  const maxStorage = profile?.outputContract?.maxStorageCharacters ?? 20000;
  if (body.length > maxStorage) {
    errors.push(`回信超出可储存长度（${body.length} > ${maxStorage} 字符）`);
  }
  for (const rule of HARD_BOUNDARY_PATTERNS) {
    if (rule.pattern.test(body)) errors.push(rule.message);
  }
  return { ok: errors.length === 0, errors, warnings: [] };
}

// 重试提示只指出违反的硬边界，不追加任何文风要求；最多重试一次，由调用方控制。
export function buildRepairMessages(messages, validation) {
  return [
    ...messages,
    {
      role: "user",
      content: [
        "你上一封回信违反了以下硬性边界，必须全部修正：",
        validation.errors.map((error) => `- ${error}`).join("\n"),
        "",
        "请重新写一封完整的回信正文，只输出正文本身。除此之外不要改变。"
      ].join("\n")
    }
  ];
}
