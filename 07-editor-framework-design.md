# 主编(editor) Agent 规范 与 小说框架设计 —— 落地实现与流程

> 日期：2026-09-05（本轮已落地，见文末实现索引）
> 上游：`02-product-definition.md`（去评判主线）、`04-harness-design.md`（harness）、`05-agent-spec.md`（Agent 规范）、`06-framework-and-mode-notes.md`（收敛记录 §6）
> 本文回答：**主编（唯一 primary）是谁、小说框架（docs/ 四层）怎么从"一句话"长成可用企划、这个流程由哪些工具/机制承载**。写作段的 plan-gate 与 genre skill 留 §7。
>
> ⚠️ **2026-09-06 修订（以本段为准，旧章节按需读）**：企划层 **懒建**（createProject 不播种；docs 空，文件在用户点名某层后才被写入）；**不再自动注入 DESIGN_PROTOCOL**——用户说「完善核心设定」等时，editor 调 `doc-spec` 工具拿该层结构，**按用户自由描述成稿（不逐格盘问）→ 确认后整层落盘 → 之后只 edit-doc 还待定/要改的小节**。进入空间只展示四层现状卡片 + 提示，干什么由用户决定。

---

## 1. 主编（editor）—— 唯一 primary

### 1.1 persona 边界（实现在 `src/agent/registry.ts` 的 EDITOR_SYSTEM）

| 段 | 内容要点 |
|---|---|
| **设计段职责** | 陪用户把"一个想法"长成 docs/ 四层活文档；按依赖序推进（core 最先、outline 最后且最易变）；层内"聊定一格就写一格"，不空谈 |
| **框架维护** | docs 是你的活文档：查 = list-docs / read-doc / search-docs；增 = append-doc；改 = edit-doc；删 = remove-doc-section；整篇重写才用 write-doc。动前先 read 当前版；confirm = 用户拍板，别绕过 |
| **写作段职责** | 写作不是你的活：需要时先 task(planner) 出节拍/细纲，再 task(writer) 写正文；你编排、把成品给用户拍板后落 chapters/。能自己一两步查完的不派 |
| **交互纪律** | ask-user 用于要创作裁决；不替用户做作品级决定；不确定以 docs/ 当前版为准；不亲自写正文；无独立评审职责 |

**editor 不是**：导演 agent、评审 agent、亲手写正文的写手。它是唯一常驻的对话脑 + 项目执掌者；planner/writer 只在它 `task` 委派时出现，各自独立上下文。

### 1.2 工具集与"什么时候用"

| 工具 | 何时用 | confirm |
|---|---|---|
| `list-docs` | 开场/不确定有哪些材料；返回各文档 + 小节标题（含未填 `（待定）` 可见） | — |
| `read-doc` | 读整篇；或带 `section`（小节标题，如「主角」「角色：沈越」）只读一格 | — |
| `search-docs` | 改/删某个设定前查它被谁引用（影响面） | — |
| `append-doc` | 追加一块（新角色卡 / 新设定小节）；block 自带 `##` 标题，重名会提示改用 edit | 无（非破坏） |
| `edit-doc` | 改一个小节正文（其余原样保留） | ✅ 动态（旧→新长度） |
| `remove-doc-section` | 删一个小节 | ✅ 动态（含引用检查命中） |
| `write-doc` | 整篇重写（脚手架 / 整体重构） | ✅ |
| `task` | 派 planner/writer（可派列表由 system 动态注入 description） | ✅ |
| `ask-user` | 要用户出主意 / 拍板创作取舍 | — |
| `skill` | 载入题材/文风技法知识 | — |
| `confirm` | 显式请求一次拍板 | — |

### 1.3 阶段状态（不是第二 persona）

editor 只有一个人格；进入空间**只展示四层现状卡片**（`src/framework/report.ts`：有/无、是否待完善），**干什么由用户决定**。每次请求 editor 都带 `<nvl-state>` 锚点（项目现状摘要）；**设计引导不自动注入**——用户点名要完善某层时，editor 调 `doc-spec` 工具（`src/framework/doc_spec.ts`）按需拿该层结构规范再成稿。

---

