/**
 * LLM 层跨层类型：loop / context / session 复用，故独立成 llm/types。
 * NeutralMsg / AssistantTurn / ToolSchema 是 provider 无关的内部形状；provider 适配见 provider.ts。
 */
import type { JsonSchema, ToolCall } from "../core/types";

/** 一次工具调用的 schema 描述（喂给模型选工具用） */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/** provider 无关的消息三元：user / assistant / tool */
export type NeutralMsg =
  | { role: "user"; text: string }
  | { role: "assistant"; text?: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; output: string };

/** 一次 LLM 交互的聚合结果（text/reasoning/toolCalls） */
export interface AssistantTurn {
  text: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  finish: "stop" | "tool_calls" | "error";
  usage?: { input: number; output: number };
}
