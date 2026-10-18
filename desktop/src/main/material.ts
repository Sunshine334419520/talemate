/**
 * 侧栏材质判定：macOS 用 vibrancy，Windows 11 22H2+ 用 acrylic，其余退到实色。
 *
 * 这是开窗前的纯决策，主进程与 preload 共用同一个结果（preload 从 additionalArguments 读）。
 * `APP_MATERIAL` 是联调开关：强制 none 验降级，强制 acrylic 验 Windows 材质。
 */
import os from "node:os";
import type { WindowMaterial } from "../shared/api";

export function resolveWindowMaterial(
  platform: NodeJS.Platform = process.platform,
  release: string = os.release(),
): WindowMaterial {
  const forced = process.env.APP_MATERIAL;
  if (forced === "vibrancy" || forced === "acrylic" || forced === "mica" || forced === "none") {
    return forced;
  }
  if (platform === "darwin") return "vibrancy";
  if (platform === "win32") {
    const build = Number(release.split(".")[2] ?? 0);
    return build >= 22621 ? "acrylic" : "none";
  }
  return "none";
}
