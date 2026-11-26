# 上下文压缩架构（Context Fold）

> **职责**：定义会话上下文的生命周期——哪些材料按需、哪些被折叠、哪些绝不进摘要，以及压缩失败时怎么办。
> **读者**：要改 `src/session/`、`src/context/`、`src/storage/session-store.ts`、`src/telemetry/` 的人。
> **对齐代码**：2026-11-24 · 标【现状】的段落已按代码核对；常驻注入已删（pinned 不再带 resident）。
> **相邻**：`architecture.md`（一次交互怎么走）· `state.md`（状态层）· `design-docs.md`（设计文档体系）· `telemetry.md`（事件与投影）

**一句话**：压缩不压书，只压对话。书的事实从文件现取；压缩只保留磁盘上没有的意图、决定和未完成任务。

---

## 1. 决策记录

这七条是架构的形状，改动其中任何一条都要重写本文对应章节。

| # | 决策 | 日期 | 理由 |
|---|---|---|---|
| **D1** | 摘要放弃承载 canon | 2026-11-21 | 生成物不可审计、会漂移；书的事实已在 `design/`、`chapters/`、`state/` 里。摘要只承载对话：意图、决定、未决问题、下一步 |
| **D2** | 决定账先做会话级 | 2026-11-21 | 用户拍板必须活过压缩，但"作者否过什么"作为跨书经验是另一个对象。会话级先落地；项目级 `state/failures.md` 不在本架构内 |
| **D3** | 折叠是累积的 | 2026-11-21 | 第 n 次折叠的输入必须包含第 n-1 次的摘要，不允许从零重写 |
| **D4** | 压缩单位是 turn | 2026-11-21 | 一条 assistant 消息可带多个工具结果；按消息条数切会把 Q/A 和 tool call/result 拆开 |
| **D5** | 证据账与决定账是确定性的 | 2026-11-21 | "读过什么、拍过什么板"能算、能记、不能生成；模型只写对话叙事 |
| **D6** | 压缩失败等于没压缩 | 2026-11-21 | 一次折叠是一条原子事件；摘要失败时窗口不变，另走确定性降级 |
| **D7** | 计划进正文窗口，不改工具可见范围 | 2026-11-21 | 用户看过的计划字节必须指导正文；`.talemate/` 仍然不是工具可读的根 |

---

## 2. 术语

| 术语 | 含义 |
|---|---|
| **折叠（fold）** | 把工作集里最老的一段 turn 转成一条上下文记录的动作。不是"摘要"，产物包含摘要、证据、决定、pinned 快照 |
| **折叠记录（CompactionRecord）** | 一次折叠的 canonical 事件；消息窗口由它投影出来 |
| **工作集（working set）** | 仍以原文保留在窗口里的消息；折叠只吃工作集 |
| **pinned** | 折叠时由 harness 从文件与事件确定性生成的块：位置、未回收承诺、用户决定、计划、证据 |
| **证据账（evidence ledger）** | 被压段里"读过什么"的确定性记录：工具、路径、小节、rev、字数、结论摘要 |
| **决定账（decision ledger）** | 会话内用户拍板的确定性记录：接受 / 拒绝 / 提意见，含用户原话 |
| **高/低水位** | 触发折叠与折叠目标：越过高水位才折，一次折到低水位以下 |
| **原文保留（structural recent）** | 最近 turn 以 `StoredMessage` 原样留在窗口里，tool part 不拍平 |
| **降级折叠（degraded）** | summarizer 不可用时只把工具结果换成指针，不生成叙事 |

---

## 3. 落地前的问题【历史】

下面是这次改造的动机，五个问题均已修掉，保留供追溯。落地前的实现集中在旧的 `session/compaction` 模块、`src/context/assemble.ts`、`src/storage/session-store.ts`：

| # | 问题 | 代码事实 | 后果 |
|---|---|---|---|
| 1 | 第二次折叠丢上一份摘要 | `headText` 只认 user/assistant，compaction 落到空串；窗口又从最新 compaction 起 | 前史在第二次折叠时静默消失 |
| 2 | 工具输出完全不参与摘要 | 摘要只取 assistant 的 `text` part；`read`/`grep`/`task`/`recall` 都是 tool part | 规划简报、刚读到的设定、考据结论压一次就没 |
| 3 | `recent` 不是消息，是纯文本 | `recent` 被转成 `[user]/[assistant]` 文本；tool part 与工具入参全丢；原文不在窗口里 | 最近一个 turn 的结构与内容同时丢失 |
| 4 | 规划正文不可读 | 计划只活在内存 `pending` 与 `.talemate/plans/`；后者不在语料根表里 | 折叠或重启后，系统要求"照规划执行"，模型却读不到规划 |
| 5 | system 超限时压缩无能为力 | `isOverBudget` 用含 system 的 `lastInput` 判超，`compact()` 只动 messages；窗口 ≤ 6 条直接返回 null | 提示词底子过大时每步触发压缩，永远修不好 |

