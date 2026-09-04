/**
 * LLM 层：provider 无关的多轮 chat，支持流式 delta（回调）+ 工具调用循环。
 *
 * - 会话 runner 把历史转成 NeutralMsg 数组调 chat()；
 * - chat() 返回聚合的 assistant turn（text/reasoning/toolCalls），期间通过 onText/onReasoning 实时吐 delta；
 * - runner 自己执行 toolCalls（工具注册表），再把结果作为 role:"tool" 消息续调 chat()——循环直到无工具调用。
 *
 * NeutralMsg（内部）：user/assistant/tool 三元。assistant.toolCalls 由后续 role:"tool" 结果承接。
 * provider 适配：anthropic 需把连续 tool 结果并成一条 tool_result user 消息；openai 用 role:"tool"。
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { JsonSchema, ModelConfig, ToolCall } from "../core/types";

/** 一次工具调用的 schema 描述（喂给模型选工具用） */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export type NeutralMsg =
  | { role: "user"; text: string }
  | { role: "assistant"; text?: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; output: string };

export interface AssistantTurn {
  text: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  finish: "stop" | "tool_calls" | "error";
  usage?: { input: number; output: number };
}

export interface ChatOpts {
  model: ModelConfig;
  system?: string;
  messages: NeutralMsg[];
  tools?: ToolSchema[];
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
}

export async function chat(opts: ChatOpts): Promise<AssistantTurn> {
  switch (opts.model.provider) {
    case "anthropic":
      return chatAnthropic(opts);
    case "openai":
      return chatOpenAI(opts);
    case "mock":
      return chatMock(opts);
  }
}

// ─── Anthropic ───

async function chatAnthropic(opts: ChatOpts): Promise<AssistantTurn> {
  const cfg = opts.model;
  const client = new Anthropic({ apiKey: cfg.apiKey });
  const { system, messages } = toAnthropicMessages(opts.system, opts.messages);

  const stream = client.messages.stream(
    {
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
      system,
      messages,
      tools: opts.tools?.map(toAnthropicTool),
    },
    { signal: opts.signal },
  );

  stream.on("text", (delta) => opts.onText?.(delta));

  const msg = await stream.finalMessage();
  if (msg.stop_reason === "max_tokens") {
    throw new Error(
      `[anthropic] 输出被 max_tokens 截断（stop_reason=max_tokens）。model=${cfg.model} max_tokens=${cfg.maxTokens}。请调大 TALEMATE_MAX_TOKENS。`,
    );
  }

  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const toolCalls: ToolCall[] = msg.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> }));

  const usage = msg.usage;
  return {
    text,
    toolCalls,
    finish: toolCalls.length ? "tool_calls" : "stop",
    usage: { input: usage.input_tokens, output: usage.output_tokens },
  };
}

function toAnthropicMessages(
  system: string | undefined,
  messages: NeutralMsg[],
): { system: string | undefined; messages: Anthropic.MessageParam[] } {
  const out: Anthropic.MessageParam[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user") {
      out.push({ role: "user", content: m.text });
    } else if (m.role === "assistant") {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.text) blocks.push({ type: "text", text: m.text });
      for (const tc of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input as Record<string, unknown> });
      }
      out.push({ role: "assistant", content: blocks });
    } else {
      // tool 结果：anthropic 要求跟在带 tool_use 的 assistant 消息后、并成一条 user(tool_result)
      const results: Anthropic.ToolResultBlockParam[] = [];
      let j = i;
      while (j < messages.length && messages[j].role === "tool") {
        const t = messages[j] as Extract<NeutralMsg, { role: "tool" }>;
        results.push({ type: "tool_result", tool_use_id: t.toolCallId, content: t.output });
        j++;
      }
      out.push({ role: "user", content: results });
      i = j - 1;
    }
  }
  return { system, messages: out };
}

function toAnthropicTool(t: ToolSchema): Anthropic.Tool {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  };
}

// ─── OpenAI 兼容（DeepSeek / Moonshot / OpenAI…） ───

