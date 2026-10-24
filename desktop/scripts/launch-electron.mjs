/**
 * 启动桌面壳的唯一入口：先清掉 `ELECTRON_RUN_AS_NODE`，再拉起 Electron。
 *
 * 为什么需要这一层：从 Electron 系终端（VS Code 的扩展宿主、DeepSeek Harness 等）里跑
 * `bun run desktop` 时，父进程会把 `ELECTRON_RUN_AS_NODE=1` 一起带进来。Electron 二进制看到它
 * 就以**纯 Node** 运行，`require("electron")` 返回的是可执行文件路径而不是 API 对象——症状是
 * 主进程一进 `prelude.ts` 就报 `Cannot read properties of undefined (reading 'isPackaged')`，
 * 而构建那一步完全正常，看起来像代码坏了。
 *
 * 这个变量必须在**派生子进程之前**删掉，不能只在自己进程里改：Electron 继承的是 spawn 时的环境。
 * 与它同源的另一处是 `desktop/electron.vite.config.ts`（dev 模式由 electron-vite 自己派生 Electron，
 * 走不到这里）。
 *
 * 用法：`bun desktop/scripts/launch-electron.mjs [electron 参数…]`，默认打开仓库里的 `desktop/`；
 * 参数原样透传，子进程的退出码原样返回。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const appDir = join(repo, "desktop");

if (!existsSync(electronPath)) {
  console.error(
    "[launch-electron] Electron 二进制不在。先跑 `bun run desktop:setup`，或重新 `bun install`。",
  );
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = process.argv.length > 2 ? process.argv.slice(2) : [appDir];
const child = spawn(electronPath, args, { stdio: "inherit", env });

child.on("error", (err) => {
  console.error(`[launch-electron] 起不来：${err.message}`);
  process.exit(1);
});

// macOS/Linux 上 Ctrl-C 会同时发给父子；这里只负责把子进程的结局如实转成自己的退出码。
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
