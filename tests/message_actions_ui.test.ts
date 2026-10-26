/**
 * 复制 / 回退 / 回到底部的布局守卫：按钮在对话区里，不在输入框上；每条消息有操作行。
 * jsdom 没有布局，所以守的是结构 + 关键样式。
 */
import { describe, test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("消息操作 · 复制 / 回退", () => {
  test("每条用户气泡与助手正文都有 MessageActions，复制走 clipboard", async () => {
    const thread = await readFile(join(ROOT, "desktop/src/renderer/Thread.tsx"), "utf8");
    expect(thread).toContain("function MessageActions");
    expect(thread).toContain("navigator.clipboard.writeText");
    expect(thread).toContain('aria-label={copied ? "已复制" : "复制"}');
    expect(thread).toContain("<CopyIcon");
    expect(thread).toContain("<UndoIcon");
    expect(thread).toContain("<MessageActions");
  });

  test("回退目标只能是已落盘的用户消息（有 seq 才渲染按钮）", async () => {
    const thread = await readFile(join(ROOT, "desktop/src/renderer/Thread.tsx"), "utf8");
    expect(thread).toContain("seq !== undefined && onRewind !== undefined");
    expect(thread).toMatch(/kind: "me"; text: string; seq\?: number/);
  });

  test("回退确认框自己画：给出仅对话 / 连文件两种模式", async () => {
    const ws = await readFile(join(ROOT, "desktop/src/renderer/Workspace.tsx"), "utf8");
    const css = await readFile(join(ROOT, "desktop/src/renderer/styles.css"), "utf8");
    expect(ws).toContain('className="rewind-dialog"');
    expect(ws).toContain("仅回退对话");
    expect(ws).toContain("回退并还原");
    expect(css).toContain(".rewind-mask");
  });

  test("手动发消息无条件恢复跟随并回到底部", async () => {
    const ws = await readFile(join(ROOT, "desktop/src/renderer/Workspace.tsx"), "utf8");
    const start = ws.indexOf("const say = useCallback");
    const end = ws.indexOf("}, []);", start);
    expect(start).toBeGreaterThan(-1);
    const block = ws.slice(start, end);
    expect(block).toContain("pinnedRef.current = true");
    expect(block).toContain("setAtBottom(true)");
    expect(block).toContain("setLive");
  });

  test("回到底部按钮在对话区底边，不压输入框", async () => {
    const ws = await readFile(join(ROOT, "desktop/src/renderer/Workspace.tsx"), "utf8");
    const css = await readFile(join(ROOT, "desktop/src/renderer/styles.css"), "utf8");
    expect(ws).toContain('<div className="conversation">');
    expect(css).toContain(".conversation {");
    expect(css).toMatch(/\.jump-bottom \{[^}]*bottom:\s*12px/);
    expect(css).not.toMatch(/\.jump-bottom \{[^}]*bottom:\s*86px/);
  });
});
