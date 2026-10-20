# 西方结构工艺的「幕—序列—场景」层级与长篇小说「卷」的映射

> 研究范围：Paul Gulino / Frank Daniel 的八序列法、Shawn Coyne 的 Story Grid、Blake Snyder 与 Jessica Brody 的 Save the Cat、John Truby 的 22 步、Robert McKee 的场景/价值理论、Brandon Sanderson 的 promise-progress-payoff 与 try-fail cycle，以及系列小说如何分卷的实践资料。
>
> 结论用途：给 talemate 的卷纲/序列纲设计提供两类东西——可以写成检查项的**结构约束**，以及只能当诊断问题的**创作启发**。
>
> 资料性质：以一手著作的观点为主，网络资料用于定位原文、交叉核对和补充案例。页码、百分比、场景数都随版本与篇幅变化；下文凡给出数字，均视为行业惯例或某本书的示例，不是故事成立的充要条件。

---

## 0. 结论先行

1. **幕（act）是戏剧单位，卷（volume）是出版/阅读单位。** 二者不是同义词。一个卷可以包含一个完整的三幕故事，也可以只包含一个大幕的一部分；反过来，一个幕也可以横跨两三个卷。把「三卷」直接映射成「三幕」，是最常见、也最没有根据的模板化错误。
2. **跨框架最稳的约束不是节拍数量，而是每一级都要有「价值转变 + 不可逆收束 + 因果链」。** Gulino 的序列、Story Grid 的 scene/sequence、McKee 的 scene、Sanderson 的 progress，说的都是同一件事：这一级结束时，世界或人物不能回到起点。
3. **对长篇小说，规划的主单位应是「序列」，不是「章」。** 章是生产/阅读切分，一个章可以包含多个场景，也可以只包含一个场景的一半；序列才是有独立戏剧问题、能单独成立的最小规划单元。talemate 现有的「卷 → 序列 → 章」方向是对的。
4. **最小卷纲只需要回答六个问题：** 这一卷的戏剧问题是什么；主角要什么、谁挡着；卷首状态是什么；卷末状态在哪个价值上发生了不可逆变化；卷末的危机选择是什么；这一卷由哪几个序列组成、每个序列的不可逆转折是什么。其余字段按题材和项目复杂度启用。
5. **比例、节拍表、序列数量只能做警告，不能做硬失败。** 一部 100 万字的书不可能靠「每卷 8 个序列、每卷 15 个 beat、每卷都在 25/50/75 处转折」写好；把这些硬化成 AI 检查项，只会生产对称、可预测、充满填充物的卷。

---

## 1. 层级表：每一级必须回答什么，什么值得写进规划

这张表是后面所有框架的「收敛版」。它不规定每一级必须有几拍，只规定每一级必须能回答的问题。

| 层级 | 这一级必须回答的问题 | 可写进规划的数据 | 约束强度 |
|---|---|---|---|
| **系列 / 全书（global story）** | 整本书的戏剧问题是什么？结局带来什么绝对且不可逆的变化？主题/控制性思想是什么？哪些 promise 必须在全书层面兑现？ | `global_question`、`controlling_idea`（可选）、`global_promises[]`、`final_state`、`series_arc_position` | 主题类是软约束；promise 闭合是硬约束 |
| **幕（act）** | 这一阶段主角的策略/世界观发生了什么重大反转？哪个价值从正到负或从负到正？下一幕为什么必须换一种做法？ | `act_question`、`entry_value`、`exit_value`、`major_reversal`、`strategy_before/after`、`sequences[]` | 反转与价值变化可判定；反转是否「重大」需人判 |
| **卷（volume）** | 这一卷自己讲完了一个什么故事？它回答了哪个局部问题？卷末把主角/世界留在什么新状态？它为下一卷留下了什么新问题？ | `volume_question`、`protagonist_goal`、`opposition`、`entry_state`、`exit_state`、`value_before/after`、`sequences[]`、`series_position` | 局部闭合与状态变化可判定；是否「值得单独成卷」需人判 |
| **序列（sequence）** | 这一段自己的戏剧问题是什么？谁在这一段里想要什么？结束时发生了什么不可逆的变化？这个变化如何制造下一段的问题？ | `sequence_question`、`sequence_protagonist`、`entry_state`、`exit_state`、`irreversible_turn`、`turn_type`（action/revelation）、`cost` | 问题、状态差、不可逆性可判定；转折是否可信需人判 |
| **场景（scene）** | 哪个价值处在危险中？场景开始时它的电荷是什么，结束时是什么？这个场景对 plot / character / promise 做了什么？ | `pov`、`value_at_stake`、`value_before/after`、`turning_point`、`plot_change`、`character_change`、`promise_refs[]` | 价值变化可判定；变化是否「有意义」需人判 |
| **节拍（beat）** | 这一拍谁做了什么、对方如何反应？能量/信息/关系发生了什么变化？ | `action`、`reaction`、`subtext`、`value_shift` | 仅作写作诊断，不建议进卷纲 |
| **章（chapter）** | 这一章给读者的进入点是什么？结尾的钩子/余味是什么？它包含哪些场景？ | `pov`、`scenes[]`、`word_count`、`entry_hook`、`exit_hook` | 生产单位；不要求独立戏剧完整性 |

**读法：**

- 「硬约束」不是「自动判对错」，而是「可以用结构化数据检查字段是否存在、前后是否不等、顺序是否成立」。它只能抓**形式缺口**，抓不到「这个转折是否可信」。
- 「卷」这一行是 talemate 最该补的：现有卷纲有「本卷在全局的位置」「本卷目标与阻力」「本卷的情绪曲线」「卷末状态」「本卷的序列」五格，但缺少显式的 `volume_question`、`entry_state` 和 `crisis_choice`。这三项恰好是「这一卷是不是一个完整故事」的判据。
- 「章」不是戏剧单位。不要用章数反推序列数，也不要把「一章一个场景」当成结构。

---

## 2. 术语警告：四个「sequence」和两种「beat」

这些框架最容易在工程化时出错的地方，是**同名不同物**。如果 schema 里只写一个 `sequence` 字段，却同时引用 Gulino 和 McKee，规划者会得到互相矛盾的长度预期。

| 术语 | 出处 | 实际含义 | 粒度 |
|---|---|---|---|
| **Sequence（Gulino / Frank Daniel）** | *Screenwriting: The Sequence Approach* | 一部电影被切成约 8 个「小电影」，每个约 10–15 分钟/页，有自己的主角、戏剧问题、上升冲突和部分收束 | 很粗；一部电影 8 个 |
| **Sequence（McKee）** | *Story* | 「一系列场景，通常 2–5 个，以一个比之前任何场景都更强的冲击收尾」 | 较细；一部电影有很多个 |
| **Sequence（Story Grid）** | Shawn Coyne | 多个场景组成，建立**全局赌注的不可逆变化**；它本身也要有五个 commandments | 介于 scene 和 act 之间 |
| **Sequence（日常用法）** | 编剧/小说工艺通俗文章 | 常被当作「一组场景」的同义词，没有严格定义 | 不确定 |
| **Beat（McKee / Story Grid）** | *Story* / Story Grid | 最小的行动—反应交换，或一次能量变化 | 极细；场景内部 |
| **Beat（Save the Cat）** | Blake Snyder | 一个重大故事事件/节拍点，如 Catalyst、Midpoint、All Is Lost | 很粗；全书 15 个 |

**本文的约定：**

- 讲**卷以下的规划单位**时，用 Gulino/Story Grid 意义上的 sequence：一个有独立戏剧问题、以不可逆变化收束的场景群。
- 讲**场景内部**时，用 McKee 的 scene 与 beat：scene 让一个价值转向，beat 是场景内的行动—反应。
- 讲**全书节奏**时，才用 Save the Cat 的 15 个 beat；不要把它们下沉到每一卷。
- schema 字段应写明采用哪一家定义，不能只写 `sequence`。例如 `planning_unit: "gulino_sequence"` 或 `sequence_scope: "volume"`。

