# Agent 规范 —— talemate 的 Agent / SubAgent / Tools 定义与触发

> 日期：2026-09-05
> 上游：`04-harness-design.md`（§3 Agent 架构是这份规范的容器）、`02-product-definition.md`（2026-09-04 修订版，去评判的产品主线）
> 参考资料：`~/code/agent-foundry/docs/opencode-study/`（01/03/04/05 课）+ `~/code/opencode` 源码精读（本文标注了出处）
> 这份规范回答四个问题：**我们到底需要哪些 Agent / 哪些 SubAgent / 这些 Agent 在什么时机被触发 / 用什么机制触发**，顺带把 Agent / SubAgent / Tool / Skill / 规则文件五者的边界钉死，避免 P1 接领域时凭感觉加角色。
>
> ⚠️ **2026-09-06 修订（以本文 §8 为准）**：企划层改 **懒建 + doc-spec 按需**——createProject 不再播种四层；设计引导不再是 DESIGN_PROTOCOL 自动注入，而是用户点名某层时由 editor 调 `doc-spec` 拿结构再成稿。§0/§4 里「outline 还是骨架即注入设计协议」等旧表述已过时。

---

## 0. 为什么写这份规范（现状的模糊点）

P0 harness 已经落地了 `AgentDef` + `AgentRegistry`（`src/agent/registry.ts`，内置 editor/planner/writer），但"谁是 Agent、谁是 SubAgent、谁能触发谁、内部杂活算不算 agent"这些约定散在各处、且有一处不一致：

1. **"角色"和"机制"混着谈**。04 §3 说"editor primary + planner/writer subagent + task 委派"，但没解释为什么 planner/writer 是 subagent 而不是 tool、为什么没有"评审/拍板 agent"——新角色只能靠感觉归类。
2. **触发只有一种实现（task 工具）但没写清"谁在何时该调它"**。editor 的 system prompt 里写着"写作不是你的活，用 task 委派 writer"，但"该不该先规划、规划/写手之间谁串流程、成品由谁落盘"没有一处权威定义。
3. **内部杂活没走 agent 体系**。compaction 现在是一段硬编码 `chat(COMPACTION_SYSTEM)`（`src/session/compaction.ts:41`），而 opencode 把它做成一个 hidden agent——这破坏了"能力 = 人格 × 权限"的统一模型。
4. **writer 的落盘权和 editor 的拍板权冲突未解**。writer 工具集里有 `save-chapter`（会触发 confirm），而 04 §7.2 又写"回传文本为主、save 为辅，写入一律走 editor 的 confirm"——到底谁落盘，两处没对上。

规范的写法是**先立判定规则，再给目录，再给触发矩阵，最后约束实现**。

---

## 1. 参考模型：opencode 的一句话心智模型

> 本节是对 opencode 源码的提炼，出处标注到文件。opencode-study 各课"对照我们的 harness"的段落不采用——那对应的是被 talemate 取代的旧 harness。

### 1.1 只有一个"会思考的东西"：Agent，且它是一份数据

opencode 里 Agent 就是一份配置（`packages/opencode/src/agent/agent.ts` 的 `Info`）：

```
{ name, description,
  mode: "primary" | "subagent" | "all",
  prompt,            // ⭐ 人格 = 系统提示词
  permission,        // ⭐ 工具权限矩阵（决定它碰得到哪些工具）
  model?, variant?, temperature?, topP?,   // 调参
  steps?,            // 步数软上限
  native?, hidden? } // 元信息
```

**没有任何一个 Agent 背后有"另一套代码路径"。** 起标题、写摘要、压缩上下文（title/summary/compaction）在 opencode 里全是 `hidden: true` 的普通 Agent——harness 想干这些杂活时，就是"拿一个 Agent 跑一遍"（`agent.ts:219-264`）。这是最该带走的设计观：**能力 = 人格 × 工具权限，别为每种角色单开代码路径。**

### 1.2 primary 与 subagent 的区别不在代码，在"这个会话怎么来的"

