# 感知架构提案：从 prose 分诊到每次请求的观察层

> **职责**：提出感知层的整体架构、控制流、数据模型、覆盖范围与落地顺序，供拍板。
> **读者**：要决定感知下一步怎么走的人；要改 `src/context/`、`src/session/`、`src/telemetry/` 的人。
> **对齐代码**：2026-11-26 · 提案 v0.1；observed + purpose 路由 + P2 defer 已落地（阶段 1/2 的一部分）；其余仍是拟议设计，未落地。
> 相邻：`perception.md`（当前设计）· `compaction.md`（对话折叠）· `telemetry.md`（事件）· `architecture.md`（一次请求）

**一句话**：感知是每次请求前的观察阶段；上下文分诊只是其中一个策略。当前代码只实现了 prose 分诊，本提案把它拆成“每次请求都观察、按 purpose 决定是否分诊、所有请求都留 trace”。

---

## 1. 现状：一个模式借用了系统的名字

> 2026-11-26 更新：`perception/observed`、purpose 路由与 P2 defer 已落地；下面的“现状”描述的是改造前，保留作动机。

【现状】`src/context/perception.ts` 是纯分诊函数；`src/context/perception_candidates.ts` 只采集 prose 候选；`src/session/session.ts` 的 `buildPerception` 只在下面四个条件同时成立时运行：

```ts
perceptionMode() !== "off"
agent.mode === "primary" && !agent.hidden
pending plan 已批准、未执行、有 chapter
plan 正文非空
```

其余请求直接返回 `undefined`：没有 plan，没有 `perception/plan` 事件，`request/header.perceptionHash` 是 `null`。

【现状】`profileFor` 对非 prose 返回 `P3 / tool.index`。这看起来支持所有 purpose，实际是把“不支持”伪装成“已分诊且全部延迟”。调用方拿 `chat` 来跑，会得到一份合法但空洞的 plan。

【现状】`perceptionMode` 默认 `shadow`，`inject` 只通过 `TALEMATE_PERCEPTION=inject` 打开；这是对的，先观测、不改变 prompt。

### 1.1 三个问题

| 问题 | 表现 | 后果 |
|---|---|---|
| 命名超前 | `perception.ts` 实际是 `context triage`；`perception_candidates.ts` 实际是 `prose candidates` | 读代码的人以为感知系统已经存在 |
| 缺失静默 | 非 prose 请求没有 envelope，没有 trace | 无法区分“不需要分诊”“还没实现”“出 bug” |
| 门控维度错 | 顶层用 `plan.approved && !plan.done` 代理“prose 窗口” | 加 revision / plan / chat 时会堆一串状态判断 |

**判断**：把第一版收在 prose 是对的——它的 P0 最硬，漏看代价最高。错的是让“只在 prose 运行”变成了“只在 prose 才有感知记录”。**选择性干预是对的，选择性失明不是。**

---

## 2. 目标与非目标

### 2.1 目标

1. **每次请求都有观察记录**：purpose、mode、有没有 profile、为什么没有、预算、缺口。便宜、无 I/O。
2. **分诊按 purpose 路由**：有 Profile 才采集候选、才分诊；没有就明确记 `no-profile`，不返回全 P3 的假 plan。
3. **干预分级**：`shadow` 只记录；`inject` 只对有 Profile、有 eval 的 purpose 打开。
4. **P0 不静默丢**：超预算、过期、缺失都进 trace；inject 时拒绝发送，shadow 时只记录。
5. **不生成第二份 canon**：感知只选材料、给坐标；不改写世界规则、用户原话、知识边界。

### 2.2 非目标

- 不做“每次请求都采集全部候选”——观察便宜，采集按 Profile。
- 不新增感知 agent，不新增感知工具。
- 不在感知层做审批、权限、治理。
- 不做向量库、多模态（第一版）。
- **不做材料语义压缩**（见 §8，待定）。

---

## 3. 架构：观察、注意、取回、编码、记录

```text
一次请求
  │
  ├─ observe（每次请求，便宜）
  │    purpose / mode / agent / profile? / 已在上下文的来源 / 缺口
  │    → PerceptionEnvelope
  │
  ├─ attend（有 Profile 才跑，可能读文件）
  │    collectCandidates(purpose) → triage(profile, budget) → ContextPlan
  │
  ├─ recall（缺口或发现任务才跑，后续）
  │    glob / grep / read / recall；有轮数与停止条件
  │
  ├─ encode（压缩；本提案不做）
  │    暂用“不压、defer 到工具”代替
  │
  └─ trace（有变化才写）
       perception/observed（无 plan）
       perception/plan（有 plan）
       request/header.perceptionHash
```

