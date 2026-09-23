/**
 * invariants 的离线测试：四条不变量各自的判据，以及它们**不该**拦的那些。
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

describe("invariants · 角色卡三条（design/characters/*.md）", () => {
  const CARD = "design/characters/林晚.md";
  const full = "# 角色：林晚\n\n### 基本档案\n姓名：林晚\n\n### 说话方式\n短句。\n";

  test("卡上出现 `##` → 拒（不管哪条路写的）", () => {
    expect(check({ path: CARD, after: "# 角色：林晚\n\n## 基本档案\n来历不明。\n" })).toContain("一律用 `###`");
  });

  test("整篇写缺必有格 → 拒；**局部改不要求凑齐**（它本来就不带标题）", () => {
    const thin = "# 角色：林晚\n\n### 基本档案\n姓名：林晚\n";
    expect(check({ path: CARD, after: thin })).toContain("缺这几格");
    // 局部改：标题集合原样（本来就缺），只改正文 —— 两条都不该拦
    expect(
      check({ path: CARD, opKind: "replace", before: thin, after: "# 角色：林晚\n\n### 基本档案\n姓名：林晚之\n" }),
    ).toBeUndefined();
  });

  test("必有格整格消失 → 拒；**删掉整张卡不算**（那时它不再是卡了）", () => {
    const without = "# 角色：林晚\n\n### 基本档案\n姓名：林晚\n";
    expect(check({ path: CARD, opKind: "replace", before: full, after: without })).toContain("必有格");
    expect(check({ path: CARD, opKind: "delete", before: full, after: "" })).toBeUndefined();
  });

  test("新建的卡没有'丢掉'可言——缺格由骨架那条管，不由这条管", () => {
    expect(check({ path: CARD, before: undefined, after: "# 角色：林晚\n" })).toContain("缺这几格");
  });
});

describe("invariants · 管辖范围", () => {
  test("非角色卡的文档不受那三条管", () => {
    expect(check({ path: "design/wiki/world.md", after: "整段散文，没有标题。" })).toBeUndefined();
  });

  test("多条都违反时只报第一条（一次给一个能改的）", () => {
    // 既有 `##`、又缺格：报的是 `##` 那条（它在数组里靠前）
    const out = check({ path: "design/characters/林晚.md", after: "# 角色：林晚\n\n## 基本档案\nx\n" });
    expect(out).toContain("一律用 `###`");
  });
});