---

## 3. Gulino / Frank Daniel：八序列法

### 3.1 来源与基本主张

Paul Gulino 在 *Screenwriting: The Sequence Approach*（Continuum, 2004；第二版 Bloomsbury Academic, 2024）中整理了 Frank Daniel 在 USC/AFI 教授的八序列法。核心主张是一句话：**「一部大电影是由几部小电影组成的。」** 与其面对 120 页的庞然大物，不如把它切成八个约 10–15 页的「小电影」，每个都有自己的主角、戏剧问题、上升冲突和部分收束。[1][14]

### 3.2 八序列的划分与功能

八序列按 **2–4–2** 分配到三幕：第一幕 A–B，第二幕 C–F，第三幕 G–H。

| 序列 | 幕 | 常见功能 | 出口 |
|---|---|---|---|
| **A** | 第一幕 | 建立谁、什么、哪里、何时；日常世界被打破 | 激励事件（inciting incident） |
| **B** | 第一幕 | 主角尝试应对，反而制造更大的问题；确立主戏剧问题 | 第一幕结束，主角锁定目标/进入新世界 |
| **C** | 第二幕 | 第一次正面尝试解决主问题；通常制造更深、更大的问题 | 第一次尝试失败，代价上升 |
| **D** | 第二幕 | 被迫采取更极端的手段；接近中点 | **第一次高潮/First Culmination**：揭露或命运反转，让主角的路更难，同时让观众瞥见最终答案或其镜像 |
| **E** | 第二幕 | 承担第一次高潮的后果；副线（爱情、友情、师徒）浮出水面 | 副线压力上升，主线暂时受挫 |
| **F** | 第二幕 | 最坏的局面；正面处理核心冲突 | **第二次高潮/Second Culmination**：第二幕结束的低点/全盘皆输 |
| **G** | 第三幕 | 看似解决的方案被证明不成立；赌注再次上升 | 假结局/新的危机 |
| **H** | 第三幕 | 真正的收束；解决激励事件留下的问题；常与第一序列形成视觉/情境呼应 | 新平衡 |

这张表是**常见功能**的合成，不是 Gulino 对每部电影的机械规定。Gulino 分析的是 11 部电影（*Toy Story*、*North by Northwest*、*The Graduate*、*Fellowship of the Ring* 等），每部片的序列边界和功能都有差异。他也明确说，不是每部电影都必须正好八个序列；八序列是帮助写作的脚手架，不是验尸报告。[1][14]

### 3.3 每个序列的内部结构

一个序列不是「一段情节」，而是一个**迷你故事**：

```text
setup（建立这一段的日常/目标）
  → complication（阻力出现，且逐步升级）
    → crisis（被迫二选一，两个选项都有代价）
      → resolution（做出选择，产生部分收束）
        → 但收束同时打开一个新问题，把读者推进下一段
```

关键在最后一步：**resolution 必须是部分的**。它回答这一段的戏剧问题，但不能让整个世界回到原状；它要让下一段的问题从这一段的后果里长出来。否则序列之间就只是并列的 episode（段落），不是因果链。

### 3.4 长度比例

- 八序列 × 10–15 页 ≈ 80–120 页，对应约 110–120 页的标准长片。
- 三幕比例约为 **25% / 50% / 25%**。
- 在 120 页剧本里，每个序列约 15 页；在 100,000 词的小说里，若仍用 8 序列，每个约 12,500 词。
- 小说通常比电影需要更多序列，因为副线更多、视角更多、世界信息更多。不要为了凑 8 而把副线硬塞进主线序列。

### 3.5 适用与不适用

**适用：** 单一主戏剧问题、主线清晰、副线不过度膨胀的故事；动作、爱情、历史、惊悚尤其合适。

**不适用：** 多主角、多线并进、史诗奇幻、复杂悬疑。这不是说这些类型不能用，而是说它们往往需要 10–16 个序列，或者需要把「序列」按 POV/故事线分别规划。Plottr 的八序列模板也明确提醒：它最适合「相对直接、副线少」的故事。[14]

**对 talemate 的启示：** 八序列法最有价值的不是「8」这个数字，而是**每个序列都要有自己的戏剧问题和部分收束**。把这条写成序列纲的必填项，比规定每卷必须 8 段有用得多。

---

## 4. Story Grid：五级单位、价值转变与 obligatory scenes

### 4.1 单位层级

Shawn Coyne 的 Story Grid 把故事拆成嵌套单位：

```text
global story
  → subplots
    → acts
      → sequences
        → scenes
          → beats
```

各家的层级表略有出入（Coyne 的某些文章从 scene 开始讲），但核心定义是稳定的：

- **Beat（节拍）**：最小的故事单位，一次「微互动」，有输入、通常有输出，展示能量的变化。[9]
- **Scene（场景）**：一个可定义的价值转变；一个「working scene」至少包含一个 story event，即「由冲突引起的一个或多个角色的生活价值的主动变化」。[9][10]
- **Sequence（序列）**：多个场景组成，建立**全局赌注的不可逆变化**；角色在追求欲望对象的过程中做出选择，并逼近激励事件提出的全局问题。[9]
- **Act（幕）**：多个序列汇聚而成的更大单位；在长篇里通常对应 beginning hook / middle build / ending payoff 的一段。
- **Global story（全局故事）**：整部作品；acts 组成它的 beginning hook、middle build、ending payoff。

### 4.2 五个 commandments

Coyne 认为**每一个单位**——从 beat 到 global story——都要有同样的五件事：[7][8]

1. **Inciting incident（激励事件）**：打破平衡，启动这一单位。可以是 causal（角色行动导致）或 coincidental（偶然发生）。
2. **Progressive complications（渐进复杂化）**：阻力逐级升级；其中改变价值的那一下叫 **turning point progressive complication**。复杂化不能升级后又退回更轻的阻力。
3. **Crisis（危机）**：真正的两难，通常是 **best bad choice**（两个坏选项里选较好的）或 **irreconcilable goods**（两个善选项不可兼得）。
4. **Climax（高潮）**：角色实际做出选择/采取行动，是这一单位里最主动的一刻。
5. **Resolution（收束）**：高潮之后的新状态；它应该成为下一单位的问题或目标。

这条「每一级都要有五个 commandments」是 Story Grid 最有工程价值的部分：它把「这一章/这一段/这一卷有没有结构」变成了可逐级检查的清单。但它也有一个陷阱：**五个词都填上，不等于五个事件都成立**。Coyne 自己用的是「Russian dolls」隐喻，强调嵌套，而不是要求每层都长得一样。[7]

### 4.3 价值转变（value shift）

Story Grid 用「价值」来描述变化：

- 每个场景记录 **beginning value → ending value**，以及正/负极性。
- 价值标签要具体，例如「stable → panicked」「known → unknown」「afterthought → centerpiece」，不要只写「好 → 坏」。
- 一个场景的价值转变不一定要动到全局价值；它可以是局部价值，但必须和全局价值的推进有关。
- 多条故事线（global、subplot、character arc）各有自己的价值轨道；规划时应该分别追踪，而不是只追一条「主线」。

Coyne 的 spreadsheet 是这套方法最实用的产物：每行一个场景，列包括场景号、叙事装置、字数、story event、beginning value、ending value、极性、五个 commandments 中出现了哪些、兑现了哪些 obligatory scenes/conventions。[11] 这张表的价值在于**把「中段感觉不对」变成「第 17 场没有价值变化」**。

### 4.4 Obligatory scenes（类型义务场景）

Obligatory scenes 是**类型向读者承诺的、必须兑现的故事事件**，不是所有故事通用的清单。例如：[7]

