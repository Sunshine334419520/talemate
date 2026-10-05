/**
 * 随包数据的根：`prompts/` 与 `skills/`。
 *
 * 守的是**打包之后才会出现**的那种失败：`import.meta.url` 指向 bundle 内部，这两个目录被算到构建
 * 产物旁边。提示词读不到会抛（至少响），而 skill 一个都发现不了**且不报错**——`scanDir` 把"目录
 * 不存在"当空库。外壳用 `setResourceRoot` 把它钉到随包数据那里；这里验三件事：
 * 没钉时照旧、钉了就用钉的、以及**路径不是模块加载时算的**（否则 import 提升会让外壳永远来不及钉）。
 *
 * 后两条由**用例顺序**一起验：先"没钉"（走回退），再"钉了"（若路径在加载时算过，这一条会读到
 * 回退那份，于是失败）。所以这两条的先后不能调。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinSkillsDir, setResourceRoot } from "../src/core/config";
import { readPrompt } from "../src/prompts";
import { discoverSkills } from "../src/skill/discovery";

const origHome = process.env.TALEMATE_HOME;
let root: string;

afterAll(async () => {
  setResourceRoot(undefined);
  if (origHome === undefined) delete process.env.TALEMATE_HOME;
  else process.env.TALEMATE_HOME = origHome;
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe("随包数据 · prompts 与 skills 的根", () => {
  test("没钉的时候按代码位置推——CLI 与测试什么都不用做", () => {
    expect(readPrompt("tools/skill")).toContain("skill");
    expect(builtinSkillsDir()).toBe(join(import.meta.dir, "..", "skills"));
  });

  test("钉了之后从那里读——打包后靠这一步，否则两个目录都算到构建产物旁边", async () => {
    root = await mkdtemp(join(tmpdir(), "talemate-res-"));
    process.env.TALEMATE_HOME = join(root, "home"); // 别把真的全局库扫进来
    await mkdir(join(root, "prompts", "tools"), { recursive: true });
    await writeFile(join(root, "prompts", "tools", "probe.txt"), "从随包数据里读到的\n");
    await mkdir(join(root, "skills", "probe-skill"), { recursive: true });
    await writeFile(
      join(root, "skills", "probe-skill", "SKILL.md"),
      ["---", "name: probe-skill", "description: 钉子生效了", "---", "", "正文", ""].join("\n"),
    );

    setResourceRoot(root);

    const wrong: string[] = [];
    if (readPrompt("tools/probe") !== "从随包数据里读到的") wrong.push("readPrompt 没走钉住的根");
    if (builtinSkillsDir() !== join(root, "skills")) wrong.push("builtinSkillsDir 没走钉住的根");
    const names = (await discoverSkills()).map((s) => s.name);
    if (!names.includes("probe-skill")) wrong.push(`discoverSkills 没发现钉子那边的库（拿到 ${names.join(",")}）`);
    expect(wrong).toEqual([]);
  });
});
