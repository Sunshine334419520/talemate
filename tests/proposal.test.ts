/**
 * 提案渲染：纯函数，无 fs、无 ctx。
 *
 * 新的审阅模型：整篇 + diff，没有逐格编号。这里守两件事：
 * 会落盘的字节用户都能看到；局部修改不走提案（走 edit）。
 */
import { describe, test, expect } from "bun:test";
import { planDisplay, renderPlan } from "../src/framework/plan";
import { labelOf, proposalDisplay, renderProposal, reviewable } from "../src/framework/proposal";

const card = [
  "# 角色：林晚",
  "",
  "二房庶女，管着家里的账，却始终不被允许坐上主桌。",
  "",
  "她想要账册，不是为了钱。",
  "",
].join("\n");

const core = [
  "# 核心设定",
  "",
  "## 一句话简介",
  "沈越，被逐出家族的前首席，靠一门不能见光的本事往回爬。",
  "",
  "## 题材 · 频道",
  "男频 · 都市异能",
  "",
].join("\n");

const prose = [
  "# 序列 2 · 夜宴",
  "",
  "主角混进沈家的夜宴，为的是拿到那本账册。",
  "",
  "写的时候：别太顺，中间至少失手一次。",
  "",
].join("\n");

/** 提案里必须出现全部会落盘的字节（标题按标题文本算）。 */
function unseenLines(rendered: string, content: string): string[] {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => {
      const heading = l.match(/^#{1,6}\s+(.*)$/);
      return heading ? !rendered.includes(heading[1]) : !rendered.includes(l);
    });
}

describe("labelOf · 对用户不出现路径", () => {
  test("指南短名 → 层名；没有短名 → 文档自己的 H1；都没有 → 指南标题/草稿", () => {
    expect(labelOf("design/core.md", core)).toBe("核心层");
    expect(labelOf("design/wiki/world.md", "# x\n")).toBe("世界层");
    expect(labelOf("design/characters/林晚.md", card)).toBe("角色：林晚");
    expect(labelOf("design/wiki/岛屿地图.md", "# 岛屿地图\n")).toBe("岛屿地图");
    expect(labelOf("design/outline/vol_2.md", "# 卷 2 · 内城\n")).toBe("卷 2 · 内城");
    expect(labelOf("design/outline/vol_2/s2.md", prose)).toBe("序列 2 · 夜宴");
    expect(labelOf("design/outline/vol_2/s2.md", "没有标题的草稿")).toBe("序列纲");
  });
});

describe("reviewable · 只判“有没有字节可看”", () => {
  test("整篇散文、有标题、没标题，都可以交出去", () => {
    expect(reviewable("design/core.md", core)).toBe(true);
    expect(reviewable("design/core.md", "整段散文，一个标题都没有。")).toBe(true);
    expect(reviewable("design/characters/林晚.md", card)).toBe(true);
    expect(reviewable("design/outline/vol_2/s2.md", prose)).toBe(true);
  });

  test("空/整篇占位才拒绝", () => {
    expect(reviewable("design/core.md", "")).toBe(false);
    expect(reviewable("design/core.md", "  \n\n")).toBe(false);
    expect(reviewable("design/characters/林晚.md", "（待定）\n")).toBe(false);
  });
});

describe("renderProposal · 整篇 + diff", () => {
  test("首次提案：整篇交出，字节齐全，没有路径/格号/操作话术", () => {
    const text = renderProposal({ name: "design/core.md", content: core });
    expect(text).toContain("提案 · 核心层");
    expect(text).toContain("整篇草稿");
    expect(unseenLines(text, core)).toEqual([]);
    expect(text).not.toContain("第 1 格");
    expect(text).not.toContain(".md");
    expect(text).not.toContain("design/");
    expect(text).not.toContain("回复「没问题」");
  });

  test("角色卡也按整篇交出——不需要为它写渲染分支", () => {
    const text = renderProposal({ name: "design/characters/林晚.md", content: card });
    expect(text).toContain("提案 · 角色：林晚");
    expect(text).toContain("二房庶女，管着家里的账");
    expect(unseenLines(text, card)).toEqual([]);
    expect(text).not.toContain("基本档案");
  });

  test("重提：显示与上一版的差异，未改的行不必重看", () => {
    const v2 = core.replace("男频 · 都市异能", "女频 · 都市异能");
    const text = renderProposal({ name: "design/core.md", content: v2, previous: core });
    expect(text).toContain("与上一版提案的差异");
    expect(text).toContain("+女频 · 都市异能");
    expect(text).toContain("-男频 · 都市异能");
    expect(text).toContain("已替换上一版提案");
    expect(text).not.toContain("★本版改动");
  });

  test("与上一版相同 → 明说无改动，不假装有差异", () => {
    const text = renderProposal({ name: "design/core.md", content: core, previous: core });
    expect(text).toContain("（无改动）");
  });
});

describe("proposalDisplay · 结构化卡片", () => {
  test("首次：标题 + 整篇 body，sections 恒为空", () => {
    const view = proposalDisplay({ name: "design/characters/林晚.md", content: card });
    expect(view.kind).toBe("design");
    expect(view.title).toBe("角色：林晚");
    expect(view.sections).toEqual([]);
    expect(view.body).toContain("二房庶女，管着家里的账");
    expect(view.blankNote).toBeUndefined();
  });

  test("重提：body 是 diff，并说明替换了上一版", () => {
    const v2 = prose.replace("别太顺", "别太顺，也别太惨");
    const view = proposalDisplay({ name: "design/outline/vol_2/s2.md", content: v2, previous: prose });
    expect(view.title).toBe("序列 2 · 夜宴");
    expect(view.previousNote).toContain("已替换上一版");
    expect(view.diff).toContain("+写的时候：别太顺，也别太惨");
    expect(view.body).toBeUndefined();
  });

  test("规划的结构化视图不变：正文是规划 markdown", () => {
    const view = planDisplay(3, "# 节拍\n\n1. 上岛。\n2. 点人。\n");
    expect(view.kind).toBe("plan");
    expect(view.title).toBe("第 3 章 · 规划");
    expect(view.sections).toEqual([]);
    expect(view.body).toContain("上岛。");
    expect(renderPlan(3, "# 节拍\n\n1. 上岛。\n")).not.toContain("回复「没问题」");
  });
});