- 爱情故事：恋人分手/关系破裂的场景。
- 惊悚：主角第一次正面遭遇反派；最终危机前的假胜利；全盘皆输的时刻。
- 成长故事：年轻主角从天真世界观走向艰难理解的关键场景。

Coyne 的关键补充是：**原创性来自对 obligatory scenes 的新鲜执行，而不是省略它们。** 读者可能说不清为什么，但少了这些场景会觉得被欺骗。Obligatory scenes 可以放在结构的任何位置——它可以是中段的 climax、开头的 inciting incident，或者结尾的一部分——重要的是它被兑现了。[7]

### 4.5 如何用它检查一部长篇

一个可操作的三遍法：

1. **自下而上做场景表。** 每场填 value before/after、turning point、五个 commandments、promise/obligatory 兑现。先找出「价值没变」的场；它们要么删，要么并，要么补一个真正的转折。
2. **把场景聚成序列。** 每个序列问：它的局部问题是什么？结束时全局赌注有没有发生不可逆变化？如果没有，这个序列只是场景堆。
3. **自上而下看三幕/全局。** 用五个 commandments 检查 beginning hook、middle build、ending payoff；再用 promise/payoff 账本检查每个承诺是否兑现。Coyne 建议先掌握 scene，再用同样的眼光看 sequence、act、major turning point 和 global story。[7]

数量参考：Coyne 以 80,000 词小说为例，偏好 1,500–2,000 词/场，约 40–60 场；三幕按 25/50/25 分，约 12–15 / 20–25 / 12–15 场。他还提出「15 个核心场景」：每个 act-level 单位各有 5 场，分别钉住五个 commandments。[7] 这些数字是**诊断用的基线**，不是写作合同；同一页里的算术本身也有不一致之处（40 场减去 15 场，文中却写成剩 33 场），说明它更适合当量级参考，而不是精确配额。

---

## 5. Save the Cat：15 beats 与小说改编

### 5.1 15 beats 与比例

Blake Snyder 的 *Save the Cat!* 为 110 页剧本给出 15 个 beat。Jessica Brody 的 *Save the Cat! Writes a Novel* 把它改成小说百分比，并把第二幕的进入点从 25% 提前到 20%、把 All Is Lost 放在 75%。[12][13]

| # | Beat | 剧本页（110 页） | 小说百分比（Brody） | 作用 |
|---|---|---|---|---|
| 1 | Opening Image | 1 | 0–1% | 开场意象，展示「之前」的世界 |
| 2 | Theme Stated | 5 | 5% | 别人（不是主角）点出主题/教训 |
| 3 | Set-Up | 1–10 | 1–10% | 日常世界，埋下后面要回收的元素 |
| 4 | Catalyst | 12 | 10% | 激励事件，打破平衡 |
| 5 | Debate | 12–25 | 10–20% | 主角犹豫：我能做吗？ |
| 6 | Break into Two | 25 | 20% | 主动选择进入第二幕的反常世界 |
| 7 | B Story | 30 | 22% | 副线（爱情/导师/伙伴），承载主题 |
| 8 | Fun and Games | 30–55 | 20–50% | 「前提的承诺」：预告片/海报式的桥段 |
| 9 | Midpoint | 55 | 50% | 假胜利或假失败；赌注上升；主角从被动转主动 |
| 10 | Bad Guys Close In | 55–75 | 50–75% | 外部压力收紧，内部怀疑回潮 |
| 11 | All Is Lost | 75 | 75% | 触底；「死亡的气息」 |
| 12 | Dark Night of the Soul | 75–85 | 75–80% | 在废墟里停留，转变前的最低点 |
| 13 | Break into Three | 85 | 80% | 顿悟；A 线与 B 线合并，解决方案浮现 |
| 14 | Finale | 85–110 | 80–99% | 执行新计划，击败对手，收束 |
| 15 | Final Image | 110 | 99–100% | 与 Opening Image 镜像/相反，证明世界变了 |

这些页码是 110 页剧本的示例，Snyder 自己也说不要为了精确页码而扭曲故事；Brody 的百分比同样是 guideposts，不是硬性配额。[12][13]

### 5.2 哪些 beat 可以在「卷」级复用，哪些只适用于全书

先把「beat」这个词换掉：在卷级，最好说「卷级转折」，避免和 Snyder 的 15 beats 混淆。可复用的不是编号，而是**功能**。

| Beat/功能 | 卷级可用？ | 条件 |
|---|---|---|
| Opening Image / Final Image | 可用，但应做「卷内镜像」 | 只在这卷确实有一个清晰的「之前/之后」状态时；不要每卷都用同一种意象 |
| Theme Stated | 谨慎 | 可以在卷内点出**这一卷**要学的局部主题；不要重复全书主题句，否则读者会觉得说教 |
| Catalyst / Inciting Incident | 必须 | 每卷都需要自己的激励事件；它不必是全书激励事件 |
| Debate | 可选 | 只在这卷有一个真实的「要不要进去」的犹豫时；否则会拖节奏 |
| Break into Two | 可用 | 这卷的主角做出不可逆的承诺/进入新领域时 |
| B Story | 条件可用 | 只在这卷有真正的副线，并且副线和主线有主题/因果交集时；不要为了 beat 表硬加恋爱线 |
| Fun and Games | 条件可用 | 只在这卷的核心承诺是「探索前提」时（如冒险、悬疑、奇幻设定）；否则会变成填充 |
| Midpoint | 可用 | 每卷可以有自己的中点反转；但不一定非要是「假胜利/假失败」，也可以是真相揭露、盟友背叛、目标改变 |
| Bad Guys Close In | 条件可用 | 只在这卷有独立的对手压力时；如果反派在全书层面才收紧，卷内不必复制 |
| All Is Lost | 可用，但不要每卷都「全盘皆输」 | 卷级可以是「局部方案失败」「关键关系破裂」「旧身份失效」；每卷都失去导师/同伴会让读者麻木 |
| Dark Night of the Soul | 可选 | 只在这卷需要一次真正的信念危机时；否则会变成重复的情绪低谷 |
| Break into Three | 可用 | 这卷的 A/B 线合并、主角获得新洞察时 |
| Finale | 必须 | 每卷都需要自己的高潮和收束；但不必是全书 Finale 的缩小版 |
| Final Image | 可选 | 只在这卷有明确的「新平衡」意象时 |

**全书级专属：**

- 全书的 Theme Stated：一本书只应该有一个真正的主题命题；卷级可以「局部测试」它，但不能每卷都重新陈述一遍。
- 全书的 B Story：如果 B Story 是跨卷的爱情/师徒/政治线，它的起点和终点属于全书，不属于某一卷。
- 全书的 Finale 和 Final Image：全书的最终对决和最终世界状态不能被卷级高潮替代。
- 全书的 Midpoint：全书的中点反转通常比任何卷级中点都大；如果每卷都有同等级的中点，全局中点会被稀释。

**结论：** Save the Cat 适合做**全书**的节奏检查，不适合做**每卷**的模板。卷级只需要保留「激励事件 → 中点反转 → 低点 → 高潮/收束」这几个功能；B Story、Fun and Games、Bad Guys Close In 是否出现，取决于这一卷的材料，不取决于 beat 表的完整性。

---

## 6. John Truby：22 步、moral argument、character web

### 6.1 22 步

Truby 的 *The Anatomy of Story* 用 22 步描述一个「有机故事」的生长顺序。不同版本的措辞略有差异，常见列表如下：[15][16]

