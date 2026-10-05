/**
 * prompt 之间的**契约守卫**（与 `docs.test.ts` / `agents.test.ts` 同一路数：让约定长在 CI 里）。
 *
 * 守的是第一处真正的重复：**规划这份契约有两份写本**——`propose-plan` 的说明（提交规划的人读）
 * 与规划者的 persona（起草规划的人读）。两份必须列出同一套产物，理由与 skill 那条一样：
 * **两份说两套话，迟早一处要求建卡、另一处不认**，而且看不出是哪一份在生效。
 *
 * 判据是**从正文里抽出来的路径**，不是手抄一份清单——手抄的清单自己就会烂。
 */
import { describe, expect, test } from "bun:test";
import { readPrompt } from "../src/prompts";

/** 正文里出现的"作品/工作区路径"：`state/progress.md`、`design/characters/<名>.md`… */
function artifactsIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(?:design|chapters|state)\/[^\s,;:()（）]+/g)) {
    // 归一：去掉尾部的标点与包裹符号（`` `path` `` 与 `(path:` 都该认出是同一条路径）
    out.add(m[0].replace(/[.。，、）)`"'»]+$/, ""));
  }
  return out;
}

describe("规划契约 · 两份写本的产物词汇", () => {
  test("propose-plan 与规划者列出同一套产物路径", () => {
    const submit = artifactsIn(readPrompt("tools/propose-plan"));
    const planner = artifactsIn(readPrompt("planner.system"));

    // 两边都得有点东西（否则模式一旦失效，下面那条会空着通过）
    expect(submit.size).toBeGreaterThan(0);
    expect(planner.size).toBeGreaterThan(0);

    const missing = [
      ...[...submit].filter((p) => !planner.has(p)).map((p) => `planner.system 少了 ${p}`),
      ...[...planner].filter((p) => !submit.has(p)).map((p) => `propose-plan 少了 ${p}`),
    ];
    expect(missing).toEqual([]);
  });

  test("新人物的卡在两边都排进产物，而且都排在正文之前", () => {
    // 这条盯的是"建卡在写作之前"这个顺序——它是流程的要点，不是措辞上的巧合：
    // 卡排在正文后面，就等于事后从正文反推，那是墓志铭不是合同（见 characters.md）。
    const missing: string[] = [];
    for (const id of ["tools/propose-plan", "planner.system"]) {
      const text = readPrompt(id);
      if (!text.includes("design/characters/")) missing.push(`${id} 没有把角色卡排进产物`);
      const card = text.indexOf("design/characters/");
      const prose = text.indexOf("chapters/chapter_ch");
      if (card < 0 || prose < 0 || card > prose) missing.push(`${id} 里角色卡没有排在正文之前`);
    }
    expect(missing).toEqual([]);
  });
});
