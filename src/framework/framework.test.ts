/**
 * 离线测试（不打 LLM）：markdown 区块手术 / Layer 骨架 / 播种 / 跨文档搜索 / 常驻设定注入。
 * 运行：bun test
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, listDesigns, readDesign, removeDesign, writeDesign } from "../storage/project";
import { appendBlock, getSection, listHeadings, removeSection, replaceSection } from "./markdown";
import { RESIDENT_DESIGNS } from "./layers";
import { renderDesignSpec } from "./design_spec";
import { renderHits, searchDesigns } from "./search";
import { buildResidentDesigns, buildDesignIndex } from "./anchor";
import { addCharacterTool, removeCharacterTool, updateCharacterTool } from "../tool/character_tools";
import { applyDesignTool, proposeDesignTool } from "../tool/design_tools";
import { defineTool } from "../tool/define";
import { ToolRegistry } from "../tool/registry";
import { executeToolPart } from "../tool/runner";
import type { PendingProposal, ToolContext } from "../core/types";

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

  test("listHeadings(content, 1) 能拿到 H1（取文档标题用），默认仍从 H2 起", () => {
    expect(listHeadings(sample, 1).map((h) => h.title)).toContain("任意文档");
    expect(listHeadings(sample).map((h) => h.title)).not.toContain("任意文档");
  });
});

// ─── design-spec（结构规范） ───

describe("design-spec（结构规范）", () => {
  test("常驻设定文档枚举：core + wiki/world 总纲", () => {
    expect(RESIDENT_DESIGNS).toEqual(["core.md", "wiki/world.md"]);
  });
  test("core 规范 = 小说介绍四格；world = 空间/规则/术语三格（旧格移除）", () => {
    expect(renderDesignSpec("core")).toContain("## 一句话简介");
    expect(renderDesignSpec("core")).toContain("## 金手指 / 超常设定");
    expect(renderDesignSpec("core")).toContain("基调 · 情绪");
    expect(renderDesignSpec("core")).not.toContain("一句话卖点");
    expect(renderDesignSpec("core")).not.toContain("爽感承诺");
    expect(renderDesignSpec("world")).toContain("## 空间与舞台");
    expect(renderDesignSpec("world")).toContain("## 规则与秩序");
    expect(renderDesignSpec("world")).toContain("## 术语表");
    expect(renderDesignSpec("world")).not.toContain("世界观一句话");
    expect(renderDesignSpec("world")).not.toContain("势力与人物群像");
    expect(renderDesignSpec("world")).not.toContain("历史痕迹与秘密");
    expect(renderDesignSpec("characters")).toContain("add-character");
  });

  test("每格三件齐备（写/别写/写成）+ 通篇形制 + 写入 key", () => {
    const core = renderDesignSpec("core");
    expect(core).toContain("## 题材 · 频道");
    expect(core).toContain("写：");
    expect(core).toContain("别写：");
    expect(core).toContain("写成：");
    expect(core).toContain("通篇：");
    expect(core).toContain("layer: core"); // 固定层的写入 key 就地给出
    // 题材格的规范里不再有"货架与读者预期契约"这类承诺语
    expect(core).not.toContain("货架与读者预期契约");
    // 角色层是一角色一卡，不套通篇形制（它的字段规范在 characters.ts）
    expect(renderDesignSpec("characters")).not.toContain("通篇：");
  });
});

// ─── 播种 + 搜索 + 锚点（走真实临时项目） ───

describe("项目懒建 / 搜索 / 锚点", () => {
  test("懒建：建项目不种四层；文件被写入才出现", async () => {
    expect(await listDesigns(pid)).toEqual([]);
    await writeDesign(pid, "core.md", "# core\n\n## 一句话简介\n空难后困于荒岛。");
    expect(await listDesigns(pid)).toEqual(["core.md"]);
  });

  test("searchDesigns 跨文档命中；renderHits 分组", async () => {
    await writeDesign(pid, "core.md", "## 一句话简介\n沈越 想要活着回去。");
    await writeDesign(pid, "wiki/world.md", "## 势力\n沈越 与林晚结伴求生。");
    const hits = await searchDesigns(pid, "沈越");
    expect(hits.length).toBe(2);
    const text = renderHits(hits, "沈越");
    expect(text).toContain("core.md");
    expect(text).toContain("wiki/world.md");
    expect(await searchDesigns(pid, "不存在的词")).toHaveLength(0);
  });

  test("buildResidentDesigns：core + world 总纲常驻全文，无状态包装", async () => {
    await writeDesign(pid, "core.md", "# core\n\n## 一句话简介\n沈越 想要活着回去。");
    await writeDesign(pid, "wiki/world.md", "## 空间与舞台\n一座荒岛。\n\n## 规则与秩序\n无超自然。");
    const resident = await buildResidentDesigns(pid);
    expect(resident).toContain("沈越 想要活着回去"); // core 全文
    expect(resident).toContain("一座荒岛。"); // world 总纲全文
    expect(resident).toContain("无超自然。");
    expect(resident).not.toContain("<nvl-state>"); // 无状态包装
    expect(resident).not.toContain("写作进度"); // 进度归工具，不常驻
    const index = await buildDesignIndex(pid);
    expect(index).toContain("core.md"); // 索引仍由 list-designs 提供
  });
});

// ─── 角色卡工具（离线：假 ctx 走真实 storage） ───

/** 测试用 ctx：pending 与"给用户看的文本"都挂在外面，测试要能直接查看。 */
function makeCtx(projectId: string): ToolContext & { pending: Map<string, PendingProposal>; shown: string[] } {
  const pending = new Map<string, PendingProposal>();
  const shown: string[] = [];
  return {
    projectId,
    sessionId: "test-session",
    agent: "editor",
    signal: new AbortController().signal,
    confirm: async () => true,
    askUser: async () => "（测试）",
    showProposal: (text) => {
      shown.push(text);
    },
    getProposal: (name) => pending.get(name),
    setProposal: (p) => {
      pending.set(p.name, p);
    },
    clearProposal: (name) => {
      pending.delete(name);
    },
    pending,
    shown,
    readDesign: (name) => readDesign(projectId, name),
    writeDesign: (name, content) => writeDesign(projectId, name, content),
    removeDesign: (name) => removeDesign(projectId, name),
    listDesigns: () => buildDesignIndex(projectId),
    listDesignPaths: () => listDesigns(projectId),
    searchDesigns: async (q) => renderHits(await searchDesigns(projectId, q), q),
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
    const content = (await readDesign(pid, "characters/林晚.md"))!;
    expect(content).toContain("# 角色：林晚");
    for (const label of ["一句话定位", "想要 · 最怕", "说话方式", "习惯动作", "在故事中的功能"]) {
      expect(content).toContain(`### ${label}`);
    }
    const idx = (await readDesign(pid, "characters/_index.md"))!;
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
    const content = (await readDesign(pid, "characters/林晚.md"))!;
    expect(content).toContain("新版：越在乎越呛");
    expect(content).toContain("空姐，与江屿困同一座岛"); // 未传字段保留
  });

  test("remove-character：删卡并同步总表", async () => {
    const r = await removeCharacterTool.execute({ name: "林晚" }, makeCtx(pid) as never);
    expect(r.output).toContain("已删除");
    expect(await readDesign(pid, "characters/林晚.md")).toBeUndefined();
    const idx = (await readDesign(pid, "characters/_index.md"))!;
    expect(idx).not.toContain("林晚");
  });
});