### 3.1 三个阶段的边界

| 阶段 | 回答 | 成本 | 何时跑 |
|---|---|---|---|
| **observe** | 这一步是什么 purpose？有没有 Profile？上下文里已经有什么？缺什么？ | 低（内存态） | 每次请求 |
| **attend** | 哪些候选进、P0–P3、放哪、include/defer/drop | 中高（读文件） | 有 Profile 且 mode ≠ off |
| **recall** | 不知道材料在哪时怎么找 | 高（多轮工具） | 缺口/核查任务，默认不跑 |
| **encode** | 进来之后怎么变短 | 待定 | 本提案不做 |

**关键**：observe 不等于 collect。每次请求都观察，不代表每次请求都读全书。

### 3.2 Envelope

```ts
export type PerceptionPurpose = "chat" | "plan" | "prose" | "revision" | "research" | "audit";

export interface PerceptionEnvelope {
  purpose: PerceptionPurpose;
  mode: "off" | "shadow" | "inject";
  profile: string;                 // "prose.v1" / "none"
  profiled: boolean;
  reason?: "off" | "not-primary" | "no-plan" | "no-profile" | "empty";
  context: {
    systemChars: number;
    messages: number;
    planInContext: boolean;
    openQuestions: number;
  };
  plan?: ContextPlan;              // 只有 profiled 才有
  hash: string;                    // envelope + plan 的稳定 hash
}
```

Envelope 只回答“这次感知看到了什么”，不复制正文。

### 3.3 Plan

沿用现有 `ContextPlan`：purpose、budget、decisions、missing。新增一个约束：

```ts
export type PerceptionAction = "include" | "defer" | "drop" | "compress";
```

`compress` 保留在类型里，但 **v1 的 triage 不产生它**；P2 只有“放得下就 include，放不下就 defer”。原因见 §8。

---

## 4. Purpose 分类

| purpose | 入口 | 典型 P0 | Profile 状态 |
|---|---|---|---|
| **chat** | 用户对话 / 设计讨论 | 当前指令、当前文档现文、未答问题 | 未做（轻量） |
| **plan** | 章节规划（mate 或 planner） | 章意图、序列契约、上一章结尾 | 未做 |
| **prose** | 写正文 | 已批准规划、场景人物知识边界、必须发生 | 【现状】shadow 已落地 |
| **revision** | 改稿 | 当前正文、用户原话、原规划契约 | 未做 |
| **research** | 考据 | 精确问题、范围、证据门槛 | 未做 |
| **audit** | 连续性核查（未来） | 待查正文、相关卡/规则/承诺 | 未做 |

`chat` 暂时包含“设计对话”。如果以后发现普通寒暄和设计决策的 P0 差异太大，再拆 `design`；现在拆是过早分类。

---

## 5. Profile 草案

Profile 是“这一步的默认注意力”，不是硬编码清单。同一份材料在不同 purpose 下层级可以移动。

| purpose | P0（必进，尾部） | P1（预算内进，头部） | P2（可进，中部） | P3（只给坐标） |
|---|---|---|---|---|
| **chat** | 当前指令、当前讨论的文档现文、未答提问 | 相关规则、已否决项、模式注记 | 更大范围的世界/人物、决定历史 | 全书语料 |
| **plan** | 章意图、序列契约、上一章结尾 | 在场人物卡/状态、未回收承诺、读者状态、卷纲 | 更大纲、决定历史、声音 | 全书 wiki/卡 |
| **prose** | 已批准规划、场景人物与知识边界、必须发生/不能兑现 | 读者状态、声音、场景世界规则、上一章结尾、progress | 决定历史、工艺账 | 全书章节/wiki/大纲 |
| **revision** | 当前正文、用户原话、原规划契约 | 声音、读者/承诺 | 决定/工艺 | 全书语料 |
| **research** | 精确问题、范围、证据门槛 | 已有考据 | 网页来源 | 全部考据 |
| **audit** | 待查正文、相关卡/规则/承诺 | 读者状态、规划 | 更早章节 | 全书语料 |

预算按 purpose 给默认值，可被 env 覆盖；先手写，跑真实项目后再调。