| 幕 | # | 步骤 | 功能 |
|---|---|---|---|
| 第一幕 | 1 | Self-revelation, need, and desire | 先确定主角最终要领悟什么，再反推他的需要和欲望 |
| | 2 | Ghost and story world | 过去的创伤/幽灵，以及故事世界的规则 |
| | 3 | Weakness and need | 主角当前的弱点，以及他真正需要的东西 |
| | 4 | Inciting event | 打破平衡的事件 |
| | 5 | Desire | 主角明确想要的目标 |
| | 6 | Ally or allies | 盟友，让观众得以看到主角的真实情感 |
| | 7 | Opponent and/or mystery | 对手；对手通常想要同一个目标或完全相反的东西 |
| | 8 | Fake-ally opponent | 表面是盟友、实际是对手的人 |
| | 9 | First revelation and decision | 第一幕结束：主角获得第一次真相，并做出进入第二幕的决定 |
| 第二幕 | 10 | Plan | 主角为达成欲望制定的策略 |
| | 11 | Opponent's plan and main counterattack | 对手的计划与主要反击 |
| | 12 | Drive | 双方直接较量的升级 |
| | 13 | Attack by ally | 盟友的攻击/背叛，制造最大危机 |
| | 14 | Apparent defeat | 主角看似失败 |
| | 15 | Second revelation and decision | 主角意识到错误，带着新的理解进入第三幕 |
| | 16 | Audience revelation | 观众看到主角错在哪里，改变对主角欲望的态度 |
| | 17 | Third revelation and decision | 主角获得击败对手所需的最后洞察 |
| | 18 | Gate, gauntlet, visit to death | 最后的考验/献祭/濒死体验 |
| 第三幕 | 19 | Battle | 最终对决 |
| | 20 | Self-revelation | 主角真正理解自己的错误，以及如何修复 |
| | 21 | Moral decision | 主角按新的理解做出与开头不同的选择 |
| | 22 | New equilibrium | 新的平衡；主角已改变 |

Truby 自己强调，这是一套**推导顺序**，不是必须逐拍照抄的 beat sheet；故事可以少于或多于 22 步。他把最小结构概括为七个关键步骤：**weakness/need → desire → opponent → plan → battle → self-revelation → new equilibrium**。他也明确反对「简化的三幕结构」陈词滥调，但他的 22 步仍然有清晰的三段式推进。[15][16]

### 6.2 Moral argument（道德论证）

Truby 的 moral argument 不是一句「主题句」，而是**由角色选择构成的论证**：

- 故事的核心是一个道德问题；不同角色代表不同的价值体系/生活方式。
- 主角在结尾做出的 **moral decision**，是对这个问题的回答；这个选择必须和他开头会做的选择不同。
- 对手不是单纯的障碍，而是另一种价值体系的化身；对手通常想要和主角**同一个目标**，或者**完全相反**的东西。
- 在 **double reversal** 中，主角和对手都获得自我认知，作者的道德视野成为两人领悟的合题。

对规划的含义：卷纲不必写「本卷主题：贪婪是坏的」，但应该能回答「这一卷让主角在哪个道德问题上做了哪种选择，代价是什么」。这是一个**可写进规划的问题**，但不是一个可以自动判对错的字段。

### 6.3 Character web（角色网）

Character web 不是「角色列表」，而是**由主题和对立关系定义的关系结构**：

- **Opponent**：主角之外最重要的角色；阻止主角达到目标；尤其擅长攻击主角的弱点。对手可以是「同一个目标」的竞争者，也可以是「完全相反」的敌人。
- **Ally**：与主角并肩，或提供帮助；主角愿意在他面前暴露真实情感。
- **Fake ally**：表面帮助、实际反对；制造揭露和转折，也让对手显得更强。
- **Secondary opponents / allies**：各自代表不同的价值系统，用来从不同角度照亮主角的道德问题。
- 这个结构可以扩展到社会、制度、家庭，甚至主角内心的不同部分。

对长篇小说分卷的含义：**角色网是跨卷的，不必每卷重建。** 一卷可以只启用角色网的一个子集；但每个主要角色在这一卷里最好有一个明确的「价值立场」和「对主角弱点的攻击方式」，否则他只是在场，没有戏剧功能。

### 6.4 22 步怎么用才不教条

- **全书层面**：可以用 22 步做一次完整性检查，尤其是 self-revelation → moral decision → new equilibrium 这条链。
- **卷层面**：用七步，不要用 22 步。一卷的「battle」可以是局部对抗，「self-revelation」可以是局部认知，「new equilibrium」可以是卷末的新状态。
- **不要**要求每卷都出现 fake ally、audience revelation、visit to death。这些是全书级或特定类型的装置，不是每卷的必需品。

---

## 7. Robert McKee：scene 的价值电荷、转折点、控制性思想

### 7.1 层级

McKee 在 *Story* 里给出另一套层级：[17]

```text
beat（行动—反应）
  → scene（让至少一个价值转向）
    → sequence（通常 2–5 个场景，以一个 sequence climax 收束）
      → act（一系列 sequence，以一个 major reversal 收束）
        → story（一系列 act，走向绝对且不可逆的 story climax）
```

注意：McKee 的 sequence 比 Gulino 的 sequence 细得多。Gulino 的 sequence 是「迷你电影」，McKee 的 sequence 是「几个场景组成的中等转折」。工程上不要混用。

### 7.2 Scene：价值电荷与转折点

McKee 的定义是：场景是「在多少连续的时间和空间里，通过冲突展开的行动，它使一个角色生活中的价值电荷状况至少在一个价值上发生可感知的变化」。[17]

- **Value（价值）**：爱/恨、真/假、自由/奴役、生/死、希望/绝望……每个场景要选一个主要价值。
- **Value charge（价值电荷）**：场景开始时这个价值在角色生活中的正/负/混合状态。
- **Turning point（转折点）**：场景结束时，价值从正到负或从负到正；如果没有变化，这个场景就是「nonevent」，只是 exposition，应该删掉或把信息织进别的场景。
- **测试方法**：写下开场价值电荷 → 写下结尾价值电荷 → 如果相同，问「这场为什么在这里？」。McKee 的标准是「No scene that doesn't turn.」[17]

这条对 AI 检查最友好：`value_before` 和 `value_after` 是否相同，是可以机械判断的。但要注意：**「不同」不等于「有意义」**。一个场景可以从「安全」变成「不安全」却毫无张力；检查只能提示，不能裁决。

### 7.3 控制性思想（controlling idea）

McKee 认为故事的终极意义可以压缩成一句话，包含两个部分：**Value + Cause**。它不是抽象格言，而是「什么价值，通过什么原因/力量，进入了主角的世界」。控制性思想从高潮/最终行动里读出来，然后反过来指导全书的取舍。[17]

例如，不是「爱很重要」，而是「爱能战胜死亡，因为主角愿意为对方放弃自己的执念」——价值是「爱 vs 死亡」，原因是「牺牲」。

对规划的含义：`controlling_idea` 是一个有用的**可选**字段，适合全书，不适合每一卷。卷级的对应物是 `volume_question` + `crisis_choice`：这一卷在测试哪个价值，主角的选择给出了什么局部答案。

### 7.4 Story substance：期望与结果之间的 gap

McKee 说故事的实质是「角色采取行动时预期的结果」与「实际发生的结果」之间的裂缝（gap）。场景就是不断打开这个 gap：角色采取行动 → 世界给出意外反应 → 角色被迫调整 → 再行动。[17]

这与 Sanderson 的 try-fail cycle 是同一件事的两种说法：**progress 不是「事情发生了」，而是「角色的预期被打破，因此不得不改变策略」**。

### 7.5 警告

McKee 自己警告不要过度增加幕的数量：幕太多会「invite clichés」「reduce the impact of climaxes」「result in repetitiousness」。这对分卷同样成立：**不要把每一卷都当成一个独立的幕来制造大反转**；反转太多会贬值。

---

## 8. Brandon Sanderson：promise / progress / payoff、try-fail cycle、角色弧与情节弧的耦合

### 8.1 Promise / Progress / Payoff

Sanderson 在 BYU 2025 课程中把情节分成两个尺度：**大 P 的全局情节**和**小 p 的章节情节**。核心方法是：[18][19][20]

