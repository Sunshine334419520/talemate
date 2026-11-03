/**
 * 请求详情：由日志折叠出某一步实际发给模型的三块——header（配置+工具）、system prompt、消息窗口。
 *
 * 不存请求体：这套设计的前提是"模型可见 ⟺ 已持久引用"。这里只做纯折叠，
 * 不读文件、不调模型；旧日志没有 system/prompt 或 header 快照时，对应字段就是缺失，不猜。
 *
 * 边界：消息用 `projectMessages` 的同一份投影，再按最后一次 compaction 截窗（与 loadModelWindow 同义）。
 */
import type { StoredMessage } from "../core/types";
import type { AnyTraceEvent } from "./events";
import { projectMessages } from "./projection";

export interface RequestDetail {
  /** 该步 `request/header` 的 seq */
  seq: number;
  step: number;
  config: {
    provider: string;
    model: string;
    temperature: number | null;
    maxTokens: number;
    reasoning?: string;
  };
  /** 最近一次带完整 tools 的 header 快照 */
  tools?: NonNullable<(AnyTraceEvent & { type: "request/header" })["data"]["tools"]>;
  system?: { seq: number; text: string; hash: string };
  context?: { provider: string; model: string; contextWindow?: number };
  /** 该步请求里的消息窗口（不含 system；system 走 ChatOpts.system） */
  messages: StoredMessage[];
}

function windowMessages(messages: StoredMessage[]): StoredMessage[] {
  let start = 0;
  for (let i = 0; i < messages.length; i++) if (messages[i]?.role === "compaction") start = i;
  return messages.slice(start);
}

export function buildRequestDetail(events: readonly AnyTraceEvent[], headerSeq: number): RequestDetail | null {
  const eventsUpTo = events.filter((event) => event.seq <= headerSeq);
  const headerEvent = eventsUpTo.find((event) => event.seq === headerSeq && event.type === "request/header");
  if (headerEvent?.type !== "request/header") return null;
  const header = headerEvent.data;

  let system: RequestDetail["system"];
  let tools: RequestDetail["tools"];
  let context: RequestDetail["context"];
  for (const event of eventsUpTo) {
    if (event.type === "system/prompt") {
      system = { seq: event.seq, text: event.data.text, hash: event.data.hash };
    } else if (event.type === "request/header" && event.data.tools !== undefined && event.data.tools.length > 0) {
      tools = event.data.tools;
    } else if (event.type === "request/context") {
      context = {
        provider: event.data.provider,
        model: event.data.model,
        ...(event.data.contextWindow === undefined ? {} : { contextWindow: event.data.contextWindow }),
      };
    }
  }

  return {
    seq: headerSeq,
    step: header.step,
    config: {
      provider: header.provider,
      model: header.model,
      temperature: header.temperature,
      maxTokens: header.maxTokens,
      ...(header.reasoning === undefined ? {} : { reasoning: header.reasoning }),
    },
    ...(tools === undefined ? {} : { tools }),
    ...(system === undefined ? {} : { system }),
    ...(context === undefined ? {} : { context }),
    messages: windowMessages(projectMessages(eventsUpTo)),
  };
}
