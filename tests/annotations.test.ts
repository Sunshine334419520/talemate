/**
 * 右栏批注 → 用户消息的合成。这是界面里唯一会被模型读到的字符串，格式错了就是白标一场。
 */
import { describe, expect, test } from "bun:test";
import { composeAnnotationMessage, type Annotation } from "../desktop/src/renderer/annotations";

const note = (id: number, block: number, quote: string, text: string): Annotation => ({
  id,
  block,
  quote,
  text,
});

describe("批注合成", () => {
  test("按正文位置排序，引用与备注原样保留", () => {
    const notes = [
      note(2, 5, "第二处", "改这里"),
      note(1, 2, "第一处", "改那里"),
    ];
    const msg = composeAnnotationMessage("第 6 章", "chapters/chapter_ch6_v2.md", notes);

    expect(msg).toContain("第 6 章里我标了 2 处，帮我改一下。");
    expect(msg).toContain("文档：chapters/chapter_ch6_v2.md");
    expect(msg.indexOf("第一处")).toBeLessThan(msg.indexOf("第二处"));
    expect(msg).toContain("1. 原文：第一处\n   备注：改那里");
    expect(msg).toContain("2. 原文：第二处\n   备注：改这里");
    // 最后一句就是最后一条备注，不再追加"只改这几处"之类的范围话术
    expect(msg.endsWith("备注：改这里")).toBe(true);
  });

  test("同一段按添加顺序", () => {
    const notes = [note(7, 3, "后加的", "B"), note(4, 3, "先加的", "A")];
    const msg = composeAnnotationMessage("第 2 章", "chapters/chapter_ch2_v1.md", notes);
    expect(msg.indexOf("先加的")).toBeLessThan(msg.indexOf("后加的"));
  });

  test("引用里的换行不丢", () => {
    const msg = composeAnnotationMessage(
      "第 2 章",
      "chapters/chapter_ch2_v1.md",
      [note(1, 0, "第一行\n第二行", "保留换行")],
    );
    expect(msg).toContain("原文：第一行\n第二行");
  });

  test("没有备注就不拼消息", () => {
    expect(composeAnnotationMessage("第 6 章", "chapters/chapter_ch6_v2.md", [])).toBe("");
  });
});
