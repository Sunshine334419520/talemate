# 架构评审：看完 DeepSeek Harness 之后，我们的评测与可观测性该怎么改

> **职责**：把 DSH 的会话事件、session-telemetry、OTel 后端与 session-stats 对照到我们的 eval/trace 设计上，明确哪些保留、哪些修正、哪些只是 DSH 的部署约束。
> **读者**：准备开始实现 eval/trace、但不想先写错底座的我。
> **对齐代码**：阶段 1 已落地（`src/telemetry/`，见 `../../telemetry.md`）· 参考 DSH 当前 checkout（2026-10-31）· 对齐手册 §1.2 / §4 / §5

---

## 一句话结论

> **我们的评测方法论是对的，trace 底座要改。**  
> 从“Span-first 的独立日志”改成“**canonical append-only event log 是唯一真源，Span / stats / messages 是投影**”。  
> 这不是审美问题：DSH 已经明确踩过“span 对 fork/中断/重试有损”和“两份日志制造第二真源”这两个坑。

---

## 1. DSH 实际是什么样

### 1.1 Session 是 append-only 事件日志

DSH 的 `Session` 不是“消息 + 另一份 trace”，而是唯一真源：

```text
turn/start
step/start
user/message
assistant/message      ← 带完整 compact stream
assistant/attempt      ← 失败/重试/中断也保留
tool/call
tool/result            ← 含 error.name / code / reason
request/header
compaction/*
feedback/record
turn/end
```

消息历史从事件日志**派生**，不单独存储。  
对应源码：

```text
packages/core/session/src/types.ts
packages/llm/llm/src/assistant-stream.ts
packages/session/session-stats/src/projection.ts
```

关键点：

- 每个事件有 `seq` / `time` / `type` / `data`；
- `assistant/attempt` 保留“没有产生 surface message”的失败尝试；
- `surfaceOp` / `sourceEventSeqs` 让 fork、替换、引用关系可还原；
- `session/end-seed` 把继承/fork 历史与本次生命周期切开。

### 1.2 telemetry 是下游捕获，不是第二真源

`session-telemetry` 为每个 canonical event 生成一条 ledger record：

```ts
interface SessionTelemetryRecord {
  sourceEvent?: { sessionId; envelope: Omit<SessionEvent, "data"> };
  channel: "ledger" | "ops";
  time: number;
  severity: "info" | "warn" | "error";
  attributes: Record<string, string | number>;
  body: unknown;   // data 的深拷贝，可被 redaction
}
```

设计要点：

- **capture / transport 分离**：coordinator 负责捕获、脱敏、交接；后端负责批量、重试、丢失策略；
- **redaction waterfall**：每条导出记录在 `emit` 前过 `session-telemetry/record`；抛异常即扣下（fail-closed）；
- **canonical log 永不改写**；脱敏只作用于导出副本；
- **非阻塞**：`emit()` 必须是队列 push，不能拖慢 agent loop；
- **best-effort**：游标标记“已交接”，不是“已送达”；接收端按 `(session.id, format_version, seq)` 去重；
- **live / on-demand**：live 跟事件流；on-demand 从 canonical log 读前缀；
- **默认关闭 / 反馈门控**：OTel 后端 `DISABLED` / `FEEDBACK_ONLY`，不是默认上传。

对应源码：

```text
packages/session/session-telemetry/src/index.ts
packages/session/session-telemetry/src/coordinator.ts
packages/session/session-telemetry-otel/src/index.ts
```

### 1.3 OTel 用的是 logs，不是 spans

DSH 的 telemetry 决策记录里明确否决了“映射到 OTel span（GenAI 语义约定）”：

> span 模型对可 fork、可中断的会话有损，留给将来真正有 span 查询需求的消费方。

所以它先把完整事件作为 OTLP **logs** 导出。  
这不是“还没做 span”，而是一个有意的选择：**先保证事件完整，再谈查询视图。**

### 1.4 session-stats 是纯投影

`sessionStats` 从完整日志折叠出 turns/steps/llmMs/toolMs/ttft/decode：

- 分页、压缩不改数字；
- 统计口径只有一处；
- UI 和 eval 可以共享同一个投影。

### 1.5 DSH 没有“prompt 质量 eval”

