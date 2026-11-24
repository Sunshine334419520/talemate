# 感知层：把高信号材料放进这一步的上下文

> **职责**：定义 Agent 每一步推理之前，哪些材料有资格进入上下文、以什么层级和位置进入、哪些压缩、哪些留在工具后面、以及如何记录这次感知决策。
> **读者**：要改 `src/session/`、`src/context/`、`src/framework/`、`prompts/*` 的人；以及要判断"某次输出错在模型，还是错在模型一开始就没看到"的人。
> **对齐代码**：2026-11-23 · shadow 已落地并默认开启；inject 已接上（`TALEMATE_PERCEPTION=inject`，只给 eval 对照用，默认不开）；发现未做。标【现状】的部分已按当前代码核对；其余是本文的设计。本文不受既有接口约束；旧版以“生产单元/问题登记表”为中心，已废弃。
> **相邻**：`compaction.md`（语义压缩：折叠、证据账）· `architecture.md`（一次交互怎么走）· `state.md`（状态层）· `design-docs.md`（四类活文档）· `chapter-planning.md`（章节生产）· `telemetry.md`（事件与 trace）· `perception-triage.md` / `perception-discovery.md`（分诊与发现的详细设计，待写）

**一句话**：感知不是"把该知道的都放进去"，而是"这一步推理需要的最小高信号材料，按正确的层级和位置进入上下文，其余留在工具后面"。

---

## 1. 感知是入口闸

传统软件的输入由 schema 定义：调用方传什么，函数就处理什么。Agent 的输入是 prompt：**谁进、谁不进、按什么顺序进、压缩到什么粒度，全是设计决策。** 每一个 token 都在花预算——attention、KV cache、API 计费。

```text
Agent 每一步：
  感知 → 决定这次推理能看到什么
  推理 → 只能加工已经进入上下文的材料
  行动 → 把结论变成对书/文件的改动
```

推理不能凭空补回没看见的事实。模型看到的噪声太多，也会稀释真正重要的证据。所以感知的优化目标不是"信息尽可能全"，而是：

> **让下一次推理质量最大化的最小高信号 token 集合。**

它同时决定三件事：

1. **资格**：哪些材料有资格进入这一次上下文；
2. **层级与位置**：谁放头部、谁放尾部、谁压缩、谁根本不进；
3. **可恢复性**：没进来的材料，模型之后怎么按坐标取回。

感知不是预处理，是架构问题。它和数据建模、API 设计、容量规划同一量级。

---

## 2. 四个模式，一份总方案

双轴矩阵里的感知四式各是独立设计对象。**这份文档是总方案**，只定义小说 Agent 的候选、分级、位置、压缩取舍、发现契约与追踪；每个模式的内部算法由专文补齐。

| 模式 | 解决什么 | 文档 | 状态 |
|---|---|---|---|
| **上下文分诊** | 哪些材料进这一步的上下文，P0/P1/P2/P3，放哪 | 本文给模型；`perception-triage.md` 补打分与阈值 | 本文 |
| **语义压缩** | 进来之后怎么变短而不丢关键证据 | `compaction.md` | 已落地 |
| **渐进发现** | 一开始不知道材料在哪，怎么逐步找 | 本文给契约；`perception-discovery.md` 补策略 | 本文 |
| **多模态融合** | 图、表、PDF、日志等异类信息怎么进 | 本文留位；需要时单独设计 | 暂缓 |

**小说项目当前基本是文本**：设定、状态、章节、笔记都是 markdown；所以多模态不是第一版问题。真正要解决的是：**在正确的位置，给模型看正确的几段文本。**

---

## 3. 候选：这本小说有哪些信息可能进上下文

不按文件分，按"这本书必须保持什么"分。六条信号线 + 三类材料。

### 3.1 六条信号线

