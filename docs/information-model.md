# 信息模型：对象、真源与载体

> **职责**：回答"这本书有哪些信息对象、每个对象的真源在哪、哪些只是缓存/投影、谁写谁审、半衰期多长、怎么寻址、冲突以谁为准"。
> **读者**：要改 `src/storage/`、`src/framework/`、`src/session/`、`src/context/` 或设计新文档种类的人；以及要判断"某次写偏是模型不行，还是信息本身没有载体"的人。
> **对齐代码**：2026-11-24 · 标【现状】的载体已按当前代码核对；标【提议】的是本文的设计，尚未落地。本文只定对象、真源、写者与寻址；创作文档的形状不在本文范围。
> **相邻**：`perception.md`（每一步怎么选材料）· `compaction.md`（对话怎么折叠）· `state.md`（状态层的形状）· `assets.md` / `characters.md` / `outline.md`（现有的四层与字段规范）

**一句话**：先定对象，再选载体；一个对象只有一个真源。

---

## 1. 判据

### 1.1 对象 ≠ 载体

- **对象**：这本书必须保持或决定的东西——世界规则、谁此刻知道什么、作者否过什么、读者期待什么。
- **载体**：存放它的文件、账本、事件、计算。`design/wiki/world.md`、`state/characters/`、`chapters/` 都是载体。

同一个对象可以换载体；同一个载体可以装多个对象。**从载体倒推，只会得到“感知＝读 wiki”；从对象出发，才会问“这一场需要知道哪条规则，最便宜的来源是哪里”。**

### 1.2 每个对象回答四件事

| 问题 | 为什么必须回答 |
|---|---|
| **真源还是缓存/投影？** | 缓存会脱节；脱节的缓存比没有更糟 |
| **谁写、谁审？** | 模型的推断不能冒充 canon；用户拍板才能落盘 |
| **半衰期多长？** | 决定常驻、按需、折叠、归档 |
| **怎么寻址、怎么取？** | 决定 `read` / `grep` / 感知能不能精确取到 |

### 1.3 结构只在“有机器消费者”时存在

一个字段/格只有满足下面之一才值得固定：

1. **门禁**：缺了不能批准或不能写正文；
2. **机器查找/校验**：系统要按它过滤、注入、对账；
3. **确定性寻址**：`read section`、`edit` 锚点、rev 对账。

没有机器消费者的“格”是模板惯性，应该删。创作文档里不要为了“完整”而固定字段；机器要的数据放到独立账本或元数据里。

---

## 2. 对象表

状态列：**truth** = 真源；**claim** = 当前主张（可被用户改）；**cache** = 可重建缓存；**derived** = 纯计算；**ephemeral** = 会话内临时。