- **primary**：用户能直接对话的 Agent，是会话的"当前人格"。一条用户消息绑定一个 agent（消息上带 `agent` 字段），runLoop 按 `lastUser.agent` 解析用谁的人格和工具集（`session/prompt.ts:1170`）。opencode 内置 primary = `build`（默认）、`plan`（plan 模式，禁所有 edit）；`default_agent` 配置要求非 subagent 非 hidden（`agent.ts:328-340`）。
- **subagent**：**不能**成为会话默认、不能直接对话，只能被另一个 Agent **经 `task` 工具派生**。派生时新建一个独立 Session（`parentID` 指向父会话），全新上下文、只传一段 prompt，跑完后把**最终文本**包成 `<task_result>` 回传父会话（`tool/task.ts`）。隔离在数据层长这样：**父子之间唯一的联系是 `parentID` 指针 + 权限下传，除此之外子代理什么都不知道。**

所以 primary / subagent **不是两类程序，是"这个脑子的会话由谁开启"的两种场景**。`mode: "subagent"` 只是给 task 工具一个"允许被派生"的标记 + 默认禁链式派生（subagent 默认拿不到 `task`，防递归爆炸，`agent.ts` 的 `deriveSubagentSessionPermission`）。

### 1.3 触发机制只有一种：工具调用

模型在循环里唯一能影响进程的方式就是 **tool-call**。由此推出两件事：

- **调用子代理 = 调一个工具**。`task` 是一个普通工具，但它的 description 是**运行时动态生成**的——把当前 agent 权限内可见的所有 `mode: "subagent"` 的 agent 列出来（`tool/registry.ts` 的 `describeTask`：过滤掉被 deny 的、逐行 `- name: description`）。**模型视角里"我要派个 explore"就是"我调一下 task 工具、subagent_type 填 explore"。** 这就是"tools 触发 agents"的确切含义。
- **primary 切换也是靠消息重新绑定**。`plan_exit` 工具会往会话注入一条 `agent: "build"` 的合成 user 消息（`tool/plan.ts`），下一轮 runLoop 读到 `lastUser.agent = build` 就换人格。用户侧用 `/agent`、默认用配置，本质都是"决定下一条消息绑哪个 agent"。

### 1.4 Tools 与 Agent 的分界

Tool 也是一份数据（`Def { id, description, parameters, execute → { title, metadata, output } }`），注册进一个 registry，执行时统一走"校验 → 执行 → 截断"，参数校验失败的回话是 **"请重写"** 而不是裸报错（`tool/tool.ts`）。Tool 与 SubAgent 的边界一句话：

> **Tool 没有自己的上下文、人格和循环**——一次调用、结果回灌；**SubAgent 是完整跑一个带独立上下文的循环**。需要"专注地多轮思考、且产出要跟父会话隔离"的活，做 subagent；确定性、单次、schema 化的动作，做 tool。

---

## 2. talemate 的归类判定规则

落到我们头上，五类东西怎么分（新增任何东西先过这张表）：

| 你在纠结的东西是… | 做成 | 依据（判断题） |
|---|---|---|
| 用户直接长期对话的"人" | **Agent (primary)** | 它是不是某个对话面的常驻人格？ |
| 需要一个独立上下文专注干完、产出要隔离、或想给它单配模型 | **SubAgent** | execute 里会"为一个完整思考任务开一个新 LLM 对话"吗？ |
| 确定性、单次、schema 化的动作（读文档/落盘/问用户/委派本身） | **Tool** | 不需要它"自己想怎么做"，给参数就给结果？ |
| 按需注入的知识正文（文风卡/技法包/模板/判据库） | **Skill** | 是"知识/说明书"而不是"动作/脑"吗？ |
| 跨角色常驻的操作规范、路径约定、命名纪律 | **AGENTS.md** | 是要"每步都遵守的规则"吗？ |

三条附则，用来挡住常见误判：

1. **不设导演 Agent，也不设"评审/拍板" Agent。** opencode 没有导演；多脑协作的唯一机制是父 Agent 用 `task` 委派。拍板永远是人（用户当主编），不需要也不应该有"审查另一个 agent 产出的 agent"——那是已删除的评判系统的残留冲动。
2. **能靠 Tool 完成的，不升级成 SubAgent；能靠 Skill 注入的，不重写成 SubAgent。** 比如"读某角色卡切片"是 editor 自己 `read-doc` 就能干的，不该派个子代理；"要按某个文风的规矩写"是 writer 载入一张风格 skill，不是另开一个角色。**SubAgent 是稀缺资源（每次 = 一整段独立上下文 + 一次往返），只在"隔离上下文"或"独立人格/模型"真的买到东西时才用。**
3. **一个任务的"流程"不单独成角色。** "规划→写正文→拍板"是 editor 的工作协议（写进它的 system prompt），不是一个新 Agent。下一节按这个原则给目录。

