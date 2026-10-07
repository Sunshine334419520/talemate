/**
 * token 数的显示格式。**窗口大小那张表不在这里**——它在 `src/core/windows.ts`（harness 那边），
 * 因为压缩按它算触发点、界面按它显示占比，两处必须是同一张表。
 */
export function tokens(n: number): string {
  // 到百万就换单位：`8.4K / 1000K` 这种读起来要在脑子里再除一次——**单位该跟着量级走**
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1000) return `${trim(n / 1000)}K`;
  return String(n);
}

/** 单位内的数字：十以下留一位小数（8.4K），以上取整（128K）——**别给不存在的精度**。 */
function trim(v: number): string {
  return v < 10 ? v.toFixed(1).replace(/\.0$/, "") : String(Math.round(v));
}
