/**
 * 上下文预算：token 估算、窗口分层、触发/迟滞与 preflight。
 *
 * 这一层只认数字，不认识消息，也不读文件。估算公式与阈值全部在这里——触发点、分层预算、
 * 摘要上限若各写一份，界面上的占比与压缩的动手时刻迟早说两套话。
 *
 * 估算永远带"约"：字符换算只是兜底，真实用量优先（provider 报回的 `usage.input`）。
 */
import { contextWindow } from "../core/windows";
import type { CompactionRecord, StoredMessage } from "../core/types";

/** 一次请求之外必须留的余量：下一轮正文 + 摘要请求本身。 */
const DEFAULT_SAFETY_TOKENS = 4096;

/** 摘要不超过这个 token 数（§7.4 的初始值）。 */
export const DEFAULT_SUMMARY_BUDGET = 1200;

export interface ContextBudget {
  model: string;
  window: number;
  maxOutput: number;
  safety: number;
  /** 端到端可用的输入预算 */
  usable: number;
  /** 越过它就折叠 */
  trigger: number;
  /** 一次折叠的目标：折到它以下 */
  lowWater: number;
  /** 工作集至少保留多少 token 的原文 */
  recentFloor: number;
  /** 单条摘要的上限 */
  summaryBudget: number;
  /** 分层上限（§11.2 的初始值） */
  systemCap: number;
  toolsCap: number;
  stateCap: number;
}

function envNumber(name: string, env: NodeJS.ProcessEnv): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/**
 * 按模型窗口算预算。`TALEMATE_COMPACT_TOKENS` 覆盖触发点（测试/手工调参用），
 * `TALEMATE_RECENT_FLOOR_TOKENS` 覆盖保留区：两者都是绝对 token 数，不随模型放大。
 */
export function budgetFor(
  model: string,
  maxOutputTokens: number,
  env: NodeJS.ProcessEnv = process.env,
): ContextBudget {
  const window = contextWindow(model);
  const maxOutput = Math.max(0, maxOutputTokens);
  const safety = envNumber("TALEMATE_SAFETY_TOKENS", env) ?? DEFAULT_SAFETY_TOKENS;
  const usable = Math.max(1024, window - maxOutput - safety);
  const triggerOverride = envNumber("TALEMATE_COMPACT_TOKENS", env);
  const trigger = triggerOverride ?? Math.round(usable * 0.85);
  // 手工压低触发点时也把目标水位一起压低，否则"折到低水位"永远不可达
  const lowWater =
    envNumber("TALEMATE_LOW_WATER", env) ?? (triggerOverride === undefined ? Math.round(usable * 0.5) : Math.round(trigger * 0.6));
  // 保留区与摘要上限也跟着触发点缩：拿 1M 窗口的 20% 去保留，压到 800 token 的评测会永远折不动
  const recentFloor =
    envNumber("TALEMATE_RECENT_FLOOR_TOKENS", env) ??
    (triggerOverride === undefined ? Math.round(usable * 0.2) : Math.round(trigger * 0.25));
  const summaryBudget =
    envNumber("TALEMATE_SUMMARY_TOKENS", env) ??
    (triggerOverride === undefined ? DEFAULT_SUMMARY_BUDGET : Math.max(64, Math.round(trigger * 0.6)));
  return {
    model,
    window,
    maxOutput,
    safety,
    usable,
    trigger,
    lowWater,
    recentFloor,
    summaryBudget,
    systemCap: Math.round(usable * 0.4),
    toolsCap: Math.round(usable * 0.15),
    stateCap: Math.round(usable * 0.1),
  };
}

/** 中日韩字符按 1 token、其余按 0.28 估（§11.1 的初始公式）。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x2e80 && cp <= 0x9fff) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xff00 && cp <= 0xffef)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.round(cjk + other * 0.28);
}

/** 一条消息按它的全部字节估：文本、推理、工具入参与输出都算。 */
export function estimateMessageTokens(message: StoredMessage): number {
  if (message.role === "context" && message.context !== undefined) {
    return estimateRecordTokens(message.context);
  }
  if (message.role === "assistant") {
    let n = 4; // role / 分隔符的固定开销
    for (const part of message.parts ?? []) {
      if (part.type === "text" || part.type === "reasoning") n += estimateTokens(part.text);
      else if (part.type === "tool") n += estimateTokens(part.input ?? "") + estimateTokens(part.output ?? "");
    }
    return n;
  }
  return 4 + estimateTokens(message.text ?? "") + estimateTokens(message.summary ?? "") + estimateTokens(message.recent ?? "");
}

export function estimateMessagesTokens(messages: readonly StoredMessage[]): number {
  let n = 0;
  for (const m of messages) n += estimateMessageTokens(m);
  return n;
}

/** `<context-state>` 渲染后的规模估算（不引入 assemble，避免环）。 */
export function estimateRecordTokens(record: CompactionRecord): number {
  let n = estimateTokens(record.summary.archive ?? "") + estimateTokens(record.summary.session);
  for (const s of [...record.summary.accomplished, ...record.summary.intent, ...record.summary.open, ...record.summary.pointers]) {
    n += estimateTokens(s) + 2;
  }
  n += estimateTokens(record.pinned.project ?? "");
  n += estimateTokens(record.pinned.promises ?? "");
  for (const d of record.pinned.decisions) n += estimateTokens(d.note ?? "") + 8;
  for (const e of record.evidence) n += estimateTokens(`${e.kind} ${e.path ?? ""} ${e.section ?? ""}`) + 8;
  return n + 16;
}

export interface PreflightResult {
  ok: boolean;
  /** 拒绝时给界面/模型的可操作文案；ok 时缺省 */
  message?: string;
}

/**
 * 发请求之前先量 system + tools。常驻设定过大时压缩无能为力——它只能动消息，而问题不在消息。
 * 这里宁可拒绝并给出数字，也不发一个注定超窗的请求、或在 `lastInput` 上无限触发压缩。
 */
export function preflight(budget: ContextBudget, systemChars: number, toolsChars: number): PreflightResult {
  const system = Math.ceil(systemChars * 0.6);
  const tools = Math.ceil(toolsChars * 0.3);
  const residentRatio = (system + tools) / budget.usable;
  if (residentRatio > 0.55) {
    return {
      ok: false,
      message:
        `常驻上下文过大：system 约 ${system} token、工具定义约 ${tools} token，` +
        `合计约占模型窗口 ${Math.round(residentRatio * 100)}%（可用 ${budget.usable}）。` +
        "压缩只能处理对话，修不好常驻层——请拆分 design/wiki/world.md，或换更大窗口的模型。",
    };
  }
  // 单层超限也拒绝：工具太多是配置问题，不是对话能压掉的
  if (tools > budget.toolsCap) {
    return {
      ok: false,
      message:
        `工具定义约 ${tools} token，超过该模型可用预算的 15%（${budget.toolsCap}）。` +
        "减少同时可见的工具，或换更大窗口的模型。",
    };
  }
  if (system > budget.systemCap) {
    return {
      ok: false,
      message:
        `system 约 ${system} token，超过该模型可用预算的 40%（${budget.systemCap}）。` +
        "请拆分常驻设定（design/core.md / design/wiki/world.md），或换更大窗口的模型。",
    };
  }
  return { ok: true };
}