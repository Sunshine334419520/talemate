/**
 * 会话调试信息：CLI `/debug` 与桌面端 `/debug` 共用的一份构建与渲染。
 *
 * 目的只有一个：**让人（或 agent）拿到路径，去看完整对话过程**。所以这里只放能定位问题的
 * 事实——会话 id、三个存储路径、角色与模型、模式、待批 / 未答、用量——不放密钥。
 */
import { projectPaths, sessionPaths, talemateHome } from "../core/config";
import type { ModelConfig, PendingProposal } from "../core/types";
import { readText } from "../storage/atomic";
import { loadMessages, loadModelWindow, loadSessionMeta } from "../storage/session-store";
import { eventLogFor } from "../telemetry/log";
import { projectStats } from "../telemetry/projection";
import type { SessionStats } from "../telemetry/projection";
import type { Session } from "./session";

export interface SessionDebugInfo {
  projectId: string;
  projectTitle: string;
  projectRoot: string;
  sessionId: string;
  sessionDir: string;
  /** canonical 事件日志——排查先看它；消息是它折出来的，不再落文件 */
  eventsPath: string;
  eventCount: number;
  stats: SessionStats;
  /** 改动索引：按轮列出的文件改动（不存 diff，点开时回消息里取） */
  changesPath: string;
  pendingAskPath: string;
  pendingAskExists: boolean;
  agent: string;
  agentName: string;
  depth: number;
  model: Pick<ModelConfig, "provider" | "model" | "baseURL" | "reasoning" | "maxTokens">;
  profile?: string;
  mode?: string;
  pending: { name: string; approved: boolean; done?: boolean; chapter?: number }[];
  messageCount: number;
  lastSeq: number;
  /** 实际会进模型窗口的条数与起点（最近一次 compaction 之后；无压缩则从第一条起） */
  modelWindowCount: number;
  modelWindowFromSeq: number;
  compactionSeq?: number;
  lastUsage?: { input: number; output: number };
}

/** 现取一份调试信息。会读盘（消息条数与 journal 是否存在），所以是 async 的。 */
export async function buildSessionDebug(session: Session): Promise<SessionDebugInfo> {
  const home = talemateHome();
  const pp = projectPaths(home, session.projectId);
  const sp = sessionPaths(home, session.projectId, session.sessionId);
  const messages = await loadMessages(session.projectId, session.sessionId);
  const events = await eventLogFor(session.projectId, session.sessionId).read();
  const window = loadModelWindow(messages);
  const compaction = [...messages].reverse().find((m) => m.role === "compaction");
  const meta = await loadSessionMeta(session.projectId, session.sessionId).catch(() => undefined);
  const pending: SessionDebugInfo["pending"] = [...session.pending.values()].map((p: PendingProposal) => ({
    name: p.name,
    approved: p.approved,
    ...(p.done === true ? { done: true } : {}),
    ...(p.chapter === undefined ? {} : { chapter: p.chapter }),
  }));
  return {
    projectId: session.projectId,
    projectTitle: session.meta.title,
    projectRoot: pp.root,
    sessionId: session.sessionId,
    sessionDir: sp.dir,
    eventsPath: sp.events,
    eventCount: events.length,
    stats: projectStats(events),
    changesPath: sp.changes,
    pendingAskPath: sp.pendingAsk,
    pendingAskExists: (await readText(sp.pendingAsk)) !== undefined,
    agent: session.agentId,
    agentName: session.agent.name,
    depth: session.depth,
    model: {
      provider: session.model.provider,
      model: session.model.model,
      ...(session.model.baseURL === undefined ? {} : { baseURL: session.model.baseURL }),
      reasoning: session.model.reasoning,
      maxTokens: session.model.maxTokens,
    },
    ...(session.profile === undefined ? {} : { profile: session.profile }),
    ...(session.currentMode === undefined ? {} : { mode: session.currentMode.title }),
    pending,
    messageCount: messages.length,
    lastSeq: messages.at(-1)?.seq ?? 0,
    modelWindowCount: window.length,
    modelWindowFromSeq: window[0]?.seq ?? 0,
    ...(compaction === undefined ? {} : { compactionSeq: compaction.seq }),
    ...(meta?.usage?.at(-1) === undefined ? {} : { lastUsage: meta.usage.at(-1) }),
  };
}

/** 渲染成人能读的一段文本。密钥永远不出现在这里。 */
export function renderSessionDebug(info: SessionDebugInfo): string {
  const pending =
    info.pending.length === 0
      ? "无"
      : info.pending
          .map((p) => {
            const state = p.done === true ? "已执行" : p.approved ? "已同意、待执行" : "未同意";
            const what = p.chapter === undefined ? p.name : `${p.name}（第 ${p.chapter} 章）`;
            return `${what} · ${state}`;
          })
          .join("；");
  const model = [
    `${info.model.provider} / ${info.model.model}`,
    info.profile === undefined ? undefined : `配置：${info.profile}`,
    `推理：${info.model.reasoning}`,
    `最大输出：${info.model.maxTokens}`,
  ]
    .filter((s): s is string => s !== undefined)
    .join(" · ");

  const lines = [
    "会话调试信息",
    `- 作品：${info.projectTitle}（${info.projectId}）`,
    `- 项目目录：${info.projectRoot}`,
    `- 会话：${info.sessionId}`,
    `- 角色：${info.agentName}（${info.agent}，深度 ${info.depth}）`,
    `- 会话目录：${info.sessionDir}`,
    `- 事件日志：${info.eventsPath}`,
    `  共 ${info.eventCount} 条；${renderStats(info.stats)}`,
    `- 改动索引：${info.changesPath}`,
    `- 消息：${info.messageCount} 条（事件折出来的），最后 seq=${info.lastSeq}`,
    `- 模型窗口：${info.modelWindowCount} 条，从 seq=${info.modelWindowFromSeq} 起` +
      `${info.compactionSeq === undefined ? "（无压缩）" : `（上次压缩 seq=${info.compactionSeq}）`}`,
    `- 未答提问记录：${info.pendingAskExists ? info.pendingAskPath : "无"}`,
    `- 模型：${model}`,
    ...(info.model.baseURL === undefined ? [] : [`- API 地址：${info.model.baseURL}`]),
    `- 模式：${info.mode ?? "无"}`,
    `- 待批：${pending}`,
    `- 最近用量：${
      info.lastUsage === undefined ? "无" : `input ${info.lastUsage.input} / output ${info.lastUsage.output}`
    }`,
    "",
    "看完整对话过程：",
    `  cat ${JSON.stringify(info.eventsPath)}`,
    `  cat ${JSON.stringify(info.changesPath)}`,
  ];
  return lines.join("\n");
}

/** 一行统计：轮/步/工具/压缩 + 两段耗时。0 就说 0，不编。 */
function renderStats(stats: SessionStats): string {
  const shell = `轮 ${stats.turns}（失败 ${stats.failedTurns} · 中止 ${stats.abortedTurns}） · 步 ${stats.steps}`;
  const tools = `工具 ${stats.toolCalls}（失败 ${stats.toolErrors}） · 压缩 ${stats.compactions}`;
  const time = `模型 ${stats.llmMs}ms / 工具 ${stats.toolMs}ms`;
  const tokens = `token input ${stats.inputTokens} / output ${stats.outputTokens}`;
  return `${shell} · ${tools} · ${time} · ${tokens}`;
}