| 信号线 | 回答什么 | 典型载体 | 变化速度 | 默认层级 | 压缩方式 |
|---|---|---|---|---|---|
| **世界线** | 规则、事实、术语、地名 | `design/core.md`、`design/wiki/*`、卷/序列纲 | 慢 | P1 | 选小节、引用原文；不转述成摘要 |
| **人物线** | 他是谁、此刻要什么、知道什么/不知道什么 | 角色卡 + `state/characters/*` | 卡慢、状态快 | P0/P1 | 卡是基线，状态是"现在"；知识边界必须原文 |
| **叙事线** | 写到哪、欠什么、这一章是什么型、要推进什么 | `state/progress.md`、`state/foreshadowing.md`、规划 | 每章变 | P0/P1 | 窗口 + 过滤；只留未回收承诺 |
| **读者线** | 读者知道/不知道/期待/被欠什么 | 读者账（待建） | 每章变 | P1 | 每章四行，最近窗口 |
| **作者线** | 作者要什么、否过什么、为什么 | 会话决定、工艺账（待建） | 长半衰期 | P1/P2 | 原话保留，按相关度截取 |
| **声音线** | 视角、语域、节奏、禁用写法 | 文风卡、`prose.rules`、工艺账 | 长半衰期 | P1 | 融合成一份声音简报，不贴整章 |

### 3.2 三类材料

| 材料 | 例子 | 默认层级 | 处理 |
|---|---|---|---|
| **对话线** | 历史消息、工具结果 | 工作集/P3 | 最近 turn 原文；更早折叠；工具结果只留指针 + 首段/结论 |
| **外部事实** | 考据本、网页 | P2/P3 | 结论 + 出处；整页留在工具后面 |
| **任务态** | 当前指令、模式、待批提案、批准规划 | P0 | 原文；规划全文进尾部 |

这张表是感知的**候选池**。分诊的第一步不是扫全部文件，而是问：**这一步属于哪几条信号线？**

---

## 4. 上下文分诊：P0 / P1 / P2 / P3

### 4.1 层级定义

| 层 | 含义 | 处理 |
|---|---|---|
| **P0** | 不在就会写错 | 必须进；放在**尾部**或最新请求附近；原文优先，不压缩 |
| **P1** | 不在会写偏/写飘 | 应进；放头部或紧随 P0；可做融合，但要保留来源 |
| **P2** | 有用，但可压缩/截取 | 压缩后进；只保留与这一步相关的片段 |
| **P3** | 默认不进 | 留在工具/文件后面，只给索引与取数坐标 |
| **Never** | 过期、重复、已被替换、已否决 | 直接丢弃；在 trace 里记原因 |

**层级不是材料的固有属性，是这一步赋予的。** 同一份"上一章结尾"，规划时可能是 P0，写第三场时可能降到 P1/P2。

### 4.2 按步骤给 Profile

| 步骤 | P0 | P1 | P2 | P3 |
|---|---|---|---|---|
| **对话/设计** | 当前指令、目标文档现文 | 相关规则、已否决项、未答提问 | 更大范围的世界/人物、工艺账 | 全书语料 |
| **规划一章** | 章意图、章型、上一章结尾 | 在场人物、未回收承诺、读者状态、卷/序列契约 | 更大纲、决定历史、声音 | 全书 wiki/卡 |
| **写正文** | 已批准规划、场景人物与知识边界、必须发生/不能兑现 | 读者状态、声音、场景世界规则、上一章结尾 | 决定历史、工艺账、更宽的承诺 | 全书章节/wiki |
| **改稿** | 当前正文、用户原话 | 原规划契约、声音、读者/承诺 | 决定/工艺 | 全书语料 |
| **查事实** | 精确问题、范围、证据门槛 | 已有考据 | 网页来源 | 全部考据 |
| **连续性核查**（未来） | 待查正文、相关卡/规则/承诺 | 读者状态、规划 | 更早章节 | 全书语料 |

Profile 是**分诊的起点**，不是硬编码清单：同一步骤的不同回合，P0/P1 可以移动。

### 4.3 位置也是分诊

```text
system（头部）  角色、规则、常驻核心/世界观（稳定、少变）
system（中部）  P2 压缩件（越大纲、旧决定、背景）
system（尾部）  P0 + 高 P1（紧挨生成；避免 Lost in the Middle）
messages        最近对话原文；当前用户消息在最后
工具索引        P3 的路径 + 一行说明；不展开正文
```

三条规则：

