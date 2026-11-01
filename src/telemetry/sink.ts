/**
 * 捕获出口：canonical 事件落盘之后，再复制一份给外部消费者（评测读取器、将来的 OTel backend）。
 *
 * 契约只有一条：`emit` 必须是**入队**——不做 I/O、不抛。它跑在会话热路径上，一次慢写或一次异常
 * 就会拖慢/打断 agent loop。批量、重试、丢失策略都归 sink 自己（capture / transport 分离），
 * 会话侧只负责在事件成立的那一刻把它交出去。
 *
 * 边界：不认识事件内容，也不改写它。脱敏在导出侧做（见 `redact.ts`），canonical 日志永不改写。
 */
import type { AnyTraceEvent } from "./events";

export interface TraceSink {
  /** 只入队。允许丢，不允许阻塞，不允许抛。 */
  emit(event: AnyTraceEvent): void;
  flush?(): void | Promise<void>;
  shutdown?(): Promise<void>;
}

/** 进程内收集器：测试与"本次运行里看一眼"用。它就是把事件 push 进数组，所以天然满足非阻塞。 */
export class MemoryTraceSink implements TraceSink {
  readonly events: AnyTraceEvent[] = [];

  emit(event: AnyTraceEvent): void {
    this.events.push(event);
  }
}
