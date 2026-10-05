/**
 * 开场白：**进程一起来必须先做的两件事**——读 `.env`、把随包数据的根钉死。
 * 它必须是主进程的第一条 import，顺序就是它的全部机制。
 *
 * **为什么 .env 要自己读**：跑 CLI 时 Bun 会自动加载 `.env`，**Electron 不会**。不读的后果不是报错，
 * 而是**静悄悄按默认值跑**：`TALEMATE_PROVIDER` 缺省 `anthropic`、模型缺省 `claude-opus-5`——
 * 于是你在 `.env` 里配的 DeepSeek 一行都没生效，顶栏还理直气壮地显示着另一个模型的名字。
 * （这一条是真踩过的：查了半天"为什么思考看不到"，方向全被这个假象带偏。）
 *
 * 语义与 Bun / Vite 一致：**已经设了的变量不覆盖**——命令行与脚本（`TALEMATE_PROVIDER=mock …`）优先。
 *
 * 为什么非得单独一个模块：`agent/registry.ts` 在**模块顶层**读提示词（`readPrompt("mate.system")`），
 * 而 ESM 的求值顺序是**先依赖后自己**。所以 `setResourceRoot(...)` 写在同一文件里、哪怕写在最上面，
 * 也永远晚一步——症状是打包后启动即 `ENOENT … /T/prompts/mate.system.txt`，一个跟路径有关的错，
 * 但根源在求值顺序。而 ESM 保证同一份 import 声明列表里靠前的先求值，所以把它拆成独立模块、
 * 放在第一行，是这条约束唯一的表达方式。（实测：`desktop:probe` 的第 4 步就是拿这个当判据。）
 *
 * 打包后是 `process.resourcesPath`；开发时是仓库根（脚本给 `TALEMATE_RESOURCES`，或从 app 路径往上推）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import { setResourceRoot } from "../../../src/core/config";

/** 开发时 `.env` 与随包数据同根；打包后在同目录（构建时一起发出去）。 */
const RESOURCES = app.isPackaged
  ? process.resourcesPath
  : (process.env.TALEMATE_RESOURCES ?? join(app.getAppPath(), ".."));

loadEnvFile(join(RESOURCES, ".env"));

/** 逐行读 `.env` 填进 `process.env`，**只填没设过的**。几行手写解析就够——不引 dotenv。 */
function loadEnvFile(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m === null || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

setResourceRoot(process.env.TALEMATE_RESOURCES ?? RESOURCES);
