# Agent 与工具：谁、什么时候、用什么机制

> **职责**：回答"有哪些 Agent / 工具 / Skill，它们怎么归类、怎么触发、怎么加新的"。
> **读者**：要加或改 Agent、工具、prompt、skill 的人。
> **对齐代码**：2026-11-25 · 工具面与不变量在 `src/tool/` 与 `src/framework/invariants.ts`；角色表与路由契约在 `agent/registry.ts`；正文写作窗口与文风目录（`styleCatalog`）在 `framework/prose.ts`（`tests/agents.test.ts` 守着 subagent 的路由契约）；内置文风卡在 `skills/`（`storytelling` 默认讲述体 / `style-01-wangwen` 快节奏爽感 / `style-02-guyan` 女频古言 / `style-03-xianyan` 现言快节奏）；考据本（researcher 的笔记本）在 `framework/research.ts`；提问的三态与界面在 `ask-user.md`；章节生产那条链见 `chapter-planning.md`
> 相邻：`permissions.md`（谁能做什么、什么要问）· `ask-user.md`（提问、跳过、pending）· `architecture.md`（循环与上下文）· `prompts/README.md`（prompt 怎么写）· `design-docs.md`（设计工具背后的领域）

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
2. **能靠 Tool 完成的，不升级成 SubAgent；能靠 Skill 注入的，不重写成 SubAgent。** SubAgent 是稀缺资源（每次 = 一整段独立上下文 + 一次往返 + **用户一次确认**），只在下列之一真的买到东西时才用：
   - **这活会淹掉主线上下文**——它产出的中间材料（读来读去、试错、死路）远多于你要的结论；
   - **要给这活套一套更窄的权限**——planner 与 researcher 都是类别拒的只读（`edit: deny`），
     **作品**一个字节都动不了（researcher 另有一本自己的考据本，那不是作品，见「工具」的 `research_tools`）；
   - **要单配模型**（`AgentDef.model`）。

   反面同样成立：**需要和用户来回迭代的不要委派**（设计对话就是），**一两步能做完的不要委派**（委派本身要一次确认，还要写一份自足 prompt）。判据的正文在 `prompts/tools/task.txt`，那里是唯一该说它的地方。
3. **一个任务的"流程"不单独成角色。** "规划→写正文→拍板"是 mate 的工作协议，不是新 Agent。

## 角色名册

| 角色 | mode | 职责 | 谁能触发它 | 工具 |
|---|---|---|---|---|
| **mate 搭档** | primary | 用户的创作参谋与项目执掌者：把"想法"长成四层活文档并维护；**自己写正文**；当编排者，委派并拍板 | 用户每次输入 | 见下 |
| **planner 规划者** | subagent | 把一个章节意图读成一份**场景简报**：前情、这场戏（谁要什么、谁挡谁）、必须发生、不能提前兑现、章末问题，以及按序的产物清单 | mate 经 `task` | `read` `glob` `grep` `webfetch` `websearch`（`edit` / `notes` 是**类别拒**——落盘类工具整个不在 schema 里）+ `recall`（**只读**考据本，别重查） |
| **researcher 考据** | subagent | 就一个**外部世界的事实**问题上外网查证，返回**结论 + 出处**（并明说哪些没查到/来源打架） | mate 经 `task` | `read` `glob` `grep` `webfetch` `websearch`（同上，类别拒）+ `recall` `remember`（它自己的考据本） |
| **summarizer** | primary + **hidden** | 上下文折叠时只写对话叙事（意图 / 决定 / 未决 / 下一步）；pinned 与证据账由 harness 确定性生成。不进角色表、不进 task 可派列表、不当默认 primary | harness 内部自动 | 无 |

- mate **自己写正文**（规范与文风卡由 harness 在写作窗口注入 system，见下「Skill 系统」）；**正文不派子代理**——它没有比自身更短的结论（"中间材料不进主线"那条判据对它不成立），而 mate 没见过正文就识别不出写作中浮现的新点子。理由与取舍见 `chapter-planning.md`。
- planner 与 researcher **不能直接对话**，只被 `task` 派生，且**都不能提问**（它们跑在隔离上下文里，用户不在场——见 `permissions.md`）。两者**不重叠**：阶段不同（章节级 vs 任意时刻）、粒度不同（一份工作单 vs 一个事实）、产出不同。
- persona 在 `prompts/*.txt`（英文，`readPrompt()` 载入）；agent 的 `description`（路由契约）内联在 `registry.ts`，写法见 `prompts/README.md`。

