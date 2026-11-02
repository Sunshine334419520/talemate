# 遥测：事件日志、投影与导出

> **职责**：回答"会话事件是什么形状、谁在什么时候发、messages/span/统计怎么从它折出来、导出时怎么脱敏"。
> **读者**：要加一类事件、加一个投影、接一个观测消费者（eval reader / OTel）的人。
> **对齐代码**：2026-11-02 · 实现在 `src/telemetry/` 与 `storage/session-store.ts`；评审背景见 `learning/evals-observability/architecture-review-dsh.md`

## 一句话

**一份 canonical append-only 事件日志是真源；messages、span、统计都是它的纯投影。**
没有第二份可写历史，也没有"顺手把派生值写回去"的路。

```text
                    events.jsonl（只追加，seq 单调）
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
  messages 投影            span 投影                统计投影
  （UI / 模型上下文）      （排查 / 将来的查询）      （/debug、成本、失败桶）
        │                       │                       │
        ▼                       ▼                       ▼
  内存消息投影（fold 一次） /trace 摘要              /debug 一行账
```

## 文件都在哪

| 文件 | 是什么 |
|---|---|
| `src/telemetry/events.ts` | 事件类型 → data 形状。加一类事件只改这张表 |
| `src/telemetry/log.ts` | `events.jsonl` 的追加与读取：发号、串行化、半行容忍、sink 分发 |
| `src/telemetry/projection.ts` | 三个纯投影：`projectMessages` / `projectSpans` / `projectStats` |
| `src/telemetry/redact.ts` | 导出副本的脱敏；洗不干净就整条扣下 |
| `src/telemetry/sink.ts` | `TraceSink`：落盘之后复制给外部消费者，只入队、不阻塞 |
| `src/storage/session-store.ts` | 事件写入/读取入口；回退写 `session/rewind`；消息现场折 |
| `src/storage/change_index.ts` | 改动索引 `changes.jsonl`：追加、读取、回退墓碑（只存指针，不存 diff） |
| `src/session/change_history.ts` | 从消息重算改动索引；按 `(messageSeq, callId)` 取 diff |
| `src/session/trace_view.ts` | `/trace` 的摘要与导出 |

## 事件词汇

| 事件 | 什么时候 | 谁发 |
|---|---|---|
| `session/start` | 会话第一次落元信息（改名不会再发） | `Session.saveMeta` |
| `session/seed` | 旧日志里的迁移记录（新代码不再产生，只保留读取） | — |
| `session/rewind` | 就地回退；投影据此遮住 `seq >= targetSeq` 的消息 | `truncateMessagesBefore` |
| `turn/start` / `turn/end` | 一次用户输入到模型停下 | `Session.runTurn` |
| `step/start` / `step/end` | 一次模型请求（`step` 从 0 起） | `Session.runTurn` 的 `generate` |
| `request/header` | 每次请求前：模型参数 + system/tools/messages/prompt 的 hash 与字符数，**不含正文** | 同上 |
| `assistant/attempt` | 这次请求失败或被中止（**没有产出消息**） | 同上 |
| `user/message` / `assistant/message` / `compaction/summary` | 一条消息提交进事件日志 | `appendMessage` |
| `tool/call` / `tool/result` | 每次工具执行前后（含被 `planGatePart` 拦下的） | `Session` 的 `executeTool` / `applyApprovedDesign` |
| `compaction/start` / `compaction/end` | 上下文压缩 | `Session.maybeCompact` |

为什么 `assistant/attempt` 必须存在：上面那三种消息事件只记得成功落盘的消息。一次网络失败、一次用户中止、一次被截断的流，在任何消息投影里都不存在——不单独记，它们就永远查不到。

`request/header` 与 eval 的 manifest 用同一份 `core/hash.ts`：在线 trace 与 cassette 的 promptHash/toolsHash 能互相指认；manifest 优先读它，不再依赖 cassette 第一条。

为什么工具正文不复制进事件：入参与输出已经在 `assistant/message` 的 parts 里。事件只记边界上才拿得到的事实（`state` / `durationMs` / `outputChars` / `error`），再存一份正文就是第二份真源。

## 改动索引（另一份投影）