根因：**把"对话记录"当成了"项目记忆"**。这本书的记忆在文件里；对话里真正不可恢复的只有用户意图、否决理由、未决问题与正在进行的任务。

---

## 4. 第一原则

1. **磁盘是长期记忆，对话不是。** 压缩只保留磁盘上没有的东西。
2. **能算的不要存，能读的不要摘要。** 故事到哪了、欠什么、谁在哪，从文件现取；摘要是投影，不是第二份 canon。
3. **摘要只增不减。** 第 n 次折叠包含第 n-1 次的摘要；不允许从零重写。
4. **结构性内容不经生成。** 用户拍板、未答提问、批准的计划、状态快照由 harness 格式化；LLM 只写对话叙事。
5. **工具调用与结果不可分。** 最小压缩单位是 turn；一个 assistant step 的 tool call + result 永远同进同出。
6. **压缩失败等于没压缩。** 一次折叠是一条原子事件；摘要失败时窗口不变。
7. **先截断，后压缩。** 单次工具输出在工具边界就有上限；压缩是最后一道。
8. **预算按 token，分到层。** system / tools / working set / summary 各有预算；system 超限时不进入压缩循环。
9. **每次折叠可解释。** 进/出 token、压掉几段、保留几条证据、丢了什么，都能在 trace 里看到。
10. **摘要不是 canon。** 渲染时明说"书的事实以项目文件为准；需要时按证据账重读"。

---

## 5. 分层模型【现状】

每一轮送给模型的上下文由下面几层组成；只有 L2/L3 会被折叠。**作品文档一层都不在 system 里**——包括
`design/brief.md` 与 `design/wiki/world.md`：它们和别的文档一样，靠 `read` 现取。

```
┌──────────────────────────────────────────────────────────────┐
│ system                                                       │
│  L0 固定层   env · role system · AGENTS.md · skill 目录       │
│  L1 任务层   待审提案 · 已批准计划 · 未答提问 · 当前模式       │
│  L1 正文窗   正文规范 + 文风卡 + 本章规划全文                  │
├──────────────────────────────────────────────────────────────┤
│ messages                                                     │
│  L3 对话史   <context-state>                                 │
│               ├─ <project>   位置 / 承诺 / 当前计划（派生）    │
│               ├─ <session>   累积折叠（LLM）                  │
│               ├─ <decisions> 用户拍板原文（确定性）            │
│               ├─ <evidence>  读过什么 @rev（确定性）           │
│               └─ <open>      未决问题（确定性）                │
│  L2 工作集   最近 N 个 turn 的原文（结构完整，tool part 在）   │
│  L3/当前     本轮用户消息                                     │
└──────────────────────────────────────────────────────────────┘
```

| 层 | 内容 | 谁写 | 生命周期 | 折叠策略 |
|---|---|---|---|---|
| **L0 固定** | system 外壳、AGENTS.md、skill 目录 | harness | 每轮重建 | 不压 |
| **L1 任务态** | 提案、计划、提问、模式 | harness | 跨轮、可持久化 | 不压 |
| **L1 正文窗** | 规范、文风、本章规划 | harness | 写正文期间 | 不压 |
| **L2 工作集** | 最近对话原文 | 事件投影 | 高水位内保留 | 按 turn 整段淘汰 |
| **L3 对话史** | 累积摘要 + 三个确定性账 | harness + summarizer | 全会话 | 累积折叠 |
| **磁盘** | design / chapters / state / plans | 用户与 mate | 永久 | 不进上下文，按坐标重读 |

关键边界：**L2 以下不承载书的事实**。一条事实若下一章还要用，它应该已经在 `state/`、`design/`、`chapters/` 或规划里；摘要只负责"我们聊到哪了、用户要什么、还欠哪个决定"。

---

## 6. 压缩单位与选择【现状】

### 6.1 段

