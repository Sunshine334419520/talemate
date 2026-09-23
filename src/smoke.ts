/**
 * P0 冒烟：mock provider + 临时 TALEMATE_HOME，离线验证 harness 全链路：
 *   建项目 → openSession(mate) → post → LLM 首轮返回 task 工具调用
 *   → runner 执行 task → 委派 writer 子会话（独立上下文）→ 结果回填父 assistant part
 *   → 第二轮 LLM 返回正文 → 落盘。
 * 运行：bun run src/smoke.ts
 * 环境：TALEMATE_PROVIDER=mock（不需 key）；TALEMATE_HOME 自动用临时目录。
 */
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession, type UserIO } from "./session/session";
import { createProject, listDesigns, readProjectRules, writeProjectMeta } from "./storage/project";
import { loadMessages, listSessionIds, loadSessionMeta } from "./storage/session-store";
import { loadModelConfig } from "./core/config";
import { evaluateWithSource } from "./permission";
import { PLAN_KEY } from "./core/types";

const HOME = await mkdtemp(join(tmpdir(), "talemate-smoke-"));
process.env.TALEMATE_HOME = HOME;
process.env.TALEMATE_PROVIDER = "mock";
// 剧本：mock 首轮调 task 工具 → 触发子会话委派
process.env.TALEMATE_MOCK_TOOL = "task";

const seen: string[] = [];
const proposals: string[] = [];
const io: UserIO = {
  onEvent: (e) => {
    if (e.type === "text.delta") seen.push(e.text);
    if (e.type === "proposal") proposals.push(e.text);
  },
  confirm: async () => "once",
  askUser: async (q) => `（自动答复：${q}）`,
};