## 2. 小说框架模型 —— 四层 DocKind

结构规范是**数据**（`src/framework/doc_spec.ts`：core/world/characters/outline 各该有哪些小节 + 成稿/补缺做法）；**懒建**——文件平时不存在，用户点名某层时 editor 用 `doc-spec` 拿形状、按其小节成稿落盘。文件一旦建立即内容与真相，之后 `read-doc` 为准。

| 层 | 文件 | 变化 | 影响范围 | 注入方式 |
|---|---|---|---|---|
| 核心层 | `core.md` | 极少变 | 一改牵全身 | **常驻**：每轮 `<nvl-state>` 全文 |
| 世界层 | `world.md` | 慢变、追加 | 世界相关切片 | 按需 read/search |
| 人物层 | `characters.md` | 慢变、追加（每角色一格） | 本章角色切片 | 按需 read/search |
| 情节层 | `outline.md` | 快变、最局部 | 当前卷/章 | 按需 read；细纲切片进 writer task prompt |

### 2.1 各层目标结构（doc_spec 数据定义；`（待定：…）` = 未填格）

<details>
<summary>core.md（核心层）</summary>

```markdown
# core · 核心层（卖点与设定内核）
> 全书最稳定的一层，所有层都长在它上面。改 core 常牵动其他层。

## 一句话卖点
## 题材 · 频道
## 主角
### 想要什么
### 最怕什么
### 为什么是他
## 金手指 / 真实约束
### 边界与代价
## 爽感承诺
## 目标读者
```
</details>

<details>
<summary>world.md（世界层）</summary>

```markdown
# world · 世界层（舞台与秩序）
## 世界观一句话
## 空间与舞台
## 规则与秩序
## 势力与人物群像
## 历史痕迹与秘密
## 术语表
```
</details>

<details>
<summary>characters.md（人物层）</summary>

```markdown
# characters · 人物层
## 角色总表

<!-- 加角色：用 append-doc 追加以下结构，把 〈〉 换成实际名字
## 角色：〈名字〉
### 一句话定位
### 想要 · 最怕
### 说话方式   ← 口头禅/拐不拐弯/给一句"声音范例"原文（不是性格形容词）
### 习惯动作
### 在故事中的功能
-->
```
</details>

<details>
<summary>outline.md（情节层）</summary>

```markdown
# outline · 情节层
## 一句话主线
## 开篇钩子（前 3 章）
## 分卷方向
## 结局方向
## 伏笔与回收登记
```
</details>

> 角色卡字段呼应 `临时思考.md` §5：**说话方式 / 习惯动作** 比"冷静嘴硬"这类性格形容词更能立住人——卡片要求给"声音范例"原文。

---

## 3. 设计对话流程

```mermaid
flowchart TD
    A[用户进项目 / 说想写什么] --> B{editor: designActive?<br/>outline 还是骨架}
    B -- 否 --> Z[主编职责：按需读 docs 切片<br/>准备写作/回答案]
    B -- 是 --> C[每轮注入: persona + 设计段协议 + nvl-state 锚点]
    C --> D[挑一层推进，依赖序 core→world/characters→outline]
    D --> E[层内循环：问→辩→定→记]
    E --> F{这一格能一句话讲清<br/>且用户认可?}
    F -- 否 --> E
    F -- 是 --> G[edit/append 写进对应 docs → confirm 拍板]
    G --> H[update 后 read 当前版保持一致]
    H --> I{这层还有关键格未定?}
    I -- 是 --> E
    I -- 否 --> J[向用户报一句：当前已定 + 还待定]
    J --> K{用户冒出新点子 / 推翻旧设定?}
    K -- 是 --> L[判定归哪层; 牵动别处用 search-docs 查影响面;<br/>小改自己 edit, 大级联 task planner]
    L --> H
    K -- 否 --> M{用户说可以开始写了?<br/>(outline 有了分卷/细纲方向)}
    M -- 否 --> D
    M -- 是 --> Z
```

流程要点：