```
user message        = 一个 segment
assistant step      = 一个 segment（该 StoredMessage 的全部 parts，含 tool call/result）
turn                = 一个 user message + 其后的全部 assistant steps，直到下一个 user
```

规则：

1. **压缩单位是 turn**，从最老的一端整段淘汰，Q/A 不拆开。
2. **当前 turn 永不压缩**；最近 `recentFloor`（按 token，不按条数）内的 turn 原文保留。
3. **单个 turn 超预算**时允许"段内修剪"：把它的工具结果换成摘要 + 指针，保留 user 全文、assistant 文本、最后一步；标 `intraTurn: true`。这是唯一允许拆 turn 的情况。
4. **未闭合的 segment 不压**：`running` 状态的工具、被中断的 assistant、未 commit 的消息都跳过。
5. `StoredMessage` 已把 tool call 与 result 放在同一条 assistant 消息的 `parts` 里，原子性在存储层已成立；折叠只需不拆消息。

### 6.2 选择

```ts
function selectSegments(messages, budget) {
  const kept = lastTurnsWithin(messages, budget.recentFloor);
  const rest = messages.slice(0, messages.length - kept.length);
  const picked = [];
  while (estimate(picked) < budget.overflow && rest.length) picked.push(rest.shift());
  return { picked, kept: [...rest, ...kept] };
}
```

选不中任何东西、而 system 又没超 → 抛出"窗口不足且无可压缩段"，带具体数字给界面。**不允许静默跳过、继续发一个超窗请求。**

---

## 7. 折叠流程【现状】

五步。前两步确定性，第三步才用模型，第四步校验，第五步原子提交。

### 7.1 触发与水位

```
usable    = contextWindow(model) - maxOutputTokens - safetyTokens
highWater = usable * 0.85
lowWater  = usable * 0.50
```

- 上次请求的真实 `usage.input` 优先；没有真数时用字符估算（见 §11）。
- **迟滞**：越过高水位才折，一次折到低水位以下。避免"每步都压一次"的抖动。
- 触发点在每步请求前；一次折叠后重新量，仍超则继续折（换到小窗口模型时可能要多轮）。

### 7.2 preflight

先算 `systemTokens + toolSchemaTokens`：

- `> usable * 0.55`：不折叠，返回可操作错误——"提示词底子过大：system 约 X token、工具定义约 Y token，合计约占模型窗口 Z%；请精简 AGENTS.md 与 skill 目录，或换更大窗口的模型"。
- `> usable`：第一次请求都不发。不允许先发一个必超的请求，或在 `lastInput` 上无限触发压缩。

### 7.3 构造折叠输入

```xml
<fold-input>
  <previous-fold>          ← 第 n-1 次的 <session>，原文照带
  <pinned>                 ← 全部由 harness 从文件/事件生成
    <project>写到第 12 章；第 12 章收在……</project>
    <promises>未回收：……</promises>
    <decisions>…用户原话…</decisions>
    <plan chapter="13" path=".talemate/plans/ch_13.md" hash="…"/>
  </pinned>
  <segment turn="7-11">
    [user] …
    [assistant] …
    [tool kind="read" path="state/foreshadowing.md" rev="a1b2c3" chars="812"] 摘要：…
    [tool kind="task" agent="planner" chars="5230"] 结论：…（结论型输出保留正文，上限 4k）
  </segment>
</fold-input>
```

工具结果分两类：

- **原始材料**（`read` / `grep` / `webfetch` / `recall` 列表）：只给指针 + 首段，正文由 `path#section@rev` 重读。
- **结论**（`task` 的 `<task_result>`、`recall` 的结论、一次考据的最终答复）：给正文，按字符上限截断。结论是感知的产物，不是可重读的原文；压掉它等于压掉取证结果。

### 7.4 生成与校验

summarizer 只输出对话叙事，固定四段：

```xml
<accomplished>这段里做成了什么（≤3 条）</accomplished>
<intent>用户想要什么、否过什么、在等什么（≤3 条）</intent>
<open>尚未解决、下一步要用的问题（≤5 条）</open>
<pointers>下一步可能需要的路径/章号（≤5 条）</pointers>
```

校验（不通过则重试一次，再失败走降级）：

- 四段齐全，总长 ≤ `summaryBudget`（初始 1200 token）；
- 不出现空洞；
- `<intent>` 与 `<decisions>` 重复只警告，不判失败；
- 未知专名只警告，不判失败——避免误杀。

### 7.5 原子提交

一次折叠 = 一条 canonical 事件 `context/compaction`，带完整记录。投影规则：

