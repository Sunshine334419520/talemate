# 讨论记录 · 小说框架的知识载体 + opencode 的 plan / plan-mode 机制

> 日期：2026-09-05（未定稿）· **2026-09-06 更新见文末 §7**（懒建 + doc-spec 取代预种 / DESIGN_PROTOCOL 自动注入）
> 主题：小说框架内容该不该常驻 / 为什么维护框架不是 SubAgent / 知识为什么要用 Skill / opencode 的 plan-mode 是什么
> 源码依据：`~/code/opencode/packages/opencode/src/`（agent.ts / reminders.ts / tool/plan.ts / skill/index.ts / cli/cmd/run.ts）

> ## ⚠️ 阅读指引（2026-09-06）：仅 §7、§8 为现行
>
> §0–§6 是早期讨论/决策过程记录，其中多处已被推翻：`<nvl-state>` 锚点已删除、DocKind 骨架"播种进文件"已改为**懒建 + doc-spec 按需**、维护纪律"放 editor.system"已被 §6.6 修正、`DESIGN_PROTOCOL` 自动注入已取消。**以 §7（懒建 + doc-spec）、§8（core/world 收敛）为准**；§0–§6 只作决策历史，读代码时不要按它们对照。实现以 `05-agent-spec.md`、`07-editor-framework-design.md` 与 `src/` 为准。

---

## 0. 起于四个连环疑问

1. 小说框架（docs/：core/world/characters/outline）是我们后续一切的基础——为什么不是像 AGENTS.md 一样**常驻**？
2. "维护框架"是一件有明确产出的活，为什么不是 **SubAgent**？
3. 你说方法放 **Skill**，那 opencode 到底用什么机制处理这类"角色长期按方法产出结构化文档"的事？它似乎没有内置 skill。
4. plan-mode 又是什么？之前不是说 plan 是 opencode 的 SubAgent 吗，为什么还有 plan-mode？

结论先行（正文逐步给证据）：

- **框架内容**不能全文常驻（会长大），正确形态是"**精炼锚点常驻 + 全文按需 read-doc + 大综合才派 subagent**"。
- **维护框架 = editor 的对话职责**（用户全程拍板），不是一次隔离任务 → 不是 SubAgent。subagent 只用于其中"一次读全量再产出一致结构"的大步骤。
- **方法 ≠ Skill**。方法属于 editor 处于"设计 phase"时每轮该在的东西，对应 opencode 的"**agent 人格/phase 注入**"档（①③），不是按需加载的 skill（④）。skill 只放**题材等附加知识**。
- opencode **只有 1 个内置 skill**（`customize-opencode`，代码注入 `location:"<built-in>"`）；它的核心知识不在 skill 里，而在 agent 人格 + AGENTS.md + compaction 锚点。
- **plan 是 primary Agent，不是 SubAgent**（源码 mode:"primary"）。"plan-mode" = 会话的当前 agent 是 plan 时的状态。进入/退出由 plan_enter/plan_exit 门控，退出由 plan_exit 工具注入一条绑回 build 的合成消息。

---

## 1. opencode 的"知识"有 5 档载体（源码证据）

| 档 | 载体 | 何时进上下文 | 谁决定 | 谁拥有 | 出处 |
|---|---|---|---|---|---|
| ① | **agent 的 system prompt**（人格） | 每轮 | harness | 核心产品（代码，删不掉） | `agent.ts` 的 `PROMPT_BUILD/EXPLORE/COMPACTION…`；build/plan/compaction/title/summary 全在这 |
| ② | **AGENTS.md / instruction 文件** | 每轮 | harness | 项目（用户自己的） | session 组装读盘 |
| ③ | **phase 注入的系统提醒** | 处于该 phase 的每一轮 | harness | 核心产品 | `reminders.ts`：agent 是 plan 时把 plan 方法拼进当轮 user 消息 |
| ④ | **skill** | 模型判断"该用了"→ 调 skill 工具 | 模型 | 内置=代码 `<built-in>`；其余=用户磁盘 | `skill/index.ts`：唯一内置 `customize-opencode` 从代码注册，磁盘同名可覆盖 |
| ⑤ | **subagent**（task 工具） | 一次性隔离上下文 | 模型 | — | `tool/task.ts` |

