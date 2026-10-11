/**
 * SKILL.md 解析的边界。重点是**行尾**：CRLF 检出曾经让整份 skill 静默消失（见 parse.ts 的注释），
 * 而那种失败不报错、不改签名，只有一条测试钉得住。
 */
import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { builtinSkillsDir } from "../src/core/config";
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

describe("skill · 内置库", () => {
  /**
   * 库里的每一个目录都得能被认出来，**且卡名 == 目录名**。
   *
   * 这不是审美：用户切换文风时写的是**卡名**（`design/core.md` 的「文风」格），而库里是**目录名**
   * ——两者一旦不一致，那张卡在 <available_skills> 里看得见、按名字却取不到，`buildProseBrief`
   * 会报"文风库里没有这个名字"，而它明明就躺在库里。等价于 `parse.ts` 那条 CRLF：不报错、只是那张卡没了。
   */
  test("每个目录都解析得出，且卡名就是目录名——名字是用户唯一的取用方式", async () => {
    const dirs = (await readdir(builtinSkillsDir(), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(dirs.length).toBeGreaterThan(0); // 空库会让下面那条空着通过

    const bad: string[] = [];
    for (const dir of dirs) {
      const file = join(builtinSkillsDir(), dir, "SKILL.md");
      try {
        const skill = parseSkillFile(await readFile(file, "utf-8"), file);
        if (skill.name !== dir) bad.push(`${dir}/ 里的卡名是「${skill.name}」`);
        if (!skill.description) bad.push(`${dir}/ 没有 description——它不进 <available_skills>`);
      } catch {
        bad.push(`${dir}/ 没有能解析的 SKILL.md`);
      }
    }
    expect(bad).toEqual([]);
  });

  /**
   * 每张内置卡都要标 `kind: style` 且有一个**中文** `title`（不等于 id）。
   *
   * 两条都是为了界面那个文风选择器：`kind` 是它把文风卡从普通 skill 里挑出来的唯一判据
   * （库是内置 + 全局 + 项目三处合并的，不筛的话查资料的 skill 也会进候选，选中它等于把
   * 一份工作法当成"一种声音"注进正文窗口）；`title` 是给人看的——没有它界面只能退回显示
   * `style-01-wangwen` 这种 id。
   *
   * 内置库现在全是文风卡，所以这里按"每张都是"来钉。**将来真加了非文风的内置 skill，
   * 这条会红——那是要你显式做一次决定，不是它可以被绕过。**
   */
  test("内置库每张卡都标了 kind: style，且中文 title 不等于 id", async () => {
    const dirs = (await readdir(builtinSkillsDir(), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    const bad: string[] = [];
    for (const dir of dirs) {
      const file = join(builtinSkillsDir(), dir, "SKILL.md");
      try {
        const skill = parseSkillFile(await readFile(file, "utf-8"), file);
        if (skill.kind !== "style") bad.push(`${dir}/ 没有标 kind: style`);
        if (!skill.title) bad.push(`${dir}/ 没有 title——界面只能显示 id`);
        else if (skill.title === skill.name) bad.push(`${dir}/ 的 title 还是 id 本身，没给中文名`);
      } catch {
        bad.push(`${dir}/ 没有能解析的 SKILL.md`);
      }
    }
    expect(bad).toEqual([]);
  });
});
