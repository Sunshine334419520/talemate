/**
 * 提案渲染：纯函数，无 fs、无 ctx。
 *
 * 这里守的是那条**不变量**：渲染器不认识任何一层。所以最要紧的两个用例是
 * "角色卡"和"无规范登记的专题页"——它们都必须靠 itemsOf 的兜底渲染出来，不新增任何分支。
 * 哪天有人为某一层加了 `if (layer === …)`，这些用例会先炸。
 */
import { describe, test, expect } from "bun:test";
import { itemsOf, labelOf, renderProposal, reviewable } from "../src/framework/proposal";
import { specFor } from "../src/framework/design_spec";

/**
 * 一张手写的角色卡。卡不再由任何构造器生成（`buildCardMarkdown` 已随 `add-character` 删除），
 * 它就是模型按 design-spec 写出来、经 propose-design 落盘的文本——所以这里手写。
 */
const card = [
  "# 角色：林晚",
  "",
  "### 基本档案",
  "空姐，与江屿困同一座岛",
  "",
  "### 性格与矛盾",
  "（待定）",
  "",
  "### 想要 · 最怕",
  "（待定）",
  "",
  "### 底线 · 绝不做",
  "（待定）",
  "",
  "### 说话方式",
  "（待定）",
  "",
].join("\n");

const core = [
  "# 核心设定",
  "",
  "## 基调 · 情绪",
  "冷硬里带一点不甘。",
  "",
  "## 题材 · 频道",
  "男频 · 都市异能",
  "",
].join("\n");

/**
 * 整篇散文、只有 H1——序列纲的形状。它**不该被逼着分格**，但字节必须摆得出来：
 * 从前这种草稿被 reviewable 直接拒收，理由是"渲染成 0 格 = 用户看到空白页"。
 * 现在改成兜底成"整篇一格"，拒绝的理由就没了。
 */
const prose = [
  "# 序列 2 · 夜宴",
  "",
  "主角混进沈家的夜宴，为的是拿到那本账册。",
  "",
  "写的时候：别太顺，中间至少失手一次。",
  "",
  "预估 5-7 万字。",
  "",
].join("\n");

/** 一份卷纲：五格里填了两格，其余留空。 */
const vol = [
  "# 卷 2 · 内城",
  "",
  "## 本卷在全局的位置",
  "主角从外围走到台面上。",
  "",
  "## 卷末状态",
  "从没人知道他在查，变成沈家知道他在查。",
  "",
].join("\n");

/**
 * 提案的**唯一不变量**：会落盘的字节，用户必须都看得到。逐行查，缺哪行报哪行
 * （标题行按它的标题文本算——标题在提案里就是那个编号标签）。
 */
function unseenLines(rendered: string, content: string): string[] {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => {
      const heading = l.match(/^#{1,6}\s+(.*)$/);
      return heading ? !rendered.includes(heading[1]) : !rendered.includes(l);
    });
}

