/**
 * 三向裁决的两条路：
 *
 * 1. **文本**（CLI / 用户手打）：`draftVerdict` 的整句词表，fail-closed。
 * 2. **结构化**（桌面按钮）：`accept` / `reject` / `refine` 直接发 IPC，**不再**合成
 *    “没问题 / 不行”写进对话历史。
 *
 * 第二条是这次重设计的重点；第一条不能删——CLI 和“用户直接打字回话”仍然靠它。
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { draftVerdict } from "../src/session/session";

const ROOT = join(import.meta.dir, "..");

describe("文本裁决 · CLI / 手打回复", () => {
  test("整句只有接受词才算接受", () => {
    for (const s of ["没问题", "没问题。", "好", "好的", "可以", "同意", "确认", "ok"]) {
      expect(draftVerdict(s)).toBe("accept");
    }
  });

  test("整句只有拒绝词才算拒绝", () => {
    for (const s of ["不行", "不要", "算了", "拒绝"]) {
      expect(draftVerdict(s)).toBe("reject");
    }
  });

  test("带改动要求的话不算同意——fail-closed 那条不变", () => {
    // 「没问题，但第 3 格改成 X」夹着改动要求：不能因为开头是"没问题"就落盘。
    expect(draftVerdict("没问题，但第 3 格改成别的")).toBe("refine");
  });
});

describe("界面按钮 · 结构化裁决", () => {
  test("提案卡直接发 accept / reject / refine，不再引用固定短语", async () => {
    const card = await readFile(join(ROOT, "desktop/src/renderer/ProposalCard.tsx"), "utf8");
    expect(card).toContain('onVerdict("accept")');
    expect(card).toContain('onVerdict("reject")');
    expect(card).toContain('onVerdict("refine", value)');
    expect(card).not.toContain("VERDICT_TEXT");
  });

  test("界面走 resolveProposal IPC，而不是把短语塞回输入框", async () => {
    const ws = await readFile(join(ROOT, "desktop/src/renderer/Workspace.tsx"), "utf8");
    const start = ws.indexOf("const resolveProposal = useCallback");
    const end = ws.indexOf("/**", start + 1);
    expect(start).toBeGreaterThan(-1);
    const block = ws.slice(start, end);
    expect(block).toContain(".resolveProposal(");
    expect(block).not.toContain("window.tm.prompt");
  });
});
