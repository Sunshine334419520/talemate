/**
 * 脱敏：事件离开进程之前过的那一道。canonical 日志本身不改写——它是本地账本，
 * 本来就存着文件内容与命令输出；而导出副本会进评测集、进别人的机器，所以必须单独洗一遍。
 *
 * 失败是扣下（fail-closed）：一条洗不干净的事件宁可整条不进导出，也不能带着密钥出去。
 *
 * 边界：只作用于**副本**。不做"写入前脱敏"——那样本地日志会缺字节，回放就还原不出当时发生了什么。
 */
import { homedir } from "node:os";
import type { AnyTraceEvent } from "./events";

export interface RedactionRule {
  re: RegExp;
  with: string;
}

export interface RedactionPolicy {
  /** 替换成 `~` 的家目录；缺省取当前用户。 */
  homeDir?: string;
  /** 追加规则，排在默认规则之后。 */
  rules?: RedactionRule[];
}

/**
 * 默认规则只认"一看就是凭据"的形状，不猜。
 *
 * 刻意不做的：不按长度通配一串随机字符（会把哈希、会话 id、章节号一起洗掉），不删正文
 * （那等于把评测要看的材料删了）。脱敏的目标是密钥与机器路径，不是隐私审查。
 */
const DEFAULT_RULES: RedactionRule[] = [
  { re: /\bsk-[A-Za-z0-9_-]{8,}/g, with: "sk-***" },
  { re: /\b(Bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, with: "$1 ***" },
  { re: /((?:api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*["']?)[^\s"',}]{6,}/gi, with: "$1***" },
];

/** 脱敏时发现这条记录没法安全地洗（例如 data 里有无法序列化的值）。调用方据此整条扣下。 */
export class RedactionError extends Error {
  constructor(readonly seq: number | undefined, cause: unknown) {
    super(`第 ${seq ?? "?"} 条事件无法脱敏，已扣下`);
    this.name = "RedactionError";
    this.cause = cause;
  }
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 单串脱敏。路径替换放在规则之后：先洗密钥，再收家目录。 */
export function redactText(text: string, policy: RedactionPolicy = {}): string {
  let out = text;
  for (const rule of [...DEFAULT_RULES, ...(policy.rules ?? [])]) {
    // 每次都从 lastIndex 0 开始：带 g 的正则是有状态的
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, rule.with);
  }
  const home = policy.homeDir ?? homedir();
  if (home.length > 1) {
    const variants = new Set([home, home.replace(/\\/g, "/"), home.replace(/\//g, "\\")]);
    for (const variant of variants) out = out.replace(new RegExp(escapeRe(variant), "g"), "~");
  }
  return out;
}

function redactValue(value: unknown, policy: RedactionPolicy): unknown {
  if (typeof value === "string") return redactText(value, policy);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, policy));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactValue(item, policy);
    return out;
  }
  return value;
}

/**
 * 脱敏一条事件，返回副本。先 JSON 往返一次：既拿到深拷贝，也让"序列化不了"在这里暴露——
 * 一个会在导出中途炸掉的记录，不如现在就扣下。
 */
export function redactEvent(event: AnyTraceEvent, policy: RedactionPolicy = {}): AnyTraceEvent {
  let copy: AnyTraceEvent;
  try {
    copy = JSON.parse(JSON.stringify(event)) as AnyTraceEvent;
  } catch (err) {
    throw new RedactionError(event.seq, err);
  }
  return redactValue(copy, policy) as AnyTraceEvent;
}

/**
 * 批量脱敏。逐条 try：坏掉的那一条被扣下并计数，其余照常出去——
 * 整批失败会让一次会话的观测全丢，而"少一条"是可以接受的。
 */
export function redactEvents(
  events: AnyTraceEvent[],
  policy: RedactionPolicy = {},
): { events: AnyTraceEvent[]; dropped: number } {
  const out: AnyTraceEvent[] = [];
  let dropped = 0;
  for (const event of events) {
    try {
      out.push(redactEvent(event, policy));
    } catch {
      dropped++;
    }
  }
  return { events: out, dropped };
}
