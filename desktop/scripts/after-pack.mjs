/**
 * macOS 本地构建的兜底签名：electron-builder 找不到 Developer ID 时不会签整个 bundle，
 * Electron 二进制自带的是 linker ad-hoc 签名，Gatekeeper 会报“code has no resources”。
 * 没有配置真实签名时，这里对 .app 做一次 ad-hoc 深度签名，让 bundle 至少是完整签名。
 *
 * 配置了 CSC_LINK / CSC_NAME 时跳过，交给 electron-builder 的正式签名。
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export default async function afterPack(context) {
  if (process.platform !== "darwin") return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
}
