/**
 * 提问卡的布局不变量（静态检查）。
 *
 * 真正的像素验收靠原型/无头浏览器截图；这里只钉住最容易在一次样式重构里被删掉的三条：
 * 卡片限高、正文内部滚动、头尾固定。少了任何一条，长问题就会把按钮推出屏幕。
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const CSS = join(import.meta.dir, "..", "desktop", "src", "renderer", "styles.css");

function rule(css: string, selector: string): string {
  const marker = `${selector} {`;
  const start = css.indexOf(marker);
  if (start < 0) return "";
  const end = css.indexOf("}", start);
  return end < 0 ? "" : css.slice(start, end + 1);
}

describe("提问卡 · 布局不变量", () => {
  test("卡片限高、正文内部滚动、头尾固定", async () => {
    const css = await readFile(CSS, "utf8");
    const checks: [string, string, string][] = [
      [".ask-sheet", "max-height", "卡片必须限高"],
      [".ask-sheet", "overflow: hidden", "卡片自己裁切，避免圆角外溢"],
      [".ask-body", "overflow-y: auto", "长问题在正文区内部滚动"],
      [".ask-body", "min-height: 0", "flex 子项允许收缩，滚动才会生效"],
      [".ask-sheet-head", "flex: none", "标题不能被正文挤走"],
      [".ask-sheet-foot", "flex: none", "翻页器与提交按钮不能被正文挤走"],
      [".ask-history", "width: 100%", "回看卡占满对话列，不 shrink-to-fit"],
      [".ask-history-body", "max-height", "回看卡正文限高"],
      [".ask-history-body", "overflow-y: auto", "回看卡正文内部滚动"],
      [".confirm-sheet", "max-height", "审批卡也要限高"],
    ];
    const missing: string[] = [];
    for (const [selector, needle, why] of checks) {
      const block = rule(css, selector);
      if (block === "") missing.push(`${selector} 规则不存在（${why}）`);
      else if (!block.includes(needle)) missing.push(`${selector} 缺少 ${needle}（${why}）`);
    }
    expect(missing).toEqual([]);
  });

  test("底部弹窗、提示条、选项与只读卡的关键类都还在", async () => {
    const css = await readFile(CSS, "utf8");
    const selectors = [
      ".askdock",
      ".ask-sheet",
      ".ask-opt",
      ".ask-custom",
      ".ask-actions",
      ".ask-pill",
      ".ask-history",
      ".ask-history-head",
      ".confirm-sheet",
      ".ask-btn.zhu",
    ];
    const missing = selectors.filter((s) => !css.includes(`${s} {`));
    expect(missing).toEqual([]);
  });
});
