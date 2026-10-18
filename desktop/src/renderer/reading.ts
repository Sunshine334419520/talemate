/**
 * 阅读字号：对话与文件内容共用一个 CSS 变量。
 *
 * 设置页改的是这一格；界面其余部分（左栏、按钮、状态栏）不跟着缩放——它们是工具，不是稿件。
 */

export const DEFAULT_READING_SIZE = 14;
export const MIN_READING_SIZE = 12;
export const MAX_READING_SIZE = 20;

export function clampReadingSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_READING_SIZE;
  return Math.min(MAX_READING_SIZE, Math.max(MIN_READING_SIZE, Math.round(size)));
}

export function applyReadingSize(size: number): void {
  document.documentElement.style.setProperty("--reading-size", `${clampReadingSize(size)}px`);
}
