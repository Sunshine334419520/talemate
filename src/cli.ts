/**
 * talemate CLI（真实体验入口）：argv 分发、current 空间指针、REPL 斜杠命令，以及把 session 事件流
 * 渲染成给人看的输出；默认 verbose，每一步都打印。
 *
 * 边界：只管接命令与渲染，LLM / 工具 / 权限的实现都在 session 与 tool 层。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { join } from "node:path";
import { loadModelConfig, hasCredentials, talemateHome } from "./core/config";
import type { AskAnswer, AskOutcome, AskRequest, LLMEvent, StoredMessage } from "./core/types";
import { buildProjectStatus } from "./framework/report";
import { createProject, loadProjectMeta } from "./storage/project";
import { enumerateDocs, readDoc } from "./storage/corpus";
import { isSubagentSession, listSessionIds, loadMessages, loadSessionMeta } from "./storage/session-store";
import { openSession, renderPermissionView, type Session, type UserIO } from "./session/session";
import { buildSessionDebug, renderSessionDebug } from "./session/debug";
import type { Action } from "./permission";

// ─────────────────────────── 受管根 / current 指针 ───────────────────────────

/** 章节文件名（CLI 展示用）：项目相对 → 根相对的换算只属于给人看的输出，所以留在 CLI，不下沉到只认项目相对路径的语料层。 */
async function chaptersOf(projectId: string): Promise<string[]> {
  const all = await enumerateDocs(projectId, "chapters/");
  return all.map((p) => p.slice("chapters/".length));
}

/** 用户会话 id（`/sessions` 与 `/open` 共用的编号口径）：`task` 派生的子会话不列出。 */
async function visibleSessionIds(projectId: string): Promise<string[]> {
  const ids = await listSessionIds(projectId);
  const metas = await Promise.all(ids.map((id) => loadSessionMeta(projectId, id).catch(() => undefined)));
  return ids.filter((_, i) => !isSubagentSession(metas[i]));
}

function currentFile(): string {
  return join(talemateHome(), "current.json");
}

async function loadCurrent(): Promise<string | undefined> {
  try {
    const raw = await readFile(currentFile(), "utf-8");
    const c = JSON.parse(raw) as { id?: string };
    return c.id;
  } catch {
    return undefined;
  }
}

async function saveCurrent(id: string): Promise<void> {
  await mkdir(talemateHome(), { recursive: true });
  await writeFile(currentFile(), JSON.stringify({ id }, null, 2), "utf-8");
}

// ─────────────────────────── 展示辅助 ───────────────────────────

const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `…` : s;
}

/**
 * 提案类工具的入参就是整篇正文（文档草稿 / 章节规划），内容由 harness 渲染后经 `proposal` 事件整块
 * 打印，所以不走常规工具行的截断打印——否则会打出 `input={"path":"design/core.md",...}`，既看不懂，
 * 也和"对用户不出现文件路径"的纪律冲突；规划还会把正文重复一遍。
 */
const PROPOSAL_TOOLS = new Set(["propose-design", "apply-design", "propose-plan"]);

// ─────────────────────────── REPL 状态 ───────────────────────────

let verbose = true;
/** 思考显示：hide = 收起成一行摘要（默认）；show = 流式打印全文。 */
let reasoningMode: "hide" | "show" = "hide";
let curSpaceId: string | undefined;
let curTitle: string | undefined;
let curSession: Session | undefined;
let lastSeq = 0;
let inChildScope = false;
let rl: ReturnType<typeof createInterface>;

function promptText(): string {
  // 模式挂在最前面：它决定下一步什么能做，而它自己在会话里是隐形的，不显示就没人知道还开着
  const mode = curSession?.currentMode;
  const base = `${mode ? `[${mode.title}] ` : ""}${curTitle ?? curSpaceId ?? "talemate"}/搭档`;
  // 有待落盘的提案 → 提示符上挂着，用户一眼看到"还有东西等我拍板"
  const pending = curSession?.pendingLabel;
  return pending ? `${base}（待写入：${pending}）> ` : `${base}> `;
}

