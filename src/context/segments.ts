/**
 * 折叠单位：turn / segment 的切分与选择。
 *
 * 一条 assistant 消息可能带多个工具结果；按消息条数切会把 Q/A 与 tool call/result 拆开，
 * 所以压缩单位是 turn（一个 user message 加其后的全部 assistant steps）。当前 turn 永不压，
 * 最近 `recentFloor` token 内的 turn 原文保留。
 *
 * 边界：纯函数，只吃消息；不读文件、不调模型。上下文记录（role:"context"）不是对话，跳过。
 */
import type { AssistantPart, CompactionRecord, StoredMessage } from "../core/types";
import { estimateMessageTokens } from "./budget";

export interface TurnSegment {
  fromSeq: number;
  toSeq: number;
  messages: StoredMessage[];
  tokens: number;
  /** 工具仍在跑 / 助手消息未 commit 的段落不压 */
  closed: boolean;
}

function isDialogue(m: StoredMessage): boolean {
  return m.role === "user" || m.role === "assistant";
}

function isClosed(m: StoredMessage): boolean {
  if (m.role !== "assistant") return true;
  // 未闭合的 segment：running/pending 工具，或被中断、还没 commit 完的 assistant
  if (m.finish === "error") return false;
  for (const p of m.parts ?? []) {
    if (p.type === "tool" && (p.state === "pending" || p.state === "running")) return false;
  }
  return true;
}

/** 消息 → turn 段（按 user message 切）。上下文记录与旧 compaction 消息不参与。 */
export function turnsOf(messages: readonly StoredMessage[]): TurnSegment[] {
  const turns: TurnSegment[] = [];
  let current: TurnSegment | undefined;

  const openTurn = (m: StoredMessage): TurnSegment => {
    const t: TurnSegment = { fromSeq: m.seq, toSeq: m.seq, messages: [], tokens: 0, closed: true };
    turns.push(t);
    return t;
  };

  for (const m of messages) {
    if (!isDialogue(m)) continue;
    if (m.role === "user" || current === undefined) current = openTurn(m);
    current.messages.push(m);
    current.toSeq = m.seq;
    current.tokens += estimateMessageTokens(m);
    if (!isClosed(m)) current.closed = false;
  }
  return turns;
}

export interface FoldSelection {
  /** 这次折叠吃掉的原文（按序） */
  picked: StoredMessage[];
  /** 留在窗口里的原文（含上下文消息与不可压段） */
  kept: StoredMessage[];
  turns: number;
  /** 单个 turn 超预算时只修剪工具结果，不拆 Q/A */
  intraTurn: boolean;
}

export interface SelectOptions {
  /** 最近多少 token 的原文必须保留 */
  recentFloorTokens: number;
  /** 这次折叠需要丢掉多少 token 才回到低水位 */
  needToDropTokens: number;
  /** 单个 turn 超过它时只修剪工具结果 */
  oversizedTurnTokens?: number;
}

/** 工具结果修剪后保留的正文；其余换成指针（路径由证据账给出）。 */
const TOOL_KEEP_CHARS = 400;

export const EMPTY_SELECTION: FoldSelection = { picked: [], kept: [], turns: 0, intraTurn: false };

/**
 * 从最老的一端整段淘汰。不可压的段（未闭合）会把选择截止在它那里——
 * 继续往后挑会造出一个"中间被留下、前面被压掉"的窗口，模型读不懂先后。
 */
export function selectFold(messages: readonly StoredMessage[], opts: SelectOptions): FoldSelection {
  const turns = turnsOf(messages);
  if (turns.length <= 1) return { ...EMPTY_SELECTION, kept: [...messages] };

  // 最近 recentFloor 内的 turn 原文保留；当前 turn 无条件保留
  let keptFrom = turns.length - 1;
  let keptTokens = turns[keptFrom].tokens;
  while (keptFrom > 0 && keptTokens + turns[keptFrom - 1].tokens <= opts.recentFloorTokens) {
    keptFrom--;
    keptTokens += turns[keptFrom].tokens;
  }

  const picked: StoredMessage[] = [];
  let dropped = 0;
  let intraTurn = false;
  let pickedTurns = 0;
  for (let i = 0; i < keptFrom; i++) {
    const turn = turns[i];
    if (!turn.closed) break;
    if (dropped >= opts.needToDropTokens) break;
    if (turn.tokens > (opts.oversizedTurnTokens ?? Number.MAX_SAFE_INTEGER)) {
      // 单个 turn 就超预算：允许段内修剪（唯一允许拆 turn 的情况）
      picked.push(...trimTurn(turn.messages));
      intraTurn = true;
    } else {
      picked.push(...turn.messages);
    }
    pickedTurns++;
    dropped += turn.tokens;
  }

  const pickedSeqs = new Set(picked.map((m) => m.seq));
  const kept = messages.filter((m) => !pickedSeqs.has(m.seq) || !isDialogue(m));
  // 修剪过的 turn 仍以原 seq 计：上下文消息与不参与对话的消息永远留在窗口里
  return { picked, kept, turns: pickedTurns, intraTurn };
}

/**
 * 段内修剪：把工具结果正文换成"指针 + 首段"，保留 user 全文、assistant 文本与最后一步。
 * 返回的是副本——原文一个字节都不改，证据账稍后按原消息算。
 */
export function trimTurn(messages: readonly StoredMessage[]): StoredMessage[] {
  const out: StoredMessage[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") {
      out.push(m);
      continue;
    }
    const parts: AssistantPart[] = (m.parts ?? []).map((p) => {
      if (p.type !== "tool" || p.output === undefined || p.output.length <= TOOL_KEEP_CHARS) return p;
      const head = p.output.slice(0, TOOL_KEEP_CHARS);
      return { ...p, output: `${head}\n…（工具结果已在折叠时修剪；需要细节按证据账重读）` };
    });
    out.push({ ...m, parts });
  }
  return out;
}

/** 旧 compaction 消息 → 折叠记录（legacy），让后续折叠继续累积而不是从零开始。 */
export function legacyRecordOf(m: StoredMessage, at = m.ts): CompactionRecord {
  const session = [m.summary ?? "", m.recent ?? ""].filter((s) => s.trim() !== "").join("\n\n");
  return {
    id: `legacy-${m.seq}`,
    at,
    legacy: true,
    consumed: { fromSeq: m.seq, toSeq: m.seq, turns: 0 },
    summary: { session, accomplished: [], intent: [], open: [], pointers: [] },
    pinned: { decisions: [] },
    evidence: [],
    budget: { usable: 0, trigger: 0, before: 0, after: 0 },
    dropped: { messages: 0, toolResults: 0, toolChars: 0 },
    degraded: false,
  };
}

/** 从窗口里找上一次折叠记录：新格式在前，旧 compaction 消息兜底。 */
export function previousRecordOf(window: readonly StoredMessage[]): CompactionRecord | undefined {
  for (const m of window) {
    if (m.role === "context" && m.context !== undefined) return m.context;
  }
  const legacy = window.find((m) => m.role === "compaction");
  return legacy === undefined ? undefined : legacyRecordOf(legacy);
}

/** 估算一组消息里被工具结果吃掉的量（记录里的 dropped.toolChars）。 */
export function toolStatsOf(messages: readonly StoredMessage[]): { results: number; chars: number } {
  let results = 0;
  let chars = 0;
  for (const m of messages) {
    for (const p of m.parts ?? []) {
      if (p.type === "tool" && p.output !== undefined) {
        results++;
        chars += p.output.length;
      }
    }
  }
  return { results, chars };
}