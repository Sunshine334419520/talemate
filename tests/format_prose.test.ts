/**
 * 正文排版的守卫：一句一段是落盘前的确定性规则，不靠模型自觉。
 *
 * 重点不是“切得好看”，而是三条边界：
 *   1. 只在句号 `。` 后切；问号、感叹号、省略号、逗号、分号都不切；
 *   2. 对话引号里的连续讲话不拆，避免切出没有开引号的残片；
 *   3. 标题、列表、引用、代码围栏原样保留。
 */
import { describe, expect, test } from "bun:test";
import { formatProse } from "../src/framework/format_prose";

describe("formatProse · 一句一段", () => {
  test("一段多句 → 一句一段", () => {
    expect(formatProse("他停下车。拔钥匙。上楼。开门。\n")).toBe(
      "他停下车。\n\n拔钥匙。\n\n上楼。\n\n开门。\n",
    );
  });

  test("只有句号切；问号、感叹号、省略号不切", () => {
    expect(formatProse("甲。乙？丙！丁……\n")).toBe("甲。\n\n乙？丙！丁……\n");
    expect(formatProse("走不走？走！他停了一下……然后走了。\n")).toBe(
      "走不走？走！他停了一下……然后走了。\n",
    );
  });

  test("逗号、分号不切", () => {
    expect(formatProse("他说；走吧，别停。\n")).toBe("他说；走吧，别停。\n");
  });

  test("对话引号里的连续讲话保持一段；引号后的叙述再切", () => {
    expect(formatProse("他说：“走吧。”她没动。\n")).toBe("他说：“走吧。”\n\n她没动。\n");
    expect(formatProse("“行不行，得拆开看。您要是信不过我，现在就可以换人。”\n")).toBe(
      "“行不行，得拆开看。您要是信不过我，现在就可以换人。”\n",
    );
  });

  test("标题、列表、引用、代码围栏原样保留", () => {
    const input = [
      "# 第 1 章",
      "",
      "正文。第二句。",
      "",
      "- 列表一。列表二。",
      "> 引用一。引用二。",
      "",
      "```",
      "甲。乙。",
      "```",
      "",
    ].join("\n");
    const lines = formatProse(input).split("\n");
    expect(lines.slice(0, 3)).toEqual(["# 第 1 章", "", "正文。"]);
    expect(lines).toContain("- 列表一。列表二。");
    expect(lines).toContain("> 引用一。引用二。");
    expect(lines).toContain("甲。乙。");
  });

  test("已经是一句一段时保持稳定（幂等）", () => {
    const once = formatProse("甲。乙。丙。\n");
    expect(formatProse(once)).toBe(once);
  });

  test("沿用文件自己的行尾", () => {
    expect(formatProse("甲。乙。\r\n")).toBe("甲。\r\n\r\n乙。\r\n");
  });

  test("空内容保持空", () => {
    expect(formatProse("")).toBe("");
    expect(formatProse("\n\n")).toBe("");
  });
});
