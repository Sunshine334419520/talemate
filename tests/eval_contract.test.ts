/**
 * 评测契约的守卫：case 能被无歧义地读懂、时钟能被冻结。
 *
 * 这里只测 M0 的契约与校验器，不跑模型、不跑 case；runner 与 replay 在 M1 才有测试。
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildSystemPrompt } from "../src/context/assemble";
import { today } from "../src/core/config";
import { validateAll, validateCase, validateVariants } from "../eval/validate";

const EVAL_ROOT = join(import.meta.dir, "..", "eval");

/** 一份最小的合法 case；每个反向用例只改一处。 */
const MINIMAL = {
  id: "workflow-minimal",
  family: "workflow",
  base: true,
  brief: "随便说一句",
  checks: [{ kind: "file-exists", path: "design/core.md" }],
  budget: { maxTurns: 1, maxSteps: 4, maxTokens: 1000 },
};

describe("时钟 · 冻结", () => {
  test("TALEMATE_TODAY 是合法日期时原样返回", () => {
    expect(today({ TALEMATE_TODAY: "2026-11-01" })).toBe("2026-11-01");
  });

  test("格式不对就退回真实日期，不静默用坏值", () => {
    const value = today({ TALEMATE_TODAY: "2026/11/01" });
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(value).not.toBe("2026/11/01");
  });

  test("system prompt 的 env 行用的是冻结日期", () => {
    const prev = process.env.TALEMATE_TODAY;
    process.env.TALEMATE_TODAY = "2026-11-01";
    try {
      const system = buildSystemPrompt({
        projectTitle: "测试书",
        agentName: "搭档",
        roleSystem: "角色",
        rules: "",
        skills: "",
      });
      expect(system.startsWith("2026-11-01 作品：测试书 当前角色：搭档")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.TALEMATE_TODAY;
      else process.env.TALEMATE_TODAY = prev;
    }
  });
});

describe("case 契约 · 校验器", () => {
  test("仓库里的 case 全部通过；M0 至少有一个 base case", async () => {
    const result = await validateAll(EVAL_ROOT);
    expect(result.issues).toEqual([]);
    expect(result.cases).toBeGreaterThan(0);
    expect(result.base).toBeGreaterThan(0);
  });

  test("仓库里的变体 patch 全部命中（替换串失效会静默退化成 baseline）", async () => {
    const result = await validateVariants(EVAL_ROOT);
    expect(result.issues).toEqual([]);
    expect(result.variants).toBeGreaterThan(0);
  });

  test("最小合法 case 没有意见", () => {
    expect(validateCase(MINIMAL)).toEqual([]);
  });

  test("未知 family / id 前缀不符 / 空 checks / 坏 budget 一次列全", () => {
    const issues = validateCase({
      ...MINIMAL,
      id: "X",
      family: "nope",
      checks: [],
      budget: { maxTurns: 0, maxSteps: -1 },
    });
    const text = issues.map((i) => `${i.where}:${i.message}`).join("\n");
    expect(text).toContain("family");
    expect(text).toContain("id");
    expect(text).toContain("checks");
    expect(text).toContain("budget.maxTurns");
    expect(text).toContain("budget.maxSteps");
    expect(text).toContain("budget.maxTokens");

    const prefix = validateCase({ ...MINIMAL, id: "prose-minimal" });
    expect(prefix.map((i) => i.message).join("\n")).toContain('id 必须以 "workflow-" 开头');
  });

  test("未知判据、缺字段、坏 afterTurn 都被抓住", () => {
    const issues = validateCase({
      ...MINIMAL,
      checks: [
        { kind: "no-such-check" },
        { kind: "file-contains", path: "design/core.md" },
        { kind: "max-steps", n: 0 },
        { kind: "tool-order", names: [] },
        { kind: "file-exists", path: "a.md", afterTurn: -1 },
      ],
    });
    const text = issues.map((i) => `${i.where}:${i.message}`).join("\n");
    expect(text).toContain("未知判据");
    expect(text).toContain("file-contains 缺少字段：text");
    expect(text).toContain("n 必须是正整数");
    expect(text).toContain("names 必须是非空的字符串数组");
    expect(text).toContain("afterTurn 必须是非负整数");
  });

  test("change-recorded 的 changeKind 可选，但值必须合法", () => {
    expect(
      validateCase({
        ...MINIMAL,
        checks: [{ kind: "change-recorded", path: "design/core.md", changeKind: "modified" }],
      }),
    ).toEqual([]);
    const issues = validateCase({
      ...MINIMAL,
      checks: [{ kind: "change-recorded", path: "design/core.md", changeKind: "renamed" }],
    });
    expect(issues.map((i) => i.message).join("\n")).toContain("changeKind");
  });
});
