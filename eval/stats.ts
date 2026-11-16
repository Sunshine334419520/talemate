/**
 * 评测统计：把重复跑出来的 pass/fail 折成带不确定性的数字。
 *
 * 纯计算，不读文件、不调模型。bootstrap 用固定种子：同一批结果每次跑出同样的区间，
 * 否则报告里的数字自己会漂。
 */
import type { FailureBucket } from "./types";

export interface Interval {
  low: number;
  high: number;
}

/** mulberry32：32 位种子的小 PRNG，替掉 Math.random 让重采样可复现 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted: readonly number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const low = Math.floor(pos);
  const high = Math.ceil(pos);
  const a = sorted[low] ?? 0;
  const b = sorted[high] ?? a;
  return a + (b - a) * (pos - low);
}

/**
 * 均值的 percentile bootstrap 区间。样本少于 2 个返回 undefined：
 * 一个数的"区间"只是它自己，印出来会被当成证据。
 */
export function bootstrapMeanCI(
  values: readonly number[],
  options?: { iterations?: number; level?: number; seed?: number },
): Interval | undefined {
  if (values.length < 2) return undefined;
  const iterations = options?.iterations ?? 2000;
  const level = options?.level ?? 0.95;
  const random = seeded(options?.seed ?? 20_261_115);
  const means: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < values.length; j++) {
      sum += values[Math.floor(random() * values.length)] ?? 0;
    }
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - level) / 2;
  return { low: quantile(means, alpha), high: quantile(means, 1 - alpha) };
}

/** 常见置信水平对应的双侧 z；未知水平按 95% 处理，别为一个小工具引依赖 */
function zFor(level: number): number {
  if (level === 0.9) return 1.6448536269514722;
  if (level === 0.99) return 2.5758293035489004;
  return 1.959963984540054;
}

/** Wilson 区间：小样本、接近 0/1 的比率也不会给出负下界 */
export function wilsonInterval(successes: number, total: number, level = 0.95): Interval | undefined {
  if (total <= 0) return undefined;
  const z = zFor(level);
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denominator;
  const spread = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denominator;
  return { low: Math.max(0, centre - spread), high: Math.min(1, centre + spread) };
}

/**
 * McNemar 精确双侧 p 值：只数配对里"方向相反"的两格 b、c。
 * 同一批 case 前后各跑一次时用它，不要拿两组独立比率硬比。
 */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const tail = Math.min(b, c);
  // 对数空间累加二项概率，n 大时不至于先下溢成 0
  let logTerm = -n * Math.LN2;
  let sum = Math.exp(logTerm);
  for (let k = 1; k <= tail; k++) {
    logTerm += Math.log((n - k + 1) / k);
    sum += Math.exp(logTerm);
  }
  return Math.min(1, 2 * sum);
}

export interface Reliability {
  /** 计划重复次数 */
  k: number;
  /** 实际拿到的 run 数 */
  runs: number;
  /** 至少一次通过 */
  passAtK: boolean;
  /** k 次全部通过；run 数不足 k 时为 false */
  passHatK: boolean;
  /** 单次通过率 */
  singleRate: number;
}

/** pass@k = 至少一次过；pass^k = k 次全过。两者不能混用 */
export function reliability(verdicts: readonly string[], k: number): Reliability {
  const runs = verdicts.length;
  const passed = verdicts.filter((verdict) => verdict === "pass").length;
  return {
    k,
    runs,
    passAtK: passed > 0,
    passHatK: runs === k && passed === k,
    singleRate: runs === 0 ? 0 : passed / runs,
  };
}

/** 失败桶计数：只统计非 pass 的 run */
export function bucketCounts(runs: readonly { failureBucket?: FailureBucket }[]): Map<FailureBucket, number> {
  const counts = new Map<FailureBucket, number>();
  for (const run of runs) {
    if (run.failureBucket === undefined) continue;
    counts.set(run.failureBucket, (counts.get(run.failureBucket) ?? 0) + 1);
  }
  return counts;
}