function printBanner(projectId: string): Promise<void> {
  return (async () => {
    const meta = await loadProjectMeta(projectId);
    const chapters = await chaptersOf(projectId);
    console.log(`\n${CYAN}◈ ${meta.title}${meta.genre ? `（${meta.genre}）` : ""}${RESET}  id: ${meta.id}`);
    console.log(`   chapters/: ${chapters.length ? chapters.join(", ") : "（空）"}`);
    const status = await buildProjectStatus(projectId);
    // status 首行是“作品：…”与上面重复，展示四层现状即可
    console.log(status.split("\n").slice(1).join("\n"));
    if (verbose) console.log(`   （core/world 常驻设定仍每轮注入 mate 上下文，这里不重复打印）`);
  })();
}

/** 打印"本轮新增落盘消息"的紧凑索引（工具结果已流式/预览显示过，不重复全文；要看全文用 /msg <seq>）。 */
function replayNew(messages: StoredMessage[], from: number): number {
  let last = from;
  let toolCount = 0;
  for (const m of messages) {
    if (m.seq <= from) continue;
    last = m.seq;
    if (m.role === "assistant") {
      for (const p of m.parts ?? []) {
        if (p.type !== "tool") continue;
        if (PROPOSAL_TOOLS.has(p.name)) continue; // 提案正文已整块打印过，不算"工具落盘"
        toolCount++;
        const len = p.output !== undefined ? p.output.length : (p.error?.length ?? 0);
        console.log(`  ⚙ 工具落盘：${p.name}（${len} 字 · 完整见 /msg ${m.seq}）`);
      }
    }
  }
  if (toolCount) console.log(`\n${DIM}本轮 ${toolCount} 次工具调用已落盘${RESET}`);
  return last;
}

/** 打印某条落盘消息的全文（/msg <seq> 用）：文本 + 工具入参/输出。 */
async function printMessage(projectId: string, sessionId: string, seqText: string): Promise<void> {
  const n = Number(seqText);
  const all = await loadMessages(projectId, sessionId);
  const m = all.find((x) => x.seq === n);
  if (!m) {
    console.log(`没有第 ${seqText} 条消息（本会话 seq 范围 1..${all.length}）。`);
    return;
  }
  if (m.role === "assistant") {
    for (const p of m.parts ?? []) {
      if (p.type === "text") console.log(`[msg#${n} text]\n${p.text}`);
      else if (p.type === "reasoning") console.log(`[msg#${n} reasoning]\n${p.text}`);
      else if (p.type === "tool") {
        console.log(`[msg#${n} tool ${p.name} ${p.state}]`);
        if (p.input) console.log(`input:\n${p.input}`);
        if (p.output !== undefined) console.log(`output:\n${p.output}`);
        if (p.error) console.log(`error:\n${p.error}`);
      }
    }
  } else {
    console.log(`[msg#${n} ${m.role}]\n${m.text ?? JSON.stringify(m, null, 2)}`);
  }
}

// ─────────────────────────── 权限表（/permissions） ───────────────────────────

function paintAction(a: Action): string {
  const color = a === "allow" ? GREEN : a === "ask" ? YELLOW : RED;
  return `${color}${a.padEnd(5)}${RESET}`;
}

/**
 * 规则表由 harness 渲染（`renderPermissionView`，界面那条命令读的是同一份）——这里只负责上色与换行。
 */
function printPermissions(session: Session): void {
  console.log(`\n${renderPermissionView(session.permissionView(), paintAction)}\n`);
}

// ─────────────────────────── io（详细打印渲染） ───────────────────────────

/**
 * 收起模式下的思考显示（不需要 TUI）：流式期间用一行 `\r` 重写的状态行顶着，推理一结束就擦掉、
 * 换成一行摘要。展开全文走 /msg <seq>——推理本来就落盘在 messages.jsonl 的 reasoning part 里。
 */
let think: { started: number; chars: number; head: string; live: boolean } | undefined;
let lastLiveWrite = 0;

/** 擦掉原地刷新的状态行（空行覆盖 + 回车归位）。 */
function clearLiveLine(): void {
  if (think?.live) {
    process.stdout.write(`\r${" ".repeat(48)}\r`);
    think.live = false;
  }
}

/** 推理结束 → 收起成一行摘要。 */
function flushThinking(): void {
  if (!think) return;
  const wasLive = think.live;
  clearLiveLine();
  const secs = ((Date.now() - think.started) / 1000).toFixed(1);
  const head = think.head ? ` · ${think.head}` : "";
  console.log(`${wasLive ? "" : "\n"}${DIM}▸ 思考 ${secs}s · ${think.chars} 字${head}${RESET}`);
  think = undefined;
}

