/**
 * 目录摘要器的离线测试：**一份文档在索引里占哪一行**，以及"没有一行"的那几种。
 * 运行：bun test
 *
 * 纯函数（路径 + 标签 + 内容进，那一行出），不用起临时目录。盯三件事：
 *   - 注册表真的在派发（角色卡走它），而不是索引里还留着一串 if；
 *   - 那一行**自带 `label`**：散文那行不缀文件名就看不出是哪一份；
 *   - **本该交给兜底的情形确实返回 `undefined`**——"没有一行"和"有一行"同样要紧：
 *     多给一行，那份文档的小节就永远看不见了。
 */
import { describe, test, expect } from "bun:test";
import { summarize } from "../src/framework/summaries";

/** 只填了「基本档案」的薄卡：身份取得到，其余四格待补。 */
const THIN = "# 角色：林晚\n\n### 基本档案\n姓名：林晚\n身份 · 所属：空乘\n";

/** 索引给的默认名字就是这一段的文件名（组名前缀已剥掉）。 */
const at = (path: string, content: string | undefined, label?: string): string | undefined =>
  summarize({ path, label: label ?? (path.split("/").pop() as string), content });

describe("summaries · 注册表派发（角色卡）", () => {
  test("一人一行：`- 名 · 身份（必有齐 / 待补：…）`，**不铺**必有格的标题", () => {
    expect(at("design/characters/林晚.md", THIN)).toBe(
      "- 林晚 · 空乘（待补：性格与矛盾、想要 · 最怕、底线 · 绝不做、说话方式）",
    );
  });

  test("自由长尾缀在「另有」里——不读卡也知道它上面还有什么", () => {
    expect(at("design/characters/林晚.md", `${THIN}\n### 回响\n破万法。\n`)).toContain("另有：回响");
  });

  test("读不到内容 → 那一行也在，只是写成「（缺）」", () => {
    expect(at("design/characters/林晚.md", undefined)).toBe("- 林晚 · （缺）");
  });

  test("`characters/` 下**不是卡**的东西让位——由 `nameFromPath` 说了算，不由路径模式说了算", () => {
    // `_index.md` 是 2026-09-18 删掉的派生总表。它匹配得上 `characters/*.md`，但它不是卡。
    // 让位 = **没有一行**（不是"退回去问规范"）：退回去会让它掉进"不分格就取首句"那条通用规则，
    // 拿到一句脱离上下文的正文（这张卡上就是「码头搬运工」）。
    // 索引另有一条遗留跳过（见 anchor.ts 的 LEGACY_SKIP），所以它连小节也不会被铺出来。
    expect(at("design/characters/_index.md", "# 角色总表\n\n## 沈越\n码头搬运工\n")).toBeUndefined();
  });
});

describe("summaries · 规范派生（不分格的文档给 `label（首句）`）", () => {
  test("序列纲整篇散文：首句才是信号，小节标题不是——**而且得缀上文件名**", () => {
    expect(at("design/outline/vol_1/s1.md", "主角混进内城，为的是见一个人。\n第二句。\n", "vol_1/s1.md")).toBe(
      "vol_1/s1.md（主角混进内城，为的是见一个人。）",
    );
  });

  test("首句跳过标题行、占位、引用块", () => {
    const doc = "# 序列纲\n\n（待定）\n\n> 引导语\n\n真正的第一句。\n";
    expect(at("design/outline/vol_1/s1.md", doc)).toBe("s1.md（真正的第一句。）");
  });

  test("过长截断（40 字 + 省略号）", () => {
    const out = at("design/outline/vol_1/s1.md", `${"一".repeat(60)}。`) ?? "";
    expect(out).toBe(`s1.md（${"一".repeat(40)}…）`);
  });

  test("整篇都是占位/空行 → 「空」，不是一页空白", () => {
    expect(at("design/outline/vol_1/s1.md", "# 序列纲\n\n（待定）\n")).toBe("s1.md（空）");
  });
});

describe("summaries · 没有一行的情况（交给索引铺小节）", () => {
  test("有格的文档：返回 undefined，索引去铺它的小节标题", () => {
    expect(at("design/core.md", "# 核心\n\n## 一句话简介\n沈越想活着回去。\n")).toBeUndefined();
    expect(at("design/outline/vol_2.md", "## 本卷在全局的位置\n承接上卷。\n")).toBeUndefined();
  });

  test("没登记规范的文档：同样 undefined", () => {
    expect(at("design/wiki/岛屿地图.md", "# 岛屿地图\n\n## 北岸\n礁石。\n")).toBeUndefined();
  });

  test("非卡且读不到内容 → undefined（「（缺）」由索引统一写，不在这里各写一套）", () => {
    expect(at("design/core.md", undefined)).toBeUndefined();
  });
});
