# Harness 设计：talemate 项目空间 + 多角色创作 Agent

> 日期：2026-09-04
> 上游：`02-product-definition.md`（产品定义）+ `03-implementation-plan.md`（实现计划）+ 2026-09-04 对 opencode v1.18.16 的四份实测研究
> 本文件回答"**talemate 自己的 agent harness 长什么样、怎么搭**"，是自建基础设施（`src/` 下 `core/storage/llm/agent/session/tool/skill/context` 各模块）的基准。写作领域能力（prompt/企划分层/章节生产）在其上后接。
> ⚠️ 本文档**取代** 01/02/03 里以"评判系统/标准工程/编辑循环收敛"为护城河的那部分论点（详见 §0）。

---

## 0. 定位转向（vs 01/02/03）

| 旧论点（作废） | 新方向（本文件） |
|---|---|
| 护城河 = "把质量变成可检查的标准"（双档判据 + 批评者 + 编辑循环收敛） | 护城河 = **创作过程系统化**：设计段把企划做厚、写作段结构先行（规划→节拍）+ 用户当主编拍板 |
| 质量靠"事后打分循环"收敛 | 质量靠"**写前把结构和设定做对**" + 独立上下文分工 + 人拍板 |
| 批评者兼任点子捕捉器、自动回写企划书 | 回写通道暂不做（2026-09-04 决策）：企划改动由主编对话 + 用户拍板落盘 |
| 一批实验脚本验证（gen-one / gen-style-demo / run） | **自建 harness 基础设施**（借 opencode 边界），写作领域作为 agent 接入 |

一句话：**talemate = 一个"项目空间"承载的、由多角色创作 Agent 围绕"活的企划书"工作的系统；用户是主编，Agent 是参谋与执行者。评判系统整体移除。**

---

## 1. 顶层模型：项目空间 + 会话

### 1.1 与 Claude Code 的类比与差异

- Claude Code：`cd 某目录 → 进入 → 该目录下有多个 Session`（目录 = 用户自己选的工作区）。
- talemate：用户**不指定目录**，而是**"创建一部小说项目"**。harness 在**自己受管目录**下自动建一个项目目录，此后所有活动都发生在该目录（= 这部小说的"空间"）。

```
受管根目录（env TALEMATE_HOME，默认 ~/.talemate/）
└── novels/<project-id>/          ← 一小说一目录（用户不碰路径，只认小说名）
```

### 1.2 一个项目 = 设计 + 写作 两段，同一空间

项目空间内同时承载**设计段产物**与**写作段产物**，两段是先后关系、共用同一份"活企划"：

```
novels/<project-id>/
├── talemate.json           # 项目元信息：id/书名/题材/创建时间/各角色用模型…
├── AGENTS.md               # 项目规则（常驻注入）：路径约定/企划分层规则/写作纪律总则
├── docs/                   # ◀ 设计段：企划活文档（用户+主编持续迭代）
│   ├── core.md             #   核心层：一句话卖点/题材/主角内核/金手指边界/爽感承诺
│   ├── world.md            #   世界层：世界观/体系/势力/地点/术语
│   ├── characters.md       #   人物层：角色总表 + 每角色卡片
│   └── outline.md          #   情节层：整本主线/分卷纲/章节细纲
├── skills/                 # 项目级 skill（本小说专属模板/设定规则，可选）
├── chapters/               # ◀ 写作段产物
│   ├── plan_ch001.md       #   第 1 章 体验工程图（规划产物）
│   ├── chapter_ch001_v1.md #   第 1 章 正文 v1
│   └── …
└── .talemate/              # harness 私有（不视为作品内容）
    └── sessions/<session-id>/
        ├── session.json    #   会话元信息（绑定哪个项目/标题/当前角色…）
        └── messages.jsonl  #   消息流（seq + type + data，见 §10）
```

**为什么会话也放项目目录里**：会话是"围绕这部小说的讨论记录"，跟作品同目录便于整体备份/迁移/进 git；`/sessions` 目录结构是讨论层的存储，不属于"作品内容"（docs/chapters 才算）。

### 1.3 会话 = 一个项目上下文

- 会话绑定**一个项目**（类比：Session 绑定一个 worktree/location）。
- 一个项目可以有**多个会话**（不同话题/不同天），靠 `session.json` + 标题恢复。
- 默认进入一个**主编会话**（§4），写作段由主编按需 task 委派子角色（§4.3）。

---

## 2. 领域模型（承接"企划活文档"讨论）

设计段的产物 = **一组分层、持续迭代、随时可改的活文档**。分层的意义：层间**变化频率、影响范围、再生成范围**不同，维护与注入都按层处理。