### 显式不做的角色（防回归）

**批评者 / 评审 agent** · **导演 / orchestrator agent** · **自动点子捕捉 / 一致性核查 agent** —— 分别是已删除的评判系统、多余的编排层、和"后台自动改企划"的残留冲动。

**`researcher` 不在上面这三个里，边界值得写清楚**：它查的是**外部世界的事实**（一个朝代怎么收税、某个器物当时叫什么），不是稿子**内部的一致性**（金手指的边界有没有被违反）。前者是"去问世界"，后者是"拿自己的文档互相对照"——后者仍然不做。判据落在**主语**上：问的是世界，不是这部小说。

**它的考据本不是「知识库」，也不是 skill。** 判据同样是主语，只是换成了**谁拥有它**：`skills/` 库里那几张卡是**用户的**东西——进 `<available_skills>` 目录、用户按名选（`design/core.md` 的「文风」格就是在选）、三层库还带"同名覆盖"的语义；而考据本是**模型自己的备忘录**，写在引擎工作区、`read` 够不着、用户不必知道也不用拍板。所以它既不该进 skill 库（那是"推"进上下文的、用户可选的知识），也不该有审阅环节（它不是作品）——它是"拉"的：问到才查。

### 加角色的固定动作

① 写一个 `AgentDef`（含 system）→ ② 决定 tools 白名单 → ③ 决定触发：被 mate 委派就 `mode:"subagent"`（task 的可见列表由运行时自动带出），是新对话面才考虑 `mode:"primary"`。

**不改任何 loop/registry 代码**——这正是"Agent 是数据"的回报。

## 工具

按领域分模块（TS 文件名 snake_case，工具 id kebab-case）。**下面这张表由 `tests/docs.test.ts` 守着**——`BUILTIN_TOOLS` 里每个工具都必须**以反引号形式**出现在这里（裸子串会误判成"提到了"，见那条测试的注释），删了工具没删文档、或加了工具忘了文档，测试都会红。所以这里不写数量。

**`file_tools`** — 改文件的两个面

| id | 用途 |
|---|---|
| `write` | 整篇写/覆盖一份文件（`design/…` / `chapters/…` / `state/…`）。**「这份文件整个是我的」**——旧文件不在场也能写 |
| `edit` | 锚点式改一段（给原文片段 + 替换文本），其余字节原样。**「我在动它的一部分」** |
| `delete` | 删掉**整份文件**。**删前把"这个名字还在哪儿出现"放进审批说明**——影响面不在被删的那份文件里 |

`write` 与 `edit` 分开而不是并成一个：合并就得靠"哪个参数给没给"来分辨，schema 对模型是含糊的。

**删一个段落/一节、末尾加一节，都不归 `delete`**——那都是 `edit`：给出原文片段与替换文本（删就替换为空）。`delete` 只管整份文件。

**`delete` 不做级联。** 它把引用列出来，清理由模型用 `edit` 逐处做——"该不该动 `world.md` 里那句话"是判断，不是机械操作。talemate 把 shell 剥掉了，删除必须是一个工具；也正因为没有 shell，"顺手删干净"没有地方可做，级联只能交回模型逐处判断。

**三个都不自己落盘**——拼出 `FileOp` 交给 `framework/write_ops.ts` 那条唯一路径，所以校验、不变量后验、权限、CAS、原子写、diff 全在那一处。**哪个目录能写由项目根表划**（`talemate.json.corpusRoots` 的 `write`），某个 agent 能不能动手由权限表划（子代理整类是 `edit: deny`）。"加一个要保护的目录"是加一条根表 / 规则，不是造一个工具。唯一**不走这条路**的写是 `propose-plan` 落规划工件——它不是作品文档，见 `framework/plan.ts`。

**`find_tools`** — 项目语料的两个找法（**项目级**：项目根表里所有可读目录通吃）

| id | 用途 |
|---|---|
| `glob` | 按项目相对 glob 找文件路径（`*` 不跨 `/`、`**` 任意层、`?` 单字符；无 `/` 的模式按文件名在任意深度匹配）。只读路径、不读内容；`path` 限定目录 |
| `grep` | 按正则搜文档内容，返回"文件 → 行号 + 行文本"；`path` 可为目录或单个文件，`include` 再按文件 glob 过滤，支持 `literal` / `ignoreCase` / `context` |