| purpose | 默认预算（token） | 说明 |
|---|---|---|
| chat | 4k | 对话短，重在当前指令与现文 |
| plan | 10k | 契约 + 人物 + 承诺 |
| prose | 12k | 【现状】默认 12k |
| revision | 12k | 正文本身可能很长，P0 优先 |
| research | 8k | 问题 + 已有结论 |
| audit | 12k | 正文 + 相关材料 |

预算不是模型窗口，而是“感知允许放进 system 的材料量”；真正的窗口由 compaction 与 provider 决定。

---

## 6. 控制与失败语义

### 6.1 mode

| mode | observe | plan | 改变 prompt | 用途 |
|---|---|---|---|---|
| `off` | 无（或只记 header 为 off） | 无 | 否 | 显式关闭 |
| `shadow` | 是 | 有 Profile 时 | 否 | 默认；收集证据 |
| `inject` | 是 | 有 Profile 时 | 是（仅 include/defer 之外的动作） | 只在有 eval 的 Profile 上开 |

建议从全局 env 过渡到 **per-profile gate**：

```text
TALEMATE_PERCEPTION=shadow
TALEMATE_PERCEPTION_INJECT=prose      # 只让 prose 注入
```

全局 `inject` 仍然可以强制所有 Profile，但默认不这么用。

### 6.2 无 Profile

不返回假 plan。Envelope：

```ts
{ purpose: "chat", mode: "shadow", profile: "none", profiled: false, reason: "no-profile" }
```

请求照常发送，system 不变。trace 里能查到“这次没分诊，因为没 Profile”。

### 6.3 P0 超预算 / 过期 / 缺失

| 情况 | shadow | inject |
|---|---|---|
| P0 超预算 | 记录 `p0-over-budget`，请求继续 | **拒绝发送**，报可操作错误（拆场/换模型/提高预算） |
| P0 stale | 记录 `stale-p0`，请求继续 | 拒绝发送，要求重取 |
| P0 候选缺失（无载体） | 进 `missing`，不拉低 coverage | 同左；这是 memory 覆盖问题，不是感知失败 |
| P1/P2 超预算 | defer，记原因 | defer，system 里没有它；工具可读 |

原则：**P0 宁可不发，也不静默截断。**

### 6.4 失败不炸请求

- observe 失败：envelope 记 `error`，请求继续。
- shadow 的 collect/triage 失败：记 `error`，请求继续。
- inject 的 plan 失败：拒绝发送，给出原因；不允许“悄悄退回旧 system”而不记录。

### 6.5 子代理

建议：

- **envelope：所有 agent 都有**（primary、planner、researcher），便宜、只读内存。
- **profile：逐步开**。planner 用 `plan`，researcher 用 `research`；第一阶段可以只 observe，不分诊。
- 子代理不能向用户提问，但感知记录不涉及提问，安全。

---

## 7. 候选与分诊

### 7.1 候选

沿用六条信号线 + 三类材料：

- 世界线、人物线、叙事线、读者线、作者线、声音线；
- 对话线、外部事实、任务态。

元数据保持：`authority` / `freshness` / `cost` / `size` / `expandable` / `alreadyInContext` / `gap`。

### 7.2 动作

| 动作 | 含义 | v1 |
|---|---|---|
| `include` | 原文进 system | 是 |
| `defer` | 只留坐标，工具按需读 | 是 |
| `drop` | 过期/重复/缺失，不进 | 是 |
| `compress` | 缩短后进 | **否**，见 §8 |

### 7.3 规则

1. P0：永远 include；超预算/过期按 §6.3 处理。
2. P1：预算内 include，否则 defer。
3. P2：放得下 include；放不下 defer；**不截断**。
4. P3：defer 到 `tool.index`。
5. `alreadyInContext`：drop，reason `already-in-context`；P0 coverage 把它算作已覆盖。
6. `freshness: stale`：drop；P0 按 §6.3。
7. `gap`：进 `missing`，不产生候选正文。

### 7.4 位置

- P0 → `system.tail`（紧挨生成，避免 Lost in the Middle）
- P1 → `system.head`（稳定、可缓存）
- P2 → `system.middle`（若 include）
- P3 → `tool.index`（路径 + 一行说明）
- 当前指令、用户原话 → `messages.recent` / 已在上下文

---

## 8. 材料语义压缩：本提案不做

### 8.1 为什么待定

“语义压缩”听起来像“用模型把材料缩短”，但在这个领域有三个风险：

