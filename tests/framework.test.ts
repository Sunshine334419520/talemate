/**
 * 离线测试（不打 LLM）：markdown 区块手术 / 资产骨架 / 播种 / 目录索引 / 项目级根表 / 写盘路径。
 * 运行：bun test
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, loadProjectMeta, removeDoc, writeDoc } from "../src/storage/project";
import { enumerateDocs, readDoc, scanDocs } from "../src/storage/corpus";
import { getSection, listHeadings, removeSection, upsertSection } from "../src/framework/markdown";
import { docTree } from "../src/framework/anchor";
import { planAbs } from "../src/framework/plan";
import { renderHits } from "../src/framework/search";
import { buildIndex } from "../src/framework/anchor";
import { buildProjectStatus } from "../src/framework/report";
import { deleteTool, editTool, writeTool } from "../src/tool/file_tools";
import { defineTool } from "../src/tool/define";
import { globDocs, grepDocs } from "../src/framework/find";
import { globTool, grepTool } from "../src/tool/find_tools";
import { readTool } from "../src/tool/read_tools";
import { recallTool, rememberTool } from "../src/tool/research_tools";
import { listNoteNames, noteAbs, readNote } from "../src/storage/notes";
import { projectPaths, talemateHome } from "../src/core/config";
import { enterProseTool, exitProseTool, proposePlanTool, taskTool } from "../src/tool/core_tools";
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
import { renderPendingNote, renderPermissionView, Session, writeSettlesPlan } from "../src/session/session";
import { isChapterFile } from "../src/framework/plan";
import { DEFAULT_STYLE, SHELF_HEADING, STYLE_HEADING, buildProseBrief, styleCatalog, styleChoiceFrom, withShelf, withStyle } from "../src/framework/prose";
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

/**
 * 取一次「自愈拒绝」的文案。
 *
 * `propose-plan` 带 `halt`，所以它的自愈路径必须是 **throw 而不是 return**——
 * return 会被 runner 置 halt，把回合停在一个本可自愈的错误上（见 "tool runner · halt"）。
 * 因此断言它的拒绝时不能读 `.output`，只能接住异常。
 */
