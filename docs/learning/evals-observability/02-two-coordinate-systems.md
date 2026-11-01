# 知识点 2 · 两个坐标系：离线 eval vs 在线 observability

> **职责**：把手册 §1.2 那张「最重要的一张图」讲透——为什么 eval 与 observability 是两个坐标系，为什么它们必须共用同一份事件 schema，以及「先定 schema、再长两头」到底在防哪一种重写。
> **读者**：刚学完知识点 1、准备进入评测地基之前的我。
> **对齐代码**：不涉及代码 · 对齐手册 §1.2 / §4.2 / §4.8 / §5.1–5.4（2026-10-30 版）

> **2026-10-31 架构评审修正**：本篇的 Span 仍可作为一种查询视图，但**不要把它当成唯一真源**。看完 DSH 后，我们改为“canonical append-only event log → messages / spans / stats 投影”。详见 [architecture-review-dsh.md](architecture-review-dsh.md)。

---

## 一分钟版

> **离线 eval** 是控制实验：固定 case、固定环境、重复跑，回答「这批改动整体好不好」；产物是报告。  
> **在线 observability** 是现场记录：真实会话、每次都跑，回答「这一次为什么坏、线上正在坏什么」；产物是 trace。  
> 两者共享同一份**事件 schema**：eval 把 trace 当原料，trace 把 eval 的 case 当已知坏样本。  
> 所以顺序必须是 **事件 schema → 两头**，不是「先做 eval，再补 trace」。

---

## 1. 先把「两个坐标系」翻译成人话

「坐标系」不是比喻修辞，它说的是**同一个问题在不同测量条件下的两种问法**。

| 你真正想问的 | 该用哪个 | 为什么 |
|---|---|---|
| 「这个 prompt 改完，整体是变好还是变坏？」 | 离线 eval | 需要固定输入、重复、对比，才能归因 |
| 「刚才这一次，为什么写到第 7 步停了？」 | 在线 observability | 需要真实轨迹的上下文、父子关系、耗时和错误 |
| 「线上最近哪类失败在变多？」 | 在线 observability + 聚合 | 需要长期、真实、带标签的 span |
| 「这个改动值不值得保留？」 | 离线 eval | 需要 baseline、配对比较、预注册阈值 |

一句话：**eval 是控制实验，observability 是现场取证。**  
控制实验能回答「平均而言」，现场取证能回答「这一次」；两者不能互相冒充。

---

## 2. 为什么它们会分裂成两个坐标系

知识点 1 已经拆过三根柱子。把结论接到这里：

| 知识点 1 的结论 | 在知识点 2 里的后果 |
|---|---|
| 失败是概率性的，不能靠一次复现 | 需要**重复跑 + 分布**，这是 eval 的形态 |
| 对错是程度性的，没有 `==` | 需要 rubric / 配对 / 阈值，这是 eval 的判据 |
| 对错在轨迹里，不在字符串里 | 需要**带父子关系的事件序列**，这是 trace 的形态 |
| ground truth 只在边界 | span 必须埋在执行器 / provider / 文件系统，不能从文本反推 |

所以不是「先有 eval，后来觉得还需要日志」；是 agent 的**测量对象**同时要求两件事：

1. **可比较**：同一 case、同一环境、跑多次，才能说 A 比 B 好；
2. **可追因**：保留这一次的真实父子调用，才能说它为什么坏。

这两件事的服务对象不同，成本结构也不同，于是长成了两个坐标系。

---

## 3. 两个坐标系的「测量单位」不同

这是最容易含糊的地方。不是「一个粗、一个细」，而是**单位根本不一样**。