**读法**：越靠上越"常驻、harness 保证、删不掉"；越靠下越"按需、模型发起、用户可扩展"。**选择哪档不看"这个产出是什么文档"，而看两问：(a) 它每轮都要在吗？(b) 它属于核心产品还是用户扩展？**

关键事实：
- opencode 处理"一个角色长期按固定方法产出结构化文档"用的是 **①/③**（角色人格 + phase 注入），**不是 skill，更不是 subagent**。
- **subagent 承载不了"常驻"**：它是隔离、一次性、跑完即死；常驻只能由 harness 每轮组装。

---

## 2. plan 与 plan-mode（澄清"plan 是不是 SubAgent"）

### 2.1 plan 是 primary Agent

`agent.ts` 内置 agent：`build`（primary）、`plan`（**primary**）、`general`/`explore`（**subagent**）、`compaction`/`title`/`summary`（hidden primary）。

- 只有 `mode:"subagent"` 的（general/explore）能进 task 工具的可派列表（registry 的 `describeTask` 只列非 primary）。
- **plan 不在 task 可派列表里**——它不可能是 subagent。它是"会话切换成 plan 这个人格"。

### 2.2 "plan-mode" = 会话当前 agent 是 plan 时的状态

- **人格**：plan 有自己的一套 permission（`agent.ts` 的 plan 定义）：只允许写 plan 文件（`.opencode/plans/*.md`）、允许 `question` 和 `plan_exit`、`task` general deny（不能派 general 子代理）、不能 edit 代码。→ 这就是"plan 模式不许改代码"的实现。
- **每轮注入**：只要会话 agent === "plan"，`reminders.ts` 就把 plan 的方法文本（`plan-mode.txt` / `PROMPT_PLAN`，内含 Phase 1→5）**自动拼进当轮 user 消息**——不需要模型记得 load，不会因为 compaction 丢掉。
- **产出文件**：plan 把计划写进一个 plan.md 文件（`Session.plan` 定位）；要用 read/edit。
- **进入/退出**：`plan_enter` / `plan_exit` 是两个权限点（build 允许 plan_enter；非交互 CLI 会 deny 两者）。退出由 `tool/plan.ts` 的 PlanExitTool 问用户"计划好了，切回 build 开始实现？"，确认后**注入一条 `agent:"build"` 的合成 user 消息**（"you can now edit files, execute the plan"），下一轮 loop 读到 `lastUser.agent=build` 就换人格。

### 2.3 对 Claude Code 的映射

- Claude Code 的 plan mode ≈ 一个由用户切换的 harness 模式（禁 edit）；其自定义 subagent（`.claude/agents/*.md`）由 Task 工具调。两者是不同的东西——**一个管"当前会话是什么人格/模式"，一个管"派一个隔离脑去干一次活"**。opencode 的"plan(primary) + explore/general(subagent)" 把这两个概念分得很干净。

---

## 3. 对 talemate 的落地设计（三样东西各落哪档）

### 3.1 内容（docs/ 本身）→ 类比 plan.md / 项目文件，不是任何知识档

- docs/ 是"作品文件"，在盘上：要用时 read-doc 切片，绝不缓存旧设定。
- **但它确实是我们最高频的背景** → 加一段**每轮常驻的「框架锚点」**（`<nvl-state>`），由 harness 组装（写文档后刷新 / compaction 时生成），存 `.talemate/`：
  ```
  <nvl-state>
    一句话简介 / 题材·频道    ← core.md 派生
    当前写到哪 / 当前卷主线     ← outline.md 派生
    已确认核心设定（core 精简） ← 落盘时顺手刷新
    未回收伏笔 / 待定清单       ← 防模型忘了坑
  </nvl-state>
  ```
- 这不等于全文常驻：世界/角色/大纲全文仍按需读；"精髓常驻、细节按需"——与 compaction 把历史压成一条常驻摘要同理。

### 3.2 方法（怎么把框架聊出来 + 每层文档该有哪几格）→ ①/③ 档，不是 skill、不是 subagent