DSH 有：

- 单元测试 / 类型检查；
- benchmarks（性能门禁）；
- feedback（用户信号）；
- session telemetry / inspector。

但它没有我们手册里那套 **rubric / pairwise / pass^k / eval case** 的 prompt 质量评测体系。  
所以：

- **事件底座可以学 DSH**；
- **评测方法论不能拿 DSH 当答案**，它只提供事件、投影和反馈的基座。

---

## 2. 我们原设计哪些保留，哪些修正

| 原设计 | DSH 对照 | 结论 |
|---|---|---|
| 两个坐标系：eval vs observability | 同一份会话事件喂不同消费者 | 保留 |
| 闭环：假设→单变量→重复→配对→决策→沉淀 | DSH 不直接覆盖，但事件日志能提供原料 | 保留 |
| 四维 / L1–L6 | DSH 的 feedback/benchmark 可对应部分级别 | 保留 |
| `LLMEvent` 不动，另加 `TraceSink` | DSH 也把 UI 与会话日志分开 | 保留“分开”，但通道要改 |
| `Span` / `spans.jsonl` 作为独立真源 | DSH 用 canonical session log，span 是派生物 | **修正** |
| `spans.jsonl` + `messages.jsonl` 两份数据 | DSH 只有一份 canonical log | **修正** |
| 只记 span，不记 attempt/retry/interrupt | DSH 专门保留 `assistant/attempt`、`llm/retry` | **修正** |
| OTel spans 优先 | DSH 先用 OTLP logs，span 有损 | **推迟** |
| 本地 JSONL，无脱敏 | DSH 有强制脱敏点、默认不导出 | **补上** |
| eval 读 trace | DSH 的 projection 模式可复用 | 保留，但读事件而非独立 span 文件 |

---

## 3. 修正后的目标架构

```text
                 ┌──────────────────────────────┐
                 │ canonical append-only events │  ← 唯一真源
                 │ turn/step/chat/tool/attempt  │
                 └──────────────┬───────────────┘
                                │
          ┌─────────────────────┼─────────────────────┐
          ▼                     ▼                     ▼
   ┌─────────────┐       ┌─────────────┐       ┌─────────────┐
   │ messages    │       │ spans/stats │       │ eval reader │
   │ projection  │       │ projection  │       │ + replay    │
   └─────────────┘       └─────────────┘       └─────────────┘
          │                     │                     │
          ▼                     ▼                     ▼
       UI 历史              延迟/成本/失败桶       case / report
```

核心原则：

1. **一份 canonical event log**；
2. messages、spans、stats 都是**纯投影**；
3. capture 与 transport 分开；
4. 边界埋点，不从文本重建；
5. 脱敏在导出前，canonical log 不改；
6. OTel 以后再加，先不引 SDK。

---

## 4. 具体 schema 建议

### 4.1 `TraceEvent`：canonical

```ts
export interface TraceEvent {
  schemaVersion: 1;
  sessionId: string;
  seq: number;
  time: number;
  type:
    | "turn/start"
    | "turn/end"
    | "step/start"
    | "step/end"
    | "assistant/message"
    | "assistant/attempt"
    | "tool/call"
    | "tool/result"
    | "compaction/start"
    | "compaction/summary"
    | "compaction/end"
    | "feedback";
  data: unknown;
  surfaceOp?: unknown;
  sourceEventSeqs?: number[];
}
```

- `seq` 是排序与去重的身份；
- `time` 是追加时间；
- `assistant/attempt` 保留失败/重试/中断；
- `tool/result` 带 `error.name/code/reason`；
- `feedback` 是 L6 信号。

### 4.2 `Span`：派生的查询视图

```ts
export interface Span {
  traceId: string;       // = sessionId（或 sessionId + lifecycle）
  spanId: string;        // 由 seq 派生，稳定
  parentId?: string;     // turn/step/tool 关系
  name: "invoke_agent" | "chat" | "execute_tool" | "compaction";
  startMs: number;
  durationMs: number;
  status: "ok" | "error";
  attrs: Record<string, string | number | boolean>;
  error?: { type: string };
}
```

**Span 不是真源**，是从事件折叠出来的：