1. **P0 不放中间。** 长上下文对开头和结尾更敏感；P0 必须在尾部或最新请求附近。
2. **稳定规则放头部，变化状态放尾部。** 头部每轮变化小，值得缓存；尾部每轮重算。
3. **P3 不进 prompt 正文。** 只给 `list` / `search` / `read` 的入口；模型需要时自己取。

inject 的渲染只取 `include` / `compress` 且**尚未在上下文里**的决定：每块以
`<perception purpose placement>` 包裹，每个来源一个 `<perception-item tier source>`。
已在 system/messages 的候选在分诊时就是 `drop`（`already-in-context`），不会重复出现。

### 4.4 分诊输入

每个候选带元数据，分诊按它决策：

| 元数据 | 用途 |
|---|---|
| **authority**：authoritative / current / supporting / inferred | 权威材料不能被推断替代 |
| **freshness**：fresh / stale（带 rev） | 过期的 P0/P1 不能进；要么重取，要么报错 |
| **cost**：free / cheap / expensive / interrupt | 常驻 < 计算 < 状态 < 文档小节 < 章节正文 < 外网 < 问用户 |
| **size**：字符/token | 决定压缩还是丢弃 |
| **expandable**：能否按 path/section 再取 | P3 与发现的入口 |
| **already-in-context**：是否已在常驻/窗口/证据账里 | 去重，避免同一份材料出现两次 |

分诊不是“把候选全部塞进去再排”，而是**先决定资格与层级，再决定位置与粒度**。

### 4.5 输出

```ts
export type Purpose = "chat" | "plan" | "prose" | "revision" | "research" | "audit";

export type Tier = "P0" | "P1" | "P2" | "P3";

export type Placement =
  | "system.head"
  | "system.middle"
  | "system.tail"
  | "messages.recent"
  | "tool.index";

export type Action = "include" | "compress" | "defer" | "drop";

export interface ContextDecision {
  candidate: ContextCandidate;
  tier: Tier;
  action: Action;
  placement: Placement;
  /** compress 后的文本；include 时为空（直接用原文） */
  text?: string;
  /** 给 trace 看的原因：p0-current-instruction / stale / duplicate / over-budget … */
  reason: string;
}

export interface ContextPlan {
  purpose: Purpose;
  budget: { ceiling: number; used: number };
  decisions: ContextDecision[];
}
```

`assemble` 消费 `ContextPlan` 生成 system 与 messages；`perception/trace` 事件记录决策的坐标与规模，不复制正文（正文在 `system/prompt` 里）。

---

## 5. 先选择，后压缩

小说项目最容易犯的错，是把 canon 压成摘要。**能选小节就不要压；能引用就不要转述。**

| 内容 | 做法 |
|---|---|
| 对话历史 | 折叠：累积摘要 + 证据账 + 最近 turn 原文（见 `compaction.md`） |
| 工具结果 | 原始材料：指针 + 首段；结论（task/recall）：正文，限长 |
| 世界规则 | 只取这场戏用到的小节，原文 + `path@rev`；不生成"规则摘要" |
| 人物卡 | 基线保留；当前状态取 `state/characters`；知识边界必须原文 |
| 承诺账 | 只留未回收条目 |
| 作者决定 | 原话保留，按章/人物/路径截取 |
| 声音 | 文风卡 + 校正 + 最新章节样例，融合成简报 |
| 外部事实 | 结论 + 出处，不贴整页 |

两条硬规则：

1. **压缩的是材料，不是权威。** 世界规则、用户原话、知识边界这类东西，宁可只取一段，也不要让模型改写成摘要。
2. **先丢再压。** 不在这一步视野里的，直接 P2/P3 或不进；只有"必须进但太长"的才压缩。

### 5.1 语义压缩的边界

- **对话折叠**已有完整方案（`compaction.md`）：turn 为单位、累积、证据账、pinned。
- **材料压缩**是感知层的事：选小节、截取、融合；**不生成第二份 canon**。
- 单份 P0 超预算 → 不静默截断，报可操作错误："这一场的规划 + 人物知识边界需要 X 字，上限 Y；请拆场/换模型。"
- P2 超预算 → 压缩或降级为 P3 坐标。
- P3 永不进正文。