- 框架建立是 **editor 的设计 phase**：用户全程拍板 → 只能在主对话（editor）里发生 → 不是 SubAgent。
- editor 需要"怎么做"的方法 → 对应 opencode plan-mode 的做法：**harness 检测到处于设计 phase（如 docs 未成熟）时，每轮把「框架协议」拼进上下文**（放代码/内置，用户删不掉；AGENTS.md 若想定制可覆盖）。
- **DocKind 骨架**：建项目时把每层文档的骨架（core 该有哪几格、characters 卡该有哪几格…）**播种进文档文件本身**——文档自带规范，read-doc 即加载，删骨架=删自己的企划。

### 3.3 附加题材知识 → ④ skill 档

- 男频爽点模板 / 悬疑该问哪些问题 / 文风卡这类**变量知识**才做 skill；用户能自加（加题材包是 feature）。内置保证存在的做成 `<built-in>` 代码注入。

### 3.4 SubAgent 只用于"一次性大综合"

- "把 core+world+characters 读全 → 综合成整本大纲" / "改一个前提 → 级联重整多份文档"这类**隔离大活**才 `task(planner)`。
- 判断尺子：**要不要跟用户来回对话 → 要的归 editor（配锚点+方法），不要的一次隔离大活 → subagent**。

---

## 4. 尚未拍板的开放点

1. **设计 phase 的判定**：按"docs 未成熟"（如 outline 空）自动注入，还是显式进入"设计 mode"？
2. **锚点由谁维护**：write-doc 后 harness 自动刷新？谁生成摘要（editor 顺手写 vs 复用 compaction 的小模型）？
3. **方法放人格还是 phase 注入**：editor 的 system 常驻一段精简方法（大小可控） vs 处于设计 phase 才每轮注入完整协议（照 plan-mode reminders）？
4. 是否照 opencode 把"设计 phase"做成一种**会话可切换的 mode/agent**（比 editor 更接近 plan 的对称形态），还是保持"单 editor + phase 自动判定"？
5. DocKind 骨架与题材模板的关系、以及是否给角色加一个"知识/knowledge"字段来挂方法。

## 5. 收敛后的回写目标

- `05-agent-spec.md`：把"框架内容/方法/题材知识"的落档补进归类规则与触发矩阵。
- `04-harness-design.md`：上下文组装 §5 补"框架锚点"；角色 §3 补"editor 设计 phase"。

---

## 6. 追加收敛决定（2026-09-05 续谈，覆盖/细化上文）

> 上文 §3/§4 仍是过程记录；本节是谈完后的当前定论，冲突时以本节为准。

### 6.1 不做"框架设计 persona"，单 editor + 阶段状态

- 不设"主编 mode / 框架设计 mode"两个可切换人格（推翻 §4-4 的疑问）。
- 理由：框架维护没有"贵且难回退的动作"需要门禁（它是对话 + confirm 把关的小写）；双 persona 只在有硬权限边界时才值得（见 6.2）。
- editor 保持唯一 primary；**设计段/写作段是两个阶段状态**（由项目状态判定），只影响"上下文注入什么"，不影响人格。

### 6.2 plan mode 的本质：给"贵的动作"上闸 → talemate 抄到写作流

- 为什么 opencode/Claude Code 有 plan mode：模型有行动偏差，靠 prompt 请它"先规划"不可靠；**plan mode 是结构上让它做不到先动手**（禁 edit 工具），保护"改代码"这个贵且难回退的动作。auto mode 只自动化"选不选这道闸"，替代不了"用户此刻的信住度"这个安全边界。
- **talemate 的对应闸在"写一章"上**：writer 对某章的执行，门禁于"这一章已有一份用户批准过的 plan_ch"——没有就先规划、给你看、拍板，才放 writer。**在写作流局部生效，不做全局 persona。**

### 6.3 框架增删改查 = 四样各归其位（修正版）

