/**
 * judge 的守卫：JSON 解析要容忍围栏，κ/MAE 的数学要能被手算核对。
 * 真实模型调用不进单测；judgeSample 接受注入的 chatFn。
 */
import { describe, expect, test } from "bun:test";
import type { ModelConfig } from "../src/core/types";
import { judgeSample, meanAbsoluteError, parseJudgeScore, publicModel, quadraticWeightedKappa } from "../eval/judge";

const MODEL: ModelConfig = { provider: "mock", model: "mock", maxTokens: 1000, reasoning: "off" };

describe("judge · 解析", () => {
  test("容忍 ```json 围栏和前后废话", () => {
    const score = parseJudgeScore(
      '好的，评分如下：\n```json\n{"dimensions":{"场景落实":5,"人物":3,"节奏与声音":5,"正文卫生":3},"reason":"场景具体"}\n```',
    );
    expect(score.dimensions).toEqual({ 场景落实: 5, 人物: 3, 节奏与声音: 5, 正文卫生: 3 });
    expect(score.total).toBe(4);
    expect(score.reason).toBe("场景具体");
  });

  test("分数夹到 1–5，并丢掉非数字维度", () => {
    const score = parseJudgeScore('{"dimensions":{"a":9,"b":0,"c":"x"},"reason":""}');
    expect(score.dimensions).toEqual({ a: 5, b: 1 });
    expect(score.total).toBe(3);
  });

  test("publicModel 不把 apiKey 写进报告", () => {
    expect(publicModel({ ...MODEL, apiKey: "sk-secret" })).not.toHaveProperty("apiKey");
  });

  test("没有 JSON 时明确失败，不返回 0 分", () => {
    expect(() => parseJudgeScore("我觉得还行")).toThrow("没有返回 JSON");
  });
});

describe("judge · 校准", () => {
  test("完全一致 κ=1，完全反向 κ<0", () => {
    expect(quadraticWeightedKappa([1, 3, 5], [1, 3, 5])).toBe(1);
    expect(quadraticWeightedKappa([1, 3, 5], [5, 3, 1])).toBeLessThan(0);
  });

  test("MAE 是逐项绝对差平均", () => {
    expect(meanAbsoluteError([1, 3, 5], [2, 3, 4])).toBe(0.67);
  });

  test("长度不一致直接报错", () => {
    expect(() => quadraticWeightedKappa([1], [1, 2])).toThrow("长度不一致");
  });
});

describe("judge · 注入模型", () => {
  test("judgeSample 把 rubric 与正文放进 user，并解析注入的回复", async () => {
    let seen = "";
    const score = await judgeSample({
      sample: "第一章正文",
      rubric: "四维 rubric",
      model: MODEL,
      chatFn: async (opts) => {
        seen = opts.messages[0]?.text ?? "";
        return { text: '{"dimensions":{"场景落实":5},"reason":"好"}' };
      },
    });
    expect(seen).toContain("四维 rubric");
    expect(seen).toContain("第一章正文");
    expect(score.total).toBe(5);
  });
});