---

## 6. 渐进发现：需要，但形态是 Agentic Search

小说的语料是**路径清楚、名字精确、体量有限**的。所以：

- **不需要向量库做主检索。** 按名字/术语/路径精确找，比 embedding 召回更稳、可引用、可复现。
- **需要 Agentic Search。** 典型问题：这条伏笔最早埋在哪？这个词在哪几场出现过？这个人物第一次出场怎么写的？这一段和哪条设定冲突？答案位置一开始不知道。

### 6.1 发现循环

```text
问题/缺口
  → 候选地图：list / 已知锚点 / 名字与术语
  → 广扫：search（40 条上限）
  → 精读：read section（12k 上限，offset 续读）
  → 沿人名/术语/章号继续找
  → 停：关键问题有证据 / 预算用完 / 没有新命中
```

- 用现有 `list` / `search` / `read`；**不新增发现 agent**。
- 最多 N 轮（建议 3），每轮必须缩小范围或命中新证据；没有进展就停。
- 不使用"把 2000 个文件全读一遍"式扫描。
- 整个过程进 Perception Trace：查询、命中、进入、丢弃、轮数。

### 6.2 什么时候不需要发现

写正文时，规划、人物、读者、声音大多已知；发现只用于**缺口**与**连续性核查**，不是默认动作。默认动作是分诊 + 压缩。

外部事实仍走 researcher + 考据本 + 外网，不并入本书发现。

> 发现的详细策略（何时广扫、何时精读、如何终止、如何合并多轮结果）见 `perception-discovery.md`；本文只钉契约。

---

## 7. 多模态融合：先留位

小说项目当前基本是文本。第一版不做；未来出现参考图、地图、时间线表格、研究 PDF 时：

- 先判断**核心信号在空间关系里，还是在文字内容里**；
- 空间关系（地图、版式、表情）保留原图或结构化描述；
- 文字内容抽取成文本；
- 不把整张图/整个 PDF 塞进上下文。

---

## 8. Perception Trace：这个模块真正的产物

不是"问题都问了吗"，而是**这一步的上下文决策记录**：

```text
purpose=prose.chapter13.scene2
candidates 34 · entered 6 · compressed 2 · deferred 23 · dropped 3
P0: plan.beats, scene.cast.knowledge        → system.tail
P1: reader.state, voice.brief, prev.ending   → system.head
P2: wiki.night_banquet 1.5k→0.4k, decisions 1.1k→0.3k
P3 behind tools: full world, ch.11, foreshadowing ledger
dropped: outline.old_section (redundant), core@old_rev (stale)
budget 7.2k/12k · compression_ratio 0.42 · stale 1 · duplicate 2
```

### 8.1 指标

| 指标 | 回答 |
|---|---|
| `budget_usage` | 这次用了多少预算，离上限多远 |
| `p0_coverage` | P0 候选是否全部进入 |
| `dropped_count` | 丢了多少，为什么 |
| `compression_ratio` | 压缩前后比例 |
| `p3_hit_rate` | 留在工具后面的材料，后来真的被取了没有 |
| `stale_count` | 有多少候选因过期被拒 |
| `duplicate_count` | 有多少候选因已存在被去重 |
| `discovery_rounds` | 发现用了几轮、是否收敛 |

### 8.2 事件

```ts
"perception/plan": {
  step: number;
  purpose: Purpose;
  chapter?: number;
  hash: string;
  builtAt: number;
  budget: { ceiling: number; used: number };
  decisions: Array<{
    id: string;
    tier: Tier;
    action: Action;
    placement: Placement;
    source: { kind: string; path?: string; section?: string; rev?: string; seq?: number };
    sourceChars: number;
    chars: number;
    reason: string;
  }>;
  missing: string[];
  metrics: { p0Coverage: number; dropped: number; compressionRatio: number; stale: number; duplicate: number; missing: number; deferred: number };
};
```

