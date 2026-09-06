/**
 * 真实跑一次"从零到框架"主编设计对话（DeepSeek 实测），全程透明打印。
 * 用法：bun run demo-framework.ts
 * 临时 TALEMATE_HOME；演示用 confirm 自动确认、ask_user 用脚本答案队列自动作答。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildResidentDocs, designActive } from "./src/framework/anchor";
import { createProject } from "./src/storage/project";
import { loadMessages } from "./src/storage/session-store";
import { openSession, type UserIO } from "./src/session/session";
import type { LLMEvent, StoredMessage } from "./src/core/types";

const HOME = await mkdtemp(join(tmpdir(), "talemate-demo-"));
process.env.TALEMATE_HOME = HOME;

/** 演示用户的 ask_user 答案队列：编辑器问什么，从队头取；取空回一个兜底。 */
const answers = [
  "求生紧张为主，感情是暗线",
  "双频，女性读者能看进去更重要",
  "男主：一个修船厂出身的普通人，习惯性把责任扛自己身上；想要活着回去，最怕连累同行的林晚",
  "真实荒岛，不要系统不要异能",
  "岛上埋一条线：之前来过一批人，没走成",
  "林晚：空姐，嘴硬心软，担心人却说反话——原话『你死了我可不会埋你』",
];

function askAnswer(q: string): string {
  const a = answers.shift();
  if (a) {
    console.log(`\n   ↩ [演示自动作答] ${JSON.stringify(a)}\n`);
    return a;
  }
  const fallback = "（演示兜底）按你的专业判断给个默认，标出需要我确认的地方，别反复问同样的问题。";
  console.log(`\n   ↩ [演示自动作答·兜底] ${JSON.stringify(fallback)}\n`);
  return fallback;
}

const io: UserIO = {
  onEvent(e: LLMEvent) {
    switch (e.type) {
      case "text.delta":
        process.stdout.write(e.text);
        break;
      case "reasoning.delta":
        process.stdout.write(`\x1b[2m${e.text}\x1b[0m`);
        break;
      case "tool-call":
        console.log(`\n───── ⚙ tool-call: ${e.name} ─────`);
        console.log(`   input: ${e.input}`);
        break;
      case "step.end":
        if (e.finish !== "stop") console.log(`\n[step ${e.finish}]`);
        break;
      default:
        break;
    }
  },
  async confirm(action, summary) {
    console.log(`\n⚠️  需要确认：${action}`);
    console.log(`     ${summary.replace(/\n/g, "\n     ")}`);
    console.log(`   → [演示确认 y]`);
    return true;
  },
  askUser: async (q, options) => {
    console.log(`\n❓ 主编提问：${q}`);
    if (options?.length) console.log(`   选项：${options.join(" / ")}`);
    return askAnswer(q);
  },
};

function truncate(s: string, n = 1200): string {
  return s.length > n ? s.slice(0, n) + `\n…[截断 ${s.length - n} 字]` : s;
}

/** 打印自某 seq 之后新增的消息（文本 + 每个工具 part 的 input/output），供"看细节"。 */
function dumpNew(messages: StoredMessage[], fromSeq: number): number {
  let last = fromSeq;
  for (const m of messages) {
    if (m.seq <= fromSeq) continue;
    last = m.seq;
    const role = m.role.toUpperCase();
    if (m.role === "user") console.log(`\n[msg#${m.seq} USER ${m.agent ?? ""}] ${m.text ?? ""}`);
    else if (m.role === "assistant") {
      console.log(`\n[msg#${m.seq} ASSISTANT ${m.agent ?? ""}]`);
      for (const p of m.parts ?? []) {
        if (p.type === "text") console.log(`   text: ${p.text}`);
        else if (p.type === "reasoning") console.log(`   reasoning: ${truncate(p.text, 400)}`);
        else if (p.type === "tool") {
          console.log(`   tool[${p.name}] state=${p.state}`);
          if (p.input) console.log(`     input: ${truncate(p.input, 600)}`);
          if (p.output !== undefined) console.log(`     output: ${truncate(p.output)}`);
          if (p.error) console.log(`     error: ${p.error}`);
        }
      }
    } else if (m.role === "compaction") {
      console.log(`\n[msg#${m.seq} COMPACTION] summary=${truncate(m.summary ?? "", 500)}`);
    }
    void role;
  }
  return last;
}

const meta = await createProject({ title: "荒岛回声", genre: "悬疑求生" });
console.log(`\n═══════════════ 项目已建：${meta.id} · ${meta.title} ═══════════════\n`);

const designOn = await designActive(meta.id);
console.log(`designActive=${designOn}（outline 仍为骨架 → 处于设计段，注入设计协议）`);
console.log("\n───── core/world 常驻设定（editor 每轮注入，现读自磁盘） ─────\n");
console.log(await buildResidentDocs(meta.id));

const session = await openSession({ projectId: meta.id, io, title: "演示会话" });
let last = 0;

async function post(label: string, text: string): Promise<void> {
  console.log(`\n\n═══════════ 😊 用户 ${label} ═══════════`);
  console.log(text);
  console.log("\n───── 主编开始处理（文本流式；工具调用/确认/提问见上） ─────\n");
  const reply = await session.post(text);
  console.log(`\n\n[主编本轮最终文本] ${reply}`);
  const msgs = await loadMessages(meta.id, session.sessionId);
  console.log("\n───── 本轮落盘消息回放（含每个工具的输出） ─────");
  last = dumpNew(msgs, last);
}

await post("#1", [
  "我要写一部荒岛求生：一个男人和一个空姐空难后流落荒岛。",
  "基调：求生紧张为主、感情是暗线；双频。",
  "请帮我从零把这部小说搭起来——按依赖序推进 core → world → characters → outline。",
  "主角定这样：修船厂出身的普通人，习惯性把责任扛自己身上；想要活着回去，最怕连累同行的空姐林晚。",
  "世界定这样：真实荒岛、不要系统不要异能；岛里埋一条线——之前来过一批人，没走成。",
  "能自己合理默认的就先落盘（每落一格会 confirm 给你看），需要我拍板的才问。",
  "先立 core 和 world，角色卡我们下一步再细聊。",
].join("\n"));

await post("#2", [
  "主角卡已可以建。",
  "林晚：空姐，嘴硬心软，担心人却说反话——她的声音范例原话是『你死了我可不会埋你』。",
  "给她建一张完整的角色卡（一句话定位 / 想要·最怕 / 说话方式 / 习惯动作 / 在故事中的功能）。",
  "顺带把世界那批『没走成的人』写成一个小节，别把底牌掀完。",
].join("\n"));

await post("#3", [
  "现在材料够了。把整本结构综合出来：先派 planner 按 outline 骨架产出『一句话主线 + 开篇3章钩子 + 分卷方向』，然后你念给我听、并落盘 outline。",
  "不要现在写正文。",
].join("\n"));

console.log("\n\n═══════════ 📁 最终 docs 四层内容 ═══════════\n");
for (const f of ["core.md", "world.md", "characters.md", "outline.md"]) {
  const { readDoc } = await import("./src/storage/project");
  console.log(`\n──────── ${f} ────────\n`);
  console.log((await readDoc(meta.id, f)) ?? "(缺)");
}

await rm(HOME, { recursive: true, force: true });
