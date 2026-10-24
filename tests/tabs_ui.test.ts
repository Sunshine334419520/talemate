/**
 * 「对话 / 轨迹」的布局守卫：它是一条独占一行、左对齐、下划线指示当前页的标签栏，
 * 不是标题栏里的胶囊分段控件。jsdom 没有布局，所以这里守的是结构 + 那几条关键样式。
 */
import { describe, test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("对话 / 轨迹 · 标签栏布局", () => {
  test("标题行与标签行分开，标签是 tablist", async () => {
    const ws = await readFile(join(ROOT, "desktop/src/renderer/Workspace.tsx"), "utf8");
    expect(ws).toContain('<div className="head-row">');
    expect(ws).toContain('<div className="viewtabs" role="tablist"');
    expect(ws).toContain('aria-selected={view === "chat"}');
    expect(ws).toContain('aria-selected={view === "trace"}');
  });

  test("当前页用下划线标出，标签行不是拖拽区", async () => {
    const css = await readFile(join(ROOT, "desktop/src/renderer/styles.css"), "utf8");
    expect(css).toContain('.main .head .viewtab[aria-selected="true"]::after');
    expect(css).toContain("bottom: -1px");
    // 标签点不动通常就是被标题栏的 drag 区吃了
    expect(css).toMatch(/\.main \.head \.viewtabs \{[^}]*-webkit-app-region:\s*no-drag/);
  });
});