- **Promise（承诺）**：开头向读者承诺「这是什么类型的故事、这个角色会经历什么、这个冲突会如何解决」。承诺至少有三种：tone/genre（语气/类型）、character（角色会如何解决问题）、character arc（角色会变成谁）；再加上 plot promise 和 Chekhov's gun。
- **Progress（推进）**：中段必须让读者感到「在往某个方向走」。Progress 是最重要也最难的部分；偶尔倒退可以，但不能长期原地打转。
- **Payoff（兑现）**：结尾必须偿还承诺；不能靠 deus ex machina、巧合或作者作弊。好的 payoff 应该让读者觉得「比我预想的更好」，而不是「果然如此」。

Sanderson 的一个实用判断：**读者很少因为 payoff 不好而弃书，他们会读完然后打差评；但他们会因为 progress 停滞而弃书。** 所以中段的第一要务不是「藏惊喜」，而是「让每一步都改变局面」。[19]

### 8.2 Try-fail cycle

中段的引擎是 try-fail cycle：

```text
角色想要 X
  → 尝试方案 A（基于他的旧信念/旧能力）
    → 失败，且失败带来新信息/新代价
      → 调整，尝试方案 B（更聪明/更绝望）
        → 失败，代价更大
          → ……直到最后一次尝试成功，或主角改变了对 X 的理解
```

Sanderson 用 **「Yes, but / No, and」** 来描述升级：角色成功了一部分，但带来更大的问题（yes, but）；角色失败了，而且情况更糟（no, and）。关键是每次失败都要**改变故事状态**，不能只是「同样的障碍再来一次」。[18][24]

### 8.3 角色弧与情节弧的耦合

Sanderson 的主张是：**外部升级应该暴露并驱动内部成长；情节必须服务角色，而不是反过来。** 如果角色为了情节而做出不符合其性格的选择，读者会觉得被欺骗。[18][19]

对卷纲的含义：

- 每一卷的主情节高潮，应该同时是角色弧的一个节点：主角被迫面对一个他一直逃避的信念/缺陷。
- 反过来，角色弧的每一次变化，应该由一个具体的情节事件逼出来，而不是靠内心独白宣布。
- 卷末的「新状态」既包括外部世界（他拿到了什么/失去了什么），也包括内部（他现在相信什么/不再相信什么）。

### 8.4 系列与分卷的实践

Sanderson 的 *The Stormlight Archive* 是一个「幕 ≠ 卷」的清晰案例：[21][23]

- 每一部小说内部被分成五个部分，加插曲（interludes）；他按「一部三部曲」的规模来规划每一卷。
- 系列层面又是三幕：第 1–2 部 = 第一幕，第 3–4 部 = 第二幕，第 5 部 = 第三幕（第一个五年弧收束）。
- 每一卷仍然有自己的完整弧、自己的视角人物、自己的高潮；它不是「只为大结局做铺垫」的中转站。

这说明：**卷可以有自己的三幕/多序列结构，同时又是更大幕的一部分。** 两种结构可以嵌套，不需要二选一。

---

## 9. 长篇小说如何分卷

### 9.1 Act 与 Volume 的区别

| | Act（幕） | Volume（卷） |
|---|---|---|
| **定义** | 由一次重大价值反转/策略改变定义的戏剧阶段 | 出版、阅读、生产上的容器；通常应是一个可独立阅读的单元 |
| **边界** | 主角的策略、世界观或处境发生不可逆变化 | 一个局部故事讲完，读者可以在此停下并得到满足 |
| **长度** | 全书的 20–30% / 40–60% / 20–30% | 英文长篇常见 80,000–150,000 词（[25]）；中文网络长篇常见 20–100 万字（经验观察，差异极大） |
| **数量** | 通常 3 个；可以更多，但 McKee 警告会稀释高潮 | 可变；取决于故事材料和出版节奏 |
| **失败模式** | 「伪幕」：有事件，没有策略/价值反转 | 「中转站卷」：只推进，没有自己的收束 |

### 9.2 四种常见配置

1. **单卷独立故事**：一卷 = 一个全局故事 = 三幕。最常见于单本小说。
2. **系列，每卷自足**：每一卷是一个局部三幕故事；整个系列另有一个三幕弧。例子：*Harry Potter*（1–2 部第一幕，3–6 部第二幕，7 部第三幕）、*Stormlight*（1–2 / 3–4 / 5）。[21][23]
3. **一个长故事拆成多卷**：每一卷是全局故事的一个或两个幕；它仍然需要自己的局部高潮和收束，否则就是中转站。这是网络连载最常见的形态，也是最容易写坏的一种。
4. **网络连载的「卷」**：往往是一个 20–50 章的情节弧，可能只对应一个序列群，而不是一个完整的幕。此时「卷」更接近「季」而不是「幕」；不要强行给它三幕。

### 9.3 一卷应该包含几个序列

**先给结论：** 自足的一卷通常 **4–8 个序列**；如果这一卷只是更大故事的一个「乐章」，**2–4 个**；如果超过 8–10 个，先问「这是不是应该拆成两卷」，而不是继续加序列。

推导方式不是字数，而是**不可逆转折的数量**：

- 一个序列 = 一个局部戏剧问题 + 一次不可逆变化 + 一个新问题。
- 一卷有几个「必须发生的不可逆变化」，就有几个序列的骨架。
- 如果两个序列的出口状态相同，它们其实是同一个序列。
- 如果一个序列没有让任何东西不可逆地改变，它不是序列，只是场景群。

**长度参考：**

- Gulino：8 序列 × 10–15 页 ≈ 一部 110–120 页电影；每序列约 8–13% 的总时长。
- 小说：若一卷 100,000 词、8 序列，每序列约 12,500 词；若 6 序列，每序列约 16,700 词。
- 中文长篇：若一卷 30 万字、8 序列，每序列约 3.75 万字；若 6 序列，每序列约 5 万字。
- 经验下限：一个序列如果短于约 8,000–10,000 英文词（约 2–3 万中文汉字），它可能只是一个场景群，撑不起「setup → complication → crisis → resolution」的完整弧。

**但不要把这当公式。** 一个 4 序列的卷可以写得很好，一个 12 序列的卷也可以；关键是每个序列都有独立的戏剧问题，而不是为了凑数把一段情节切成四份。

### 9.4 卷末应该落在 act 的什么位置

这是最容易教条化的地方。正确的问法不是「卷末必须落在 act break 吗」，而是「这一卷的局部故事在哪里讲完，同时全局故事被推到了哪里」。

三种合法落点：

1. **卷末 = 全局 act break**：这一卷的收束同时是全局的重大反转；主角的策略/世界观发生不可逆变化。适合系列的第一幕结束、第二幕结束、全剧终。此时卷末应该有最大的反转和最高的代价。
2. **卷末 = 全局 act 的中间**：这一卷有自己的局部高潮和收束，但全局幕还没结束；它留下一个更大的问题，下一卷继续同一幕。这是最常见的系列形态。此时不要伪造一个「全盘皆输」的全局反转；用一个局部胜利/失败 + 一个新的门即可。
3. **卷末 = 全局 act 的起点附近**：这一卷主要建立新状态/新世界，卷末是「进入新阶段」的承诺。适合第二卷/过渡卷，但风险是「中转站」；必须有一个自己的局部故事，不能只是「接下来要去某地」。

**判据：**

- 读者如果在这一卷末停下，是否得到了一个完整的故事？如果答案是「没有，必须看下一卷」，那这一卷就是中转站（除非它是连载中的「部」，读者事先接受了这个契约）。[22]
- 这一卷的卷末状态，是否在至少一个价值上不同于卷首？如果相同，这一卷没有发生真正的变化。
- 这一卷的卷末，是否制造了一个**新的问题**，而不是仅仅重复旧问题？新问题应该从这一卷的后果里长出来。

**不要做的事：**