```
窗口 = [<context-state> 合成消息] + consumed.toSeq 之后的全部原文消息
```

- 摘要生成失败 → 不写事件，旧窗口继续；下一次重试。
- 进程崩溃在"生成了、没写事件" → 旧窗口仍然完整；没有半截状态。
- 同一次折叠重复执行 → 以 `consumed.toSeq + previousId` 去重，幂等。
- 回退/分支 → 回退事件之后的折叠记录也在被遮住的范围内，投影自然回到更早的窗口。

---

## 8. 累积折叠与 pinned【现状】

### 8.1 折叠是左结合的

```
S₀ = 空
Sₙ = fold(Sₙ₋₁, segmentₙ, pinnedₙ)
```

不是 `Sₙ = summarize(segmentₙ)`。实现上 `<previous-fold>` 必须原样进入 summarizer 输入；`pinned` 每轮重建（它来自文件，不来自上一次摘要）。

### 8.2 为什么 pinned 不能交给模型（D1）

模型会漂移、会漏名字、会把"打算"写成"已经发生"。pinned 是确定的，应该**复制**而不是**生成**：

| pinned 块 | 来源 | 是否生成 |
|---|---|---|
| `<project>` 位置 | `state/progress.md` 最后 7 节 | 否，原文 |
| `<promises>` 未回收 | `state/foreshadowing.md` 过滤状态 | 否，原文 |
| `<decisions>` | `proposal/decision` 等事件 | 否，用户原话 |
| `<plan>` | 已批准规划（路径 + hash） | 否，harness 读取 |
| `<evidence>` | 工具调用事件 | 否，确定性派生 |
| `<session>` | summarizer | 是，唯一一段 |

这同时解决"600 字承载整本书"的问题：摘要只承载对话，书的规模由文件承载。

**D1 的具体含义：**

- summarizer 不写世界规则、人物事实、章节事件、伏笔状态。
- 它写的是：这段对话里用户要什么、否了什么、定了什么、还欠什么、下一步该看哪份文件。
- 如果它不确定一条事实是否已在文件里，**写路径，不写事实**。
- 书的事实以文件为准；摘要与文件冲突时，一律以文件为准。

### 8.3 摘要满了怎么办

单条 `<session>` 超过 1200 token 时，不把整段重新压一遍，而是：

1. 只把 `<session>` 最老的一半折进一个 `<archive>` 短块（≤300 token），保留最近一半；
2. `<archive>` 同样累积，不重写；
3. 如果 `<archive>` 也满，才做一次"两级合并"。

这是可选的第二级；第一版不需要。先保证"只增不减 + 有上限"，再观察实际会话长度。

### 8.4 渲染

`<context-state>` 作为窗口里第一条 user 消息：

```xml
<context-state>
  <project>第 12 章已落盘。上一章收在……</project>
  <promises>未回收：…（见 state/foreshadowing.md）</promises>
  <session>…累积摘要…</session>
  <decisions>用户否决了"让林晚主动认罪"的方案；理由：太早亮底牌。</decisions>
  <evidence>
    read design/characters/林晚.md @9f2c1a
    read state/progress.md @77ab02
    task planner session=… (2026-11-21)
  </evidence>
  <open>1. 第 13 章是否引入新角色？用户未答。</open>
</context-state>
（以上是上一段对话的投影。书的事实以项目文件为准；不确定时按上面的路径重读。）
```

它不再自称"故事摘要"：它是"对话投影 + 恢复坐标"。

---

## 9. 证据账与决定账【现状】

### 9.1 证据账

从被压段的工具调用确定性派生，写入折叠记录；渲染进 `<evidence>`。去重规则：同 `kind + path + section` 只留最新 rev。

```ts
export interface EvidenceEntry {
  kind: "read" | "search" | "task" | "recall" | "skill" | "web";
  path?: string;
  section?: string;
  rev?: string;
  label: string;       // 工具名 / 子代理名 / skill 名
  chars: number;
  digest?: string;     // 结论型输出的一行
}
```

证据账的作用不是"证明模型读过"，而是**给出重读坐标**。它同时回答"答案过期"：下一次 `read` 返回新的 rev，模型能看见变化。

### 9.2 决定账（会话级，D2）

accept / reject 是按钮，不产生用户消息；现在压一次就只剩 assistant 的转述。新增事件：

```ts
"proposal/decision": {
  proposal: string;        // 路径或 PLAN_KEY
  verdict: "accept" | "reject" | "refine";
  note?: string;           // refine 时用户原话
  chapter?: number;
}
```