| 对象 | 回答什么 | 真源 | 缓存/派生 | 写者 | 审者 | 半衰期 | 寻址 | 注入建议 |
|---|---|---|---|---|---|---|---|---|
| **世界规则/事实** | 世界是什么样、术语/地名 | `design/brief.md`、`design/wiki/*`、卷/序列纲 | 目录索引行 | 用户 + mate（提案） | 用户拍板 | 长 | `path#section@rev` | 按需 `read`（无文档常驻）；`glob`/`grep` 找路径 |
| **章节事件** | 发生过什么 | `chapters/chapter_ch<N>_v<M>.md` | `state/progress.md`、场景索引、章摘要 | mate（write） | 用户看 diff | 永久 | 章号/版本、行范围、场景索引 | P2/P3；按场景取 |
| **角色基线** | 他是谁、要什么/怕什么/绝不做什麼、声音 | `design/characters/<名>.md` | 目录索引一行 | 用户 + mate（提案） | 用户拍板 | 长 | `path`，整篇 | P0/P1；整篇或按需取 |
| **角色此刻** | 此刻处境、要什么 | `state/characters/<名>.md` | 无 | mate 章末回写 | 用户看 diff | 每章 | `path#section` | P0/P1；按在场人物取 |
| **知识边界** | 谁知道/不知道/误以为什么 | **`state/knowledge.md`（提议）** | 无 | mate 回写 | 用户看 diff | 每章 | 命题 id | P0/P1；按场景命题取 |
| **关系** | 谁欠谁、此刻盟友/反目、怎么看对方 | **`state/relations.md`（提议）** | 无 | mate 回写 | 用户看 diff | 每章 | 人物对 | P1；按在场人物取 |
| **承诺** | 埋在哪、何时还、现在什么状态 | `state/foreshadowing.md` | 未回收过滤（derived） | mate 回写 | 用户看 diff | 每章 | 条目/状态 | P0/P1；只取未回收 |
| **叙事位置** | 写到哪一卷/序列/哪一章 | **chapters（truth）** | `state/progress.md`（cache） | mate 回写 | 用户看 diff | 7 章窗口 | 章号 | P1；窗口 |
| **作者意图** | 要什么、否过什么、为什么 | **会话事件**（`proposal/decision` + `answersTo`） | 项目决定索引（derived） | harness | 无（用户原话） | 永久 | proposal + 时间/章 | P1/P2；按相关度截取 |
| **声音** | 怎么写、什么声音、禁写什么 | 文风卡 + **`state/craft.md`（提议）** | 声音简报（derived） | 用户选卡；mate 记校正 | 用户看 diff | 长 | skill + `path#section` | P1；融合简报 |
| **读者状态** | 读者知道/不知道/期待/被欠什么 | **`state/reader.md`（提议，claim）** | 从正文推断（仅作 supporting） | mate 回写 | 用户看 diff | 每章 | 章号 | P1；最近窗口 |
| **规划** | 这一章执行什么 | `.talemate/plans/ch_<N>.md` | pinned `<plan>` | mate + 用户批准 | 用户拍板 | 到正文落盘 | 章号 + hash | P0；整篇注入 |
| **外部事实** | 不能编的事实 | `.talemate/research/<题>.md` | `recall` 目录 | researcher | 无 | 长 | 题目 | P2/P3；结论 + 出处 |
| **对话** | 我们聊到哪、拍过什么板 | 会话事件 | `context/compaction` 记录 | harness | 无 | 会话 | `seq` | 最近 turn 原文；更早折叠 |
| **任务态** | 当前模式、待批、未答 | 会话内存 + 事件 | 无 | harness | 用户 | 会话内 | 内存键 / seq | P0；原文 |

### 2.1 关键判断

- **`state/progress.md` 不是真源，是缓存。** 章节才是“发生过什么”的真源。progress 是最近 7 章的窗口；章数与节数不一致时，以 chapters 为准并要求回写。
- **知识不能按角色各存一份。** “账册在二房手里”是一个命题；A 知道、B 不知道，是命题 × 人。按角色存会导致 N 份副本和跨角色矛盾。提议 `state/knowledge.md` 作为命题级真源。
- **关系需要单点。** “谁欠谁、此刻盟友还是反目”如果只在正文/大纲里，感知无法稳定取；提议 `state/relations.md`，按人物对记录。第一版可以先不做，但这是已知缺口。
- **作者意图不落创作文件。** 决定可以由事件算出来；落成 `state/decisions.md` 就是第二份真源。索引是缓存，事件是真源。
- **读者状态是 claim，不是 canon。** 它是对读者此刻知道的判断，允许用户改；不能拿它去覆盖正文。
- **规划是引擎工作区，不是作品。** `.talemate/plans` 由 harness 注入，工具读不到；它是执行合同，不是要进版本控制的作品文档。

---

## 3. 真源 vs 缓存

| 缓存/派生 | 真源 | 重建规则 | 冲突时 |
|---|---|---|---|
| `state/progress.md` | chapters | 章节目录 + 每章末节；窗口 7 章 | chapters 赢 |
| 场景索引 | chapters | 从正文场景边界/行范围派生 | chapters 赢 |
| 章摘要 / 目录索引行 | chapters / design docs | 首行/首标题/首段现算 | 原文赢 |
| 未回收承诺 | `state/foreshadowing.md` | 过滤终态 | 账本赢 |
| 项目决定索引 | 会话事件 | 扫 `proposal/decision` + `answersTo`，按 mtime/size 缓存 | 事件赢 |
| 声音简报 | 文风卡 + `state/craft.md` + 最新章节样例 | 融合，带来源 rev | 校正卡赢 |
| 读者推断 | `state/reader.md` | 只在缺失时作 supporting，标 `inferred` | 文件赢 |
| 正文/场景的“现在到哪” | chapters | 最大章号/版本 | chapters 赢 |