async function rejectMessage(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => {
      throw new Error("预期被拒，但调用成功了");
    },
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );
}

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

  // **没有 `replaceSection` 这条了**：改一格的正文现在走通用的 `edit`（锚点式替换），
  // 别的字节一个不碰。它的覆盖在「角色卡 › 改一格走 edit」那几条里。

  test("removeSection 删掉一格", () => {
    const next = removeSection(sample, "第二节");
    expect(next).not.toContain("## 第二节");
    expect(next).toContain("## 第一节");
  });

  test("upsertSection 命中就换掉那一格，别的格一个字节不动", () => {
    const core = ["# 核心设定", "", "## 题材 · 频道", "男频", "", "## 文风", "storytelling", ""].join("\n");
    const next = upsertSection(core, "文风", "网文爽感");
    expect(next).toContain("## 文风\n网文爽感");
    expect(next).not.toContain("storytelling");
    expect(next).toContain("## 题材 · 频道\n男频");
  });

  test("upsertSection 命不中就追加——格还不存在是**正常起点**，不是错误", () => {
    const core = "# 核心设定\n\n## 题材 · 频道\n男频\n";
    const next = upsertSection(core, "文风", "storytelling");
    expect(next).toContain("## 文风\nstorytelling");
    expect(next.indexOf("## 题材 · 频道")).toBeLessThan(next.indexOf("## 文风")); // 追加在末尾
    expect(next.startsWith("# 核心设定")).toBe(true);
  });

  test("upsertSection 空内容起手也能用（新建项目没有 core.md）", () => {
    expect(upsertSection("", "文风", "storytelling")).toBe("## 文风\nstorytelling");
  });

  test("upsertSection 的区块语义与 removeSection 一致：`##` 连带它自己的 `###`", () => {
    const next = upsertSection(sample, "第二节", "换掉了");
    expect(next).toContain("## 第二节\n换掉了");
    expect(next).not.toContain("### 子小节"); // 子格属于这一区块
    expect(next).toContain("## 第一节");
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

// ─── 三个读口（项目级：design / chapters / state 通吃） ───

describe("读口 · read / list / search", () => {
  // **自己的项目**：上面那些 describe 共用 `pid`，这里播下的文件会污染它们的"初始为空"断言。
  let rpid: string | undefined;
  const proj = async (): Promise<string> => (rpid ??= (await createProject({ title: "读口" })).id);
  const CH = "chapters/chapter_ch9_v1.md";

  test("read 读得到 chapters/——从前工具名把管辖范围焊死在 design/ 上", async () => {
    const id = await proj();
    await writeDoc(id, CH, "# 第九章\n\n沈越上了船。\n");
    await writeDoc(id, "design/core.md", "# 核心\n\n## 一句话简介\n沈越想活着回去。\n");
    const r = await readTool.execute({ path: CH }, makeCtx(id) as never);
    expect(r.output).toContain("沈越上了船。");
  });

  test("read 找不到时的清单按**路径所属那一段**给——章节找不到就列章节，不列企划", async () => {
    const id = await proj();
    const r = await readTool.execute({ path: "chapters/没有这一章.md" }, makeCtx(id) as never);
    expect(r.output).toContain("没有找到");
    expect(r.output).toContain("chapter_ch9_v1.md");
    expect(r.output).not.toContain("core.md");
  });

  test("glob：省略 path = 整个项目；给目录就只搜那一段", async () => {
    const id = await proj();
    await writeDoc(id, "design/core.md", "# 核心\n");
    await writeDoc(id, CH, "沈越在这里。\n");
    const all = (await globTool.execute({ pattern: "**/*.md" }, makeCtx(id) as never)).output;
    expect(all).toContain("design/");
    expect(all).toContain("chapters/");
    expect(all).toContain("chapter_ch9_v1.md");

    const onlyCh = (await globTool.execute({ pattern: "**/*.md", path: "chapters" }, makeCtx(id) as never)).output;
    expect(onlyCh).toContain("chapter_ch9_v1.md");
    expect(onlyCh).not.toContain("core.md");
  });

  test("grep：范围是参数。扫得到正文里的引用——删名前的引用检查靠这一条", async () => {
    const id = await proj();
    await writeDoc(id, "design/core.md", "# 核心\n\n沈越想要回去。\n");
    await writeDoc(id, CH, "沈越在这里。\n");
    const all = (await grepTool.execute({ pattern: "沈越" }, makeCtx(id) as never)).output;
    expect(all).toContain(CH);
    const scoped = (await grepTool.execute({ pattern: "沈越", path: "design" }, makeCtx(id) as never)).output;
    expect(scoped).not.toContain("chapters/");
  });
});

describe("索引 · 目录次序与未知目录", () => {
  test("未知目录不再被静默丢掉（从前 order 只列四个已知名，其余枚举到了也不显示）", async () => {
    const id = (await createProject({ title: "索引目录" })).id;
    await writeDoc(id, "design/wiki/地理/北境.md", "## 北境\n风大，年年有人冻死。\n");
    const idx = await buildIndex(id);
    expect(idx).toContain("地理/");
    expect(idx).toContain("北境.md");
  });

  test("列整个项目时三个根按作品次序排在前面，且流水只占一行", async () => {
    const id = (await createProject({ title: "索引根次序" })).id;
    await writeDoc(id, "design/core.md", "# 核心\n");
    await writeDoc(id, "chapters/chapter_ch1_v1.md", "第一章。\n");
    await writeDoc(id, "state/progress.md", "# 章节流水\n\n## 第 1 章\n他借到了粮。\n");

    const idx = await buildIndex(id, "");
    const order = ["design", "chapters", "state"].map((g) => idx.indexOf(`  ${g}/`));
    expect(order.every((i) => i >= 0)).toBe(true); // 三个根都列出来了
    expect([...order].sort((a, b) => a - b)).toEqual(order); // 次序是 design → chapters → state
    // 流水是只追加的，几十章之后整篇铺小节会把目录淹掉——所以它只给一行
    expect(idx).toContain("progress.md（1 条 · 最近：第 1 章）");
    expect(idx).not.toContain("- 第 1 章");
  });
});

// ─── 播种 + 搜索 + 锚点（走真实临时项目） ───

describe("状态卡 · 大纲现状只报位置，不报剩余", () => {
  test("写到哪儿了：读 `state/progress.md` 的最后一节，原样报出来", async () => {
    const id = (await createProject({ title: "状态卡" })).id;
    await writeDoc(id, "design/outline/vol_1.md", "# 第一卷\n\n## 本卷在全局的位置\n他刚穿来，一无所有。\n");
    await writeDoc(id, "design/outline/vol_1/s1.md", "序列一 · 落地\n");
    // 还没写过正文 → 那一行不长尾巴（不编"写到第 0 章"）
    expect(await buildProjectStatus(id)).toContain("✓ 第 1 卷 / 共 1 卷 · 1 个序列：他刚穿来，一无所有。");
    expect(await buildProjectStatus(id)).not.toContain("写到");

    await writeDoc(
      id,
      "state/progress.md",
      "# 章节流水\n\n## 第 1 章\n他睁眼，认下这一屋子的欠账。\n\n## 第 2 章\n东家来催账，他第一次开口讲价。\n",
    );
    const card = await buildProjectStatus(id);
    expect(card).toContain("写到第 2 章（东家来催账，他第一次开口讲价。）"); // 最后一节，不是第一节
    expect(card).not.toContain("第 1 章");
    // **没有"还剩/进度/百分比"这回事**：序列纲声明的是功能不是事件，章数与序列进度之间没有换算
    const leaked = ["还剩", "进度", "%", "完成"].filter((w) => card.includes(w));
    expect(leaked).toEqual([]);
  });
});

describe("项目懒建 / 搜索 / 锚点", () => {
  test("懒建：建项目不种四层；文件被写入才出现", async () => {
    expect(await enumerateDocs(pid, "design/")).toEqual([]);
    await writeDoc(pid, "design/core.md", "# core\n\n## 一句话简介\n空难后困于荒岛。");
    expect(await enumerateDocs(pid, "design/")).toEqual(["design/core.md"]);
  });

  test("scanDocs 跨文档命中；renderHits 分组，路径按**项目相对**给出", async () => {
    await writeDoc(pid, "design/core.md", "## 一句话简介\n沈越 想要活着回去。");
    await writeDoc(pid, "design/wiki/world.md", "## 势力\n沈越 与林晚结伴求生。");
    const hits = await scanDocs(pid, "沈越", "design/");
    expect(hits.length).toBe(2);
    const text = renderHits(hits, "沈越");
    // 报出来的路径**就是**工具收的那个口径——模型可以直接拿它去 read/edit
    expect(text).toContain("design/core.md");
    expect(text).toContain("design/wiki/world.md");
    expect(await scanDocs(pid, "不存在的词", "design/")).toHaveLength(0);
  });

  test("索引把 core 与 world 也当普通文档列出来（没有常驻层）", async () => {
    await writeDoc(pid, "design/core.md", "# core\n\n## 一句话简介\n沈越 想要活着回去。");
    await writeDoc(pid, "design/wiki/world.md", "## 空间与舞台\n一座荒岛。\n\n## 规则与秩序\n无超自然。");
    const index = await buildIndex(pid);
    expect(index).toContain("core.md");
    expect(index).toContain("world.md");
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
  /** 当前模式。`getMode` 与 `setMode` 共用它——正文模式进出与外层权限档叠在一起。 */
  let mode: string | undefined;
  return {
    projectId,
    sessionId: "test-session",
    agent: "mate",
    callId: "test-call",
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
    askUser: async () => ({ kind: "answered", answers: [] }),
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
      mode = m;
      modeLog.push(m);
    },
    exitProse: () => {
      if (mode === "prose") mode = undefined;
      modeLog.push(undefined);
    },
    getMode: () => mode,
    pending,
    shown,
    modeLog,
    approved,
    setConfirmReply: (reply) => {
      confirmReply = reply;
    },
    // 读口留着，写口一个都不留（改文件只能走 write/edit，见 core/types.ts）
    readDoc: (path) => readDoc(projectId, path),
    listIndex: (prefix) => buildIndex(projectId, prefix),
    globDocs: async (pattern, path) => (await globDocs(projectId, pattern, path)).text,
    grepDocs: async (query) => (await grepDocs(projectId, query)).text,
    searchDocs: async (q, prefix) => renderHits(await scanDocs(projectId, q, prefix), q),
    runSubagent: async () => ({ text: "（无）", sessionId: "sub-test" }),
    loadSkill: async () => undefined,
    webSettings: async () => ({}),
  };
}

describe("角色卡（常见格 + 自由长尾；建卡改卡走 write / edit）", () => {
  const CARD = (name: string) => `design/characters/${name}.md`;

  /**
   * 一张形状齐的卡：五格常在。卡不再由任何构造器生成——`add-character` 已删除，
   * 建卡与改卡都走 `write` / `edit`。所以测试自己拼卡文本，就像模型会做的那样。
   * `hollow` 把四个段落格写成（待定）——用来验"名单只盯格里有字没有"。
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

  /** 直接落一份卡（读侧用例的起点；写路径本身由 write_ops / invariants 的用例覆盖）。 */
  async function put(name: string, content: string) {
    await writeDoc(pid, CARD(name), content.trim());
    return makeCtx(pid);
  }

  test("建卡：write 整篇落盘——角色没有专用工具，创建就是写一份 design/characters/<名>.md", async () => {
    await put("林晚", cardText("林晚", "空乘，与江屿困在同一座岛"));

    const content = (await readDoc(pid, CARD("林晚")))!;
    expect(content).toContain("# 角色：林晚");
    for (const label of ["基本档案", "性格与矛盾", "想要 · 最怕", "底线 · 绝不做", "说话方式"]) {
      expect(content).toContain(`### ${label}`);
    }
    // 名单现算（读卡），不存派生文件；身份取「身份 · 所属」那一行
    expect(await buildIndex(pid)).toContain("- 林晚 · 空乘，与江屿困在同一座岛（常见格齐）");
  });

  test("名单只盯格里有字没有：空标题的常见格显示为待补，但卡照样落盘", async () => {
    await put("空壳", cardText("空壳", "某人的身份", { hollow: true }));
    const roster = await buildIndex(pid);
    expect(roster).toContain("- 空壳 · 某人的身份（待补：性格与矛盾、想要 · 最怕、底线 · 绝不做、说话方式）");
  });

  test("名单行取「身份 · 所属」而不是首行（首行是姓名）", async () => {
    await put("陆青", cardText("陆青", "七个吊唁者共同的旧友"));
    const roster = await buildIndex(pid);
    expect(roster).toContain("- 陆青 · 七个吊唁者共同的旧友（");
    expect(roster).not.toContain("姓名：陆青");
  });

  test("基本档案整格全待定也算缺（旧写法会误判成「填了」）；部分填了则保留未定的那几行", async () => {
    const allPending = cardText("无名", "占位", { hollow: true }).replace(
      "姓名：无名\n性别：（待定）\n身份 · 所属：占位",
      "姓名：（待定）\n性别：（待定）\n身份 · 所属：（待定）",
    );
    await put("无名", allPending);
    expect(await buildIndex(pid)).toContain("- 无名 · （待定）（待补：基本档案、");

    const partial = cardText("半填", "占位").replace(
      "姓名：半填\n性别：（待定）\n身份 · 所属：占位",
      "姓名：半填\n性别：男\n身份 · 所属：（待定）",
    );
    await put("半填", partial);
    const card = (await readDoc(pid, CARD("半填")))!;
    expect(card).toContain("姓名：半填");
    expect(card).toContain("身份 · 所属：（待定）"); // 未定的那一项留在卡上
  });

  // 改一格走 `edit`（锚点式）：用户看 diff 点头，其余字节原样（见 design-docs.md）。
  test("改一格走 edit：只换那一格，其余字节一字不动", async () => {
    const ctx = makeCtx(pid);
    const r = await editTool.execute(
      { path: CARD("林晚"), find: "短句、直给。", replace: "新版：越在乎越呛，反话里藏担心" },
      ctx as never,
    );
    expect(r.output).toContain("已改写");

    const content = (await readDoc(pid, CARD("林晚")))!;
    expect(content).toContain("新版：越在乎越呛");
    expect(content).toContain("空乘，与江屿困在同一座岛"); // 别的格没被碰
    expect(content).toContain("### 说话方式"); // 标题也没被吃掉
  });

  test("edit 改不了文件里没有的那段——拒绝文案要能自愈", async () => {
    const ctx = makeCtx(pid);
    const r = await editTool.execute(
      { path: CARD("林晚"), find: "卡上根本没有这一句。", replace: "x" },
      ctx as never,
    );
    expect(r.output).toContain("找不到");
    // 原样，一个字节没写
    expect(await readDoc(pid, CARD("林晚"))).toContain("空乘，与江屿困在同一座岛");
  });

  // ── 回归：自由长尾与老卡的废止小节，任何写入之后都必须一字不丢 ──

  test("[回归] 自由长尾小节、老卡的废止小节在改一格之后一字不丢", async () => {
    await writeDoc(
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
    // 只改「回响」那一格：锚点给的是它当前的正文，替换成加了第二句的一版
    const ctx = makeCtx(pid);
    const r = await editTool.execute(
      {
        path: CARD("乔家劲"),
        find: "「破万法」：契机「想要公平地进行对决」。",
        replace: "「破万法」：契机「想要公平地进行对决」。\n触发条件由性格导出。",
      },
      ctx as never,
    );
    expect(r.output).toContain("已改写");

    const after = (await readDoc(pid, CARD("乔家劲")))!;
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
    const roster = await buildIndex(pid);
    expect(roster).toContain("- 乔家劲 · 钵兰街阿劲，自诩四二六红棍（待补：");
    expect(roster).toContain("另有：回响、习惯动作、当前、一句话定位");
  });

  test("缺格的卡：整篇 write 补齐常见五格，自由长尾原样留在卡上", async () => {
    const before = (await readDoc(pid, CARD("乔家劲")))!;
    const filled = before.replace(
      "### 回响",
      "### 性格与矛盾\n\n既认命又不认。\n\n### 想要 · 最怕\n\n想要一个说法；最怕欠人。\n\n### 底线 · 绝不做\n\n不动女人和孩子。\n\n### 说话方式\n\n短句、直给，不绕弯\n\n### 回响",
    );
    await put("乔家劲", filled);

    const after = (await readDoc(pid, CARD("乔家劲")))!;
    expect(after).toContain("既认命又不认。");
    expect(after).toContain("紧张时数东西够不够用"); // 长尾还在
    expect(await buildIndex(pid)).toContain(
      "- 乔家劲 · 钵兰街阿劲，自诩四二六红棍（常见格齐；另有：回响、习惯动作、当前、一句话定位）",
    );
  });

  test("删一格走 edit：自由长尾随便删，名单跟着更新", async () => {
    const ctx = makeCtx(pid);
    const ok = await editTool.execute(
      { path: CARD("乔家劲"), find: "### 一句话定位\n空姐，与江屿困同一座岛", replace: "" },
      ctx as never,
    );
    expect(ok.output).toContain("已改写");
    expect((await readDoc(pid, CARD("乔家劲")))!).not.toContain("一句话定位");
  });

  test("名单：只有老「一句话定位」的卡也能出身份，不立刻退化成（待定）", async () => {
    await writeDoc(pid, CARD("老卡"), "# 角色：老卡\n\n### 一句话定位\n从前的一句定位\n");
    expect(await buildIndex(pid)).toContain("- 老卡 · 从前的一句定位");
  });

  test("[回归] 走 write 落的卡进名单（旧的派生总表在这条路上会漏）", async () => {
    await put("沈越", cardText("沈越", "婚礼／殡仪主持"));
    const roster = await buildIndex(pid);
    expect(roster).toContain("- 沈越 · 婚礼／殡仪主持（常见格齐）"); // 名单现算 → 不会漏
    expect(roster).not.toContain("characters/沈越.md:"); // 角色卡不铺常见格标题，只有一行
  });

  test("delete：删卡；名单随之消失（现算，不用额外同步）", async () => {
    // **没有角色专用工具了**——删一份文档就是通用 delete 加一个项目相对路径。
    const r = await deleteTool.execute({ path: CARD("林晚") }, makeCtx(pid) as never);
    expect(r.output).toContain("已删除");
    expect(await readDoc(pid, CARD("林晚"))).toBeUndefined();
    expect(await buildIndex(pid)).not.toContain("林晚");
  });
});

// ─── runner：halt 只在成功时置位 ───

// ─── propose-plan：规划工件 + 用户拍板 ───

describe("propose-plan · 规划工件与拍板", () => {
  const PLAN = [
    "意图：把岛上这七个人点一遍。",
    "",
    "产物（按序）：",
    "  1. chapters/chapter_ch1_v1.md",
    "",
    "第 1 步要什么：",
    "  节拍：上岛第一晚。退路断在谁也没看见的时候。",
    "  需要的角色：七个人都露一面，谁跟谁不熟要显出来。",
  ].join("\n");

  test("交出规划、halt、落 .talemate/plans/、登记待拍板，且不碰作品目录", async () => {
    const ctx = makeCtx(pid);
    const before = await enumerateDocs(pid, "design/");

    const r = await proposePlanTool.execute({ chapter: 1, content: PLAN }, ctx as never);

    expect(proposePlanTool.halt).toBe(true); // 门靠它：交出去就停，不靠模型自觉
    expect(r.output).toContain("规划已交给用户");
    expect(ctx.shown[0]).toContain("──── 第 1 章 · 规划 ────");
    expect(ctx.shown[0]).toContain("上岛第一晚。");
    expect(ctx.shown[0]).toContain("意图：把岛上这七个人点一遍。");
    expect(ctx.shown[0]).not.toContain("回复「没问题」");

    // **真的落盘了**（旧断言是"节拍不落盘"），落的是引擎工作区：`read` 那个读口看不见它，
    // 语料也枚举不到它——规划不是作品的一份文档（见 framework/plan.ts 的文件头）。
    const onDisk = await readFile(planAbs(pid, 1), "utf-8");
    expect(onDisk).toContain("# 第 1 章规划");
    expect(onDisk).toContain("上岛第一晚。");
    expect(await readDoc(pid, ".talemate/plans/ch_1.md")).toBeUndefined();
    expect(await enumerateDocs(pid, "design/")).toEqual(before);

    // 登记成"待执行的规划"：用户回话后由 harness 置 approved，模型自述无效
    expect(ctx.pending.get(PLAN_KEY)?.chapter).toBe(1);
    expect(ctx.pending.get(PLAN_KEY)?.approved).toBe(false);
  });

  test("同一章再交一份即覆盖（一章一个工件），别的章各留各的", async () => {
    const ctx = makeCtx(pid);
    await proposePlanTool.execute({ chapter: 2, content: "第一版。" }, ctx as never);
    await proposePlanTool.execute({ chapter: 2, content: "第二版。" }, ctx as never);
    await proposePlanTool.execute({ chapter: 3, content: "第三章的。" }, ctx as never);

    // 清理策略就是这一条：名字由章号决定，所以再交一份就是替换，章数封顶了工件的数量
    const ch2 = await readFile(planAbs(pid, 2), "utf-8");
    expect(ch2).toContain("第二版。");
    expect(ch2).not.toContain("第一版。");
    expect(await readFile(planAbs(pid, 3), "utf-8")).toContain("第三章的。");
    // 待拍板的只有最近那一份——一回合只交一份（halt 保证）
    expect(ctx.pending.get(PLAN_KEY)?.chapter).toBe(3);
  });

  test("content 为空 / chapter 不是正整数 → 抛错而不是 return（return 会被 runner 置 halt）", async () => {
    const ctx = makeCtx(pid);
    await expect(proposePlanTool.execute({ chapter: 1, content: "   " }, ctx as never)).rejects.toThrow("缺少 content");
    await expect(
      proposePlanTool.execute({ chapter: "第 1 章", content: PLAN } as never, ctx as never),
    ).rejects.toThrow("正整数");
    expect(ctx.shown.length).toBe(0); // 什么都没交出去
  });

  test("**不进任何模式**也交得了规划——它批准的是执行，不是一份要审阅的稿子", async () => {
    // 规划批准的是"照它去执行"，不是一份要审阅的文档；旧草稿模式那种"edit / delegate 全 deny"
    // 对"写正文前的准备"没有意义。
    const ctx = makeCtx(pid);
    expect(ctx.getMode()).toBeUndefined();
    const r = await proposePlanTool.execute({ chapter: 1, content: PLAN }, ctx as never);
    expect(r.output).toContain("规划已交给用户");
    expect(ctx.modeLog).toEqual([]); // 也没有顺手把模式切过去
  });

  test("task 派规划者不再有硬门——门只剩 propose-plan 的 halt 那一半", async () => {
    // 从前这里挡的是"没拍板过的节拍就别派 writer"。正文改由 mate 自己写之后，写正文不再经过任何
    // 一个可以挂门的工具（那是普通 write，用户照样在 diff 上点头），硬门随之取消。
    const ctx = makeCtx(pid);
    const r = await taskTool.execute({ agent: "planner", prompt: "把第 1 章的规划做出来。" }, ctx as never);
    expect(r.output).toContain('agent="planner" state="completed"');
    expect(r.output).toContain('session="sub-test"');
  });

  test("待办注记说清是哪一章、工件在哪、拍完板该干什么（压缩之后靠它，不靠消息历史）", async () => {
    const ctx = makeCtx(pid);
    await proposePlanTool.execute({ chapter: 1, content: PLAN }, ctx as never);
    const note = renderPendingNote(ctx.pending)!;
    expect(note).toContain("第 1 章的规划");
    // 规划躺在 read / list 看不见的地方，所以路径必须报出来
    expect(note).toContain(".talemate/plans/ch_1.md");
    expect(note).toContain("用户还没同意");

    ctx.pending.get(PLAN_KEY)!.approved = true;
    const approved = renderPendingNote(ctx.pending)!;
    expect(approved).toContain("按「产物（按序）」执行");
    // 文风不再靠 mate 自己记得去取——规范与卡由 harness 随 system 一起交出去（framework/prose.ts）
    expect(approved).not.toContain("skill(prose)");
  });

  test("正文一落盘，规划就不再是待办——注记改口，但条目留着", async () => {
    const ctx = makeCtx(pid);
    await proposePlanTool.execute({ chapter: 1, content: PLAN }, ctx as never);
    const plan = ctx.pending.get(PLAN_KEY)!;
    plan.approved = true;

    const write = (path: string) => ({ id: "c", name: "write", input: { path } });
    // 四条都不算：别的章、工具没成功（用户拒了 / 校验没过）、还没拍板、工具不是写文件
    const notSettling = [
      writeSettlesPlan(plan, write("chapters/chapter_ch2_v1.md"), true),
      writeSettlesPlan(plan, write("chapters/chapter_ch1_v1.md"), false),
      writeSettlesPlan({ ...plan, approved: false }, write("chapters/chapter_ch1_v1.md"), true),
      writeSettlesPlan(plan, { id: "c", name: "read", input: { path: "chapters/chapter_ch1_v1.md" } }, true),
    ];
    expect(notSettling).toEqual([false, false, false, false]);
    // 是这一章、确实落盘了（`edit` 也算：局部改完那一章就在了）
    expect(writeSettlesPlan(plan, { id: "c", name: "edit", input: { path: "chapters/chapter_ch1_v1.md" } }, true)).toBe(true);

    plan.done = true;
    const note = renderPendingNote(ctx.pending)!;
    expect(note).toContain("<settled-plan>");
    expect(note).not.toContain("按「产物（按序）」执行"); // 执行过了，不该再喊一次
    expect(ctx.pending.has(PLAN_KEY)).toBe(true); // **不是删除**：规划正文只活在 pending 里
    expect(note).toContain(".talemate/plans/ch_1.md");
  });

  test("章文件的认法只认一种形状——写错名字是失效，不是误判", () => {
    const cases: [string, number, boolean][] = [
      ["chapters/chapter_ch1_v1.md", 1, true],
      ["chapters/chapter_ch3_v12.md", 3, true],
      ["chapters/chapter_ch12_v1.md", 12, true],
      ["chapters/chapter_ch2_v1.md", 1, false], // 是章文件，但不是这一章
      ["chapters/chapter_ch1_v1.md", 12, false], // 反过来也一样
      ["chapters/ch1.md", 1, false], // 没按约定命名 → done 不置位，退回"一直开着"（失效，不是误判）
      ["design/core.md", 1, false],
      ["chapters/chapter_ch1_v1.txt", 1, false],
    ];
    const wrong = cases.filter(([p, n, want]) => isChapterFile(p, n) !== want).map(([p]) => p);
    expect(wrong).toEqual([]);
  });
});

// ─── 正文写作窗口 ───

// ─── 建书时种下的书架声明 ───

describe("withShelf · 书架声明种进核心设定", () => {
  test("没有 core.md 时起手一份：先频道、后题材，各一行", () => {
    const text = withShelf(undefined, "男频", "都市");
    expect(text).toContain("# 核心设定");
    expect(text).toContain(`## ${SHELF_HEADING}\n男频\n都市`);
  });

  test("已经有这一格时只换那一格，别的一格不动", () => {
    const core = `# 核心设定\n\n## ${SHELF_HEADING}\n女频\n古言\n\n## 一句话简介\n她回了一趟老家。\n`;
    const text = withShelf(core, "男频", "玄幻");
    expect(text).toContain(`## ${SHELF_HEADING}\n男频\n玄幻`);
    expect(text).toContain("## 一句话简介\n她回了一趟老家。");
    expect(text).not.toContain("古言");
  });

  test("只选了频道没选题材，也写得进去", () => {
    expect(withShelf(undefined, "女频", "")).toContain(`## ${SHELF_HEADING}\n女频`);
  });

  test("两个值都空 → 不写：没有可写的东西就不该凭空造一份 core.md", () => {
    expect(withShelf(undefined, undefined, undefined)).toBeUndefined();
    expect(withShelf(undefined, "", "  ")).toBeUndefined();
    expect(withShelf("# 核心设定\n", "", "")).toBeUndefined();
  });
});

describe("文风目录 · 状态栏那个选择器取的两样", () => {
  test("withStyle：没有核心设定时起手一份，格内容就是卡名", () => {
    const text = withStyle(undefined, "style-01-wangwen");
    expect(text).toContain("# 核心设定");
    expect(text).toContain(`## ${STYLE_HEADING}\nstyle-01-wangwen`);
  });

  test("withStyle：已有核心设定时只换那一格", () => {
    const core = "# 核心设定\n\n## 题材 · 频道\n男频\n\n## 文风\nstorytelling\n";
    const text = withStyle(core, "style-01-wangwen");
    expect(text).toContain("## 题材 · 频道\n男频");
    expect(text).toContain("## 文风\nstyle-01-wangwen");
  });

  test("当前文风：没有 core.md → 默认卡，没什么可说的", async () => {
    const id = (await createProject({ title: "文风 · 空项目" })).id;
    const { current } = await styleCatalog(id);
    expect(current.name).toBe(DEFAULT_STYLE);
    expect(current.note).toBeUndefined();
  });

  test("当前文风：格里的字不是卡名 → 照样报出来，不静默换掉用户的声口", async () => {
    const id = (await createProject({ title: "文风 · 大白话" })).id;
    await writeDoc(id, "design/core.md", "# 核心设定\n\n## 文风\n写得顺一点的那种网文味道\n");
    const { current } = await styleCatalog(id);
    expect(current.name).toBe(DEFAULT_STYLE);
    expect(current.note).toBeDefined();
  });

  test("候选集只列 `kind: style` 的卡——普通 skill 不许混进文风选择器", async () => {
    const id = (await createProject({ title: "文风 · 混合库" })).id;
    // 往项目库里丢一个**没有 kind** 的普通 skill：它会被 discoverSkills 看到，
    // 但绝不该出现在文风候选里——选中它等于把一份工作法当成"一种声音"注进正文窗口
    const dir = join(projectPaths(talemateHome(), id).skills, "lookup");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "---\nname: lookup\ndescription: 查资料的普通 skill\n---\n\n正文\n");

    const { cards } = await styleCatalog(id);
    const names = cards.map((c) => c.name);
    expect(names).not.toContain("lookup");
    expect(names).toContain(DEFAULT_STYLE); // 内置那两张声明过 kind，在
    // 界面上给人看的是中文 title；写进 core.md 的才是 name
    expect(cards.find((c) => c.name === DEFAULT_STYLE)?.title).not.toBe(DEFAULT_STYLE);
  });
});

describe("正文写作窗口 · 规范与文风卡什么时候进上下文", () => {
  const CORE = (body: string): string => `# 核心\n\n## 文风\n${body}\n`;

  test("文风格读不出卡名时用默认，**但带一句说明**——不能静默换掉用户的声口", () => {
    const cases: [string, string, boolean][] = [
      ["（待定）", "storytelling", false], // 没填 → 默认，没什么可说的
      ["网文爽文那一张", "storytelling", true], // 不像卡名 → 默认 + 说明
      ["storytelling", "storytelling", false],
      ["style-01-wangwen", "style-01-wangwen", false],
      ["文风：storytelling", "storytelling", false], // 格是给人写的，容忍几种写法
      ["- **storytelling**", "storytelling", false],
    ];
    const wrong = cases
      .filter(([body, want, wantNote]) => {
        const c = styleChoiceFrom(CORE(body));
        return c.name !== want || (c.note !== undefined) !== wantNote;
      })
      .map(([body]) => body);
    expect(wrong).toEqual([]);
  });

  test("没有核心设定、或没有文风格 → 默认那张", () => {
    const got = [
      styleChoiceFrom(undefined).name,
      styleChoiceFrom("# 核心\n\n## 一句话简介\n沈越想活着回去。\n").name,
    ];
    expect(got).toEqual(["storytelling", "storytelling"]);
  });

  test("窗口块：规范 + 卡 + 落盘路径，三样一起给", async () => {
    await writeDoc(pid, "design/core.md", CORE("storytelling"));
    const brief = await buildProseBrief(pid, 3);
    const missing = [
      `<prose-window chapter="3">`,
      "【正文规范】",
      "Point of view has a declared mode", // 规范正文真的进来了
      "【这本书的文风】storytelling",
      "叙述者在场", // 卡的正文真的进来了
      "段落是完整的一件事",
      // 落盘路径必须就是 `isChapterFile` 认的那一个：告诉它的名字和认它的名字是同一件事的两半
      "chapters/chapter_ch3_v1.md",
    ].filter((s) => !brief.includes(s));
    expect(missing).toEqual([]);
  });

  test("换一张卡：核心设定写哪张，交出来的就是哪张的正文——选得到，不是只挂在目录里", async () => {
    // 这条钉的是"用户能切换文风"的**取用端**：卡名写进「文风」格之后，真的走到写正文那一步。
    // 卡名与正文各取一处（正文用「名字领句」，是该卡最醒目的指纹）——目录里有、正文却取不到，
    // 正是会静默发生的那种失败。
    await writeDoc(pid, "design/core.md", CORE("style-01-wangwen"));
    const brief = await buildProseBrief(pid, 1);
    const missing = ["【这本书的文风】style-01-wangwen", "名字领句"].filter((s) => !brief.includes(s));
    expect(missing).toEqual([]);
  });

  test("指定的卡在库里不存在 → 明说要问用户，**不静默退回默认**", async () => {
    await writeDoc(pid, "design/core.md", CORE("style-bucunzai"));
    const brief = await buildProseBrief(pid, 1);
    expect(brief).toContain("style-bucunzai");
    expect(brief).toContain("文风库里没有这个名字");
    expect(brief).toContain("先别写正文"); // 不是"悄悄用默认那张接着写"
  });
});

// ─── 会话模式 ───

describe("会话模式 · prose", () => {
  test("enter-prose / exit-prose：只有规划已批准且未执行时能进", async () => {
    const ctx = makeCtx(pid);
    expect((await enterProseTool.execute({}, ctx as never)).output).toContain("还没有已批准");
    ctx.pending.set(PLAN_KEY, {
      name: PLAN_KEY,
      content: "## 意图\n测试\n",
      chapter: 1,
      approved: true,
      at: Date.now(),
    });
    await enterProseTool.execute({}, ctx as never);
    expect(ctx.getMode()).toBe("prose");
    expect(ctx.modeLog).toEqual(["prose"]);
    await exitProseTool.execute({}, ctx as never);
    expect(ctx.getMode()).toBeUndefined();
    expect(ctx.modeLog).toEqual(["prose", undefined]);
  });

  test("正文模式不挡工具：它换的是 system，不是权限档", async () => {
    // 写正文走普通 `write`，用户照样在 diff 上点头；模式只在正文窗口打开时改人格。
    const available = visibleTools([...BUILTIN_TOOLS], mergeConfigs(BASE_PERMISSIONS)).map((t) => t.id);
    expect(available).toContain("write");
    expect(available).toContain("edit");
    expect(available).toContain("task");
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

  test("deny 单调——不受顺序影响", () => {
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
    // agent 声明也在这条链上：子代理（planner / researcher）的 question: deny 压过内置默认的 allow
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

  test("渲染成文本：每类动作都有结论、来源点到具体那一层（CLI 与界面共用这一份）", async () => {
    const text = renderPermissionView((await sessionWith({ edit: "deny" })).permissionView());

    // 类别取自 BASE_PERMISSIONS 的键——这里不再抄一份清单，直接拿它数
    for (const p of Object.keys(BASE_PERMISSIONS)) expect(text).toContain(p);
    // 用户配的那条要说得出是哪一层定的（这正是这张表存在的理由）
    expect(text).toMatch(/edit\s+deny\s+←\s+项目配置 talemate\.json/);
    expect(text).toContain("分层");
    expect(text).toContain("会话已批准");
  });
});

describe("权限 · 会话级行为", () => {
  test("accept-edits：落盘不问，委派与联网照问", async () => {
    const ctx = makeCtx(pid, mergeConfigs(BASE_PERMISSIONS, MODES["accept-edits"].permission));
    expect(await ctx.ask({ permission: "edit", pattern: "design/core.md", summary: "" })).toBe("allow");
    expect(ctx.check("delegate", "planner")).toBe("ask");
    expect(ctx.check("extern", "https://x")).toBe("ask");
  });

  test("planner / researcher 的类别拒：edit 与 delegate 都是 deny（只读）", async () => {
    const ctx = makeCtx(pid, mergeConfigs(BASE_PERMISSIONS, { edit: "deny", delegate: "deny" }));
    expect(ctx.check("edit", "design/core.md")).toBe("deny");
    expect(await ctx.ask({ permission: "edit", pattern: "design/core.md", summary: "" })).toBe("deny");
    expect(ctx.check("extern", "https://x")).toBe("ask"); // 查资料仍然可以
  });

  test("reject 与 deny 是两回事：前者等人点头，后者连问都不问", async () => {
    const ctx = makeCtx(pid);
    ctx.setConfirmReply("no");
    expect(await ctx.ask({ permission: "edit", pattern: "design/a.md", summary: "" })).toBe("reject");

    const strict = makeCtx(pid, fromConfig({ edit: "deny" }));
    expect(await strict.ask({ permission: "edit", pattern: "design/a.md", summary: "" })).toBe("deny");
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

  test("落盘也要过规则表——「不许」不因为问过一次就失效", async () => {
    const doc = "design/wiki/guarded.md";
    const before = "# X\n\n## 甲\n旧的一版。\n";
    await writeDoc(pid, doc, before);
    // pattern 是**项目相对路径**，与工具入参、与 docs/permissions.md 的例子同一口径——
    // 三者曾经各说各话（写入传的是裸 `name`），于是文档里写的 `design/core.md` 这类规则从来没生效过。
    const ctx = makeCtx(pid, mergeConfigs(BASE_PERMISSIONS, { edit: { "*": "allow", [doc]: "deny" } }));

    const r = await writeTool.execute({ path: doc, content: "# X\n\n## 甲\n新的一版。\n" }, ctx as never);
    expect(r.output).toContain("不允许改文件");
    expect(await readDoc(pid, doc)).toContain("旧的一版。"); // 真的一个字没写进去
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
      makeCtx(pid, mergeConfigs(BASE_PERMISSIONS, { edit: "deny" })) as never,
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

  // 上面那条用手写工具钉语义，这条钉**真实工具**照它做了——propose-plan 自愈路径抛错时
  // 回合必须留着，模型才能照自愈文案带正确参数重调。
  test("校验失败不停轮：propose-plan 缺 content → error 且不 halt", async () => {
    const reg = new ToolRegistry();
    reg.register(proposePlanTool);
    const part = await executeToolPart(
      "mate",
      { id: "1", name: "propose-plan", input: { chapter: 1, content: "" } },
      reg,
      makeCtx(pid) as never,
    );
    expect(part.type === "tool" && part.state).toBe("error");
    expect(part.type === "tool" && part.halt).toBeFalsy();
  });
});

// ─── 考据本（researcher 的笔记本，`.talemate/research/`） ───

describe("考据本 · 记一条、翻回来、以及它够不着作品", () => {
  /** 今天，按**本地**日期算——与工具盖章用的是同一个判据，所以不硬编码。 */
  const TODAY = (() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  })();

  const NOTE = "明代佃租比例";
  const BODY = "结论：佃租约五成。来源 https://a.example/ming";

  test("remember 落盘、recall 带得回正文与「查于」日期", async () => {
    const ctx = makeCtx(pid, fromConfig({ notes: "allow" }));
    await rememberTool.execute({ name: NOTE, content: BODY }, ctx as never);

    const text = await recallTool.execute({ query: "佃租" }, ctx as never);
    const missing = [NOTE, TODAY, "https://a.example/ming"].filter((s) => !text.output.includes(s));
    expect(missing).toEqual([]);
  });

  test("同名再记一次 = 替换，不是新增；文案要点名换掉的是哪一版", async () => {
    const ctx = makeCtx(pid, fromConfig({ notes: "allow" }));
    await rememberTool.execute({ name: NOTE, content: BODY }, ctx as never);
    const again = await rememberTool.execute(
      { name: NOTE, content: "结论改了口径。来源 https://b.example/ming" },
      ctx as never,
    );

    const names = await listNoteNames(pid);
    const wrong = [
      names.filter((n) => n === NOTE).length === 1, // 盘上只有一份
      again.output.includes("替换"),
      again.output.includes(TODAY), // 新查于
      !(await readNote(pid, NOTE))?.includes("https://a.example/ming"), // 旧结论不再服务
    ].filter((x) => !x);
    expect(wrong).toEqual([]);
  });

  test("未命中要回已有题目清单——那是换措辞重试的路", async () => {
    const ctx = makeCtx(pid, fromConfig({ notes: "allow" }));
    const miss = await recallTool.execute({ query: "完全没有的词" }, ctx as never);
    const missing = ["没有找到", NOTE].filter((s) => !miss.output.includes(s));
    expect(missing).toEqual([]);

    const index = await recallTool.execute({}, ctx as never); // 不带 query = 要目录
    expect(index.output.includes(NOTE) && !index.output.includes("没有找到")).toBe(true);
  });

  test("题目不合法 → 自愈文案，且盘上什么都不多", async () => {
    const ctx = makeCtx(pid, fromConfig({ notes: "allow" }));
    const before = (await listNoteNames(pid)).length;
    const outs: string[] = [];
    for (const bad of ["a/b", "明代 佃农", "..", "长".repeat(80)]) {
      outs.push((await rememberTool.execute({ name: bad, content: BODY }, ctx as never)).output);
    }
    const wrong = [
      outs.every((o) => o.includes("重新调用")), // 每条都说清了怎么改
      (await listNoteNames(pid)).length === before,
    ].filter((x) => !x);
    expect(wrong).toEqual([]);
  });

  test("正文没出处 → 拒收并说清为什么；研究员的人格就是每条都带来源", async () => {
    const ctx = makeCtx(pid, fromConfig({ notes: "allow" }));
    const out = await rememberTool.execute({ name: "无出处的结论", content: "反正是这么回事。" }, ctx as never);
    const wrong = [
      out.output.includes("出处"),
      (await listNoteNames(pid)).includes("无出处的结论") === false,
    ].filter((x) => !x);
    expect(wrong).toEqual([]);
  });

  test("考据本够不着作品：list/search/read 都看不见它，这是本设计的地基", async () => {
    const ctx = makeCtx(pid, fromConfig({ notes: "allow" }));
    await rememberTool.execute({ name: NOTE, content: BODY }, ctx as never);

    const wrong = [
      !(await enumerateDocs(pid, "")).some((p) => p.includes(".talemate")),
      (await readDoc(pid, `.talemate/research/${NOTE}.md`)) === undefined,
    ].filter((x) => !x);
    expect(wrong).toEqual([]);
    // 但它在盘上（绝对路径算得出来，文件真的存在）
    expect(await readNote(pid, NOTE)).toBeDefined();
  });

  test("权限：默认 ask——用户说不，就一条都不落", async () => {
    const denied = makeCtx(pid); // 默认规则集（BASE_PERMISSIONS）
    denied.setConfirmReply("no");
    const out = await rememberTool.execute({ name: "被拒的笔记", content: BODY }, denied as never);
    const wrong = [
      out.output.includes("拒绝"),
      (await listNoteNames(pid)).includes("被拒的笔记") === false,
    ].filter((x) => !x);
    expect(wrong).toEqual([]);
  });

  test("`recall` 的缺席是故意的：它没有 permission，就没有可 deny 的把手", async () => {
    // runner 的兜底是 `if (tool.permission && …)`，没有 permission 这条就是死代码——所以 recall
    // 的圈定全靠结构（目录由 projectId 推死、不收路径参数）。给它加上 permission 会让它变得
    // 可被模式打断，而"读自己的笔记本"没有要拦的理由。
    expect(recallTool.permission).toBeUndefined();
    expect(rememberTool.permission).toBe("notes");
  });

  test("绝对路径就是那个绝对路径——题目即文件名，没有第二条寻址", () => {
    expect(noteAbs(pid, NOTE)).toBe(join(talemateHome(), "novels", pid, ".talemate", "research", `${NOTE}.md`));
  });
});

// ─── 文档树（界面左栏那棵树；与 list 的文本索引同族） ───

describe("文档树 · 显示名与排序都只有一份", () => {
  test("顶层是六段中文名，**目录名一个都不出现**", () => {
    const tree = docTree(["state/progress.md", "chapters/chapter_ch1_v1.md", "design/core.md"]);
    expect(tree.map((n) => n.name)).toEqual(["核心设定", "正文", "现状"]);
    // 六段的固定次序：核心设定 → 世界观 → 角色 → 大纲 → 正文 → 现状
    const all = docTree([
      "state/progress.md",
      "chapters/chapter_ch1_v1.md",
      "design/outline/vol_1.md",
      "design/characters/沈越.md",
      "design/wiki/world.md",
      "design/core.md",
    ]);
    expect(all.map((n) => n.name)).toEqual(["核心设定", "世界观", "角色", "大纲", "正文", "现状"]);
  });

  test("名字是人话：第 3 章（第 2 稿）、第 1 卷 / 序列 2、伏笔账", () => {
    const tree = docTree([
      "chapters/chapter_ch3_v2.md",
      "design/outline/vol_1/s2.md",
      "state/foreshadowing.md",
      "design/characters/沈越.md",
    ]);
    const byName = Object.fromEntries(tree.map((n) => [n.name, n]));
    const wrong = [
      byName["正文"]?.children?.[0]?.name === "第 3 章（第 2 稿）",
      byName["正文"]?.children?.[0]?.path === "chapters/chapter_ch3_v2.md",
      byName["大纲"]?.children?.[0]?.name === "第 1 卷",
      byName["大纲"]?.children?.[0]?.children?.[0]?.name === "序列 2",
      byName["现状"]?.children?.[0]?.name === "伏笔账",
    ].filter((x) => !x);
    expect(wrong).toEqual([]);
  });

  test("章号按数值排：第 2 章在第 10 章前面", () => {
    const tree = docTree(["chapters/chapter_ch10_v1.md", "chapters/chapter_ch2_v1.md"]);
    expect(tree[0].children?.map((n) => n.name)).toEqual(["第 2 章", "第 10 章"]);
  });

  test("一段既有总纲又有专题页时，那个节点**两个身份都有**；纯分组只有名字", () => {
    const tree = docTree(["design/wiki/world.md", "design/wiki/漕运.md", "design/characters/沈越.md"]);
    const world = tree.find((n) => n.name === "世界观");
    const chars = tree.find((n) => n.name === "角色");
    const wrong = [
      world?.path === "design/wiki/world.md", // 点它开总纲
      world?.children?.[0]?.name === "漕运", // 箭头展开看专题页
      chars?.path === undefined, // "角色"本身不是一份文档
      chars?.children?.[0]?.name === "沈越",
    ].filter((x) => !x);
    expect(wrong).toEqual([]);
  });

  test("认不出的照原样列进「其他」——加了一类文档忘了配名字，也得看得见", () => {
    const tree = docTree(["design/没有这一类/怪东西.md", "design/core.md"]);
    expect(tree.map((n) => n.name)).toEqual(["核心设定", "其他"]);
    expect(tree[1].children?.[0]?.path).toBe("design/没有这一类/怪东西.md");
  });
});
