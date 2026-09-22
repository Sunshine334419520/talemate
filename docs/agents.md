# Agent 与工具：谁、什么时候、用什么机制

> **职责**：回答"有哪些 Agent / 工具 / Skill，它们怎么归类、怎么触发、怎么加新的"。
> **读者**：要加或改 Agent、工具、prompt、skill 的人。
> **对齐代码**：2026-09-22 · Agent 名册在 `src/agent/registry.ts`，权限在 `src/permission.ts`
> 相邻：`permissions.md`（谁能做什么、什么要问）· `architecture.md`（循环与上下文）· `prompts/README.md`（prompt 怎么写）· `design-docs.md`（设计工具背后的领域）

## 归类判定规则

新增任何东西先过这张表：

| 你在纠结的东西是… | 做成 | 判据 |
|---|---|---|
| 用户直接长期对话的"人" | **Agent (primary)** | 它是某个对话面的常驻人格吗？ |
| 需要独立上下文专注干完、产出要隔离、或想单配模型 | **SubAgent** | 它要"为一个完整思考任务开一段新对话"吗？ |
| 确定性、单次、schema 化的动作 | **Tool** | 不需要它"自己想怎么做"，给参数就给结果？ |
| 按需注入的知识正文（文风卡 / 技法包 / 模板） | **Skill** | 是"知识/说明书"而不是"动作/脑"吗？ |
| 用户自己想给这部小说加的项目规矩 | **AGENTS.md** | 这是用户的东西还是产品的行为？产品行为不得写这 |

**Tool 与 SubAgent 的边界一句话**：

> **Tool 没有自己的上下文、人格和循环**——一次调用、结果回灌；**SubAgent 是完整跑一个带独立上下文的循环**。

### 三条附则（挡常见误判）

1. **不设导演 Agent，也不设"评审/拍板" Agent。** 多脑协作的唯一机制是父 Agent 用 `task` 委派。拍板永远是人。**凡是"让另一个 agent 去审查 agent 产出"的提议，都在重犯已被否决的评判系统。**
2. **能靠 Tool 完成的，不升级成 SubAgent；能靠 Skill 注入的，不重写成 SubAgent。** SubAgent 是稀缺资源（每次 = 一整段独立上下文 + 一次往返），只在"隔离上下文"或"独立人格/模型"真的买到东西时才用。
3. **一个任务的"流程"不单独成角色。** "规划→写正文→拍板"是 mate 的工作协议，不是新 Agent。

## 角色名册

| 角色 | mode | 职责 | 谁能触发它 | 工具 |
|---|---|---|---|---|
| **mate 搭档** | primary | 用户的创作参谋与项目执掌者：把"想法"长成四层活文档并维护；当编排者，委派并拍板 | 用户每次输入 | 见下 |
| **writer 写手** | subagent | 按"当前设定切片 + 节拍"写一章正文；**不自创设定、只输出正文** | mate 经 `task` | `read-design` `list-designs` `skill` `save-chapter` |
| **summarizer** | primary + **hidden** | 上下文压缩时生成前情摘要；不进角色表、不进 task 可派列表、不当默认 primary | harness 内部自动 | 无 |

- mate **不亲自写正文**（节拍不是正文——它自己出，见下）；writer **不能直接对话**，只被 `task` 派生。
- persona 在 `prompts/*.txt`（英文，`readPrompt()` 载入）；agent 的 `description`（路由契约）内联在 `registry.ts`，写法见 `prompts/README.md`。

### 显式不做的角色（防回归）

**批评者 / 评审 agent** · **导演 / orchestrator agent** · **自动点子捕捉 / 一致性核查 agent** —— 分别是已删除的评判系统、多余的编排层、和"后台自动改企划"的残留冲动。

### 加角色的固定动作

① 写一个 `AgentDef`（含 system）→ ② 决定 tools 白名单 → ③ 决定触发：被 mate 委派就 `mode:"subagent"`（task 的可见列表由运行时自动带出），是新对话面才考虑 `mode:"primary"`。

**不改任何 loop/registry 代码**——这正是"Agent 是数据"的回报。

## 工具

按领域分五个模块（TS 文件名 snake_case，工具 id kebab-case）。**下面这张表由 `tests/docs.test.ts` 守着**——`BUILTIN_TOOLS` 里每个工具都必须出现在这里，删了工具没删文档、或加了工具忘了文档，测试都会红。所以这里不写数量。

**`design_tools`** — design/ 通用文档操作

| id | 用途 |
|---|---|
| `read-design` | 读整篇或按小节读 |
| `list-designs` | 列 design/ 各文档 + 小节索引（角色卡一人一行；**不分格的文档也只给一行 + 首句**，如序列纲） |
| `search-designs` | 跨 design/ 扫词，返回"文件 → 小节 + 行"（改/删前查影响面） |
| `propose-design` | 摆提案给用户看，**不写盘**，并结束本回合 |
| `apply-design` | 落盘**提案那一份**（不收正文） |
| `append-design` | 末尾追加一块 |
| `remove-design-section` | 删一个小节（删除前内置引用检查） |