/**
 * 终端里的提问读取。序号选选项，直接输入文字 = 自定义答案，空行 = 跳过。
 * timeout 在 REPL 里不生效：用户就在提示符前，超时只会把还在想的人打断。
 */
async function readAsk(req: AskRequest): Promise<AskOutcome> {
  const answers: AskAnswer[] = [];
  for (const q of req.questions) {
    if (q.header) console.log(`\n${DIM}${q.header}${RESET}`);
    console.log(`\n${YELLOW}❓ 主编提问${RESET}：${q.question}`);
    if (q.options?.length) {
      q.options.forEach((o, i) =>
        console.log(`   ${i + 1}. ${o.label}${o.description ? ` ${DIM}— ${o.description}${RESET}` : ""}`),
      );
      console.log(
        `   ${DIM}${q.multiSelect ? "可多选，序号用逗号分隔" : "输入序号"}；直接打字 = 自定义答案；回车 = 跳过${RESET}`,
      );
    }
    const ans = (await rl.question("   > ")).trim();
    if (ans === "") {
      answers.push({ id: q.id, selected: [] });
      continue;
    }
    if (q.options?.length) {
      const picked: string[] = [];
      const rest: string[] = [];
      for (const token of ans.split(/[\s,，]+/).filter(Boolean)) {
        const n = Number(token);
        if (Number.isInteger(n) && n >= 1 && n <= q.options.length) picked.push(q.options[n - 1].label);
        else rest.push(token);
      }
      if (picked.length === 0) {
        answers.push({ id: q.id, selected: [], custom: ans });
        continue;
      }
      const selected = q.multiSelect === true ? picked : picked.slice(0, 1);
      answers.push({
        id: q.id,
        selected,
        ...(rest.length > 0 ? { custom: rest.join(" ") } : {}),
      });
      continue;
    }
    answers.push({ id: q.id, selected: [], custom: ans });
  }
  return { kind: "answered", answers };
}

function makeIO(): UserIO {
  const onEvent = (e: LLMEvent): void => {
    if (e.type !== "reasoning.delta") flushThinking(); // 任何别的事件都表示这段推理已经结束
    switch (e.type) {
      case "text.delta":
        process.stdout.write(inChildScope ? `${e.text}` : e.text);
        break;
      case "reasoning.delta": {
        if (reasoningMode === "show") {
          process.stdout.write(`${DIM}${e.text}${RESET}`);
          break;
        }
        if (inChildScope) break; // 子代理的推理不打状态行（会和父会话的输出缠在一起）
        if (!think) think = { started: Date.now(), chars: 0, head: "", live: false };
        think.chars += e.text.length;
        if (!think.head) {
          const line = e.text.split("\n").find((l) => l.trim());
          if (line) think.head = truncate(line.trim(), 40);
        }
        const now = Date.now();
        if (now - lastLiveWrite > 120) {
          lastLiveWrite = now;
          process.stdout.write(`\r${DIM}◌ 思考中… ${((now - think.started) / 1000).toFixed(0)}s${RESET}`);
          think.live = true;
        }
        break;
      }
      case "tool-call.start":
        // 大工具（写正文/设计稿）的参数要流很久；先报一声，别让终端看起来死了
        if (verbose && !PROPOSAL_TOOLS.has(e.name)) {
          console.log(`\n${CYAN}⚙ 准备工具${RESET} ${e.name} …`);
        }
        break;
      case "tool-call":
        if (verbose && !PROPOSAL_TOOLS.has(e.name)) {
          console.log(`\n${CYAN}⚙ 工具调用${RESET} ${e.name} ${DIM}input=${truncate(e.input, 300)}${RESET}`);
        }
        break;
      case "tool.result":
        if (verbose && !PROPOSAL_TOOLS.has(e.name)) {
          const out = truncate(e.output.replace(/\n/g, " "), 160);
          console.log(`   ↳ 结果（${e.output.length} 字）：${out || "(空)"}`);
        }
        break;
      case "proposal":
        // 提案正文是给用户读的：整块打印（不缩进、不截断），前后留空行与流式正文分开。
        // 操作提示不写进提案正文（界面用按钮）；终端里单独给一行，判定仍走 draftVerdict。
        console.log(`\n${e.text}\n`);
        console.log(`${DIM}   [y] 接受 · [n] 拒绝 · 直接说要改哪里${RESET}`);
        break;
      case "scope.open":
        inChildScope = true;
        if (verbose) console.log(`\n${YELLOW}┌─ 委派子代理：${e.label}（其推理/工具/文本见下）${RESET}`);
        break;
      case "scope.close":
        inChildScope = false;
        if (verbose) console.log(`\n${YELLOW}└─ 子代理结束 ─${RESET}`);
        break;
      case "session.status":
        if (e.status === "idle") process.stdout.write("\n");
        break;
      default:
        break;
    }
  };
  return {
    onEvent,
    confirm: async (action, summary) => {
      console.log(`\n${YELLOW}⚠ 需要确认${RESET}：${action}`);
      console.log(summary.split("\n").map((l) => `   ${l}`).join("\n"));
      // 三档：这一次 / 这一类以后都别问 / 拒绝。中间那档进会话级 approved 表（见 docs/permissions.md）
      const ans = (await rl.question("   [y] 这次允许 · [a] 这类都别再问 · [N] 拒绝 > ")).trim().toLowerCase();
      if (ans === "a" || ans === "always") return "always";
      return ans === "y" || ans === "yes" ? "once" : "no";
    },
    askUser: (req) => readAsk(req),
  };
}

