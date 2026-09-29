/**
 * 考据本里**不碰盘**的那一半：题目的规则、笔记的读写形状、recall 的三句话。
 *
 * 落盘、权限、覆盖那几条在 `framework.test.ts` 用真工具跑（那才是 ctx 的责任）。
 * 这里盯的是两处最容易悄悄坏掉的地方：**题目被静默改名**（`safeName` 会把 `"a/b"` 切成 `"b"`），
 * 与**未命中不给清单**（清单是恢复回路，删了它就等于删了换措辞重试这条路）。
 */
import { describe, expect, test } from "bun:test";
import {
  emptyIndexText,
  hasSource,
  hitText,
  indexText,
  matchNotes,
  missText,
  noteName,
  parseNote,
  renderNote,
  todayISO,
  type Note,
} from "../src/framework/research";
import { MAX_NOTE_NAME, safeNoteName } from "../src/storage/notes";

describe("考据本 · 题目", () => {
  test("合法题目原样通过，尾部 .md 摘掉——落盘名字必须是模型知道的那一个", () => {
    const cases: [string, string | undefined][] = [
      ["明代佃农的税怎么收", "明代佃农的税怎么收"],
      ["网文-开篇节奏", "网文-开篇节奏"],
      ["vol_2 战与和".replace(" ", ""), "vol_2战与和"],
      ["明代税制.md", "明代税制"], // 给的是题目不是文件名
      ["  漕运  ", "漕运"],
    ];
    const wrong = cases.filter(([input, want]) => safeNoteName(input) !== want).map(([input]) => input);
    expect(wrong).toEqual([]);
  });

  test("带分隔符的题目一律拒——`safeName` 会把它悄悄切成最后一段，那比拒绝坏得多", () => {
    // `safeName("a/b")` 实际返回 `"b"`、`safeName("../x")` 返回 `"x"`：不报错，落成一个模型
    // 自己都不知道的名字，从此 recall 再也找不回来。判据必须是"原样通过"。
    const cases = ["a/b", "../x", "..", "甲\\乙", "design/考据"];
    const accepted = cases.filter((c) => safeNoteName(c) !== undefined);
    expect(accepted).toEqual([]);
  });

  test("点开头的也拒——写侧放行、读侧不认，就等于造一条读不回来的笔记", () => {
    // `readNote` 挡点开头的名字（隐藏文件），所以这里必须一起挡：两份清单是同一份。
    const accepted = [".hidden", ".", "..md"].filter((c) => safeNoteName(c) !== undefined);
    expect(accepted).toEqual([]);
  });

  test("空格、中文标点、空、超长都不合法", () => {
    const cases = ["明代 佃农", "《明史》税制", "", "   ", "明朝：税制", "税".repeat(MAX_NOTE_NAME + 1)];
    const accepted = cases.filter((c) => safeNoteName(c) !== undefined);
    expect(accepted).toEqual([]);
    expect(safeNoteName("税".repeat(MAX_NOTE_NAME))).toBe("税".repeat(MAX_NOTE_NAME)); // 边界内可以
  });

  test("`noteName` 把三条失败分开报——修法不一样，话就不能一样", () => {
    const bySeparator = noteName("design/明代税制");
    const byLength = noteName("长".repeat(MAX_NOTE_NAME + 5));
    const byChar = noteName("明代 佃农");
    const ok = noteName("明代税制");
    const wrong = [
      "problem" in bySeparator && bySeparator.problem.includes("不能有「/」"),
      "problem" in byLength && byLength.problem.includes("太长"),
      "problem" in byChar && byChar.problem.includes("字符"),
      "name" in ok && ok.name === "明代税制",
    ].filter((x) => !x);
    expect(wrong).toEqual([]);
  });
});

