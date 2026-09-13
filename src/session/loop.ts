/**
 * 抽离出的 agent 循环：纯控制流，依赖注入、对 storage/llm/agents 零 import。
 *
 * 一条输入 → 若干轮「取上下文 → 生成 → 执行工具 → 落盘 → 判断是否续」，
 * 直到某一轮无 tool-call、有工具要求 halt、或达 steps 上限。
 * 依赖全部经 LoopDeps 注入，因此可脱离文件系统单独测（给一份 fake deps）。
 *
 * halt：工具成功后要求结束本回合、把控制权交回用户（propose-design 用它保证提案与落盘不同回合）。
 */
import type { AgentDef, AssistantPart, LLMEvent, ToolCall } from "../core/types";
import type { AssistantTurn, NeutralMsg, ToolSchema } from "../llm/types";

export interface LoopDeps {
  /** 组装本次请求：截窗后的历史 → NeutralMsg + system + 该角色可见工具 */
  buildRequest(agent: AgentDef): Promise<{ system: string; messages: NeutralMsg[]; tools?: ToolSchema[] }>;
  /** 跑一次 LLM 流式交互（delta 经回调吐出） */
  generate(
    req: { system: string; messages: NeutralMsg[]; tools?: ToolSchema[] },
    opts: { signal: AbortSignal; onText(d: string): void; onReasoning(d: string): void },
  ): Promise<AssistantTurn>;
  /** 执行一次工具调用 → 返回其 assistant part（completed/error） */
  executeTool(agent: AgentDef, call: ToolCall): Promise<AssistantPart>;
  /** 落盘一条 assistant 消息（含工具结果） */
  commitAssistant(msg: { agent: string; parts: AssistantPart[]; finish: "stop" | "tool_calls" }): Promise<void>;
  /** 落盘一条 user 消息（第 0 步前） */
  commitUser(input: string, agentId: string): Promise<void>;
  /** 事件出口（CLI 打印 / 未来 SSE） */
  onEvent(e: LLMEvent): void;
  /** 可选：上下文压缩前检查——超阈值时写一条 compaction 消息。循环开始时调用一次。 */
  maybeCompact?(): Promise<void>;
  /** 本轮最多多少步（防跑飞） */
  steps?: number;
  /** 中止信号 */
  signal: AbortSignal;
}

export async function runLoop(agent: AgentDef, input: string, deps: LoopDeps): Promise<string> {
  deps.onEvent({ type: "session.status", status: "busy" });
  await deps.commitUser(input, agent.id);
  if (deps.maybeCompact) await deps.maybeCompact();

  let lastText = "";
  const steps = deps.steps ?? 10;
  for (let step = 0; step < steps; step++) {
    deps.onEvent({ type: "step.start" });
    // 组装本次请求
    const { system, messages, tools } = await deps.buildRequest(agent);
    // 调用 LLM（流式 delta 转发给 io）
    const turn = await deps.generate(
      { system, messages, tools },
      {
        signal: deps.signal,
        onText: (d) => deps.onEvent({ type: "text.delta", text: d }),
        onReasoning: (d) => deps.onEvent({ type: "reasoning.delta", text: d }),
      },
    );

    // 收拢本条 assistant 的 parts（含工具执行结果，内嵌在本条里）
    const parts: AssistantPart[] = [];
    if (turn.reasoning) parts.push({ type: "reasoning", text: turn.reasoning });
    if (turn.text) parts.push({ type: "text", text: turn.text });

    // 逐个执行；某工具要求 halt（halt 只在成功时置位，见 tool/runner）就停在本条，剩余调用不再执行。
    // 剩余调用必须补一个带各自 id 的 part：本条消息登记了全部 toolCalls，而 assemble 只回放
    // completed/error——少一个 part，下一次请求的消息形状就是坏的（静默错误，测试专门盯它）。
    let halted = false;
    let haltOutput = "";
    for (const call of turn.toolCalls) {
      if (halted) {
        parts.push({
          type: "tool",
          id: call.id,
          name: call.name,
          state: "error",
          error: "本回合已结束（前一个工具把控制权交回了用户），这次调用没有执行。",
          time: { ran: Date.now(), completed: Date.now() },
        });
        continue;
      }
      const part = await deps.executeTool(agent, call);
      parts.push(part);
      if (part.type === "tool" && part.halt) {
        halted = true;
        haltOutput = part.output ?? "";
      }
    }

    const finish = turn.toolCalls.length ? "tool_calls" : "stop";
    await deps.commitAssistant({ agent: agent.id, parts, finish });
    deps.onEvent({ type: "step.end", finish });

    lastText = parts
      .filter((p): p is Extract<AssistantPart, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("");

    if (!turn.toolCalls.length) break;
    // 有工具调用 → 工具结果已内嵌在 parts，下一轮会以 role:"tool" 回放

    if (halted) {
      // halt 那一步通常没有正文（模型直接调工具），回落到工具自己的确认语，
      // 免得 CLI / 别的调用方拿到一个空回复。
      if (!lastText) lastText = haltOutput;
      break;
    }
  }

  deps.onEvent({ type: "session.status", status: "idle" });
  return lastText;
}
