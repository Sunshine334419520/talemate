/**
 * 折叠编排：preflight → select → build → summarize →（校验已在 summary 内）→ 产出记录。
 *
 * 这里不落盘：一次折叠的原子提交是 Session 追加一条 `context/compaction` 事件，消息窗口由
 * 投影重算。摘要生成失败时走确定性降级（一条 `degraded` 记录，只把工具结果换成指针）；
 * 没有可折的段时返回 `refused`，调用方不写事件、也不发请求。
 *
 * 边界：确定性账（证据/决定/pinned）在这里组装；叙事只来自 `summary.ts`。
 */
import type { CompactionRecord, DecisionEntry, ModelConfig, StoredMessage } from "../core/types";
import { hashJson } from "../core/hash";
import type { ContextBudget } from "./budget";
import { estimateMessagesTokens, estimateRecordTokens, estimateTokens } from "./budget";
import { evidenceFrom } from "./ledger";
import type { PinnedSnapshot } from "./project_state";
import { buildFoldInput, summarize, type Summarizer } from "./summary";
import { previousRecordOf, selectFold, toolStatsOf } from "./segments";

export interface FoldRequest {
  projectId: string;
  sessionId: string;
  model: ModelConfig;
  /** 模型实际会看到的窗口（含上一次折叠的合成消息） */
  messages: StoredMessage[];
  budget: ContextBudget;
  /** summarizer 的 system prompt */
  system: string;
  pinned: PinnedSnapshot;
  plan?: { chapter: number; path: string; hash: string };
  decisions: DecisionEntry[];
  /** harness 里仍未回答的提问（并进 `<open>`） */
  open: string[];
  summarizer?: Summarizer;
  env?: NodeJS.ProcessEnv;
  now?: number;
}

export interface FoldOutcome {
  record?: CompactionRecord;
  /** 拒绝折叠时给界面/模型的可操作文案 */
  refused?: string;
}

/** 折叠记录的身份是 (上一条记录, 吃掉的范围, 摘要)；同一输入重放得到同一个 id（幂等）。 */
function recordId(previousId: string | undefined, fromSeq: number, toSeq: number, session: string): string {
  return hashJson({ previousId: previousId ?? null, fromSeq, toSeq, session }).slice(0, 16);
}

function unique(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const t = item.trim();
    if (t === "" || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * 执行一次折叠。返回记录；不可折时返回 `refused`（不发请求、不写事件）。
 *
 * 选中的原文按 turn 整段淘汰；若单个 turn 就超预算，允许段内修剪工具结果（`intraTurn`）。
 */
export async function foldContext(req: FoldRequest): Promise<FoldOutcome> {
  const window = req.messages;
  const previous = previousRecordOf(window);
  const before = estimateMessagesTokens(window);
  // 目标不是"丢掉足够多的原文"，而是折叠后的窗口（记录 + 保留原文）落到低水位以下：
  // 摘要与 pinned 本身也要占位置，不留这份余量就会折完仍然超水位、再折一次。
  const reserve =
    req.budget.summaryBudget +
    64 +
    estimateTokens(req.pinned.project ?? "") +
    estimateTokens(req.pinned.promises ?? "") +
    req.decisions.reduce((n, d) => n + 8 + estimateTokens(d.note ?? ""), 0);
  const needToDrop = Math.max(0, before + reserve - req.budget.lowWater);

  const selection = selectFold(window, {
    recentFloorTokens: req.budget.recentFloor,
    needToDropTokens: needToDrop,
    oversizedTurnTokens: req.budget.lowWater,
  });
  if (selection.picked.length === 0) {
    return {
      refused:
        `窗口约 ${before} token，超过水位 ${req.budget.trigger}，但已经没有可折叠的完整 turn` +
        "（最近的工作集必须原文保留）。请缩短当前轮，或换更大窗口的模型。",
    };
  }

  const evidence = evidenceFrom(selection.picked);
  const pinned: CompactionRecord["pinned"] = {
    decisions: req.decisions,
    ...(req.pinned.project === undefined ? {} : { project: req.pinned.project }),
    ...(req.pinned.promises === undefined ? {} : { promises: req.pinned.promises }),
    ...(req.plan === undefined ? {} : { plan: req.plan }),
  };

  const input = buildFoldInput({ previous, pinned, messages: selection.picked });
  const result = await summarize({
    model: req.model,
    system: req.system,
    budget: req.budget,
    input,
    messages: selection.picked,
    ...(previous === undefined ? {} : { previous }),
    ...(req.summarizer === undefined ? {} : { summarizer: req.summarizer }),
    ...(req.env === undefined ? {} : { env: req.env }),
  });

  let fromSeq = Number.POSITIVE_INFINITY;
  let toSeq = Number.NEGATIVE_INFINITY;
  for (const m of selection.picked) {
    if (m.seq < fromSeq) fromSeq = m.seq;
    if (m.seq > toSeq) toSeq = m.seq;
  }
  const tools = toolStatsOf(selection.picked);
  const keptTokens = estimateMessagesTokens(
    selection.kept.filter((m) => m.seq > toSeq && m.role !== "context" && m.role !== "compaction"),
  );

  const record: CompactionRecord = {
    id: recordId(previous?.id, fromSeq, toSeq, result.summary.session),
    at: req.now ?? Date.now(),
    ...(previous === undefined ? {} : { previousId: previous.id }),
    consumed: {
      fromSeq,
      toSeq,
      turns: selection.turns,
      ...(selection.intraTurn ? { intraTurn: true } : {}),
    },
    summarizer: { model: req.model.model, promptHash: result.promptHash, schema: 2 },
    summary: {
      ...result.summary,
      open: unique([...req.open, ...result.summary.open]),
    },
    pinned,
    evidence,
    budget: { usable: req.budget.usable, trigger: req.budget.trigger, before, after: 0 },
    dropped: { messages: selection.picked.length, toolResults: tools.results, toolChars: tools.chars },
    degraded: result.degraded,
  };
  record.budget.after = estimateRecordTokens(record) + keptTokens;
  // context-state 超预算时先截证据（最老的最先走），叙事不再二次改写
  while (record.evidence.length > 0 && estimateRecordTokens(record) > req.budget.stateCap) {
    record.evidence.shift();
  }

  return { record };
}