1. **第二份 canon**：世界规则、人物知识边界、用户原话一旦被改写，就会和磁盘上的原文分叉。
2. **证据丢失**：截断或改写都可能切掉决定性的半句；而正文写作恰恰依赖这些细节。
3. **无法验收**：没有“压缩后证据是否还在”的指标，就无法证明它比“defer 到工具”更好。

【现状】`triageCandidates` 的 `compress` 只是 `sliceToTokens` 按 token 砍，可能砍在半句上。**它不是语义压缩，只是预算兜底。**

### 8.2 本提案的策略

- v1 **不产生 `compress`**。
- P2 放得下就 `include`，放不下就 `defer` 到工具；模型需要时 `read` 对应小节。
- P0 超预算不截断，按 §6.3 报错。
- 如果将来要做，先满足退出条件（见 §8.4），再单独设计。

### 8.3 与 compaction 的分工

| | compaction | 材料压缩（待定） |
|---|---|---|
| 对象 | 对话历史（turn） | 候选材料（P2） |
| 触发 | 窗口高水位 | 本次请求预算 |
| 生命周期 | 跨请求、累积、持久化 | 一次请求、重算 |
| 方法 | LLM 写对话叙事 + 确定性账 + pinned | 选小节 / 摘录 / 融合（不生成 canon） |
| 产物 | `context-state` 消息（messages） | system 里的 P2 块 |
| 失败 | 不折叠，旧窗口继续 | defer / drop / 报预算错误 |
| 共同底线 | 不生成第二份书的事实 | 不生成第二份书的事实 |

compaction **不是感知的一个 mode**，它是对话窗口的生命周期；它给感知提供 pinned 和证据账，感知据此去重、决定 P3。

### 8.4 将来重启压缩的退出条件

只有同时满足才做：

1. 只压非权威的 supporting 材料；权威材料只选小节、原文摘录。
2. 压缩产物带 `path@rev` 和省略范围，trace 能重建。
3. 有 eval 指标：关键证据保留率、P0 coverage、人工对照。
4. 失败可回退：压缩失败时 defer，不阻塞请求。
5. 用户能在请求详情里看到“这段被压过，原文在哪”。

---

## 9. 发现：先留契约，不急着做

发现是“不知道材料在哪时怎么找”，不是默认动作。

- 用现有 `read` / `glob` / `grep` / `recall`，不新增 agent。
- 触发：缺口、stale、连续性核查；不是每次请求。
- 循环：候选地图 → 广扫 → 精读 → 沿名字/章号继续 → 停（证据够 / 预算用完 / 无新命中）。
- 最多 N 轮（建议 3），每轮必须缩小范围或命中新证据。
- trace 记：查询、命中、进入、丢弃、轮数、停止原因。
- 第一版可以只留契约，不实现自动循环；模型仍可手动调用工具。

---

## 10. Trace 与 UI

### 10.1 事件

建议保留 `perception/plan`，新增 `perception/observed`：

| 事件 | 何时 | 内容 |
|---|---|---|
| `perception/observed` | 每次请求；无 plan 时也写 | purpose / mode / profile / profiled / reason / context / hash |
| `perception/plan` | 有 Profile 且 plan 变化 | 现有字段 + envelope 摘要 |
| `request/header.perceptionHash` | 每步 | 指向最近一次 observed 或 plan |

只记坐标与规模，不复制正文。按 hash 变化才写，避免每步一份。

### 10.2 指标

保留：`p0Coverage` / `dropped` / `stale` / `duplicate` / `missing` / `deferred` / `budget`。

新增：`purpose` / `profiled` / `noProfile` / `profile` / `reason`。

**移除或标废**：`compressionRatio`——v1 没有压缩，这个数没有意义。

### 10.3 UI

- 请求详情「感知」tab：有 plan 显示决策表；无 plan 显示 `未分诊：no-profile / off / not-primary / no-plan`。
- 轨迹摘要：按 purpose 分组的 observed / profiled 计数。
- 感知仍然不是轨迹表的一行；它是请求属性。

---

## 11. 与现有系统的接线

```text
Session.buildRequest(agent)
  → observe(agent, session)
      purpose = purposeOf(agent, session)
      envelope = { purpose, mode, profile, profiled, reason, context }
      if profile && mode != off:
        candidates = collect(purpose)
        plan = triage(candidates, profile, budget)
        envelope.plan = plan
  → assemble(system, messages)      // inject 且有 plan 时消费
  → chat()
Session.generate
  → trace("perception/observed" | "perception/plan")（hash 变化时）
  → trace("system/prompt")
```