describe("itemsOf · 一个函数、两个数据源", () => {
  test("有规范登记的文件：按规范的小节与**规范顺序**取，不按正文顺序", () => {
    // 用户看到的标签取规范里的**短名**（不是 `core.md` 的 H1「core」）
    expect(specFor("design/core.md")?.label).toBe("核心层");
    expect(itemsOf("design/core.md", core).map((i) => i.heading)).toEqual([
      "题材 · 频道",
      "一句话简介",
      "金手指 / 超常设定",
      "基调 · 情绪",
    ]);
  });

  test("角色卡走兜底（规范不分格）：H1 + 必有五格逐格列出", () => {
    // 卡现在**有**规范（`characters/*`），但 `sections` 为空 → 照旧落到 ownItems 兜底，行为不变。
    // 从前"有没有规范"是按精确文件名判的，卡匹配不上纯属偶然；改按路径之后卡拿得到建卡方法
    // （`design-spec(name:"characters/林晚.md")` 不再回一句误导的"未登记"）。
    expect(specFor("design/characters/林晚.md")?.sections).toEqual([]);
    expect(itemsOf("design/characters/林晚.md", card).map((i) => i.heading)).toEqual([
      "基本档案",
      "性格与矛盾",
      "想要 · 最怕",
      "底线 · 绝不做",
      "说话方式",
    ]);
  });

  test("卡上的自由长尾小节也逐格列出（开放长尾也能被审阅，不需要任何渲染分支）", () => {
    const withTail = `${card}\n### 回响\n破万法：契机「想要公平地进行对决」。\n`;
    const heads = itemsOf("design/characters/乔家劲.md", withTail).map((i) => i.heading);
    expect(heads).toContain("回响");
    expect(heads).toContain("基本档案");
  });

  test("专题页 / 章节细纲同样走兜底", () => {
    expect(itemsOf("design/wiki/岛屿地图.md", "# 岛屿地图\n\n## 北岸\n礁石。\n").map((i) => i.heading)).toEqual(["北岸"]);
    expect(itemsOf("design/outline/plan_ch3.md", "## 节拍\n1. 醒来\n").map((i) => i.heading)).toEqual(["节拍"]);
  });

  test("情节层按**路径模式**登记：同一个层下的卷纲与序列纲靠模式分开，章计划仍无规范", () => {
    expect(specFor("design/outline/vol_2.md")?.id).toBe("outline-vol");
    expect(specFor("design/outline/vol_2/s3.md")?.id).toBe("outline-seq");
    expect(specFor("design/outline/plan_ch3.md")).toBeUndefined();
    // **旧正则有、glob 没有的一条严格性**：`\d+`。`permission.match` 只认 `*`/`?`，表达不了
    // "卷号必须是数字"，所以 `vol_.md` 这类畸形路径现在也会落到卷纲规范上。
    // 这是**换来词表统一**的代价（与 `invariants`、权限用同一套匹配），也确实是更有用的答案：
    // 模型想写的本来就是一份卷纲，回它"卷纲的形状"比回"未登记"更接近它的意图。
    // 真正要守的不是畸形路径，而是**两种大纲分得开**——`outline/vol_*.md` 也命中序列纲的路径，
    // 分开它们的是模式长度而非表序，`tests/specs.test.ts` 钉住这条。
    expect(specFor("design/outline/vol_.md")?.id).toBe("outline-vol");
  });

  test("卷纲按它的五格取；序列纲不分格，一格都没有", () => {
    expect(itemsOf("design/outline/vol_2.md", vol).map((i) => i.heading)).toEqual([
      "本卷在全局的位置",
      "本卷目标与阻力",
      "本卷的情绪曲线",
      "卷末状态",
      "本卷的序列",
    ]);
    expect(specFor("design/outline/vol_2/s2.md")?.sections).toEqual([]);
    expect(itemsOf("design/outline/vol_2/s2.md", prose)).toEqual([]); // 交给 reviewOf 兜底成"整篇一格"
  });

  test("规范之外的小节也列出来（凡要落盘的字节用户都得看得到）", () => {
    const extra = "# 核心设定\n\n## 题材 · 频道\n男频\n\n## 自创的一格\n谁也没规定过这个。\n";
    const items = itemsOf("design/core.md", extra);
    expect(items.map((i) => i.heading)).toContain("自创的一格");
    expect(items[items.length - 1].heading).toBe("自创的一格"); // 排在规范格之后
  });
});

describe("labelOf · 对用户不出现路径", () => {
  test("层的规范 → 层名；文档的规范与开放文档 → 文档自己的 H1", () => {
    expect(labelOf("design/core.md", core)).toBe("核心层");
    expect(labelOf("design/wiki/world.md", "# x\n")).toBe("世界层");
    expect(labelOf("design/characters/林晚.md", card)).toBe("角色：林晚");
    expect(labelOf("design/wiki/岛屿地图.md", "# 岛屿地图\n")).toBe("岛屿地图");
    // 卷纲/序列纲的 H1（「卷 2 · 内城」）比"卷纲"这三个字有信息量
    expect(labelOf("design/outline/vol_2.md", vol)).toBe("卷 2 · 内城");
    expect(labelOf("design/outline/vol_2/s2.md", prose)).toBe("序列 2 · 夜宴");
    expect(labelOf("design/outline/vol_2/s2.md", "没有标题的草稿")).toBe("序列纲"); // 无 H1 → 退回规范名
  });
});

describe("reviewable · 防「渲染成空页却照样落盘」", () => {
  test("规范规定了小节的文档：没按规范组织 → 不能审阅（几格全待定，散文却会原样落盘）", () => {
    expect(reviewable("design/core.md", core)).toBe(true);
    expect(reviewable("design/core.md", "整段散文，一个标题都没有。")).toBe(false);
    expect(reviewable("design/core.md", "## 随便一个标题\n内容")).toBe(false);
    expect(reviewable("design/wiki/world.md", prose)).toBe(false); // 规范按文件登记，wiki/world.md 也算有规范
    expect(reviewable("design/outline/vol_2.md", vol)).toBe(true); // 卷纲走同一条判据
    expect(reviewable("design/outline/vol_2.md", "整段散文，一个标题都没有。")).toBe(false);
  });

  test("规范说「不分格」的文档：落到开放文档那条判据（空 sections 不许把提案一律拒掉）", () => {
    // 序列纲的 sections 为空。少了 reviewable 里 `spec.sections.length` 那一半，`[].some()` 恒为
    // false，**所有序列纲提案都会提不出来**——这条用例就是钉住那一半的。
    expect(specFor("design/outline/vol_2/s2.md")?.sections).toEqual([]);
    expect(reviewable("design/outline/vol_2/s2.md", prose)).toBe(true);
    expect(reviewable("design/outline/vol_2/s2.md", "（待定）")).toBe(false); // 整篇只有占位：什么都看不到
    expect(reviewable("design/characters/林晚.md", card)).toBe(true); // 角色卡同走这条路
  });

  test("无规范登记的文档：有 level ≥ 2 标题就逐格，没有就整篇一格——两种都看得到字节", () => {
    expect(reviewable("design/wiki/x.md", "## A\n内容")).toBe(true);
    expect(reviewable("design/wiki/岛屿地图.md", prose)).toBe(true);
    expect(reviewable("design/outline/plan_ch3.md", prose)).toBe(true);
  });
});