决定账从事件派生，随每次折叠累积，**原文保留**（提意见的原话、拒绝的理由）。它只覆盖当前会话。

**边界**：项目级的"作者否过什么"是另一个对象（未来的 `state/failures.md`），不在本架构内。不要把会话决定账和项目经验混成一个文件——前者随会话消失，后者跨书累积，两者的半衰期不同。

### 9.3 未决问题

`<open>` 是两部分的并集：

- harness 里仍未回答的提问（已有 `asks` 机制）；
- summarizer 标记的、没有对应提问的悬空问题。

不回答的提问不能被压缩掉，也不能被模型当成"用户默认同意"。

---

## 10. 任务态与计划【现状】

当前 `pending` 只在内存（`src/session/session.ts`），重启清空；规划正文在 `.talemate/plans/`，但 `read/list/search` 读不到。新架构：

### 10.1 计划

- `propose-plan` 落盘后，追加事件 `proposal/presented`（chapter / path / hash / 摘要行）。
- 用户接受/拒绝追加 `proposal/decision`。
- 会话打开时从事件重建 `pending`；计划正文由 **harness** 读 `.talemate/plans/ch_N.md`（不进模型工具），hash 不符时标 `stale`。
- **正文窗口直接注入已批准计划全文**。它是有界的、用户看过的那份字节；和文风卡一样，属于"这一章写作必须成立的约束"。

这修掉的不只是压缩问题：重启后 `enter-prose` 不再因为 `pending` 清空而失效。

### 10.2 重启恢复

| 状态 | 现状 | 目标 |
|---|---|---|
| 待审文档提案 | 内存，重启丢 | 事件重建；或明确丢弃、走重新提案 |
| 已批准规划 | 内存，重启丢 | 事件 + 文件，重启恢复 |
| 未答提问 | journal 已有 | 保留，进 `<open>` |
| 模式 | 内存（文档明说临时） | 保持临时；计划可恢复即可重新 enter-prose |
| 计划正文 | `.talemate` 不可读 | 正文窗口由 harness 注入 |

---

## 11. 预算与工具输出【现状】

### 11.1 token 估算

字符估算只能当兜底。建议：

```
cjk   = 中日韩字符数 × 1.0
ascii = 其余字符数 × 0.28
tokens ≈ cjk + ascii + 4 × 消息条数 + tool schema 字符 × 0.3
```

优先级：

1. 上一次请求的真实 `usage.input`（ground truth）；
2. `request/header` 记录的三段字符数按上述公式估；
3. 全新会话、还没发过请求 → 用公式估 system + tools + messages。

`lastInput` 只用于总量判断；分层预算用估算值。界面百分比继续带"约"。

### 11.2 分层预算（初始值，按评测调）

| 层 | 占 usable 上限 | 超限行为 |
|---|---|---|
| system | 40% | preflight 报错，要求精简 AGENTS.md / skill 目录或换模型 |
| tools schema | 15% | 报错（工具太多是配置问题） |
| `<context-state>` | 10% | 先折 `<session>`，再截 `<evidence>` |
| working set | ≥ 40% | 低于此则折叠 |

### 11.3 先截断，后压缩

压缩不为工具输出擦屁股。工具边界先做预算：

| 工具 | 上限 | 超限返回 |
|---|---|---|
| `read`（无 section） | 12k 字符 | 标题索引 + 首段 + "用 section=… 读某一节"；超长 section 支持 `offset` 分页 |
| `read`（有 section） | 12k 字符 | 第一节 + "此节还有 N 字，用 offset=… 继续" |
| `grep` | 100 条命中 / 单文件 20 处 | "命中 N 处，显示前 100；用 path 缩小范围" |
| `glob` | 100 条路径 | "找到 N 份，显示前 100；用 path 缩小范围" |
| `webfetch` | 80k（已有） | 已有 |
| `task` | 结论全文，≤ 12k | 超限截断并标注 |
| `recall` | 目录 / 单条 | 已有 |

一条感知卫生：

**证据账替代全文留存**：一次 `read` 的全文只需活到当前 turn 结束；之后由 `path#section@rev` 代表它。模型要细节就重读。

---

## 12. 失败、降级与原子性【现状】

### 12.1 三档