1. **先 core 后 outline**。core 决定一切；outline 最后且最易变，不在 core 立住前深聊。
2. **聊定才写**：没写进 docs 的不算已定。每层循环"问→辩→定→记"，每次 `edit-doc`/`append-doc` 只动一格、confirm 拍板。
3. **层告一段落报状态**：给用户"当前已定 + 还待定"，避免原地打转（可参考 `<nvl-state>` 索引）。
4. **新点子即时归类**：当场判断归哪层，聊定落盘；推翻旧设定先用 `search-docs` 看影响面，小改自己 `edit-doc`，牵动多层的结构级改动派 planner（`task(planner)`，让它 read 全量 docs 产出一致的新版，editor 复核给用户）。
5. **写作段由用户点单进入**：outline 有了方向后，editor 回到编排职责，设计协议自然退场。

---

## 4. 框架维护工具规约（可强制进工具，residual 才留 persona）

原则（06 §6.6）：**能靠结构/工具强制的不写 prompt**。

- **寻址**：小节 = 文档里以 `##`+ 开头的标题。一格（如 `## 主角`）覆盖到下一个同级/更高标题前；`###` 子格可单独寻址。`src/framework/markdown.ts` 提供 getSection/replaceSection/removeSection/appendBlock/listHeadings。
- **confirm**：`edit-doc`/`remove-doc-section`/`write-doc` 在 execute 内做（给旧→新摘要 / 引用命中），拒绝返回文案不落盘。
- **删前查引用**：`remove-doc-section` 收到 `term`（实体名）→ 内置 `search-docs(term)`，命中列进 confirm 摘要——**强制点**，模型想跳也跳不过。
- **锚点不用维护**：`<nvl-state>` 是组装时**派生**的（core 全文 + 写作进度 + 文档索引），永不过期，无写后刷新钩子。

各工具的执行语义与返回见 `src/tool/（按领域模块：doc_tools / character_tools / framework_tools / core_tools（工具 id 用 kebab））`。

---

## 5. 锚点与上下文组装

editor（可见 primary）每次请求的 system = `env + persona + [设计段协议] + <nvl-state> + AGENTS.md + skill 目录`（`src/context/assemble.ts` / `src/session/session.ts`）：

```markdown
<nvl-state>
作品：书名｜题材
── 核心层 docs/core.md（最高优先依据，全文常驻）──
<core.md 全文>
── 写作进度 ──
已落章 N 篇 / plan 文件名…
── 文档索引 ──
core.md:
  - 一句话卖点 …
  - 主角 …
…
</nvl-state>
```

- **core 全文常驻**：core 小、最稳、一切依赖它 → 放锚点；world/characters/outline 全文仍按需 read-doc（它们会长大，不能每轮全量）。
- **subagent 不注入锚点**（省 token）：planner/writer 的上下文由 task prompt 带切片 + 自己 read-doc 补齐。

---

## 6. 跑通示例：从"一个念头"到框架（对照真实工具）

> 前置：`talemate novel create "荒岛"` 进入主编会话（docs 为空，懒建）。进入先看到四层现状卡片 + 提示；以下示例是"用户点名完善核心设定"后 editor 的成稿流程（先吸收自由描述 → 按 doc-spec 小节成稿 → 确认落盘 → 只补缺）。

**用户**：想写个荒岛求生的故事，一个男人和一个空姐流落荒岛。

`[editor: 每轮注入 persona + <nvl-state> 锚点。用户说『完善核心设定』→ editor 调 doc-spec(core) 拿结构，按小节把用户的话整理成稿]`

**editor**（走依赖序 core）:好，先别急着定情节，把"核"聊清楚。先问：你脑子里最先浮起的画面是紧张求生，还是两个人之间的暧昧？

**用户**：紧张求生为主，感情是暗线。

**editor**:那卖点大概是"两个人、一座岛、活下去"。我落进 core：
```
# 一句话卖点  ← edit-doc(core.md, "一句话卖点", "空难后，他和她被困荒岛，没有系统没有外挂，只有脑子与自然你死我活。")
```
⚠️ **需要确认**：改写 docs/core.md › 一句话卖点（旧 8 字 → 新 42 字；其余小节不变） → 用户 y

