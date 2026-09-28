/**
 * SKILL.md 解析的边界。重点是**行尾**：CRLF 检出曾经让整份 skill 静默消失（见 parse.ts 的注释），
 * 而那种失败不报错、不改签名，只有一条测试钉得住。
 */
import { describe, expect, test } from "bun:test";
import { parseSkillFile } from "../src/skill/parse";

const LF = ["---", "name: prose", "description: 白话现代中文", "---", "", "# 正文文风纪律", "", "只写正文。", ""].join("\n");
const CRLF = LF.replace(/\n/g, "\r\n");

describe("skill · SKILL.md 解析", () => {
  test("LF 与 CRLF 检出解析出同一份东西——行尾不该决定一个 skill 存不存在", () => {
    const a = parseSkillFile(LF, "lf/SKILL.md");
    const b = parseSkillFile(CRLF, "crlf/SKILL.md");
    const same = [
      a.name === "prose" && b.name === "prose",
      a.description === "白话现代中文" && b.description === "白话现代中文",
      a.body === b.body,
    ];
    expect(same).toEqual([true, true, true]);
  });

  test("frontmatter 之后才是正文，前导空行不留", () => {
    expect(parseSkillFile(CRLF, "x/SKILL.md").body.startsWith("# 正文文风纪律")).toBe(true);
  });

  test("缺 name 抛错——宁可让 scanDir 记一笔，也不要一个没有名字的 skill", () => {
    const noName = ["---", "description: 只有描述", "---", "", "正文", ""].join("\n");
    expect(() => parseSkillFile(noName, "bad/SKILL.md")).toThrow(/缺 name/);
  });

  test("没有 frontmatter 也抛错——name 是唯一的必填，缺了就不算一个 skill", () => {
    expect(() => parseSkillFile("# 就是个 md\n\n内容。\n", "p/SKILL.md")).toThrow(/缺 name/);
  });
});
