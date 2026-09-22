/**
 * 离线测试（不打 LLM）：markdown 区块手术 / Layer 骨架 / 播种 / 跨文档搜索 / 常驻设定注入。
 * 运行：bun test
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, listDesigns, loadProjectMeta, readDesign, removeDesign, writeDesign } from "../src/storage/project";
import { appendBlock, getSection, listHeadings, removeSection, replaceSection } from "../src/framework/markdown";
import { RESIDENT_LAYERS } from "../src/framework/layers";
import { renderDesignSpec } from "../src/framework/design_spec";
import { renderHits, searchDesigns } from "../src/framework/search";
import { buildResidentDesigns, buildDesignIndex } from "../src/framework/anchor";
import { removeCharacterTool } from "../src/tool/character_tools";
import {
  appendDesignTool,
  applyDesignTool,
  proposeDesignTool,
  removeDesignSectionTool,
} from "../src/tool/design_tools";
import { defineTool } from "../src/tool/define";
import { designSpecTool } from "../src/tool/framework_tools";
import { enterPlanTool, exitPlanTool, proposePlanTool, taskTool } from "../src/tool/core_tools";
import { MODES } from "../src/agent/modes";
import {
  BASE_PERMISSIONS,
  deriveSubagentPermission,
  evaluate,
  evaluateWithSource,
  match,
  merge,
  mergeConfigs,
  visibleTools,
  fromConfig,
  type PermissionConfig,
  type Rule,
  type Ruleset,
} from "../src/permission";
import { BUILTIN_TOOLS } from "../src/tool";
import { AgentRegistry } from "../src/agent/registry";
import { PLAN_KEY } from "../src/core/types";
import { renderPendingNote, Session } from "../src/session/session";
import type { ModelConfig } from "../src/core/types";
import { ToolRegistry } from "../src/tool/registry";
import { executeToolPart } from "../src/tool/runner";
import type { ConfirmReply, PendingProposal, ToolContext } from "../src/core/types";

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
    expect(RESIDENT_LAYERS).toEqual(["core", "world"]);
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
    // 人物层没有规范小节（一角色一卡），形状在 guide 里；必有格枚举由 CHARACTER_FIELDS 派生
    const chars = renderDesignSpec("characters");
    expect(chars).toContain("### 基本档案");
    expect(chars).toContain("### 说话方式");
    expect(chars).toContain("自由长尾");
    expect(chars).toContain("propose-design");
    expect(chars).not.toContain("add-character"); // 角色专用写工具已删
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

  test("情节层 = 卷纲 + 序列纲两种文档；「整本大纲」连同它的五格一起没了", () => {
    const outline = renderDesignSpec("outline");
    // 一次调用取全这一层的两个尺度
    expect(outline).toContain("## 本卷在全局的位置");
    expect(outline).toContain("## 卷末状态");
    expect(outline).toContain("## 本卷的序列");
    expect(outline).toContain("name: outline/vol_<N>.md");
    expect(outline).toContain("name: outline/vol_<N>/s<序号>.md");
    expect(outline).toContain("整篇散文，不分小节"); // 序列纲不分格
    // 旧「整本大纲」的五格随文档一起删掉——它们各自有更好的家（core / 卷纲 / 状态层）
    expect(outline).not.toContain("## 一句话主线");
    expect(outline).not.toContain("## 伏笔与回收登记");
    // 情节层的主文档不是一个文件，所以不给 layer 写入口（给了会写到目录名上）
    expect(outline).not.toContain("layer: outline");
  });

  test("design-spec 的 name 入口：登记过的给规范，没登记的明说自由成稿", async () => {
    expect((await designSpecTool.execute({ name: "outline/vol_1.md" })).output).toContain("## 本卷的序列");
    expect((await designSpecTool.execute({ name: "outline/vol_1/s2.md" })).output).toContain("整篇散文，不分小节");
    expect((await designSpecTool.execute({ name: "wiki/岛屿地图.md" })).output).toContain("没有单独登记结构规范");
    expect((await designSpecTool.execute({ layer: "nope" })).output).toContain("layer 应为");
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
/**
 * 侧录 + 真求值的测试 ctx。
 *
 * `check`/`ask` **不是桩**——它们跑真正的 `evaluate`，所以"这个模式下工具该不该被挡住"这类断言
 * 测的是产品逻辑，不是测试自己编的答案。`rulesets` 缺省 `[BASE_PERMISSIONS]`（= 没有模式）。
 */
