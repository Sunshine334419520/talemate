# AI 长篇叙事的分层规划与控制：证据、失败模式与对 talemate 卷/序列层的建议

> 研究范围：DOC、Re³、RecurrentGPT、StoryVerse、Agents' Room、Dramatron、LongWriter、Plan-and-Write、Hierarchical Neural Story Generation、LongStory、DOME、StoryWriter、STORYTELLER、WriteHERE、ConStory-Bench / Lost in Stories、CFPG 等 2023–2026 年的长文与叙事生成工作；另参考 Sudowrite / NovelAI / NovelCrafter 一类工程实践。
>
> 结论用途：给 talemate 的「卷纲 → 序列纲 → 章规划 → 正文」提供两类东西——**哪些表示法有可复现证据**，以及**哪些失败模式必须在 schema 和状态层里提前留位置**。本文不提出新的结构模板，也不主张把创作判断硬化成自动改写。
>
> 与 `02-western-structure.md` 的关系：02 从编剧工艺回答「卷/序列/场景各该回答什么问题」；本文从 AI 系统回答「这些问题的哪些部分必须写成可检查的状态，才能让模型不跑偏」。两份报告在三点上一致：卷/序列是规划单位；不要套固定 beat 数量；promise/payoff 账本放状态层。本文额外补的是 **entry/exit state、turn 的价值变化、以及 AI 特有的状态漂移与局部修改传播**。

---

> 读前须知：证据分级、外推限制，以及 SCOPE / MetaWriter / Weaver 等条目的核查结果，见第 12 节；正文先给 10 条结论。

---

## 1. 10 条有证据支持的结论

### 结论 1：分层规划的第一收益是「不跑题、不断线」，不是「更好看」

把「先规划再写」与「直接续写」对比，最稳定的提升出现在**全局连贯**与**大纲相关性**，而不是文采或事实一致性。

