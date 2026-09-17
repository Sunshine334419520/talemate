/**
 * 提案渲染：纯函数，无 fs、无 ctx。
 *
 * 这里守的是那条**不变量**：渲染器不认识任何一层。所以最要紧的两个用例是
 * "角色卡"和"无规范登记的专题页"——它们都必须靠 itemsOf 的兜底渲染出来，不新增任何分支。
 * 哪天有人为某一层加了 `if (layer === …)`，这些用例会先炸。
 */
import { describe, test, expect } from "bun:test";
import { buildCardMarkdown } from "./characters";
import { itemsOf, labelOf, renderProposal, reviewable, specFor } from "./proposal";

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

describe("itemsOf · 一个函数、两个数据源", () => {
  test("有规范登记的文件：按规范的小节与**规范顺序**取，不按正文顺序", () => {
    expect(specFor("core.md")?.id).toBe("core");
    expect(itemsOf("core.md", core).map((i) => i.heading)).toEqual([
      "题材 · 频道",
      "一句话简介",
      "金手指 / 超常设定",
      "基调 · 情绪",
    ]);
  });

  test("角色卡走兜底（在规范之外）：H1 + 常驻四格 + 「当前」逐格列出", () => {
    expect(specFor("characters/林晚.md")).toBeUndefined(); // 规范的 file 是目录 characters/
    const card = buildCardMarkdown("林晚", { profile: "空姐，与江屿困同一座岛" });
    expect(itemsOf("characters/林晚.md", card).map((i) => i.heading)).toEqual([
      "基本档案",
      "想要 · 最怕",
      "底线 · 绝不做",
      "说话方式",
      "当前",
    ]);
  });

  test("卡上的自定义长尾小节也逐格列出（开放长尾也能被审阅，不需要任何渲染分支）", () => {
    const card = buildCardMarkdown("乔家劲", { profile: "钵兰街阿劲" }) + "\n\n### 回响\n破万法：契机「想要公平地进行对决」。\n";
    const heads = itemsOf("characters/乔家劲.md", card).map((i) => i.heading);
    expect(heads).toContain("回响");
    expect(heads).toContain("基本档案");
  });

  test("专题页 / 章节细纲同样走兜底", () => {
    expect(itemsOf("wiki/岛屿地图.md", "# 岛屿地图\n\n## 北岸\n礁石。\n").map((i) => i.heading)).toEqual(["北岸"]);
    expect(itemsOf("outline/plan_ch3.md", "## 节拍\n1. 醒来\n").map((i) => i.heading)).toEqual(["节拍"]);
  });

  test("规范之外的小节也列出来（凡要落盘的字节用户都得看得到）", () => {
    const extra = "# 核心设定\n\n## 题材 · 频道\n男频\n\n## 自创的一格\n谁也没规定过这个。\n";
    const items = itemsOf("core.md", extra);
    expect(items.map((i) => i.heading)).toContain("自创的一格");
    expect(items[items.length - 1].heading).toBe("自创的一格"); // 排在规范格之后
  });
});

describe("labelOf · 对用户不出现路径", () => {
  test("有规范 → 层名；没有 → 文档自己的 H1", () => {
    expect(labelOf("core.md", core)).toBe("核心层");
    expect(labelOf("wiki/world.md", "# x\n")).toBe("世界层");
    expect(labelOf("characters/林晚.md", buildCardMarkdown("林晚", {}))).toBe("角色：林晚");
    expect(labelOf("wiki/岛屿地图.md", "# 岛屿地图\n")).toBe("岛屿地图");
  });
});

describe("reviewable · 防「渲染成空页却照样落盘」", () => {
  test("没标题 / 有规范却没按规范组织 → 不能审阅", () => {
    expect(reviewable("core.md", core)).toBe(true);
    expect(reviewable("wiki/x.md", "## A\n内容")).toBe(true);
    expect(reviewable("core.md", "整段散文，一个标题都没有。")).toBe(false);
    expect(reviewable("wiki/x.md", "整段散文，一个标题都没有。")).toBe(false);
    expect(reviewable("core.md", "## 随便一个标题\n内容")).toBe(false); // 四格全空，正文却会原样落盘
  });
});

describe("renderProposal", () => {
  test("整篇：逐格编号 + 待定单独点出 + 收尾契约，且不出现路径", () => {
    const text = renderProposal({ name: "core.md", content: core });

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

  test("单格：只摆那一格，带旧→新字数", () => {
    const text = renderProposal({
      name: "wiki/world.md",
      content: "新的规则正文。",
      section: "规则与秩序",
      oldBody: "旧的。",
    });
    expect(text).toContain("提案 · 世界层 › 规则与秩序");
    expect(text).toContain("其余格不动");
    expect(text).toContain("回复「没问题」就写入；要改直接说。");
    expect(text).not.toContain("第 1 格");
  });

  test("重提：标出本版改动过的格，并说明替换了上一版", () => {
    const v2 = core.replace("男频 · 都市异能", "女频 · 都市异能");
    const text = renderProposal({ name: "core.md", content: v2, previous: core });

    expect(text).toMatch(/题材 · 频道\s*★本版改动/);
    expect(text).not.toMatch(/基调 · 情绪\s*★本版改动/); // 没动的格不打标
    expect(text).toContain("已替换上一版提案");
  });

  test("角色卡也能审阅（不需要为它写任何渲染代码）", () => {
    const card = buildCardMarkdown("林晚", { profile: "空姐，与江屿困同一座岛" });
    const text = renderProposal({ name: "characters/林晚.md", content: card });
    expect(text).toContain("提案 · 角色：林晚");
    expect(text).toContain("1. 基本档案");
    expect(text).toContain("空姐，与江屿困同一座岛");
    expect(text).toContain("第 2、3、4、5 格还没定"); // 只有基本档案填了，其余常驻格与「当前」是占位
  });
});
