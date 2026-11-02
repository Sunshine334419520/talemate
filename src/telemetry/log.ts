/**
 * 事件日志：每个会话一条 `events.jsonl`，只追加、带单调 `seq`，是这份会话的唯一真源。
 *
 * 为什么不是"再写一份 span 文件"：两份可写历史一定会分叉——重放时不知道该信哪一份，去重也没有
 * 稳定身份。这里只有一条线，span 与统计都是它的投影。
 *
 * 三条纪律：
 * 1. `seq` 在进程内由一条队列发放，永远 +1；去重身份是 `sessionId + seq`。
 * 2. 崩溃留下的半行（没有换行结尾）不丢：下一次追加先补一个换行，把它隔开；读的时候跳过坏行。
 * 3. 落盘之后才交给 sink，且 sink 的失败与阻塞都到不了会话（见 `sink.ts`）。
 *
 * 边界：只管"一个会话目录里的 events.jsonl"。消息投影、脱敏、导出都不在这里。
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sessionPaths, talemateHome } from "../core/config";
import { TRACE_SCHEMA_VERSION } from "./events";
import { upgradeEvent } from "./schema";
import type { AnyTraceEvent, TraceEvent, TraceEventData, TraceEventType } from "./events";
import type { TraceSink } from "./sink";

/** 解析一份 JSONL 事件日志。坏行（崩溃留下的半行）跳过——它是常态，不是错误。 */
export function parseEvents(text: string): AnyTraceEvent[] {
  const out: AnyTraceEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = upgradeEvent(JSON.parse(line));
      if (event === null) continue;
      out.push(event);
    } catch {
      // 只可能是末尾那半行：进程在写这一行的中途被杀
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

export class EventLog {
  readonly path: string;
  /** 已发放到的最大 seq；undefined = 还没读过文件 */
  private tailSeq: number | undefined;
  /** 文件末尾是不是一个不完整行——下一次追加要先补换行 */
  private needsNewline = false;
  /** 串行化读改写：并发 append 各自读到同一个尾 seq 就会发出重复身份 */
  private queue: Promise<void> = Promise.resolve();
  private readonly sinks = new Set<TraceSink>();

  constructor(
    readonly home: string,
    readonly projectId: string,
    readonly sessionId: string,
  ) {
    this.path = sessionPaths(home, projectId, sessionId).events;
  }

  /** 追加一条事件，返回带 seq 的完整记录。并发调用按调用顺序发号。 */
  async append<T extends TraceEventType>(
    type: T,
    data: TraceEventData[T],
    at = Date.now(),
  ): Promise<TraceEvent<T>> {
    const run = this.queue.then(async () => {
      const seq = (await this.currentTail()) + 1;
      const event: TraceEvent<T> = {
        schemaVersion: TRACE_SCHEMA_VERSION,
        sessionId: this.sessionId,
        seq,
        time: at,
        type,
        data,
      };
      await mkdir(dirname(this.path), { recursive: true });
      // 半行没有换行结尾：直接接上去会把新事件粘进那条坏行里，两个都读不出来
      await appendFile(this.path, `${this.needsNewline ? "\n" : ""}${JSON.stringify(event)}\n`, "utf-8");
      this.needsNewline = false;
      this.tailSeq = seq;
      // TraceEvent<T> 对泛型 T 不可直接赋给联合；它本来就落在联合里，只是编译器收不窄
      this.publish(event as AnyTraceEvent);
      return event;
    });
    // 队尾只留一个"已结束"的信号：一次写失败不能毒住后面每一次追加
    this.queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** 读全部事件（按 seq 排序）。会先等掉排队中的写入，否则读到的是"少了最后几条"的历史。 */
  async read(): Promise<AnyTraceEvent[]> {
    await this.queue;
    const events = await this.readFile();
    this.tailSeq = events.at(-1)?.seq ?? 0;
    return events;
  }

  attachSink(sink: TraceSink): void {
    this.sinks.add(sink);
  }

  detachSink(sink: TraceSink): void {
    this.sinks.delete(sink);
  }

  private async currentTail(): Promise<number> {
    // 不能走 `read()`：它等的是这条队列本身，在队列里调它等于等自己
    if (this.tailSeq === undefined) {
      const events = await this.readFile();
      this.tailSeq = events.at(-1)?.seq ?? 0;
    }
    return this.tailSeq;
  }

  private async readFile(): Promise<AnyTraceEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf-8");
    } catch {
      return []; // 还没有日志：新会话、或者旧会话第一次被追加
    }
    this.needsNewline = raw.length > 0 && !raw.endsWith("\n");
    return parseEvents(raw);
  }

  /**
   * 交给 sink。`emit` 契约上只入队，但这里仍然包一层 try：一个写坏的消费者不该让会话掉线。
   * 注意这是同步调用——非阻塞是 sink 的责任，不是这里的。
   */
  private publish(event: AnyTraceEvent): void {
    for (const sink of this.sinks) {
      try {
        sink.emit(event);
      } catch {
        // 传输层的失败属于传输层：canonical 日志已经落盘，观测丢一条不等于会话丢一条
      }
    }
  }
}

const logs = new Map<string, EventLog>();

/**
 * 同一进程里一个会话一份 EventLog——尾 seq 与写入队列必须有单一持有者。
 * 键带 home：测试与多套 TALEMATE_HOME 会因为同名的 project/session 撞在一起。
 */
export function eventLogFor(projectId: string, sessionId: string, home = talemateHome()): EventLog {
  const key = join(home, projectId, sessionId);
  let log = logs.get(key);
  if (log === undefined) {
    log = new EventLog(home, projectId, sessionId);
    logs.set(key, log);
  }
  return log;
}

/** 只给测试：换一份 home 或删掉目录之后，缓存的尾 seq 就不再成立。 */
export function resetEventLogs(): void {
  logs.clear();
}