**只存一份真源**：缓存可以多份，但必须可重建、可删、可对账；不能手改缓存并把它当 truth。

---

## 4. 所有权与写路径

| 对象 | 谁写 | 走哪条路 | 谁批准 |
|---|---|---|---|
| 世界规则/角色基线 | mate + 用户 | `write` / `edit`（看 diff） | 用户点头 |
| 章节正文 | mate | `write` / `edit`（diff） | 用户看 diff |
| 角色此刻/承诺/读者/工艺/知识/关系 | mate | `write` / `edit`（diff） | 用户看 diff |
| 规划 | mate | `propose-plan` → 落 `.talemate/plans` | 用户拍板 |
| 外部事实 | researcher | `remember` | 无（研究员自己的账） |
| 决定索引 | harness | 计算，不落文件 | 无 |
| 场景索引 | harness | 计算/提取，缓存 | 无 |
| 对话/任务态 | harness | 事件/内存 | 无 |

三条纪律：

1. **canon 只能走 diff 可见的写路径。** 模型不能自己声称“用户同意了”。
2. **状态回写是 diff，不是提案。** 它每章都变，走 `write` / `edit` 就够。
3. **机器索引不手改。** 决定索引、场景索引、`progress` 都是投影/缓存；要改就改真源。

---

## 5. 寻址

全仓只有一种路径口径：**项目相对路径**。

| 寻址方式 | 适用 | 例子 |
|---|---|---|
| `path` | 一切文档 | `design/characters/林晚.md` |
| `path#section` | 有标题的文档 | `design/wiki/world.md#夜宴` |
| `path@rev` | 新鲜度/重读 | `state/foreshadowing.md@a1b2c3` |
| 章号/版本 | 章节 | `chapter_ch13_v2` |
| 行范围 | 正文/无标题文档 | `chapters/chapter_ch13_v2.md#L80-L140` |
| 场景索引 | 正文按场景取 | `ch13/scene2`（派生） |
| 命题 id | 知识边界 | `ledger-in-erfang` |
| 人物对 | 关系 | `沈越↔林晚` |
| `seq` / 时间 | 会话事件 | `proposal/decision@seq` |
| 题目 | 考据 | `明代税制` |

没有条目级 ID，没有第二套层名。**标题不是必须的**；没有标题时用整篇、行范围或场景索引。

---

## 6. 冲突规则

| 冲突 | 以谁为准 | 处理 |
|---|---|---|
| 世界规则 vs 正文 | 规则文档优先 | 正文不一致 → 标记 `needs-adjudication`，不静默改设定 |
| 发生过什么：chapters vs progress/大纲 | chapters | progress 落后 → 标 cache stale，要求回写 |
| 角色此刻：state vs 卡 | state/characters | 卡是基线，“现在”以 state 为准 |
| 谁知道什么：knowledge vs 角色状态/正文 | `state/knowledge` | 角色状态不重述知识；正文推断只作 supporting |
| 关系：relations vs 正文 | `state/relations` | 正文是发生过的证据，关系账是“现在” |
| 承诺：卷纲（计划）vs foreshadowing（实际） | 实际状态以 foreshadowing 为准 | 卷纲只写旧债/新债/禁揭，不写“已回收” |
| 作者意图：事件 vs craft vs 推断 | 事件（用户原话） | craft 是提炼；推断永不 authoritative |
| 读者状态：reader vs 正文推断 | reader | 推断标 `inferred`，不覆盖文件 |
| 声音：craft 校正 vs 文风卡 | craft 校正 | 校正 > 卡 > 样例 |
| 外部事实：考据本 vs 网页 vs 模型记忆 | 考据本 > 网页 > 模型记忆 | 模型记忆永不 authoritative |

语义矛盾（“这条规则和这段正文打架”）不在信息模型里自动判；它留给反思层。信息模型只负责**结构性冲突**（版本/章数/hash/同一键值不一致）。

---

## 7. 新鲜度

