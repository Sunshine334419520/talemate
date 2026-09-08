/**
 * 离线测试（不打 LLM）：markdown 区块手术 / DocKind 骨架 / 播种 / 跨文档搜索 / 常驻设定注入。
 * 运行：bun test
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, listDocs, readDoc, removeDoc, writeDoc } from "../storage/project";
import { appendBlock, getSection, listHeadings, removeSection, replaceSection } from "./markdown";
import { RESIDENT_DOCS } from "./dockind";
import { renderDocSpec } from "./doc_spec";
import { renderHits, searchDocs } from "./search";
import { buildResidentDocs, buildDocIndex } from "./anchor";
import { addCharacterTool, removeCharacterTool, updateCharacterTool } from "../tool/character_tools";
import type { ToolContext } from "../core/types";

let HOME: string;
let pid: string;

beforeAll(async () => {
  HOME = await mkdtemp(join(tmpdir(), "talemate-test-"));
  process.env.TALEMATE_HOME = HOME;
  const meta = await createProject({ title: "测试书", genre: "悬疑" });
  pid = meta.id;
});

afterAll(async () => {
  await rm(HOME, { recursive: true, force: true });
});

// ─── markdown 区块手术 ───

const sample = [
  "# 任意文档",
  "",
  "## 第一节",
  "（待定）",
  "",
  "## 第二节",
  "（待定）",
  "",
  "### 子小节",
  "（待定）",
  "",
].join("\n");

describe("markdown 区块手术", () => {
  test("getSection 命中一级与二级小节，找不到时给可用列表", () => {
    const s1 = getSection(sample, "第二节");
    expect(s1.found).toBe(true);
    expect(s1.body).toContain("（待定）");
    expect(s1.block).toContain("## 第二节");

    const s2 = getSection(sample, "子小节");
    expect(s2.found).toBe(true);
    expect(s2.block).toContain("### 子小节");

    const miss = getSection(sample, "不存在");
    expect(miss.found).toBe(false);
    expect(miss.available).toContain("第二节");
  });

  test("replaceSection 只改一格，其余保留", () => {
    const next = replaceSection(sample, "第一节", "空难后被困荒岛，只有脑子与自然你死我活。");
    expect(next).toContain("你死我活");
    expect(next).not.toContain("（待定）\n\n## 第二节");
    expect(next).toContain("## 第二节"); // 第二节小节仍在
    expect(getSection(next, "第二节").found).toBe(true);
  });

  test("removeSection 删掉一格", () => {
    const next = removeSection(sample, "第二节");
    expect(next).not.toContain("## 第二节");
    expect(next).toContain("## 第一节");
  });

  test("appendBlock 追加 + 小节索引", () => {
    const appended = appendBlock(sample, "## 角色：沈越\n\n（待定）");
    expect(appended).toContain("## 角色：沈越");
    const titles = listHeadings(appended).map((h) => h.title);
    expect(titles).toEqual(expect.arrayContaining(["第一节", "第二节", "角色：沈越"]));
  });

  test("listHeadings 跳过 HTML 注释里的模板 heading（防幽灵卡）", () => {
    const c = [
      "# characters",
      "",
      "## 角色总表",
      "（待定）",
      "",
      "<!-- 模板：",
      "## 角色：〈名字〉",
      "### 说话方式",
      "-->",
      "",
      "## 角色：林晚",
      "### 说话方式",
      "（待定）",
      "",
    ].join("\n");
    const titles = listHeadings(c).map((h) => h.title);
    expect(titles).toContain("角色总表");
    expect(titles).toContain("角色：林晚");
    expect(titles).not.toContain("角色：〈名字〉"); // 注释里的模板 heading 不算数
  });
});

// ─── doc-spec（结构规范） ───

describe("doc-spec（结构规范）", () => {
  test("常驻设定文档枚举：core + wiki/world 总纲", () => {
    expect(RESIDENT_DOCS).toEqual(["core.md", "wiki/world.md"]);
  });
  test("core 规范 = 小说介绍四格；world = 空间/规则/术语三格（旧格移除）", () => {
    expect(renderDocSpec("core")).toContain("## 一句话简介");
    expect(renderDocSpec("core")).toContain("## 金手指 / 超常设定");
    expect(renderDocSpec("core")).toContain("基调 · 情绪");
    expect(renderDocSpec("core")).not.toContain("一句话卖点");
    expect(renderDocSpec("core")).not.toContain("爽感承诺");
    expect(renderDocSpec("world")).toContain("## 空间与舞台");
    expect(renderDocSpec("world")).toContain("## 规则与秩序");
    expect(renderDocSpec("world")).toContain("## 术语表");
    expect(renderDocSpec("world")).not.toContain("世界观一句话");
    expect(renderDocSpec("world")).not.toContain("势力与人物群像");
    expect(renderDocSpec("world")).not.toContain("历史痕迹与秘密");
    expect(renderDocSpec("characters")).toContain("add-character");
  });
});

// ─── 播种 + 搜索 + 锚点（走真实临时项目） ───

describe("项目懒建 / 搜索 / 锚点", () => {
  test("懒建：建项目不种四层；文件被写入才出现", async () => {
    expect(await listDocs(pid)).toEqual([]);
    await writeDoc(pid, "core.md", "# core\n\n## 一句话简介\n空难后困于荒岛。");
    expect(await listDocs(pid)).toEqual(["core.md"]);
  });

  test("searchDocs 跨文档命中；renderHits 分组", async () => {
    await writeDoc(pid, "core.md", "## 一句话简介\n沈越 想要活着回去。");
    await writeDoc(pid, "wiki/world.md", "## 势力\n沈越 与林晚结伴求生。");
    const hits = await searchDocs(pid, "沈越");
    expect(hits.length).toBe(2);
    const text = renderHits(hits, "沈越");
    expect(text).toContain("core.md");
    expect(text).toContain("wiki/world.md");
    expect(await searchDocs(pid, "不存在的词")).toHaveLength(0);
  });

  test("buildResidentDocs：core + world 总纲常驻全文，无状态包装", async () => {
    await writeDoc(pid, "core.md", "# core\n\n## 一句话简介\n沈越 想要活着回去。");
    await writeDoc(pid, "wiki/world.md", "## 空间与舞台\n一座荒岛。\n\n## 规则与秩序\n无超自然。");
    const resident = await buildResidentDocs(pid);
    expect(resident).toContain("沈越 想要活着回去"); // core 全文
    expect(resident).toContain("一座荒岛。"); // world 总纲全文
    expect(resident).toContain("无超自然。");
    expect(resident).not.toContain("<nvl-state>"); // 无状态包装
    expect(resident).not.toContain("写作进度"); // 进度归工具，不常驻
    const index = await buildDocIndex(pid);
    expect(index).toContain("core.md"); // 索引仍由 list-docs 提供
  });
});

// ─── 角色卡工具（离线：假 ctx 走真实 storage） ───

function makeCtx(projectId: string): ToolContext {
  return {
    projectId,
    sessionId: "test-session",
    agent: "editor",
    signal: new AbortController().signal,
    confirm: async () => true,
    askUser: async () => "（测试）",
    readDoc: (name) => readDoc(projectId, name),
    writeDoc: (name, content) => writeDoc(projectId, name, content),
    removeDoc: (name) => removeDoc(projectId, name),
    listDocs: () => buildDocIndex(projectId),
    listDocPaths: () => listDocs(projectId),
    searchDocs: async (q) => renderHits(await searchDocs(projectId, q), q),
    listChapters: async () => "（无）",
    runSubagent: async () => "（无）",
    loadSkill: async () => undefined,
    saveChapter: async () => "（无）",
  };
}

describe("character-tools（add/update/remove + 总表同步）", () => {
  test("add-character：建规范卡（一文件 5 小节）+ 同步 _index 总表", async () => {
    const r = await addCharacterTool.execute(
      {
        name: "林晚",
        one_line: "空姐，与江屿困同一座岛",
        want_fear: "想要体面地活着回去；最怕成为拖累",
        idiolect: "嘴硬心软，关心反着说；原话『你死了我可不会埋你』",
        habit: "紧张时数东西够不够用",
        function: "江屿的对照与软肋，感情暗线",
      },
      makeCtx(pid) as never,
    );
    expect(r.output).toContain("林晚");
    const content = (await readDoc(pid, "characters/林晚.md"))!;
    expect(content).toContain("# 角色：林晚");
    for (const label of ["一句话定位", "想要 · 最怕", "说话方式", "习惯动作", "在故事中的功能"]) {
      expect(content).toContain(`### ${label}`);
    }
    const idx = (await readDoc(pid, "characters/_index.md"))!;
    expect(idx).toContain("林晚");
  });

  test("add-character：重复名被拒（自愈提示）", async () => {
    const r = await addCharacterTool.execute({ name: "林晚", one_line: "x" }, makeCtx(pid) as never);
    expect(r.output).toContain("已存在");
  });

  test("update-character：只改说话方式，其余保留", async () => {
    const r = await updateCharacterTool.execute(
      { name: "林晚", idiolect: "新版：越在乎越呛，反话里藏担心" },
      makeCtx(pid) as never,
    );
    expect(r.output).toContain("说话方式");
    const content = (await readDoc(pid, "characters/林晚.md"))!;
    expect(content).toContain("新版：越在乎越呛");
    expect(content).toContain("空姐，与江屿困同一座岛"); // 未传字段保留
  });

  test("remove-character：删卡并同步总表", async () => {
    const r = await removeCharacterTool.execute({ name: "林晚" }, makeCtx(pid) as never);
    expect(r.output).toContain("已删除");
    expect(await readDoc(pid, "characters/林晚.md")).toBeUndefined();
    const idx = (await readDoc(pid, "characters/_index.md"))!;
    expect(idx).not.toContain("林晚");
  });
});