- **compaction** 在请求前处理 messages；它的 pinned / 证据账可供 observe 使用。
- **proseWindow** 仍然负责把规划与文风卡放进 system；感知把它记为 `alreadyInContext`，不重复注入。
- **planner / researcher** 走同一 observe；profile 逐步开。

---

## 12. 落地顺序

| 阶段 | 做什么 | 行为变化 | 验收 |
|---|---|---|---|
| **0** | 拍板本提案 | 无 | 决策记录 |
| **1** | purpose 路由 + envelope + `perception/observed` + UI | 无（只记录） | 每个请求有 hash；无 Profile 有原因 |
| **2** | prose 硬化：P2 不截断、P0 超预算显式、去掉 compress | shadow 无变化；inject 更安全 | 单测 + prose eval |
| **3** | `revision` Profile（推荐第一个新 Profile） | shadow | 改稿 P0 覆盖 |
| **4** | `plan` / `chat` Profile | shadow | 各自 eval |
| **5** | 按 Profile 打开 `inject` | 有 | shadow/inject 对照无回归 |
| **6** | 发现循环 / 压缩（若退出条件满足） | 待定 | 单独设计 |

**建议第一个新 Profile 是 revision**：它和 prose 共用大部分材料，但 P0 换成“当前正文 + 用户原话”，能直接验证“同一份材料在不同 purpose 下层级移动”这个核心命题。

---

## 13. 需要拍板的决策

| # | 决策 | 建议 | 备选 | 影响 |
|---|---|---|---|---|
| D1 | `perception` 的命名 | 保留为伞；当前模块移入 `perception/triage` | 改名 `context_triage` | 代码结构与文档一致性 |
| D2 | 每次请求 envelope | 是，便宜、只读内存 | 只 prose | 可观测性 |
| D3 | purpose 路由 | 是，替代 `plan.approved` 顶层门控 | 继续用状态门控 | 可扩展性 |
| D4 | 材料语义压缩 | 本提案不做；P2 defer | 只做原文摘录 | 风险与工作量 |
| D5 | v1 动作 | include / defer / drop | 保留 truncate | 是否静默丢证据 |
| D6 | 子代理覆盖 | envelope 全部；profile 逐步 | 只 primary | 盲区 |
| D7 | 事件形状 | `observed` + `plan` 两事件 | 单一 `record` | 迁移成本 |
| D8 | 首个新 Profile | revision | plan / chat | 验证核心命题 |

---

## 14. 验收标准

1. 每个请求都有 `perceptionHash`；无 Profile 时有 `reason`，不是 `null`。
2. `purpose` 由路由得出，不再用 `plan.approved` 做顶层门控。
3. `profileFor` 对不支持的 purpose 返回 `undefined`，不返回全 P3 假 plan。
4. P0 覆盖可解释；P0 超预算/过期在 shadow 记录、inject 拒绝发送。
5. v1 不产生 `compress`；P2 放不下就 defer，不静默截断。
6. shadow 逐字不改变旧 system；inject 只在有 Profile + eval 时开。
7. 请求详情能看到“未分诊”的原因；轨迹摘要能按 purpose 统计。
8. 全部单测离线；eval 覆盖 prose、revision、no-profile 三类。

---

## 附录 A：现状代码地图

| 行为 | 位置 |
|---|---|
| 感知门控 | `src/session/session.ts` 的 `buildPerception` |
| 候选采集 | `src/context/perception_candidates.ts` 的 `collectProseCandidates` |
| 分诊 | `src/context/perception.ts` 的 `triageCandidates` / `profileFor` |
| 事件 | `src/telemetry/events.ts` 的 `perception/plan` |
| 投影 | `src/telemetry/projection.ts` 的 `projectPerception` |
| 请求详情 | `src/telemetry/request_detail.ts` 的 `perception` 字段 |
| UI | `desktop/src/renderer/Trace.tsx` 的感知 tab |
| 文档 | `docs/perception.md`（设计）· `docs/compaction.md`（折叠） |

## 附录 B：本提案明确不做的事

- 不做材料语义压缩（D4）。
- 不做“每次请求读全书”的候选采集。
- 不新增感知 agent / 感知工具。
- 不在感知层做审批、权限、治理。
- 不用感知替代 compaction。
- 不把感知做成轨迹表的一行。
- 不把 `profileFor` 的 P3 兜底当成“已支持”。