/**
 * 阶段 0 的证伪脚本：**harness 能不能在 Node 上跑？打包之后还读不读得到 prompts / skills？**
 *
 * 桌面端选 Electron 的全部依据就是这两条——主进程跑的是 Node，不是 Bun。所以它们不许停在"应该
 * 没问题"上：这个脚本把它变成一条可执行的命令。做法是把 `src/smoke.ts`（mock provider 的全链路
 * 冒烟，不需要 key）用 esbuild 打成**单文件**，放到仓库**外面**用 `node` 跑。
 *
 * 跑三遍，第二遍是故意跑失败的（主进程那一层由 `bun run desktop:selftest` 在真 Electron 里验）：
 *
 *   1. 不钉资源根 → **应当失败**，且错在找不到 prompts。这一遍证明两件事：打包后 `import.meta.url`
 *      确实指向 bundle 内部（相对回退指到了仓库外面），以及"钉根"那一步不是摆设。
 *   2. 钉上资源根 → 应当通过。这就是打包后真实的样子。
 *   3. 再用 `bun` 跑一遍同一个 bundle → 应当同样通过。Bun 与 Node 都认，说明这份产物没绑死在哪一个
 *      运行时上（也正是"零 Bun 专有 API"那句话的运行期版本）。
 *
 * 运行：`bun run desktop:probe`
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根：随包数据（prompts/ 与 skills/）就在这一层。 */
const REPO = join(HERE, "..", "..");

interface Run {
  code: number;
  out: string;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString()));
    child.stderr.on("data", (b: Buffer) => (out += b.toString()));
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

const dir = await mkdtemp(join(tmpdir(), "talemate-node-probe-"));
const bundle = join(dir, "probe.mjs");
const failures: string[] = [];

try {
  await build({
    entryPoints: [join(HERE, "entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: bundle,
    logLevel: "error",
    banner: { js: "// 由 desktop/probe/run-under-node.ts 生成，不要手动改。" },
  });
  const kb = Math.round((await stat(bundle)).size / 1024);
  console.log(`已打包到 ${bundle}（${kb} KB）`);

  // 1) 不钉资源根：应当失败，而且错法是"读不到 prompts"——不是别的什么原因
  const bare = await run("node", [bundle], { TALEMATE_RESOURCES: "" });
  const looksLikeMissingPrompts = bare.out.includes("ENOENT") || bare.out.includes("no such file");
  console.log(`[1] 不钉根：退出码 ${bare.code}${looksLikeMissingPrompts ? "，错在找不到文件 ✓" : ""}`);
  if (bare.code === 0) failures.push("不钉资源根竟然跑通了——那说明回退路径还能指到仓库，这个探针就白做了");
  if (!looksLikeMissingPrompts) failures.push(`不钉根时的失败原因不像"读不到 prompts"：\n${bare.out.slice(0, 400)}`);

  // 2) 钉上资源根：这就是打包后真实的样子
  const pinned = await run("node", [bundle], { TALEMATE_RESOURCES: REPO });
  console.log(`[2] 钉根 + node：退出码 ${pinned.code}`);
  if (pinned.code !== 0) failures.push(`钉了资源根仍然跑不通：\n${pinned.out.slice(-1500)}`);

  // 3) 同一个 bundle 换 bun 跑：产物不绑运行时
  const withBun = await run("bun", [bundle], { TALEMATE_RESOURCES: REPO });
  console.log(`[3] 钉根 + bun：退出码 ${withBun.code}`);
  if (withBun.code !== 0) failures.push(`bun 跑同一个 bundle 失败：\n${withBun.out.slice(-1500)}`);

  if (failures.length === 0) console.log("\n✔ Node 与 Bun 都能跑打包后的 harness，随包数据读得到");
} finally {
  await rm(dir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n✘ 探针未通过：\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