| 档 | 条件 | 行为 |
|---|---|---|
| **normal** | summarizer 正常 | 摘要 + pinned + 证据账 |
| **degraded** | summarizer 报错 / 超时 / 输出校验失败 | **确定性折叠**：只把被压段的工具结果换成指针，保留 user/assistant 文本；不生成任何叙事。标 `degraded: true` |
| **refuse** | system 超限 / 无可压段 | 不写事件，不继续请求；把数字和动作给界面 |

`degraded` 的意义：宁可少一段叙事，也不要编一段；下一次窗口有余量时再做正常折叠。

### 12.2 原子性与迁移

- 折叠记录只通过一条 `context/compaction` 事件落盘；消息不删不改。
- 投影是纯函数：`project(events) → { stateMessage, workingSet }`。
- 旧格式兼容：读到 `role:"compaction"` 的旧消息时，当作 `legacy: true` 的折叠记录，后续折叠继续累积。
- 新事件与旧 `compaction/summary` 并存一段时间；投影优先新事件。

---

## 13. 可观测性与评测【现状】

> 提示词重写后，旧 cassette 需要重录：`summarizer` 请求的 system 与输出格式都变了，
> `eval:run --replay` 在 `context-compaction-retains` 这类 case 上会 miss。

### 13.1 trace

每次折叠一条 `context/compaction` 事件：

```json
{
  "previousId": "…",
  "consumed": { "fromSeq": 12, "toSeq": 84, "turns": 6 },
  "summarizer": { "model": "deepseek-v4-flash", "promptHash": "…", "schema": 2 },
  "budget": { "usable": 950000, "before": 902000, "after": 410000, "trigger": 807500 },
  "dropped": { "messages": 18, "toolResults": 21, "toolChars": 183042 },
  "kept": { "evidence": 14, "decisions": 3, "open": 2 },
  "degraded": false
}
```

`/trace` 展示当前水位、各层占比、最近一次折叠的"进/出/保留/丢弃"。界面只在跨过阈值时给一行提示，不打断。

### 13.2 评测用例（离线、mock provider）

| 用例 | 断言 |
|---|---|
| `compaction-cumulative` | 连续折叠 3 次，第一次摘要里的专名仍在第三次的 `<session>` 里 |
| `compaction-tool-digest` | 被压段读到 `state/foreshadowing.md`，新记录 `<evidence>` 有 path@rev，`<session>` 有它的结论 |
| `compaction-recent-structural` | 折叠后最近 turn 的 tool part 仍在窗口里，形状与折叠前一致 |
| `compaction-plan-survives` | 批准计划 → 折叠 → 正文窗口仍含计划全文 |
| `compaction-decisions` | 用户 reject 的原话在任意次折叠后仍逐字存在 |
| `compaction-atomic` | summarizer 抛错 → 事件数不变，窗口不变 |
| `compaction-degraded` | summarizer 抛错 → 工具结果变指针，user/assistant 文本保留，无新增专名 |
| `compaction-hysteresis` | 折叠一次后下一次请求不再触发 |
| `compaction-oversized-turn` | 单 turn 超预算时只修剪工具结果，不拆 Q/A |
| `compaction-system-overflow` | system + tools 超窗 → 报错且不发请求，不进入循环 |
| `compaction-restart` | 重开会话，已批准计划仍可进入正文模式 |
| `compaction-legacy` | 旧 `role:"compaction"` 消息能被继续累积 |

---

## 14. 模块与删除清单【现状】

### 14.1 新模块

```
src/context/
  budget        窗口表 + token 估算 + 分层预算 + 触发/迟滞
  segments      StoredMessage -> turn/step 段；选择；原子性；段内修剪
  fold          编排：preflight -> select -> build -> summarize -> validate -> commit
  summary       折叠输入构造、summarizer 调用、四段输出解析与校验
  ledger        证据账 / 决定账 / 未决问题（从事件与工具 part 确定性派生）
  project_state state/progress、foreshadowing、计划的结构化注入
  assemble      渲染 ContextPlan -> system + NeutralMsg[]（取代 toNeutralMessages）
```

### 14.2 删除 / 替换

| 现在 | 处理 |
|---|---|
| 旧的 `session/compaction` 模块（`estimateChars` / `headText` / `recentText`） | 已删除；由 budget + summary + segments 取代 |
| `StoredMessage.role: "compaction"` | 折叠改为事件；旧消息保留为 legacy 投影，迁移期后删除该 role |
| `loadModelWindow` 的"从 compaction 起" | 投影按 `consumed.toSeq` 决定窗口；原文消息不拍平 |
| `compaction/summary` 事件 | 由 `context/compaction` 取代；旧事件兼容读 |
| `.talemate/plans` 不可读 | 不进语料根表；由 harness 在正文窗口注入，工具仍读不到 |
| `RECENT_KEEP = 6` | 改为 `recentFloor` token 预算 |
| `prompts/summarizer.system.txt` | 重写为"折叠对话"，不再写 story-state / 设定 / 伏笔 |

