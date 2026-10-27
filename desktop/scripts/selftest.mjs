/**
 * 跨平台自检入口。package.json 里原来的 `TALEMATE_HOME=${TMPDIR:-/tmp}` 只在 POSIX shell 成立，
 * Windows 的 cmd/PowerShell 会把整串当字面量，桌面端自检根本起不来。这里统一用 Node 的 tmpdir。
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mode = process.argv[2] === "window" ? "window" : "1";
const child = spawn(process.execPath, ["desktop/scripts/launch-electron.mjs"], {
  stdio: "inherit",
  env: {
    ...process.env,
    TALEMATE_HOME: join(tmpdir(), "talemate-selftest"),
    TALEMATE_RESOURCES: process.cwd(),
    TALEMATE_PROVIDER: "mock",
    ...(mode === "1" ? { TALEMATE_MOCK_TOOL: "task" } : {}),
    TALEMATE_DESKTOP_SELFTEST: mode,
  },
});
child.on("error", (err) => {
  console.error(`[selftest] 起不来：${err.message}`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