// ─────────────────────────── 会话开 / 切 ───────────────────────────

async function openInSpace(projectId: string, sessionId?: string): Promise<void> {
  const io = makeIO();
  curSpaceId = projectId;
  const session = await openSession({
    projectId,
    io,
    title: sessionId ? undefined : `会话 ${new Date().toLocaleString()}`,
    sessionId,
  });
  curSession = session;
  // 与桌面端同一个默认：工作区内修改（落盘免确认；委派与联网仍问）。
  // 要每次询问就 TALEMATE_PERMISSION_MODE=ask。模式只在内存里，重开会话按这里重新起。
  session.setMode(process.env.TALEMATE_PERMISSION_MODE === "ask" ? undefined : "accept-edits");
  lastSeq = 0;
  const meta = await loadProjectMeta(projectId);
  curTitle = meta.title;
  await printBanner(projectId);
  if (sessionId) console.log(`已恢复会话 ${session.sessionId}`);
  else console.log(`新会话 ${session.sessionId}（/quit 退出 · /help 命令）`);
}

/** 解析 /use 选择：id 精确 或 书名包含 */
async function resolveSpace(sel: string): Promise<string | undefined> {
  const { listProjects } = await import("./storage/project");
  const all = await listProjects();
  const hit = all.find((p) => p.id === sel) ?? all.find((p) => p.title.includes(sel));
  return hit?.id;
}