### 14.3 数据模型（跨层放 `src/core/types.ts`）

```ts
export interface CompactionRecord {
  id: string;
  at: number;
  previousId?: string;
  legacy?: boolean;
  consumed: { fromSeq: number; toSeq: number; turns: number; intraTurn?: boolean };
  summarizer?: { model: string; promptHash: string; schema: number };
  summary: {
    archive?: string;          // 超过上限时把最老的一行折进这里（≤300 token）
    session: string;           // 累积的对话叙事
    accomplished: string[];
    intent: string[];
    open: string[];
    pointers: string[];
  };
  pinned: {
    project?: string;
    promises?: string;
    decisions: DecisionEntry[];
    plan?: { chapter: number; path: string; hash: string };
  };
  evidence: EvidenceEntry[];
  budget: { usable: number; trigger: number; before: number; after: number };
  dropped: { messages: number; toolResults: number; toolChars: number };
  degraded: boolean;
}

export interface DecisionEntry {
  at: number;
  proposal: string;
  verdict: "accept" | "reject" | "refine";
  note?: string;
  chapter?: number;
}
```

`CompactionRecord` 是 canonical 记录；`<context-state>` 是它 + 当前任务态 + 当前文件快照的渲染结果。

### 14.4 新事件

```ts
"context/compaction": CompactionRecord;
"proposal/presented": { proposal: string; chapter?: number; path?: string; hash?: string };
"proposal/decision": DecisionEntry;
```

`proposal/presented` / `proposal/decision` 不只服务压缩：界面回看、评测、未来项目级失败账都靠它。

---

## 15. 分阶段落地

> 落地状态（2026-11-22）：阶段 0–4 已实现。§13.2 的用例在 `tests/compaction.test.ts`；
> 二级归档摘要是简版（`<archive>` ≤300 token，只在 `<session>` 超预算时启动）；
> 未做：`<archive>` 再满之后的两级合并（§8.3 的可选第二级）、项目级失败账（后者本就不在本架构内）。

### 阶段 0：止血（不改数据模型）

1. 累积摘要：`<previous-fold>` 进入 summarizer 输入；测试断言内容包含旧摘要专名。
2. 摘要输入带工具摘要：`read` 给 path@rev + 首段；`task` 给结论正文；`grep` 给命中数与 top 路径。
3. `recent` 改为"保留顺序号"：折叠记录存 `toSeq`，窗口从"折叠消息 + toSeq 之后的原文"取；不再拍平。
4. 正文窗口注入已批准计划全文（harness 读文件）。
5. preflight：system + tools 超限时报错，不进入消息压缩。

这五条能立刻消掉 §3 的五个洞，且不需要新事件、新模块。

### 阶段 1：结构（新模块与记录）

- budget / segments / fold / summary / ledger / project_state 落地；
- `context/compaction` 事件；
- 确定性证据账与决定账；
- 迟滞与分层预算；
- trace 与界面水位。

### 阶段 2：任务态持久化

- `proposal/presented` / `proposal/decision` 事件；
- 会话打开时重建 pending；
- 重启后计划与正文窗口恢复；
- 旧 compaction 消息的 legacy 迁移。

### 阶段 3：取数与卫生

- `read` 分页 / `glob`、`grep` 上限；
- 文档 rev 进 `read` 输出；

### 阶段 4：评测与体验

- §13.2 全部用例；
- 折叠提示词定稿；
- 二级归档摘要（只在需要时）；
- `/trace` 的折叠视图。

---

## 16. 被拒绝的方案

