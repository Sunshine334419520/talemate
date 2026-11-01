/**
 * 正文 judge：按 rubric 给四个维度打 1/3/5，返回总分与一句理由。
 *
 * 这里只做"一次打分"；校准、κ、pairwise 在 judge-calibration / judge-cli。judge 的输出是数据，
 * 不是判决——没有人工分校准之前，它只能用来发现大偏差，不能单独决定 prompt 去留。
 */
import type { ModelConfig } from "../src/core/types";
import { chat, type ChatOpts } from "../src/llm/provider";

/** 报告里不能带 apiKey：judge 的输出会进 git。 */
export function publicModel(model: ModelConfig): Omit<ModelConfig, "apiKey"> {
  const { apiKey, ...rest } = model;
  void apiKey;
  return rest;
}

export interface JudgeScore {
  dimensions: Record<string, number>;
  /** 四维平均，1–5 */
  total: number;
  reason: string;
}

export type JudgeChat = (opts: ChatOpts) => Promise<{ text: string }>;

export const JUDGE_SYSTEM = `You are an exacting fiction editor. Score the chapter only against the rubric.
Do not reward length, ambition, or explanations. A 5 is rare; a 1 means the dimension is absent.
Return JSON only, with no prose around it:
{"dimensions":{"场景落实":1|3|5,"人物":1|3|5,"节奏与声音":1|3|5,"正文卫生":1|3|5},"reason":"one sentence"}`;

/** 从模型输出里抠 JSON；容忍 ```json 围栏和前后废话。 */
export function parseJudgeScore(text: string): JudgeScore {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`judge 没有返回 JSON：${text.slice(0, 200)}`);
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new Error(`judge JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof raw !== "object" || raw === null) throw new Error("judge JSON 不是对象");
  const dimensions = (raw as { dimensions?: unknown }).dimensions;
  const reason = (raw as { reason?: unknown }).reason;
  if (typeof dimensions !== "object" || dimensions === null || Array.isArray(dimensions)) {
    throw new Error("judge JSON 缺少 dimensions");
  }
  const scores: Record<string, number> = {};
  for (const [key, value] of Object.entries(dimensions)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    scores[key] = Math.max(1, Math.min(5, Math.round(value)));
  }
  if (Object.keys(scores).length === 0) throw new Error("judge dimensions 里没有数字");
  const total = Object.values(scores).reduce((n, v) => n + v, 0) / Object.keys(scores).length;
  return {
    dimensions: scores,
    total: Math.round(total * 10) / 10,
    reason: typeof reason === "string" ? reason : "",
  };
}

export async function judgeSample(opts: {
  sample: string;
  rubric: string;
  model: ModelConfig;
  chatFn?: JudgeChat;
}): Promise<JudgeScore> {
  const call = opts.chatFn ?? chat;
  const reply = await call({
    model: opts.model,
    system: JUDGE_SYSTEM,
    messages: [
      {
        role: "user",
        text: `Rubric:\n\n${opts.rubric}\n\nChapter:\n\n${opts.sample}`,
      },
    ],
  });
  return parseJudgeScore(reply.text);
}

/** 二次加权 κ（ordinal 1–5）：对角线权重 1，最大距离权重 0。 */
export function quadraticWeightedKappa(human: readonly number[], judge: readonly number[]): number {
  if (human.length !== judge.length) throw new Error("human / judge 长度不一致");
  const n = human.length;
  if (n === 0) return Number.NaN;
  const max = Math.max(5, ...human, ...judge);
  const min = Math.min(1, ...human, ...judge);
  const range = max - min || 1;
  const po = human.reduce((sum, h, i) => sum + 1 - ((h - judge[i]!) / range) ** 2, 0) / n;

  const countsH = new Map<number, number>();
  const countsJ = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    countsH.set(human[i]!, (countsH.get(human[i]!) ?? 0) + 1);
    countsJ.set(judge[i]!, (countsJ.get(judge[i]!) ?? 0) + 1);
  }
  let pe = 0;
  for (let h = min; h <= max; h++) {
    for (let j = min; j <= max; j++) {
      const ph = (countsH.get(h) ?? 0) / n;
      const pj = (countsJ.get(j) ?? 0) / n;
      pe += ph * pj * (1 - ((h - j) / range) ** 2);
    }
  }
  if (1 - pe === 0) return 1;
  return Math.round(((po - pe) / (1 - pe)) * 1000) / 1000;
}

export function meanAbsoluteError(human: readonly number[], judge: readonly number[]): number {
  if (human.length !== judge.length || human.length === 0) return Number.NaN;
  const total = human.reduce((sum, h, i) => sum + Math.abs(h - judge[i]!), 0);
  return Math.round((total / human.length) * 100) / 100;
}