| | 离线 eval | 在线 observability |
|---|---|---|
| 基本单位 | **case × run** | **一次 trace / 一个 span** |
| 样本 | 小（30 个 case × 3 次） | 大（每次会话、每轮、每次工具） |
| 输入 | 受控：初始 HOME、固定 brief、固定 follow-up | 真实：用户想说什么就说什么 |
| 可重复性 | 高：可以重跑、配对、复现 | 低：同一条 trace 不能重来 |
| 成本 | 高：真模型调用、judge、人工 | 低：埋点是旁路；本地可全量 |
| 主要产物 | **报告**（数字 + 失败桶 + 结论） | **trace**（span 树 + 属性 + 错误） |
| 主要问题 | 「整体变好没有？」 | 「这一次为什么坏？」 |
| 失败的含义 | 统计信号 | 因果现场 |
| 决策 | 保留 / 回滚 / 再改 | 修哪一步 / 告警 / 加 case |

**关键**：eval 的一次 run 也会产生 trace；trace 的一次坏样本也可以变成 eval case。两者不是两条互不相干的流水线，而是同一份事件在两个方向上的使用。

---

## 4. 共享事件 schema：不是「日志格式」，是契约

手册说「同一份事件 schema」时，指的不是「都用 JSONL」这种存储格式，而是**事件的语义契约**：

- 有哪些 span 名称；
- 谁是谁的 parent；
- 开始/结束时间怎么记；
- 成功/失败怎么表达；
- 哪些属性允许进 trace，哪些必须留在外面；
- 错误怎么分类。

### 4.1 三层 span 是最小完备集

```
turn（一次用户输入 → 最终答复）
├── chat            （一次模型调用）
│   └── execute_tool （一次工具执行）× n
├── chat
│   └── execute_tool
└── compaction      （一次压缩：before/after token、丢了什么）
```

少一层会怎样：

- 少 `turn`：算不出一个任务的总成本，只能算单次调用；
- 少 `chat`：算不出第几步开始变慢，只能看总时长；
- 少 `execute_tool`：失败率只能按会话算，无法按工具归因；
- 少 `compaction`：上下文为什么突然变短、丢了什么，永远解释不清。

**这三层（加 compaction）正好覆盖钱、时间、错误三种归因**——这就是它是最小完备集的意思。

### 4.2 `LLMEvent` 不是 trace

talemate 已经有 `LLMEvent`（`tool-call` / `tool.result` / `usage` / `text.delta`…），为什么还要单独的 `Span`？

| | `LLMEvent` | `Span` |
|---|---|---|
| 服务对象 | 渲染层（UI 要实时画） | 评测 / 观测 / 归因 |
| 生命周期 | 一次事件推送 | 有 start / duration / parent |
| 时间 | 不带可靠时间戳 | `startMs` / `durationMs` |
| 父子关系 | 没有 | `spanId` / `parentId` |
| 失败 | 可能是自由文本 | `status` + `error.type` 枚举 |
| 可重建性 | 面向界面，丢字段可接受 | 必须保留归因所需的最小完备信息 |

手册 §5.4 的结论很硬：**不要改 `LLMEvent`**——它是 UI 契约，改它要动渲染层。应该在 `Session` 的依赖里加一条**平行通道** `TraceSink`，在 `chat` / `execute_tool` / `compaction` 的前后各加两行。

这不是「多写一份日志」，是**两个不同消费者对同一事实的不同投影**：UI 要即时，trace 要可归因。

### 4.3 schema 的边界纪律

从 §5.4 直接继承：

1. **不要把正文放进 attrs**。放 hash、长度、枚举。正文进 trace 会让文件爆炸，也有隐私问题。
2. **错误必须有类型**。`timeout` / `permission_denied` / `schema_invalid` / `model_refusal` / `tool_not_found` / `internal`。自由文本的 `error` 只能告诉你「坏了」，不能告诉你「哪类坏」。
3. **args 只记 hash + 关键字段**。`write` 的参数可能是整章正文，记全量等于把正文写两遍。
4. **时间戳是字段，不是事后推算**。没有 `startMs` 就没有 P50/P95，延迟分位永远落不了地。

### 4.4 实例：一条 trace、一行 span、一份 schema

先看**一次真实运行**长什么样。用户在会话里说：

> 给这章加一个新角色，先别写正文。

这次运行可能产生下面这棵树：

