import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export type Provider = "anthropic" | "openai";

/** 推理强度：off = 关闭思考（DeepSeek V4 / OpenAI 推理模型支持）；low/high/max = 开启 */
export type Reasoning = "off" | "low" | "high" | "max";

export interface LLMConfig {
  provider: Provider;
  apiKey?: string;
  model: string;
  baseURL?: string;
  maxTokens: number;
  reasoning: Reasoning;
  /** 采样温度。注意：DeepSeek V4 官方文档声明 temperature/top_p 无效（静默忽略） */
  temperature?: number;
}

/** 从环境变量加载配置（bun run 自动加载 .env） */
export function loadLLMConfig(env = process.env): LLMConfig {
  const provider = (env.TALEMATE_PROVIDER as Provider) || "anthropic";
  const model = env.TALEMATE_MODEL || (provider === "anthropic" ? "claude-opus-5" : "gpt-4o");
  const reasoning = (env.TALEMATE_REASONING as Reasoning) || "off";
  const userMaxTokens = Number(env.TALEMATE_MAX_TOKENS) || 16000;
  // 思考模式会先烧大量 token 做推理；开着思考时把输出预算抬高，避免正文被截断
  const maxTokens = reasoning !== "off" ? Math.max(userMaxTokens, 32000) : userMaxTokens;
  const temperature = env.TALEMATE_TEMPERATURE ? Number(env.TALEMATE_TEMPERATURE) : undefined;
  return {
    provider,
    apiKey: env.TALEMATE_API_KEY || undefined,
    baseURL: env.TALEMATE_API_BASE || undefined,
    model,
    maxTokens,
    reasoning,
    temperature,
  };
}

let anthropicClient: Anthropic | undefined;
let openaiClient: OpenAI | undefined;

export interface ChatResult {
  /** 最终可见文本 */
  content: string;
  /** 思考过程（reasoning_content）。DeepSeek 思考模式返回；Anthropic / 非思考模式下为空 */
  reasoning?: string;
}

/** 单次对话：system + user → 文本 + 思考过程。写手/批评者/盲评共用。 */
export async function chat(config: LLMConfig, system: string, user: string): Promise<ChatResult> {
  if (config.provider === "anthropic") return chatAnthropic(config, system, user);
  return chatOpenAI(config, system, user);
}

async function chatAnthropic(config: LLMConfig, system: string, user: string): Promise<ChatResult> {
  if (!anthropicClient) {
    anthropicClient = config.apiKey ? new Anthropic({ apiKey: config.apiKey }) : new Anthropic();
  }
  // 流式防止长输出超时；max_tokens 给足，让模型按提示自限 2000-3000 字
  const stream = anthropicClient.messages.stream({
    model: config.model,
    max_tokens: config.maxTokens,
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    system,
    messages: [{ role: "user", content: user }],
  });
  const message = await stream.finalMessage();
  return {
    content: message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(""),
  };
}

async function chatOpenAI(config: LLMConfig, system: string, user: string): Promise<ChatResult> {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL || undefined });
  }
  // DeepSeek V4 默认开启思考（reasoning），会把 max_tokens 预算吃掉大半导致正文被截断。
  // 默认 off：判据/纪律已写进 prompt，写作不需要额外推理。
  // 用 spread 注入 DeepSeek 私有字段 thinking（spread 不触发多余属性检查），reasoning_effort 是 SDK 原生字段。
  const thinkingBody: object =
    config.reasoning === "off"
      ? { thinking: { type: "disabled" } }
      : { thinking: { type: "enabled" }, reasoning_effort: config.reasoning };
  const completion = await openaiClient.chat.completions.create({
    model: config.model,
    max_tokens: config.maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...thinkingBody,
  });
  const choice = completion.choices?.[0];
  const content = choice?.message?.content ?? "";
  // 思考过程：DeepSeek 思考模式把推理放在 message.reasoning_content（OpenAI 兼容字段）
  const reasoning = (choice?.message as any)?.reasoning_content ?? undefined;
  // 截断检测：finish_reason=length 意味着输出被 max_tokens 掐断，绝不能静默当成完整稿
  if (choice?.finish_reason === "length") {
    throw new Error(
      `输出被 max_tokens 截断（finish_reason=length）。` +
        `model=${config.model} max_tokens=${config.maxTokens} 实际=${completion.usage?.completion_tokens ?? "?"}` +
        (completion.usage && "completion_tokens_details" in completion.usage
          ? ` (reasoning_tokens=${(completion.usage as any).completion_tokens_details?.reasoning_tokens ?? "?"})`
          : "") +
        `. 若开启了思考请调大 TALEMATE_MAX_TOKENS，或设 TALEMATE_REASONING=off。`,
    );
  }
  return { content, reasoning };
}