只记坐标与规模；正文在 `system/prompt`。**按 hash 变化才写**：每一步的 `request/header` 带
`perceptionHash`，所以"这个请求看到了什么"仍可从最近一条 plan 重建，而事件账不会每步复制一份。
`/trace` 加一行感知摘要；感知**不是轨迹表里的一行**——它是某一步请求的决策，桌面端在有
`requestSeq` 的记录详情里按 `request/header.perceptionHash` 展开，不拿最近一条冒充。

`P0` 覆盖只算已存在的 P0 候选；缺载体（`state/reader.md` 未建立这类）进 `missing`，不拉低
`p0Coverage`——"没有这份材料"和"有却没进去"是两件事，不能混成一个小数。

---

## 9. 与现有系统的接线

### 9.1 一次请求

```text
Session.buildRequest(agent)
  → collectCandidates(purpose, project, session)
      resident / state / plan / chapters / decisions / craft / reader / tool results
  → triage(candidates, purpose, budget)
      → ContextPlan { decisions }
  → assemble(plan)（v1 shadow 不消费；inject 才消费）→ system + messages
  → chat()
Session.generate
  → trace("perception/plan", plan)（hash 变化时）
  → trace("system/prompt", system)
```

感知在**每次请求前**运行，不是"开工前装配一次"。一章有几十次请求，每次的分诊结果可以不同。

### 9.2 与折叠的关系

- **感知**：这次请求前选什么、放哪、压缩多少。
- **折叠**：历史对话太长之后，把最老的一段变成上下文记录（`compaction.md`）。
- 折叠的证据账告诉感知"这些材料已经在窗口里/已被压掉，重读坐标在哪"；感知据此去重、决定 P3。
- 两者都不生成 canon。感知单不落盘；折叠记录落一条事件。

### 9.3 工具与发现

- `read` / `search` / `list` / `recall` 既是 P3 的取数口，也是渐进发现的执行口。
- 工具边界的上限（read 12k、search 40、list 80、task 12k）是感知预算的第一道，不是最后一道。
- 常驻文档去重：`core.md` / `wiki/world.md` 已在 system，`read` 不再返回全文。
- **不新增感知工具、不新增 agent。**

### 9.4 与记忆/治理的边界

- 读者账、工艺账、作者决定属于 **memory**：回答"什么必须跨请求保持"。感知只把其中相关条目作为候选。
- 批准、不可逆、权限属于 **governance**。感知不负责"必需问题都答上"，只负责"这次上下文看到了什么"。
- 如果某类材料长期缺失（例如没有读者账），那是 memory 覆盖问题，不是感知失败。感知会在 trace 里记"候选缺失"，但不会自己造一份。

### 9.5 与旧设计的替换

| 旧版（已废弃） | 新版 |
|---|---|
| 生产单元 / 感知单元 | `Purpose`（步骤目的）；单元最多是 profile 标签 |
| 问题登记表 + 必需缺口门 | 候选池 + P0-P3 分诊；缺口是 trace，不在这里做治理 |
| 感知单 `/perception-brief` | `ContextPlan` + `perception/plan` 事件 |
| reader/craft/decisions 写进感知 | 它们是 memory 的载体，感知只当候选 |
| required/expected/optional | P0/P1/P2/P3 + include/compress/defer/drop |
| planner "读缺口" | planner 同样走分诊；P3 材料用 read 按需取 |

---

## 10. 第一版做什么

1. **候选模型**：六条信号线 + 三类材料；带 authority/freshness/cost/size/expandable。
2. **分诊 Profile**：先做 `plan` / `prose` / `revision` 三个；`chat` 用轻量版。
3. **位置**：system.head / system.tail / system.middle / tool.index；P0 放尾部。
4. **压缩取舍**：P2 截取/融合；P3 只留坐标；P0 超限报错。
5. **发现**：复用 `list`/`search`/`read`，最多 3 轮，记录 trace；不新建 agent。
6. **Perception Trace**：`perception/plan` 事件 + 指标。
7. **不做的**：多模态、向量库、问题登记表、在感知层做审批门、reader/craft 自动生成。

先跑两三章真实项目，观察 P0/P1 的权重、位置、压缩比是否真的影响输出，再调 Profile 与阈值。

