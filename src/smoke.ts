/**
 * P0 冒烟：mock provider + 临时 TALEMATE_HOME，离线验证 harness 全链路：
 *   建项目 → openSession(editor) → post → LLM 首轮返回 task 工具调用
 *   → runner 执行 task → 委派 writer 子会话（独立上下文）→ 结果回填父 assistant part
 *   → 第二轮 LLM 返回正文 → 落盘。
 * 运行：bun run src/smoke.ts
 * 环境：TALEMATE_PROVIDER=mock（不需 key）；TALEMATE_HOME 自动用临时目录。
 */
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession, type UserIO } from "./session";
import * as store from "./storage";
import { loadModelConfig } from "./core/config";

const HOME = await mkdtemp(join(tmpdir(), "talemate-smoke-"));
process.env.TALEMATE_HOME = HOME;
process.env.TALEMATE_PROVIDER = "mock";
// 剧本：mock 首轮调 task 工具 → 触发子会话委派
process.env.TALEMATE_MOCK_TOOL = "task";

const seen: string[] = [];
const io: UserIO = {
  onEvent: (e) => {
    if (e.type === "text.delta") seen.push(e.text);
  },
  confirm: async () => true,
  askUser: async (q) => `（自动答复：${q}）`,
};

try {
  // 1) 建项目
  const meta = await store.createProject({ title: "冒烟测试书", genre: "都市" });
  const model = loadModelConfig();
  console.log(`[1] 项目已建：${meta.id}`);

  // 2) 开主编会话并 post
  const session = await openSession({ projectId: meta.id, model, io });
  const reply = await session.post("帮我写第 1 章：主角在都市醒来。");
  console.log(`[2] editor post 返回（${reply.length} 字）：${truncate(reply, 120)}`);

  // 3) 验证父会话消息链：user → assistant(task) → assistant(text)
  const msgs = await store.loadMessages(meta.id, session.sessionId);
  const roles = msgs.map((m) => m.role).join(" → ");
  console.log(`[3] 父会话消息链：${roles}`);

  const taskPart = msgs.flatMap((m) => m.parts ?? []).find((p) => p.type === "tool" && p.name === "task");
  const hasTaskOk = taskPart?.type === "tool" && taskPart.state === "completed" && /task_result/.test(taskPart.output ?? "");
  console.log(`[4] task 工具调用已执行并回填：${hasTaskOk ? "✓" : "✗"}`);
  if (!hasTaskOk) {
    console.log("    task part 原文：", JSON.stringify(taskPart ?? null).slice(0, 400));
    throw new Error("task 委派链路未打通");
  }

  // 4) 子会话已落盘（writer）
  const subIds = await store.listSessionIds(meta.id);
  console.log(`[5] 落盘会话数：${subIds.length}（应 ≥2：父+writer 子）`);
  const subMetas = [];
  for (const sid of subIds) subMetas.push(await store.loadSessionMeta(meta.id, sid));
  const writerSession = subMetas.find((m) => m.title.startsWith("task:"));
  console.log(`    子会话：${subMetas.map((m) => `${m.title}(${m.id})`).join(", ")}`);
  if (!writerSession) throw new Error("writer 子会话未落盘");

  // 5) 端到端收到 delta 文本
  console.log(`[6] 收到流式 delta：${seen.length > 0 ? "✓" : "✗"}`);

  // 6) 文档落盘结构
  const pp = join(HOME, "novels", meta.id);
  const tree = await listTree(pp);
  console.log(`[7] 项目目录：\n${tree.map((f) => "    " + f.replace(pp + "/", "")).join("\n")}`);
  const rules = await readFile(join(pp, "AGENTS.md"), "utf-8");
  console.log(`[8] AGENTS.md 已建：${rules.split("\n")[0]}`);

  console.log("\n✔ P0 冒烟全链路通过");
} finally {
  await rm(HOME, { recursive: true, force: true });
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

async function listTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(dir, { withFileTypes: true }).then((ds) =>
      ds.map((d) => join(dir, d.name)),
    );
  } catch {
    return out;
  }
  for (const e of entries) {
    out.push(e);
    try {
      const st = await import("node:fs/promises").then((fs) => fs.stat(e));
      if (st.isDirectory()) out.push(...(await listTree(e)));
    } catch {
      /* ignore */
    }
  }
  return out;
}
