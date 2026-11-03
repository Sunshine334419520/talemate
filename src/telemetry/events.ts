/**
 * 会话事件（canonical log）的形状：一次会话发生过的每一件事，按单调 `seq` 排成一条只追加的线。
 *
 * 它是唯一真源——messages、span、统计都是从这里折出来的投影（见 `projection.ts`）。所以加事件类型
 * 之前先问一句：它能不能由已有事件推出来？能就别加。反过来，**失败也要留下事件**：一次没有产出
 * 正文的调用在消息里根本不存在，只有 `assistant/attempt` 记得它发生过。
 *
 * 边界：只定义形状与版本号，不碰文件、不碰投影。写入在 `log.ts`，折叠在 `projection.ts`。
 */
import type { StoredMessage, ToolState } from "../core/types";
import type { ToolSchema } from "../llm/types";

/** 日志格式版本。改字段含义就加一，消费方靠它决定怎么读旧记录。 */
export const TRACE_SCHEMA_VERSION = 2;

/** 失败只有名字和一句话：堆栈属于调试器，不属于会话账本。 */
export interface TraceError {
  name: string;
  message: string;
}

export interface TraceUsage {
  input: number;
  output: number;
}

/** 一轮（一次用户输入到模型停下）的结局。 */
export type TurnStatus = "completed" | "error" | "aborted";

/** 一步（一次模型请求）的结局。`error` 表示这次请求没拿到完整回应。 */
export type StepFinish = "stop" | "tool_calls" | "error";

/**
 * 一次模型请求的结局。`ok` 不在这里：成功的那一步由 `step/start`+`step/end` 表示。
 * 只有"没产出消息"的尝试才需要单独记——它们在任何消息投影里都不存在。
 */
export type AttemptOutcome = "error" | "interrupted";

/** 请求三段各自的字符数；与 `LLMEvent.usage.parts` 同口径（真总数、分摊构成）。 */
export interface TraceRequestChars {
  system: number;
  tools: number;
  messages: number;
}

/**
 * 事件类型 → data 形状。键即 `TraceEvent["type"]`，加一类事件只改这张表。
 *
 * 工具入参/结果正文**不复制**到这里：它们已经随 `assistant/message` 落盘，再存一份就是第二份
 * 真源。这里只留边界上才拿得到的事实（耗时、状态、字符数、错误），span 与统计靠它们。
 */
export interface TraceEventData {
  "session/start": {
    agent: string;
    model: string;
    provider: string;
    title: string;
    depth?: number;
    parentSessionId?: string;
  };
  /** 旧会话迁移：把已有消息一次性搬进事件日志（现在不再产生，只为读旧日志保留）。 */
  "session/seed": { messages: StoredMessage[] };
  /** 就地回退：投影丢掉 `seq >= targetSeq` 的消息；历史本身不删，只被这条事件遮住。 */
  "session/rewind": { targetSeq: number };
  "turn/start": { agent: string; resumed: boolean };
  "turn/end": { status: TurnStatus; durationMs: number; error?: TraceError };
  "step/start": { step: number };
  /** 渲染后的 system prompt。按变化才写；它不是 messages 投影的一部分，模型上下文仍走 ChatOpts.system。 */
  "system/prompt": { step: number; text: string; hash: string };
  /**
   * 一次请求的"头"：模型参数与三段 hash，不含正文。
   * 它把在线 trace 与 eval manifest 接起来——两边用同一份 hash，才能互相指认。
   */
  "request/header": {
    step: number;
    /** 只有完整快照带 reason：首个请求 initial，配置/工具变化 change；其余 step 沿用最新快照 */
    reason?: "initial" | "change";
    /** 只有完整快照带 tools：完整 schema，供请求详情重建 */
    tools?: ToolSchema[];
    agent: string;
    provider: string;
    model: string;
    temperature: number | null;
    maxTokens: number;
    reasoning?: string;
    systemHash: string;
    toolsHash: string;
    messagesHash: string;
    promptHash: string;
    systemChars: number;
    toolsChars: number;
    messagesChars: number;
    depth?: number;
    parentSessionId?: string;
  };
  /** 路由元数据：provider/model/contextWindow 变化时才写 */
  "request/context": { provider: string; model: string; contextWindow?: number };
  "step/end": {
    step: number;
    finish: StepFinish;
    durationMs: number;
    usage?: TraceUsage;
    requestChars?: TraceRequestChars;
  };
  "assistant/attempt": {
    step: number;
    outcome: AttemptOutcome;
    durationMs: number;
    streamedChars: number;
    error: TraceError;
  };
  "user/message": { message: StoredMessage };
  "assistant/message": { message: StoredMessage };
  "compaction/start": { model: string };
  "compaction/summary": { message: StoredMessage };
  "compaction/end": { durationMs: number; ok: boolean; compacted: boolean };
  /** `step` 缺省 = 不是某一轮模型请求发起的（例如 harness 代模型执行 apply-design） */
  "tool/call": { callId: string; name: string; inputChars: number; step?: number };
  "tool/result": {
    callId: string;
    name: string;
    state: ToolState;
    outputChars: number;
    durationMs: number;
    error?: string;
    change?: { path: string; kind: string };
  };
}

/**
 * 运行时事件类型表：`Record<TraceEventType, true>` 是穷尽的——给 `TraceEventData` 加一条
 * 却忘了更新这里，编译就会报错。读日志时靠它拒绝未知类型。
 */
const EVENT_TYPES: Record<TraceEventType, true> = {
  "session/start": true,
  "session/seed": true,
  "session/rewind": true,
  "turn/start": true,
  "turn/end": true,
  "step/start": true,
  "system/prompt": true,
  "request/header": true,
  "request/context": true,
  "step/end": true,
  "assistant/attempt": true,
  "user/message": true,
  "assistant/message": true,
  "compaction/start": true,
  "compaction/summary": true,
  "compaction/end": true,
  "tool/call": true,
  "tool/result": true,
};

const EVENT_TYPE_SET = new Set<string>(Object.keys(EVENT_TYPES));

export function isTraceEventType(value: string): value is TraceEventType {
  return EVENT_TYPE_SET.has(value);
}

export type TraceEventType = keyof TraceEventData;

export interface TraceEvent<T extends TraceEventType = TraceEventType> {
  schemaVersion: typeof TRACE_SCHEMA_VERSION;
  sessionId: string;
  /** 单调、永不复用。去重与重放的身份就是 `sessionId + seq`。 */
  seq: number;
  time: number;
  type: T;
  data: TraceEventData[T];
}

/** 判别联合：`switch (e.type)` 之后 `e.data` 自动收窄。 */
export type AnyTraceEvent = { [K in TraceEventType]: TraceEvent<K> }[TraceEventType];

/**
 * 参与 messages 投影的事件类型——`projectMessages` 与存储层的"事件优先"判据都从这里取。
 * 加一种消息事件只改这一行，不要在两处各抄一份。
 */
export const MESSAGE_EVENT_TYPES = [
  "session/seed",
  "user/message",
  "assistant/message",
  "compaction/summary",
] as const;

export type MessageEventType = (typeof MESSAGE_EVENT_TYPES)[number];

export function isMessageEventType(type: string): type is MessageEventType {
  return (MESSAGE_EVENT_TYPES as readonly string[]).includes(type);
}

/** 判别联合里的消息事件：`data` 不是 `{ message }` 就是 `{ messages }`。 */
export type MessageTraceEvent = Extract<AnyTraceEvent, { type: MessageEventType }>;

export function isMessageEvent(event: AnyTraceEvent): event is MessageTraceEvent {
  return isMessageEventType(event.type);
}

