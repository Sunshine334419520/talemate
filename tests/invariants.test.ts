/**
 * invariants 的离线测试：重名小节这条不变量该拦什么、**不该**拦什么。
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

describe("invariants · 管辖范围", () => {
  test("整段散文、没有标题的文档不受这条管", () => {
    expect(check({ path: "design/wiki/world.md", after: "整段散文，没有标题。" })).toBeUndefined();
  });

  test("角色卡同样只受重名这一条管——骨架是建议，不是通行证", () => {
    expect(check({ path: "design/characters/林晚.md", after: "# 角色：林晚\n" })).toBeUndefined();
  });
});