**`read_tools`** — 项目语料的读口

| id | 用途 |
|---|---|
| `read` | 按项目相对路径读整篇，或读其中一个 `section` |

**`research_tools`** — 考据本（researcher 自己的笔记本）

| id | 用途 |
|---|---|
| `recall` | 翻考据本：带 `query` 按词找（题目与正文都算命中面），不带就列已有题目。**未命中会回已有清单**——那是换措辞重试的路，不是错误 |
| `remember` | 记一条（题目 + 结论，**必须带出处 URL**），同名即覆盖。只给 researcher（`notes` 权限），planner 只有 `recall` |

考据本落在 `<novel>/.talemate/research/<题目>.md`——**引擎工作区，不是作品**：不进项目根表，`read` / `glob` / `grep` 一概够不着，读口只有 `recall` 一个（mate 读不到、用户也看不见，所以垃圾笔记的出路只有文件系统）。它解决的就一件事：**同一个问题不该被查第二遍**——查回来的结论不靠上下文活过压缩（折叠只留路径与结论首行，细节要按证据账重读），所以要落在笔记里。见 `framework/research.ts`。

（`character_tools`、`design_tools`、`framework_tools` 三个模块已删：角色专用工具一个都没有了，**建卡改卡走 `write` / `edit`，删卡走 `delete`**；两段式提案与结构规范查询也已退场——整篇成稿就是一次 `write`，用户看 diff 点头。）

**`core_tools`** — 委派 / 知识 / 人机交互

