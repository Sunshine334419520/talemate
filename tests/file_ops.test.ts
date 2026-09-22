/**
 * file_ops 的离线测试：四个 op 分别算出什么、以及它们各自的拒绝条件。
 * 运行：bun test
 *
 * 这里断言的是**新内容**，不是"调了哪个函数"——所以底下从 replaceSection 换成模糊匹配时，
 * 这些用例该继续绿。
 */
import { describe, test, expect } from "bun:test";
import { computeNext } from "../src/framework/file_ops";
import type { FileOp } from "../src/core/types";

function next(op: FileOp, current: string | undefined) {
  const r = computeNext(op, current);
  if (!r.ok) throw new Error(`预期成功，却失败了：${r.output}`);
  return r;
}

function rejected(op: FileOp, current: string | undefined) {
  const r = computeNext(op, current);
  if (r.ok) throw new Error("预期失败，却成功了");
  return r.output;
}

describe("file_ops · write", () => {
  test("新建：isNew 为真", () => {
    const r = next({ kind: "write", path: "design/core.md", content: "# core\n" }, undefined);
    expect(r.action).toBe("write");
    if (r.action === "write") {
      expect(r.isNew).toBe(true);
      expect(r.content).toBe("# core\n");
    }
  });

  test("覆盖已存在：isNew 为假，内容整篇换掉", () => {
    const r = next({ kind: "write", path: "design/core.md", content: "新" }, "旧");
    if (r.action === "write") {
      expect(r.isNew).toBe(false);
      expect(r.content).toBe("新");
    }
  });
});

describe("file_ops · replace", () => {
  test("命中：只有那一段变，其余字节原样", () => {
    const current = "## 第一节\n旧的\n\n## 第二节\n不动\n";
    const r = next({ kind: "replace", path: "design/core.md", find: "旧的", replace: "新的" }, current);
    if (r.action === "write") {
      expect(r.content).toBe("## 第一节\n新的\n\n## 第二节\n不动\n");
      expect(r.match).toBe("exact");
      expect(r.count).toBe(1);
    }
  });

  test("文件不存在 → 拒绝，并指向 write", () => {
    const out = rejected({ kind: "replace", path: "design/core.md", find: "a", replace: "b" }, undefined);
    expect(out).toContain("write");
  });

  test("找不到 → 拒绝文案来自匹配层（不是这里另编一句）", () => {
    const out = rejected({ kind: "replace", path: "design/core.md", find: "没有这句", replace: "x" }, "有的别的\n");
    expect(out).toContain("找不到");
  });
});

describe("file_ops · append", () => {
  test("追加到末尾：原有内容保留，块前空一行、文件以换行收尾", () => {
    const r = next({ kind: "append", path: "design/wiki/world.md", block: "## 术语表\n（待定）" }, "## 空间与舞台\n一座荒岛。\n");
    if (r.action === "write") {
      expect(r.content).toBe("## 空间与舞台\n一座荒岛。\n\n## 术语表\n（待定）\n");
    }
  });

  test("文档不存在 → 拒绝（追加只能加到已存在的文档上）", () => {
    const out = rejected({ kind: "append", path: "design/wiki/world.md", block: "x" }, undefined);
    expect(out).toContain("已存在");
  });

  test("空块 → 拒绝", () => {
    expect(rejected({ kind: "append", path: "design/wiki/world.md", block: "   \n  " }, "已有\n")).toContain("空");
  });
});

describe("file_ops · delete", () => {
  test("存在 → 产出 remove 动作", () => {
    expect(next({ kind: "delete", path: "design/characters/林晚.md" }, "卡的字节").action).toBe("remove");
  });

  test("不存在 → 拒绝（不静默当成功）", () => {
    expect(rejected({ kind: "delete", path: "design/characters/林晚.md" }, undefined)).toContain("无法删除");
  });
});
