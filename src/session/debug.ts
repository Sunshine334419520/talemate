/**
 * 会话调试信息：CLI `/debug` 与桌面端 `/debug` 共用的一份构建与渲染。
 *
 * 目的只有一个：**让人（或 agent）拿到路径，去看完整对话过程**。所以这里只放能定位问题的
 * 事实——会话 id、三个存储路径、角色与模型、模式、待批 / 未答、用量——不放密钥。
 */
import { projectPaths, sessionPaths, talemateHome } from "../core/config";
import type { ModelConfig, PendingProposal } from "../core/types";
import { readText } from "../storage/atomic";
import { loadMessages, loadSessionMeta } from "../storage/session-store";
import type { Session } from "./session";

export interface SessionDebugInfo {
  projectId: string;
  projectTitle: string;
  projectRoot: string;
  sessionId: string;
  sessionDir: string;
  messagesPath: string;
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
  lastUsage?: { input: number; output: number };
}

/** 现取一份调试信息。会读盘（消息条数与 journal 是否存在），所以是 async 的。 */
export async function buildSessionDebug(session: Session): Promise<SessionDebugInfo> {
  const home = talemateHome();
  const pp = projectPaths(home, session.projectId);
  const sp = sessionPaths(home, session.projectId, session.sessionId);
  const messages = await loadMessages(session.projectId, session.sessionId);
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
    messagesPath: sp.messages,
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
    `- 消息文件：${info.messagesPath}`,
    `  共 ${info.messageCount} 条，最后 seq=${info.lastSeq}`,
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
    `  cat ${JSON.stringify(info.messagesPath)}`,
  ];
  return lines.join("\n");
}
