/**
 * CLI（阶段一：库 + REPL）。
 * 用法：
 *   bun run src/cli.ts novel create "书名" [题材]
 *   bun run src/cli.ts <project-id>          # 进主编会话 REPL
 *   bun run src/cli.ts ls                    # 列项目
 *   bun run src/cli.ts resume <project-id>   # 列出会话（二期加多会话恢复）
 *
 * 交互面：真实 stdin confirm/ask_user + 多行输入（空行提交）。
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadModelConfig, hasCredentials } from "./core/config";
import type { LLMEvent } from "./core/types";
import { createProject, listProjects, loadProjectMeta } from "./storage/project";
import { listSessionIds, loadSessionMeta } from "./storage/session-store";
import { BUILTIN_TOOLS } from "./tool/builtin";
import { openSession, type UserIO } from "./session/session";

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === "novel" && rest[0] === "create") {
    const title = rest[1];
    if (!title) {
      console.error("用法：bun run src/cli.ts novel create \"书名\" [题材]");
      process.exit(1);
    }
    const meta = await createProject({ title, genre: rest[2] });
    console.log(`已创建小说项目：${meta.id}（${meta.title}）`);
    console.log(`进入主编会话：bun run src/cli.ts ${meta.id}`);
    return;
  }

  if (cmd === "ls") {
    const projects = await listProjects();
    if (!projects.length) {
      console.log("（还没有小说项目。用 novel create 创建）");
      return;
    }
    for (const p of projects) console.log(`${p.id}\t${p.title}${p.genre ? `（${p.genre}）` : ""}`);
    return;
  }

  if (cmd === "resume") {
    const projectId = rest[0];
    const sessions = await listSessionIds(projectId);
    console.log(`项目 ${projectId} 的会话：`);
    for (const sid of sessions) {
      try {
        const m = await loadSessionMeta(projectId, sid);
        console.log(`  ${sid}\t${m.title}\t${new Date(m.time.created).toLocaleString()}`);
      } catch {
        console.log(`  ${sid}\t(损坏)`);
      }
    }
    return;
  }

  // 默认：进 REPL
  const projectId = cmd;
  if (!projectId) {
    console.error("用法见文件头。快速开始：bun run src/cli.ts novel create \"书名\"");
    process.exit(1);
  }

  await repl(projectId);
}

/** REPL：用户输入一行 → 主编 post → 打印结果，循环 */
async function repl(projectId: string): Promise<void> {
  const meta = await loadProjectMeta(projectId);
  const model = loadModelConfig();
  if (!hasCredentials(model)) {
    console.error("✗ 未找到 API key。mock 冒烟用：TALEMATE_PROVIDER=mock");
    process.exit(1);
  }
  console.log(`[talemate] 项目：${meta.title} 角色：主编  model=${model.provider}:${model.model}`);
  console.log("（输入 /quit 退出；一次输入多行用空行结束）");

  const rl = createInterface({ input, output });
  const io: UserIO = {
    onEvent: (e: LLMEvent) => renderEvent(e),
    confirm: async (action, summary) => {
      const ans = await rl.question(`\n⚠ 需要确认：${action}\n  ${summary}\n  [y/N] `);
      return /^y|yes/i.test(ans.trim());
    },
    askUser: async (question, options) => {
      const optsText = options?.length ? `\n  选项：${options.join(" / ")}` : "";
      return (await rl.question(`\n❓ ${question}${optsText}\n  > `)).trim();
    },
  };

  // 一次会话 = 建一个新 session（阶段一不做多会话恢复）
  const session = await openSession({ projectId, io, title: `会话 ${new Date().toLocaleString()}` });
  console.log(`[talemate] 会话 ${session.sessionId}（输入 /quit 退出）`);

  let buf: string[] = [];
  for (;;) {
    const line = await rl.question("你> ");
    if (line.trim() === "/quit") break;
    if (line.trim() === "") {
      const text = buf.join("\n").trim();
      buf = [];
      if (!text) continue;
      console.log("── 主编 ──");
      try {
        const reply = await session.post(text);
        console.log(`\n${reply}`);
      } catch (e) {
        console.error(`\n✗ ${e instanceof Error ? e.message : e}`);
      }
      console.log("────────");
    } else {
      buf.push(line);
    }
  }
  rl.close();
}

/** 渲染事件：流式 delta 直接打印（无换行），step 边界换行 */
function renderEvent(e: LLMEvent): void {
  switch (e.type) {
    case "text.delta":
      process.stdout.write(e.text);
      break;
    case "reasoning.delta":
      process.stdout.write(`\x1b[2m${e.text}\x1b[0m`); // 灰色思考
      break;
    case "step.start":
      process.stdout.write("\n");
      break;
    case "step.end":
      if (e.finish !== "stop") process.stdout.write(`\n[step ${e.finish}]\n`);
      break;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
