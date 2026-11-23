/**
 * invariants 的离线测试：目前只剩“重名小节”一条；角色卡的形状不变量已删除。
 * 运行：bun test
 *
 * 这一层是纯函数（`before` / `after` 两份文本进，错误文案出），所以不用起临时目录。
 * 「不该拦」那几条和「该拦」同样要紧——不变量拦错了比不拦更糟：模型会卡在一个它没法理解的红灯前。
 */
import { describe, test, expect } from "bun:test";
import { checkInvariants, type InvariantInput } from "../src/framework/invariants";

function check(over: Partial<InvariantInput>): string | undefined {
  return checkInvariants({
    path: "design/wiki/world.md",
    opKind: "write",
    before: undefined,
    after: "",
    ...over,
  });
}

describe("invariants · 重名小节（design/*）", () => {
  test("新造出一个重名 → 拒，并说清为什么（按标题寻址会失效）", () => {
    const out = check({
      before: "# X\n\n## 甲\n一\n\n## 乙\n二\n",
      after: "# X\n\n## 甲\n一\n\n## 乙\n二\n\n## 甲\n三\n",
    });
    expect(out).toContain("已经有了小节「甲」");
    expect(out).toContain("寻址");
  });

  test("原本就重名的老文档，一次无关改动不拦——那不是这次造成的", () => {
    const dup = "# X\n\n## 甲\n一\n\n## 甲\n二\n";
    expect(check({ before: dup, after: "# X\n\n## 甲\n一改\n\n## 甲\n二\n" })).toBeUndefined();
  });

  test("把重名改掉（删掉一个）不拦", () => {
    expect(
      check({ before: "# X\n\n## 甲\n一\n\n## 甲\n二\n", after: "# X\n\n## 甲\n一\n" }),
    ).toBeUndefined();
  });

  test("**不管 chapters/**——散文里出现同名标题无害，那里没有按标题寻址", () => {
    expect(check({ path: "chapters/ch1.md", before: "## 甲\n", after: "## 甲\n\n## 甲\n" })).toBeUndefined();
  });

  test("三级标题同样算（`### 回响` 加两次也是重名）", () => {
    expect(check({ before: "### 回响\n一\n", after: "### 回响\n一\n\n### 回响\n二\n" })).toContain("回响");
  });
});

describe("invariants · 角色卡不再有形状守卫", () => {
  const CARD = "design/characters/林晚.md";

  test("卡上出现 `##` 不再被拒——审阅是整篇/diff，不依赖 `###` 分格", () => {
    expect(check({ path: CARD, after: "# 角色：林晚\n\n## 基本档案\n来历不明。\n" })).toBeUndefined();
  });

  test("整篇写缺任何“必有格”都不拦——卡没有必填格", () => {
    const thin = "# 角色：林晚\n\n码头搬运工，话少。\n";
    expect(check({ path: CARD, after: thin })).toBeUndefined();
  });

  test("删掉一整段也不拦；删掉整张卡当然也不拦", () => {
    const full = "# 角色：林晚\n\n### 基本档案\n姓名：林晚\n\n### 说话方式\n短句。\n";
    expect(check({ path: CARD, opKind: "replace", before: full, after: "# 角色：林晚\n\n短句。\n" })).toBeUndefined();
    expect(check({ path: CARD, opKind: "delete", before: full, after: "" })).toBeUndefined();
  });

  test("重名标题仍然拦——这是寻址需要，不是创作形状", () => {
    expect(
      check({
        path: CARD,
        before: "# 角色：林晚\n\n### 回响\n一\n",
        after: "# 角色：林晚\n\n### 回响\n一\n\n### 回响\n二\n",
      }),
    ).toContain("回响");
  });
});

describe("invariants · 管辖范围", () => {
  test("非角色卡的文档同样只受重名标题约束", () => {
    expect(check({ path: "design/wiki/world.md", after: "整段散文，没有标题。" })).toBeUndefined();
  });
  test("不在 design/ 下的文档不归它管", () => {
    expect(check({ path: "chapters/ch1.md", before: "## 甲\n", after: "## 甲\n\n## 甲\n" })).toBeUndefined();
  });
});