| 需要的东西 | 载体 | 谁所有 |
|---|---|---|
| 操作的手（读/写/列文档） | 工具（editor 已持有） | 产品（代码） |
| 每层结构规范 | **doc_spec 数据，按需取**（用户点名某层时 editor 调 doc-spec）；文件懒建 | 数据产品给；文件建立后内容是用户 |
| **维护纪律 + 设计方法** | **editor.system（代码）** | **产品（删不掉）** ← 关键修正 |
| 项目自己的规矩 | AGENTS.md | 用户 |
| 题材附加规范 | skill | 用户可加 |
| 级联大活/读全量再综合 | task(planner) | — |

**AGENTS.md 定位修正（本节最重要）**：AGENTS.md 语义等同 CLAUDE.md——项目级、用户管理、系统只提供"每轮注入该文件"的能力、默认可空。**产品核心行为不得依赖它。** 维护纪律（先读后写 / 覆盖与删除前 confirm / 删前查引用 / 改 core 扫 outline / 改完刷新锚点）属产品核心行为 → 放 editor.system（现状 `EDITOR_SYSTEM` 已有"落盘纪律"一小段，扩写即可），不进 AGENTS.md。AGENTS.md 只放用户想加的本项目规矩（如"本作禁超自然"）；产品可播种最小占位提示，但逻辑不依赖其内容。

### 6.4 待补的工具缺口

- `write-doc` 目前要求整份文档全文重写；docs 长大后就该支持**按区块编辑**（`edit-doc(name, section, patch)` / `append-doc(name, block)`），否则"改一格"变"整篇重抄"，烧 token 且易丢段落。
- 删/改走 confirm；删前查引用（grep docs）。
- 写/改/删后 **harness 自动刷新 `<nvl-state>` 锚点**。

### 6.5 对 §4 开放点的处置

- 4：不做可切换 mode/agent → 单 editor + phase 自动判定 ✅
- 1/3：方法注入按项目状态（docs 未成熟）自动拼，精简版也可常驻 editor.system；具体由 6.3 落位
- 2：锚点由 harness 在写文档后自动刷新（机制见 6.4）
- 5：DocKind 骨架先播种进文件，题材模板走 skill

> **落地状态（2026-09-05）**：§6.1–§6.6 已按计划实现——见 `07-editor-framework-design.md`（主编规范 + 框架设计流程 + 跑通示例）与 `05-agent-spec.md` §8。差异点：§6.3 表格里"维护纪律→editor.system"被 §6.6 推翻；§6.4 锚点改为"每轮派生"，无需写后刷新钩子。

### 6.6 对"放 editor.system"的再修正（推翻 §6.3 表中"维护纪律→editor.system"那行）

用户质疑：core/world/角色这类特化知识，真的该堆进 system prompt（persona）吗？——**不该。** 引出一条更根本的原则：

> **凡能靠"结构/工具"强制的事情，不写成 prompt 让模型"记得做"；prompt 只留给需要拿上下文判断的残差。**
> （同 opencode plan mode：用"禁 edit 工具"而非"请你先规划"。）

专门知识按"它是哪种东西"归位，而不是按"放哪个文件"归位：

| 它是… | 归位 | 为什么不是 persona |
|---|---|---|
| **文档结构（DocKind schema）** | **数据**：播种进文档文件（schema 长在文件里，read-doc 即得）；数据还可驱动校验/锚点 | 结构是"数据"，不是"editor 是谁" |
| **可强制的纪律**（覆盖/删除前 confirm、删前查引用、写后刷锚点） | **工具 + harness 钩子**：confirm 已有；删除/影响类工具自行 grep 引用；write 后 harness 自动刷锚点 | 工具强制"做不到跳过"，prompt 靠自觉 |
| **残差判断**（"这改动牵动其他层先告诉我影响面"） | persona（很短、很通用，属职责描述） | 这才是 persona 该有的 |

推论：schema 不常驻（在文件里，用时读）、纪律被工具兜住、锚点由 harness 刷——**专门化知识几乎不占任何 prompt**，persona 保持干净。


---

## 7. 2026-09-06 落地更新（取代上文"预种 + DESIGN_PROTOCOL 自动注入"）

用户拍板后实现（以代码为准）：

