/**
 * 感知分诊：把候选材料折成这一步的 `ContextPlan`——层级、位置、动作、预算与缺失。
 *
 * 这一层是纯函数：不读文件、不认识 Session；候选由 `perception_candidates.ts` 现取。
 * v1 只跑 prose Profile，且只做 shadow（不消费 plan 组装 prompt）；profile 的权重是手写的，
 * 等真实 trace 与 eval 有数据再调，不先上学习型打分。
 *
 * 边界：只输出决策。正文只活在 `ContextDecision.text` 里，写事件时由 `perceptionTraceOf`
 * 抹掉，只留坐标与规模。
 */
import type {
  ContextCandidate,
  ContextDecision,
  PerceptionAction,
  PerceptionMetrics,
  PerceptionPlacement,
  ContextPlan,
  PerceptionPurpose,
  PerceptionTier,
  PerceptionTrace,
  PerceptionTraceDecision,
} from "../core/types";
import { hashJson } from "../core/hash";
import { estimateTokens } from "./budget";

export const PERCEPTION_ENV = "TALEMATE_PERCEPTION";
export const PERCEPTION_TOKENS_ENV = "TALEMATE_PERCEPTION_TOKENS";

/** 一次分诊的默认上限。手写 12k：P0 规划 + 人物状态 + 读者/声音足够，余下的留给工具按需取。 */
export const DEFAULT_PERCEPTION_TOKENS = 12_000;

export type PerceptionMode = "off" | "shadow" | "inject";

/**
 * 默认 shadow：真实会话里就能看到决策，但不改变 prompt。`inject` 才让 plan 参与组装；
 * 它只用于 eval 的变体对照，不靠 `.env` 默认打开。
 */
export function perceptionMode(env: NodeJS.ProcessEnv = process.env): PerceptionMode {
  const value = (env[PERCEPTION_ENV] ?? "shadow").trim().toLowerCase();
  if (value === "off" || value === "shadow" || value === "inject") return value;
  return "shadow";
}

export function perceptionTokenBudget(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[PERCEPTION_TOKENS_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_PERCEPTION_TOKENS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_PERCEPTION_TOKENS;
}

interface ProfileEntry {
  tier: PerceptionTier;
  placement: PerceptionPlacement;
}

/**
 * v1 的 prose Profile。判据用候选 id 的前缀，而不是 candidate.line：
 * "同一份材料在不同步骤可以是不同层级"——这里只回答散文这一步。
 */
function profileFor(purpose: PerceptionPurpose, candidate: ContextCandidate): ProfileEntry {
  if (purpose !== "prose") return { tier: "P3", placement: "tool.index" };
  if (candidate.id.startsWith("task.plan") || candidate.id.startsWith("task.instruction")) {
    return { tier: "P0", placement: "system.tail" };
  }
  if (candidate.id.startsWith("character.state.") || candidate.id.startsWith("character.knowledge")) {
    return { tier: "P0", placement: "system.tail" };
  }
  if (
    candidate.id.startsWith("character.card.") ||
    candidate.id.startsWith("character.relations") ||
    candidate.id.startsWith("reader.") ||
    candidate.id.startsWith("voice.") ||
    candidate.id.startsWith("narrative.progress") ||
    candidate.id.startsWith("narrative.promises") ||
    candidate.id.startsWith("narrative.prev-ending") ||
    candidate.id.startsWith("world.resident.")
  ) {
    return { tier: "P1", placement: "system.head" };
  }
  if (candidate.id.startsWith("author.")) return { tier: "P2", placement: "system.middle" };
  return { tier: "P3", placement: "tool.index" };
}

/** 按 token 上限截取；中文按 1、其余按 0.28 估，和 `budget.ts` 同一套口径。 */
function sliceToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (estimateTokens(text) <= maxTokens) return text;
  let out = "";
  for (const ch of text) {
    if (estimateTokens(out + ch) > maxTokens) break;
    out += ch;
  }
  return out;
}