`changes.jsonl` 每会话一份、只追加：一行一条"哪个文件被改了"，带 `turnSeq` / `messageSeq` / `callId` / 增删行数，**不存 diff**。写点在 `Session.persistAssistant`（事件先落、索引后落）；回退追加 `{type:"rewind"}`，读取按文件顺序重放；打开会话时顺手对账一次（落后就重写）。本次会话读一个文件，本书读 N 个——两边都不折事件。点开某一行才按指针回消息里取 diff。

## 五个已经拍板的决定

1. **canonical 事件日志，不是 sidecar。** 两份可写历史一定会分叉；`events.jsonl` 只追加，消息只在内存里折（不再落文件）。
2. **messages 是投影。** 读的时候事件优先（`loadMessages` 先折事件）；写的时候先落事件、再重写缓存。缓存删了能由事件重算回来。
3. **先本地、后 OTel；OTel 先接 logs。** span 由事件派生，不落盘。等真有 span 查询需求，再换 backend，不换事件。
4. **脱敏只作用于导出副本。** 本地账本保留原文（回放要完整）；导出默认关闭，`redact.ts` 洗密钥与家目录，洗不干净就扣下（fail-closed）。
5. **身份是 `sessionId + seq`。** 消息的 `seq` 只是投影内顺序（回退后可复用），不拿来去重；`spanId` 由起始事件的 `seq` 派生，重放稳定。

## 不变量

- 事件日志**只追加**：不改写、不删除。回退也只是一条新事件。
- **先事件、后缓存**：两步之间被杀，缓存少一条可重算；反过来就会多出一条讲不出来的消息。
- 投影是**纯函数**：只吃事件、吐视图；不回写，不读文件。
- **失败保留**：请求失败、工具失败、没闭合的段都留在日志/视图里，标 `error`，不补一个编的结束时间。
- `emit` 只入队；sink 抛异常被吞掉——观测丢一条不等于会话丢一条。
- **默认不导出**：导出必须显式调用（`/trace export`）；导入外部实现时脱敏一定在离开进程之前。

## 加一类事件

1. 在 `events.ts` 的 `TraceEventData` 加一条：类型名 + data 形状。注释写清"为什么非它不可"。
2. 生产：会话里用 `this.trace(type, data)`（旁路、失败可丢）；消息类必须走 `appendMessage`（同步落盘）。
3. 如果它参与消息投影：改 `projectMessages` 和 `storage/session-store.ts` 的 `MESSAGE_EVENTS`。
4. 决定 `projectSpans` / `projectStats` 要不要消费它——不消费就什么都不用做。
5. 在 `tests/telemetry.test.ts` 投一条合成事件，断言投影结果。

判据：**能由已有事件推出来的，不要加新事件。** 事件该记的是"边界上发生了什么"，不是"我们后来怎么解释它"。

## 怎么看

**桌面端（主要入口）**：命令面板打 `/trace`，右栏出摘要与事件日志路径，右上角「导出脱敏副本」写 `trace-export.jsonl`（窗口里没有 `cat`，所以路径必须写在屏上）。标题栏那个「轨迹」是**逐条消息的过程视图**（看一次工具调用的入参/输出），不是这份事件账——两者都留着，回答的问题不同。

**CLI**：

```bash
# 摘要（轮/步/工具/失败/耗时/token/span 计数）
/trace

# 导出脱敏副本（缺省落到会话目录的 trace-export.jsonl）
/trace export
/trace export /tmp/trace.jsonl

# 调试信息：事件路径、条数、统计；以及 messages 缓存路径
/debug

# 原始日志就是 JSONL，直接看
cat <session>/events.jsonl | jq -c 'select(.type=="tool/result")'
```

`/debug` 里两个路径的分工：**events.jsonl 是账本**（排查以它为准），**changes.jsonl 是改动索引**（每会话一份的小投影，只存指针；删了能由事件重算）。

## 还没做

- eval case / rubric / pairwise / replay provider —— 手册里的方法论那一层；
- 跨会话 trace 查询与 span 可视化；
- OTLP logs 导出（`TraceSink` 已经留好座位）；
- 两个进程同时写同一会话的互斥（现状是单进程写）。

> 判据：先保证事件完整，再谈查询视图。反过来会得到一个"看起来有 span、但重放不出来"的底座。