- 不要为了「每卷都要有 act break」而在每卷末杀死一个重要角色/制造一次全盘皆输。反转会贬值，读者会学会 rhythm。
- 不要为了「三卷 = 三幕」而把第二卷写成纯过渡。三幕是全局的，不是卷的配额。
- 不要把「卷末悬念」当成「卷末收束」的替代品。悬念是钩子，收束是故事。

### 9.5 比例建议

| 单位 | 建议比例 | 说明 |
|---|---|---|
| 三幕（全局） | 20–30% / 40–60% / 20–30% | Story Grid 常用 25/50/25；Save the Cat 小说版用 20/50/80 的转折点。两者都是惯例，不是定律 |
| 序列（卷内） | 每序列约 8–15% 的卷长 | 8 序列 ≈ 12.5%；6 序列 ≈ 16.7%；4 序列 ≈ 25%（后者需要很强的单一戏剧问题） |
| 卷（系列内） | 英文 80–150k 词 [25]；中文网络长篇 20–100 万字（经验观察） | 类型差异很大；不要用字数反推结构 |
| 系列幕（跨卷） | 2–5 卷/幕 | *Stormlight* 2/2/1；*Harry Potter* 2/4/1。没有普适公式 |

**对中文长篇的适配：**

- 中文网络长篇的「卷」往往比西方传统出版的 volume 长（30–100 万字很常见）。不要直接套用 80–150k 词的 volume 长度；套用「局部故事必须讲完」这条结构判据。
- 「爽点」是读者回报（reader reward）的一种，不是结构单位。它可以写进 `emotional_curve` / `reader_reward`，但不应该替代 `crisis_choice` 或 `irreversible_turn`。
- 章节是连载的交付单位；不要用「每章一个爽点」去替代序列级的因果推进。爽点可以是序列的 payoff，但序列本身仍然要有问题和转折。

---

## 10. 哪些是可判定的结构约束，哪些只是创作启发

这是整份报告对 talemate 最直接的部分。判断标准不是「这个框架对不对」，而是「这条规则能不能用结构化数据检查，以及检查错了会不会伤害故事」。

### 10.1 可以硬化成检查项（但仍应只报警告）

| 约束 | 怎么判定 | 误报风险 |
|---|---|---|
| 每个单位有 inciting incident / progressive complications / crisis / climax / resolution | 五个字段非空，顺序正确 | 低；但填了字段不等于写得好 |
| 每个场景/序列的价值前后不同 | `value_before != value_after` | 低；可能漏掉「价值相同但信息/关系变了」的场景 |
| 每个序列以不可逆变化收束 | `exit_state != entry_state` 且 `reversible == false` | 中；「不可逆」需要人判 |
| 因果链连续 | 下一序列的 `entry_state` 等于上一序列的 `exit_state`，或显式说明重置原因 | 中；时间跳跃/多线叙事需要例外 |
| 每个 promise 有 payoff | promise/payoff 图：每个开出的 id 在之后有闭合节点 | 低；但「是否值得开这个 promise」不可判 |
| 危机是二选一，且高潮选择了其中一个 | `crisis.options.length == 2`，`climax.choice ∈ options`，两个选项都有 `cost` | 中；有些危机是「多选一」或「不选」 |
| 主角有目标，对手有目标，两者冲突 | 字段非空 + 目标/阻力指向同一对象 | 低；但「冲突是否深刻」不可判 |
| 副线与主线有交集 | 每个 subplot 至少有一个场景同时引用主线和副线 id | 低；可能漏掉主题层面的交集 |
| 升级 | 至少一个维度（赌注/范围/代价/知识）在序列间严格增加 | 中；有些故事是「横向扩展」而非纵向升级 |
| setup 在 payoff 之前 | 时间/序列序号的偏序检查 | 低；闪回需要例外 |

这些检查的正确用法是 **lint**：发现问题 → 让规划者解释或修正。不要「检查失败 → 自动重写」。因为 AI 能判断「字段不同」，不能判断「不同得有意义」。

### 10.2 只能当软警告/诊断问题

| 启发 | 为什么不能硬化 |
|---|---|
| 三幕比例 25/50/25 | 只是常见分布；不同题材、不同叙述方式差异很大 |
| 每卷 8 个序列 | Gulino 的方法针对 110 页电影；长篇的序列数由材料决定 |
| 每卷 15 个 Save the Cat beats | 会导致每卷都有假中点、全盘皆输、顿悟，节奏可预测 |
| 每卷都在卷末做 act break | 会逼出虚假的大反转，稀释全局高潮 |
| 每个场景都必须 turn | 有些场景的功能是呼吸、铺垫、关系深化；只要它有别的功能，可以不 turn。McKee 的理想是「no scene that doesn't turn」，但这是理想，不是每场都必须有可见的正负翻转 |
| 每个序列都必须有 try-fail | 有些序列是「成功但付出代价」，不是失败循环 |
| 每卷都必须有 B Story / Fun and Games / Theme Stated | 这些是全书或类型装置，不是每卷的必需品 |
| 每卷都必须有 obligatory scenes | obligatory scenes 是类型契约，不是卷契约；同一类型的不同卷可以分担不同的义务场景 |
| 主角必须「讨人喜欢」/有 save the cat 时刻 | 这是 Snyder 的商业直觉，不是普遍结构约束；反英雄、悲剧、文学小说经常不适用 |
| 控制性思想必须是一句话 | 有用，但很多好故事的主题是暧昧的、多义的 |
| 22 步必须按顺序出现 | Truby 自己说是推导顺序，不是 beat sheet |
| 章 = 场景 | 章是交付单位；一个章可以包含多个场景或部分场景 |

### 10.3 不可判定的东西，不要假装能判

- **「这个转折是否可信」**：取决于铺垫、人物一致性、世界规则、语调。结构化检查只能看「有没有铺垫」，不能看「铺垫够不够」。
- **「这个价值变化是否重要」**：从「安全」到「不安全」可以是生死攸关，也可以是微波炉坏了。需要读者/人判断。
- **「这个 promise 是否值得开」**：开太多 promise 是常见病，但「多少算多」取决于类型和读者契约。
- **「这个卷是否好看」**：结构完整不等于好看；节奏、文笔、人物魅力、信息释放都不在结构检查范围内。
- **「这个主题是否正确/深刻」**：道德论证是创作判断，不是 schema 字段能裁决的。

**工程原则：** 硬检查抓「缺了什么」，软诊断问「为什么这样」。两者都不要自动改稿。

---

## 11. 最小卷纲 schema

下面的 schema 是**不教条的最小集**：它只要求回答「这一卷是不是一个完整故事、是否推进了全局、是否留下了新问题」。它不是要替代 talemate 现有的五格卷纲，而是给五格提供更明确的判据。

### 11.1 必需字段

| 字段 | 一句话：它约束什么 |
|---|---|
| `volume_question` | 这一卷要回答的局部戏剧问题（通常是「主角能不能……？」）；没有它，卷就没有统一性。 |
| `protagonist_goal` | 主角在这一卷具体要拿到/保住/阻止什么；没有它，事件就没有方向。 |
| `opposition` | 谁/什么在阻止，为什么现在更难；没有它，冲突就没有升级。 |
| `entry_state` | 卷首主角和世界的状态，必须承接上一卷；没有它，读者会觉得每一卷都在重置。 |
| `exit_state` | 卷末主角和世界的状态，必须在至少一个命名价值上不同于卷首；没有它，这一卷就没有变化。 |
| `value_at_stake` | 这一卷主要测试的价值（如自由/安全、归属/独立、真相/秩序），以及卷首/卷末的电荷；没有它，变化就只是事件堆。 |
| `crisis_choice` | 卷末高潮的两难（两个选项、都有代价）和主角实际选择的那个；没有它，卷末就只是「打赢了/打输了」，不是选择。 |
| `sequences[]` | 这一卷的序列列表；每项至少要有 `question`、`entry_state`、`exit_state`、`irreversible_turn`、`turn_type`、`cost`。没有它，卷纲就只是梗概。 |
| `series_position` | 这一卷在全局主线中的位置：承接什么、推进什么、必须给下一卷留下什么状态；没有它，卷就会变成孤岛。 |