| 层 | 文档 | 变化特征 | 注入方式 |
|---|---|---|---|
| 核心层 | `docs/core.md` | 极少变、一改牵全身、用户必须拍板 | 写作/规划时**常驻精简带**（小） |
| 世界层 | `docs/world.md` | 慢变、追加为主 | 按需读（read_doc / task prompt 切片） |
| 人物层 | `docs/characters.md` | 慢变、追加为主 | 按需读（本章相关角色切片） |
| 情节层 | `docs/outline.md` | 快变、最局部 | 按需读（当前章/卷切片） |

- **文档格式**：Markdown。核心层尽量结构化条目；细节层保留散文空间（不杀死创作）。可寻址 = "文件名 + 章节小标题"粒度即可，先不做条目级 ID/引用（二期视需要加）。
- **版本感**：设计段落盘前用 `confirm` 给用户看 diff/影响面；改动记录可先靠 git（项目目录进 git），不做应用层版本历史（Q16 的"版本感"由此满足）。
- **写作依赖当前版本**：每次 task 委派写手，prompt 里带"当前 core 切片 + 相关 world/characters 切片 + 细纲切片"——**绝不缓存旧设定**。

---

## 3. Agent 架构：声明式角色 + 单主会话 + task

### 3.1 Agent 定义（纯声明）

```
interface Agent {
  id: string            // "editor" | "planner" | "writer" | …
  name: string          // 显示名（主编/规划/写手）
  description: string   // 何时选它（task 委派时路由用）
  mode: "primary" | "subagent"
  model?: ModelRef      // 缺省继承父会话模型（按角色可配不同模型/推理强度）
  system: string        // 角色 system prompt（editor：设计对话主持；writer：写手规范…）
  tools: string[]       // 该角色可见工具 id 列表
  steps?: number        // 上限轮次（防跑飞）
  permission?: Ruleset  // 预留：该角色在哪些动作上须经 confirm（见 §7.4）
}
```

- **注册表**：代码内置默认（editor primary；planner/writer subagent）+ `talemate.json` 可按角色覆盖 model/system。
- **无导演 agent**：opencode 里也没有导演——多角色的唯一机制是 `task` 工具委派 + 每条消息可换 agent。talemate 采用**主编单会话 + task 委派**（§4）。

### 3.2 主编（editor，primary）—— 唯一的"日常对话面"

- 用户建项目后进入的就是主编会话。**设计段**：主编引导/陪用户把企划从"一个想法"长成四层活文档；每次落盘用 `confirm`。
- 主编手里有：`read_doc / write_doc / list_docs`（活文档）+ `task`（委派规划/写手）+ `skill` + `ask_user`。
- 主编**不亲自写正文**（正文是写手子会话的活），避免"设计对话上下文污染正文腔调、正文污染设计讨论"。

### 3.3 task 委派 = 子会话隔离（opencode 照搬）

- 委派时：**新建子会话** `Session{ parentID, agent, title }`，**只传一份 prompt 文本**（设计好的任务 + 当前设定切片），子会话独立上下文、不污染父会话。
- 子会话跑完自己的循环 → 把**最后文本**以 `<task_result>` 包装回传父会话（作为 task 工具的 output）。父模型只见结果摘要/成品，不见子会话草稿堆。
- 深度限制：沿 parentID 上溯，默认允许 1 层嵌套（editor → writer 足够）。
- 前台为主（await 子会话返回）；后台模式（返回 running，完成注入 synthetic 消息）二期再做。
- **何时用 task**：只在复杂处。日常设定问答主编直接答；"写第 N 章"→ task writer；"给第 N 章做节拍规划"→ task planner。不需要一次写很多章，不设批量流水线。

---

## 4. 会话循环（自研，无 Effect）

核心形态直接取 opencode **V2 干净循环**的形状，去掉 Effect/Fiber/协调器，用 async/await + 每会话单队列：

```
// 每会话一个异步任务队列（本质 = 一把锁 + 单写者）：busy 时新消息排队或阻塞等待。
post(userInput):
  append user 消息（落盘）
  if 空闲: runLoop()

runLoop():
  while true:
    // 读当前上下文（按 compaction 截断：latest compaction 之后的 seq）
    history = loadAfterLastCompaction(session)
    agent   = 当前角色（本条 user 消息绑定的 agent，缺省 editor）
    // 组装一次请求（§5）
    { system, messages } = buildRequest(agent, history)
    result = streamOneTurn({ agent, system, messages, tools: registry.tools(agent) })
    // streamOneTurn 内部：流式 → 逐事件广播 → 遇 tool-call 则 settle 本地执行 → 结果回填
    if 有未 settle 的 tool-call: continue    // 工具结果喂下一轮
    else: break                               // 无工具调用 = 本轮结束
```