// ─── design 写入两段式：propose（不写盘）→ 用户回话 → apply（写提案那一份） ───

/** 用无规范登记的专题页做落盘往返，避免和本文件其它用例抢 core.md / characters/。 */
const DOC = "wiki/test-proposal.md";
const DOC2 = "wiki/test-guard.md";

describe("design 写入：提案 → 回话 → 落盘", () => {
  test("propose-design 只摆提案、不写盘，并声明 halt", async () => {
    expect(proposeDesignTool.halt).toBe(true);
    expect(applyDesignTool.halt).toBeUndefined();

    const ctx = makeCtx(pid);
    const content = "# 舞台\n\n## 空间与舞台\n一座与世隔绝的岛。\n\n## 规则与秩序\n离开就死。\n";
    const r = await proposeDesignTool.execute({ name: DOC, content }, ctx as never);

    expect(r.output).toContain("尚未写入");
    expect(await readDesign(pid, DOC)).toBeUndefined(); // 关键：一个字节都没落盘
    expect(ctx.pending.get(DOC)?.approved).toBe(false); // 同意由用户回话决定，默认否

    const shown = ctx.shown.join("\n");
    expect(shown).toContain("1. 空间与舞台");
    expect(shown).toContain("2. 规则与秩序");
    expect(shown).toContain("回复「没问题」就写入");
    expect(shown).not.toContain(".md"); // 对用户不出现路径
    expect(shown).not.toContain("design/");
  });

  test("apply-design：未同意不写；同意后落盘的字节 == 提案内容", async () => {
    const ctx = makeCtx(pid);
    const content = "# 舞台\n\n## 空间与舞台\n一座与世隔绝的岛。\n\n## 规则与秩序\n离开就死。\n";
    await proposeDesignTool.execute({ name: DOC, content }, ctx as never);

    const denied = await applyDesignTool.execute({ name: DOC }, ctx as never);
    expect(denied.output).toContain("还没同意");
    expect(await readDesign(pid, DOC)).toBeUndefined();

    // harness 判同意（等价于 Session.markPendingApproval 按用户回话置位）
    ctx.pending.get(DOC)!.approved = true;
    const ok = await applyDesignTool.execute({ name: DOC }, ctx as never);
    expect(ok.output).toContain("已按提案写入");
    expect(await readDesign(pid, DOC)).toBe(content.trim()); // 逐字节一致
    expect(ctx.pending.has(DOC)).toBe(false); // 落盘后清提案
  });

  test("apply-design：没有待落盘提案就拒绝（fail-closed）", async () => {
    const r = await applyDesignTool.execute({ name: DOC2 }, makeCtx(pid) as never);
    expect(r.output).toContain("没有");
  });

  test("单格提案：整篇快照被改过 → 拒绝落盘（不盲写）", async () => {
    const ctx = makeCtx(pid);
    await writeDesign(pid, DOC2, "# 舞台\n\n## 空间与舞台\n旧的一版。\n\n## 规则与秩序\n（待定）\n");
    await proposeDesignTool.execute({ name: DOC2, content: "新的空间描述。", section: "空间与舞台" }, ctx as never);
    ctx.pending.get(DOC2)!.approved = true;

    // 提案之后文档被别处改过
    await writeDesign(pid, DOC2, "# 舞台\n\n## 空间与舞台\n被别人改过了。\n\n## 规则与秩序\n（待定）\n");
    const r = await applyDesignTool.execute({ name: DOC2 }, ctx as never);

    expect(r.output).toContain("被改动过");
    expect(await readDesign(pid, DOC2)).toContain("被别人改过了"); // 原样，没被覆盖
  });

  test("单格提案落盘：只改那一格，其余原样（走 replaceSection）", async () => {
    const ctx = makeCtx(pid);
    const before = "# 舞台\n\n## 空间与舞台\n旧的一版。\n\n## 规则与秩序\n离开就死。\n";
    await writeDesign(pid, DOC2, before);
    await proposeDesignTool.execute({ name: DOC2, content: "北岸全是礁石；南岸有废弃码头。", section: "空间与舞台" }, ctx as never);
    ctx.pending.get(DOC2)!.approved = true;

    const r = await applyDesignTool.execute({ name: DOC2 }, ctx as never);
    expect(r.output).toContain("已按提案改写");

    const after = (await readDesign(pid, DOC2))!;
    expect(after).toContain("北岸全是礁石；南岸有废弃码头。");
    expect(after).not.toContain("旧的一版。");
    expect(after).toContain("离开就死。"); // 另一格原样不动
    expect(after).toContain("## 规则与秩序"); // 标题也没被吃掉
  });

  test("守卫：没标题的正文 / section 带标题行 / 派生文件 _index.md 都被拒", async () => {
    const ctx = makeCtx(pid);
    const flat = await proposeDesignTool.execute({ name: "wiki/x.md", content: "整段散文，一个标题都没有。" }, ctx as never);
    expect(flat.output).toContain("没法逐格审阅");

    await writeDesign(pid, DOC2, "# X\n\n## 第一节\n（待定）\n");
    const headed = await proposeDesignTool.execute({ name: DOC2, content: "## 第一节\n正文", section: "第一节" }, ctx as never);
    expect(headed.output).toContain("不要带标题行");

    const idx = await proposeDesignTool.execute({ name: "characters/_index.md", content: "## a\nb" }, ctx as never);
    expect(idx.output).toContain("自动维护");
  });

  test("固定层用 layer：路径由工具定，模型不给路径", async () => {
    const ctx = makeCtx(pid);
    const content = "# 舞台\n\n## 空间与舞台\n一座与世隔绝的岛。\n";
    const r = await proposeDesignTool.execute({ layer: "world", content }, ctx as never);

    expect(r.output).toContain("尚未写入");
    expect(ctx.pending.has("wiki/world.md")).toBe(true); // 模型只给了 layer，路径是工具补的
    ctx.pending.get("wiki/world.md")!.approved = true;

    const ok = await applyDesignTool.execute({ layer: "world" }, ctx as never);
    expect(ok.output).toContain("已按提案写入");
    expect(await readDesign(pid, "wiki/world.md")).toBe(content.trim());
  });

  test("守卫：固定层的主文档不许写到别处（world.md → 指回 wiki/world.md）", async () => {
    const ctx = makeCtx(pid);
    const r = await proposeDesignTool.execute({ name: "world.md", content: "# x\n\n## a\nb\n" }, ctx as never);
    expect(r.output).toContain("design/wiki/world.md"); // 给回正确路径，让它自纠
    expect(ctx.pending.size).toBe(0); // 没有登记任何提案
  });

  test("守卫：characters 不是可写的 layer；layer 与 name 不能同时给", async () => {
    const ctx = makeCtx(pid);
    const a = await proposeDesignTool.execute({ layer: "characters", content: "# x\n\n## a\nb\n" }, ctx as never);
    expect(a.output).toContain("add-character");

    const b = await proposeDesignTool.execute(
      { layer: "world", name: "wiki/x.md", content: "# x\n\n## a\nb\n" },
      ctx as never,
    );
    expect(b.output).toContain("只能给一个");
  });
});

// ─── runner：halt 只在成功时置位 ───

describe("tool runner · halt", () => {
  test("成功才 halt；抛错/校验失败不能停轮（否则循环死在可自愈的错误上）", async () => {
    const reg = new ToolRegistry();
    reg.register(
      defineTool<{ fail?: boolean }>({
        id: "t-halt",
        description: "",
        input: { type: "object" },
        halt: true,
        async execute(args) {
          if (args.fail) throw new Error("校验失败");
          return { output: "ok" };
        },
      }),
    );

    const okPart = await executeToolPart("editor", { id: "1", name: "t-halt", input: {} }, reg, makeCtx(pid) as never);
    expect(okPart.type === "tool" && okPart.halt).toBe(true);

    const badPart = await executeToolPart("editor", { id: "2", name: "t-halt", input: { fail: true } }, reg, makeCtx(pid) as never);
    expect(badPart.type === "tool" && badPart.state).toBe("error");
    expect(badPart.type === "tool" && badPart.halt).toBeFalsy();
  });
});