function makeDecision(
  candidate: ContextCandidate,
  tier: PerceptionTier,
  placement: PerceptionPlacement,
  action: PerceptionAction,
  reason: string,
  text?: string,
): ContextDecision {
  return {
    candidate,
    tier,
    placement,
    action,
    ...(text === undefined ? {} : { text }),
    reason,
  };
}

/**
 * 分诊。顺序是"先判资格，再判预算"：缺载体/过期/已在上下文里的直接落账，
 * 不进预算；P0 永远进（超预算也是上层该看见的错误），P1/P2 才做取舍。
 */
export function triageCandidates(
  candidates: readonly ContextCandidate[],
  purpose: PerceptionPurpose,
  ceiling: number,
  chapter?: number,
): ContextPlan {
  const decisions: ContextDecision[] = [];
  const missing: string[] = [];
  let used = 0;

  for (const candidate of candidates) {
    const profile = profileFor(purpose, candidate);
    if (candidate.gap !== undefined) {
      missing.push(candidate.gap);
      decisions.push(makeDecision(candidate, profile.tier, profile.placement, "drop", `missing: ${candidate.gap}`));
      continue;
    }
    if (candidate.freshness === "stale") {
      decisions.push(makeDecision(candidate, profile.tier, profile.placement, "drop", "stale"));
      continue;
    }
    if (candidate.alreadyInContext === true) {
      decisions.push(makeDecision(candidate, profile.tier, profile.placement, "drop", "already-in-context"));
      continue;
    }

    const sourceTokens = estimateTokens(candidate.text);
    if (profile.tier === "P0") {
      used += sourceTokens;
      decisions.push(makeDecision(candidate, profile.tier, profile.placement, "include", "p0-required"));
      continue;
    }
    if (profile.tier === "P1") {
      if (used + sourceTokens <= ceiling) {
        used += sourceTokens;
        decisions.push(makeDecision(candidate, profile.tier, profile.placement, "include", "p1-included"));
      } else {
        decisions.push(makeDecision(candidate, profile.tier, profile.placement, "defer", "over-budget"));
      }
      continue;
    }
    if (profile.tier === "P2") {
      const room = ceiling - used;
      if (room <= 0) {
        decisions.push(makeDecision(candidate, profile.tier, profile.placement, "defer", "over-budget"));
        continue;
      }
      const text = sliceToTokens(candidate.text, Math.min(sourceTokens, room));
      const after = estimateTokens(text);
      if (after === 0) {
        decisions.push(makeDecision(candidate, profile.tier, profile.placement, "defer", "over-budget"));
        continue;
      }
      used += after;
      decisions.push(makeDecision(candidate, profile.tier, profile.placement, "compress", "compressed", text));
      continue;
    }
    decisions.push(makeDecision(candidate, profile.tier, profile.placement, "defer", "deferred-p3"));
  }

  return {
    purpose,
    ...(chapter === undefined ? {} : { chapter }),
    budget: { ceiling, used },
    decisions,
    missing: [...new Set(missing)],
  };
}

function isCovered(decision: ContextDecision): boolean {
  if (decision.action === "include" || decision.action === "compress") return true;
  return decision.reason === "already-in-context";
}

/** 由决策折指标；同一份 plan 反复算结果一致（不读时间、不读文件）。 */
export function perceptionMetrics(plan: ContextPlan): PerceptionMetrics {
  const p0 = plan.decisions.filter((d) => d.tier === "P0" && d.candidate.gap === undefined);
  const p0Covered = p0.filter(isCovered).length;
  const compressed = plan.decisions.filter((d) => d.action === "compress");
  const before = compressed.reduce((n, d) => n + estimateTokens(d.candidate.text), 0);
  const after = compressed.reduce((n, d) => n + estimateTokens(d.text ?? ""), 0);
  return {
    p0Coverage: p0.length === 0 ? 1 : Number((p0Covered / p0.length).toFixed(3)),
    dropped: plan.decisions.filter((d) => d.action === "drop").length,
    compressionRatio: compressed.length === 0 || before === 0 ? 1 : Number((after / before).toFixed(3)),
    stale: plan.decisions.filter((d) => d.candidate.freshness === "stale").length,
    duplicate: plan.decisions.filter((d) => d.candidate.alreadyInContext === true).length,
    missing: plan.missing.length,
    deferred: plan.decisions.filter((d) => d.action === "defer").length,
  };
}