---

## 3. 我们需要的角色目录（P1 目标态）

### 3.1 总表

| 角色 | mode | 一句话职责（persona 边界） | 工具集 | 建议模型/推理 | 谁能触发它 |
|---|---|---|---|---|---|
| **editor（主编）** | primary | 用户的创作参谋与项目执掌者：设计段把"想法"长成 docs/ 四层活文档并维护；写作段当编排者，委派并拍板 | task, read-doc, write-doc, **edit-doc, append-doc, remove-doc-section, search-docs**, list-docs, skill, ask-user, confirm | 默认项目模型；编辑对话可用 off/low | 用户（每次输入都绑它，唯一常驻脑） |
| **planner（规划）** | subagent | 通用结构师：把材料梳理成结构/规划（章节节拍、整本/分卷大纲、结构重排）——尺度是 task 参数，不是角色 | read-doc, list-docs, skill | 可单配；规划是分析活，low/high 皆可 | editor 经 task |
| **writer（写手）** | subagent | 按"当前设定切片 + 细纲/节拍"写一章正文；不自创设定、只输出正文 | read-doc, list-docs, skill, save-chapter* | 生成活，low 更省（临时思考 §七已实测） | editor 经 task |
| **summarizer（内部）** | primary + hidden | 上下文压缩时生成前情摘要；**不进用户可见角色表、不进 task 可派列表、不当默认 primary** | 无 | 缺省继承；可 talemate.json 覆盖小模型 | harness 内部自动 |

\* `save-chapter` 的去留见 §5.4（writer 直接落盘 vs editor 拍板后落盘，尚未最终选型；当前保留 writer 的 save-chapter）。

### 3.2 显式不做的角色（防回归）

- **批评者 / 评审 agent** —— 已随评判系统删除，不回归。
- **导演 agent / orchestrator agent** —— 编排是 editor 的 system prompt 工作协议 + task 链，不是一个能对话的角色。
- **自动"点子捕捉器 / 一致性核查" agent** —— 回写企划走 editor 提议 + 用户拍板（02 §4 决策），不做后台自动改企划的 agent。

### 3.3 以后（P2）可能加的角色，都从 subagent 长出来

| P2 能力 | 形态 | 触发 |
|---|---|---|
| 上传样例 → 提取文风 | **style-extractor** subagent（独立上下文读样例，产出 SKILL.md 草案） | editor 经 task；产物给用户拍板后入全局 skill 库 |
| 长篇一致性对账 | **consistency** subagent（跨章查设定出入） | editor 经 task |
| 长篇状态层（伏笔登记/连续日志） | 偏 harness 内部/工具，未必成角色 | 后置再定 |

**加角色的固定动作（三步，防止再造一条路径）**：① 写一个 AgentDef（含 system，见 §5 的 prompt 写作约束）→ ② 决定 tools 白名单 → ③ 决定触发：若被 editor 委派，mode=subagent 并写进 editor 的 task 可见列表（动态描述自动带出）；若是新对话面，才考虑 mode=primary。不改任何 loop/registry 代码——这正是"Agent 是数据"的回报。

---

## 4. 触发矩阵：谁、在什么时机、用什么机制

### 4.1 分三路触发源

| 触发源 | 例子 | 机制 |
|---|---|---|
| **用户** | 进项目、设计段提问、"写第 N 章" | 用户输入绑定当前 primary（editor）；写章这类"要触发子代理"的话术，由 editor 识别后转成工具调用（见下行） |
| **Agent（模型自决）** | editor 判断"该规划了"→ task(planner) | **工具调用**：model 调 `task` 工具，运行时 describeTask 把可见 subagent 列给它选 |
| **harness（系统内部）** | 上下文超预算、会话命名 | 内部自动跑 hidden agent（compaction/title） |