```text
invoke_agent  (turn)
└── chat  (第一次模型调用)
    ├── execute_tool  read   design/core.md
    └── execute_tool  read   design/characters/
└── chat  (第二次模型调用)
    ├── execute_tool  write  characters/lin.md   ← 越权写盘
    └── chat  (模型文本：我先列三个方向，你选)
```

### 4.5 schema 是「允许什么样的记录存在」

用 TypeScript 表达，schema 不是一行数据，而是**类型 + 约束**：

```ts
export type SpanName = "invoke_agent" | "chat" | "execute_tool" | "compaction";

export interface Span {
  schemaVersion: 1;
  traceId: string;
  spanId: string;
  /** turn 没有 parent；chat 的 parent 是 turn；execute_tool 的 parent 是 chat */
  parentId?: string;
  name: SpanName;
  startMs: number;
  durationMs: number;
  status: "ok" | "error";
  /** 只放 hash / 长度 / 枚举，不放正文 */
  attrs: Record<string, string | number | boolean>;
  /** status=error 时必须有；error.type 是枚举，不是自由文本 */
  error?: { type: string; message: string };
}
```

它约束的不只是字段名，还有关系：

- `invoke_agent.parentId` 必须不存在；
- `chat.parentId` 必须指向一个 `invoke_agent`；
- `execute_tool.parentId` 必须指向一个 `chat`；
- `status === "error"` 时必须有 `error.type`；
- `durationMs >= 0`；
- `attrs` 不允许出现整段正文。

### 4.6 span 是「实际发生了一次什么」

一条 span 实例可能长这样（JSONL 的一行）：

```json
{"schemaVersion":1,"traceId":"t-9f2a","spanId":"a1","name":"invoke_agent","startMs":1760000000000,"durationMs":42310,"status":"ok","attrs":{"agent":"mate","mode":"normal"}}
{"schemaVersion":1,"traceId":"t-9f2a","spanId":"c1","parentId":"a1","name":"chat","startMs":1760000000100,"durationMs":8100,"status":"ok","attrs":{"gen_ai.request.model":"deepseek-flash","gen_ai.usage.input_tokens":18422,"gen_ai.usage.output_tokens":2103}}
{"schemaVersion":1,"traceId":"t-9f2a","spanId":"e1","parentId":"c1","name":"execute_tool","startMs":1760000001200,"durationMs":142,"status":"ok","attrs":{"gen_ai.tool.name":"read","path":"design/core.md"}}
{"schemaVersion":1,"traceId":"t-9f2a","spanId":"e2","parentId":"c1","name":"execute_tool","startMs":1760000001400,"durationMs":87,"status":"ok","attrs":{"gen_ai.tool.name":"read","path":"design/characters/"}}
{"schemaVersion":1,"traceId":"t-9f2a","spanId":"c2","parentId":"a1","name":"chat","startMs":1760000002000,"durationMs":12000,"status":"ok","attrs":{"gen_ai.request.model":"deepseek-flash","gen_ai.usage.input_tokens":19001,"gen_ai.usage.output_tokens":512}}
{"schemaVersion":1,"traceId":"t-9f2a","spanId":"e3","parentId":"c2","name":"execute_tool","startMs":1760000003000,"durationMs":220,"status":"ok","attrs":{"gen_ai.tool.name":"write","path":"characters/lin.md","args_hash":"7c1e"}}
```

把这几行读成一张表：

| 字段 | 这一条 span 里的值 | 它让什么问题可回答 |
|---|---|---|
| `traceId` | `t-9f2a` | 把这些行归到同一次运行；与 eval 的 `RunResult.traceId` join |
| `spanId` / `parentId` | `e3` / `c2` | 写出树：这次 write 属于第二次 chat |
| `name` | `execute_tool` | 按操作类型聚合 |
| `startMs` / `durationMs` | `...3000` / `220` | 算 P50/P95、定位慢步骤 |
| `status` / `error` | `ok` / 无 | 算成功率；失败时按 `error.type` 分桶 |
| `attrs` | `tool=write, path=characters/lin.md` | 判断「有没有越权写盘」，而不是看模型怎么说 |