**`character_tools`** — 人物层

| id | 用途 |
|---|---|
| `remove-character` | 删角色卡（删除前引用检查进 confirm） |

**`framework_tools`** — 框架层

| id | 用途 |
|---|---|
| `design-spec` | 按需返回"结构规范 + 成稿做法"：`layer` 取整层（情节层返回它的卷纲 + 序列纲两份），`name` 取某一份文档 |

**`core_tools`** — 委派 / 知识 / 人机交互

| id | 用途 |
|---|---|
| `task` | 委派 subagent（可派列表由运行时拼进 description）；**派 writer 时有硬门**——没有用户拍板过的节拍就拒 |
| `skill` | 按名注入 SKILL.md 正文 |
| `ask-user` | 向用户提问要**创作裁决**（不是权限审批） |
| `propose-plan` | 把**一章**的节拍摆给用户拍板并结束本回合；**不落盘**（批准的是"去写正文"这个动作）。它登记的那份 `approved` 就是 `task(writer)` 的门，成功后自动退出计划模式 |
| `enter-plan` | 进入**计划模式**（`edit`/`delegate` 一律 deny，那些工具从 schema 里消失） |
| `exit-plan` | 用户改主意不做了 → 离开计划模式 |
| `confirm` | 模型主动要用户点头（受 `question` 权限管） |
| `save-chapter` | 把成品正文落 `chapters/` |

**`web_tools`** — 联网

| id | 用途 |
|---|---|
| `webfetch` | 抓一个 URL → text/markdown/html |
| `websearch` | 搜索（默认 tavily；无 key 回退 bocha/exa/duckduckgo） |

### 会话模式（`agent/modes.ts`）

**模式 = 临时叠在 primary agent 上的一层权限档**，外加一句"这个模式是什么"。它**不装工作流**——"进了 plan 模式之后该怎么设计"不归它管，那归工具自己的输入契约。

与 agent 的分工：agent 回答"你是谁"（长期），模式回答"眼下在干什么"（一次一仗）。所以模式**必须有界**——进去、做完、出来。开放式的谈话（和用户聊设计）**不套模式**，那会把人关在里面出不来——`design-docs.md` 的「mate 没有阶段状态机」讲的正是这件事。

现在两种，都只是一张规则表：

| 模式 | 规则 | 效果 |
|---|---|---|
| **`accept-edits`** | `edit: allow` | 落盘不问；委派与联网照问 |
| **`plan`** | `edit: deny` · `delegate: deny` | 只读——那些工具**从 schema 里消失** |

**按类别挡，不是按名单。** 将来加了新的写作工具、只要它声明了 `permission: "edit"`，就自动被 `plan` 挡住——不需要谁记得去改一份名单。这是旧写法（模式里硬编码一串工具名、加工具时靠一条测试兜底）修掉的病。

模式的纪律正文刻意**不讲节拍**——那归 `propose-plan` 的 description。绑死成"章节计划模式"会让它换个场景就用不了，有一条用例钉着。

**模式只在会话内存里**，和待执行提案同生命周期：进程重启即回到默认。**硬保证不靠它**——写正文那道门挂在 `task(writer)` 上（查一份 approved 的节拍）。

### 权限：谁能做什么、什么要问

完整设计见 **`docs/permissions.md`**。这里只说它和本文件的关系：

- **`AgentDef.tools` 是广告**（模型看得到哪些 schema），**`AgentDef.permission` 才是边界**。撤下一个工具仍要真删定义——但"禁一类动作"从此不需要删工具，写 `{ edit: "deny" }` 就行。
- `runner.ts` 有一道**粗粒度兜底**：`deny *` 盖住的类别一律拒，哪怕工具是被幻觉调出来的（执行查的是**全局** registry，所以白名单挡住它看不见，兜底才挡得住它调得动）。细粒度（具体 pattern 的 allow/ask）由工具自己走 `ctx.ask`。

### 工具框架

`defineTool({ id, description, input, execute })` → `{ output, title?, metadata? }`。

- 入参带字段级 description，自动生成 JSON Schema。
- **校验失败 / 工具不存在 → 返回面向模型的重写指令**（不抛裸异常），让模型自纠。
- 长输出超预算写临时文件 + 返回预览 + 提示分段取。
- `halt`：工具在**成功**时可要求结束本回合（`propose-design` 与 `propose-plan`）。**校验失败必须 `throw`，不能 `return`**——runner 对任何 return 都置 `halt`，返回一个校验错误等于把回合停在一个本可自愈的错误上。