> 关键认知：**在 agentic 世界里，"用户要写一章"并不会直接启动 writer**。用户输入进入 editor 的会话 → editor（按它的工作协议 + 手上的材料）**决定**要不要、以及先调哪个 subagent。所以"触发时机"本质上被两个东西决定：**editor 的 system prompt 里的工作协议**（什么时候该 task）+ **task 工具的动态描述**（它能派谁）。我们没有也不应该有一张"关键词 → 直接 spawn"的硬表。

### 4.2 editor 的工作协议（触发时的决策依据，写进 editor.system）

这是把产品流程落到"模型何时调 task"的地方，按 02 §4 修订版写：

1. **设计段对话**：editor 直接答；框架维护是 editor 的活——查 = `list-docs/read-doc/search-docs`，增 = `append-doc`，改 = `edit-doc`（只动一格），删 = `remove-doc-section`（删除前工具内置引用检查），整篇重写才用 `write-doc`。**confirm = 用户拍板，别绕过；不派子代理**。
2. **用户要为某章做节拍规划**（"第 N 章怎么写 / 做个细纲"）→ editor `task(planner, { prompt: 带 core+相关角色/世界切片 + 本章任务 })`；planner 只读 docs/skill，回节拍文本；editor 展示给用户，拍板后由 editor 落 `plan_ch<N>.md`。
3. **用户要写某章正文** → editor 先 `read-doc` 拿"当前版本"的 core + 相关切片 + （若有）`plan_ch<N>.md` → `task(writer, { prompt: writer 规范 + 切片 + 节拍 })` → writer 产出正文 → **回到 editor，editor 面向用户做成品确认，用户拍板后 editor 落 `chapter_ch<N>_v<M>.md`**。
   - 允许 editor 合并 2+3（用户只说"写第 N 章"且没有现成规划时，editor 可先 task(planner) 拿到节拍、把节拍连同切片一起 task(writer)）——**这是同一个循环里连续两次 task 调用**，opencode 就是这么串多步的，不需要任何编排代码。
4. **任何一步出现"要不要写残酷点 / 金手指边界是什么"这类作品级取舍** → editor `ask-user`（参谋要裁决，不是权限审批）。
5. **"什么时候必须派、什么时候自己干"**：需要**隔离上下文**或**独立专注**的活才 task；editor 自己能一两步查完的（读个切片、列个文档）绝不派。**每派一次都是一段全新上下文 + 一次往返成本。**

### 4.3 task 工具的参数与回传契约（照 opencode，已在 P0 实现）

```
task { agent: "planner" | "writer" | …, prompt: string }
  → 校验 agent 存在且 mode=subagent；depth 检查（沿 parentID，默认 ≤1 层）
  → 新建 child Session(agentId, model = sub.model ?? 父 model，同项目)
  → child.post(prompt) 跑完整子循环
  → 父模型收到：<task agent="…" state="completed"><task_result>子代理最终文本</task_result></task>
```

要求（`tool/task.ts` 说明书语义）：
- **prompt 必须自包含**：子代理上下文全新，你给的 prompt 就是它的全部指令——把材料/切片写全，别让它猜。
- **必须说清要它返回什么**（正文全文？节拍表？）和**要不要它写正文**。
- 子代理的**工具集由它自己的 AgentDef 决定**（不是继承父全量）；**默认不带给它 task**（防链式 spawn），除非显式允许。

---

## 5. 机制实现规约（落到当前代码）

这一节是把上面对齐到 `src/` 的实现约束，同时标出当前 P0 与规范的差距。

### 5.1 Agent 绑定与每轮解析（已满足，需注释固化）

- `StoredMessage.agent` 已存在（`src/core/types.ts`）；`Session.post` 缺省用当前会话 agent（editor），loop 按该 agent 解析 system + 工具（`session.ts:buildRequest` / `loop.ts`）。✅
- 待固化：会话一旦支持多 agent，规则是 **runLoop 每轮按 `lastUser.agent` 决定人格**（照 opencode `prompt.ts:1170`）。P1 只有 editor 常驻，先写注释即可。

### 5.2 task 工具 = 动态 describeTask ✅（2026-09-05 落地）