function makeCtx(
  projectId: string,
  ...rulesets: Ruleset[]
): ToolContext & {
  pending: Map<string, PendingProposal>;
  shown: string[];
  modeLog: (string | undefined)[];
  approved: Rule[];
  /** 下一次 `ask` 弹窗时用户怎么答 */
  setConfirmReply(reply: ConfirmReply): void;
} {
  const pending = new Map<string, PendingProposal>();
  const shown: string[] = [];
  const modeLog: (string | undefined)[] = [];
  const approved: Rule[] = [];
  const rules = rulesets.length ? rulesets : [fromConfig(BASE_PERMISSIONS)];
  let confirmReply: ConfirmReply = "once";
  return {
    projectId,
    sessionId: "test-session",
    agent: "mate",
    signal: new AbortController().signal,
    confirm: async () => confirmReply,
    check: (permission, pattern) => evaluate(permission, pattern, ...rules, approved).action,
    ask: async (req) => {
      const rule = evaluate(req.permission, req.pattern, ...rules, approved);
      if (rule.action === "deny") return "deny";
      if (rule.action === "allow") return "allow";
      if (confirmReply === "no") return "reject";
      if (confirmReply === "always" && req.always) {
        approved.push({ permission: req.permission, pattern: req.always, action: "allow" });
      }
      return "allow";
    },
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
    setMode: (m) => {
      modeLog.push(m);
    },
    pending,
    shown,
    modeLog,
    approved,
    setConfirmReply: (reply) => {
      confirmReply = reply;
    },
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

describe("角色卡（必有五格 + 自由长尾；唯一写入口是 propose-design）", () => {
  const CARD = (name: string) => `characters/${name}.md`;

  /**
   * 一张合规的卡：必有五格齐全。卡不再由任何构造器生成——`add-character` 已删除，
   * 建卡与改卡都走 propose-design。所以测试自己拼卡文本，就像模型会做的那样。
   * `hollow` 把四个段落格写成（待定）——用来验"骨架只盯标题在不在"。
   */
  const cardText = (name: string, identity: string, opts: { extra?: string[]; hollow?: boolean } = {}) => {
    const f = (s: string) => (opts.hollow ? "（待定）" : s);
    return [
      `# 角色：${name}`,
      "",
      "### 基本档案",
      "",
      `姓名：${name}`,
      "性别：（待定）",
      `身份 · 所属：${identity}`,
      "",
      "### 性格与矛盾",
      "",
      f("既认命又不认。"),
      "",
      "### 想要 · 最怕",
      "",
      f("想要一个说法。"),
      "",
      "### 底线 · 绝不做",
      "",
      f("不动女人和孩子。"),
      "",
      "### 说话方式",
      "",
      f("短句、直给。"),
      "",
      ...(opts.extra ?? []),
    ].join("\n");
  };

  /** 走完整两段式：propose（不写盘）→ 标记用户同意 → apply。被拒时不落盘。 */
  async function land(name: string, content: string) {
    const ctx = makeCtx(pid);
    const proposed = await proposeDesignTool.execute({ name: CARD(name), content }, ctx as never);
    if (ctx.pending.has(CARD(name))) {
      ctx.pending.get(CARD(name))!.approved = true;
      await applyDesignTool.execute({ name: CARD(name) }, ctx as never);
    }
    return { proposed, ctx };
  }

  test("建卡：两段式提案落盘——角色没有专用工具，创建就是 propose-design 带 name", async () => {
    const { proposed } = await land("林晚", cardText("林晚", "空乘，与江屿困在同一座岛"));
    expect(proposed.output).toContain("尚未写入");

    const content = (await readDesign(pid, CARD("林晚")))!;
    expect(content).toContain("# 角色：林晚");
    for (const label of ["基本档案", "性格与矛盾", "想要 · 最怕", "底线 · 绝不做", "说话方式"]) {
      expect(content).toContain(`### ${label}`);
    }
    // 名单现算（读卡），不存派生文件；身份取「身份 · 所属」那一行
    expect(await buildDesignIndex(pid)).toContain("- 林晚 · 空乘，与江屿困在同一座岛（必有齐）");
  });

  test("缺任一必有格 → 整篇提案被拒并列出缺哪几格（不再有构造器替模型补格）", async () => {
    const thin = "# 角色：某人\n\n### 基本档案\n\n身份 · 所属：某人\n";
    const { proposed, ctx } = await land("某人", thin);
    expect(proposed.output).toContain("缺这几格");
    expect(proposed.output).toContain("性格与矛盾");
    expect(proposed.output).toContain("说话方式");
    expect(ctx.pending.size).toBe(0); // 没登记任何提案
    expect(await readDesign(pid, CARD("某人"))).toBeUndefined(); // 更没落盘
  });

  test("骨架只盯标题在不在：空标题能过校验，但名单里显示为待补", async () => {
    await land("空壳", cardText("空壳", "某人的身份", { hollow: true }));
    const roster = await buildDesignIndex(pid);
    expect(roster).toContain("- 空壳 · 某人的身份（待补：性格与矛盾、想要 · 最怕、底线 · 绝不做、说话方式）");
  });

  test("名单行取「身份 · 所属」而不是首行（首行是姓名）", async () => {
    await land("陆青", cardText("陆青", "七个吊唁者共同的旧友"));
    const roster = await buildDesignIndex(pid);
    expect(roster).toContain("- 陆青 · 七个吊唁者共同的旧友（");
    expect(roster).not.toContain("姓名：陆青");
  });

  test("基本档案整格全待定也算缺（旧写法会误判成「填了」）；部分填了则保留未定的那几行", async () => {
    const allPending = cardText("无名", "占位", { hollow: true }).replace(
      "姓名：无名\n性别：（待定）\n身份 · 所属：占位",
      "姓名：（待定）\n性别：（待定）\n身份 · 所属：（待定）",
    );
    await land("无名", allPending);
    expect(await buildDesignIndex(pid)).toContain("- 无名 · （待定）（待补：基本档案、");

    const partial = cardText("半填", "占位").replace(
      "姓名：半填\n性别：（待定）\n身份 · 所属：占位",
      "姓名：半填\n性别：男\n身份 · 所属：（待定）",
    );
    await land("半填", partial);
    const card = (await readDesign(pid, CARD("半填")))!;
    expect(card).toContain("姓名：半填");
    expect(card).toContain("身份 · 所属：（待定）"); // 未定的那一项留在卡上
  });

  test("整篇提案打到已存在的卡上 → 带「整篇重写」告警（add-character 查重的替代）", async () => {
    const ctx = makeCtx(pid);
    const r = await proposeDesignTool.execute(
      { name: CARD("林晚"), content: cardText("林晚", "换了个身份") },
      ctx as never,
    );
    expect(r.output).toContain("已存在");
    expect(r.output).toContain("整篇重写");
    // 旧卡的小节标题被列出来——用户看得出哪些会消失
    expect(r.output).toContain("5 个小节：基本档案、性格与矛盾、想要 · 最怕、底线 · 绝不做、说话方式");
  });

  test("section 级提案：只换那一格，其余字节不动", async () => {
    const ctx = makeCtx(pid);
    await proposeDesignTool.execute(
      { name: CARD("林晚"), section: "说话方式", content: "新版：越在乎越呛，反话里藏担心" },
      ctx as never,
    );
    ctx.pending.get(CARD("林晚"))!.approved = true;
    const r = await applyDesignTool.execute({ name: CARD("林晚") }, ctx as never);
    expect(r.output).toContain("已按提案改写");

    const content = (await readDesign(pid, CARD("林晚")))!;
    expect(content).toContain("新版：越在乎越呛");
    expect(content).toContain("空乘，与江屿困在同一座岛"); // 别的格没被碰
  });

  test("section 级提案改不了不存在的格——缺必有格的卡只能靠整篇提案补齐", async () => {
    const ctx = makeCtx(pid);
    const r = await proposeDesignTool.execute(
      { name: CARD("林晚"), section: "回响", content: "破万法。" },
      ctx as never,
    );
    expect(r.output).toContain("回响");
    expect(ctx.pending.size).toBe(0); // 没登记提案
  });

  // ── 回归：自由长尾与老卡的废止小节，任何写入之后都必须一字不丢 ──

  test("[回归] 自由长尾小节、老卡的废止小节在 section 级提案后一字不丢", async () => {
    await writeDesign(
      pid,
      CARD("乔家劲"),
      [
        "# 角色：乔家劲",
        "",
        "### 基本档案",
        "钵兰街阿劲，自诩四二六红棍",
        "",
        "### 回响",
        "「破万法」：契机「想要公平地进行对决」。",
        "",
        "### 习惯动作",
        "紧张时数东西够不够用",
        "",
        "### 当前",
        "已故",
        "",
        "### 一句话定位",
        "空姐，与江屿困同一座岛",
        "",
      ].join("\n"),
    );
    const ctx = makeCtx(pid);
    await proposeDesignTool.execute(
      {
        name: CARD("乔家劲"),
        section: "回响",
        content: "「破万法」：契机「想要公平地进行对决」。\n触发条件由性格导出。",
      },
      ctx as never,
    );
    ctx.pending.get(CARD("乔家劲"))!.approved = true;
    await applyDesignTool.execute({ name: CARD("乔家劲") }, ctx as never);

    const after = (await readDesign(pid, CARD("乔家劲")))!;
    expect(after).toContain("触发条件由性格导出。");
    // 其余小节连同正文原样保留——「习惯动作」「当前」「一句话定位」都是已废止的格，
    // 现在算自由长尾，同样一字不动
    for (const line of [
      "钵兰街阿劲，自诩四二六红棍",
      "紧张时数东西够不够用",
      "### 当前",
      "已故",
      "### 一句话定位",
      "空姐，与江屿困同一座岛",
    ]) {
      expect(after).toContain(line);
    }
    expect((after.match(/^### /gm) ?? []).length).toBe(5); // 没有多出/重复的小节
  });

  test("名单的「另有」列出自由长尾小节（每张卡都不同，所以它是信号不是噪音）", async () => {
    const roster = await buildDesignIndex(pid);
    expect(roster).toContain("- 乔家劲 · 钵兰街阿劲，自诩四二六红棍（待补：");
    expect(roster).toContain("另有：回响、习惯动作、当前、一句话定位");
  });

  test("缺格的卡：整篇提案补齐必有五格，自由长尾原样留在卡上", async () => {
    const before = (await readDesign(pid, CARD("乔家劲")))!;
    const filled = before.replace(
      "### 回响",
      "### 性格与矛盾\n\n既认命又不认。\n\n### 想要 · 最怕\n\n想要一个说法；最怕欠人。\n\n### 底线 · 绝不做\n\n不动女人和孩子。\n\n### 说话方式\n\n短句、直给，不绕弯\n\n### 回响",
    );
    await land("乔家劲", filled);

    const after = (await readDesign(pid, CARD("乔家劲")))!;
    expect(after).toContain("既认命又不认。");
    expect(after).toContain("紧张时数东西够不够用"); // 长尾还在
    expect(await buildDesignIndex(pid)).toContain(
      "- 乔家劲 · 钵兰街阿劲，自诩四二六红棍（必有齐；另有：回响、习惯动作、当前、一句话定位）",
    );
  });

  test("守卫：remove-design-section 拒删必有格，自由长尾随便删", async () => {
    const ctx = makeCtx(pid);
    const bad = await removeDesignSectionTool.execute(
      { name: CARD("乔家劲"), section: "底线 · 绝不做" },
      ctx as never,
    );
    expect(bad.output).toContain("必有格");
    expect((await readDesign(pid, CARD("乔家劲")))!).toContain("### 底线 · 绝不做");

    const ok = await removeDesignSectionTool.execute(
      { name: CARD("乔家劲"), section: "一句话定位" },
      ctx as never,
    );
    expect(ok.output).toContain("已删除");
    expect((await readDesign(pid, CARD("乔家劲")))!).not.toContain("一句话定位");
  });

  test("名单：只有老「一句话定位」的卡也能出身份，不立刻退化成（待定）", async () => {
    await writeDesign(pid, CARD("老卡"), "# 角色：老卡\n\n### 一句话定位\n从前的一句定位\n");
    expect(await buildDesignIndex(pid)).toContain("- 老卡 · 从前的一句定位");
  });

  test("[回归] 走 propose-design 落的卡进名单（旧的派生总表在这条路上会漏）", async () => {
    await land("沈越", cardText("沈越", "婚礼／殡仪主持"));
    const roster = await buildDesignIndex(pid);
    expect(roster).toContain("- 沈越 · 婚礼／殡仪主持（必有齐）"); // 名单现算 → 不会漏
    expect(roster).not.toContain("characters/沈越.md:"); // 角色卡不铺必有格标题，只有一行
  });

  test("remove-character：删卡；名单随之消失（现算，不用额外同步）", async () => {
    const r = await removeCharacterTool.execute({ name: "林晚" }, makeCtx(pid) as never);
    expect(r.output).toContain("已删除");
    expect(await readDesign(pid, CARD("林晚"))).toBeUndefined();
    expect(await buildDesignIndex(pid)).not.toContain("林晚");
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

  test("守卫：无规范登记的散文放行（兜底成整篇一格），有规范登记的散文仍被拒", async () => {
    const ctx = makeCtx(pid);
    // wiki 专题页 / 序列纲这类：整篇散文是正当形状，摆成"整篇一格"用户照样看得到字节
    const flat = await proposeDesignTool.execute({ name: "wiki/x.md", content: "整段散文，一个标题都没有。" }, ctx as never);
    expect(flat.output).toContain("提案已交给用户审阅");

    // 有规范登记的层：同样的散文会被渲染成"四格全（待定）"，正文却照样落盘——这才是要拒的
    const layered = await proposeDesignTool.execute({ layer: "core", content: "整段散文，一个标题都没有。" }, ctx as never);
    expect(layered.output).toContain("没法逐格审阅");

    await writeDesign(pid, DOC2, "# X\n\n## 第一节\n（待定）\n");
    const headed = await proposeDesignTool.execute({ name: DOC2, content: "## 第一节\n正文", section: "第一节" }, ctx as never);
    expect(headed.output).toContain("不要带标题行");
  });

  test("守卫：角色卡上出现 ## 被拒（否则卡里所有 ### 会从逐格审阅里消失）", async () => {
    const ctx = makeCtx(pid);
    const proposed = await proposeDesignTool.execute(
      { name: "characters/某人.md", content: "# 角色：某人\n\n## 基本档案\n来历不明。\n" },
      ctx as never,
    );
    expect(proposed.output).toContain("一律用 `###`");
    expect(ctx.pending.size).toBe(0); // 没登记任何提案

    const appended = await appendDesignTool.execute(
      { name: "characters/某人.md", block: "## 回响\n破万法。" },
      ctx as never,
    );
    expect(appended.output).toContain("一律用 `###`");

    // 反过来：`###` 的自由小节（开放长尾）畅通
    await writeDesign(pid, "characters/某人.md", "# 角色：某人\n\n### 基本档案\n来历不明。\n");
    const ok = await appendDesignTool.execute(
      { name: "characters/某人.md", block: "### 回响\n破万法：契机「想要公平地进行对决」。" },
      ctx as never,
    );
    expect(ok.output).toContain("已追加到");
    expect((await readDesign(pid, "characters/某人.md"))!).toContain("### 回响");
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
    expect(a.output).toContain('name:"characters/<名>.md"');

    const b = await proposeDesignTool.execute(
      { layer: "world", name: "wiki/x.md", content: "# x\n\n## a\nb\n" },
      ctx as never,
    );
    expect(b.output).toContain("只能给一个");
  });

  test("守卫：outline 也不再是可写的 layer——一卷一个文件，改走 name", async () => {
    const ctx = makeCtx(pid);
    const r = await proposeDesignTool.execute({ layer: "outline", content: "## 随便\n内容" }, ctx as never);
    // 放行的话 DESIGN_SPECS["outline"].file 是目录 "outline/"，会往目录名上写盘
    expect(r.output).toContain("layer 只收 core / world");
    expect(r.output).toContain('name:"outline/vol_<N>.md"'); // 自愈文案把正确路径给回去
    expect(ctx.pending.size).toBe(0); // 没登记任何提案
  });
});

// ─── runner：halt 只在成功时置位 ───

// ─── propose-plan：写正文前的那道门 ───

describe("propose-plan · 写正文前的门", () => {
  const BEATS = "上岛第一晚。\n\n入夜前先把七个人点一遍，谁跟谁不熟要露出来。\n\n钩子：退路断在谁也没看见的时候。";

  test("摆出节拍、halt、且不写任何文件", async () => {
    const ctx = makeCtx(pid);
    const before = await listDesigns(pid);

    const r = await proposePlanTool.execute({ chapter: "第 1 章", content: BEATS }, ctx as never);

    expect(proposePlanTool.halt).toBe(true); // 门靠它：摆出来就停，不靠模型自觉
    expect(r.output).toContain("节拍已摆给用户");
    expect(ctx.shown[0]).toContain("──── 第 1 章 · 节拍 ────");
    expect(ctx.shown[0]).toContain("上岛第一晚。");
    expect(ctx.shown[0]).toContain("钩子：退路断在谁也没看见的时候。");
    expect(ctx.shown[0]).toContain("回复「没问题」就按这个写正文");
    // 节拍不落盘——批准的是动作，不是文档
    expect(await listDesigns(pid)).toEqual(before);
    // 但要在**内存里**登记成"待执行的节拍"：用户回话后由 harness 置 approved，task(writer) 才放行
    expect(ctx.pending.get(PLAN_KEY)?.content).toContain("上岛第一晚。");
    expect(ctx.pending.get(PLAN_KEY)?.approved).toBe(false);
  });

  test("chapter 缺省时抬头不带标签", async () => {
    const ctx = makeCtx(pid);
    await proposePlanTool.execute({ content: BEATS }, ctx as never);
    expect(ctx.shown[0]).toContain("──── 节拍 ────");
  });

  test("content 为空 → 抛错而不是 return（return 会被 runner 置 halt，把回合停在可自愈的错误上）", async () => {
    const ctx = makeCtx(pid);
    await expect(proposePlanTool.execute({ content: "   " }, ctx as never)).rejects.toThrow("缺少 content");
    expect(ctx.shown.length).toBe(0); // 什么都没摆
  });

  test("task(writer) 的硬门：没有拍板过的节拍就不放行，且文案能自愈", async () => {
    const ctx = makeCtx(pid);
    const blocked = await taskTool.execute({ agent: "writer", prompt: "写第 1 章" }, ctx as never);
    expect(blocked.output).toContain("没有一份用户已拍板的节拍");
    expect(blocked.output).toContain("propose-plan"); // 自愈：告诉它下一步调什么
  });

  test("摆过但用户还没回话 → 仍然不放行（approved 由 harness 置，模型自述无效）", async () => {
    const ctx = makeCtx(pid);
    await proposePlanTool.execute({ chapter: "第 1 章", content: BEATS }, ctx as never);
    const blocked = await taskTool.execute({ agent: "writer", prompt: "写第 1 章" }, ctx as never);
    expect(blocked.output).toContain("没有一份用户已拍板的节拍");
  });

  test("用户回话同意 → 放行；且一次批准只换一次写作（用掉即清）", async () => {
    const ctx = makeCtx(pid);
    await proposePlanTool.execute({ chapter: "第 1 章", content: BEATS }, ctx as never);
    ctx.pending.get(PLAN_KEY)!.approved = true; // 等价于用户回了一句"没问题"（Session 侧的动作）

    const ok = await taskTool.execute({ agent: "writer", prompt: "写第 1 章" }, ctx as never);
    expect(ok.output).toContain('<task agent="writer" state="completed">');
    expect(ctx.pending.has(PLAN_KEY)).toBe(false); // 写完了，批准也一并作废

    const again = await taskTool.execute({ agent: "writer", prompt: "再写一遍" }, ctx as never);
    expect(again.output).toContain("没有一份用户已拍板的节拍"); // 下一章要重新摆、重新拍板
  });

  test("待办注记能说清是哪一章的节拍（压缩之后靠它，不靠消息历史）", async () => {
    const ctx = makeCtx(pid);
    await proposePlanTool.execute({ chapter: "第 1 章", content: BEATS }, ctx as never);
    const note = renderPendingNote(ctx.pending)!;
    expect(note).toContain("第 1 章的节拍");
    expect(note).toContain("用户还没同意");

    ctx.pending.get(PLAN_KEY)!.approved = true;
    expect(renderPendingNote(ctx.pending)!).toContain("可以带它 task(writer)");
  });
});

// ─── 会话模式 ───

describe("会话模式 · plan", () => {
  test("enter-plan / exit-plan 进出模式", async () => {
    const ctx = makeCtx(pid);
    await enterPlanTool.execute({}, ctx as never);
    expect(ctx.modeLog).toEqual(["plan"]);
    await exitPlanTool.execute({}, ctx as never);
    expect(ctx.modeLog).toEqual(["plan", undefined]);
  });

  test("propose-plan 成功后自动退出模式——正常路径用不着 exit-plan", async () => {
    const ctx = makeCtx(pid);
    await enterPlanTool.execute({}, ctx as never);
    await proposePlanTool.execute({ chapter: "第 1 章", content: "上岛第一晚。" }, ctx as never);
    expect(ctx.modeLog).toEqual(["plan", undefined]);
  });

  /** 某个规则集下，**整个注册表**里还剩哪些工具可见。 */
  const visibleUnder = (...configs: PermissionConfig[]): string[] =>
    visibleTools([...BUILTIN_TOOLS], mergeConfigs(...configs)).map((t) => t.id);

  test("计划模式挡住一切会写文件的工具——**按类别挡，不是按名单**", () => {
    // 断言的是"没有任何 edit/delegate 工具漏网"。将来加了新的写作工具、只要它声明了
    // permission: "edit"，就自动被挡——不需要谁记得去改一份名单。
    const available = visibleUnder(BASE_PERMISSIONS, MODES.plan.permission);
    const leaked = BUILTIN_TOOLS.filter(
      (t) => (t.permission === "edit" || t.permission === "delegate") && available.includes(t.id),
    ).map((t) => t.id);
    expect(leaked).toEqual([]);
    // 而且确实拦到了东西（否则上面那条空断言恒真）
    expect(available.length).toBeLessThan(BUILTIN_TOOLS.length);
  });

  test("但只读工具与两个出口都还在（模式不是把人关死）", () => {
    const available = visibleUnder(BASE_PERMISSIONS, MODES.plan.permission);
    const missing = ["read-design", "list-designs", "design-spec", "propose-plan", "exit-plan", "ask-user"].filter(
      (t) => !available.includes(t),
    );
    expect(missing).toEqual([]);
  });

  test("模式纪律必须与领域无关——绑死成「章节计划模式」就换不了场景", () => {
    const d = MODES.plan.note.toLowerCase();
    const bound = ["节拍", "beat", "chapter", "sequence", "outline"].filter((w) => d.includes(w));
    expect(bound).toEqual([]);
  });
});

// ─── 权限 ───

describe("权限 · 求值", () => {
  const R = fromConfig;

  test("一条都没匹配 → ask（默认问，不是默认放行）", () => {
    expect(evaluate("edit", "whatever", []).action).toBe("ask");
    expect(evaluate("edit", "whatever", R({ delegate: "allow" })).action).toBe("ask");
  });

  test("顺序即优先级：后写的赢", () => {
    expect(evaluate("edit", "a.md", R({ edit: "ask" }), R({ edit: "allow" })).action).toBe("allow");
    expect(evaluate("edit", "a.md", R({ edit: "allow" }), R({ edit: "ask" })).action).toBe("ask");
  });

  test("deny 单调——不受顺序影响（我们和 opencode 的唯一分歧）", () => {
    expect(evaluate("edit", "a.md", R({ edit: "deny" }), R({ edit: "allow" })).action).toBe("deny");
    expect(evaluate("edit", "a.md", R({ edit: "allow" }), R({ edit: "deny" })).action).toBe("deny");
  });

  test("pattern 是通配的，`*` 跨 `/`", () => {
    expect(match("design/wiki/world.md", "design/*")).toBe(true);
    expect(match("chapters/ch1.md", "design/*")).toBe(false);
    expect(match("design/core.md", "design/core.md")).toBe(true);
  });

  test("`deny *` 隐藏工具；具体 pattern 的 deny 不隐藏（那是「这一类里有一个例外」）", () => {
    const tools = [
      { id: "edit-tool", permission: "edit" as const },
      { id: "read-tool" },
    ];
    expect(visibleTools(tools, R({ edit: "deny" })).map((t) => t.id)).toEqual(["read-tool"]);

    const oneException = R({ edit: { "*": "allow", "design/secret.md": "deny" } });
    expect(visibleTools(tools, oneException).map((t) => t.id)).toEqual(["edit-tool", "read-tool"]);
    expect(evaluate("edit", "design/secret.md", oneException).action).toBe("deny");
    expect(evaluate("edit", "design/other.md", oneException).action).toBe("allow");
  });

  test("四层拼装：内置默认 → agent → 模式 → 用户配置（顺序即优先级）", () => {
    // 模式的 allow 压过内置默认的 ask；用户配置的 allow 又压过模式的 ask
    expect(evaluate("edit", "*", mergeConfigs(BASE_PERMISSIONS, {}, { edit: "allow" }, {})).action).toBe("allow");
    expect(evaluate("extern", "*", mergeConfigs(BASE_PERMISSIONS, {}, {}, { extern: "allow" })).action).toBe("allow");
    // 但 deny 单调：模式的 deny 压得过用户配置的 allow（"不许"不该被别处的"允许"盖掉）
    expect(evaluate("edit", "*", mergeConfigs(BASE_PERMISSIONS, {}, { edit: "deny" }, { edit: "allow" })).action).toBe(
      "deny",
    );
    // agent 声明也在这条链上：writer 的 question: deny 压过内置默认的 allow
    expect(evaluate("question", "*", mergeConfigs(BASE_PERMISSIONS, { question: "deny" }, {}, {})).action).toBe("deny");
  });

  test("子代理：父的 deny 继承，父的 allow 不继承", () => {
    const parent = mergeConfigs(BASE_PERMISSIONS, { edit: "allow" }, { extern: "deny" });
    const derived = deriveSubagentPermission(parent, { permission: { question: "deny" } });

    expect(evaluate("extern", "*", derived).action).toBe("deny"); // 父的 deny → 继承
    expect(evaluate("edit", "*", derived).action).toBe("ask"); // 父的 allow → **不**继承，回落默认
    expect(evaluate("question", "*", derived).action).toBe("deny"); // 子自己的规则
    expect(evaluate("delegate", "*", derived).action).toBe("deny"); // 没声明 → 禁委派
  });
});

describe("权限 · 说清「这条是谁定的」", () => {
  // 四层：内置默认 → agent → 模式 → 用户配置
  const layers = [
    fromConfig(BASE_PERMISSIONS),
    fromConfig({}),
    fromConfig({ edit: "deny", delegate: "deny" }),
    fromConfig({ extern: "allow" }),
  ];

  test("命中的规则报出它所在的层号；一层都没有 → -1（走了默认 ask）", () => {
    expect(evaluateWithSource("edit", "*", ...layers).layer).toBe(2);
    expect(evaluateWithSource("extern", "*", ...layers).layer).toBe(3);
    expect(evaluateWithSource("question", "*", ...layers).layer).toBe(0);
    expect(evaluateWithSource("edit", "*", fromConfig({})).layer).toBe(-1);
  });

  test("[回归] deny 来自**前面**的层时，报的是那个前面的层，不是最后匹配的那个", () => {
    // 顺序即优先级的写法会报第 3 层（用户配置的 allow），但实际生效的是第 2 层的 deny——
    // 显示"是用户配置放行的"就完全说反了（deny 单调，见 evaluate 第 1 步）
    const { rule, layer } = evaluateWithSource("edit", "*", ...layers);
    expect(rule.action).toBe("deny");
    expect(layer).toBe(2);
  });
});

describe("权限 · 规则表视图（CLI 的 /permissions）", () => {
  const model: ModelConfig = { provider: "mock", model: "test", maxTokens: 1, reasoning: "off" };

  /** 一个真实 Session（不是假 ctx）——视图读的是会话自己的状态，得照着真东西测。 */
  async function sessionWith(permissions?: PermissionConfig): Promise<Session> {
    const meta = await loadProjectMeta(pid);
    const agents = new AgentRegistry();
    agents.applyProject(meta);
    const tools = new ToolRegistry();
    for (const t of BUILTIN_TOOLS) tools.register(t);
    return new Session({ projectId: pid, meta: { ...meta, permissions }, agents, tools, model });
  }

  test("四层永远都在、顺序不变——用户配了也看得见自己在最后一层", async () => {
    const view = (await sessionWith({ edit: "deny" })).permissionView();
    expect(view.derived).toBe(false);
    // 层名对不上很要紧：视图是用户判断"我的配置生效没有"的唯一入口
    expect(view.layers.map((l) => l.label)).toEqual([
      "内置默认",
      "agent 搭档",
      "模式",
      "项目配置 talemate.json",
    ]);
    expect(view.layers[3].rules).toEqual([{ permission: "edit", pattern: "*", action: "deny" }]);
  });

  test("视图摊开的那几层，求值结果就是会话真正在执行的——显示和执行不会各说各话", async () => {
    const session = await sessionWith({ edit: { "*": "allow", "design/core.md": "ask" } });
    const view = session.permissionView();
    const sets = [...view.layers.map((l) => l.rules), view.approved];

    // 兜底那条 `*→allow` 生效
    expect(evaluateWithSource("edit", "chapters/ch1.md", ...sets).rule.action).toBe("allow");
    // 但被点名的那一个仍然要问，且来源是"项目配置"那一层
    const guarded = evaluateWithSource("edit", "design/core.md", ...sets);
    expect(guarded.rule.action).toBe("ask");
    expect(view.layers[guarded.layer].label).toBe("项目配置 talemate.json");
  });

  test("没进模式时模式层是空的，但位子留着——层号不因为空而错位", async () => {
    const view = (await sessionWith()).permissionView();
    expect(view.modeTitle).toBeUndefined();
    expect(view.layers[2].rules).toEqual([]);
    // 空层不参与求值，`question` 仍然由第一层（内置默认）的 allow 定
    expect(evaluateWithSource("question", "*", ...view.layers.map((l) => l.rules)).layer).toBe(0);
  });
});

describe("权限 · 会话级行为", () => {
  test("accept-edits：落盘不问，委派与联网照问", async () => {
    const ctx = makeCtx(pid, mergeConfigs(BASE_PERMISSIONS, MODES["accept-edits"].permission));
    expect(await ctx.ask({ permission: "edit", pattern: "design/core.md", summary: "" })).toBe("allow");
    expect(ctx.check("delegate", "writer")).toBe("ask");
    expect(ctx.check("extern", "https://x")).toBe("ask");
  });

  test("plan：edit 与 delegate 都是 deny（只读）", async () => {
    const ctx = makeCtx(pid, mergeConfigs(BASE_PERMISSIONS, MODES.plan.permission));
    expect(ctx.check("edit", "design/core.md")).toBe("deny");
    expect(await ctx.ask({ permission: "edit", pattern: "design/core.md", summary: "" })).toBe("deny");
    expect(ctx.check("extern", "https://x")).toBe("ask"); // 查资料仍然可以
  });

  test("reject 与 deny 是两回事：前者等人点头，后者得先离开模式", async () => {
    const ctx = makeCtx(pid);
    ctx.setConfirmReply("no");
    expect(await ctx.ask({ permission: "edit", pattern: "design/a.md", summary: "" })).toBe("reject");
  });

  test("always：答一次「以后都允许」，同类不再问", async () => {
    const ctx = makeCtx(pid);
    ctx.setConfirmReply("always");
    expect(await ctx.ask({ permission: "edit", pattern: "design/a.md", always: "design/*", summary: "" })).toBe("allow");
    expect(ctx.approved).toEqual([{ permission: "edit", pattern: "design/*", action: "allow" }]);

    // 同类**另一个文件** → 直接放行；把答复切成 no 来证明它真的没再弹窗
    ctx.setConfirmReply("no");
    expect(await ctx.ask({ permission: "edit", pattern: "design/b.md", summary: "" })).toBe("allow");
  });

  test("apply-design 走 confirm:false 也要过规则表——「不许」不因为问过一次就失效", async () => {
    const doc = "wiki/guarded.md";
    const before = "# X\n\n## 甲\n旧的一版。\n";
    await writeDesign(pid, doc, before);
    // 除这个文件外都放行——所以这条如果过了，一定是"被 deny 挡住"，不是"配置把一切关掉了"
    const ctx = makeCtx(pid, mergeConfigs(BASE_PERMISSIONS, { edit: { "*": "allow", [doc]: "deny" } }));
    // base 要对得上，否则先被并发保护拦下，测不到权限那一步
    ctx.setProposal({ name: doc, content: "# X\n\n## 甲\n新的一版。\n", base: before, approved: true, at: Date.now() });

    const r = await applyDesignTool.execute({ name: doc }, ctx as never);
    expect(r.output).toContain("不允许改文件");
    expect(await readDesign(pid, doc)).toContain("旧的一版。"); // 真的一个字没写进去
  });

  test("runner 兜底：被 `deny *` 盖住的工具，哪怕被幻觉调出来也拒", async () => {
    const reg = new ToolRegistry();
    reg.register(
      defineTool<Record<string, never>>({
        id: "t-edit",
        description: "",
        input: { type: "object" },
        permission: "edit",
        async execute() {
          return { output: "不该跑到这里" };
        },
      }),
    );
    const part = await executeToolPart(
      "mate",
      { id: "1", name: "t-edit", input: {} },
      reg,
      makeCtx(pid, mergeConfigs(BASE_PERMISSIONS, MODES.plan.permission)) as never,
    );
    expect(part.type === "tool" && part.state).toBe("error");
    expect(part.type === "tool" && part.error).toContain("不允许");
  });
});

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

    const okPart = await executeToolPart("mate", { id: "1", name: "t-halt", input: {} }, reg, makeCtx(pid) as never);
    expect(okPart.type === "tool" && okPart.halt).toBe(true);

    const badPart = await executeToolPart("mate", { id: "2", name: "t-halt", input: { fail: true } }, reg, makeCtx(pid) as never);
    expect(badPart.type === "tool" && badPart.state).toBe("error");
    expect(badPart.type === "tool" && badPart.halt).toBeFalsy();
  });
});