- 文件来源返回 `rev = hashText(content).slice(0, 8)`；
- 会话来源返回 `seq` 或 `at`；
- 章节来源返回 `(chapter, version)`；
- 规划来源返回 `hash`；
- 缓存的 cacheKey 包含所有来源 rev/seq；变了就重建；
- `required`/P0 的过期答案不能继续用：重取、降级或报错；
- 缓存（progress、场景索引、决定索引）允许落后，但必须能被检测出来。

---

## 8. 感知如何消费

- 感知不拥有对象；它按六条信号线（世界/人物/叙事/读者/作者/声音）+ 材料（对话/外部事实/任务态）建候选。
- 每个候选带：真源/缓存、authority、freshness、cost、size、expandable。
- 分诊决定 P0–P3 与位置；缓存与真源冲突时，真源进 P0/P1，缓存降级或丢弃。
- `state/progress`、`state/reader`、`state/craft`、决定索引是**memory 的候选**，不是感知的字段。

详见 `perception.md`。

---

## 9. 折叠如何保留

折叠只保留磁盘上的对话意图，不承载 canon（`compaction.md` 的 D1）。信息模型给 pinned 提供文件来源：

- `<project>`：`state/progress`（缓存，按真源对账）；
- `<promises>`：`state/foreshadowing` 未回收；
- `<decisions>`：会话事件；
- `<plan>`：已批准规划坐标；
- `<reader>`：`state/reader` 最近窗口（提议）；
- `<craft>`：`state/craft` 最近校正（提议）。

摘要仍不写世界规则、人物事实、章节事件、承诺状态。

---

## 10. 要删除/降级的东西

| 现在 | 处理 |
|---|---|
| `state/progress.md` 被当源 | 降级为 cache；chapters 是 truth |
| 知识按角色各存一份 | 迁到命题级 `state/knowledge`（提议） |
| 关系只活在正文/大纲 | 视需要加 `state/relations`（提议） |
| `.talemate/plans` 覆盖写 | 当前执行保留；历史/审计按需加版本（后续） |
| `world.md` 全文常驻 | 已删除：整份文档都不常驻，一律按需 `read`（感知决策，不是信息真源） |

保留：路径口径、唯一写路径、CAS、原子写、权限、章节版本、事件日志。

---

## 11. 分阶段落地

### 阶段 0：定对象，降级缓存

- 本文对象表作为唯一清单；
- `progress` 明确为 cache，加章数对账；
- 决定索引（计算，不落文件）；
- reader/craft 的载体先定（`state/reader.md`、`state/craft.md`）。

### 阶段 1：机器数据独立

- `state/knowledge.md`（命题 × 谁知道）；
- `state/relations.md`（可选）；
- 场景索引（派生/缓存）；
- 别名索引（grep 用）；
- 承诺状态机读化（账本内，不是卷纲）。

### 阶段 2：对账与评测

- progress vs chapters 对账；
- 承诺计划 vs 实际状态对账；
- 知识账 vs 正文推断的冲突报告；
- 感知 trace 与命中率。

---

## 12. 验收标准

1. 每个对象只有一个真源；缓存可重建、可检测落后。
2. 章节是“发生过什么”的唯一真源；progress 冲突时以 chapters 为准。
3. 知识是命题级单点，不按角色重复。
4. 作者意图来自事件，不落第二份文件。
5. 创作文档没有“缺一格即拒”；提案审阅是整篇 + diff。
6. 机器要用的数据（章型、承诺状态、知识、场景）在独立账本/元数据里。
7. 每个来源有 rev/seq/版本，能判过期。
8. 冲突有明确优先级；语义矛盾留给反思层。
9. 感知只消费对象，不拥有对象；memory 与 perception 边界清楚。
10. 全部用例离线通过。

## 附录：开放问题

1. 关系账第一版是否必要？如果场景规划频繁问“他们现在什么关系”，就需要；否则先不进。
2. 读者账由 mate 写是否可靠？需要用户 diff 可见，并允许 `read` 校正。
3. 场景索引是派生还是小提取步骤？正文没有场景边界时，可能需要一次轻量提取；它只能是缓存。
4. 规划历史要不要版本化？当前执行不需要；改稿/审计可能需要。
5. 知识命题的粒度：一条秘密一个命题，还是按“谁知道这件事”拆？先一命题，人物状态里只写“知道/不知道/误以为”。