- DOC 相对 Re³：连贯性 67.6 vs 45.1，大纲相关性 65.3 vs 37.1，趣味性 60.1 vs 39.4；论文报告为连贯性 +22.5、相关性 +28.2、趣味性 +20.7 个绝对点（[DOC, ACL 2023](https://aclanthology.org/2023.acl-long.190/)）。
- Re³ 相对滚动窗口基线：连贯性 +14%、前提相关性 +20%（[Re³, EMNLP 2022](https://aclanthology.org/2022.emnlp-main.296/)）。
- 更早的 Hierarchical Neural Story Generation 用「先扩写 prompt，再写故事」两级结构，人类偏好 67.32% vs 32.68%（[Fan et al., ACL 2018](https://arxiv.org/abs/1805.04833)）。
- Plan-and-Write 的静态规划优于动态规划：整体偏好 50.07% vs 30.07%，连贯性 49.47% vs 28.27%（[Yao et al., AAAI 2019](https://arxiv.org/abs/1811.05701)）。

但 DOC 自己明确说：**长程事实一致性仍是问题**，低层大纲执行仍经常失败，大纲错误会级联到正文。也就是说，分层规划是「方向约束」，不是「一致性保证」。对 talemate 的含义是：卷纲/序列纲首先负责「这一卷/这一段在回答什么问题、结束时世界必须变成什么样」，不要把「文笔好」「人设稳」寄希望于多一层大纲。

### 结论 2：规划粒度的甜点在「场景以上、事件以下」：2–5 个 turn/beat + 状态差

过粗和过细都有可复现的失败：

- **过细**：DOC 的详细大纲最大深度 3、每个节点分支 2–5，每个叶子最多写 512 token；即便如此，作者仍报告「更详细的大纲更难忠实执行」，而且**继续加大控制强度会产生越来越窄、越来越重复的输出**。叶子还会出现「有的太模糊、有的过度展开」，大纲错误会级联（[DOC](https://ar5iv.labs.arxiv.org/html/2212.10077)）。
- **过细的工程版本**：LongWriter 的 AgentWrite 要求每段计划 200–1000 词，并明确写「不要把子任务切得太细」；计划步骤太多会导致生成崩溃，约 0.2% 的数据因此被过滤。并行分段虽然略增长度，但连贯性下降约 6%（[LongWriter, ICLR 2025](https://arxiv.org/abs/2408.07055)）。
- **过粗**：Plan-and-Write 的 storyline 是「每句一个关键词」的有序词表，作者自己承认它「遗漏实体、事件、关系」，并提出应改用实体/事件/关系结构（[Plan-and-Write](https://ar5iv.labs.arxiv.org/html/1811.05701)）。
- **动态层级更稳**：DOME 用「5 个宏观故事阶段 → 每阶段 3 个章节级详细大纲」的两层结构，并且**边写边展开后续详细大纲**，比 DOC 的固定三层树更能适应生成中的不确定性；其消融显示去掉动态层级后故事长度和人类排名显著下降（[DOME, NAACL 2025](https://aclanthology.org/2025.naacl-long.63/)）。
- **固定大纲会锁死工作流**：WriteHERE 批评 outline-first 系统一旦生成大纲就难以回头补检索/补推理；它用递归 DAG 把检索、推理、写作交替展开，在 2k–8k 词上优于 Agents' Room（[WriteHERE, EMNLP 2025](https://aclanthology.org/2025.emnlp-main.1254/)）。

**对 talemate 的粒度建议：**

| 层级 | 有效粒度 | 不要写成 |
|---|---|---|
| 卷 | 5 个左右的宏观阶段/价值转折；每卷一个局部戏剧问题 | 逐章事件表、15 个 Save the Cat beat |
| 序列 | 2–4 个 turn（价值转变 + 选择 + 代价）；一个不可逆收束 | 逐场景动作清单、每句话的梗概 |
| 章 | 2–5 个 scene beat（目标/阻力/转折/代价） | 逐段对白、逐动作 blocking |
| 场景 | 1 个价值变化 + 1 个转折点 | 每个 beat 都写进卷纲 |

「事件可以换，状态必须保住」——这句话不仅适用于改纲，也适用于 AI 生成：**规划层应约束状态转移与 turn 的功能，而不是事件的身份。**

### 结论 3：带时间索引的结构化事件/状态记忆，比纯摘要更能压住矛盾；但「事后事实抽取 + 编辑」只对可验证属性有效

- DOME 用四元组 `<subject, action, object, chapter_index>` 存记忆，按实体检索后再让 LLM 语义过滤。去掉记忆模块后冲突率从 0.56 升到 4.52；论文报告记忆模块把冲突减少 87.61%（[DOME](https://ar5iv.labs.arxiv.org/html/2412.13575)）。
- PlotMachines 的动态 plot-state memory 消融显示：去掉记忆后，ROUGE 的提升消失；作者据此认为「plot state tracking 是重要的」（[PlotMachines, ACL 2020](https://arxiv.org/abs/2004.14967)）。
- RecurrentGPT 同时维护长期记忆（所有早期段落的摘要向量库）与短期记忆（最近 10–20 句摘要）；去掉任一种都会降低连贯性（[RecurrentGPT](https://arxiv.org/abs/2305.13304)）。
- 但 Re³ 的 Edit 模块（抽取人物属性、检测矛盾、用 GPT-3 改写）对主指标几乎没有帮助：去掉 Edit 后连贯性/相关性为 60.3/59.3，保留时为 57.3/59.3；不一致检测 ROC-AUC 0.684，且只覆盖人物属性（[Re³](https://ar5iv.labs.arxiv.org/html/2210.06774)）。

**含义：** 值得存的是「实体—事件—时间—参与者」这类可检索、可比较的事实；不要指望在全文写完后用一次「事实抽取 + 编辑」修好情节、主题、伏笔。后者必须在规划/写作时就作为约束存在。

### 结论 4：检索必须以「当前计划/当前事件」为查询，只喂相关切片；全量上下文会稀释注意力

- RecurrentGPT 用「下一段计划」作为长期记忆的检索 query，只取最相关的几段早期内容（[RecurrentGPT](https://arxiv.org/abs/2305.13304)）。
- Re³ 每段重建 prompt：前提、人物、前文各节大纲、最近段落摘要、当前节大纲、上一段原文；再用 DPR 选相关上下文（[Re³](https://ar5iv.labs.arxiv.org/html/2210.06774)）。
- StoryWriter 的 Coordinator 按当前子事件压缩历史，实验发现「滑动窗口 [2, k-1]」在 15k token 以下最好；把中间上下文最大化简化反而最有效（[StoryWriter, 2025](https://arxiv.org/abs/2506.16445)）。
- 工程实践里反复出现同一个坑：把全书摘要/完整大纲塞进上下文，模型会把「计划中的未来事件」当成「已经发生的事实」，或者因为事实太多而稀释注意力（[oh-story 工程文档](https://github.com/zenstory-ai/oh-story-claudecode/blob/main/docs/ai-long-novel-character-consistency.md)，C 级证据）。
- ConStory-Bench 发现一致性错误更常出现在**叙事中段、token 熵更高的片段**，这与长上下文中的注意力稀释一致（[Lost in Stories, ACL 2026 Findings](https://aclanthology.org/2026.findings-acl.410/)）。

**含义：** planner 每次只拿「当前序列契约 + 当前章相关状态切片 + 当前 POV 知识」，而不是整本大纲；检索 query 应该是「这一章要兑现的 turn / exit state」，不是「这本书讲了什么」。

### 结论 5：伏笔/承诺必须显式记账；上下文里有，不等于会回收

- CFPG 直接指出：LLM 即使拿到了必要上下文，也经常让「契诃夫之枪」不响；它把叙事连续性编码成 **Foreshadow–Trigger–Payoff 三元组**，在 BookSum 上挖掘监督信号，报告 payoff accuracy 与叙事对齐提升（[CFPG, 2026](https://arxiv.org/abs/2601.07033)）。
- ConStory-Bench 的 19 个一致性错误子类型里，明确包含 `timeline_plot_abandoned_plot_elements`（被遗弃的情节元素）；这说明「忘了收线」是被系统记录的真实失败，不是读者错觉（[ConStory-Bench](https://huggingface.co/datasets/jayden8888/ConStory-Bench)）。
- 工程系统普遍把伏笔做成账本：`open / paid / abandoned` 状态、计划回收窗口、重要性、场景绑定、逾期提醒；并区分「直接回收 / 变体回收 / 隐性回收」（[StoryMoss](https://github.com/91zgaoge/StoryMoss)、[dsh-story](https://www.npmjs.com/package/@wang--lin--chang/dsh-story)，C 级证据）。

**含义：** `state/foreshadowing.md` 不应只是「伏笔 + 打算哪章收」的自由文本，而应至少能回答：**这条承诺现在是什么状态、最晚什么时候要处理、已经有哪些正文证据、如果删掉它后面的 payoff 是否还成立（空 setup 检测）。** 这些是 lint，不是质量打分。

### 结论 6：一致性错误集中在事实/时间维度、叙事中段、高熵片段；检查要连续、带证据

- Lost in Stories / ConStory-Bench 用 2,000 个 prompt、8k–10k 词的故事，定义了 5 大类 19 个子类：人物（记忆、知识、能力波动、遗忘能力）、事实细节（外貌、命名、数量）、叙事风格（视角、语调、风格突变）、时间/情节（绝对时间、时长、同时性、无因之果、因果违反、被遗弃情节）、世界观（核心规则、社会规范、地理）。错误最常出现在**事实与时间维度**，倾向于出现在**叙事中段**和**高 token 熵**的片段，且某些错误类型会共现（[Lost in Stories](https://aclanthology.org/2026.findings-acl.410/)）。
- ConStory-Checker 的关键不是给一个总分，而是**抽取可能冲突的陈述对，并给出原文引用来支撑判断**；它报告 Consistency Error Density（CED）与 Group Relative Rank（GRR）（[ConStory-Bench](https://huggingface.co/datasets/jayden8888/ConStory-Bench)）。
- DOME 的 Temporal Conflict Analyzer 也是把四元组按时间分组、转成自然语言、让 LLM 判冲突，冲突率 `CR = m/N`（[DOME](https://ar5iv.labs.arxiv.org/html/2412.13575)）。

**含义：** 每章写完后做一次「抽取事实对 → 找矛盾 → 带证据」的 lint，比全书写完再总体打分有效；重点检查中段和高熵段落（动作密集、信息密集、视角切换处）。

### 结论 7：局部修改会通过依赖关系破坏全局；必须记录 supersession/依赖并做影响范围审计

- StoryState 用显式持久状态管理可编辑故事书；消融显示去掉显式状态会导致**更多页面被改动、用户工作量增加**；关闭页面级重生成能保一致性，但会迫使几乎整本重写；去掉 Consistency Critic 后身份/布局违规更频繁（[StoryState, 2026](https://arxiv.org/abs/2602.01305)）。
- Plug-and-Play Dramaturge 直接指出：**不协调的局部修改会引入新的不一致，导致分数下降和迭代停止**；它的做法是先稳定全局结构，再细化局部（[Dramaturge, 2025](https://arxiv.org/abs/2510.05188)）。
- 关于「持久修正」的研究把问题拆成三件事：修正是否持续约束后续生成（correction persistence）、语义影响是否传播到依赖它的段落/摘要/元数据（semantic propagation）、谁有权决定修正的范围与例外（human semantic governance）；建议用 revision ledger 和「B supersedes A」的显式取代关系（[durable correction, 2026](https://philarchive.org/archive/ASFCWPv1)，B/C 级证据）。
- 工程侧的具体事故：作者删掉一段，后续 AI 版本把「最新全文」当基线，删除被吸收；记忆整合用「本集完整来源」覆盖了 6,302 字的累计人物档案（[Zenstory #268](https://github.com/zenstory-ai/zenstory/issues/268)、[Ouroboros #1227](https://github.com/razzant/ouroboros/issues/1227)，C 级证据）。

**含义：** 改一章不是改一章。至少要记录：这条修改**取代**了哪条旧事实、哪些 promise/状态/后续章计划依赖它、读者知识是否随之改变。修改后只重检受影响范围，不要整本重写，也不要静默覆盖。

### 结论 8：人物声音漂移是独立失败模式；稳定特质 / 缓慢演化 / 瞬时情绪要分层

- PersonaForge 把长对话失败归因为 trait drift、style collapse、context blindness；它把人物分成 Core Traits（稳定）、Speaking Style Matrix（说话方式）、Dynamic State（动态），报告长对话漂移从 24.8% 降到 6.3%，RoleBench 漂移从 20.4% 降到 8.4%（[PersonaForge, ACL 2026 Findings](https://aclanthology.org/2026.findings-acl.386/)）。
- BRIDGE 指出「所说的、内部表示的、记忆里存的」三者会漂移，形成非对称断裂风险：很多连贯的回合可能被一次高代价矛盾抵消；它把可观察状态、潜在状态、记忆状态在解码前耦合（[BRIDGE, ICML 2026](https://icml.cc/virtual/2026/poster/62193)）。
- PHASE-Tree 把人物状态分成「不可变身份根 + persona + session + moment」四层，不同层有不同的抗修改/更新速率（[PHASE-Tree](https://www.semanticscholar.org/reader/8d429b6b30bd25f986b5baf091bc6e49c0f12b7c)，B 级证据）。
- Persistent Personas 在 100+ 轮对话上发现 persona fidelity 会随时间下降，且与指令遵循存在权衡（[Persistent Personas, 2025](https://arxiv.org/abs/2512.12775)）。
- ConStory-Bench 的人物子类型正是「记忆矛盾、知识矛盾、能力波动、遗忘能力」——这些不是「人设不够详细」，而是**状态没有分层**（[ConStory-Bench](https://huggingface.co/datasets/jayden8888/ConStory-Bench)）。

**含义：** 一张人物卡不能同时承担「他是谁」「他现在在哪/伤在哪/欠谁钱」「他这一刻在用什么语气」。稳定特质、知识边界、关系/资源、瞬时情绪应分开存；写作时只注入当前场景需要的那一层。

### 结论 9：重复/同质化是分布级问题；需要章节级事件去重与全书分布检查

- PNAS 的 Echoes in AI 用 Sui Generis 分数测量「一个情节元素在同 prompt 的多条生成中是否独特」；GPT-4/LLaMA-3 经常重复同一组特异性情节元素组合，而人类故事很少被这样复现；该分数与人类「惊讶度」判断中等相关（[Echoes in AI, PNAS 2025](https://www.pnas.org/doi/abs/10.1073/pnas.2504966122)）。
- PlotMachines 的 n-gram 分析发现：Grover 过度复述大纲点，频率约为金故事的 2 倍；Fusion 则倾向遗漏大纲点；金故事平均每个大纲点约在一段中被提到一次——**理想是「覆盖但不复述」**（[PlotMachines](https://ar5iv.labs.arxiv.org/html/2004.14967)）。
- Avoidance Decoding 通过惩罚与已生成内容的相似度，报告最多 2.6 倍多样性提升、平均 30% 重复减少（[Avoidance Decoding, EMNLP 2025](https://aclanthology.org/2025.emnlp-main.381/)）。
- Agents' Room 的机器故事长度约为人类的两倍（3,000–3,300 词 vs 1,439 词），但最长的机器故事也出现更多重复、更低的 unique-word ratio（[Agents' Room, ICLR 2025](https://arxiv.org/abs/2410.02603)）。

**含义：** 「这一章要写一个新事件」不够；要检查**同一功能是否反复用同一种事件兑现**（例如每次危机都靠「突然出现一个帮手」）。重复检测应同时看 n-gram、事件签名（谁—做了什么—结果）和大纲点覆盖/过覆盖。

### 结论 10：评测要用「硬约束检查 + 校准过的人工/成对评审」；单一自动指标或单一 LLM 总分不可靠

- Agents' Room 用 9,900 次成对人工评分，Fleiss κ = 0.46；LLM evaluator 与人类在系统级 Spearman ρ = 0.62，但条目级只有 0.41；Rouge-L 反而偏向「更贴近参考故事」的端到端基线，而人类并不这么选（[Agents' Room](https://ar5iv.labs.arxiv.org/html/2410.02603)）。
- LitBench 用 43,827 对训练、2,480 对测试；最好的现成 LLM judge（Claude-3.7-Sonnet）与人类偏好一致率只有 73%，训练过的 Bradley-Terry / 生成式 reward model 达到 78%（[LitBench, EACL 2026](https://aclanthology.org/2026.eacl-long.362/)）。
- The Limits of Automatic Evaluation of Creativity 比较 100 篇人类故事与 100 篇 LLM 故事、11 个创造力维度：多数自动指标与人类评分负相关或无相关；没有一种自动方法（包括 LLM judge）是可靠代理；LLM judge 还系统性偏向 AI 生成的故事，似乎依赖表面文体特征（[Limits of Automatic Evaluation, 2026](https://arxiv.org/abs/2608.23705)）。
- The Authenticity Gap 发现标准 5 点 Likert 只恢复了 5 个已知系统偏好中的 2 个，而 SPA 协议恢复了 5 个（[The Authenticity Gap, EMNLP 2022](https://aclanthology.org/2022.emnlp-main.406/)）。

**含义：** 把评测拆成两层。**硬层**：状态矛盾、契约 exit 条件、promise 逾期/空 setup、大纲覆盖、重复、知识边界——这些可以用确定性检查或带证据的窄判断，适合进测试。**软层**：情节、人物、语言、整体偏好——用成对比较 + Bradley-Terry + 多维度人工评分；LLM judge 只做初筛，且必须用人类样本校准、交换顺序、报告一致率。不要用 BLEU/ROUGE、困惑度、单一 LLM 总分或「字数」当质量结论。

---

## 2. 系统速览：规划层级、状态表示、控制信号与评测

这张表把上面结论背后的系统摊开，方便对照。表中「长度」是评测长度，不是系统上限。

| 系统（年份） | 规划层级 | 状态/记忆表示 | 控制信号 | 评测与结论 |
|---|---|---|---|---|
| **Hierarchical Neural Story Generation**（2018） | prompt（前提）→ story | 无显式状态 | prompt expansion | 67.32% 人类偏好；两级即可显著改善连贯/相关 |
| **Plan-and-Write**（2019） | title → storyline（词序列）→ story | 无显式状态 | 静态/动态 schema | 静态规划整体 50.07% vs 动态 30.07%；词序列太粗，作者建议实体/事件/关系 |
| **Re³**（2022） | premise → setting/characters/3-point outline → draft → rewrite → edit | 人物属性字典、前节大纲摘要、最近摘要、DPR 相关上下文、上一段原文 | plan 相关性 rerank + 编辑 | +14% 连贯、+20% 相关；Plan 与 Rewrite 关键，Edit 作用有限 |
| **DOC**（2023） | premise → 顶层 beat → depth-2 → depth-3 事件树；叶子为写作单位 | 设定/人物事实累积到当前大纲项；无时间索引账本 | FUDGE token 级控制器，当前事件摘要 + 未来上下文 | +22.5/+28.2/+20.7；更详细大纲更难执行；控制过强会重复 |
| **RecurrentGPT**（2023） | 下一段 plan（3–5 句） | 长期向量库摘要 + 短期 10–20 句摘要 | plan 作为检索 query；用户可编辑 plan/memory | 在 3k–6k 词上优于 Re³/DOC；两种记忆都有用 |
| **Dramatron**（2023） | title → characters → story beats → locations → dialogue | 用户编辑在各层回填 | prompt chaining | 15 位从业者；长程连贯、重复、刻板印象、版权/归属问题 |
| **Agents' Room**（2024/25） | 规划 agent（conflict/character/setting/plot）→ 写作 agent（exposition/rising/climax/falling/resolution） | 共享 scratchpad；无显式状态账本 | 中央 orchestrator | 1k–2k 词；writing agents 是主要增益；plan-only 弱；更长更重复 |
| **StoryVerse**（2024） | abstract act（goal + prerequisites + placeholders）→ LLM 叙事规划 → 角色动作 | 世界状态变量（位置、属性、关系、记忆） | Act Director 检查前置条件、实例化、placeholder resolution | 游戏概念验证；前置条件/占位符是契约式表示的好例子 |
| **LongWriter / AgentWrite**（2024/25） | prompt → 段落计划（主题 + 描述 + 目标词数）→ 串行写作 | 无显式状态；前文全量 | 每段词数目标 | 2k→20k 词；长度分大幅提升，质量略降；并行损连贯；计划别切太细 |
| **DOME**（2025） | premise → 5 个宏观阶段 → 每阶段 3 个章节大纲 → 边写边展开 | 时间知识图谱四元组 `<subject, action, object, chapter>`；实体检索 + LLM 过滤 | 动态大纲 + 记忆检索 + 冲突分析 | 冲突率 0.56 vs DOC 1.21；去掉记忆冲突 +87.61%；7k 词约 200 次 API/4 小时 |
| **StoryWriter**（2025） | premise → 事件元组图 → 子事件 → 章节分配（可非线性）→ 正文 | 事件图 + Coordinator 按当前事件压缩历史 | 事件校验、ReIO 输出重写 | 8k 词；人类 4.2 vs DOC 3.7/Agents' Room 3.8；去事件大纲掉到 2.5 |
| **STORYTELLER**（2025） | SVO 情节节点（CBN/CPN/CEN）→ STORYLINE 时间链 → NEKG 实体图 → 逐章审校 | SVO + 时间戳事件链 + 叙事实体知识图谱 | 审校/纠错闭环 | 人类偏好 84.33% 胜率；实体状态显式化 |
| **WriteHERE**（2025） | 递归 DAG：检索/推理/写作三类任务，动态分解 | 记忆 + 任务状态（active/suspend/silent） | 调度器按依赖执行 | 2k–8k 词；优于 Agents' Room；批评固定大纲锁死工作流 |
| **LongStory**（2024） | 关键词 + 结构位置 token 递归生成 | 长期 memory + 短期 cheating + 话语位置 token | CWC 权重 + LSP token | 5–50 段；completeness/coherence/repetition 最好或次好；位置 token 减重复 |
| **ConStory-Bench / Lost in Stories**（2026） | 评测基准，不是生成器 | 19 类一致性错误 + 证据对 | ConStory-Checker | 事实/时间错误最多；中段、高熵；类型共现 |
| **CFPG**（2026） | 不提出生成器；提出 Foreshadow–Trigger–Payoff 三元组 | 叙事承诺的因果谓词 | payoff accuracy | LLM 即使有上下文也会漏回收；显式编码有效 |
| **Weaver**（2024） | 写作专用模型族，不是规划层级 | 无长文状态机制 | SFT + Constitutional DPO + RAG/工具 | 写作基准强；缺少长篇叙事一致性评测，不能当规划证据 |

---

## 3. 规划粒度：六种表示法，各自在什么粒度上有效

### 3.1 一张对照表

| 表示法 | 有效粒度 | 过细的后果 | 过粗的后果 | 证据 |
|---|---|---|---|---|
| **Outline（大纲）** | 卷：5 个左右宏观阶段；序列：功能 + 2–4 turn；章：2–5 beat | 句子级大纲 = 重叠软约束，模型只填表；DOC 报告控制越强越重复、叶子不均 | 一句话前提 = 无方向；Plan-and-Write 词序列漏实体/事件/关系 | DOC、Plan-and-Write、AgentWrite |
| **Event graph（事件图）** | 序列/章：事件节点 + 因果/时间边 + 参与者 | 全动作脚本 = 编剧式 blocking，writer 无自由度；事件一改全图崩 | 孤立事件列表 = 因果缺口、机械降神 | StoryWriter、STORYTELLER、DOME |
| **Character state（人物状态）** | 稳定特质/声音 + 知识边界 + 关系/资源 + 瞬时情绪，分层存 | 追踪每个情绪波动 = 噪声；状态文件膨胀成第二份企划 | 一行性格 = OOC；知识矛盾/能力波动 | PersonaForge、BRIDGE、PHASE-Tree、ConStory-Bench |
| **Scene beats（场景节拍）** | 章内 2–5 个：目标/阻力/转折/代价 | 每个手势都写 = 僵硬、机械 | 「发生了一些事」= 中段塌陷、无价值变化 | DOC、Story Grid/02 报告、工程节奏审计 |
| **Promise-payoff ledger（承诺账）** | 全书/卷/序列：ID + setup 证据 + 计划回收窗口 + 状态 + payoff 证据 | 每个母题都当 promise = 假阳性、维护成本爆炸 | 只写「有伏笔」= 遗忘、空 setup | CFPG、ConStory-Bench、StoryMoss/dsh-story |
| **Constraint list（约束清单）** | 5–10 条硬不变量：知识边界、禁止揭示、世界规则、POV | 几十条「必须包含」= 清单式写作，压死因果 | 没有约束 = 设定推翻、视角混乱、机械降神 | StoryState、ConStory-Bench、DOME |

### 3.2 为什么「过细」会僵硬

DOC 的结论最直接：**更详细的大纲让「忠实执行」更难**，因为约束太多且互相重叠；继续加大控制强度会让输出「越来越窄、越来越重复」。这不是模型不听话，而是**软约束之间开始竞争**：当前事件、人物发展、设定、未来上下文同时要求注意力，writer 只能选择最容易满足的那条。

工程上还有一个更隐蔽的版本：**大纲细到事件顺序**时，writer 会把「写事件」当成任务，而不是「让状态发生变化」。结果就是每个 beat 都发生了，但人物的选择没有代价，读者感觉「按表走」。

### 3.3 为什么「过粗」会漂移

Plan-and-Write 的词序列大纲只保留每句一个关键词，作者自己说它遗漏实体、事件、关系；Re³ 的三点大纲也会被模型偏离；DOC 的低层大纲执行仍经常失败。原因是：**粗纲只给主题，不给状态差**。writer 可以写出一段「相关但没用」的文字——它谈到了大纲里的词，却没有把人物从 A 状态推到 B 状态。

### 3.4 推荐粒度：两层半

对 talemate，建议每个规划单位都写成「两层半」：

1. **散文意图（半层）**：2–4 句，说明这一段在故事里的功能、语气、不能写坏的地方。它给 writer 方向感，不参与机器检查。
2. **2–4 个 turn（一层）**：每个 turn 写「从什么价值/状态 → 到什么价值/状态；谁做了选择；代价是什么；谁知道了什么」。不写具体事件。
3. **exit state（一层）**：结束时必须为真的 3–6 条状态谓词（知识、关系、资源、身份、承诺、位置/时间）。它让「这一段有没有写完」可检查。

事件仍然自由：writer 可以换掉「遇到老乞丐」，只要 exit state 和 turn 的功能成立。

---

## 4. 上下文与一致性：检索、摘要、状态、伏笔

### 4.1 检索：计划条件化 + 混合匹配

研究系统的共同做法是「用当前计划/当前事件做 query，取相关切片」：

- RecurrentGPT：下一段 plan 作为长期记忆 query。
- Re³：DPR 选与当前段落相关的上下文。
- StoryWriter：按当前子事件压缩历史，滑动窗口 [2, k-1]。
- DOME：按实体检索四元组，再让 LLM 语义过滤。

工程产品的共同做法更朴素：**关键词/提及匹配**是主流（NovelAI Lorebook 按关键词触发条目，Sudowrite Story Bible 每代注入），而不是纯向量 RAG。原因很实际：专有名词、别名、称谓、地点需要精确命中；纯语义检索会漏掉「沈家二少爷」和「二哥」是同一人。

**建议：** 混合检索。先按实体/别名/地点做精确匹配（保证专名不漏），再用 embedding 补语义相关（保证气氛/主题/前史能进来）；两者都按当前 turn/exit state 过滤，不按「全书重要性」排序。

### 4.2 摘要：用于质感，不用于事实

摘要是有损压缩，而且会二次幻觉。Re³/RecurrentGPT 的摘要能提升连贯，但它们同时保留了「上一段原文」或「人物属性字典」来兜底事实。DOME 的消融更直接：没有结构化记忆时，冲突率从 0.56 升到 4.52。

**建议：**

- **摘要**用于「这一段读起来像什么」「前几章的情绪/语气」；不要用摘要回答「他手上还有没有那封信」。
- **事实**用状态账本/事件四元组；每个事实带章节索引和原文证据。
- **不要存两份摘要**（progress 一份、outline 一份、角色卡一份）；同一件事只留一个权威位置，其他地方引用。

### 4.3 应该存什么、每次现算什么

| 应该存（不可重算/代价高） | 每次现算（可派生） |
|---|---|
| 不可逆决定：谁死了、谁知道了秘密、哪扇门永久关闭 | 全书梗概/故事至今：从 core + 各卷 exit state + progress 现算 |
| 状态 delta：关系、资源、位置、伤势、身份、承诺 | 当前关系/位置/资源的「快照」：从最新 delta 折叠 |
| 读者知识边界与角色知识边界 | 人物名单：从角色卡目录现算 |
| Promise 账：setup 证据、due window、status、payoff 证据 | 序列「还剩什么」：用 exit state 谓词 + promise 状态现判，不存勾选清单 |
| 声音卡：稳定句法/用词/禁忌 | 章数：由字数预算和实际产出决定，不预先锁 |
| 世界规则/术语边界（在 design/，不在 state/） | 全书大纲：不存在，现算 |
| Supersession：B 取代 A、为什么、影响范围 | 「这本书是什么样」的全局观：core + 卷纲现算 |

这张表与 talemate 现有判据一致：**能算出来的不要存；会因一章而变的归 state；只在正文里成立、下次写作不用查的不存。** 新增的只有两条 AI 特有的：**知识边界**与**supersession**。

### 4.4 写到后面推翻前面：一个可执行的 retcon 协议

「后面推翻前面」不一定是错——有时是更好的想法。错的是**静默覆盖**。建议固定成五步：

1. **检测**：用 ConStory-Checker 式的事实对抽取，找出「新文本 vs 旧 canon/旧章节」的矛盾，带原文引用。
2. **裁决**：四选一——改后文、改前文、设定为不可靠叙述/谣言、承认这是有意改变。不要默认「后写的赢」。
3. **记录**：写一条 supersession：`B 取代 A`，附原因、影响范围（哪些章、哪些 promise、哪些人物知识）。
4. **传播**：更新受影响的摘要、promise 状态、后续章计划、读者知识边界；不要重写全书，只重检受影响范围。
5. **复检**：对受影响范围跑一次 lint；如果改的是「谁知道什么」，特别检查悬疑/反讽是否还成立。

**关键区分：** 计划中的未来事件不是 canon。把「打算第 20 章揭晓」写进状态/设定，模型会把它当成「已经发生」；它应该只存在于 `.talemate/plans/` 或序列契约的 obligation 里。

---

## 5. 失败模式与可复用的检测/约束

下表只列**非质量打分**的检测：它们回答「有没有缺/有没有矛盾/有没有逾期」，不回答「写得好不好」。

| 失败模式 | 可复用检测/约束 | 证据与备注 |
|---|---|---|
| **Outline drift（跑题/偏离）** | 每章用「契约 exit state + turn」做覆盖检查：哪些 turn 没发生、哪些 exit 谓词没满足、哪些事件是契约外的；用 entailment/LLM 判断时要求引用原文 | DOC 的 controller 证明「当前事件相关性」可控制；Re³ 的 plan 消融证明 plan 关键；但检查只报警告，不自动重写 |
| **重复情节** | n-gram 重复 + 事件签名（谁—做什么—结果）聚类 + 大纲点覆盖/过覆盖；同一功能连续用同一种事件时报警 | PlotMachines：Grover 过复述约 2 倍，Fusion 遗漏；Echoes in AI：Sui Generis 分布级重复；Avoidance Decoding 可作生成侧缓解 |
| **节奏塌陷 / 中段塌陷** | 章级记录：字数、场景数、turn 数、scene/sequel 比例、张力评级、故事内时间；看 25%–75% 之间主角处境是否实质变化、是否做了不可逆决定、能否删掉 30% 中段章而不丢信息 | 这是工程启发式（C 级），不是论文因果结论；ConStory-Bench 的「中段错误更多」可作为间接支持。只报警告，不规定「每章必须 turn」 |
| **人物声音漂移** | 稳定特质/声音卡 vs 当前对话的 style marker；每场检查「他想要什么/知道什么/在隐藏什么」；把「能力波动/遗忘能力/知识矛盾」列为硬错误 | PersonaForge/BRIDGE/Persistent Personas；ConStory-Bench 人物子类型 |
| **伏笔遗忘** | Promise 账本：open 超期、paid 无 setup、abandoned 无说明、空 setup（删掉 setup 后 payoff 仍成立）；每条带章节/引文 | CFPG：上下文里有也会漏；ConStory-Bench `abandoned_plot_elements`；工程账本可做逾期提醒 |
| **机械降神（deus ex machina）** | Setup-before-use 图：高潮用到的能力/线索/盟友/规则，必须在之前有 setup 节点；「payoff without setup」直接报警；同时检查「setup without payoff」 | CFPG 的 Foreshadow–Trigger–Payoff 三元组；工程上的 setup/payoff 审计。判定只看「有没有前置证据」，不看「是否可信」 |
| **局部修改导致全局不一致** | revision ledger + supersession + 依赖图；修改后只重检受影响章/承诺/知识边界；「B supersedes A」显式记录 | StoryState 的显式状态消融；Dramaturge 的 global-before-local；durable correction 的 propagation audit |
| **事实/时间矛盾** | 抽取 `<subject, action, object, chapter>` 或 SVO 四元组；按时间分组；找「绝对时间/时长/同时性/因果」冲突；带原文引用 | DOME Temporal Conflict Analyzer；ConStory-Checker；重点关心中段/高熵片段 |
| **计划被当成已发生** | 三界分离：作者真相 / 读者已知 / 角色已知；计划只写 obligation，不写 canon；检索时过滤「未来事件」 | 工程实践反复踩坑；ConStory-Bench 的 knowledge contradictions 是同一类错误的文本表现 |
| **清单式填空** | 契约只约束 exit state/turn 功能，不约束事件身份；writer 可以替换事件，只要状态和代价成立；检查「每个 turn 是否有选择与代价」，不检查「是否出现某个道具」 | DOC 的过度控制导致重复；StoryVerse 的 abstract act 用 goal+prerequisite 而非动作脚本 |

**使用原则（与 02 报告一致）：** 硬检查抓「缺了什么」，软诊断问「为什么这样」；两者都只报警告，不自动改稿。AI 能判断「字段不同」，不能判断「不同得有意义」。

---

## 6. 规划与写作的接口：planner 该输出什么形状

### 6.1 三种坏形状

1. **整篇散文大纲**：writer 要么把它当参考、自行发挥（跑偏），要么把它当模板、逐句转写（僵硬）。没有可检查的锚点。
2. **完整事件清单**：每个事件都规定死，writer 只负责填对话和描写；人物选择没有空间，因果变成「因为清单上有」。
3. **巨型状态转储**：把全书人物卡、世界规则、所有前情一次塞进去；注意力被稀释，模型把未来计划当已发生。

### 6.2 契约（contract）与清单（checklist）的区别

| | 契约 | 清单 |
|---|---|---|
| 约束对象 | **状态转移、turn 的功能、承诺、不变量** | **具体事件、顺序、动作** |
| 允许 writer 做什么 | 换事件、换场景、换对话，只要 exit state 和代价成立 | 按序填事件；自由只在措辞 |
| 可检查性 | 可检查 exit 谓词、promise 状态、知识边界 | 可检查「事件是否出现」，但无法检查「是否可信」 |
| 失败模式 | 契约写得太抽象 → 无法检查；写得太细 → 变清单 | 事件写了但人物没变化；因果断裂；机械降神 |
| 适用 | 序列/章规划 | 场景 blocking、动作戏的分镜（局部） |

**一句话：契约说「结束时必须为真什么、过程中必须付出什么」，清单说「先发生 A 再发生 B」。AI 长文需要前者，局部动作戏可以用后者。**

### 6.3 推荐的 planner 输出形状

```markdown
# 序列/章契约

意图（散文，2–4 句）：
  这一段在故事里的功能、语气、不能写坏的地方。

入口状态（只写与 canon 的差异/不确定项）：
  - 谁知道什么、谁不知道什么
  - 关系/资源/位置/时间的未决项

出口状态（必须为真，3–6 条）：
  1. <知识：谁知道了什么>
  2. <关系/资源/位置：从 A 到 B>
  3. <承诺：哪条被推进/回收/埋下>
  4. <不可逆：哪扇门关闭>

Turn（2–4 个，写价值变化，不写事件）：
  T1：从 <价值/状态> 到 <价值/状态>；谁做选择；代价；谁知道了什么
  T2：...

承诺：
  推进/回收/埋下：<promise id>（证据要求：...）

不变量（必须保持为真）：
  - <世界规则/人物知识边界/关系底线>

禁区（不许发生/不许揭示）：
  - <这一章不能揭的真相、不能用的能力、不能出现的视角>

预算：
  字数范围；章数不锁；节奏建议（scene/sequel 比例，可选）
```

**writer 拿到的是「契约 + 当前切片 + 2–5 个 beat + 声音卡」，不是「全书大纲 + 未来十章计划」。** 这样既有自由度，又有可检查的边界。

### 6.4 一个关键设计决定：契约检查放在哪一层

- **章末**：检查本章的 exit delta 是否发生、promise 是否按计划推进、有没有知识边界违规。
- **序列末**：检查序列 exit state 是否满足、不可逆 turn 是否成立、下一序列的 entry 是否接得上。
- **不要逐句检查**：DOC 的过度控制会重复；逐句 contract 会把 writer 变成填表机器。

---

## 7. 评测：哪些指标可用，哪些不可靠

### 7.1 可用的硬指标（适合进测试）

| 指标 | 怎么算 | 注意 |
|---|---|---|
| **契约 exit 满足率** | exit 谓词逐条判断；要求引用正文证据 | 谓词必须是可判定的（谁知道/在哪/关系是否变化），不要写「气氛紧张」 |
| **状态矛盾密度** | 抽取事实对，找矛盾；`矛盾数 / 千词` 或 `矛盾对 / 章` | 参考 ConStory-Checker 的 CED；必须带原文引用，否则误报不可审 |
| **Promise 覆盖率/逾期率** | open/paid/abandoned 计数；超期窗口；空 setup 检测 | 不评价「这个 promise 是否值得开」 |
| **大纲/契约覆盖** | 哪些 turn 没发生、哪些 exit 谓词没满足、哪些事件是契约外 | 只报警告；允许 writer 用等价事件替换 |
| **重复度** | n-gram、事件签名聚类、Sui Generis 式分布分数 | 分布级检查比单章检查更有意义 |
| **知识边界违规** | 角色是否用了不该知道的信息；读者是否被提前告知 | 这是悬疑/反讽的结构基础 |
| **POV/声音 marker** | 视角人物、称呼、句法/用词特征 | 只能抓明显漂移，不能判断「像不像」 |

### 7.2 可用的软指标（人工/校准 LLM）

- **成对比较 + Bradley-Terry**：维度用 Plot / Creativity / Development / Language Use / Overall（Agents' Room 的做法），或 talemate 自己的「情节推进 / 人物 / 语言 / 整体」。
- **SPA 协议**：比 5 点 Likert 更能恢复已知系统差异（Authenticity Gap）。
- **LLM judge**：只做初筛；必须用人类成对样本校准、交换 A/B 顺序、要求引用证据、报告与人类的一致率。Agents' Room 的 LLM judge 系统级 ρ=0.62、条目级 0.41，说明它适合「排序大致方向」，不适合「逐项打分」。
- **人工样本量**：至少覆盖不同卷/序列/章型；不要只抽开头（开头通常最好）。

### 7.3 不可靠的指标

- **BLEU / ROUGE / BERTScore**：与人类偏好不一致；Agents' Room 中 Rouge-L 反而偏向人类不选的端到端基线。
- **困惑度**：衡量语言模型拟合，不衡量叙事。
- **单一 LLM 总分**：LitBench 最好的现成 judge 只有 73% 与人类一致；Limits of Automatic Evaluation 发现 LLM judge 系统性偏向 AI 文本。
- **字数/长度**：LongWriter 明确把长度分与质量分分开；长度不是质量。
- **词汇多样性 alone**：unique-word ratio 高不等于故事好；Agents' Room 的长文更重复，但短时也未必更好。
- **「每章必须有转折」「每卷必须 8 序列」**：这些是结构配额，不是质量指标；02 报告已论证会把故事压成模板。

---

## 8. 对 talemate 卷/序列分层设计的直接建议

### 8.1 卷纲该存什么

现有五格（`docs/outline.md`）方向是对的，不需要新增一层「幕」文档。建议在五格内做**语义加厚**，而不是加一堆字段：

| 现有格 | 建议 | 理由 |
|---|---|---|
| **本卷在全局的位置** | 保留；写「承接上一卷的哪个 exit state、把主线推到哪、给下一卷留下什么新问题」 | 与 02 的 `series_position` 一致 |
| **本卷目标与阻力** | 保留；加「对手的计划是什么、为什么这一卷比上一卷难」 | 只有目标没有对手计划，冲突会变成事件堆 |
| **本卷的情绪曲线** | 保留为软约束；写「爽点类型/位置、读者回报」，不要当结构检查 | 情绪曲线是体验设计，不是硬约束 |
| **卷末状态** | **改写成状态谓词，不写事件**：谁知道了什么、关系/资源/身份怎么变、哪扇门永久关闭、代价是什么 | 这是 AI 最需要的一格；「主角打败了 X」是事件，事件可以换，状态必须保住 |
| **本卷的序列** | 保留「分几段、每段一句功能、预估字数」；每段至少能回答 `question` 与 `irreversible_turn` | 与 02 一致；序列不是章节列表 |

**建议新增的卷级信息（能塞进现有格就塞，不另开文档）：**

1. **`volume_question`**：这一卷在回答什么局部戏剧问题（02 已建议）。
2. **`entry_state`**：只写「与上一卷出口的差异/未决项」，完整状态从 `state/` 现算；不要复制一遍。
3. **`crisis_choice`**：卷末的两难、实际选择、代价（02 已建议）。
4. **`promise_refs[]`**：这一卷必须埋下/推进/回收的 promise ID；账本在 `state/foreshadowing.md`，卷纲只引用。
5. **`knowledge_frontier`**：卷末读者/角色必须知道/仍不知道什么；这是悬疑和反讽的结构基础。
6. **`forbidden[]`**：这一卷不许揭示/不许解决的 3–5 条；防止提前泄底。
7. **`irreversible_decisions[]`**：2–4 个不可逆选择；没有它们，卷末就只是「打了一架」。

**卷纲不要存：** 整本大纲、章数、逐章进度、人物名单、完整 entry state（能算）、未来事件清单（计划不是 canon）。

### 8.2 序列纲该存什么

现有序列纲是「整篇散文，不分小节」，这个形式可以保留。建议在散文里**固定回答七件事**（不必变成表格；可以在 `guide` 里要求）：

1. **功能/意图**：这个序列在故事里干什么（现有）。
2. **`question`**：这一段自己的戏剧问题（02 已建议）。
3. **`entry_state`**：只写与 canon 的差异/不确定项（谁不知道什么、哪条关系未决）。
4. **`exit_state`**：3–6 条必须为真的状态变化（知识/关系/资源/身份/承诺/位置）。
5. **`turns`**：2–4 个价值转变 + 选择 + 代价 + 知识变化；**不写具体事件**。
6. **`irreversible_turn` + `cost`**：这一段结束时哪扇门关闭、谁付出了什么（02 已建议）。
7. **`promises` + `invariants` + `forbidden` + `budget`**：承诺 ID、必须保持的不变量、禁区、字数范围（不锁章数）。

**关键：** 事件仍然自由。「给主角一个进内城的理由」是功能；「主角遇到老乞丐」是事件。契约只约束「进内城后谁知道什么、失去了什么」，不约束「通过谁进去」。

### 8.3 章规划该拿什么

章规划（`.talemate/plans/ch_N.md`）是执行工件，不是作品文档。建议它拿到：

- **当前序列契约的切片**：这一章要兑现哪个 turn、目标 exit delta 是什么。
- **入口快照**：与本章相关的状态事实（不是全部）、POV 人物知识、地点/时间、due promises。
- **2–5 个 scene beat**：目标/阻力/转折/代价；以及「放大点/半句带过」（现有设计已有）。
- **在场人物 + 声音卡 + 他们想要什么/知道什么/隐藏什么**。
- **连续性约束**：必须埋/收/提的 promise；不能违反的知识边界；读者已知 vs 角色已知。
- **字数与节奏预算**：字数范围、scene/sequel 建议（软）。
- **本章预期 exit delta**：给章末状态回写一个目标，避免「写完再想发生了什么」。

**章规划不要拿：** 整本大纲、未来 5–10 章的详细计划、全部人物卡、全部世界规则。只拿「这一章会用到的」。

### 8.4 状态层建议

现有 `docs/state.md` 的三根（characters / foreshadowing / progress）和四条纪律是对的，建议加三类信息，不一定要加新根：

1. **知识边界**：每个角色「知道什么/不知道什么/误以为什么」；以及「读者知道什么」。可以放在角色状态文件里，也可以在 `progress.md` 每章加一行「读者知识变化」。这是 ConStory-Bench 人物知识矛盾的直接对策。
2. **承诺账本化**：`state/foreshadowing.md` 从「伏笔 + 打算哪章收」升级为「ID + setup 证据 + due window + status（open/paid/abandoned）+ payoff 证据」。仍然自由文本，不强制 schema；但规划者每次必须能回答「这条现在什么状态」。
3. **Supersession 记录**：一条 `B 取代 A` 的修订记录，附原因和影响范围。可以放在 `progress.md` 的章末，或单独 `state/revisions.md`（加文件零代码）。没有它，局部修改会静默传播。

**回写形状：** 每章一个 delta，而不是重写整份状态。delta 至少包含：本章改变了哪些事实、谁知道了什么、哪条 promise 状态变了、本章的不可逆决定。当前快照由 delta 折叠现算；不要同时维护「delta + 全量摘要」两份。

### 8.5 哪些应当现算不落盘

- **全书观/故事至今**：core + 各卷 exit state + progress 现算。
- **人物名单**：角色卡目录现算。
- **当前关系/位置/资源**：从最新 delta 折叠现算。
- **序列「还剩什么」**：用 exit state 谓词 + promise 状态现判；不要存勾选清单。这样既保留「序列声明功能不声明事件」，又让进度可检查。
- **章数**：由字数预算和实际产出决定；不预先锁。
- **整本大纲**：不存在；现有设计正确。
- **未来事件**：只存在于计划/契约的 obligation，不进 canon。

### 8.6 与现有实现的落点

| 建议 | 落点 |
|---|---|
| 卷纲加 `volume_question` / `entry_state` / `crisis_choice` / `promise_refs` / `knowledge_frontier` / `forbidden` | `framework/design_spec.ts` 的卷纲规范 + `design/outline/vol_<N>.md` 的 guide |
| 序列纲加契约块（entry/exit/turns/promises/invariants/forbidden/budget） | `design/outline/vol_<N>/s<序号>.md` 的 `guide`；仍保持整篇散文，不加 `sections` |
| 章规划拿契约切片 + 入口快照 + beats + voice/knowledge | `prompts/planner.system.txt`、`prompts/tools/propose-plan.txt`；工件仍在 `.talemate/plans/ch_<N>.md` |
| 状态回写 delta + 知识边界 + supersession | `prompts/tools/propose-plan.txt` / `prompts/planner.system.txt` 的状态回写条；`state/` 自由文本 |
| Promise 逾期/空 setup、契约 exit 检查 | 可在规划者/审校流程里做 lint；不必新增工具，先作为 planner 的自检问题 |
| 不新增「幕」文档、不锁章数、不套 8 序列/15 beat | 保持 `docs/outline.md` 与 02 报告的结论 |

**注意：** 这些是研究建议，不是已落地设计。若采纳，需要同步 `docs/outline.md`、`docs/state.md`、`docs/chapter-planning.md` 的「对齐代码」日期，并按仓库纪律先改文档再改代码。

---

## 9. 特别回答：序列层该是「散文式功能描述」还是「带 entry/exit state 与 turn 的结构化契约」？

### 9.1 答案

**不是二选一。序列层应以「结构化契约」为承重层，散文式功能描述作为附着的意图层。** 如果只能留一个，留契约；但没有散文意图的契约会退化成清单。

用 talemate 的话说：

> 序列纲仍然是一篇散文，但散文里必须能抽出 7 件事：question、entry_state、exit_state、2–4 个 turn、irreversible_turn/cost、promises、invariants/forbidden/budget。事件不写死。

### 9.2 为什么不能只有散文

1. **散文没有可检查的锚点。** 「给主角一个进内城的理由」是功能，但模型可以写一个「进了内城但什么都没改变」的段落，读起来还像那么回事。ConStory-Bench 的事实/时间错误、DOME 的冲突率都说明：**没有状态谓词，就无法判断「这一段有没有写完」。**
2. **散文无法约束知识边界。** 悬疑依赖「读者知道什么/角色知道什么」。散文可以写「气氛紧张」，但不能防止模型让角色说出他不该知道的事。ConStory-Bench 的 knowledge contradictions 是真实高频错误。
3. **散文无法做局部修改的传播审计。** 改一个事件后，哪些 promise/状态/后续章受影响？没有契约，只能靠人重读。

### 9.3 为什么不能只有结构化契约

1. **契约一旦写成事件清单，就会杀死事件的可替换性。** DOC 的详细大纲 + 强控制产生更窄、更重复的输出；AgentWrite 明确说不要把计划切太细；Plan-and-Write 的词序列太粗，但「更细的事件表」并不会自动更好。
2. **契约无法表达语气、主题反讽、留白。** 「这一场要让读者比主角早半拍意识到不对」不是状态谓词，但它决定成败。
3. **契约写得太抽象就不可检查。** 「关系变好」不是谓词；「他从‘只信任自己’变为‘愿意把后背交给 A’」才是。

### 9.4 折中方案：一个 7 字段的「轻契约」

建议序列文件仍然是一篇散文，但在开头或结尾放一个很短的契约块（不是表格也可以，只要字段能抽出来）：

```markdown
## 契约
question: 这个序列在回答什么？
entry: 只写与 canon 的差异/不确定项
exit:
  1. 谁知道了什么
  2. 关系/资源/位置从 A 到 B
  3. 哪条 promise 被推进/回收/埋下
  4. 哪扇门永久关闭
turns:
  T1: 从 <价值> 到 <价值>；谁选择；代价；谁知道
  T2: ...
irreversible: 哪一步不能撤回；代价是什么
promises: <id...>
invariants: <必须保持为真>
forbidden: <不许揭示/不许发生>
budget: <字数范围，不锁章数>
```

**写作时的自由度：**

- writer 可以换事件、换场景、换对话、加新人物（走现有「先立人再写」的规则），只要 exit 谓词、turn 的功能、promise 状态成立。
- writer 可以「超额」完成一个 turn（更有力的转折），但不能跳过 exit 谓词。
- 如果写作中发现更好的走法，允许改契约，但要走「先改契约、再写正文」的顺序；不能让正文静默推翻契约。

**检查时的克制：**

- 只在章末/序列末检查，不逐句检查。
- 只报警告，不自动重写。
- 每条 exit 谓词必须能指向正文证据；指不到就说明契约写得太抽象，先改契约。
- 如果用户改的是事件，契约通常不变；如果用户改的是 exit state，下游序列必须重检。

### 9.5 一句话总结

**散文负责「为什么写这一段」，契约负责「写完时什么必须为真」。** 对 AI 生成来说，后者是防止漂移的承重墙；对小说创作来说，前者是防止契约变成清单的灵魂。两者都要，但不要混成一张表。

---

## 10. 关键来源

### 规划、层级与控制

1. Yang et al. **DOC: Improving Long Story Coherence With Detailed Outline Control**. ACL 2023. <https://aclanthology.org/2023.acl-long.190/> · arXiv: <https://arxiv.org/abs/2212.10077>
2. Yang et al. **Re³: Generating Longer Stories With Recursive Reprompting and Revision**. EMNLP 2022. <https://aclanthology.org/2022.emnlp-main.296/> · arXiv: <https://arxiv.org/abs/2210.06774>
3. Zhou et al. **RecurrentGPT: Interactive Generation of (Arbitrarily) Long Text**. arXiv 2023. <https://arxiv.org/abs/2305.13304>
4. Wang, Zhou, Ledo. **StoryVerse: Towards Co-authoring Dynamic Plot with LLM-based Character Simulation via Narrative Planning**. FDG 2024. <https://arxiv.org/abs/2405.13042>
5. Huot et al. **Agents' Room: Narrative Generation through Multi-Step Collaboration**. ICLR 2025. <https://arxiv.org/abs/2410.02603>
6. Mirowski et al. **Co-Writing Screenplays and Theatre Scripts with Language Models: Evaluation by Industry Professionals**. CHI 2023. <https://dl.acm.org/doi/10.1145/3544548.3581225> · arXiv: <https://arxiv.org/abs/2209.14958>
7. Bai et al. **LongWriter: Unleashing 10,000+ Word Generation from Long Context LLMs**. ICLR 2025. <https://arxiv.org/abs/2408.07055>
8. Yao et al. **Plan-and-Write: Towards Better Automatic Storytelling**. AAAI 2019. <https://arxiv.org/abs/1811.05701>
9. Fan, Lewis, Dauphin. **Hierarchical Neural Story Generation**. ACL 2018. <https://arxiv.org/abs/1805.04833>
10. Wang et al. **Generating Long-form Story Using Dynamic Hierarchical Outlining with Memory-Enhancement (DOME)**. NAACL 2025. <https://aclanthology.org/2025.naacl-long.63/> · arXiv: <https://arxiv.org/abs/2412.13575>
11. **StoryWriter: A Multi-Agent Framework for Long Story Generation**. CIKM 2025. <https://arxiv.org/abs/2506.16445>
12. **STORYTELLER: Structured Plot Planning with Entity Graphs**. Findings of ACL 2025. <https://aclanthology.org/2025.findings-acl.1071/> · arXiv: <https://arxiv.org/abs/2506.02347>
13. Xiong et al. **Beyond Outlining: Heterogeneous Recursive Planning for Adaptive Long-form Writing (WriteHERE)**. EMNLP 2025. <https://aclanthology.org/2025.emnlp-main.1254/> · arXiv: <https://arxiv.org/abs/2503.08275>
14. Park, Yang, Jung. **LongStory: Coherent, Complete and Length Controlled Long Story Generation**. PAKDD 2024. <https://arxiv.org/abs/2311.15208>
15. Wang et al. **Weaver: Foundation Models for Creative Writing**. arXiv 2024. <https://arxiv.org/abs/2401.17268>
16. Teleki et al. **A Survey on LLMs for Story Generation**. EMNLP 2025. <https://mariateleki.github.io/pdf/EXTENDED_A_Survey_on_LLMs_for_Story_Generation.pdf>
17. Wang, Kreminski. **Can LLMs Generate Good Stories? Insights and Challenges from a Narrative Planning Perspective**. IEEE CoG 2025. <https://arxiv.org/abs/2506.10161>

### 状态、记忆、一致性与伏笔

18. Li et al. **Lost in Stories: Consistency Bugs in Long Story Generation by LLMs / ConStory-Bench**. Findings of ACL 2026. <https://aclanthology.org/2026.findings-acl.410/> · arXiv: <https://arxiv.org/abs/2603.05890> · 数据: <https://huggingface.co/datasets/jayden8888/ConStory-Bench>
19. **Codified Foreshadowing-Payoff Text Generation (CFPG)**. arXiv 2026. <https://arxiv.org/abs/2601.07033>
20. **StoryState: Agent-Based State Control for Consistent and Editable Storybooks**. arXiv 2026. <https://arxiv.org/abs/2602.01305>
21. **Plug-and-Play Dramaturge: A Divide-and-Conquer Approach for Iterative Narrative Script Refinement via Collaborative LLM Agents**. arXiv 2025. <https://arxiv.org/abs/2510.05188>
22. Yao et al. **PlotMachines: Outline-Conditioned Generation with Dynamic Plot State Tracking**. ACL 2020. <https://arxiv.org/abs/2004.14967>
23. **PersonaForge: Psychology-Grounded Dual-Process Architecture for Personality-Consistent Role-Playing Agents**. Findings of ACL 2026. <https://aclanthology.org/2026.findings-acl.386/>
24. **BRIDGE: Triangular Fixed-Point Refinement for Long-Horizon Persona Consistency**. ICML 2026. <https://icml.cc/virtual/2026/poster/62193>
25. **Persistent Personas? Role-Playing, Instruction Following, and Safety in Extended Interactions**. arXiv 2025. <https://arxiv.org/abs/2512.12775>
26. 关于持久修正的 revision ledger / semantic propagation：<https://philarchive.org/archive/ASFCWPv1>（B/C 级证据，用于「局部修改传播」的概念框架）

### 重复、节奏与评测

27. Xu et al. **Echoes in AI: Quantifying Lack of Plot Diversity in LLM Outputs**. PNAS 2025. <https://www.pnas.org/doi/abs/10.1073/pnas.2504966122> · arXiv: <https://arxiv.org/abs/2501.00273>
28. Park, Yang, Jung. **Avoidance Decoding for Diverse Multi-Branch Story Generation**. EMNLP 2025. <https://aclanthology.org/2025.emnlp-main.381/>
29. **LitBench: A Benchmark and Dataset for Reliable Evaluation of Creative Writing**. EACL 2026. <https://aclanthology.org/2026.eacl-long.362/>
30. **The Limits of Automatic Evaluation of Creativity in Large Language Models**. arXiv 2026. <https://arxiv.org/abs/2608.23705>
31. **The Authenticity Gap in Human Evaluation**. EMNLP 2022. <https://aclanthology.org/2022.emnlp-main.406/>

### 工程实践（C 级，只作经验参考）

32. Sudowrite vs NovelAI 的产品对比（Story Bible / Lorebook / 上下文与连续性）：<https://sudowrite.com/blog/sudowrite-vs-novelai-2026/>
33. oh-story 的 AI 长篇小说一致性工程笔记（上下文选择、作者真相/读者知识、每章 delta）：<https://github.com/zenstory-ai/oh-story-claudecode/blob/main/docs/ai-long-novel-character-consistency.md>
34. StoryMoss 的伏笔回收看板（unpaid/paid/abandoned、逾期提醒、payoff ledger）：<https://github.com/91zgaoge/StoryMoss>
35. dsh-story 的 story ledger / 伏笔债审计 / append-only event sourcing：<https://www.npmjs.com/package/@wang--lin--chang/dsh-story>
36. pacing-structure-collapse 的节奏审计清单（middle sag、scene/sequel ratio；启发式，不是研究结论）：<https://skilldb.dev/skills/novel-audit-skills/pacing-structure-collapse>

---

## 11. 最后三句话

1. **卷/序列层的核心不是「把事件写细」，而是「把状态变化写清楚」。** 事件可以换，状态必须保住；这是 AI 生成和人类改纲共同需要的约束。
2. **契约是承重墙，散文是灵魂。** 只有契约会变成填表，只有散文会漂移；两者都要，但契约只约束 exit state、turn 的功能、承诺和不变量。
3. **评测要分层。** 硬检查抓「缺了什么/矛盾了什么」，软评审问「好不好」；不要把 BLEU、单一 LLM 总分或字数当成质量结论。

---

## 12. 方法与核查说明

### 12.1 证据分级

| 级别 | 含义 | 本文中的例子 |
|---|---|---|
| **A** | 同行评审，含人工评测或明确的自动一致性指标 | DOC、Re³、Agents' Room、Dramatron、Plan-and-Write、Hierarchical Neural Story Generation、DOME、LongWriter、LongStory、STORYTELLER、WriteHERE、LitBench、ConStory-Bench |
| **B** | 预印本或系统论文，结果可核但尚未充分复现 | RecurrentGPT、CFPG、StoryState、PersonaForge、BRIDGE、Plug-and-Play Dramaturge |
| **C** | 工程实践/产品文档，只能当经验，不能当因果证据 | Sudowrite Story Bible、NovelAI Lorebook、各类伏笔账本、节奏审计清单 |

**一个必须记住的外推限制：** 上述系统的评测长度大多在 **1,000–10,000 词**，只有 LongWriter/StoryWriter 触及 8k–20k 词；talemate 的目标是十万字级、多卷、多序列。因此本文的结论是「方向性证据」，不是「在 100 万字上已验证」。凡是涉及「卷」的结论，都是把已验证的章节级机制上推一层，必须用 talemate 自己的样本验证。

检索方式：ACL Anthology、arXiv、OpenAlex、GitHub 以及产品文档；优先读论文正文/HTML 版，摘要页不足以支撑的细节会明确标注。2025–2026 年的部分工作仍是预印本，结论以「机制」为主，不以其绝对分数为定论。

### 12.2 点名但未能核实的条目

| 点名 | 核查结果 | 本文如何处理 |
|---|---|---|
| **SCOPE** | 在 arXiv、ACL Anthology、OpenAlex 中没有找到同名且做长篇叙事生成的系统。2025–2026 年同名工作至少包括：自博弈训练框架、文本环境层次规划、人格条件叙事、KV cache 优化；它们都不是「长文分层规划系统」。 | 不引用为证据。最接近你描述的是 **DOME**（动态层次大纲 + 记忆增强），本文用 DOME 代替。 |
| **MetaWriter** | 只找到「科学同行评审写作支持」与「手写文本识别」两个同名系统；没有小说/长文生成框架。 | 不引用为证据。若你手上有具体链接，可以补一轮。 |
| **Weaver** | 是写作专用模型族（1.8B–34B），做写作数据预训练、指令回译、Constitutional DPO；**不是分层规划系统**，也没有专门的长篇叙事一致性评测。 | 只在「系统速览」里注明其边界，不用它支撑规划结论。 |
| **StoryVerse** | 是游戏叙事的概念验证，不是小说生成系统；但它用 **abstract act + prerequisites + placeholders** 把「叙事目标」变成可实例化的契约，对本文的序列契约问题有直接参考价值。 | 作为「契约式表示」的证据，而不是长文评测证据。 |
| **Agents' Room / DOC / Re³** | 都是章节级或短篇级（约 1k–8k 词），不是长篇。 | 用其机制与消融，不用其绝对分数外推整本书。 |
