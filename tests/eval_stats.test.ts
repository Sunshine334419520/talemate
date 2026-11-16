/**
 * 统计小工具的守卫：区间、κ 之外的那几个数必须能复现，且小样本不给出假区间。
 */
import { describe, expect, test } from "bun:test";
import { bootstrapMeanCI, bucketCounts, mcnemarExact, reliability, wilsonInterval } from "../eval/stats";

describe("bootstrapMeanCI", () => {
  test("单样本不给区间", () => {
    expect(bootstrapMeanCI([3])).toBeUndefined();
  });

  test("区间包住均值，固定种子可复现", () => {
    const values = [1, 2, 3, 4, 5];
    const first = bootstrapMeanCI(values);
    const second = bootstrapMeanCI(values);
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(first.low).toBeLessThan(3);
    expect(first.high).toBeGreaterThan(3);
    expect(first).toEqual(second);
  });

  test("90% 区间落在 95% 区间里", () => {
    const values = [0, 10, 20, 30, 40, 50];
    const wide = bootstrapMeanCI(values, { seed: 1, iterations: 500 });
    const narrow = bootstrapMeanCI(values, { seed: 1, iterations: 500, level: 0.9 });
    expect(wide).toBeDefined();
    expect(narrow).toBeDefined();
    if (wide === undefined || narrow === undefined) return;
    expect(narrow.low).toBeGreaterThanOrEqual(wide.low);
    expect(narrow.high).toBeLessThanOrEqual(wide.high);
  });
});

describe("wilsonInterval", () => {
  test("0/10 的上界小于 0.3，下界不为负", () => {
    const interval = wilsonInterval(0, 10);
    expect(interval).toBeDefined();
    if (interval === undefined) return;
    expect(interval.low).toBe(0);
    expect(interval.high).toBeGreaterThan(0.2);
    expect(interval.high).toBeLessThan(0.3);
  });

  test("空样本没有区间", () => {
    expect(wilsonInterval(0, 0)).toBeUndefined();
  });
});

describe("mcnemarExact", () => {
  test("5:0 的精确双侧 p 是 0.0625", () => {
    expect(mcnemarExact(5, 0)).toBeCloseTo(0.0625, 10);
  });

  test("12 个不一致里 10:2", () => {
    expect(mcnemarExact(10, 2)).toBeCloseTo(158 / 4096, 10);
  });

  test("没有不一致时 p=1", () => {
    expect(mcnemarExact(0, 0)).toBe(1);
  });
});

describe("reliability", () => {
  test("pass@k 与 pass^k 不是一回事", () => {
    const value = reliability(["pass", "fail"], 2);
    expect(value.passAtK).toBe(true);
    expect(value.passHatK).toBe(false);
    expect(value.singleRate).toBe(0.5);
  });

  test("run 数不足 k 时 pass^k 不成立", () => {
    const value = reliability(["pass"], 3);
    expect(value.passAtK).toBe(true);
    expect(value.passHatK).toBe(false);
  });
});

describe("bucketCounts", () => {
  test("只数非 pass 的桶", () => {
    const counts = bucketCounts([
      { failureBucket: "no-tool" },
      { failureBucket: "no-tool" },
      { failureBucket: "timeout" },
      {},
    ]);
    expect(counts.get("no-tool")).toBe(2);
    expect(counts.get("timeout")).toBe(1);
  });
});