### 11.2 可选/按题材启用

| 字段 | 什么时候启用 | 一句话：它约束什么 |
|---|---|---|
| `act_position` | 项目有明确的系列级幕规划时 | 这一卷落在系列三幕的哪一幕、卷末是否是全局 act break；没有系列幕规划就不要填，避免「三卷 = 三幕」的误映射。 |
| `obligatory_scenes[]` | 类型有明确契约时（爱情、惊悚、成长、悬疑等） | 这一卷必须兑现哪些类型义务场景；它是类型契约，不是通用清单。 |
| `subplots[]` / `b_story` | 这一卷有真正的副线时 | 每条副线的价值转变、与主线的交集、对主题的贡献；没有副线就不要硬加。 |
| `theme_question` / `moral_argument` | 全书有明确主题命题、或这一卷要测试它时 | 这一卷在哪个道德问题上让主角做选择；它是问题，不是口号。 |
| `character_arcs[]` | 多 POV、强角色弧、或角色弧是主要卖点时 | 谁在这一卷改变、从什么信念到什么信念、哪个情节事件逼出改变；没有它，角色弧就容易变成内心独白。 |
| `pov_plan` | 多视角/复杂时间线时 | 谁讲哪些序列、视角切换的规则；避免视角混乱。 |
| `emotional_curve` / `reader_reward` | 连载、类型小说、需要明确爽点时 | 读者的情绪走向和回报类型；它是体验设计，不是结构约束。 |
| `cliffhanger` | 连载/系列卷末需要钩子时 | 卷末留下的具体新问题；不能替代局部收束。 |
| `word_budget` | 需要排期/篇幅管理时 | 预估体量；它是资源约束，不是戏剧约束。 |
| `try_fail_cycles[]` | 中段推进乏力、需要诊断时 | 每个序列的尝试/失败/代价；它是诊断工具，不是每序列的必填项。 |
| `promise_refs[]` | 项目有 promise/foreshadowing 账本时 | 这一卷开出/推进/兑现的 promise id；数据应放在状态层，卷纲只引用，避免重复。 |

### 11.3 一个最小示例

```json
{
  "volume": 2,
  "volume_question": "主角能不能在不暴露身份的前提下拿到账册？",
  "protagonist_goal": "混进沈家夜宴，取得记录走私路线的账册",
  "opposition": "沈家二少爷怀疑他；旧盟友的倒戈让他的身份随时可能暴露",
  "value_at_stake": {
    "name": "隐匿 / 暴露",
    "before": "无人知晓的局外人",
    "after": "被沈家盯上的危险人物"
  },
  "entry_state": "主角刚赢下第一场，但欠下人情，身份尚未暴露",
  "exit_state": "账册到手一半，主角被迫暴露一半身份，沈家开始追查",
  "crisis_choice": {
    "options": [
      "拿账册，牺牲唯一能证明自己清白的证人",
      "救证人，放弃账册，任务失败"
    ],
    "chosen": "拿账册，证人死，主角第一次主动选择‘任务高于人命’",
    "cost": "他保住了线索，但失去了自我认同的支点"
  },
  "sequences": [
    {
      "id": "s1",
      "question": "主角能不能混进夜宴？",
      "entry_state": "被挡在门外",
      "exit_state": "以假身份进入，但被二少爷注意到",
      "irreversible_turn": "他用了不可撤销的假身份，从此不能再用旧身份出现",
      "turn_type": "action",
      "cost": "旧身份的社会关系被切断"
    }
  ],
  "series_position": "把主线从‘查走私’推进到‘沈家知道有人在查’；为下一卷留下‘主角必须选择阵营’的问题"
}
```

### 11.4 与 talemate 现有五格的映射

| 现有卷纲格 | 对应 schema | 建议 |
|---|---|---|
| 本卷在全局的位置 | `series_position` | 保留；如果项目有系列幕规划，再加可选的 `act_position` |
| 本卷目标与阻力 | `protagonist_goal` + `opposition` | 保留；要求写明「比上一卷难在哪」，否则只是重复 |
| 本卷的情绪曲线 | `emotional_curve` / `reader_reward` | 保留为可选；不要把它当结构约束，也不要用爽点替代转折 |
| 卷末状态 | `exit_state` | 保留；再加 `entry_state` 和 `value_at_stake`，否则「状态变了」无法判定 |
| 本卷的序列 | `sequences[]` | 保留；每段至少加 `question` 和 `irreversible_turn`，否则只是事件列表 |

**如果只加三个字段，加这三个：**

1. `volume_question`——这一卷到底在回答什么。
2. `entry_state`——这一卷从哪里开始，防止卷卷重置。
3. `crisis_choice`——卷末的选择是什么，防止「高潮 = 打赢了」。

这三个字段不会把故事钉死，但能把「这一卷是不是一个完整故事」从感觉变成可讨论的问题。

---

## 12. 明确反对「为了对称而套模板」

以下每一条都是我在资料里看到的、或工程化时最容易发生的错误。它们的共同点是：**把「常见」当成「必须」，把「结果」当成「输入」。**

### 12.1 反对「三卷 = 三幕」

**理由：** 幕由反转定义，不由卷数定义。*Stormlight* 是 1–2 部第一幕、3–4 部第二幕、5 部第三幕；*Harry Potter* 是 1–2 / 3–6 / 7。如果作者写四卷，不代表要硬造四幕；如果写两卷，也不代表只有两幕。正确做法是：先确定全局的几次重大反转，再看它们落在哪些卷末；不要先画三个等号。

### 12.2 反对「每卷必须 8 个序列」

**理由：** 8 是 Gulino 对 110–120 页电影的经验值，不是小说的自然常数。一卷可能只有 3 个真正的不可逆转折，也可能有 10 个。为了凑 8 而把一段情节切成两半，会制造没有独立问题的「伪序列」；为了压缩到 8 而合并两个不同的问题，会让序列失去焦点。

### 12.3 反对「每卷都套 15 个 Save the Cat beats」

**理由：** 15 beats 是**全书**节奏表。每卷都来一次 Catalyst → Midpoint → All Is Lost → Break into Three，会让读者在第二卷就学会节奏：啊，这里该失去导师了，那里该顿悟了。更糟的是，每卷都「全盘皆输」会让真正的全局低点失去冲击力。卷级只需要「激励事件 → 中点反转 → 低点 → 高潮/收束」的功能，不需要 15 个编号。

### 12.4 反对「每卷末都必须是 act break」

**理由：** 如果每一卷都结束在全局幕的边界，系列就只剩三卷可写；如果强行拉长，就会在非边界处伪造大反转。更常见的是反过来：每一卷都制造一次「全盘皆输」，读者很快就不信了。卷末可以是局部高潮 + 新问题，不必是全局幕边界。

### 12.5 反对「所有卷等长、等序列数」

**理由：** 对称是结果，不是目标。第一卷需要建立世界，可能序列更多；第二卷是中段，可能需要更密集的 try-fail；第三卷收束，可能更短更快。强行等长会让某些卷注水、某些卷仓促。真正应该对齐的是**每一卷的局部故事完整性**，不是字数或段数。

### 12.6 反对「每卷都要有 B Story / Fun and Games / Theme Stated」

**理由：** 这些是全书级或类型级的装置。B Story 如果每卷都有，会变成「每卷一条恋爱线」的机械节奏；Fun and Games 只适合「前提探索」型故事；Theme Stated 每卷重复会变成说教。卷级应该问「这一卷的材料需要什么」，而不是「beat 表还缺什么」。

### 12.7 反对「每个场景都必须 turn」