- **停止条件**：本轮 assistant 消息不含"需执行的 tool-call"即停。
- **每轮落盘**：user 消息先落；assistant 消息**流完整体落一条**（含 text/reasoning/tool 各 part），工具调用在 part 内走 `pending→running→completed/error` 状态机；中断残留的 running/pending 在恢复时视为 interrupted。
- **每会话单队列**：busy 时新 user 输入排队（或主编场景直接等），不做 steer/queue 多级语义。
- **结论**：循环里**只有 tool-call → settle → continue**，没有 judge/critic 步骤——与"去评判"一致。

---

## 5. 上下文组装（三类注入，借鉴 skill 研究）

对每个 agent 的每次请求，system prompt 由四块拼成：

```
system = [
  env/date 块（今天日期/项目名/角色）…用轻量占位
  角色 system（agent.system，§3.1）…若 agent 是写手，这里含写作规范
  项目规则（AGENTS.md 全文注入，来源标注 "Instructions from: …"）
  skills 目录清单（<available_skills>: name+description，无正文）…§6
]
messages = 按 compaction 截断后的历史（§8）+ 可选刚读的设定切片（拼进本条 user/task prompt，不塞 system）
```

关键规则（沿用 opencode + Claude Code 语义）：
1. **规则文件（AGENTS.md）= 常驻、每步全量注入** —— 放"操作规范/项目约定/企划分层总则"。写进每部小说根的 `AGENTS.md`，跨会话恒定，是给 agent 的"怎么在这部小说里干活"的说明。
2. **Skill = 目录化、按需注入** —— 正文不常驻；system 只给清单，命中后用 `skill` 工具把正文作为一条 tool-result 带进来（§6）。
3. **活文档（docs/*）= 工具读取，按需切片** —— 不是每次全量塞；要什么用什么工具读什么，读到的内容作为 user 侧材料（而非 system）。
4. **取当前版本**：写作/task 委派时从 `docs/` 现读，绝不引用缓存的旧设定。

---

## 6. Skill 系统（知识包：文风卡 / 技法 / 模板）

一个 skill = 一个目录 + `SKILL.md`（frontmatter 只强校验 `name` + `description`，其余字段容忍并忽略）。

```
SKILL.md
---
name: style-01-wangwen
description: 网文白话爽感文风（第三人称）。用户指定该文风/想写得"顺、快、爽"时加载。
---
（正文 = 完整文风卡：约束层 + 六维声音层 + 反例 + 声音范例）
```

- **发现**：全局库 `~/.talemate/skills/<name>/SKILL.md`（文风库/技法库/题材库，作者级、跨作品）+ 项目库 `novels/<id>/skills/<name>/SKILL.md`（本小说专属）。后者覆盖前者同名项。
- **注入**：system 只放 `<available_skills>`（name+description，location）；`skill` 工具按名把正文 `<skill_content>` 载入（tool-result，一条对话消息）。
- **触发**：模型按 description 自主调用为主；每条 skill 同时注册成一条斜杠命令（如 `/style-wangwen`）供用户手动召唤。
- **二期**：文风提取（上传样本 → 生成 skill）；远端 skill 分发（本期不做，只要本地目录）。

---

## 7. 工具框架

### 7.1 defineTool（最小，无 Effect）

```
defineTool({
  id: string,                        // 工具唯一名
  description: string,               // 给模型的长说明（写清何时用/边界/用法）
  input: Schema,                     // 字段级 description → 自动 JSON Schema
  execute: (args, ctx) => Promise<{
    output: string;                  // 回灌模型的文本
    title?: string;                  // UI 即时标题（流式更新）
    metadata?: Record<string, unknown> // 结构化信息（给 confirm UI/展示）
  }>
})
```

- 执行前校验入参；**校验失败/工具不存在 → 返回面向模型的重写指令**（不抛裸异常），让模型自纠。
- 长输出：超预算写临时文件 + 返回预览 + 提示用 read 工具分段取（正文章节场景重要）。

### 7.2 内置工具清单（阶段一）

| id | 用途 | 可见角色 |
|---|---|---|
| `task` | 委派子会话（§3.3）：`{agent, prompt}` → `<task_result>` | editor |
| `read_doc` | 读项目活文档（按文件名/可选小标题切） | editor, planner, writer |
| `write_doc` | 写/改活文档（落盘前过 `confirm`，metadata 带改动摘要） | editor |
| `list_docs` | 列项目 docs/ 与 skills/ | editor, planner, writer |
| `skill` | 按名注入知识包正文 | editor, planner, writer |
| `ask_user` | 向主编提问要创作决策（返回答案文本给模型继续） | editor（planner/writer 默认禁用） |
| `save_chapter` | 写手把成品正文落 `chapters/`（含命名规约） | writer |

> 规划/写手是否直接落盘 vs 只回传文本由主编落盘——**阶段一先定为"回传文本为主、save 为辅"**，避免子会话乱写文件；写入一律走 editor 的 confirm。可后续按角色放宽。

### 7.3 人工点：confirm / ask_user（对应"用户当主编"）

- **confirm(action, summary, diff?)**：写/覆盖活文档、落盘正文等**不可轻易反悔动作**前，向用户展示"要做什么 + 影响面 + diff"，用户 3 秒拍板。对应 opencode edit 的 `ctx.ask(metadata: diff)`。
- **ask_user(question, options?)**：设计对话中 agent 需要用户出想法/裁决时用（"主角的金手指是什么？""这段要不要写得残酷点？"）。**不是权限审批**，是参谋要决策。
- 阶段一：两者都是进程内 await 用户输入；TUI/UI 阶段再做成事件化审批流。

### 7.4 权限模型（极简）

- 不搬 opencode 的 allow/ask/deny + 级联队列。只需：**默认全放行 + 每个工具自声明"是否需 confirm"**（工具定义里 `confirm?: (args) => summary`）。角色 `permission` 字段可整体关掉某工具（如 planner 禁 ask_user）。够用即可。

---

## 8. 上下文管理（长篇唯一硬约束，借鉴 compaction 研究）

- **触发**：估算 token（简单近似：字符数/系数或逐消息 usage）超阈值（如累计 > 窗口大半）。
- **产物 = 一条 compaction 消息**（`type:"compaction"`，含 `summary` + `recent`）：
  - `summary`：LLM 按**小说向模板**生成的摘要（当前写到哪/已定设定/未回收伏笔/下一步）——替代 opencode 的 Objective/Work State 模板，换成 `<story-state>` 语义。
  - `recent`：最近保留的原始消息片段。
- **上下文边界**：`loadAfterLastCompaction` = 只取最新 compaction 之后的 seq；老消息留文件不喂模型。恢复时找到那条 compaction 消息即得"前情摘要 + 最近原文"，不必重放旧事件。
- 生成摘要用独立的 compaction agent（低推理成本即可；阶段一起码用同模型但独立 system）。

---

## 9. LLM 层（升级现有 llm.ts）

- 现状：`chat(system, user)` 单轮；无流式事件、无多轮。
- 目标接口：
  ```
  stream(request): AsyncIterable<LLMEvent>
  // LLMEvent = text.delta | text.ended | reasoning.delta | tool-call | tool-result | error | step…
  ```
- 保留：provider 抽象（anthropic / openai 兼容 / DeepSeek V4）、按角色推理强度（editor=对话可用 low/off、writer=low、plan/摘要=按需）、max_tokens 截断检测、temperature。
- 会话循环持有"未完成 assistant 消息"，把 text.delta / reasoning / tool 状态实时写入，流完整体落盘一条（§4）。

---

## 10. 存储（文件系统，轻栈）

借鉴 opencode **V2 durable 事件 + 投影**的"该落哪些值"规则，但落到文件：

- **`session.json`**：会话元（id / projectID / title / agent / model / cost / tokens / time.created…）。
- **`messages.jsonl`**：每行一条消息，**必须含 `seq`**；消息类型：`user / assistant / system / synthetic / compaction`。
  - assistant 的 content = `{ text:…, reasoning:…, tool:[{id,name,state: pending|running|completed|error, input, output, time}] }[]`。
- **规则：delta 仅 live 不落盘，ended/complete 才是落盘的全值**（借鉴 opencode：text delta / tool input delta 不持久化，只落结束值）。这样文件里只有稳定态。
- **compaction 消息必落**（§8），它是恢复上下文的关键。
- `seq` 单调递增；消息顺序 = 文件顺序 = seq 顺序。可选再存 `events.jsonl`（durable 事件流，供未来 replay / 分页 history；阶段一可先不落）。
- 全部用 `fs/promises`，无数据库。未来多用户/并发再评估 SQLite。

---

## 11. 边界与演进（Server 后置，接口先留）

- **阶段一形态 = 库 + CLI**：`talemate novel create <书名>`、`talemate <project-id>` 进主编会话（REPL）。无 HTTP。
- **未来稳定契约**（借鉴 opencode V2 最小子集，暂不实现）：
  - `POST /api/session`（建）、`POST /api/session/:id/prompt`（durable admit，不阻塞）、`GET /api/session/:id/message`（投影）、`GET /api/session/:id/event?after=seq`（SSE replay-then-live）、`POST /interrupt`。
  - 事件分类学 `session.next.*` 子集：text/reasoning/tool 的 started→delta(live)→ended、step.started/ended。
  - 届时薄 TUI = "先拉投影 + 事件增量更新本地读模型"。
- 模块边界（`src/`：`core/` 类型 · `storage/` · `llm/` · `agent/` · `session/` · `tool/` · `skill/` · `context/`）必须让 server 能成为另一个薄外壳，核心不感知 UI。为此现在就把"事件广播"做成核心内部接口（`onEvent(evt)`），CLI 先打印，未来接 SSE。

---

## 12. 里程碑（基础设施铺全 → 领域接入）

### P0 · Harness 基础设施铺全（本期目标）
1. `core/` 类型：Agent / Message / Part / LLMEvent / Tool def / Project meta
2. `storage/`：建项目、项目元读写、session.json、messages.jsonl（seq 追加）
3. `llm/`：流式多轮（anthropic + openai 兼容），截断检测保留
4. `agent/`：注册表 + editor/planner/writer 默认声明
5. `session/`：runLoop + 单队列 + compaction（估算+摘要+消息落盘）
6. `tool/`：defineTool + registry + task / read_doc / write_doc / list_docs / skill / ask_user / confirm / save_chapter
7. `skill/`：发现（全局+项目）、SKILL.md 解析、目录注入、skill 工具
8. `context/`：env+AGENTS.md+skill 目录组装、compaction 截断取历史
9. CLI 冒烟：`novel create` → 进会话 → 让 editor 读/写一个 doc、ask_user 一次、委派一个 writer 子会话（返回文本），验证全链路通

### P1 · 写作领域接入
- editor 设计对话（把 企划 长成 docs/ 四层）
- 手动触发"写第 N 章"：editor read_doc 取当前切片 → task writer（prompt 带 writer 规范 + 细纲 + 当前 core）→ save_chapter
- planner（节拍规划/体验工程图）作为独立 subagent 角色接 gen-plan 的 prompt

### P2 · 产品化
- CLI/TUI 交互面、斜杠命令、confirm/ask_user 事件化
- 文风卡迁移成 skill 库（style-01-wangwen → SKILL.md），扩充技法/题材库

---

## 附：与 opencode 对照（借 / 简化 / 剥）

| opencode 边界 | talemate 处理 | 出处 |
|---|---|---|
| V2 干净循环 `while(needsContinuation) runTurn()`，工具结果先落再喂下一轮 | 照搬形状；去 Effect/Fiber/协调器，async 队列 | 研究 A（session/runner/llm.ts） |
| task 子会话 = 独立 Session(parentID) 只传 prompt、结果 `<task_result>` 文本回传、限深 | 照搬 | 研究 A（tool/task.ts） |
| Agent 纯声明 + 无导演 + 消息绑角色 | 采用 editor 单主会话 + task 委派 | 研究 A |
| Skill 目录注入（system 只放 name+description，正文按需 skill 工具） | 照搬（全局+项目两级库） | 研究 B（skill/index.ts, tool/skill.ts） |
| 规则文件常驻全量注入（AGENTS.md "Instructions from:" 就近注入） | 照搬：一项目一 AGENTS.md | 研究 B（session/instruction.ts） |
| 事件分类：delta live-only、ended durable；compaction 即一条消息 | 照搬落盘规则 + 小说向摘要模板 | 研究 D（schema/session-event.ts, core/compaction.ts） |
| defineTool + registry（按 agent/permission 过滤） | 照搬最小版；无 output schema | 研究 C（tool/tool.ts, registry.ts） |
| permission allow/ask/deny + question 工具 | **简化**：默认放行 + 工具自声明 confirm + ask_user | 研究 C |
| SQLite + drizzle + 事件溯源 + projector | **简化/替换**：文件系统 + jsonl（seq 单调），事件溯源不落 | 研究 D |
| provider/推理/温度/截断 | 保留现有 llm.ts 能力，升流式 | 现有代码 |
| bash/fs-edit/pty/grep/glob/todo/MCP/LSP/权限队列/OTel/云同步 | **剥离** | — |
| V1/V2 双栈、双协议、迁移债 | **不引入**（自研只有一份实现） | — |