`ToolRegistry.schemasFor(ids, { taskCatalog })`（`src/tool/registry.ts`）：当某 agent 的 tools 含 `task` 时，把 `AgentRegistry.subagentCatalog()`（`src/agent/registry.ts`，取非 hidden 的 subagent）渲染成 `- planner: …\n- writer: …` 追加进 task 的 description（`session.buildRequest` 传入）。新加 subagent 无需改 tool 代码。

### 5.3 内部杂活统一成 hidden agent ✅（2026-09-05 落地）

- `AgentDef` 加 `hidden?: boolean`（`src/core/types.ts`）。
- registry 内置 hidden `summarizer`（`mode:"primary", hidden:true, tools:[]`，system=原 COMPACTION_SYSTEM）；`getDefaultPrimary()` 过滤 hidden（`src/agent/registry.ts`）。
- `session.maybeCompact` 取 `agents.get("summarizer").system` 喂 `compact()`；`src/session/compaction.ts` 去掉硬编码 COMPACTION_SYSTEM，改收 `system?`（缺省回落 SUMMARIZER_SYSTEM）。
- title 起名仍未 agent 化（P2 可选）。

### 5.4 谁落盘：把"拍板"放在 editor（差距，见决策点 3）

- 产品语义是"editor 面向用户确认成品、用户拍板后落盘"（04 §7.2）。而现在 writer 工具集含 `save-chapter`，会在**子会话里**触发 confirm——等于把落盘/拍板点下沉到了 writer。
- 两害权衡：
  - **拿掉 writer 的 save-chapter**（阶段一推荐）：writer 只回传正文文本（`<task_result>`），editor 收到后 `write_chapter`/保存，confirm 落在 editor 层。代价：**长章节会整篇进 editor 上下文**（task_result 不截断的话）。
  - **保留 writer 的 save-chapter**：writer 长文直接落盘、回传只回摘要，省 editor 上下文；但 confirm 在子会话里弹，editor 对成品内容的"把关"变弱（它只看到摘要）。
  - 折中（推荐落点）：writer 把成品落 `chapters/`（子会话内 save，confirm 给用户），同时**回传一段短摘要 + 文件路径**而非全文给 editor；editor 的角色从"看全文"降为"确认已生成 + 面向用户"。若产品要 editor 审全文再放行，则走前一种。**二选一，不能两个都留。**（这同时牵出长输出策略：任务级返回文本要有截断/摘要契约，照 05 课的 truncate 思想。）

### 5.5 其余对齐清单

| 项 | 现状 | 规范要求 |
|---|---|---|
| depth 限制 | `runSubagent` 里 `depth >= 2` 抛错（`session.ts:176`） | 保持 ≤1 层；注释说明"editor→subagent 够用，孙代理禁" |
| 子代理工具集 | 由 sub AgentDef.tools 决定 ✅ | 默认不含 task/ask-user/confirm（确认留在 editor 层，见 5.4） |
| model 继承 | `sub.model ?? this.model` ✅ | 保持；agent 钉模型用于"内部杂活用小模型" |
| confirm / ask-user | 工具层 `needsConfirm` + `io.confirm` ✅ | 语义固定：confirm=不可逆动作拍板；ask-user=参谋要创作裁决，不是权限 |
| skill 注入 | system 只放目录、正文按需 skill 工具 ✅ | 保持；文风/技法包走这条路，不做成 agent |
| 事件/消息 | 消息带 agent ✅；compaction 消息是 `<story-state>` ✅ | 保持 |

---

## 6. Prompt 写作约束（给每个 AgentDef 的 system 立规矩）

从 opencode 4 类内置 agent prompt 提炼（03 课 §9），我们写 editor/planner/writer 的 system 时遵守：

1. **第一行定角色 + 定边界**："你是主编（用户的参谋，不亲自写正文）" / "你是规划（只做节拍，不写正文）"。
2. **能力写成"工具映射"**：editor 的"什么时候 read-doc、什么时候 task、什么时候 ask-user"要写清触发条件，别只写形容词（"你要会统筹"）。
3. **写负向约束**：writer 的"不自创设定""输出只有正文、不含标题/解释"（现有 WRITER_SYSTEM 已带）；planner 的"不写正文"。
4. **机器消费的输出给格式契约**：planner 明确节拍输出的固定结构（中枢问题/环账本/章末钩子/放大点/这章不许/节拍序列，04 §3.2 已列）；compaction 给"600 字内条目式"。
5. **把"要不要 task / 何时 task"写成 editor 的操作手册 §4.2**——这是触发时机真正的落点。