**理由：** McKee 的「no scene that doesn't turn」是理想，不是每场都必须有可见的正负翻转。有些场景的功能是呼吸、关系深化、世界展示、铺垫；只要它有明确功能，就可以不 turn。真正该删的是「没有任何功能」的场景，而不是「价值没有翻转」的场景。把这条硬化成 AI 检查，会误杀大量有效的过渡场景。

### 12.8 反对「章 = 场景」「章数 = 序列数」

**理由：** 章是连载/阅读的切分，场景是戏剧单位。一个章可以包含三个场景，也可以只包含一个场景的后半段；一个序列可以跨五章，也可以在一章内结束。用章数反推序列数，会让规划者为了「一章一个转折」而制造虚假的钩子。

### 12.9 反对「把主题压成一句控制性思想，并要求每卷重复」

**理由：** 控制性思想是有用的全书诊断工具，但很多好故事的主题是暧昧的、多义的、随卷深化的。要求每卷都写一句「本卷主题：X」，会把人物变成论点的传声筒。卷级更应该写 `volume_question`（这一卷在测试什么），而不是 `volume_thesis`（这一卷的答案是什么）。

### 12.10 反对「角色网必须包含所有 archetype」

**理由：** Truby 的角色网是**诊断工具**，不是角色清单。一个故事可以没有 fake ally，也可以没有独立的 ally；只要主角的 moral problem 被足够多的价值立场照亮，角色网就是有效的。要求每个卷都出现 opponent/ally/fake ally，会让配角变成功能标签。

**一句话总结：** 结构框架的价值在于**提问**，不在于**配额**。凡是「每卷必须 N 个」「必须落在 X%」「必须出现 Y 角色」的规则，都应该先降级为警告，再让人判断。

---

## 13. 对 talemate 的直接建议

1. **保留「卷 → 序列」两级规划，不要新增「幕」文档。** 幕可以作为卷纲里的一个可选字段（`act_position`），但不值得单独一层文档。talemate 的 `docs/outline.md` 已经说「情节层只有两个尺度」，这与研究结论一致：幕是分析视角，卷/序列才是写作单位。
2. **卷纲加三个字段：`volume_question`、`entry_state`、`crisis_choice`。** 它们分别防止「卷没有统一问题」「卷卷重置」「高潮只是打赢」。其余字段按题材可选。
3. **序列纲加两个字段：`question` 和 `irreversible_turn`。** 现有序列纲是整篇散文，这很好；但规划者至少要在心里回答这两个问题，否则序列会变成事件列表。可以在 `guide` 里要求，而不是把序列纲改成表格。
4. **不要给序列规定字数。** 现有文档说「一节要写成几章，是写到那儿才知道的」，这是对的。序列的长度应该由戏剧问题决定，不由字数配额决定。
5. **把比例/beat 表放进「诊断」而不是「生成」。** 如果要把 Save the Cat 或 Story Grid 写进 prompt，应该写成「检查这一卷是否缺少某个功能」，而不是「按这个表填 15 格」。
6. **promise/payoff 账本放状态层，不放卷纲。** 现有 `state/foreshadowing.md` 已经是正确的位置；卷纲只引用 id，避免重复和脱节。
7. **不要用「三卷 = 三幕」做默认模板。** 如果项目规划了系列幕，用 `act_position` 显式记录；如果没有，就让卷自己完整，让全局幕在复盘时现算。

---

## 14. 关键来源

### 一手著作

1. Paul Gulino, *Screenwriting: The Sequence Approach*（Continuum, 2004；2nd ed., Bloomsbury Academic, 2024）。八序列、2–4–2、first/second culmination、每序列的迷你故事结构。Bloomsbury 第二版：<https://www.bloomsbury.com/in/screenwriting-9798765104644/>；Google Books 预览：<https://www.google.com.sg/books/edition/Screenwriting/BVfHAgAAQBAJ>
2. Shawn Coyne, *The Story Grid: What Good Editors Know*（2015）及 *Story Grid 101*（2021）。五 commandments、单位层级、value shift、obligatory scenes、spreadsheet。
3. Blake Snyder, *Save the Cat!*（2005）；Jessica Brody, *Save the Cat! Writes a Novel*（2018）。15 beats 与小说百分比。
4. John Truby, *The Anatomy of Story: 22 Steps to Becoming a Master Storyteller*（2007）。22 步、moral argument、character web、七步最小结构。
5. Robert McKee, *Story: Substance, Structure, Style, and the Principles of Screenwriting*（1997）。beat/scene/sequence/act、value charge、turning point、controlling idea、gap。
6. Brandon Sanderson, BYU 2025 写作课 Lecture #2 “Promise, Progress, Payoff” 与 Lecture #3 “Story Structure”。promise/progress/payoff、try-fail cycle、角色弧与情节弧。

### 在线资料（用于定位与交叉核对）

7. Story Grid, “Russian Dolls”: <https://storygrid.com/russian-dolls/>
8. Story Grid, “5 Commandments and Pheres”: <https://storygrid.com/5-commandments-and-pheres/>
9. Story Grid, “Units of Story: Beats, Tropes, Scenes, Sequences, and Quadrants”: <https://storygrid.com/articles/units-of-story>
10. Story Grid, “Writing Scenes That Work (Every Time)”: <https://storygrid.com/writing-scenes-work/>
11. Story Grid, “How to Spreadsheet Your Novel”: <https://storygrid.com/podcast/how-to-spreadsheet-your-novel>
12. StudioBinder, “Save the Cat Beat Sheet”: <https://www.studiobinder.com/blog/save-the-cat-beat-sheet/>
13. Save the Cat 小说百分比整理：<https://pageturnermag.com/2025/01/14/writing-with-word-count-ft-save-the-cat/>；<https://authorshelpkit.com/the-save-the-cat-beat-sheet-for-novelists-a-beginners-guide/>
14. Plottr, “Eight Sequences Plot Structure for Books and Screenplays”: <https://plottr.com/eight-sequences-plot-structure/>
15. John Truby, *The Anatomy of Story* 官方页：<https://truby.com/the-anatomy-of-story/>
16. Arc Studio, “22 Building Blocks – John Truby”: <https://www.arcstudiopro.com/blog/22-building-blocks-john-truby>
17. McKee Seminars, “Do Your Scenes Turn?”: <https://mckeestory.com/do-your-scenes-turn/>
18. Brandon Sanderson, “2025 Overview of Story Structure (Lecture #3)”: <https://www.brandonsanderson.com/blogs/blog/brandon-sandersons-2025-overview-of-story-structure-lecture-3>
19. Brandon Sanderson, “Promise, Progress, Payoff – Plot Theory: Lecture #2”: <https://podcasts.apple.com/ie/podcast/promise-progress-payoff-plot-theory-brandon-sandersons/id1798308121?i=1000695633007>
20. Robin Catling, “Three foundations of plot: Promises, Progress and Payoffs”: <https://robincatling.com/promises-progress-and-payoffs>
21. The Fictorians, “Plotting a Series”: <https://www.fictorians.com/2018/03/26/plotting-a-series/>
22. Wetherid, “Fantasy Series Planning for Multi-Volumes”: <https://www.wetherid.com/en/fantasy-series-planning-for-multi-volumes.html>
23. Coppermind, “The Stormlight Archive”: <https://coppermind.net/wiki/The_Stormlight_Archive>
24. Writing Excuses, “Structuring a Mid-Length Piece”（try-fail cycle）: <https://www.listennotes.com/es/podcasts/writing-excuses/1236-structuring-a-mid-FpYivQgOMJU/>
25. SagaScope, “How Many Words in a Fantasy Novel?”: <https://sagascope.com/en/blog/fantasy-novel-word-count>

> 说明：网络文章对同一本书的页码/百分比常有不同复述；本报告只在「多个来源互相印证或能追溯到作者原文」的地方使用具体数字。凡涉及「每卷几个序列」「每卷多少字」的建议，都是量级参考，不是硬性规范。