**editor**:题材/频道和主角这格要你拍板：① 偏男频还是双频？② 男主"想要/最怕"？我的默认：双频；男主想要"活着回去"，最怕……给个软肋——习惯性把责任扛在自己身上？

**用户**：就按你说的。

**editor**（继续 core）：
```
# edit-doc(core.md, "题材 · 频道", "双频｜求生向，感情为暗线")
# append-doc(core.md, "## 目标读者\n（待定：先留）")   ← 例子：追加一格（非破坏不需 confirm）
# edit-doc(core.md, "主角", "沈越——习惯性扛责任的普通人。\n\n### 想要什么\n活着回去。\n\n### 最怕什么\n把同行的人害死。")
```
……core 几格填齐、用户认可后，editor 转 world：

**editor**（world）：定一条规则再展开：这岛是**真实荒岛**还是有超自然？决定金手指那格。

**用户**：真实，不要系统不要异能。

**editor**:
```
# edit-doc(core.md, "金手指 / 真实约束", "无超自然。靠知识/体力/协作求生。\n\n### 边界与代价\n（无金手指，越界=违背本书基调）")
# append-doc(world.md, "## 历史痕迹与秘密\n（待定：岛上曾来过一批人，没走成——坑先埋着）")
```

**editor**（characters，卡必须带"说话方式"）:空姐先立卡。除了性格标签，我要能实操的三样：她**怎么说话**（口头禅/拐不拐弯）、**习惯动作**、**最怕什么**。

**用户**：她嘴硬，担心人却说"你死了我可不会埋你"。

**editor**:
```
# append-doc(characters.md, "## 角色：林晚\n\n### 一句话定位\n空姐，与沈越困同一座岛。\n\n### 想要 · 最怕\n想要体面地活着回去；最怕成为拖累。\n\n### 说话方式\n嘴硬心软，关心总是反着说；口头禅式原话：\"你死了我可不会埋你\"。\n\n### 习惯动作\n紧张时数身边的东西够不够用。\n\n### 在故事中的功能\n沈越的对照与软肋，感情暗线。")
```
……

**editor**（outline 前的检查点）:core/world/characters 有底了。现在该把材料综合成整本结构——这活要读全量 docs，我派 planner，它自己读，不占我们的对话。

```
# task(planner, { prompt: "综合 core/world/characters（自己 read-doc），按 outline 骨架产出：一句话主线 + 前3章钩子 + 分卷方向。不写正文。" })
```
**planner**（回传 `<task_result>` 一段主线 + 前3章钩子 + 分卷草案）→ editor 展示给用户 → 逐项拍板后 `edit-doc(outline.md, …)` 落盘 → `designActive` 变 false，设计协议退场，项目进入写作段就绪。

---

## 7. 边界与后续（本轮未做）

- **写作流 plan-gate**：writer 对某章的执行门禁于"已有用户批准过的 plan_ch"，是 opencode plan-mode 精神在 talemate 的落点（06 §6.2），属写作流里程碑。
- **genre skill 化**：悬疑/男频等题材的"该问什么/骨架变体"做成 skill（用户可增删），核心四层骨架保持通用。
- **writer 落盘 vs editor 拍板**（05 §5.4）选型。
- **长篇状态层**（伏笔跨章/连续性日志）P2。

## 8. 实现索引（2026-09-05 已落地）

- 结构规范与懒建：`src/framework/doc_spec.ts`（按需取规范）· `src/storage/project.ts`（createProject 不播种）· `doc-spec`/`add-character` 工具
- 小节寻址/手术：`src/framework/markdown.ts`
- 引用检查：`src/framework/search.ts`
- 锚点派生 + 设计段判定：`src/framework/anchor.ts`
- 主编 persona + 设计段协议 + hidden summarizer：`src/agent/registry.ts`
- 上下文组装（锚点/协议注入）：`src/context/assemble.ts` · `src/session/session.ts`
- 框架工具集：`src/tool/（按领域模块：doc_tools / character_tools / framework_tools / core_tools（工具 id 用 kebab））` · task 动态目录：`src/tool/registry.ts`
- compaction agent 化：`src/session/compaction.ts`
- 验证：`bun test` · `bun run smoke` · `bun run typecheck`
