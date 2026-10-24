/**
 * 轨迹视图的数据模型：把落盘的 `StoredMessage[]` 摊平成一条一条可扫的记录。
 *
 * 它和对话视图看的是同一份消息，但**不折叠过程**：思考、工具入参、工具输出、耗时、错误、
 * halt 全留着。轨迹是给排查用的，不是给阅读用的，所以这里不做"合并成用了 N 步"那种美化。
 *
 * 纯函数、不碰 DOM——渲染在 `Trace.tsx`，测试可以直接喂 fixture。
 */
import type { AskRecord, StoredMessage, ToolState, WriteChange } from "../../../src/core/types";

export type TraceKind = "user" | "text" | "reasoning" | "tool" | "compaction";

export interface TraceRow {
  key: string;
  seq?: number;
  at?: number;
  agent?: string;
  kind: TraceKind;
  text?: string;
  toolName?: string;
  state?: ToolState;
  input?: string;
  output?: string;
  error?: string;
  halt?: boolean;
  /** 工具执行耗时（毫秒）：落盘时记了 ran/completed 才有 */
  ms?: number;
  change?: WriteChange;
  ask?: AskRecord;
  finish?: string;
  model?: string;
}

/** 一条消息 → 若干行。认不出的角色/单元直接跳过——轨迹不替 harness 编故事。 */
export function traceRows(messages: StoredMessage[]): TraceRow[] {
  const rows: TraceRow[] = [];
  for (const m of messages) {
    if (m.role === "compaction") {
      rows.push({
        key: `m${m.seq}-compaction`,
        seq: m.seq,
        at: m.ts,
        kind: "compaction",
        text: [m.summary, m.recent].filter((s): s is string => typeof s === "string" && s !== "").join("\n\n"),
      });
      continue;
    }
    if (m.role === "user") {
      rows.push({
        key: `m${m.seq}-user`,
        seq: m.seq,
        at: m.ts,
        agent: m.agent,
        kind: "user",
        text: m.text ?? "",
      });
      continue;
    }
    if (m.role !== "assistant") continue;
    const parts = m.parts ?? [];
    parts.forEach((p, i) => {
      if (p.type === "reasoning") {
        rows.push({
          key: `m${m.seq}-r${i}`,
          seq: m.seq,
          at: m.ts,
          agent: m.agent,
          kind: "reasoning",
          text: p.text,
        });
        return;
      }
      if (p.type === "text") {
        rows.push({
          key: `m${m.seq}-t${i}`,
          seq: m.seq,
          at: m.ts,
          agent: m.agent,
          kind: "text",
          text: p.text,
          finish: m.finish,
          model: m.model,
        });
        return;
      }
      const ran = p.time?.ran;
      const completed = p.time?.completed;
      rows.push({
        key: `m${m.seq}-x${i}`,
        seq: m.seq,
        at: m.ts,
        agent: m.agent,
        kind: "tool",
        toolName: p.name,
        state: p.state,
        ...(p.input === undefined ? {} : { input: p.input }),
        ...(p.output === undefined ? {} : { output: p.output }),
        ...(p.error === undefined ? {} : { error: p.error }),
        ...(p.halt === true ? { halt: true } : {}),
        ...(ran !== undefined && completed !== undefined ? { ms: completed - ran } : {}),
        ...(p.change === undefined ? {} : { change: p.change }),
        ...(p.ask === undefined ? {} : { ask: p.ask }),
      });
    });
  }
  return rows;
}

export type TraceFilter = "all" | "tools" | "thinking" | "errors";

/** 过滤只影响"看不看"，不影响顺序。 */
export function filterTraceRows(rows: TraceRow[], filter: TraceFilter): TraceRow[] {
  if (filter === "all") return rows;
  if (filter === "tools") return rows.filter((r) => r.kind === "tool");
  if (filter === "thinking") return rows.filter((r) => r.kind === "reasoning" || r.kind === "compaction");
  return rows.filter((r) => r.kind === "tool" && (r.state === "error" || r.error !== undefined));
}