/** trace 的 hash 只认决策与坐标；`builtAt` 不进来，否则同一步每次构建都算"变了"。 */
export function perceptionPlanHash(plan: ContextPlan): string {
  return hashJson({
    purpose: plan.purpose,
    chapter: plan.chapter,
    budget: plan.budget,
    missing: plan.missing,
    decisions: plan.decisions.map((d) => ({
      id: d.candidate.id,
      tier: d.tier,
      action: d.action,
      placement: d.placement,
      source: d.candidate.source,
      sourceChars: d.candidate.chars,
      chars: d.action === "include" ? d.candidate.chars : (d.text?.length ?? 0),
      reason: d.reason,
    })),
  });
}

/** 事件形状：正文在这里被抹掉，只留坐标、规模与原因。 */
export function perceptionTraceOf(plan: ContextPlan, builtAt: number): PerceptionTrace {
  const decisions: PerceptionTraceDecision[] = plan.decisions.map((d) => ({
    id: d.candidate.id,
    tier: d.tier,
    action: d.action,
    placement: d.placement,
    source: d.candidate.source,
    sourceChars: d.candidate.chars,
    chars: d.action === "include" ? d.candidate.chars : (d.text?.length ?? 0),
    reason: d.reason,
  }));
  return {
    purpose: plan.purpose,
    ...(plan.chapter === undefined ? {} : { chapter: plan.chapter }),
    hash: perceptionPlanHash(plan),
    builtAt,
    budget: plan.budget,
    decisions,
    missing: plan.missing,
    metrics: perceptionMetrics(plan),
  };
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sourceLabel(source: ContextCandidate["source"]): string {
  const parts: string[] = [];
  if (source.path !== undefined) parts.push(source.path);
  if (source.section !== undefined) parts.push(`#${source.section}`);
  if (source.rev !== undefined) parts.push(`@${source.rev}`);
  if (parts.length === 0 && source.label !== undefined) parts.push(source.label);
  return parts.join("");
}

/**
 * inject 阶段的渲染：只把真正"要进、且还不在上下文里"的决定拼成一块。
 *
 * 已经常驻/已在 messages 的候选在分诊时是 drop（`already-in-context`），这里不会再出现——
 * 这就是 shadow 与 inject 共用同一份 plan 的原因：去重逻辑只有一处。
 */
export function renderPerceptionBlock(plan: ContextPlan, placement: PerceptionPlacement): string | undefined {
  const decisions = plan.decisions.filter(
    (d) =>
      d.placement === placement &&
      (d.action === "include" || d.action === "compress") &&
      d.candidate.alreadyInContext !== true,
  );
  const items: string[] = [];
  for (const decision of decisions) {
    const text = (decision.action === "compress" ? decision.text : decision.candidate.text)?.trim() ?? "";
    if (text === "") continue;
    const source = sourceLabel(decision.candidate.source);
    const attrs = [`tier="${decision.tier}"`, ...(source === "" ? [] : [`source="${escapeAttr(source)}"`])];
    items.push(`<perception-item ${attrs.join(" ")}>\n${text}\n</perception-item>`);
  }
  if (items.length === 0) return undefined;
  return `<perception purpose="${plan.purpose}" placement="${placement}">\n${items.join("\n")}\n</perception>`;
}