async function chatOpenAI(opts: ChatOpts): Promise<AssistantTurn> {
  const cfg = opts.model;
  const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL || undefined });
  const reasoning = cfg.reasoning;

  const thinkingBody: object =
    reasoning === "off"
      ? { thinking: { type: "disabled" } }
      : { thinking: { type: "enabled" }, reasoning_effort: reasoning };

  const messages = toOpenAIMessages(opts.system, opts.messages);
  const stream = await client.chat.completions.create(
    {
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      messages,
      tools: opts.tools?.map(toOpenAITool),
      ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
      ...thinkingBody,
      stream: true,
    },
    { signal: opts.signal },
  );

  let text = "";
  let reasoningText = "";
  const toolAcc: { id: string; name: string; args: string; index: number }[] = [];
  let finish: "stop" | "tool_calls" | "length" | "error" = "stop";
  let usageIn = 0;
  let usageOut = 0;

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.content) {
      text += delta.content;
      opts.onText?.(delta.content);
    }
    const reason = (delta as { reasoning_content?: string }).reasoning_content;
    if (reason) {
      reasoningText += reason;
      opts.onReasoning?.(reason);
    }
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const acc = (toolAcc[idx] ??= { id: "", name: "", args: "", index: idx });
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name += tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
      }
    }
    const fr = chunk.choices?.[0]?.finish_reason as string | null | undefined;
    if (fr && (fr === "stop" || fr === "tool_calls" || fr === "length" || fr === "error")) {
      finish = fr;
    }
    if (chunk.usage) {
      usageIn = chunk.usage.prompt_tokens ?? usageIn;
      usageOut = chunk.usage.completion_tokens ?? usageOut;
    }
  }

  if (finish === "length") {
    throw new Error(
      `[openai] 输出被 max_tokens 截断（finish_reason=length）。model=${cfg.model} max_tokens=${cfg.maxTokens}。` +
        `若开启思考请调大 TALEMATE_MAX_TOKENS 或设 TALEMATE_REASONING=off。`,
    );
  }

  const toolCalls: ToolCall[] = toolAcc.map((t) => ({
    id: t.id,
    name: t.name,
    input: safeParseArgs(t.args),
  }));

  return {
    text,
    reasoning: reasoningText || undefined,
    toolCalls,
    finish: toolCalls.length ? "tool_calls" : "stop",
    usage: { input: usageIn, output: usageOut },
  };
}

function toOpenAIMessages(
  system: string | undefined,
  messages: NeutralMsg[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.text });
    } else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.text ?? "",
        tool_calls: m.toolCalls?.length
          ? m.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) },
            }))
          : undefined,
      });
    } else {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.output });
    }
  }
  return out;
}

function toOpenAITool(t: ToolSchema): OpenAI.Chat.Completions.ChatCompletionTool {
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } };
}

function safeParseArgs(args: string): Record<string, unknown> {
  if (!args) return {};
  try {
    return JSON.parse(args) as Record<string, unknown>;
  } catch {
    return { _raw: args };
  }
}

// ─── Mock（离线冒烟：验证 runner / 工具循环，不打网络） ───

async function chatMock(opts: ChatOpts): Promise<AssistantTurn> {
  const lastUser = [...opts.messages].reverse().find((m) => m.role === "user")?.text ?? "";
  const tools = opts.tools ?? [];
  // 供冒烟脚本注入剧本：env TALEMATE_MOCK_TOOL=<toolName> 时 mock 先调用一次该工具再收尾。
  // 入参按该工具的 inputSchema.required 字段生成样例值（对 task 之类能通过 needsConfirm 校验）。
  const mockTool = process.env.TALEMATE_MOCK_TOOL;
  if (mockTool && tools.some((t) => t.name === mockTool) && !opts.messages.some((m) => m.role === "tool")) {
    const schema = tools.find((t) => t.name === mockTool)?.inputSchema;
    // task 工具给合法委派（writer 子会话），其余按 schema 采样
    const input =
      mockTool === "task"
        ? { agent: "writer", prompt: "照核心设定与细纲，把第 1 章正文写出来。" }
        : sampleArgs(schema);
    return {
      text: "",
      toolCalls: [{ id: "mock-call-1", name: mockTool, input }],
      finish: "tool_calls",
    };
  }
  const reply = `[mock:${opts.model.model}] 已收到：${truncate(lastUser, 80)}`;
  opts.onText?.(reply);
  return { text: reply, toolCalls: [], finish: "stop" };
}

/** 按 schema.required 生成样例入参（mock 用） */
function sampleArgs(schema: JsonSchema | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!schema?.properties) return out;
  for (const key of schema.required ?? Object.keys(schema.properties)) {
    const p = schema.properties[key];
    out[key] = p.type === "array" ? [] : p.type === "number" ? 1 : "mock " + key;
  }
  return out;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
