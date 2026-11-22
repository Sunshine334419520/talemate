/**
 * 模型的上下文窗口——唯一一张表。
 *
 * 两个地方要用它，所以它在这一层（`core/`）：折叠按它算预算（`context/budget.ts`），
 * 界面按它显示占比（`desktop/`）。写在两处必然分叉——界面上写着"还剩 30%"，折叠却已经动手了。
 *
 * 这是一张人工维护的表，不是问出来的：除了 Anthropic 能查 Models API，别家没有统一的查询口，
 * 所以它一定会过期。两条规矩：认不出的模型给保守的默认值（宁可报小：低估让人早点收拾上下文，
 * 高估让人撞墙）；界面上显示时永远带"约"。
 */
const WINDOWS: readonly [RegExp, number][] = [
  [/deepseek/i, 1_000_000],
  [/claude-(opus|sonnet|fable|mythos)/i, 1_000_000],
  [/claude-haiku/i, 200_000],
  [/gpt-4o|gpt-5/i, 128_000],
];

export const DEFAULT_WINDOW = 128_000;

export function contextWindow(model: string): number {
  for (const [re, size] of WINDOWS) if (re.test(model)) return size;
  return DEFAULT_WINDOW;
}