**Span 不是「日志行」的同义词**：日志行通常只是一个时刻的文本；span 有身份、有父子、有开始/结束、有状态。  
**Trace 也不是另一种 schema**：它只是同一 `traceId` 下的 span，按 `parentId` 组成的一棵树。

### 4.7 同一个文本，两条不同的 trace

再回到知识点 1 的多对一问题。假设两种运行最终都输出：

> 我先不急着写，先给你三个角色方向，你选一个。

但 trace 不同：

```text
trace A（越权）                         trace B（正确）
invoke_agent                            invoke_agent
└── chat                                └── chat
    ├── execute_tool read core.md           ├── execute_tool read core.md
    ├── execute_tool write characters/…     └── execute_tool read characters/
    └── chat（说“先不写”）
```

- 只看文本：A 和 B 几乎一样；
- 看 span：A 的 `execute_tool write` 是硬证据，B 没有；
- 所以 eval 可以断言 `noWriteUnder("characters/")`，而不是断言文本里有没有「先不写」。

这就是「trace 是 eval 的原料」的最具体含义：**span 的 `name + attrs + status` 把「行为」变成了可查询的行，而不是需要从文本里猜的叙述。**

### 4.8 schema、span、trace、case、report 的关系

用数据库类比最清楚：

| 概念 | 数据库里的对应物 | 回答什么 |
|---|---|---|
| **schema** | 表定义 + 约束 | 允许哪些字段、什么类型、什么关系 |
| **span** | 一行记录 | 这一次操作发生了什么 |
| **trace** | 同一 traceId 的多行，按 parentId 组成树 | 这一次运行整体怎么走的 |
| **case** | 实验配方 | 用什么初始世界、什么输入、期望什么 |
| **report** | 查询结果 + 结论 | 这批改动整体好不好 |

注意：schema 不是「数据库表」本身。  
换成 SQLite、Parquet、OTLP，**语义契约不变**；变的只是存取方式。反过来，如果只换了存储、但字段里没有 `parentId` / `startMs` / `error.type`，那 schema 仍然是坏的。

### 4.9 一条坏 span 会破坏什么

| 坏法 | 后果 |
|---|---|
| 没有 `parentId` | 工具调用无法归到 chat/turn，树断了 |
| 没有 `startMs` / `durationMs` | 算不出延迟分位，慢步骤无法定位 |
| `error` 只有一句自由文本 | 失败只能计数，不能按 `timeout` / `permission_denied` 分桶 |
| `attrs` 里塞整章正文 | trace 文件爆炸，且有隐私问题 |
| 没有 `traceId` | eval 报告和 trace 现场无法 join |
| 没有 `requestHash`（chat span 或 replay 记录） | 回放无法判断输入漂移，可能返回旧响应造成假复现 |

---

## 5. 两条闭环：eval 和 trace 怎么互相喂养

### 5.1 从线上坏样本到离线 case

```
真实会话出现坏结果
  → 从 trace 找到失败 span（工具错 / 超步 / 压缩后丢信息）
  → 把「初始世界 + 用户输入 + 期望行为」抽成 case
  → 在隔离 HOME 里重放
  → 变成回归集的一员
```

注意抽取的不是「整条 trace 原文」：

- **保留**：case 的初始文件、brief、follow-up、期望的 L1/L2 断言、失败分类；
- **丢掉**：真实用户隐私、session id、随机 id、绝对路径、与复现无关的正文；
- **补上**：固定模型/参数、固定初始状态、可重放的请求链。

否则「case」只是另一份日志，不能控制变量。

### 5.2 从离线报告到线上观察

```
eval 发现 pass^3 下降
  → 看失败桶：是越权？是超步？是格式？
  → 回到 trace 找同类失败的真实 span
  → 在线上加对应指标 / 告警
  → 下一次 eval 用新 case 验证修复
```

