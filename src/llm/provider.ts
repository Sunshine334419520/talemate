/**
 * LLM 层：provider 无关的多轮 chat——把历史转成 NeutralMsg[] 调 chat()，返回聚合的 assistant turn，
 * 期间用 onText/onReasoning 实时吐流式 delta；工具由 runner 自己执行、结果作为 role:"tool" 续调，
 * 循环到无工具调用为止。provider 差异见各自实现（anthropic 要把连续 tool 结果并成一条）。
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { JsonSchema, ModelConfig, ToolCall } from "../core/types";
import type { AssistantTurn, NeutralMsg, ToolSchema } from "./types";

export interface ChatOpts {
  model: ModelConfig;
  system?: string;
  messages: NeutralMsg[];
  tools?: ToolSchema[];
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  /** 工具调用刚开始、参数还在流的时候发一次——让界面能显示“正在准备…” */
  onToolCallStart?: (call: { id: string; name: string }) => void;
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
  // 工具调用的参数可能很长（整章正文/整份设计稿）；在 content_block_start 就报一声，
  // 别等 finalMessage 才让界面知道它在干活
  stream.on("streamEvent", (event) => {
    if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
      opts.onToolCallStart?.({ id: event.content_block.id, name: event.content_block.name });
    }
  });

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

  // Gemini 的 OpenAI 兼容层只认 reasoning_effort，不认 DeepSeek 的 thinking 字段。
  // 按 base URL 分流，避免给 Gemini 发一个它不认识的参数。
  const isGemini = cfg.baseURL?.includes("generativelanguage.googleapis.com") ?? false;
  const thinkingBody: object = isGemini
    ? { reasoning_effort: geminiReasoning(reasoning) }
    : reasoning === "off"
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
  /** 已经报过 start 的工具序号——name 可能分几个 delta 到达，只在第一次有名字时报 */
  const startedTools = new Set<number>();
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
        if (!startedTools.has(idx) && acc.name !== "") {
          startedTools.add(idx);
          opts.onToolCallStart?.({ id: acc.id || `tool-${idx}`, name: acc.name });
        }
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
      `[openai] 输出被 max_tokens 截断（finish_reason=length）。model=${cfg.model} max_tokens=${cfg.maxTokens}. ` +
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

/** Gemini 的 reasoning_effort 只有 minimal / low / medium / high；我们的 max 映射到 high。 */
function geminiReasoning(reasoning: ModelConfig["reasoning"]): "minimal" | "low" | "medium" | "high" {
  if (reasoning === "off") return "minimal";
  if (reasoning === "max") return "high";
  return reasoning;
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

/**
 * 解析模型返回的 tool arguments 字符串。openai 兼容模型（尤其 DeepSeek）偶尔给出不规范 JSON：
 * 套代码围栏、字符串内未转义换行、尾逗号、双层转义。逐层剥离 → 解析 → 修补 → 回退 {}，
 * 回退空对象由工具自身的必填守卫返回"请重发"，让模型自纠。
 */
export function safeParseArgs(raw: string | undefined): Record<string, unknown> {
  let s = (raw ?? "").trim();
  if (!s) return {};
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const tryParse = (t: string): unknown => {
    try {
      return JSON.parse(t);
    } catch {
      return undefined;
    }
  };
  const toObj = (v: unknown): Record<string, unknown> | undefined =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  const direct = toObj(tryParse(s));
  if (direct) return direct;
  // 双层转义：parsed 成功但得到的是字符串（其内容又是一段 JSON）
  const first = tryParse(s);
  if (typeof first === "string") {
    const nested = toObj(tryParse(first));
    if (nested) return nested;
  }
  const patched = toObj(tryParse(repairJson(s)));
  if (patched) return patched;
  return {};
}

/** 轻量修补常见 LLM 坏 JSON：去尾逗号 + 把字符串字面量内的裸换行/制表转义。 */
function repairJson(s: string): string {
  const noTrailing = s.replace(/,\s*([}\]])/g, "$1");
  let out = "";
  let inStr = false;
  let esc = false;
  for (const ch of noTrailing) {
    if (esc) {
      out += ch;
      esc = false;
      continue;
    }
    if (inStr && ch === "\\") {
      out += ch;
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      out += ch;
      continue;
    }
    if (inStr) {
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        out += "\\r";
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
    }
    out += ch;
  }
  return out;
}

// ─── Mock（离线冒烟：验证 runner / 工具循环，不打网络） ───

/** 冒烟剧本：propose-design 的一份合法草稿（必须带该层规范的小节标题，否则会被工具守卫拒）。 */
const MOCK_PROPOSAL = [
  "# 核心设定",
  "",
  "## 题材 · 频道",
  "男频 · 都市异能",
  "",
  "## 一句话简介",
  "沈越，被逐出家族的前首席，靠一门不能见光的本事往回爬。",
  "",
  "## 金手指 / 超常设定",
  "（待定）",
  "",
  "## 文风",
  "storytelling",
  "",
].join("\n");

async function chatMock(opts: ChatOpts): Promise<AssistantTurn> {
  const lastUser = [...opts.messages].reverse().find((m) => m.role === "user")?.text ?? "";
  const tools = opts.tools ?? [];
  // 剧本由 env TALEMATE_MOCK_TOOL=<toolName> 注入：mock 先调一次该工具再收尾，入参按 inputSchema.required 采样
  // 「演过一次就收尾」按工具名判，不是"窗口里有没有任何 tool 消息"——冒烟要能演
  // "第一回合调 A、用户回话后第二回合调 B"这种两回合流程（如 propose-plan → task）
  const mockTool = process.env.TALEMATE_MOCK_TOOL;
  const alreadyPlayed = opts.messages.some((m) => m.role === "tool" && m.name === mockTool);
  if (mockTool && tools.some((t) => t.name === mockTool) && !alreadyPlayed) {
    const schema = tools.find((t) => t.name === mockTool)?.inputSchema;
    // task 工具给合法委派（planner 子会话），其余按 schema 采样
    const input =
      mockTool === "task"
        ? { agent: "planner", prompt: "把第 1 章的规划做出来。" }
        : mockTool === "propose-design"
          ? { path: "design/core.md", content: MOCK_PROPOSAL }
          : sampleArgs(schema);
    opts.onToolCallStart?.({ id: "mock-call-1", name: mockTool });
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

/** 按 schema 生成样例入参（mock 用）。数组给一个样例元素，嵌套对象递归。 */
function sampleValue(schema: JsonSchema | undefined): unknown {
  if (schema === undefined) return "mock";
  if (schema.type === "array") return [sampleValue(schema.items)];
  if (schema.type === "object") return sampleArgs(schema);
  if (schema.type === "number") return 1;
  if (schema.type === "boolean") return true;
  return "mock";
}

function sampleArgs(schema: JsonSchema | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (schema === undefined || schema.type !== "object" || !schema.properties) return out;
  for (const key of schema.required ?? Object.keys(schema.properties)) {
    out[key] = sampleValue(schema.properties[key]);
  }
  return out;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export type { AssistantTurn, NeutralMsg, ToolSchema };