describe("renderProposal", () => {
  test("整篇：逐格编号 + 待定单独点出 + 收尾契约，且不出现路径", () => {
    const text = renderProposal({ name: "design/core.md", content: core });

    expect(text).toContain("提案 · 核心层");
    expect(text).toContain("1. 题材 · 频道");
    expect(text).toContain("男频 · 都市异能");
    expect(text).toContain("2. 一句话简介");
    expect(text).toContain("第 2、3 格还没定"); // 没写的格被点出来问一句
    expect(text).toContain("先留白，还是现在给我一句？");
    expect(text).toContain("回复「没问题」就写入核心层；要改直接说第几格。");
    expect(text).not.toContain(".md");
    expect(text).not.toContain("design/");
  });

  // 「只改一格」不再是一种提案：它走二向的 edit（用户看 diff，不看提案）。
  // 提案只有整篇一种形态，所以这里没有再测"单格"渲染的用例。

  test("重提：标出本版改动过的格，并说明替换了上一版", () => {
    const v2 = core.replace("男频 · 都市异能", "女频 · 都市异能");
    const text = renderProposal({ name: "design/core.md", content: v2, previous: core });

    expect(text).toMatch(/题材 · 频道\s*★本版改动/);
    expect(text).not.toMatch(/基调 · 情绪\s*★本版改动/); // 没动的格不打标
    expect(text).toContain("已替换上一版提案");
  });

  test("角色卡也能审阅（不需要为它写任何渲染代码）", () => {
    const text = renderProposal({ name: "design/characters/林晚.md", content: card });
    expect(text).toContain("提案 · 角色：林晚");
    expect(text).toContain("1. 基本档案");
    expect(text).toContain("空姐，与江屿困同一座岛");
    expect(text).toContain("第 2、3、4、5 格还没定"); // 只有基本档案填了，其余四格是（待定）
  });

  test("序列纲（规范说「不分格」）→ 整篇一格摆出来，要落盘的字节一字不少", () => {
    const text = renderProposal({ name: "design/outline/vol_2/s2.md", content: prose });

    expect(text).toContain("提案 · 序列 2 · 夜宴"); // 标签取文档自己的 H1
    expect(text).toContain("整篇草稿 · 1 格");
    expect(text).toContain("1. 全文");
    expect(unseenLines(text, prose)).toEqual([]); // 兜底存在的全部理由
    expect(text).not.toContain(".md");
  });

  test("卷纲走逐格：五格齐出，没填的点成（待定）", () => {
    const text = renderProposal({ name: "design/outline/vol_2.md", content: vol });

    expect(text).toContain("提案 · 卷 2 · 内城");
    expect(text).toContain("1. 本卷在全局的位置");
    expect(text).toContain("主角从外围走到台面上。");
    expect(text).toContain("4. 卷末状态");
    expect(text).toContain("第 2、3、5 格还没定"); // 只填了位置与卷末状态
    expect(unseenLines(text, vol)).toEqual([]);
  });

  test("有规范登记的层：`##` 之外的字节（文档标题、导语）也摆出来——从前它们是隐形落盘", () => {
    const text = renderProposal({ name: "design/core.md", content: core });

    expect(text).toContain("另有不在小节里的部分");
    expect(text).toContain("不在任何小节里");
    expect(text).toContain("核心设定"); // core 的 H1，规范里没有这一格，却会原样写入
    expect(unseenLines(text, core)).toEqual([]);
  });

  test("不在格里的部分改了也要标★（否则改稿会漏看一处）", () => {
    const v2 = core.replace("# 核心设定", "# 核心设定（改过）");
    const text = renderProposal({ name: "design/core.md", content: v2, previous: core });
    expect(text).toMatch(/不在任何小节里\s*★本版改动/);
  });

  test("正文中间的 `#` 会截断 `##` 的区块——被漏掉的那段也不许隐形（uncoveredText 取补集的原因）", () => {
    const mid = "# 标题\n\n## A\n甲。\n# 半路冒出来的标题\n乙。\n## B\n丙。\n";
    const text = renderProposal({ name: "design/wiki/x.md", content: mid });

    // 「甲。」进 A 格；「乙。」在区块之外、又不在开头——只取"首个 ## 之前"是捞不到它的
    expect(text).toContain("乙。");
    expect(unseenLines(text, mid)).toEqual([]);
  });

  test("整篇一格重提时照样标出「本版改动」（diff 不被兜底打断）", () => {
    const v2 = prose.replace("预估 5-7 万字。", "预估 3-4 万字。");
    const text = renderProposal({ name: "design/outline/vol_2/s2.md", content: v2, previous: prose });

    expect(text).toMatch(/全文\s*★本版改动/);
    expect(text).toContain("已替换上一版提案");
  });
});