async function handleSlash(raw: string): Promise<"continue" | "quit" | "switch"> {
  const [cmd, ...rest] = raw.trim().split(/\s+/);
  const arg = rest.join(" ");
  switch (cmd) {
    case "/quit":
    case "/exit":
      return "quit";
    case "/help":
      console.log(
        [
          "命令：",
          "  /quit          退出",
          "  /status        当前空间 / 会话 / 角色 / docs 填充 / 章节",
          "  /projects      列出所有项目空间（* = 当前）",
          "  /use <id|书名>  切到另一空间（开新会话；可 /sessions 恢复旧会话）",
          "  /new <书名> [题材]  新建空间并进入",
          "  /sessions      列出当前空间的历史会话",
          "  /open <n>      恢复当前空间第 n 个历史会话",
          "  /permissions   当前生效的规则表：每类动作是什么、是哪一层定的、各层都贡献了什么",
          "  /debug         当前会话的调试信息：模型、模式、待批，以及会话目录与 messages.jsonl 路径",
          "  /design <name>    打印某设计文档全文（design/ 相对路径，如 core、wiki/world、characters/沈越）",
          "  /msg <seq>     打印某条落盘消息全文（工具入参/输出），seq 看工具落盘提示",
          "  /verbose       打开详细打印（默认开）",
          "  /quiet         只显示最终文本",
          "  /reasoning     切换思考显示：收起（默认，一行摘要）/ 展开（流式全文）",
          "  行尾加 \\ 续行；空行不发送。",
        ].join("\n"),
      );
      return "continue";
    case "/status": {
      if (!curSpaceId || !curSession) return "continue";
      const mode = curSession.currentMode;
      console.log(
        `会话：${curSession.sessionId} · agent: ${curSession.agent.name}${mode ? ` · 模式：${mode.title}（/permissions 看这个模式放行了什么）` : ""}`,
      );
      console.log(await buildProjectStatus(curSpaceId));
      return "continue";
    }
    case "/permissions": {
      if (!curSession) return "continue";
      printPermissions(curSession);
      return "continue";
    }
    case "/debug": {
      if (!curSession) {
        console.log("还没有打开会话。先进入一个项目空间。");
        return "continue";
      }
      console.log(renderSessionDebug(await buildSessionDebug(curSession)));
      return "continue";
    }
    case "/projects": {
      const { listProjects } = await import("./storage/project");
      const all = await listProjects();
      if (!all.length) {
        console.log("（还没有项目空间。用 /new <书名> 建一个）");
        return "continue";
      }
      console.log(`共 ${all.length} 个空间：`);
      for (const p of all) {
        const chapters = await chaptersOf(p.id);
        const mark = p.id === curSpaceId ? " *" : "";
        console.log(`  ${p.id}${mark}  ${p.title}${p.genre ? `（${p.genre}）` : ""}  章=${chapters.length}`);
      }
      return "continue";
    }
    case "/use": {
      if (!arg) {
        console.log("用法：/use <id|书名>");
        return "continue";
      }
      const id = await resolveSpace(arg);
      if (!id) {
        console.log(`没有找到项目空间：${arg}`);
        return "continue";
      }
      if (id === curSpaceId) {
        console.log(`已经在 ${id}`);
        return "continue";
      }
      await openInSpace(id);
      return "switch";
    }
    case "/new": {
      const title = arg;
      if (!title) {
        console.log("用法：/new <书名> [题材]");
        return "continue";
      }
      const [t, ...g] = title.split(/\s+/);
      const genre = g.join(" ");
      const meta = await createProject({ title: t, genre: genre || undefined });
      console.log(`已创建：${meta.id}（${meta.title}）`);
      await saveCurrent(meta.id);
      await openInSpace(meta.id);
      return "switch";
    }
    case "/sessions": {
      if (!curSpaceId) return "continue";
      const ids = await visibleSessionIds(curSpaceId);
      if (!ids.length) {
        console.log("（本空间还没有历史会话）");
        return "continue";
      }
      for (let i = 0; i < ids.length; i++) {
        const m = await loadSessionMeta(curSpaceId, ids[i]).catch(() => undefined);
        console.log(`  ${i + 1}. ${m?.title ?? ids[i]}  (${new Date(m?.time.created ?? 0).toLocaleString()})`);
      }
      return "continue";
    }
    case "/open": {
      if (!curSpaceId) return "continue";
      const ids = await visibleSessionIds(curSpaceId);
      const n = Number(arg);
      if (!ids[n - 1]) {
        console.log(`没有第 ${arg} 个会话。可用：/sessions`);
        return "continue";
      }
      await openInSpace(curSpaceId, ids[n - 1]);
      return "switch";
    }
    case "/design": {
      if (!curSpaceId) return "continue";
      // CLI 给人用：`/design <名>` 收的是 design/ 相对简写，不是工具那套项目相对路径——命令行里用户想说的是"设计那本里的哪一份"
      const name = arg.includes(".md") ? arg : `${arg}.md`;
      const c = await readDoc(curSpaceId, `design/${name}`);
      console.log(c === undefined ? `没有 ${name}` : `# ${name}\n${c}`);
      return "continue";
    }
    case "/msg": {
      if (!curSpaceId || !curSession) return "continue";
      if (!arg) {
        console.log("用法：/msg <seq>（seq 见 /sessions 或工具落盘提示）");
        return "continue";
      }
      await printMessage(curSession.projectId, curSession.sessionId, arg);
      return "continue";
    }
    case "/verbose":
      verbose = true;
      console.log("详细打印：开");
      return "continue";
    case "/quiet":
      verbose = false;
      console.log("详细打印：关（只显示最终文本）");
      return "continue";
    case "/reasoning":
      reasoningMode = reasoningMode === "show" ? "hide" : "show";
      console.log(
        `思考显示：${reasoningMode === "show" ? "展开（流式打印全文）" : "收起（只打一行摘要；全文用 /msg <seq>）"}`,
      );
      return "continue";
    default:
      console.log(`未知命令 ${cmd}（/help 看命令）`);
      return "continue";
  }
}

