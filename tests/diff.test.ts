/**
 * diff 的离线测试：行级编辑脚本、统计、渲染时的上下文折叠。
 * 运行：bun test
 *
 * 这一层的产物是**给人看的材料**（落盘前的确认弹窗），所以既测"改了什么"，
 * 也测"渲染出来读不读得懂"——只把改动行列出来而不留上下文，人看不懂改在哪。
 */
import { describe, test, expect } from "bun:test";
import { diffLines, renderDiff, type DiffLine } from "../src/framework/diff";

const text = (...ls: string[]) => ls.join("\n") + "\n";

/** 行**自带换行符**（见 diff.ts 的 splitLines）。断言内容时脱掉它，读起来才像在说人话；
 *  "换行符本身参与比对"这件事由下面那条专门的用例钉着。 */
const bare = (ls: DiffLine[]) => ls.map((l) => l.text.replace(/\n$/, ""));

describe("diff · 编辑脚本", () => {
  test("一字未动 → 全是 ctx，统计为 0", () => {
    const r = diffLines(text("甲", "乙"), text("甲", "乙"));
    expect(r.lines.every((l) => l.kind === "ctx")).toBe(true);
    expect([r.additions, r.deletions]).toEqual([0, 0]);
  });

  test("改一行：只那一行是 del+add，前后行仍是 ctx", () => {
    const r = diffLines(text("甲", "乙", "丙"), text("甲", "乙改了", "丙"));
    expect(r.additions).toBe(1);
    expect(r.deletions).toBe(1);
    expect(bare(r.lines.filter((l) => l.kind === "ctx"))).toEqual(["甲", "丙"]);
  });

  test("中间插一行：只报一处 add，后面的行号跟着挪（不做朴素逐行比对）", () => {
    // 朴素实现会把插入点之后的每一行都报成"改了"——那正是要避免的噪音。
    const r = diffLines(text("甲", "乙", "丙"), text("甲", "插的", "乙", "丙"));
    expect(r.additions).toBe(1);
    expect(r.deletions).toBe(0);
    expect(bare(r.lines.filter((l) => l.kind === "add"))).toEqual(["插的"]);
  });

  test("删一行：只报一处 del", () => {
    const r = diffLines(text("甲", "乙", "丙"), text("甲", "丙"));
    expect(r.deletions).toBe(1);
    expect(r.additions).toBe(0);
  });

  test("行号按原文算（1 基），且 add 只有新号、del 只有旧号", () => {
    const r = diffLines(text("甲", "乙"), text("甲", "新乙"));
    const del = r.lines.find((l) => l.kind === "del");
    const add = r.lines.find((l) => l.kind === "add");
    expect([del?.oldNo, del?.newNo]).toEqual([2, undefined]);
    expect([add?.oldNo, add?.newNo]).toEqual([undefined, 2]);
  });

  test("整篇重写：全 del + 全 add，不炸", () => {
    const r = diffLines(text("甲", "乙"), text("丙", "丁"));
    expect([r.additions, r.deletions]).toEqual([2, 2]);
  });

  test("末尾少一个换行 → 算作一行之差，不被静默吞掉", () => {
    // 行携带换行符的模型下，最后一行是 "乙" 与 "乙\n" —— 真的不同。split("\n") 会把它抹平。
    const r = diffLines("甲\n乙", "甲\n乙\n");
    expect([r.additions, r.deletions]).toEqual([1, 1]);
  });

  test("末尾带换行的文本不产生幽灵尾行", () => {
    // split("\n") 会让 "甲\n" 多出一行 ""，于是每一份 diff 末尾都挂一行莫名其妙的上下文。
    const r = diffLines(text("甲", "乙"), text("甲", "乙"));
    expect(r.lines.map((l) => l.text)).toEqual(["甲\n", "乙\n"]);
  });
});

describe("diff · 渲染", () => {
  test("改动行的上下留 context 行，改动行本身带 +/- 前缀", () => {
    const r = diffLines(text("一", "二", "三", "四", "五", "六", "七"), text("一", "二", "三", "改", "五", "六", "七"));
    const out = renderDiff(r, 1);
    expect(out).toContain("-四");
    expect(out).toContain("+改");
    expect(out).toContain(" 三"); // 上一行作为上下文
    expect(out).toContain(" 五"); // 下一行作为上下文
    expect(out).not.toContain("一"); // 离得远的行被折叠掉
  });

  test("相隔很远的改动之间用「跳过 N 行」标出来（免得看成连着的一处）", () => {
    const before = text("头", ...Array.from({ length: 12 }, (_, i) => `中${i}`), "尾");
    const after = text("头改了", ...Array.from({ length: 12 }, (_, i) => `中${i}`), "尾改了");
    // 两处改动各占 2 行（del+add），各留 1 行上下文 → 中间 12 行只被留了头尾 2 行
    const out = renderDiff(diffLines(before, after), 1);
    expect(out).toContain("跳过 10 行");
  });

  test("没有改动时不铺一屏上下文，直接说无改动", () => {
    expect(renderDiff(diffLines(text("甲"), text("甲")))).toBe("（无改动）");
  });
});