| 方案 | 为什么不做 |
|---|---|
| **向量库 / RAG 作为主记忆** | 文档小、结构清楚、按路径和小节精确寻址；embedding 会丢掉小节与 rev，还会引入不可复现的召回。真到上千章，加"章摘要索引"也比向量库稳 |
| **每轮重新总结整段历史** | 贵、慢、漂移；且会重复总结已经压掉的内容。折叠必须增量 |
| **把工具输出全部留在摘要里** | 等于不压缩；工具输出是材料，路径才是可恢复的表示 |
| **让 summarizer 同时维护故事设定与伏笔** | 生成物不可审计；D1 已拒绝 |
| **新增一个"记忆管理" agent** | 它是隐藏的 harness 能力，不需要用户可见角色；新增 agent 只会让"谁决定保留什么"变得模糊 |
| **摘要当作 canon** | 与diff 审批落盘、CAS、"用户看过的字节才落盘"全部冲突 |
| **state 常驻注入** | 每轮为只在写作前有用的东西付钱；改为折叠时快照 + 规划/正文时读取 |
| **文档常驻注入（`brief.md` / `world.md` 每轮进 system）** | 每轮为一份会过期的副本付钱，还让模型分不清"我读过"与"它一直在"；改回按需 `read` + 证据账 |
| **压缩时静默丢弃、不记账** | 用户与模型都不知道丢了什么；违反可观测性 |

---

## 17. 验收标准

架构落地后，下面每一条都必须为真，并有测试钉住：

1. 任意次折叠后，第一次折叠前的用户否决原话仍在 `<decisions>` 里。
2. 任意次折叠后，第一次折叠前的专名仍能从 `<session>` 或 `<project>` 里找回。
3. 折叠后最近一个 turn 的 tool call / result 结构与折叠前一致。
4. 规划被批准后，折叠不会让正文窗口丢失计划全文；重启也不会。
5. 一次折叠只写一条事件；summarizer 失败时窗口字节不变。
6. system 超限时不发请求、不进入压缩循环，给出可操作的错误。
7. 一次折叠后上下文低于 lowWater；下一次请求不再触发。
8. 任何被压掉的工具输出都能由 `<evidence>` 的 path#section@rev 重读；重读结果标出 rev 是否变化。
9. trace 能回答：压掉了多少、保留了什么、为什么现在压。
10. 所有用例离线通过，不需要真实模型。

---

## 附录 A：一次折叠的例子

**折叠前（工作集）**：

```
[user] 第 13 章我想让林晚先沉默，别急着认罪。
[assistant] …propose-plan…
[tool propose-plan] 已交给用户…
[user] 可以，按这个写。但把"账册"那一场往后挪一章。
[assistant] …read state/foreshadowing.md…（tool 结果 812 字）
[assistant] 好，我把承诺账里的"账册暴露"改到第 14 章。
```

**折叠记录（抽象）**：

```json
{
  "consumed": { "fromSeq": 12, "toSeq": 21, "turns": 3 },
  "summary": {
    "session": "第 13 章按用户要求让林晚保持沉默；用户同意规划，但要求把账册暴露推迟一章。",
    "open": ["第 14 章如何暴露账册，尚未细化。"],
    "pointers": ["state/foreshadowing.md", "第 13 章规划"]
  },
  "pinned": {
    "project": "……（state/progress.md 最后 7 节原文）",
    "promises": "……（未回收：账册暴露，计划第 14 章）",
    "decisions": [
      { "proposal": "plan:13", "verdict": "accept" },
      { "proposal": "plan:13", "verdict": "refine", "note": "把账册那一场往后挪一章" }
    ]
  },
  "evidence": [
    { "kind": "read", "path": "state/foreshadowing.md", "rev": "a1b2c3", "chars": 812 }
  ]
}
```

**折叠后模型看到的**：

```xml
<context-state>
  <project>……</project>
  <promises>……</promises>
  <session>第 13 章按用户要求让林晚保持沉默；用户同意规划，但要求把账册暴露推迟一章。</session>
  <decisions>accept plan:13；refine："把账册那一场往后挪一章"</decisions>
  <evidence>read state/foreshadowing.md @a1b2c3</evidence>
  <open>第 14 章如何暴露账册，尚未细化。</open>
</context-state>
```

注意：世界规则、人物卡、章节原文一个字都没进摘要；它们要么在常驻层，要么在磁盘上，要么由 `<evidence>` 指出重读坐标。

---

## 附录 B：开放问题

1. **`recentFloor` 的初始值**：建议先按 `usable` 的 20% 试，按评测调。
2. **`<archive>` 二级摘要**：先不做，只在 `<session>` 连续超预算时启动。
3. **证据账的保留条数**：建议 30 条，超出按"最近使用 + 当前章节相关"裁剪；裁剪规则要确定性。
4. **项目级失败账**：D2 已明确在本文范围外；未来 `state/failures.md` 应作为项目对象单独设计，不复用会话决定账。