---

## 7. 决策点（待拍板，P1 接入前定）

1. **编排哲学：纯模型编排 vs 薄流程工具。** 规范默认**纯模型编排**（editor 工作协议 + 连续 task 串 planner→writer），不新增编排代码——最贴 opencode、最少层。若 P1 端到端实测 editor 老跳步骤、产出不稳，再退化一个"write_chapter"薄工具把流程钉死。建议先纯模型编排走通一章，用真实写作验收说话。
2. **planner 是否独立 subagent。** 默认保持独立（独立上下文 + 节拍可单独给人拍板）；但它和 writer 的细纲输入高度重叠，也可并进 writer（writer 自己先规划再写）。倾向**保持独立**，因为"结构先行"是产品护城河（02 §3），节拍应能独立迭代。
3. **writer 落盘 / 回传（§5.4）。** 选"writer 落盘+回摘要" 还是 "writer 只回传、editor 审全文再落"。影响长文上下文策略，先定。
4. **内部 agent 统一化（§5.3）** 现在就做还是 P2 一起。改动小，倾向随 P1 顺手做。

> 已默认、不再争论的：不设导演/评审 agent；拍板只属于人；子代理只经 task 触发；深度 ≤1；subagent 不链式 spawn；一次只留一个 primary（editor）。

---

## 8. 落地状态与后续（2026-09-05）

本轮实现 = **框架设计闭环 + harness 深度规范化**，与 `06-framework-and-mode-notes.md` §6/§6.6 一致，详见 `07-editor-framework-design.md`（主编规范 + 框架设计流程 + 跑通示例）。

**已落地**
- framework 域层 `src/framework/`：`doc_spec`（每层结构规范，按需取）· `markdown`（按小节区块手术）· `search`（跨文档引用）· `characters`（角色卡 schema）· `report`（四层现状卡片）· `anchor`（core/world 常驻设定注入 `buildResidentDocs` + 设计段判定）。
- **懒建**：createProject 不再播种四层（`src/storage/project.ts`）；docs 初始为空，用户要完善某层时 editor 调 `doc-spec` 拿形状再成稿；`add-character` 首次调用自建 characters.md。新增 `listChapters`。
- 框架增删改查工具：`list-docs`（含小节索引）/ `read-doc`(带 section) / `search-docs` / `edit-doc` / `append-doc` / `remove-doc-section`（删除前内置引用检查进 confirm）（`src/tool/（按领域模块：doc_tools / character_tools / framework_tools / core_tools（工具 id 用 kebab））`）。
- editor 上下文：可见 primary 每轮注入 core/world 常驻设定（`buildResidentDocs`，`src/context/assemble.ts` + `src/session/session.ts`）；设计引导不自动注入——用户点名某层时 editor 调 `doc-spec` 工具按需拿规范。常驻设定现读自磁盘，无写后刷新钩子、永不陈旧。（原 `<nvl-state>` 状态包装块已删，见 06 §8。）
- 内部杂活 agent 化 + task 动态描述 + hidden 过滤（§5.2/5.3）。
- 单测 `src/framework/framework.test.ts`（`bun test`，含懒建/doc-spec/角色卡）+ `bun run smoke`（断言 docs 懒建为空）+ `bun run typecheck` 全绿。

**§7 决策点处置**
- 2（planner 独立 subagent）：已定为**通用结构师**，尺度走 task 参数（本规范 §3.1 表述已更新）。
- 4（内部 agent 统一化）：已随本轮落地（§5.3）。
- 1（编排哲学）与 3（writer 落盘 vs editor 拍板）：未定，留给写作流里程碑（见 07 §7）。

**留后续**：写作流 plan-gate（writer 门禁于已批准 plan_ch）、genre 题材 skill 化、writer 落盘选型、长篇状态层。