```text
turn/start + turn/end          → invoke_agent
assistant/message + attempt    → chat（含 retry/中断）
tool/call + tool/result        → execute_tool
compaction/start + end          → compaction
```

### 4.3 `TraceSink`：捕获出口

```ts
export interface TraceSink {
  emit(event: TraceEvent): void;   // 非阻塞
  flush?(): void;
  shutdown?(): Promise<void>;
}
```

- `emit` 只做入队；
- 真正的 JSONL 写入、批量、重试由 backend 做；
- 失败不能影响 agent loop；
- 后面接 OTel 时只换 backend，不换事件。

---

## 5. 需要先拍板的 ADR

### ADR-1：canonical event log 还是 sidecar？

**推荐：canonical event log。**  
理由：DSH 已经证明“两份可写历史”会产生 join、重放、去重和归因问题。  
代价：talemate 现在 `messages.jsonl` 是消息日志，不是完整事件日志，需要迁移。  
退路：如果迁移成本太高，`events.jsonl` 只能是 **projection sidecar**，不能反向成为第二真源；messages 仍由事件投影。

### ADR-2：`messages.jsonl` 是否改成投影？

**推荐：目标形态是投影。**  
短期可以保留现有 messages 写入器，但同时写事件；两条写路径必须有单向派生关系，不能各自独立生成正文。

### ADR-3：OTel logs 还是 spans？

**推荐：先本地事件，后 OTel；OTel 先接 logs。**  
理由：DSH 的 fork/中断/重试证据；span 有损。  
等有真正的 span 查询需求，再从事件派生 span 导出。

### ADR-4：脱敏与默认导出

**推荐：默认本地、默认不导出；导出前强制 redaction。**  
理由：trace 会带文件内容、命令输出、提示词；本地 eval 也一样需要脱敏策略。  
canonical log 不改写，导出副本单独脱敏。

### ADR-5：身份与去重

**推荐：`sessionId + seq` 作为 ledger 身份；spanId 由 seq 派生。**  
理由：随机 id 在 replay/重试/重开时不稳定；DSH 用 `(session.id, format_version, seq)` 去重。

---

## 6. 一份“优秀架构”的判据

根据 DSH，可以落成这几条：

1. **单一真源**：不出现 messages / spans / eval 三份互相竞争的历史。
2. **纯投影**：stats、spans、报告都能从事件重算；不把派生值写回真源。
3. **边界捕获**：工具执行器、provider、文件系统；不从模型文本重建。
4. **捕获与传输分离**：coordinator 不关心 OTel SDK 的批处理/重试。
5. **热路径非阻塞**：`emit` 不能做 I/O。
6. **稳定身份**：`sessionId + seq` 可去重、可重放。
7. **脱敏在离开进程前**：本地日志与导出副本分开；canonical 不被改写。
8. **默认本地/关闭导出**：外部上报需要明确授权。
9. **消费者分离**：UI 要 `LLMEvent`；eval 要事件/案例；viewer 要投影。
10. **可回退**：出问题能只撤一个 adapter/backend，不牵动 agent loop。

---

## 7. 结论

- **“两个坐标系 / 闭环 / 四维 / L1–L6”全部保留。**
- **“Span-first 独立日志”需要修正为“Event-first + 投影”。**
- **不要先上 OTel**；先把本地事件、投影、eval reader 做对。
- **不要拿 DSH 当 eval 方法论答案**；它只提供事件和反馈的基座。

## 8. 落地状态（2026-10-31）

ADR-1..5 已按本文推荐值拍板，阶段 1 已实现：

- `events.jsonl` 是 canonical 真源；消息只在打开会话时折进内存，不再落文件；
- 改动索引 `changes.jsonl`（每会话一份，只存指针）让本次会话与本书都不折事件；
- 投影：`projectMessages` / `projectSpans` / `projectStats`，都是纯函数；
- `assistant/attempt`、`tool/call`、`tool/result`、`compaction/*` 已接线；
- `TraceSink.emit` 非阻塞，落盘后才分发；
- 导出副本强制脱敏，canonical 日志不改写。

实现说明与不变量见 [../../telemetry.md](../../telemetry.md)。

阶段 2 只剩两件：eval reader（case / replay / report）与 OTel logs 后端。