## 触发矩阵

| 触发源 | 例子 | 机制 |
|---|---|---|
| **用户** | 进项目、"写第 N 章" | 用户输入绑定当前 primary；"要触发子代理"的话术由 mate 识别后转成工具调用 |
| **Agent（模型自决）** | mate 判断"这一章够了" → `task(writer)` | 模型调 `task`；可派清单由 `subagentCatalog()` 动态拼进描述 |
| **harness** | 上下文超预算 | 内部自动跑 hidden agent |

> **关键认知**：在 agentic 世界里，"用户要写一章"**不会直接启动 writer**。输入进 mate 的会话，mate 按它的工作协议 + 手上的材料**决定**要不要、先调谁。所以触发时机由两件事决定：**mate system prompt 里的工作协议** + **task 工具的动态描述**。我们没有也不应该有一张"关键词 → 直接 spawn"的硬表。

### mate 的工作协议

1. **企划对话（含大纲）**：mate 直接答；查 = `list-designs`/`read-design`/`search-designs`，增 = `append-design`，改/成稿 = **`propose-design` → 用户回话 → `apply-design`**，删 = `remove-design-section`。**落盘必须走这两段，不派子代理。**
   **卷纲与序列纲就在这一条里**——它们是设计文档，走同一套两段式。
2. **要写某章正文**（一条链，四步）：
   ① `read-design` 取切片（core 常驻 + 当前**序列纲** + 相关人物/世界）→ ② **mate 自己写这一章的节拍** → ③ **`propose-plan` 摆给用户拍板**（它带 `halt`，回合到此为止）→ ④ 用户认可后 `task(writer, { prompt: 切片 + 节拍 })`，writer 产出回到 mate 面向用户确认、落 `chapters/`。
   - **节拍是 mate 自己的工作，不派子代理**：材料本来就在它手里（core 常驻、序列纲刚读过），派出去等于把已有的东西抄一遍；而用户改节拍是常态，留在自己的上下文里改是免费的，派出去则每次都要重发切片、还可能整份漂移。
   - ③ **有两道门**：摆出来就停（`halt`）；以及**没拍板就不许写**——`task(writer)` 查那份登记的 `approved`，没有就拒。用户要改 → 改完再摆一次（循环，不是一次性提案）。
   - **节拍不落盘**（登记只在会话内存里），**一次批准只换一次写作**。所以 ③ 与 ④ **不能合并成一个回合**：③ 之后必须结束，等用户说话。
3. **作品级取舍**（"要不要写残酷点"）→ `ask-user`。
4. **什么时候必须派**：需要隔离上下文或独立专注才 `task`；mate 自己能一两步查完的绝不派。

### task 契约

```
task { agent: "writer", prompt: string }
  → 校验 agent 存在且 mode=subagent；depth 检查（≤1 层）
  → 新建 child Session（model = sub.model ?? 父 model，同项目）
  → child.post(prompt) 跑完整子循环
  → 父模型收到 <task agent="…" state="completed"><task_result>…</task_result></task>
```

- **prompt 必须自包含**：子代理上下文全新，你给的 prompt 就是它的全部指令——把材料/切片写全，别让它猜。
- **必须说清要它返回什么**（正文全文？节拍表？）。
- 子代理工具集由**它自己的** AgentDef 决定，不继承父全量；**默认不带给它 `task`**（防链式 spawn）。

## Skill 系统

一个 skill = 一个目录 + `SKILL.md`（frontmatter 只强校验 `name` + `description`，其余字段容忍并忽略）。

```
SKILL.md
---
name: style-01-wangwen
description: 网文白话爽感文风（第三人称）。用户指定该文风/想写得"顺、快、爽"时加载。
---
（正文 = 完整文风卡：约束层 + 六维声音层 + 反例 + 声音范例）
```

- **发现**：全局库 `~/.talemate/skills/<name>/`（作者级、跨作品）+ 项目库 `novels/<id>/skills/<name>/`（本小说专属）。项目库覆盖全局同名项。
- **注入**：system 只放 `<available_skills>`（name + description + location）；`skill` 工具按名把正文载入为一条 tool-result。
- **触发**：模型按 description 自主调用为主。

## 人机交互两个工具（对应"用户当主编"）

- **`ask-user`**：agent 需要用户出想法/裁决时用（"主角的金手指是什么？"）。**不是权限审批，是参谋要决策。**
- **`confirm`**：模型**主动**要用户点头时用。它正在变得边缘——落盘那一类确认现在由权限系统自动发起（`edit: ask`），不再靠模型记得调工具。**它和 `ask-user` 都受 `question` 权限管**：子代理默认 `deny`，因为子代理跑在隔离上下文里、用户不在场，它一开口就会把用户从自己的对话里硬拽出来。

**放行规则不在这里写**——见 `permissions.md`。