**当前落地（2026-11-23）**：只做 `prose` 的 shadow。候选来自已批准规划、当前指令、常驻 core/world、
角色卡与角色此刻、`progress`、未回收承诺、上一章结尾、上一轮决定、常驻声音简报；`state/reader`、
`state/craft`、`state/knowledge`、`state/relations` 还没有载体，按 `missing` 记入 trace。
`/trace` 已显示 plan 次数、P0 覆盖、延迟/丢弃/过期/重复/缺失与最近预算；inject 已可用
（`TALEMATE_PERCEPTION=inject`，只给 eval 变体对照），发现循环未做。
默认 shadow：`TALEMATE_PERCEPTION=off` 可关掉，`TALEMATE_PERCEPTION_TOKENS` 覆盖 12k 预算。

---

## 11. 验收标准

1. 每一步的 `request/header` 都有 `perceptionHash`；hash 变化时写一条 `perception/plan`，能重建候选、层级、动作、位置与来源 rev。
2. 同一份材料不在上下文出现两次（常驻/窗口/证据账去重）。
3. P0 候选全部进入；P0 超预算时报可操作错误，不静默截断。
4. P0 位于 system 尾部或最新请求附近，不在长上下文中部。
5. 过期的候选不进入；要么重取，要么在 trace 里记 `stale`。
6. P2 有明确的压缩/截取与来源，不生成第二份 canon。
7. P3 默认不进正文；模型需要时能按坐标取回。
8. 发现循环有轮数上限与停止条件；没有"读完全书"的默认路径。
9. trace 能回答：这次看到了什么、丢了什么、为什么、关键证据落在哪个位置。
10. 全部用例离线通过；不需要真实模型。

---

## 附录 A：第 13 章第二场的 ContextPlan 示例

```text
purpose=prose, chapter=13
budget=12000

P0  plan.ch_13/必须发生          include  system.tail   1.2k
P0  scene.cast.knowledge         include  system.tail   0.8k
P1  reader.state                 include  system.head   0.5k
P1  voice.brief                  include  system.head   0.9k
P1  chapter12.ending             include  system.head   0.6k
P1  wiki.night_banquet/座次       include  system.middle 0.4k
P2  decisions.relevant           compress system.middle 1.1k→0.3k
P2  craft.voice                  compress system.middle 0.6k→0.2k
P3  design/wiki/world.md         defer    tool.index    —
P3  chapters/chapter_ch11_v1.md  defer    tool.index    —
P3  state/foreshadowing.md       defer    tool.index    —
drop outline.vol2/old-section    drop     —             redundant
drop core@old-rev                drop     —             stale
```

## 附录 B：候选元数据

```ts
export interface ContextCandidate {
  id: string;
  line: "world" | "character" | "narrative" | "reader" | "author" | "voice" | "dialogue" | "external" | "task";
  text: string;
  chars: number;
  authority: "authoritative" | "current" | "supporting" | "inferred";
  freshness: "fresh" | "stale";
  source: {
    kind: "resident" | "doc" | "state" | "derived" | "session" | "user" | "web" | "tool";
    path?: string;
    section?: string;
    rev?: string;
    seq?: number;
    label?: string;
  };
  cost: "free" | "cheap" | "expensive" | "interrupt";
  expandable?: { tool: "read" | "search" | "recall"; path?: string; query?: string };
}
```

## 附录 C：开放问题

1. **P0/P1 的默认权重**：先按本文件 Profile 手动写，跑真实章节后调；不要先上学习型打分。
2. **头部/尾部的实际效果**：`system.tail` 是否足够接近生成，还是要 P0 作为最后一条 user 消息？先用 system.tail 测。
3. **P3 的索引粒度**：只给路径 + 一行说明，还是给 `list` 目录？先给路径 + 标题索引。
4. **发现轮数**：3 轮是否够；以"没有新命中"为停条件是否需要更细的收敛判据。
5. **读者账/工艺账**：属于 memory 的设计；感知只预留 reader/author 两条信号线，不在本文件定义格式。
6. **多模态**：小说项目何时真正需要图/表；在此之前不做。
7. **压缩与位置的冲突**：P0 原文太长时，是拆场、报错，还是允许摘录？倾向报错，不静默改写。