这条线解释了为什么 trace 不能只当 debug 工具：**它是 eval 的原料，也是指标的来源**。反过来，eval 的 case 是 trace 的「已知坏样本」，让线上排查不是从零开始猜。

### 5.3 一个具体例子（talemate）

假设用户说「这章写得不对」，有两种问法：

- **在线**：打开这次运行的 trace，看到
  ```
  invoke_agent
  ├── chat（模型读 core.md）
  ├── execute_tool write characters/lin.md  ← 不该写
  ├── chat（模型说「我先确认一下」）
  └── execute_tool read design/core.md
  ```
  结论：文本说「先确认」，行为已经写盘；这是 §3.3 的 `advanced` 失败，不是文风问题。

- **离线**：把「用户要求加角色，但只该给候选」做成 case；断言 `noWriteUnder("characters/")`；跑 3 次，看 pass^3。  
  如果变体把这个失败从 9/30 降到 2/30，报告才有资格说「修好了」。

同一条失败，在线回答「为什么」，离线回答「改完有没有整体变好」。缺任何一边，都只能得到一半答案。

---

## 6. 为什么顺序必须是「先 schema，再长两头」

这是本知识点最需要能自己讲出来的部分。

### 6.1 反过来的具体代价

假设先写 `eval/run.ts`，只关心「case 通过没有」：

```ts
type RunResult = { caseId: string; pass: boolean; score: number };
```

然后要接 observability，需要：

1. **时间**：P50/P95、首 token 延迟 → `RunResult` 没有 `startMs` / `durationMs`；
2. **父子关系**：哪次工具调用属于哪次 chat、哪次 chat 属于哪次 turn → 没有 `spanId` / `parentId`；
3. **回放**：要把一次模型调用重放，需要 `requestHash` + 完整 request/response → eval 的 `RunResult` 没存；
4. **失败归因**：`pass:false` 是一个布尔，不能区分工具错、超时、越权、格式错 → 需要 `error.type`；
5. **报告 join**：eval 指标和 trace 指标无法按同一个 `traceId` 对齐。

结果不是「加几个字段」，而是**两套数据模型 + 一次重写**。这就是手册说的「会重写两遍」。

### 6.2 先定 schema 之后

```
              ┌──────────────────────────────┐
              │  事件 schema（Span / Trace）  │
              │  name / parent / time /      │
              │  status / attrs / error      │
              └──────────────┬───────────────┘
                             │
              ┌──────────────┴───────────────┐
              ▼                              ▼
      ┌───────────────┐              ┌───────────────┐
      │ TraceSink     │              │ eval reader   │
      │ spans.jsonl   │              │ metrics/report│
      └───────┬───────┘              └───────┬───────┘
              │                              │
              └────────── replay ────────────┘
                 （requestHash 校验）
```

- trace 先按 schema 落盘；
- eval 直接读同一份 span，不需要第二套「运行结果」；
- replay 用同一份 `requestHash` 校验输入没有漂移；
- 报告按 `traceId` 把「指标」与「现场」对上。

**schema 先行的收益不是省一次建模，是让 eval、trace、replay 三个消费者共享同一个事实源。**

### 6.3 schema 不是数据库表

不要把「先定 schema」理解成「先选 Jaeger / SQLite / JSONL」。  
要定的是**语义契约**：

```
span 名：invoke_agent / chat / execute_tool / compaction
父子：chat.parent = turn；execute_tool.parent = chat
时间：startMs / durationMs，epoch ms
状态：ok / error；error.type 是枚举
属性：gen_ai.* / talemate.*，不放正文
```

存储可以是 JSONL，可以先不引 OTel SDK；将来接 Jaeger 只写一个 exporter。**schema 对了，导出器是小事。**

---

## 7. 常见误解（先列出来，后面自检会用到）