async function repl(projectId: string, sessionId?: string): Promise<void> {
  rl = createInterface({ input, output, terminal: process.stdin.isTTY });
  await openInSpace(projectId, sessionId);

  let buf = "";
  let closed = false;
  const onClose = (): void => {
    closed = true;
  };
  rl.on("close", onClose);

  while (!closed) {
    let line: string;
    try {
      line = (await rl.question(promptText())).trim();
    } catch {
      break; // EOF / 输入被关闭（管道非交互也走这里干净退出）
    }
    if (line.endsWith("\\")) {
      buf += line.slice(0, -1) + "\n";
      continue;
    }
    const text = (buf + line).trim();
    buf = "";

    if (!text) continue;
    if (text.startsWith("/")) {
      const r = await handleSlash(text);
      if (r === "quit") break;
      continue; // switch 已由 openInSpace 换好 session/prompt
    }
    if (!curSession) {
      console.log("（尚未进入任何项目空间）");
      continue;
    }
    console.log(`\n${CYAN}你${RESET} > ${text}`);
    try {
      const reply = await curSession.post(text);
      if (verbose) {
        const msgs = await loadMessages(curSession.projectId, curSession.sessionId);
        lastSeq = replayNew(msgs, lastSeq);
        console.log(`\n${DIM}—— 本轮结束 ——${RESET}`);
      } else if (reply) {
        // 提案回合（halt）通常没有正文——正文已由 proposal 事件整块打印，别再多打一个空行
        console.log(`\n${reply}`);
      }
    } catch (e) {
      console.error(`\n✗ ${e instanceof Error ? e.message : e}`);
    }
  }
  rl.removeListener("close", onClose);
  rl.close();
}

// ─────────────────────────── 入口 ───────────────────────────

async function main(): Promise<void> {
  const [cmd, sub, ...rest] = process.argv.slice(2);

  if ((cmd === "new" || (cmd === "novel" && sub === "create")) && rest.length >= 0) {
    const title = cmd === "new" ? sub ?? rest[0] : rest[0];
    const genre = cmd === "new" ? rest.join(" ") : rest.slice(1).join(" ");
    if (!title) {
      console.error("用法：talemate new <书名> [题材]");
      process.exit(1);
    }
    const meta = await createProject({ title, genre: genre || undefined });
    console.log(`已创建项目空间：${meta.id}（${meta.title}）`);
    await saveCurrent(meta.id);
    await repl(meta.id);
    return;
  }

  if (cmd === "ls") {
    const { listProjects } = await import("./storage/project");
    const all = await listProjects();
    if (!all.length) {
      console.log("（还没有项目空间。用：talemate new <书名> [题材]）");
      return;
    }
    console.log(`共 ${all.length} 个项目空间：`);
    for (const p of all) {
      const chapters = await chaptersOf(p.id);
      console.log(`  ${p.id}\t${p.title}${p.genre ? `（${p.genre}）` : ""}\t章=${chapters.length}\t${new Date(p.createdAt).toLocaleDateString()}`);
    }
    return;
  }

  const sel = cmd === "use" ? sub ?? "" : cmd ?? "";
  if (sel) {
    const id = await resolveSpace(sel);
    if (!id) {
      console.error(`没有找到项目空间：${sel}`);
      console.error("可用：talemate ls");
      process.exit(1);
    }
    await saveCurrent(id);
    await repl(id);
    return;
  }

  console.log(
    [
      "talemate —— 小说创作 Agent（主编会话）",
      "",
      "用法：",
      "  talemate ls                 列出所有项目空间",
      "  talemate new <书名> [题材]   新建空间（播种四层骨架）并进入",
      "  talemate use <id|书名>       进入某空间",
      "  talemate <id>               同 use",
      "",
      "进入后是主编会话：直接对话；/help 看命令。",
    ].join("\n"),
  );
  const cur = await loadCurrent();
  const all = await (await import("./storage/project")).listProjects();
  if (all.length) {
    console.log("\n现有项目空间：");
    for (const p of all) console.log(`  ${p.id}  ${p.title}${cur === p.id ? "  ← current" : ""}`);
    if (cur) console.log(`\n上次进入：${cur}（直接 talemate ${cur}）`);
  }
  const model = loadModelConfig();
  if (!hasCredentials(model)) {
    console.error(`\n✗ 未找到 API key。mock 冒烟用：TALEMATE_PROVIDER=mock；也可 TALEMATE_REASONING=off`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