describe("考据本 · 笔记的形状", () => {
  test("盖章用本地日期，不用 UTC——差一个时区就差一天", () => {
    // 2026-09-29T23:30 本地时间：toISOString() 会给出 09-29，而东八区的本地日期已经是 30 号……
    // 反过来在西半球，UTC 会把它算到后一天。所以判据是本地三个字段，不是 ISO 串。
    const d = new Date(2026, 8, 29, 23, 30); // 本地 2026-09-29 23:30
    expect(todayISO(d)).toBe("2026-09-29");
  });

  test("写出去再读回来，题目/日期/正文都不走样", () => {
    const doc = renderNote("明代佃农的税", "2026-09-29", "结论：\n- 一条 https://example.com/a");
    const note = parseNote("明代佃农的税", doc);
    const wrong = [
      note.name === "明代佃农的税",
      note.date === "2026-09-29",
      note.body.includes("https://example.com/a"),
      note.body.startsWith("结论："),
      !note.body.includes("查于"), // 头部不该混进正文
    ].filter((x) => !x);
    expect(wrong).toEqual([]);
  });

  test("没有日期行的笔记读得回来，日期为空串——手放进去的那份也不该炸", () => {
    const note = parseNote("手写的", "# 手写的\n\n就是这么一段。\n");
    expect(note.date).toBe("");
    expect(note.body).toBe("就是这么一段。");
  });
});

describe("考据本 · 命中与文案", () => {
  const NOTES: Note[] = [
    { name: "明代佃租比例", date: "2026-09-29", body: "结论见 https://a.example/1" },
    { name: "漕运路线", date: "2026-09-20", body: "运河自杭州北上。" },
  ];

  test("题目与正文都算命中面；空 query 返回全部（那就是「要目录」）", () => {
    const wrong = [
      matchNotes(NOTES, "佃租").length === 1,
      matchNotes(NOTES, "杭州").length === 1, // 命中在正文里
      matchNotes(NOTES, "漕运路线")[0]?.name === "漕运路线",
      matchNotes(NOTES, "没有这回事").length === 0,
      matchNotes(NOTES, "").length === 2,
    ].filter((x) => !x);
    expect(wrong).toEqual([]);
  });

  test("命中一条 = 原文交出去，带着日期与出处", () => {
    const text = hitText([NOTES[0]]);
    const missing = ["明代佃租比例", "查于 2026-09-29", "https://a.example/1"].filter((s) => !text.includes(s));
    expect(missing).toEqual([]);
  });

  test("未命中要给已有清单——那是换措辞重试的路，不是可有可无的装饰", () => {
    const text = missText("明代税收", ["明代佃租比例", "漕运路线"]);
    const missing = ["没有找到研究笔记「明代税收」", "明代佃租比例", "漕运路线"].filter((s) => !text.includes(s));
    expect(missing).toEqual([]);
  });

  test("空库两句话都不该读起来像失败", () => {
    const miss = missText("明代税收", []);
    const index = emptyIndexText();
    // 「没有找到」在空库那句里可以出现，但必须紧接着说清"这里还什么都没有 + 怎么建第一条"，
    // 否则研究员会以为是自己查错了
    const wrong = [
      miss.includes("还一条都没有"),
      miss.includes("remember"),
      !index.includes("没有找到"), // 要目录时不该说"没找到"
      index.includes("remember"),
    ].filter((x) => !x);
    expect(wrong).toEqual([]);
  });

  test("要目录时列出全部题目", () => {
    const text = indexText(["明代佃租比例", "漕运路线"]);
    const missing = ["2 条", "明代佃租比例", "漕运路线"].filter((s) => !text.includes(s));
    expect(missing).toEqual([]);
  });

  test("出处判据只认 http(s)", () => {
    const wrong = [
      hasSource("见 https://a.example/x"),
      hasSource("见 http://a.example/x"),
      !hasSource("见 www.a.example"),
      !hasSource("没有任何链接"),
    ].filter((x) => !x);
    expect(wrong).toEqual([]);
  });
});