| 误解 | 为什么错 |
|---|---|
| 「线上样本无限多，所以不用离线 eval」 | 线上样本是**有偏、不可重复、没有 baseline** 的；它回答「这次为什么坏」，不回答「改动整体有没有变好」 |
| 「trace 就是更详细的日志」 | 日志是平铺文本；trace 有**父子关系、耗时、状态、错误类型**，可以直接聚合成功率/延迟/成本 |
| 「同一份 schema = 同一份数据/同一套存储」 | 共享事件语义，不共享保留策略、采样率和生命周期；线上可采样，本地可全量 |
| 「eval 的 run 结果和 trace 是两回事」 | eval 的 run 也产生 trace；`RunResult.tracePath` 和 `spans.jsonl` 应是同一份事件 |
| 「先从 messages 重建 trace 就行」 | 知识点 1 已证：`轨迹 → 文本` 多对一、不可逆；必须在边界埋点 |
| 「先把 eval 跑起来，之后再补 trace」 | 会得到两套数据模型；回放、父子归因、失败分类都要重写 |
| 「trace 只是 debug 用的，和指标无关」 | trace 是指标的来源：token、延迟、工具成功率、失败桶都从 span 聚合 |
| 「eval 是门禁」 | eval 是测量仪；门禁靠结构与类型（P9），不是分数阈值 |

---

## 8. 落到 talemate 的顺序（先只想清楚，不急着写）

按手册的 Stage 1/2，顺序应是这样：

1. **定 `Span` / `TraceSink`**：字段先于实现，先写类型与 attrs 纪律。
2. **埋四个点**：`Session.post`（invoke_agent）、`loop` 的 `chat`、`tool/runner` 的 `execute_tool`、`compaction`。
3. **落 `spans.jsonl`**：本地全量，线上可采样。
4. **eval 读同一份 span**：先做 L1/L2 断言，再做聚合报告。
5. **replay 做成 provider**：`requestHash` 对不上就抛，不静默返回旧响应。
6. **从 trace 抽 case**：失败样本进回归集，不直接存整条会话。

这和 §7 的落地顺序一致：**S1-2（trace sink）在 S1-6（judge）之前**——先有事件，才有人判。

---

## 9. 自检（先别翻上面的答案）

1. 线上 trace 的样本比离线 eval 多得多，为什么它仍然不能替代离线 eval？请从「可重复性、baseline、选择偏差」三个词里选两个展开。
2. 如果先写 `eval/run.ts`、之后才补 `src/trace`，具体会在哪三处重写？不要只说「要重写」，说出字段或流程。
3. 一条线上坏 trace 要变成 eval case，应该保留什么、丢掉什么？为什么不能直接把整条 messages 存成 case？
4. `LLMEvent` 已经有 `tool-call` / `tool.result`，为什么还要单独的 `Span`？至少说出两个 `LLMEvent` 不满足的字段。
5. 「先定事件 schema，再往上长两头」里的「schema」为什么不是数据库表？如果明天换成 SQLite，这条结论还成立吗？

---

## 10. 我的误解清单（学到这）

1. **「线上样本多，所以线上就是 eval」** → 错。线上是现场，不是控制实验；它没有固定 case、baseline 和重复。
2. **「schema 就是日志字段」** → 错。schema 是事件语义契约（父子、时间、状态、属性边界），存储只是它的一个实现。
3. **「eval 和 trace 各建一套，最后对一下就行」** → 错。没有共享 `traceId` / `requestHash`，指标和现场对不上，回放也无法校验输入漂移。
4. **「trace 可以从 messages 文本重建」** → 错。这是知识点 1 的多对一不可逆；ground truth 在边界。
5. **「先做 eval，trace 以后再说」** → 错。eval 的 `RunResult` 会缺时间、父子、错误类型和回放请求，最后不是加字段，是重写。

---

## 下一站

先答完 §9 的五问，再进 **§1.3 闭环**：假设 → 单变量 → 重复 → 配对 → 决策 → 沉淀。  
知识点 2 的真正判据不是「能背出两张表」，而是：**拿到一个坏 trace，能说清它该进 eval 的哪一部分；拿到一份 eval 报告，能说清它该去 trace 里找什么。**
