/**
 * CLI 资产命令的纯逻辑：`/assets` 的清单与 `/asset` 的增删改查。
 *
 * 不驱动 REPL（那只能在真终端里跑），但把命令字符串 → 落盘 → 清单/展示这条链整条跑一遍；
 * 删除确认以回调注入，所以"拒绝"与"确认"两条分支都能测。
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, writeDoc } from "../src/storage/project";
import { renderAssetList, runAssetCommand, assetUsage } from "../src/cli_assets";

let HOME = "";
let pid = "";
let prevHome: string | undefined;

const yes = async (): Promise<boolean> => true;
const no = async (): Promise<boolean> => false;

beforeAll(async () => {
  HOME = await mkdtemp(join(tmpdir(), "talemate-cli-assets-"));
  prevHome = process.env.TALEMATE_HOME;
  process.env.TALEMATE_HOME = HOME;
  pid = (await createProject({ title: "CLI 资产" })).id;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.TALEMATE_HOME;
  else process.env.TALEMATE_HOME = prevHome;
  await rm(HOME, { recursive: true, force: true });
});

describe("/assets 与 /asset", () => {
  test("空书的清单给下一步；不认识的种类给可选清单", async () => {
    expect(await renderAssetList(pid)).toContain("还没有资产");
    const bad = await renderAssetList(pid, "不存在");
    expect(bad).toContain("没有这种资产");
    expect(bad).toContain("character");
    expect(assetUsage()).toContain("/asset new");
  });

  test("新建角色/大纲/节拍；清单显示章范围与状态，中文种类名可过滤", async () => {
    const c = await runAssetCommand(pid, "new character 沈越", yes);
    expect(c).toContain("design/characters/沈越.md");
    const o = await runAssetCommand(pid, "new outline 第1卷", yes);
    expect(o).toContain("design/outline/第1卷.md");
    const b = await runAssetCommand(pid, "new beat design/outline/第1卷.md 进内城", yes);
    expect(b).toContain("design/outline/第1卷/beats/b01.md");
    expect(b).toContain("覆盖第 1–1 章");

    const list = await renderAssetList(pid);
    expect(list).toContain("[character] 沈越");
    expect(list).toContain("[outline] 第1卷 · 1 拍 · 第 1–1 章");
    expect(list).toContain("[beat] 进内城 · 第 1–1 章 · 待开始");

    const characters = await renderAssetList(pid, "角色");
    expect(characters).toContain("（角色）");
    expect(characters).toContain("沈越");
    expect(characters).not.toContain("[outline]");
  });

  test("set 按字段类型改：整数、枚举；清单里的章范围随之变化", async () => {
    const set = await runAssetCommand(pid, "set design/outline/第1卷/beats/b01.md chapters 3", yes);
    expect(set).toContain("已改");
    const list = await renderAssetList(pid);
    expect(list).toContain("第 1–3 章");

    const role = await runAssetCommand(pid, "set design/characters/沈越.md role protagonist", yes);
    expect(role).toContain("已改");
    const show = await runAssetCommand(pid, "show design/characters/沈越.md", yes);
    expect(show).toContain("[character] 沈越");
    expect(show).toContain("role: protagonist");

    const badNumber = await runAssetCommand(pid, "set design/outline/第1卷/beats/b01.md chapters 三", yes);
    expect(badNumber).toContain("整数");
  });

  test("show：不存在的路径 / 未登记文档", async () => {
    await writeDoc(pid, "design/notes.md", "# 笔记\n\n随手记。\n");
    expect(await runAssetCommand(pid, "show design/notes.md", yes)).toContain("未登记种类");
    expect(await runAssetCommand(pid, "show design/没有.md", yes)).toContain("没有这份文件");
    const list = await renderAssetList(pid);
    expect(list).toContain("另有 1 份未登记文档");
  });

  test("move 保留内容；delete 的拒绝与确认两条分支", async () => {
    const moved = await runAssetCommand(pid, "move design/characters/沈越.md design/characters/沈越改.md", yes);
    expect(moved).toContain("design/characters/沈越改.md");
    expect((await renderAssetList(pid, "character")).split("\n").some((l) => l.includes("沈越改"))).toBe(true);

    expect(await runAssetCommand(pid, "delete design/characters/沈越改.md", no)).toBe("没有删。");
    expect(await renderAssetList(pid, "character")).toContain("沈越改");

    expect(await runAssetCommand(pid, "delete design/characters/沈越改.md", yes)).toContain("已删除");
    expect(await renderAssetList(pid, "character")).toContain("还没有「角色」");
  });

  test("删除大纲：有节拍时拒绝，--cascade 才连删", async () => {
    const refused = await runAssetCommand(pid, "delete design/outline/第1卷.md", yes);
    expect(refused).toContain("节拍");
    const done = await runAssetCommand(pid, "delete design/outline/第1卷.md --cascade", yes);
    expect(done).toContain("design/outline/第1卷.md");
    expect(done).toContain("b01.md");
    expect(await renderAssetList(pid, "outline")).toContain("还没有「大纲");
  });

  test("章节要显式路径；节拍要所属大纲", async () => {
    expect(await runAssetCommand(pid, "new chapter", yes)).toContain("需要显式路径");
    const chapter = await runAssetCommand(pid, "new chapter chapters/chapter_ch1_v1.md 第一章", yes);
    expect(chapter).toContain("[chapter] 第一章");
    expect(await runAssetCommand(pid, "new beat", yes)).toContain("需要所属大纲");
  });
});