1. **懒建**：`createProject` 不再播种四层；docs 初始为空；`characters.md` 由 `add-character` 首次调用自建。进入空间只展示四层**现状卡片**（`src/framework/report.ts`）+ 一句提示，干什么由用户决定。
2. **结构规范 = 数据 + 按需工具**：`src/framework/doc_spec.ts` 定义每层该有哪些小节 + 成稿/补缺工作法；新增 `doc-spec` 读取工具（editor 持有）。用户点名要完善某层（说"完善核心设定"等）时，editor 靠 description 识别去调它。
3. **去自动注入**：删除 `prompts/design-protocol.txt` 与 `DESIGN_PROTOCOL` 常量；session 每轮只注入 `<nvl-state>` 锚点，不再按"outline 还是骨架"自动塞设计协议。
4. **成稿交互**（取代逐格盘问）：先让用户用自己的话讲 → editor 按该层 doc-spec 小节整理草稿（缺的写（待定））→ 用户确认 → `write-doc` 整层落盘 → 之后只 `edit-doc` 还待定/要改的那一小节，补细节给建议/选项、一次可答多个。
5. 工具命名：id 用 kebab（`doc-spec`/`add-character`…），TS 文件名用 snake（`doc_spec.ts`/`character_tools.ts`…）。

---

## 8. 2026-09-06 核心层 / 世界层收敛记录（与"小说介绍→doc_spec"同一轮）

同一轮分层收敛主线：**每一层只干一件干净的事；"会动 / 会演化的东西"不归静态层。**

### 核心层 core = 小说介绍（已落 `src/framework/doc_spec.ts`，结构见 07 §2.1）
- 四格：题材·频道 / 一句话简介 / 金手指·超常设定 / 基调·情绪。
- 一句话卖点并进一句话简介；主角只留身份在简介前提句，内核（想要/最怕/为什么是他）下放 characters 主角卡（add-character）；爽感承诺→基调·情绪；目标读者移出（"定位"未定）。

### 世界层 world = 空间与舞台 / 规则与秩序 / 术语表（已落 `src/framework/doc_spec.ts` + `buildResidentDocs` 常驻，结构见 07 §2.1）
- **追加拍板（用户）：世界观随 core 一起常驻加载**——`buildResidentDocs` 每轮现读 `core.md` + `world.md` 全文注入。覆盖了早前"世界/角色/大纲全文不常驻、会长大"的旧原则（§3.1 / §5）；world.md 若真涨到超预算，再议把细目拆出去，不预做。
- **`<nvl-state>` 块删除（2026-09-06，同一轮）**：它名义上是状态锚点、实际却搬运 core/world 整份 + 进度 + 索引（名实不符，且与 compaction 的 `<story-state>` 标签混淆）。拆法：core/world = 静态基线 → `buildResidentDocs` 不带包装每轮注入；写作进度/文档索引等**状态** → list-chapters / list-docs 工具；§3.1 曾设想的"当前写到哪/未回收伏笔/待定清单"若要做，是**独立状态块**的事，不复用此标签。§3.1–§5 的 `<nvl-state>` 论述为过程记录，以本节为准。
- **已拍板**：从六格收窄为三格——**空间与舞台**、**规则与秩序**、**术语表**。删「世界观一句话」（世界性质并进空间与舞台第一行）；删「历史痕迹与秘密」独立格（当前仍生效的过去作为"成因/遗迹"写进相关空间/规则描述，悬念/未解之谜归 outline「伏笔与回收登记」，outline 已有这格）。
- **术语表：暂留世界层**（用户拍板先放这，后续如需再议是否内联）。
- **势力/阵营：暂不并入 characters**，先在此占位——它是会"想要东西"的 actor，不该当舞台背景；最终归属（characters 组织卡 / 独立关系网文档）待后续再定。⚠️ 用户点名记下，别丢。
- 边界原则：core「金手指·超常」= 主角级本书设定；world「规则与秩序」= 世界级规则。分界样例：诡秘的力量引擎=世界规则（主角外挂很薄）；斗破境界体系=世界规则，药老/异火=主角级。
- 另注：「世界头顶的威胁」（诡秘旧日 / 末世倒计时）**不新增独立格**——作为当下硬事实/代价进「规则与秩序」，作为要引爆的东西进 outline 伏笔/结局；规则与秩序 hint 带一句"含世界当前总体状况"即可。