| id | 用途 |
|---|---|
| `task` | 委派 subagent（可派列表由运行时拼进 description）。**它没有硬门了**：从前挡的是"没拍板就派 writer"，正文改由 mate 自己写之后，写正文不再经过任何一个可挂门的工具 |
| `skill` | 按名注入 SKILL.md 正文 |
| `ask-user` | 向用户提问要**创作裁决**（不是权限审批）。1–3 题，可带选项/多选/自定义；超时是 pending 不是同意，见 `ask-user.md` |
| `propose-plan` | 把**一章**的规划交给用户拍板并结束本回合。规划**落** `<novel>/.talemate/plans/ch_<N>.md`（引擎工作区，见 `framework/plan.ts`），**不落 design/**；用户回话后由 harness 置 `approved`。它不需要任何模式前置——**规划是这条链上唯一的门** |
| `enter-prose` | 前置产物都落地后进入**正文模式**：role system 从 `mate.system` 换成 `prose.system`，权限不变；由模型显式调用，避免 plan 一接受就跳过建卡/考据 |
| `exit-prose` | 离开正文模式，恢复进入前的 mode（正文落盘时 harness 也会自动退出） |

**`web_tools`** — 联网

| id | 用途 |
|---|---|
| `webfetch` | 抓一个 URL → text/markdown/html。设置里配了 DeepSeek 就优先走它的 Fetch（html 仍直连） |
| `websearch` | 搜索。设置里配了 DeepSeek 就走它的 Search；否则 tavily / bocha / exa / duckduckgo |

**DeepSeek Search / Fetch**（`storage/web_config.ts` 存 `<talemateHome>/web.json`，设置在桌面端「设置 → 联网」）：
与模型调用同一把 key，`Bearer` 鉴权，按成功请求计费。Base 默认 `https://api.deepseek.com/v1/tools`
（含 `/v1/tools` 前缀，程序追加 `/search` 或 `/fetch`——与 DSH 的 Search / Fetch API 同口径）。
`websearch` 走 `POST …/search`（只要 `summary`，不拉整页正文；结果数由设置里的「每次搜索结果数」决定，
默认 10，单次最多 10），`webfetch` 走 `POST …/fetch`（只回 Markdown）。
Fetch 的 403/404 或空正文退回直连（站点策略/正文提取失败），401/402/429/5xx 直接报错——别让用户以为自己在用 DeepSeek。
工具不自己读这个文件：设置经 `ToolContext.webSettings()` 注入（工具层只有一个取数口）。

### 会话模式（`agent/modes.ts`）

**模式 = 临时叠在 primary agent 上的一层档**，外加一句"这个模式是什么"：可以是一条权限规则（`accept-edits`），也可以是一次 system 替换（`prose`）。它**不装工作流**——"正文该怎么写"归 `prose.system`，"规划批完了没有"归模型自己看产物。

与 agent 的分工：agent 回答"你是谁"（长期），模式回答"眼下在干什么"（一次一仗）。所以模式**必须有界**——进去、做完、出来。开放式的谈话（和用户聊设计）**不套模式**，那会把人关在里面出不来——`design-docs.md` 的「mate 没有阶段状态机」讲的正是这件事。

现在两种，一个管权限、一个管声音：

| 模式 | 规则 | 效果 |
|---|---|---|
| **`accept-edits`** | `edit: allow` | 落盘不问；委派与联网照问 |
| **`prose`** | 不碰权限，换 role system（`mate.system` → `prose.system`） | 只在写这一章时注入正文规范与文风卡，工具一个不少 |

**按类别挡，不是按名单。** 将来限制了某类动作，只要工具声明了那个 `permission`，就自动被挡住——不需要谁记得去改一份名单。这是旧写法（模式里硬编码一串工具名、加工具时靠一条测试兜底）修掉的病。

正文模式刻意**不装流程**：进不进由模型按"前置产物落没落地"决定，模式只回答"这一段用什么声音写"。验收条件是**工具面不变**——「正文模式不挡工具：它换的是 system，不是权限档」那条用例钉着。

**模式只在会话内存里**，和待确认的规划同生命周期：进程重启即回到默认。**硬保证不靠它**——它是一层"眼下按什么规则 / 什么声音走"的档，不是任何流程的状态机；"交出去就停"归工具自己的 `halt`。

### 权限：谁能做什么、什么要问

完整设计见 **`docs/permissions.md`**。这里只说它和本文件的关系：

- **`AgentDef.tools` 是广告**（模型看得到哪些 schema），**`AgentDef.permission` 才是边界**。撤下一个工具仍要真删定义——但"禁一类动作"从此不需要删工具，写 `{ edit: "deny" }` 就行。
- `runner.ts` 有一道**粗粒度兜底**：`deny *` 盖住的类别一律拒，哪怕工具是被幻觉调出来的（执行查的是**全局** registry，所以白名单挡住它看不见，兜底才挡得住它调得动）。细粒度（具体 pattern 的 allow/ask）由工具自己走 `ctx.ask`。

### 工具框架

`defineTool({ id, description, input, execute })` → `{ output, title?, metadata? }`。

- 入参带字段级 description，自动生成 JSON Schema。
- **校验失败 / 工具不存在 → 返回面向模型的重写指令**（不抛裸异常），让模型自纠。
- 长输出超预算写临时文件 + 返回预览 + 提示分段取。
- `halt`：工具在**成功**时可要求结束本回合（`propose-plan`）。**校验失败必须 `throw`，不能 `return`**——runner 对任何 return 都置 `halt`，返回一个校验错误等于把回合停在一个本可自愈的错误上。

## 触发矩阵

| 触发源 | 例子 | 机制 |
|---|---|---|
| **用户** | 进项目、"写第 N 章" | 用户输入绑定当前 primary；"要触发子代理"的话术由 mate 识别后转成工具调用 |
| **Agent（模型自决）** | mate 判断"这一章我手上没有材料" → `task(planner)` | 模型调 `task`；可派清单由 `subagentCatalog()` 动态拼进描述 |
| **harness** | 上下文超预算 | 内部自动跑 hidden agent |

> **关键认知**：在 agentic 世界里，"用户要写一章"**不会直接启动 planner**。输入进 mate 的会话，mate 按它的工作协议 + 手上的材料**决定**要不要、先调谁。所以触发时机由两件事决定：**mate system prompt 里的工作协议** + **task 工具的动态描述**。我们没有也不应该有一张"关键词 → 直接 spawn"的硬表。

### mate 的工作协议

1. **企划对话（含大纲）**：mate 直接答；查 = `glob`/`grep`/`read`。
   - **局部改**（一句、一段、一格、删一节）= `edit`：用户看 diff 就够，二向（接受 / 拒绝）。
   - **整篇成稿**（新建一份文档、或整篇重写）= `write`：旧文件不在场也能写，用户同样看 diff 点头。**没有"先取形状再提案"这回事**——规范是建议，不是通行证。
   - **删整份文档**（角色卡、过期专题页）= `delete`：它先把引用列出来，**级联清理由 mate 自己用 `edit` 做**。
   - **改文件一律走这三个工具**（`write` / `edit` / `delete`），不派子代理。
   **卷纲与序列纲就在这一条里**——它们是设计文档，走同一套 diff。
2. **要写某章正文**（一条链，四步）：
   ① 材料不在手上就 `task(planner)` 要一份**规划** → ② **`propose-plan` 把规划交给用户拍板**（它带 `halt`，回合到此为止，规划落 `.talemate/plans/ch_<N>.md`）→ ③ 用户接受后 **mate 自己写正文**：harness 随 system 把正文规范与这本书的文风卡交出去（见下「Skill 系统」的例外），mate 用 `write` 落 `chapters/`（二向：用户看 diff 点头）→ ④ **状态回写**：把这一章改变的东西写回 `state/`（角色的处境、伏笔账、这一章的流水），同样走二向。这一环列在规划的「产物（按序）」里，见 `state.md`。
   - **规划派得出去，正文不派**：规划的中间材料（翻设定、查资料、试错）远多于它交回来的那一页结论，正是 SubAgent 的判据；而正文**没有比它更短的结论**——产物就是全部中间材料，且 mate 没见过它就识别不出写作中浮现的新点子（`chapter-planning.md`）。
   - ② **是这条链上唯一的门**：交出去就停（`halt`）。规划是"照它去执行"，**批准的是执行本身**——所以没有第二个"没拍板就不许写"的检查点：写正文是普通 `write`，用户照样在 diff 上点头。
   - **能自己查一步就查完的，不要派规划者**：core 刚读过、序列纲在手上，材料本来就在 mate 手里，派出去等于把已有的东西抄一遍。
3. **作品级取舍**（"要不要写残酷点"）→ `ask-user`。
4. **什么时候必须派**：需要隔离上下文或独立专注才 `task`；mate 自己能一两步查完的绝不派。
5. **执行中发现更好的走法，就地按新的写。** 规划是**写作前**的准备，管不到写作中的发现——那不需要"变更申请"，也不需要补一份新规划（`chapter-planning.md` 的末节）。

### task 契约

```
task { agent: "planner", prompt: string }
  → 校验 agent 存在且 mode=subagent；depth 检查（≤1 层）
  → 新建 child Session（model = sub.model ?? 父 model，同项目）
  → child.post(prompt) 跑完整子循环
  → 父模型收到 <task agent="…" state="completed" session="…"><task_result>…</task_result></task>
```

- **prompt 必须自包含**：子代理上下文全新，你给的 prompt 就是它的全部指令——把这一章的意图与手上已有的材料写全，别让它猜。
- **必须说清要它返回什么**（一份可执行的章节规划）。
- 子代理工具集由**它自己的** AgentDef 决定，不继承父全量；**默认不带给它 `task`**（防链式 spawn）。
- **子会话落盘但不在左栏**：`session.json` 带 `depth` / `parentSessionId`，左栏与 `/sessions` 只列用户会话；
  对话里 `task` 画成一张嵌套卡，轨迹里能看到子会话 id 与完整过程。步数预算不够时循环会停在最后一次
  工具调用上、没有正文——所以 `task` 对空结果显式回 `state="empty"`，不让父模型以为"它答了，只是没内容"。
- **子代理有硬步数预算**（planner 20 / researcher 30）。最后三步在 system 里注入收尾提示，最后一步
  直接撤掉工具，逼它把已有材料写成结论；主代理不套这套——mate 可能正在写一整章，最后一步撤工具
  等于把稿子截断。调研实测：10 步时 5 次委派里 3 次跑满且零字返回；放开到 30 步后同一条链路
  跑到 21 步并正常收尾。

## Skill 系统

一个 skill = 一个目录 + `SKILL.md`（frontmatter 只强校验 `name`；`description` / `title` / `kind` 可选，其余字段容忍并忽略）。

```
SKILL.md
---
name: style-01-wangwen
title: 网文爽感
kind: style
description: 网文 · 白话爽感文风（第三人称，快、顺、直给）。用户说要"网文风"，或想把这本书写得顺、快、有爽感时选它。
---
（正文 = 完整文风卡：约束层 + 六维声音层 + 反例 + 声音范例）
```

**用户切换文风就是写一个卡名**：`design/core.md` 的「文风」格写哪张卡的名字，写作窗口就取哪张（`framework/prose.ts`）；不写这一格用默认那张 `storytelling`。所以**卡名必须是目录名**——对不上，`buildProseBrief` 会报"文风库里没有这个名字"，而那张卡明明躺在库里，看得见却取不到（`tests/skill.test.ts` 守着这一条）。加一张可选卡 = 加一个目录，没有第二处要改。

**文风卡要多标两样：`kind: style` 与中文 `title`。** `kind` 是**状态栏那个文风选择器**把文风卡从普通 skill 里挑出来的唯一判据——库是三处合并的，不筛的话一个"查资料"的 skill 也会进候选，选中它等于把那份工作法当成"一种声音"注进正文窗口。`title` 是界面上给人看的名字；`name` 只作**稳定 id**（写进 `design/core.md`，也是取卡的判据），两者别合并：中文写进 `name` 会同时踩两处（`prose.NAME_LIKE` 只认 ASCII；且中文之后"卡名"与"一句大白话"就分不开了）。`tests/skill.test.ts` 钉着内置库每张都有这两样。

- **发现**：三个库、一条优先级——**内置库** `<repo>/skills/<name>/`（随产品发布：`storytelling` 默认讲述体 / `style-01-wangwen` 快节奏爽感 / `style-02-guyan` 女频古言 / `style-03-xianyan` 现言快节奏）< **全局库** `~/.talemate/skills/<name>/`（作者级、跨作品）< **项目库** `novels/<id>/skills/<name>/`（本小说专属）。扫描顺序就是优先级，后扫的同名覆盖先扫的，所以内置那几份压不过任何用户自己的 skill。
- **注入**：system 只放 `<available_skills>`（name + description + location）；`skill` 工具按名把正文载入为一条 tool-result。
- **触发**：**只看 description**，没有第二处硬编码。**别在 persona 或工具返回里替它点名**"先加载 X"：那样触发契约就有了两份，两份迟早说两套话，而且一处生效一处不生效时没人查得出来。

**一处例外：正文规范与文风卡由 harness 注入（`framework/prose.ts`）。** 它们不按 description 触发、也不靠 mate 记得调 `skill`，理由三条，都不是口味问题：

1. **规范是不变量**，"记得加载"不该是它的存活条件——同 `propose-plan` 的 `halt` 由 harness 执行。
2. **skill 正文活不过压缩。** 它是 tool 结果，折叠时只留工具名与首段（证据账给的是路径，而 skill 没有可重读的路径）：书写到十几章，纪律会在某一次压缩之后**无声消失**；而 `<available_skills>` 目录每轮从 `discoverSkills` 重建、条目还在，模型不知道自己丢了什么。system 每轮重建，不受这一条影响。
3. **规范不抄进每张文风卡**：五张各一份 = 改一次动五处。

窗口的开与关都靠状态，不靠自觉：规划被用户拍板、而这一章的正文还没落盘 → 注入；正文一落盘（`chapters/chapter_ch<N>_v<M>.md` 出现）→ `PendingProposal.done` 置位，整块退出上下文。所以这份 token 只在写那一章的几轮里付。

## 人机交互工具（对应"用户当主编"）

- **`ask-user`**：agent 需要用户出想法/裁决时用（"主角的金手指是什么？"）。**不是权限审批，是参谋要决策。**
  一次 1–3 题，用户可以答、逐题跳过、收起、走开；超时返回 `pending`，搭档停下这一轮但问题仍可回答。
  界面是占住输入框位置的底部卡片，收起后留提示条。契约与三态见 `ask-user.md`。

**落盘审批不是工具，是权限系统的一道规则。** 从前有过一个让模型主动要用户点头的工具，已随两段式一起删掉：那件事现在挂在 `write_ops.ts` 的 diff 预览上——写不写、用户点不点头，由唯一写路径执行，不靠模型记得调哪个工具。子代理的 `question` 类别仍是 `deny`（它们跑在隔离上下文里、用户不在场）。提问超时是 pending，审批没有回答方是拒绝（fail closed）——两者的沉默默认相反。

**放行规则不在这里写**——见 `permissions.md`。