try {
  // 1) 建项目
  const meta = await createProject({ title: "冒烟测试书", genre: "都市" });
  const model = loadModelConfig();
  console.log(`[1] 项目已建：${meta.id}`);

  // 2) 硬门：写正文前必须有一份用户拍板过的节拍。没拍板就派 writer，会被拒
  const session = await openSession({ projectId: meta.id, model, io });
  await session.post("帮我写第 1 章：主角在都市醒来。");
  const gatedMsgs = await loadMessages(meta.id, session.sessionId);
  const refusedPart = gatedMsgs.flatMap((m) => m.parts ?? []).find((p) => p.type === "tool" && p.name === "task");
  const gated = refusedPart?.type === "tool" && /没有一份用户已拍板的节拍/.test(refusedPart.output ?? "");
  console.log(`[2] 硬门：没拍板的节拍 → task(writer) 被拒：${gated ? "✓" : "✗"}`);
  if (!gated) throw new Error(`写正文的硬门没起作用：${truncate(JSON.stringify(refusedPart ?? null), 200)}`);

  // 3) 拍板过之后同一条委派放行——走真实的两回合
  const s2write = await openSession({ projectId: meta.id, model, io });
  // 三向只有草稿模式那一条通道，所以先进模式再提案（propose-plan 的前置会拦）。
  process.env.TALEMATE_MOCK_TOOL = "enter-draft";
  await s2write.post("我要写第 1 章，先摆个节拍。");
  process.env.TALEMATE_MOCK_TOOL = "propose-plan";
  await s2write.post("帮我写第 1 章：主角在都市醒来。");
  const pendingPlan = s2write.pending.get(PLAN_KEY);
  console.log(`[3] propose-plan 已登记待执行的节拍（未获同意）：${pendingPlan && !pendingPlan.approved ? "✓" : "✗"}`);
  if (!pendingPlan || pendingPlan.approved) throw new Error("节拍未被登记为待拍板");

  process.env.TALEMATE_MOCK_TOOL = "task";
  const reply = await s2write.post("没问题");
  // 接受 = 退出草稿模式（出口是接受/拒绝，不是"提案成功"），所以随后的 task 才没被模式挡住
  console.log(`[3b] 用户接受 → 退出草稿模式：${s2write.currentMode ? "✗ 还开着" : "✓"}`);
  // 一次批准只换一次写作：task(writer) 成功后那份登记即清
  console.log(`[3b2] task(writer) 放行、且用掉即清：${s2write.pending.has(PLAN_KEY) ? "✗ 还留着" : "✓"}`);
  console.log(`[3c] mate post 返回（${reply.length} 字）：${truncate(reply, 120)}`);

  // 3d) 草稿模式：task 从 schema 里消失，连 mock 都演不出来（模式唯一的工具效果）
  const s3 = await openSession({ projectId: meta.id, model, io });
  process.env.TALEMATE_MOCK_TOOL = "enter-draft";
  await s3.post("写第 2 章。");
  process.env.TALEMATE_MOCK_TOOL = "task"; // 想演 task，但它已经不在工具列表里了
  await s3.post("继续。");
  const s3Msgs = await loadMessages(meta.id, s3.sessionId);
  const s3Tools = s3Msgs.flatMap((m) => m.parts ?? []).filter((p) => p.type === "tool").map((p) => p.name);
  const hidden = s3Tools.includes("enter-draft") && !s3Tools.includes("task");
  console.log(`[3d] 草稿模式下 task 不可见（工具序列 ${s3Tools.join(" → ")}）：${hidden ? "✓" : "✗"}`);
  if (!hidden) throw new Error("草稿模式没有藏掉 task");

  // 3d2) /permissions 的视图：只说"edit 是 deny"没用，得说得出是**模式**定的
  const pv = s3.permissionView();
  const verdict = evaluateWithSource("edit", "*", ...pv.layers.map((l) => l.rules), pv.approved);
  const source = pv.layers[verdict.layer]?.label ?? "（未匹配）";
  const sourced = verdict.rule.action === "deny" && source === pv.modeTitle;
  console.log(`[3d2] 视图把 edit 的 deny 归到「${source}」（模式：${pv.modeTitle}）：${sourced ? "✓" : "✗"}`);
  if (!sourced) throw new Error("规则表视图没能说清这条 deny 是哪一层定的");

  // 3e) 项目级权限：talemate.json 的 permissions 真的接上了（规则表最后一层）
  const meta3 = await createProject({ title: "冒烟权限书" });
  await writeProjectMeta({ ...meta3, permissions: { edit: "deny" } });
  const s4 = await openSession({ projectId: meta3.id, model, io });
  process.env.TALEMATE_MOCK_TOOL = "write"; // 想演它，但 edit 被 deny → 它不在 schema 里
  await s4.post("给我加一节。");
  const s4Tools = (await loadMessages(meta3.id, s4.sessionId))
    .flatMap((m) => m.parts ?? [])
    .filter((p) => p.type === "tool")
    .map((p) => p.name);
  const pBlocked = !s4Tools.includes("write");
  console.log(`[3e] talemate.json 的 permissions 生效（edit: deny → write 不可见）：${pBlocked ? "✓" : "✗"}`);
  if (!pBlocked) throw new Error("项目级 permissions 没生效");

  // 3f) 而且用户看得见这条去了哪：视图把 deny 归到"项目配置"那一层（/permissions 的输出就是这个）
  const pv4 = s4.permissionView();
  const v4 = evaluateWithSource("edit", "*", ...pv4.layers.map((l) => l.rules), pv4.approved);
  const userLayer = pv4.layers[v4.layer]?.label ?? "（未匹配）";
  const attributed = v4.rule.action === "deny" && userLayer.includes("talemate.json");
  console.log(`[3f] 视图把它归到「${userLayer}」：${attributed ? "✓" : "✗"}`);
  if (!attributed) throw new Error("项目级 permissions 的来源没在视图里显示出来");

  // 4) 验证父会话消息链：user → assistant(task) → assistant(text)
  const msgs = await loadMessages(meta.id, s2write.sessionId);
  const roles = msgs.map((m) => m.role).join(" → ");
  console.log(`[4] 父会话消息链：${roles}`);

  const taskPart = msgs.flatMap((m) => m.parts ?? []).find((p) => p.type === "tool" && p.name === "task");
  const hasTaskOk = taskPart?.type === "tool" && taskPart.state === "completed" && /task_result/.test(taskPart.output ?? "");
  console.log(`[4] task 工具调用已执行并回填：${hasTaskOk ? "✓" : "✗"}`);
  if (!hasTaskOk) {
    console.log("    task part 原文：", JSON.stringify(taskPart ?? null).slice(0, 400));
    throw new Error("task 委派链路未打通");
  }

  // 4) 子会话已落盘（writer）
  const subIds = await listSessionIds(meta.id);
  console.log(`[5] 落盘会话数：${subIds.length}（应 ≥2：父+writer 子）`);
  const subMetas = [];
  for (const sid of subIds) subMetas.push(await loadSessionMeta(meta.id, sid));
  const writerSession = subMetas.find((m) => m.title.startsWith("task:"));
  console.log(`    子会话：${subMetas.map((m) => `${m.title}(${m.id})`).join(", ")}`);
  if (!writerSession) throw new Error("writer 子会话未落盘");

  // 4b) design/ 懒建：初始为空（按需 design-spec 拿形状再成稿）
  const seeded = await listDesigns(meta.id);
  console.log(`[5b] design/ 懒建：初始 ${seeded.length ? seeded.join(", ") : "（空，按需 design-spec 成稿）"}`);
  if (seeded.length !== 0) throw new Error("design/ 应懒建为空");

  // 5) 端到端收到 delta 文本
  console.log(`[6] 收到流式 delta：${seen.length > 0 ? "✓" : "✗"}`);

  // 6) 文档落盘结构
  const pp = join(HOME, "novels", meta.id);
  const tree = await listTree(pp);
  console.log(`[7] 项目目录：\n${tree.map((f) => "    " + f.replace(pp + "/", "")).join("\n")}`);
  // 8) AGENTS.md 不预种：它是用户自己的文件，不存在 → 不注入
  const rules = await readProjectRules(meta.id);
  console.log(`[8] AGENTS.md 不预种：${rules === "" ? "✓（不存在 → 不注入）" : `✗ ${rules.slice(0, 40)}`}`);
  if (rules !== "") throw new Error("AGENTS.md 不应预种（是用户自己的文件）");

  // 9) 提案两段式：propose-design 不写盘、结束本回合，用户回话才决定"同意"
  const meta2 = await createProject({ title: "冒烟提案书" });
  const s2 = await openSession({ projectId: meta2.id, model, io });
  // 三向的前置：先进草稿模式
  process.env.TALEMATE_MOCK_TOOL = "enter-draft";
  await s2.post("把核心设定整理一版出来。");
  process.env.TALEMATE_MOCK_TOOL = "propose-design";
  const r2 = await s2.post("把核心设定整理一版出来。");

  const notWritten = (await listDesigns(meta2.id)).length === 0;
  console.log(`[9] propose-design 不写盘：${notWritten ? "✓（design/ 仍为空）" : "✗ 竟然落盘了"}`);
  if (!notWritten) throw new Error("提案不该落盘");

  const prop = proposals.at(-1) ?? "";
  const rendered =
    prop.includes("提案 · 核心层") && prop.includes("1. 题材 · 频道") && prop.includes("回复「没问题」就写入");
  console.log(`[9b] 提案已渲染给用户（逐格 + 收尾契约）：${rendered ? "✓" : "✗"}`);
  if (!rendered) throw new Error(`提案未按预期渲染：${truncate(prop, 200)}`);

  const halted = r2.includes("等用户回话");
  console.log(`[9c] 本回合在提案处结束（halt）：${halted ? "✓" : `✗ ${truncate(r2, 80)}`}`);

  const pending = s2.pending.get("core.md");
  console.log(`[9d] 待落盘提案已登记且未获同意：${pending && !pending.approved ? "✓" : "✗"}`);

  // "同意"由 harness 按用户回话判定——模型自述无效
  await s2.post("没问题");
  const agreed = s2.pending.get("core.md")?.approved === true;
  console.log(`[10] 用户说「没问题」→ 记为用户已同意：${agreed ? "✓" : "✗"}`);
  if (!agreed) throw new Error("同意未被 harness 记下");

  await s2.post("等一下，第 3 格我想改成雨夜");
  const revoked = s2.pending.get("core.md")?.approved === false;
  console.log(`[10b] 用户改口要改内容 → 同意撤销：${revoked ? "✓" : "✗"}`);
  if (!revoked) throw new Error("带改动要求的回话不该算同意");

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
