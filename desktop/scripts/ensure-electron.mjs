/**
 * 保证 Electron 的**二进制**在——`bun install` 之后自动跑（根 package.json 的 postinstall）。
 *
 * 为什么需要这么一个脚本：`electron` 这个 npm 包只是个壳，真正的运行时（macOS 约 124MB）由**它自己的**
 * postinstall 从网上下载到 `node_modules/electron/dist`。而 **Bun 不跑依赖的 postinstall**——
 * `bun install --help` 里那句原文是 "dependency scripts are never run"，`trustedDependencies` 与
 * `bun install --trust electron` 实测也都不触发它。于是那个 postinstall 从来没执行过，症状是
 * `electron desktop` 报 `Electron failed to install correctly`——一个跟依赖解析毫不相干的错，
 * 很难往这上面想。项目自己的生命周期脚本 Bun 是跑的，所以补在这里。
 *
 * 已装好时它是空转（0.1 秒）；没装时才下载，走 `.npmrc` 里配的镜像。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const installer = join(repo, "node_modules", "electron", "install.js");

/**
 * 镜像**在脚本里钉死，不指望 .npmrc 传进来**——实测 `bun install` 不会把 `.npmrc` 的键导成
 * `npm_config_*` 给生命周期脚本，于是下载又回去走 GitHub：实测 0.04MB/s，一百多分钟。
 * 这是这台机器上"装依赖卡住"的**唯一**原因，所以宁可在这里写死，也不要再依赖谁替我传环境变量。
 * 换源：给环境变量 `ELECTRON_MIRROR` 即可。
 */
const MIRROR = process.env.ELECTRON_MIRROR ?? "https://npmmirror.com/mirrors/electron/";

// 没装 electron（比如 --production）时静默跳过：这不是错误，仓库的主产物是库。
if (!existsSync(installer)) process.exit(0);

try {
  execFileSync(process.execPath, [installer], {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_MIRROR: MIRROR, npm_config_electron_mirror: MIRROR },
  });
} catch {
  // 下不下来不该让整个 install 失败（离线开发照样能用 CLI 那一半）。报出来，让人自己决定。
  console.error(
    "[ensure-electron] Electron 二进制没下下来。桌面端要用它；网络恢复后重跑：bun run desktop:setup",
  );
  process.exit(0);
}
