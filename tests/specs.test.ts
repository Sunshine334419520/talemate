/**
 * 设计指南注册表的守卫：路径匹配、管辖范围、每份指南的完整性。
 *
 * 与旧的 `design_spec` 不同：指南没有必填小节，也不做形状校验。这里只守“有指南、匹配对、
 * 问题与反例都在”，不守“必须有哪几格”。
 */
import { describe, test, expect } from "bun:test";
import { RESIDENT_DOCS } from "../src/framework/anchor";
import { CARD_DIR } from "../src/framework/characters";
import { GUIDES, guideFor, renderGuide } from "../src/framework/design_guides";
import { match } from "../src/permission";

function concrete(target: string): string {
  return target.replace("<名>", "林晚").replace("<序号>", "2").replace("<N>", "1").replace("<M>", "1");
}

const containers = GUIDES.filter((g) => g.match.endsWith("/"));
const files = GUIDES.filter((g) => !g.match.endsWith("/"));

describe("设计指南 · 匹配", () => {
  test("每条文件指南都给了 target，且 target 落在自己的 match 范围内", () => {
    const bad = files
      .filter((g) => g.target === undefined || !match(concrete(g.target), g.match))
      .map((g) => `${g.id}: target=${g.target ?? "(缺)"} match=${g.match}`);
    expect(bad).toEqual([]);
  });

  test("目录入口没有 target——它不是一个文件", () => {
    const bad = containers.filter((g) => g.target !== undefined).map((g) => g.id);
    expect(bad).toEqual([]);
    expect(containers.length).toBeGreaterThan(0);
  });

  test("更具体的模式胜出：拿自己的 target 去查，答的必须是自己", () => {
    const wrong = files
      .filter((g) => guideFor(concrete(g.target as string))?.id !== g.id)
      .map((g) => `${concrete(g.target as string)} → 命中了 ${guideFor(concrete(g.target as string))?.id}，应为 ${g.id}`);
    expect(wrong).toEqual([]);
  });

  test("卷纲的模式也命中序列纲的路径，靠长度分开，不靠表序", () => {
    const vol = GUIDES.find((g) => g.id === "outline-vol");
    const seq = GUIDES.find((g) => g.id === "outline-seq");
    expect(vol).toBeDefined();
    expect(seq).toBeDefined();
    expect((seq as { match: string }).match.length).toBeGreaterThan((vol as { match: string }).match.length);
    expect(match("design/outline/vol_2/s3.md", (vol as { match: string }).match)).toBe(true);
    expect(guideFor("design/outline/vol_2.md")?.id).toBe("outline-vol");
    expect(guideFor("design/outline/vol_2/s3.md")?.id).toBe("outline-seq");
  });
});

describe("设计指南 · 管辖范围", () => {
  test("没登记的路径给 undefined——专题页按自由形状成稿", () => {
    expect(guideFor("design/wiki/岛屿地图.md")).toBeUndefined();
    expect(guideFor("chapters/chapter_ch1_v1.md")).toBeUndefined();
  });

  test("常驻注入的两条路径都有指南", () => {
    const bad = RESIDENT_DOCS.filter((p) => guideFor(p) === undefined);
    expect(bad).toEqual([]);
  });

  test("四条入口都在：core / world / characters / outline", () => {
    const want = ["design/core.md", "design/wiki/world.md", "design/characters/", "design/outline/"];
    const missing = want.filter((p) => !GUIDES.some((g) => g.match === p || g.match === `${p}*`));
    expect(missing).toEqual([]);
  });

  test("角色卡按目录通配，具体路径也取得到；序列纲同理", () => {
    expect(guideFor(`${CARD_DIR}林晚.md`)?.id).toBe("characters");
    expect(guideFor("design/outline/vol_1/s2.md")?.id).toBe("outline-seq");
  });
});

describe("设计指南 · 内容完整性", () => {
  test("每份指南都有 purpose / questions / antiPatterns / summary", () => {
    const bad = GUIDES.filter(
      (g) =>
        g.purpose.trim() === "" ||
        g.questions.length === 0 ||
        g.antiPatterns.length === 0 ||
        (g.summary !== "headings" && g.summary !== "lead"),
    ).map((g) => g.id);
    expect(bad).toEqual([]);
  });

  test("没有“必填小节”这种字段：指南只给问题，不给 schema", () => {
    const withSections = GUIDES.filter((g) => "sections" in g).map((g) => g.id);
    expect(withSections).toEqual([]);
  });

  test("序列纲的指南覆盖出口状态、承诺、写法约束（机器要问的那些）", () => {
    const text = renderGuide("design/outline/vol_1/s2.md") ?? "";
    for (const need of ["入口 → 出口", "不可逆转折", "承诺", "写法约束", "功能"]) {
      expect(text).toContain(need);
    }
    expect(text).not.toContain("## 本卷的序列");
  });

  test("角色卡指南不再说“必有五格/缺一即拒/只许 ###”", () => {
    const text = renderGuide(`${CARD_DIR}林晚.md`) ?? "";
    expect(text).toContain("想要什么");
    expect(text).toContain("绝不做");
    expect(text).toContain("可验伪");
    expect(text).not.toContain("必有五格");
    expect(text).not.toContain("缺一即拒");
    expect(text).not.toContain("只许 `###`");
  });

  test("卷纲指南不再要求六格；核心层不再要求固定小节", () => {
    const vol = renderGuide("design/outline/vol_1.md") ?? "";
    expect(vol).not.toContain("## 本卷在全局的位置");
    expect(vol).toContain("卷末什么状态");
    const core = renderGuide("design/core.md") ?? "";
    expect(core).not.toContain("## 一句话简介");
    expect(core).toContain("一句话简介");
  });

  test("工作法提到 propose-design 的，都写明要先在草稿模式里", () => {
    const missing = GUIDES.filter((g) => renderGuide(g.target ?? g.match)?.includes("propose-design"))
      .filter((g) => !(renderGuide(g.target ?? g.match) ?? "").includes("草稿模式"))
      .map((g) => g.id);
    expect(missing).toEqual([]);
  });

  test("不再出现已删的工具名", () => {
    const retired = ["add-character", "update-character", "character-brief", "save-chapter", "remove-character"];
    const hits: string[] = [];
    for (const g of GUIDES) {
      const text = renderGuide(g.target ?? g.match) ?? "";
      for (const t of retired) if (text.includes(t)) hits.push(`${g.id} 提到 ${t}`);
    }
    expect(hits).toEqual([]);
  });
});