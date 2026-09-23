/**
 * 规范注册表的守卫：`tests/` 里的一条"结构不变量"测试（其余多是行为测试）。
 *
 * 守三件事：
 *   1. **胜负由模式长度定，与表序无关。** `permission.match` 把 `*` 映射成 `.*`、**跨 `/`**，
 *      所以 `design/outline/vol_*.md` 也命中 `design/outline/vol_1/s2.md`。若取规范靠"第一个
 *      命中即止"，一卷的序列纲就会被静默读成卷纲。这里对**每一条**规范回头查一次：拿它自己的
 *      target 去问注册表，答的必须是它自己。
 *   2. **同一份事实只有一个家。** 这一层从前横跨两个文件（短名在 `layers.ts` 的 `LAYERS`、
 *      长名在 `design_spec.ts` 的 `DESIGN_SPECS`），再靠一个测试钉住两边不脱节；现在两个名字
 *      并排放在同一行（`DocSpec.label` / `DocSpec.title`），那份跨文件的对应关系不存在了。
 *   3. **工作法不许漏写工具的前置。** 它是每层手抄一份的散文，漏写不会报错，只会让模型读到一份
 *      自相矛盾的规范——比没有更糟。见文末「规范注册表 · 工作法」。
 */
import { describe, test, expect } from "bun:test";
import { RESIDENT_DOCS } from "../src/framework/anchor";
import { CARD_DIR } from "../src/framework/characters";
import { SPECS, type DocSpec, specFor } from "../src/framework/design_spec";
import { match } from "../src/permission";

/** 把 target 里的占位换成具体路径——于是它能当一条"将来真的会出现"的路径用。 */
function concrete(target: string): string {
  return target.replace("<名>", "林晚").replace("<序号>", "2").replace("<N>", "1");
}

/** 目录入口：match 以 `/` 结尾的行（它不是一个文件）。 */
const containers = SPECS.filter((s) => s.match.endsWith("/"));
const files = SPECS.filter((s) => !s.match.endsWith("/"));

describe("规范注册表 · 结构", () => {
  test("每条**文件**规范都给了 target，且 target 落在自己的 match 范围内", () => {
    const bad = files
      .filter((s) => s.target === undefined || !match(concrete(s.target), s.match))
      .map((s) => `${s.id}: target=${s.target ?? "(缺)"} match=${s.match}`);
    expect(bad).toEqual([]);
  });

  test("目录入口**没有** target——它不是一个文件，不该有写入口", () => {
    const bad = containers.filter((s) => s.target !== undefined).map((s) => s.id);
    expect(bad).toEqual([]);
    expect(containers.length).toBeGreaterThan(0); // 目录读空了别静默通过
  });

  test("**更具体的模式胜出**：拿每条规范自己的 target 去查，答的必须是它自己", () => {
    // 这一条就是那张 `*` 跨 `/` 的表唯一会静默出错的地方。
    const wrong = files
      .filter((s) => specFor(concrete(s.target as string))?.id !== s.id)
      .map((s) => `${concrete(s.target as string)} → 命中了 ${specFor(concrete(s.target as string))?.id}，应为 ${s.id}`);
    expect(wrong).toEqual([]);
  });

  test("胜负由**模式长度**定，与表序无关", () => {
    const vol = SPECS.find((s) => s.id === "outline-vol");
    const seq = SPECS.find((s) => s.id === "outline-seq");
    expect(vol).toBeDefined();
    expect(seq).toBeDefined();
    const v = vol as DocSpec;
    const s = seq as DocSpec;

    // 前提：两条模式确实一长一短，长度分得开它们
    expect(s.match.length).toBeGreaterThan(v.match.length);
    // **全场关键**：宽的那条（卷纲）也命中序列纲的路径。若取规范靠"第一个命中即止"，
    // 结果就取决于谁排在表前面——这里证明它靠的是长度，表序怎么排都不影响。
    expect(match("design/outline/vol_2/s3.md", v.match)).toBe(true);
    expect(specFor("design/outline/vol_2.md")?.id).toBe("outline-vol");
    expect(specFor("design/outline/vol_2/s3.md")?.id).toBe("outline-seq");
  });
});

describe("规范注册表 · 管辖范围", () => {
  test("没登记的路径给 undefined——专题页、章计划都按自由形状成稿", () => {
    const open = ["design/wiki/岛屿地图.md", "design/outline/plan_ch1.md", "chapters/chapter_ch1_v1.md"];
    expect(open.filter((p) => specFor(p) !== undefined)).toEqual([]);
  });

  test("不分格的文档是真的不分格（角色卡、序列纲）——`sections` 空是刻意的，不是漏登记", () => {
    expect(specFor(`${CARD_DIR}林晚.md`)?.sections).toEqual([]);
    expect(specFor("design/outline/vol_2/s3.md")?.sections).toEqual([]);
    // 反之，有格的文档确实有格
    expect(specFor("design/core.md")?.sections.length).toBeGreaterThan(0);
    expect(specFor("design/wiki/world.md")?.sections.length).toBeGreaterThan(0);
    expect(specFor("design/outline/vol_2.md")?.sections.length).toBeGreaterThan(0);
  });

  test("常驻注入的两条路径都登记了规范——否则状态卡问不出「还差哪几格」", () => {
    const bad = RESIDENT_DOCS.filter((p) => specFor(p) === undefined);
    expect(bad).toEqual([]);
  });

  test("层的长短名不会各说各话：有 label 的规范，label 与 title 都在同一行上", () => {
    // 从前短名在 layers.ts、长名在 design_spec.ts，靠一个测试钉住"两边不脱节"。
    // 现在没有两个文件可脱节——这条只确认那两层确实带了用户看的短名。
    const labelled = SPECS.filter((s) => s.label !== undefined).map((s) => s.id);
    expect(labelled).toEqual(["core", "world"]);
  });

  test("四条目录入口都在——`design-spec` 靠它们一次拿全一层的文档种类", () => {
    // 曾经还有一个 `layer` 参数（`core | world | …`）当"少拼一次路径"的糖；路径口径统一之后
    // 它连同一张别名表一起删了：糖能表达的路径本来就能表达，而它多带一套词表。
    const want = ["design/core.md", "design/wiki/world.md", "design/characters/", "design/outline/"];
    const missing = want.filter((p) => !SPECS.some((s) => s.match === p || s.match === `${p}*`));
    expect(missing).toEqual([]);
  });
});

describe("规范注册表 · 工作法", () => {
  test("工作法里提到 propose-design 的，必须同时写明它要先在草稿模式里", () => {
    // 工作法每层手抄一份，措辞各异——所以漏写半句在 diff 里看不出来。漏写的后果不是报错，而是
    // 模型从规范里**合理地**推出 propose-design 不需要草稿模式，跳过 enter-draft 直接提案、被工具拒。
    // 自相矛盾的规范比没有规范更糟，所以这一条钉住"提到它就得写出它的前置"。
    const missing = SPECS.filter((s) => s.guide.includes("propose-design"))
      .filter((s) => !s.guide.includes("草稿模式"))
      .map((s) => s.id);
    expect(missing).toEqual([]);
  });
});
