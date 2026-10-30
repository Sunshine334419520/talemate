# 评测地基与可观测性 · 实践手册（Stage 1–2）

> **这份文档是什么**：一份可以照着做的工程手册。前半部分是**通用知识**（任何 agent 项目都适用），后半部分是**在 talemate 上的落地方案**（具体到改哪个文件、跑什么命令）。
>
> **它解决的问题**：把「我觉得这个 prompt 变好了」换成「改了 X，完成率从 62% 到 71%，净翻转 8/30，p<0.05，成本 +¥0.4/章」。
>
> **对应规划**：[能力评估与补强规划.md](能力评估与补强规划.md) 的 Stage 1（评测地基）与 Stage 2（可观测性）。本手册是那两节的展开版——那边写"做什么"，这里写"怎么做、做到什么程度算完"。
>
> **相邻文档**：[deep-dive/part6-evals.md](deep-dive/part6-evals.md)（eval 入门）、[handbook.md](handbook.md)（5.1 可观测性）、[learning-roadmap.md](learning-roadmap.md)（Phase 0）。
>
> **时间预算**：Stage 1 十步 ≈ 12 个工作日；Stage 2 四步 ≈ 6 个工作日。加上返工和调试，按 4–5 周排。
>
> **实践项目**：`D:\code\talemate`（TS + Bun，文件系统存储，无数据库）。

---

## 0. 怎么用这份文档

### 0.1 三条使用纪律

1. **一步一步做，不要跳。** 第 1 步的产物是第 2 步的输入。跳步的典型后果：先做 judge，做到一半发现没有 trace 可判，只能重跑模型——白花钱。
2. **每步都有「验收命令」。** 跑不通就不算完成。文档里的命令是形状，具体参数按你仓库实际调整。
3. **每完成一步，写一条 ADR**（半页）：为什么这么做、放弃了什么、什么条件下该推翻。这是 9 分档里「判据可迁移」的证据来源，也是模型换代后重估的唯一依据。

### 0.2 你会得到什么

| 产出 | 位置（talemate 内） | 它能证明什么 |
|---|---|---|
| 一套可复现的实验台 | `eval/` | 「我能用数据回答 prompt 问题」 |
| 一份基线报告 | `reports/baseline-*.md` | 「我有一个持续跑着的质量基线」 |
| 结构化 trace | `src/trace/` + `traces/` | 「我知道每一次运行死在哪一步」 |
| 对比报告若干 | `reports/<date>-<topic>.md` | 「我的改动是可归因的」 |
| ADR 若干 | `docs/adr/` | 「我的判据有出处、有边界、可被推翻」 |

### 0.3 与 9–10 分的对应关系

| 9 分档的要求（原文） | 本手册哪一步交付 |
|---|---|
| 能把判据沉淀成可复用判据 | 第 2 章（原则）+ 每步的 ADR |
| 判据之间互相引用 | 第 6 章指标字典（每个指标引用一条原则） |
| 用实验而不是感觉回答 prompt 问题 | 第 3 章 + 第 7 章 S1-9 |
| 有持续跑着的质量基线 | S1-10（CI 分层） |
| 对「模型换代后哪些防护该删」有第一性判断 | 第 9 章（把 Stage 1 的机器用于模型消融） |

> **10 分不是"做得更多"，是"提出被别人复用的机制"。** 这份手册里有两个候选：**replay 即 provider**（用既有抽象承载回放，零侵入）和**评测即 trace 的下游**（同一份事件同时喂 eval 和 viewer）。把这两个做成可移植的形态，就是 10 分的形状。

---

## 1. 心智模型

### 1.1 为什么普通测试测不了 agent

| 系统类型 | 输入→输出 | 判据 | 工具 |
|---|---|---|---|
| 普通软件 | 确定 | 相等 | 单元测试 |
| ML 模型 | 统计 | 分布 | 离线指标（accuracy/F1） |
| **Agent** | **轨迹**（多步、带工具、带副作用） | **程度性 + 主观 + 多目标** | **eval + trace** |

Agent 的特殊性在三点：

1. **输出空间是轨迹，不是字符串**。「写了什么」只是一部分，「怎么走到那里的」同样重要——调了哪些工具、有没有绕路、上下文何时被压缩。
2. **正确是程度性的**。「这段正文好不好」没有 `==`，只有 rubric 上的位置。
3. **失败是长尾的**。同一个 bug 可能一百次里出现三次，而你在 CI 里永远复现不了——除非有 trace。

### 1.2 两个坐标系

```
          离线（eval）                        在线（observability）
   ┌──────────────────────────┐      ┌──────────────────────────┐
   │ 可重复、可比、可批量      │      │ 真实、不可重复、单次      │
   │ 慢、花钱、样本有限        │      │ 快、免费、样本无限        │
   │ 回答：这批改动整体好不好  │      │ 回答：这一次为什么坏      │
   │ 产物：报告                │      │ 产物：trace               │
   └────────────┬─────────────┘      └────────────┬─────────────┘
                │                                  │
                └────────── 同一份事件 schema ──────┘
                     eval 用 trace 作为原料（回放）
                     trace 用 eval 的 case 作为已知坏样本
```

**这是本手册最重要的一张图**。它决定了实施顺序：**先定事件 schema，再往上长两头**。反过来做（先建 eval 再想 trace）会重写两遍。

### 1.3 闭环

```
   假设（"加了这条纪律，模型会少绕路"）
        ↓
   单变量改动（只改一处，且证明它真的改了）
        ↓
   跑固定 case 集 × N 次（同模型、同参数、同环境）
        ↓
   配对比较（同一 case 的 A/B 结果，不是两个百分比相减）
        ↓
   决策（保留 / 回滚 / 再改；阈值事先定）
        ↓
   沉淀（失败样本进回归集；结论进 ADR；指标进基线）
        └──────────────────────────────→ 回到假设
```

没有这一步闭环，eval 就只是「跑了一下」。闭环的每一环都对应第 2 章的一条原则。

---

## 2. 八条第一原则

这八条是后面所有设计的依据。**它们不是"最佳实践"，是推论链**——违反任何一条，后面的数字就不可信。

### P1 · 可判定性：不能判定的「好」不是指标，是意见

把「写得好」拆成「必须出现 X」「不得出现 Y」「满足 A、B、C 三条中的两条」。拆不出来的维度，说明你还没想清楚要什么——先去想清楚，别急着建 eval。

**推论**：rubric 的每一档都要有**锚点样本**（1 分长什么样、3 分、5 分）。没有锚点的 5 分制，等于让 judge 自由发挥。

### P2 · 可复现性：没 pin 的实验不是实验

一次运行必须能唯一确定：**输入 + prompt 字节 + 模型 + 参数 + 代码版本 + 环境**。少一样，结论就不可复核。

**推论**：「prompt v2」不算版本号，因为 v2 会被原地改。要 **hash**。

### P3 · 单变量：同时改两处 = 没有信息

涨了不知道是谁的功劳，跌了不知道是谁的锅。

**推论**：允许一次改两处，但必须能分别归因——要么跑两次各改一处，要么有办法在报告里拆开。

### P4 · 替换必须被证明发生

这条从 talemate 的 `probe` 推广而来，适用于**所有装配动作**：prompt 片段替换、工具集增删、模型参数修改、case 初始状态注入。

> 替换串没命中 → 变体静默退化成 baseline → 你得到「没差异」的结论 → **假阴性，且完全无感**。

**推论**：装配层必须断言，失败即抛。这条的价值不在于防错，在于**让"实验没做成"和"实验做成了但没效果"可区分**。

### P5 · 对比优于绝对

人（和 judge）的绝对打分漂移很大：同一份输出今天 4 分明天 3 分。但「这两个哪个好」稳定得多。

**推论**：能用 pairwise 就不用绝对分；能盲测就不告诉评委版本号；必须有 baseline。

### P6 · 噪声先于结论

在改任何东西之前，先测**同一配置重复跑的波动**。这就是噪声地板。小于地板的差异不叫「变好」。

**推论**：见 §3.4 的具体数字——30 个 case 的评测集，62%→71% 很可能只是噪声。

### P7 · 测量成本必须低

一次全量 eval 如果需要 2 小时 + 50 块，你一个月只会跑一次。一个月跑一次的 eval，等于没有。

**推论**：分层（快速子集 / 全量）、回放（不重跑模型）、缓存（同输入复用结果）。

### P8 · 失败模式 > 总分

总分告诉你「变没变好」，失败桶告诉你「为什么、该修哪」。

**推论**：失败必须**分类**，不能只有一个 `false`。分类表是 eval 的一等公民，和指标同级。

### P9 · 结构不可表达 > 事后检查（承接）

能靠结构保证的，不要靠判据。比如「用户看过的 == 落盘的」由「apply 拿不到正文」保证，而不是由「检查一下有没有夹带」保证。

**推论**：eval 应该是**测量仪**，不是**门禁**。门禁靠结构和类型，不靠 eval 分数。

---

## 3. 怎么判断一个 prompt 是好是坏

### 3.1 先把「好」拆成四个维度

同一个 prompt 可以在一个维度上变好、另一个维度上变坏。**判断之前必须先声明在哪个维度、愿意付什么代价**，否则两个人会拿不同的数吵同一件事。

| 维度 | 问题 | 指标 | 可接受的代价 |
|---|---|---|---|
| **能力上限** | 它能不能做对 | pass@k（k 次里有 1 次对） | 可以贵、可以慢 |
| **可靠性** | 它是否稳定做对 | pass^k（k 次全对）、方差 | 必须稳，宁可慢 |
| **经济性** | 做对要多少钱 | token/任务、成本 delta、P50/P95 延迟 | 可以略贵，不能翻倍 |
| **可维护性** | 改动会不会污染别处 | diff 大小、载体归属、耦合面 | 不能留下隐式依赖 |

产品场景（talemate 写正文）通常要求**可靠性优先**：一章写坏了的代价远大于多花两分钱。所以 pass^3 比 pass@3 更该作为主指标。

### 3.2 五种判据的强度阶梯

按「能回答什么」排序，不是按成本。**越往上越便宜、越客观、越只能测表层；越往下越贵、越主观、越能测真实价值。**

| 级别 | 判据 | 能回答 | 不能回答 | 偏差来源 | 单次成本 |
|---|---|---|---|---|---|
| L1 | **结构/契约断言** | 格式合法吗、字段全吗、引用的工具存在吗 | 内容好不好 | 几乎无 | ~0 |
| L2 | **行为断言** | 该调的调了吗、该写盘写了吗、有没有越权 | 措辞好不好 | 断言写错 | ~0 |
| L3 | **规则化启发式** | 长度、句长分布、禁用词、重复率 | 语义质量 | 指标选偏 | ~0 |
| L4 | **LLM-as-judge + rubric** | 覆盖度、风格、逻辑一致性 | 「读者会不会追」 | judge 自身的偏好 | ¥0.01–0.1 |
| L5 | **成对盲测（pairwise）** | A 和 B 哪个更好 | 好多少 | 顺序偏差、评委疲劳 | 人 5–15 min |
| L6 | **真实用户信号** | 用户接受/拒绝/修改吗 | 为什么 | 幸存者偏差、样本自选 | 免费但慢 |

**实践配比**：L1+L2 覆盖 100% 的 case（必须全过，不过说明 case 或装配坏了）；L3 用来做廉价监控；L4 做日常回归；L5 做关键决策（改主线 prompt 时）；L6 做长期校准（每月对齐一次 L5 的结论）。

### 3.3 各级判据怎么写

#### L1 结构断言

只查「不可能错」的东西。它的作用不是测质量，是**保证后续测量有意义**——输出格式都不合法，judge 打分是噪声。

```ts
// eval/checks/structural.ts
export type Check =
  | { kind: "fileExists"; path: string }
  | { kind: "fileMatches"; path: string; re: string }
  | { kind: "jsonParses"; path: string }
  | { kind: "notContains"; path: string; text: string }
  | { kind: "wordCountBetween"; path: string; min: number; max: number };

export function runCheck(c: Check, root: string): { ok: boolean; detail?: string } {
  switch (c.kind) {
    case "fileExists":
      return { ok: existsSync(join(root, c.path)) };
    case "fileMatches": {
      const t = readFileSync(join(root, c.path), "utf8");
      return { ok: new RegExp(c.re).test(t) };
    }
    // ...
  }
}
```

talemate 专属的一条高价值 L1：**prompt 里提到的工具 id，必须在工具注册表里存在**。`prompts/tools/<id>.txt` 与 `BUILTIN_TOOLS` 是 1:1 的，写错一个 id 就会让模型去调一个不存在的工具——这是纯静态检查，零成本。

#### L2 行为断言

不看输出文本，看**世界状态的变化**。

```ts
export type BehaviorCheck =
  | { kind: "toolCalled"; name: string }
  | { kind: "toolNeverCalled"; name: string; why: string }
  | { kind: "toolCalledWithPath"; name: string; pathRe: string }
  | { kind: "fileWrittenUnder"; dir: string }
  | { kind: "noWriteUnder"; dir: string; why: string }
  | { kind: "turnEndedWithoutProposal" };   // 该交回用户的时候有没有交回
```

`toolNeverCalled` 是**反向断言**，比正向断言更能抓到「模型过度作为」——而模型的默认失败模式正是过度作为（多调、多写、多问）。talemate 的 `probe` 判定 `advanced` / `stopped` 用的就是这一类：不看正文（正文里"列菜单"和"替你决定"都含"角色"二字，关键词分不开），只看「有没有对 `characters/` 目录动手」这条硬证据。

#### L3 启发式

廉价、可解释、适合做监控，不适合做决策。示例（talemate 真实用过的）：

```ts
const stats = {
  avgSentenceLen: mean(sentences.map(s => s.length)),
  longSentenceRatio: sentences.filter(s => s.length >= 40).length / sentences.length,
  causalConnectives: (text.match(/因为|所以|于是|结果|没想到|原来/g) ?? []).length,
  dialogueRatio: dialogueChars / totalChars,
};
```

**它们只能当"仪表"，不能当"裁判"**。理由是 L3 极易被优化：告诉模型"多用连接词"，连接词数量立刻上去，故事质量不动。所以 L3 指标的变化必须配合 L4/L5 才能下结论——这条纪律叫**「可优化指标不能单独作为验收标准」**。

#### L4 LLM-as-judge

三个设计决定：

**(a) 判据要可判定，且带锚点。** 不要写「写得好不好」，写：

```ts
const RUBRIC = `
维度：讲述感（1–5）
1 = 像镜头在切、像提纲在推进
3 = 有前因后果，但叙述者时有时无
5 = 像有人在讲故事：有前因后果，有叙述者的判断和态度

只输出 JSON：{"score": 1-5, "evidence": "原文里支持这个分数的一句", "reason": "≤30字"}
`;
```

`evidence` 字段是关键：**要求 judge 引用原文**，能挡掉一半的幻觉打分，也让你复核时不用重读全文。

**(b) 用不同的模型/不同的 prompt 判断。** 执行和评判是两种能力。judge 可以用更小更便宜的模型（判「是否满足标准」比「写出好文章」简单得多），而且小模型往往更严格。

**(c) judge 必须被校准。** 见 §4.6。

#### L5 成对盲测

同一 case，A/B 两版输出**打乱顺序、隐去版本**，只问「哪个更好 / 平局」。talemate 的 `style-bench` 已经实现了这个骨架（`blind/<case>/A.md`、`key.json`），这正是它比多数人的 eval 更专业的地方——**先读 blind，再看 key**。

统计上用**符号检验**（sign test）：只看「A 赢 / B 赢 / 平」，不看分数。

#### L6 用户信号

talemate 有一个别人没有的信号：**主编否决率**——用户拍板时「接受 / 拒绝 / 提意见」的分布。

口径必须写清：分母是**被拍板的提案数**，不是生成的提案数（否则漏掉「模型自己放弃了」那部分）。这个指标的价值在于它是**线上真实分布**，不花钱，且直接对应产品的最终质量。

### 3.4 统计工具箱：五个必须会的动作

#### 动作 1：测噪声地板

改任何东西之前，同一配置跑 10 次：

```ts
// 结果形如 [1,0,1,1,1,0,...]
const rate = mean(xs);
const sd = Math.sqrt(rate * (1 - rate) / xs.length);
```

30 个 case、真实成功率 65% 时，**sd ≈ 8.7 个百分点**。1 个 case 的翻转 = 3.3pp。

#### 动作 2：配对比较（McNemar）

同一批 case 跑 A/B，只数**翻转**：

```
b = A 失败、B 成功的 case 数
c = A 成功、B 失败的 case 数
```

```ts
const binom = (n: number, k: number): number => {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
};

export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += binom(n, i);   // C(n,i)
  return Math.min(1, (2 * tail) / 2 ** n);
}
```

**n=30 时的判定表**（单侧、双侧近似）：

| 净翻转 | 双侧 p | 结论 |
|---:|---:|---|
| 3/0 | 0.25 | 噪声 |
| 5/0 | 0.063 | 方向性证据，不显著 |
| **6/0** | **0.031** | **勉强显著** |
| 8/0 | 0.008 | 显著 |

> **这张表是整份文档里最该记住的数字。** 它意味着：30 个 case 的二值通过率，**只能检出约 20 个百分点的改动**。想检出 10pp，要么加 case，要么上连续分（rubric 1–5 分的信息量是 0/1 的 3–4 倍）。

#### 动作 3：连续分的置信区间（bootstrap）

rubric 分不要只报均值，报区间：

```ts
export function bootstrapCI(xs: number[], level = 0.95, iters = 10_000): [number, number] {
  const n = xs.length, means: number[] = [];
  for (let i = 0; i < iters; i++) means.push(mean(Array.from({ length: n }, () => xs[(Math.random() * n) | 0])));
  means.sort((a, b) => a - b);
  const lo = ((1 - level) / 2 * iters) | 0;
  return [means[lo], means[iters - 1 - lo]];
}
```

用配对差值做 bootstrap，得到的是「差值的区间」——**区间不跨 0 才算有差异**。

#### 动作 4：pass@k 与 pass^k

```ts
// k 次里有 1 次通过 = 能力上限
const passAtK = (runs: boolean[], k: number) => runs.slice(0, k).some(Boolean);
// k 次全通过 = 可靠性
const passHatK = (runs: boolean[], k: number) => runs.slice(0, k).every(Boolean);
```

两个数差距大 = 能力有、稳定性差 → 该加约束/降温/拆步骤，而不是换 prompt。

#### 动作 5：样本量估算（够用版）

不用记公式，记这张表（粗估：配对设计，α=0.05，功效 80%）：

| 想检出的效应 | 二值判据需要 | rubric 连续分需要 |
|---|---:|---:|
| 20pp | ~30 | ~15 |
| 10pp | ~120 | ~40 |
| 5pp | ~400+ | ~120 |

**结论**：30–50 个 case + 二值，只能做大改动的回归网；要做精细调优，必须上**连续分 + 配对**。

### 3.5 防作弊：五个会毁掉结论的坑

| 坑 | 机制 | 对策 |
|---|---|---|
| **过拟合 test set** | 反复在同一批 case 上调，分数必然涨 | 留出集（holdout）：调参用 30 个，验收用另 10–20 个，**验收前不看** |
| **judge 偏爱自己的风格** | 同族模型互相包庇 | judge 用不同厂商/更小模型；人工抽检 10%；算 κ |
| **顺序偏差** | A 总在左，评委倾向选 A | 每对随机交换左右；pairwise 时报告左右平衡 |
| **可优化指标** | 模型学会了"看起来像" | L3 指标只做仪表；验收必须 L4/L5 |
| **选择偏差** | 只跑成功的 case、只报好数 | runner 必须记录**全部** run（含 error/timeout），报告含失败桶 |

### 3.6 决策规则：把「值不值」事先定死

事后看数字找理由，是人类最强的能力，必须用规则挡住。改之前先写下来：

```
【预注册】<改动名>
假设：加了 X，会让 <指标> 上升，代价是 <成本指标> 上升不超过 <阈值>。
通过条件（全部满足才保留）：
  1. 主指标（pass^3）净翻转 ≥ 6/30，McNemar p < 0.05
  2. 安全指标不回退（越权调用 = 0，禁用词 = 0）
  3. 成本 delta ≤ +20%，P50 延迟 ≤ +30%
  4. 留出集上方向一致（允许不显著，但不许反向）
失败处置：回滚，并把失败样本加入回归集。
```

这份预注册本身就是面试素材：**它证明你不是在"调参"，而是在做实验**。

---

## 4. 评测地基：架构与实现

### 4.1 架构

```
                    ┌─────────────────────────────────────┐
                    │  eval/cases/*.json   （case 集）     │
                    └───────────────┬─────────────────────┘
                                    │
   ┌────────────────────────────────▼────────────────────────────────┐
   │  eval/run.ts  Runner                                             │
   │   · 每个 case 一个隔离 HOME（TALEMATE_HOME=临时目录）             │
   │   · 装配变体（内存里，不改仓库文件）+ 断言替换命中                 │
   │   · N 次重复 · 超时 · token 预算 · 并发                           │
   └───────┬──────────────────┬──────────────────┬────────────────────┘
           │                  │                  │
           ▼                  ▼                  ▼
   ┌───────────────┐  ┌───────────────┐  ┌──────────────────┐
   │ trace/spans   │  │ 世界状态快照   │  │ manifest（pin）   │
   │ .jsonl        │  │ (写了哪些文件) │  │ prompt_hash/model │
   └───────┬───────┘  └───────┬───────┘  └────────┬─────────┘
           │                  │                   │
           └──────────┬───────┴───────────────────┘
                      ▼
            ┌──────────────────┐        ┌──────────────────┐
            │ eval/metrics.ts  │───────▶│ eval/report.ts   │
            │ 指标聚合 + 分层   │        │ 对比报告 (md)     │
            └──────────────────┘        └──────────────────┘
                      ▲
            ┌─────────┴────────┐
            │ eval/judge/*     │  规则(L1/L2) → rubric(L4) → 校准(κ)
            └──────────────────┘
```

**一条设计约束**：runner 只能通过 `TALEMATE_HOME` 和公开的 `Session` 接口驱动被测系统，**不能 import 内部实现**。否则 eval 会随重构一起腐烂。

### 4.2 数据模型

```ts
// eval/types.ts

export interface EvalCase {
  id: string;                    // "prose-ch01-urban"
  family: "prose" | "design" | "routing" | "context" | "safety";
  difficulty: "easy" | "medium" | "hard" | "adversarial";
  /** 第一句用户输入 */
  brief: string;
  /** 后续用户回话（多轮）；省略 = 单轮 */
  followUps?: string[];
  /** 初始世界：写进临时 HOME 的文件 */
  setup?: { files?: Record<string, string>; project?: Record<string, unknown> };
  /** 硬判据（L1/L2），全过才算 pass */
  checks: Check[];
  /** 语义判据（L4），可空 */
  rubric?: string;               // rubric id，指向 eval/rubric/<id>.md
  /** 锚点样本，给 judge 和人都用 */
  anchors?: { low: string; mid: string; high: string };
  budget: { maxTurns: number; maxSteps: number; maxTokens: number };
  tags?: string[];
}

export interface Manifest {
  promptHash: string;                       // 装配后的 system + tools 全量 hash
  promptParts: Record<string, string>;      // 分段 hash：mate / tools / modes / skills
  contextHash: string;                      // 注入的常驻文档 hash（≠ prompt！）
  model: { provider: string; model: string; temperature?: number; maxTokens: number };
  toolsHash: string;
  codeCommit: string;
  bun: string;
  home: string;
}

export interface RunResult {
  runId: string;
  caseId: string;
  variantId: string;             // baseline | 变体名
  repeat: number;                // 第几次重复
  manifest: Manifest;
  checks: { id: string; ok: boolean; detail?: string }[];
  verdict: "pass" | "fail" | "error" | "timeout";
  failureBucket?: FailureBucket; // 见 4.4
  steps: number;
  usage: { input: number; output: number };
  costYuan: number;
  wallMs: number;
  tracePath: string;
}
```

### 4.3 目录布局（talemate）

```
eval/
├── types.ts
├── cases/
│   ├── prose-ch01-urban.json
│   ├── design-layer-stop.json
│   ├── routing-delegate-research.json
│   └── ...
├── checks/            # L1/L2 断言的实现（结构性 + 行为性 + 自定义函数）
├── rubric/            # rubric 文本 + 锚点样本
├── judge/             # judge prompt、校准集（人工分 + judge 分）
├── variants/          # 变体定义（patch 清单），复用 probe 的 Patch 思路
├── run.ts             # runner
├── replay.ts          # 回放（见 4.8）
├── metrics.ts         # 指标聚合
└── report.ts          # 报告生成

reports/               # 人读的产物，进 git
├── baseline-2026-11-05.md
├── 2026-11-12-prose-rules-v3.md
└── ...

traces/                # 机器产物，gitignore（但要保留 manifest 摘要）
└── <runId>/spans.jsonl
```

**两条约定**：
- `reports/` 必须进 git。文档里说的「`experiments/output/probe/` 是空的」就是这么来的——报告没入版本控制，等于没做过。
- `traces/` 可以 gitignore，但**报告里要引用 runId**，且 manifest 要抄进报告。

### 4.4 case 从哪来：30 个怎么凑

不要凭空写 30 个。按四个来源配比，每个来源解决一类盲区：

| 来源 | 数量 | 怎么得到 | 解决什么 |
|---|---|---|---|
| **真实失败** | 10 | 从历史 trace / 用户反馈里捞「它做错了」的会话，转成 case | 你真正会遇到的 bug |
| **核心能力** | 10 | 每个产品假设一条：前置工艺知识是否提高成稿质量、规划段独立上下文是否有效…… | 产品假设是否成立 |
| **边界** | 5 | 空输入、超长输入、无设定、多轮改稿、压缩临界点 | 退化行为 |
| **对抗** | 5 | 工具结果里注入指令、要求越权写、诱导跳过提案 | 安全性 |

**分层的意义**：报告必须按 `family` 切片。总体成功率会掩盖方向相反的改动（A 类 +20%、B 类 −20%，总体不变）。

**case 的三条质量线**：
1. **判据可判定**：换个人来跑，结论一致。
2. **失败可归因**：跑挂了能说清是"没调工具"还是"写了但不对"。
3. **不复用测试集调参**：`holdout: true` 标记的 case 在 CI 里跑但不给分数——只在验收时看。

### 4.5 Runner 的七个细节

| 细节 | 做法 | 为什么 |
|---|---|---|
| **隔离** | 每个 run 一个临时 `TALEMATE_HOME` | 互不污染；talemate 的 `talemateHome()` 每次现读 env，天然支持 |
| **装配在内存** | 变体 patch 只改内存里的 agent/tool 定义，不写仓库文件 | probe 已验证；避免"跑完仓库变脏" |
| **断言替换命中** | `mustReplace` 失败即抛，且**先做 `--check` 再花钱** | 防止静默退化成 baseline |
| **超时** | 每 case 独立超时 + 全局预算 | 否则一个卡死的 case 拖垮整轮 |
| **重复** | 每 case ≥ 3 次（成本允许 5 次） | 单次是掷骰子 |
| **全量记录** | error/timeout 也要落 `RunResult` | 只记成功 = 选择偏差 |
| **确定性输入** | 固定 temperature、固定 case 初始状态、禁网（除非 case 需要） | 否则差异不可归因 |

### 4.6 judge 校准：让 judge 也成为被测对象

流程（半天到一天，一次性投入）：

```
① 从 30 个 case 里抽 30 条真实输出（覆盖 pass/fail 各半）
② 你人工按 rubric 打分（1–5），作为金标
③ judge 打同样的 30 条
④ 算一致性：
   · 完全一致率
   · 二次加权 κ（1–5 有序，用加权）
   · 相邻一致率（±1 分内）
⑤ 判定：
   κ ≥ 0.7  → judge 可用于日常回归
   0.5 ≤ κ < 0.7 → 只能用于粗筛（pass/fail），不能用于细粒度比较
   κ < 0.5 → 回去改 rubric（通常是判据不可判定），不是改 judge
⑥ 把这份校准集冻结，进 git。以后每次改 judge prompt 都要重跑它
```

```ts
// 二次加权 kappa（1..5）
export function quadraticKappa(a: number[], b: number[], k = 5): number {
  const n = a.length;
  const O = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < n; i++) O[a[i] - 1][b[i] - 1]++;
  const row = O.map(r => r.reduce((s, x) => s + x, 0));
  const col = Array.from({ length: k }, (_, j) => O.reduce((s, r) => s + r[j], 0));
  let num = 0, den = 0;
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
    const e = (row[i] * col[j]) / n;
    const w = ((i - j) ** 2) / ((k - 1) ** 2);
    num += w * O[i][j];
    den += w * e;
  }
  return 1 - num / den;
}
```

**关键认知**：κ 低通常是 **rubric 的问题**，不是 judge 的问题。判据写得含糊，人和模型都会飘。所以校准的副产品是「把 rubric 改到可判定」——这正好是 P1。

### 4.7 版本归因：prompt hash 与 context hash 必须分开

talemate 的「prompt」有六个载体，改任何一个都会改变行为：

| 载体 | 位置 | 何时生效 | 归入 |
|---|---|---|---|
| persona | `prompts/mate.system.txt` | 每轮 | `promptParts.persona` |
| 工具描述 | `prompts/tools/<id>.txt` | 每轮（schema 广告） | `promptParts.tools` |
| 模式纪律 | `prompts/modes/<id>.txt` | 进入模式后 | `promptParts.modes` |
| 正文规范 | `prompts/prose.rules.txt` | 写作窗口（harness 注入） | `promptParts.prose` |
| 技能卡 | `skills/*/SKILL.md` | 模型加载后（tool 结果） | `promptParts.skills` |
| **常驻设定** | `design/core.md`、`design/wiki/world.md` | 每轮 | **`contextHash`（不是 prompt）** |

**为什么要分开**：常驻设定是**数据**，不是提示词。但它同样改变行为。如果只 hash prompt，那么「同一个 prompt 跑出不同结果」就无法解释——因为改的是 `core.md`。

```ts
// src/eval/manifest.ts
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

export function buildManifest(s: Session, cfg: ModelConfig): Manifest {
  const system = s.assembledSystem;              // 装配后的最终字节，不是源文件
  const tools = s.visibleTools.map(t => `${t.id}\n${t.description}\n${JSON.stringify(t.input)}`).join("\n");
  return {
    promptHash: sha(system + "\n--tools--\n" + tools),
    promptParts: {
      persona: sha(readPrompt("mate.system.txt")),
      tools: sha(tools),
      modes: sha(s.mode ? readPrompt(`modes/${s.mode}.txt`) : ""),
      skills: sha(s.loadedSkillDigests.join("\n")),
    },
    contextHash: sha(s.residentDocs.join("\n")),
    model: { provider: cfg.provider, model: cfg.model, temperature: cfg.temperature, maxTokens: cfg.maxTokens },
    toolsHash: sha(tools),
    codeCommit: execSync("git rev-parse --short HEAD").toString().trim(),
    bun: Bun.version,
    home: s.home,
  };
}
```

**hash 的是装配后的字节，不是源文件**。理由是：`context/assemble.ts` 里的拼接逻辑变了，源文件没变，但行为变了。只有对最终字节取 hash 才能覆盖这种情况。

**报告里必写**：`promptHash`、`contextHash`、`model`、`temperature`、`commit`。四行，决定这份报告三个月后还有没有用。

### 4.8 离线回放：把 replay 做成一个 provider

talemate 的 `llm/provider.ts` 已经是唯一的模型调用口，`Provider` 只有三个值（`anthropic` / `openai` / `mock`）。回放最干净的实现是**加第四个 provider**：

```ts
// src/llm/replay.ts
export interface RecordedCall {
  seq: number;
  requestHash: string;                 // sha256(system + messages + tools)
  request: { system?: string; messages: NeutralMsg[]; tools?: ToolSchema[] };
  response: AssistantTurn;             // text / toolCalls / finish / usage
  t: { start: number; firstToken?: number; end: number };
}

export async function chatReplay(opts: ChatOpts): Promise<AssistantTurn> {
  const rec = recorder.next();                       // 按 seq 取
  const h = hashRequest(opts);
  if (h !== rec.requestHash) {
    throw new Error(
      `回放对不上（第 ${rec.seq} 次调用）：输入变了。\n` +
      `期望 ${rec.requestHash}，实际 ${h}\n` +
      `第一处差异：${firstDiff(rec.request.messages, opts.messages)}`
    );
  }
  // 仍然要吐 delta，否则 UI 层和 step 逻辑走的是另一条路
  for (const chunk of splitDeltas(rec.response.text, 24)) opts.onText?.(chunk);
  return rec.response;
}
```

**为什么这是对的**（也是可以拿去讲的判据）：

1. **零侵入**：`loop` / `session` / `runner` 一行不改。回放不是"另一条代码路径"，只是"另一个 provider"。
2. **失败即抛**：和 `mustReplace` 同一条原则——**输入漂移必须可区分于"模型换了答案"**。如果回放静默返回记录里的响应，你会得到一个"复现成功"的假象。
3. **两种回放模式**：
   - **model replay + 真工具**（默认）：模型响应来自记录，工具真的执行 → 复现文件写入，可测 harness 逻辑。
   - **full replay**：工具结果也来自记录 → 完全离线，可用于改 judge、改指标而不花一分钱。

**成本收益**：改一次 rubric / 改一个指标公式，原本要重跑 30 case × 3 次（约 ¥30–80、40 分钟），回放后是 0 元、2 分钟。**这是让你"敢频繁改 judge"的关键**——而 judge 不改，就永远停在 κ=0.5。

**回放必须能处理的三件事**：
- 时间：记录里带 `start/firstToken/end`，回放时按原时长 sleep（或提供 `--fast`）。
- 随机 id：`callId` / `sessionId` 在回放里会重新生成，所以 requestHash **不能包含 id**。
- 工具副作用：临时 HOME 每次重建，保证起点一致。

### 4.9 报告：一页纸，固定格式

```markdown
# <改动名> vs baseline

环境：model=deepseek-v4-flash · temp=0.8 · commit=a1b2c3d
      promptHash=9f2c1e · contextHash=41aa07
样本：30 case × 3 run（留出集 10 个未参与调参）

## 结论（一句话）
加了「叙述者态度」一条：pass^3 62%→71%（净翻转 8/30，p=0.008），
文风分 3.1→3.6（Δ 0.5，95% CI [0.2, 0.8]），P50 延迟 +18%，每章成本 +¥0.4。
B 类（古言）无回退。**保留。**

## 主表
| 指标 | baseline | variant | Δ | 95% CI | 显著 |
|---|---:|---:|---:|---|---|
| pass^3 | 62% | 71% | +9pp | — | 是 (p=0.008) |
| 平均步数 | 6.3 | 6.1 | −0.2 | [−0.5, 0.1] | 否 |
| 工具成功率 | 94% | 95% | +1pp | [−1, +3] | 否 |
| P50 延迟 | 42s | 50s | +19% | — | — |
| 每章成本 | ¥1.9 | ¥2.3 | +21% | — | — |

## 分层
| family | baseline | variant | Δ |
|---|---:|---:|---:|
| prose/都市 | 60% | 73% | +13pp |
| prose/古言 | 67% | 67% | 0 |
| design | 80% | 80% | 0 |

## 失败桶迁移
| 桶 | baseline | variant | 解读 |
|---|---:|---:|---|
| 镜头切/流水账 | 9 | 4 | 主因被修掉 |
| 仿写参考样本 | 2 | 3 | 新问题：卡里例子给太具体 |
| 超步数 | 1 | 1 | 不变 |

## 判断
按预注册条件（净翻转≥6、成本≤+20%、留出集方向一致）：
成本 +21% 略超线，但质量提升显著且集中在目标 family → **保留，下一轮压成本**。
```

**格式的三条硬规矩**：
1. **第一行就是结论**，带数字。没人愿意从表格里自己找答案。
2. **必须写"没通过的指标"**。只报好数 = 自欺。
3. **失败桶必须有解读**，不只是计数。

### 4.10 接进 CI：分三层，别一次全上

| 层 | 触发 | 内容 | 预算 | 时间 |
|---|---|---|---|---|
| **L0 静态** | 每次提交 | `--check`：变体替换串命中、prompt 引用的工具存在、case schema 合法 | ¥0 | <5s |
| **L1 冒烟** | 每次提交 / pre-push | 6 个代表 case × 1 次，**mock provider** | ¥0 | <30s |
| **L2 全量** | 每晚 / 手动 | 30 case × 3 次，真模型 | ¥30–80 | 40min |

**关键**：`bun test` 必须保持离线（talemate 已有这条纪律）。eval 是**另一个命令**，不是测试的一部分——测试保证"代码没坏"，eval 回答"质量变没变"，两者不要混。

```jsonc
// package.json
"scripts": {
  "eval:check":  "bun run eval/run.ts --check",
  "eval:smoke":  "bun run eval/run.ts --cases smoke --runs 1 --provider mock",
  "eval":        "bun run eval/run.ts --runs 3",
  "eval:report": "bun run eval/report.ts --baseline reports/baseline.json"
}
```

---

## 5. 可观测性：架构与实现

### 5.1 一句话分工

> **eval 回答「这批改动整体好不好」，可观测性回答「这一次为什么坏、线上正在坏什么」。**

因为分工不同，两者的工程设计也不同：

| | eval | observability |
|---|---|---|
| 触发 | 手动 / 定时 | 每次运行，常开 |
| 采样 | 全量 | 线上可采样（本地全量） |
| 数据量 | 小（30 case × 3） | 大（每次会话几千条） |
| 生命周期 | 一次报告 | 长期留存、可查询 |
| 失败容忍 | 失败就是信号 | 埋点坏了会污染所有结论 → 需要「数据质量」指标 |

**共用的是同一份事件 schema**。这就是为什么第 4 章的 `RunResult.tracePath` 和本章的 `spans.jsonl` 是同一个东西。

### 5.2 三层 span：为什么是这三层

```
turn（一次用户输入 → 最终答复）
├── chat            （一次模型调用）
│   └── execute_tool （一次工具执行）× n
├── chat
│   └── execute_tool
└── compaction      （一次压缩：before/after token、丢了什么）
```

这三层是「**钱、时间、错误**」三种归因的最小完备集：

- **token 花在 chat** → 成本归因到具体一次调用。
- **时间花在 execute_tool** → 延迟归因到具体工具。
- **错误发生在 execute_tool 的 error 字段** → 失败归因到具体工具 + 错误类型。
- **上下文怎么长出来的** → 只有把三层按时间轴排开才看得见（§5.7 的第二个视图）。

少一层会怎样：
- 少了 turn：算不出「一个任务的总成本」，只能算单次调用。
- 少了 chat：算不出「第几步开始变慢」，只能看总时长。
- 少了 execute_tool：失败率只能按会话算，无法按工具归因——而「某类工具失败率突然上升」正是 JD 里「日志分析」要的东西。

### 5.3 对齐 OpenTelemetry 的 GenAI 语义约定

**为什么要对齐**：不是为了好看。自造字段名的代价是——(a) 接 Jaeger/Tempo/Langfuse 要重写；(b) 别人复现不了你的数；(c) 面试官无法验证你懂不懂行业标准。对齐之后，`gen_ai.request.model` 是**公共词汇**。

| 我们的 span | OTel span 名 | 关键属性 |
|---|---|---|
| turn | `invoke_agent` | `gen_ai.operation.name="invoke_agent"`、`gen_ai.agent.name`、`gen_ai.conversation.id` |
| chat | `chat` | `gen_ai.operation.name="chat"`、`gen_ai.provider.name`、`gen_ai.request.model`、`gen_ai.response.model`、`gen_ai.usage.input_tokens`、`gen_ai.usage.output_tokens`、`gen_ai.response.finish_reasons` |
| execute_tool | `execute_tool` | `gen_ai.operation.name="execute_tool"`、`gen_ai.tool.name`、`gen_ai.tool.call.id`、`error.type` |
| compaction | `chat`（或自定义 `compaction`） | `talemate.compaction.before_tokens`、`.after_tokens`、`.dropped_parts` |

> ⚠️ GenAI semconv 仍在演进（部分字段处于 development 状态）。**以官方最新为准**，这里给的是当前通行的形状。重点是「用这套词汇」，不是背字段。

**本地先不引 SDK**。带 `@opentelemetry/api` 会增加依赖和启动成本，而现在只需要一个「形状对」的 JSONL。等到要接 Jaeger 时，写一个 30 行的 exporter 把 JSONL 转 OTLP 即可——**schema 对了，导出器是小事**。

### 5.4 埋点位置（talemate 现状盘点）

先诚实盘点：**talemate 现在能测什么、不能测什么**。

| 数据 | 现状 | 位置 |
|---|---|---|
| 每轮 token 用量 | ✅ 有 | `SessionMeta.usage: {input, output}[]` |
| 上下文构成比例 | ✅ 有（字符数） | `usage` 事件的 `parts: {system, tools, messages}` |
| 工具调用与结果 | ✅ 有 | `LLMEvent` 的 `tool-call` / `tool.result` |
| 工具耗时 | ⚠️ 事后可算 | `AssistantPart.time: {ran, completed}` |
| **模型调用耗时** | ❌ **没有** | `LLMEvent` 完全不带时间戳 |
| 首 token 延迟 | ❌ 没有 | 同上 |
| 压缩事件 | ⚠️ 只能从 `role:"compaction"` 消息反推 | `StoredMessage.role` |
| 失败分类 | ❌ 没有 | `ToolPart.error` 是自由文本 |

**第一个要修的洞：事件没有时间戳。** 现在的 `LLMEvent` 联合类型（`src/core/types.ts`）里没有任何 `at` / `t` 字段。这意味着 P50/P95 延迟**无处可算**——这是 Stage 1 指标清单里「延迟分位」落地不了的直接原因。

修法：**不要改 `LLMEvent`**（它是 UI 契约，改它要动渲染层）。在 `Session` 的依赖里加一个平行通道：

```ts
// src/trace/types.ts
export interface Span {
  traceId: string;
  spanId: string;
  parentId?: string;
  name: "invoke_agent" | "chat" | "execute_tool" | "compaction";
  startMs: number;        // epoch ms，跨进程可对齐
  durationMs: number;
  status: "ok" | "error";
  attrs: Record<string, string | number | boolean>;
  error?: { type: string; message: string };
}

export interface TraceSink {
  begin(name: Span["name"], attrs?: Span["attrs"], parentId?: string): string; // 返回 spanId
  end(spanId: string, patch?: Partial<Span>): void;
}
```

四个埋点（都在已有函数里加两行，不改控制流）：

| 位置 | span | 关键属性 |
|---|---|---|
| `Session.post()` 入口 / 出口 | `invoke_agent` | agent、mode、轮次 |
| `loop.ts` 调 `chat()` 前后 | `chat` | model、input/output tokens、finish_reason、是否压缩 |
| `tool/runner` 执行前后 | `execute_tool` | tool name、args hash、status、error.type |
| `compaction.ts` 压缩前后 | `compaction` | before/after tokens、dropped parts |

**`attrs` 的三条纪律**：
1. **不要放正文**。放 hash、长度、枚举。正文进 trace 会让文件爆炸，且有隐私问题。
2. **错误必须有类型**。`error.type` 从自由文本升级成枚举（`timeout` / `permission_denied` / `schema_invalid` / `model_refusal` / `tool_not_found` / `internal`）。没有分类，失败率就只是一个数，不能归因。
3. **args 只记 hash + 关键字段**。`write` 的 args 可能是整章正文，记全量等于把正文写两遍。

### 5.5 存储与采样

```jsonl
{"traceId":"a1b2","spanId":"s1","name":"invoke_agent","startMs":1767...,"durationMs":42310,"status":"ok","attrs":{"agent":"mate","mode":"prose"}}
{"traceId":"a1b2","spanId":"s2","parentId":"s1","name":"chat","startMs":1767...,"durationMs":8100,"status":"ok","attrs":{"gen_ai.request.model":"deepseek-v4-flash","gen_ai.usage.input_tokens":18422,"gen_ai.usage.output_tokens":2103}}
{"traceId":"a1b2","spanId":"s3","parentId":"s2","name":"execute_tool","startMs":1767...,"durationMs":142,"status":"error","attrs":{"gen_ai.tool.name":"read"},"error":{"type":"tool_not_found","message":"no such file: design/core.md"}}
```

**append-only JSONL** 的三个好处：崩了不丢已写部分；`grep`/`jq` 就能查；不用引数据库。

**采样策略**：
- 本地开发：全量。
- 以后上线：**错误全采 + 成功按 10% 采样**，但**计数器不受采样影响**（计数器在写 span 时同步 +1，不走采样）。

### 5.6 从 trace 到指标：聚合的三个坑

```ts
// eval/metrics.ts（也被 observability 复用）
export interface MetricDef {
  id: string;
  unit: "ratio" | "ms" | "token" | "yuan" | "count";
  /** 分子；分母为 undefined 时是计数 */
  numerator: (spans: Span[]) => number;
  denominator?: (spans: Span[]) => number;
  direction: "up" | "down" | "neutral";
}
```

**坑 1：分位数不能先平均再算。** P95 必须对**原始样本**取分位，不能对每个 case 的均值取分位。

**坑 2：样本量不够时分位数没有意义。** 30 个 case × 3 次 = 90 个样本，P95 就是第 86 个值——一个离群点能让它跳 50%。**结论：eval 报告只报 P50 和均值；P95 从线上 trace 算。**

**坑 3：窗口要对齐。** 「今天失败率上升」可能只是今天跑的 case 更难。所以失败率必须**按 case 归一**：

```
工具失败率（可跨天比较）= Σ(失败工具调用) / Σ(工具调用)
                       —— 并且按 tool_name 分组
```

### 5.7 告警规则：从「能查」到「能自己报」

JD 的原话是「日志分析」。它的实质是三条规则，不需要复杂系统：

```ts
// 规则 1：某类工具失败率环比上升
if (curr.byTool[t].errorRate - prev.byTool[t].errorRate > 0.15 && curr.byTool[t].calls >= 20) {
  alert(`${t} 失败率 ${prev}→${curr}`);
}

// 规则 2：新增错误类型
const novel = [...curr.errorTypes].filter(x => !prev.errorTypes.has(x));

// 规则 3：延迟漂移（同模型同 case 的 P50 变化 > 30%）
```

**三条纪律**：
- **最小样本量**：`calls >= 20` 才判，否则告警全是噪声。
- **抑制**：同一规则 30 分钟内只报一次。
- **可解释**：告警必须带「哪三个 case 导致的」——能直接跳进 trace。

### 5.8 Trace viewer：三个视图，一个都不能少

不是「做个漂亮的时间轴」，是**三个具体的问题**：

| 视图 | 回答的问题 | 数据来源 | 实现优先级 |
|---|---|---|---|
| **① 时间轴** | 时间花在哪、哪一步失败 | spans.jsonl | 高（终端表格就够） |
| **② 上下文增长** | 上下文怎么长出来的、什么时候逼近窗口 | `usage` 事件序列 + `parts` | 高 |
| **③ 压缩前后 diff** | 压缩丢了什么、模型还记不记得 | `role:"compaction"` 前后消息 | 最高（这是你的核心判据） |

**视图 ② 的最小实现**（纯终端，半天）：

```
turn  ctx_tokens  system  tools  messages  note
  1      8,420     2,100  3,800   2,520
  2     14,900     2,100  3,800   9,000
  3     28,300     2,100  3,800  22,400   ← 工具结果灌入
  4     61,700     2,100  3,800  55,800   ← 逼近 64k 触发线
  5      7,900     2,100  3,800   2,000   ← compaction 发生
```

这张表就是「上下文工程」的可视化。**它比任何 UI 都有说服力**，因为它直接展示了你最贵的那条判断：tool 结果活不过压缩，而 `<available_skills>` 目录每轮重建——模型不知道自己丢了什么。

**视图 ③ 的最小实现**：压缩前把 messages 序列化，压缩后同样序列化，做一次**按角色分组的差集**：

```
压缩前：tool 结果 14 条（合计 38,200 字符）
压缩后：保留 0 条 tool 结果，assistant text 保留 6 条
丢失样本：["read design/core.md → 4,120 chars", ...]
```

这一行输出，胜过十页设计文档。

### 5.9 数据质量：埋点自己也会坏

这是几乎没人做的一层，做了就是差异：

| 指标 | 定义 | 坏了意味着 |
|---|---|---|
| `span_completeness` | 有 `end` 的 span / 全部 span | 埋点泄漏，指标偏低 |
| `usage_coverage` | 带 usage 的 chat span / 全部 chat span | 成本统计偏少 |
| `orphan_rate` | 找不到 parent 的 span 占比 | 并发下 traceId 串了 |
| `clock_skew` | `child.start < parent.start` 的比例 | 时钟/顺序问题 |

这四个数应该出现在**每次报告的表头**。一条「本次 usage_coverage 98%」比多一个质量指标更能证明你懂工程。

---

## 6. 指标字典

这是「涉及到什么计数」的正式回答。**每个指标都必须写清分母**——否则两个人报的数永远对不上。

### 6.1 任务级

| 指标 | 公式 | 分母 | 数据源 | 方向 |
|---|---|---|---|---|
| 完成率 | 通过 case 数 / 总 case 数 | case | RunResult | ↑ |
| **pass^k**（主指标） | k 次全过的 case 数 / 总 case 数 | case | RunResult × k | ↑ |
| pass@k（上限） | k 次里有 1 次过的 case 数 / 总 case 数 | case | RunResult × k | ↑ |
| 平均步数 | Σ steps / 通过 case 数 | 通过的 case | trace | ↓ |
| 超步率 | steps > 预算的 case 数 / 总 case 数 | case | trace | ↓ |
| 超时率 | timeout 的 case 数 / 总 case 数 | case | RunResult | ↓ |
| 崩溃率 | verdict=error 的 case 数 / 总 case 数 | case | RunResult | ↓ |

> 为什么 `pass^k` 是主指标：产品要的是「每次都对」。`pass@k` 高而 `pass^k` 低，说明能力有但不稳——那是该加约束，不是该换 prompt。

### 6.2 工具级

| 指标 | 公式 | 分母 | 注意 |
|---|---|---|---|
| 工具调用成功率 | status=ok 的 call / 全部 call | **call** | 按 tool_name 分组报 |
| 工具选择正确率 | 期望工具 == 实际首选工具 / 有标注的 case | 有标注的 case | 只对 routing 类 case 算 |
| 参数合法率 | schema 校验通过的 call / 全部 call | call | 不含业务校验 |
| 无效调用率 | 调了不存在的工具 / 全部 call | call | 幻觉的硬指标 |
| **重试率** | 重试次数 / 首次尝试次数 | **attempt** | 分母不是 call，别混 |
| 越权尝试数 | permission=deny 的调用数 | 计数 | 安全指标，方向 ↓ |

**重试率的三个口径**（必须选一个写进报告）：
- 引擎自动重试（provider 层）→ 算「重试」。
- 模型自己再调一次同名工具（错误后自纠）→ 通常**不算重试**，算「自愈」，应单独一个指标 `self_heal_rate`。
- 用户手动重跑 → 不算。

**把「自愈」和「重试」分开**，是判断「错误消息即恢复机制」有没有生效的唯一办法。

### 6.3 模型级

| 指标 | 公式 | 数据源 | 方向 |
|---|---|---|---|
| 输入/输出 token | Σ per chat span | `usage` | ↓（同质量下） |
| 每任务成本 | Σ(token × 单价) / 任务数 | usage | ↓ |
| **每通过任务成本** | Σ成本 / 通过任务数 | usage + verdict | ↓ |
| P50 延迟（llm-call） | 分位数(chat.durationMs) | span | ↓ |
| P95 延迟（任务） | 分位数(turn.durationMs)，样本 ≥ 200 | span | ↓ |
| 首 token 时间 | firstToken − requestStart | 需新增埋点 | ↓ |
| 上下文峰值 | max(usage.input) / 任务 | usage | ↓ |
| **压缩次数/任务** | compaction span 数 / 任务数 | span | 中性 |
| **压缩比** | after_tokens / before_tokens | span | 中性 |

> `每通过任务成本` 是唯一能同时反映质量和成本的单指标：成功率下降时它不会假装变便宜。

### 6.4 质量级

| 指标 | 公式 | 校准方式 |
|---|---|---|
| rubric 分 | 维度分均值（配对 bootstrap CI） | 锚点样本 |
| judge 通过率 | score ≥ 阈值的样本 / 总样本 | 与人工 κ |
| **judge 一致率 κ** | 二次加权 kappa | 冻结校准集 |
| **主编否决率** | (拒绝 + 提意见) / 被拍板的提案数 | 分母必须是被拍板数 |
| 安全违规数 | 按类型分桶计数 | 每类单独阈值 |
| 失败桶分布 | 每桶 case 数 / 总失败数 | 桶定义见下 |

**失败桶的标准分类**（六桶够了，再多就没人看）：

| 桶 | 判定 | 典型修法 |
|---|---|---|
| `no_tool` | 该调工具却没调 | 工具描述 / 触发条件 |
| `wrong_tool` | 调了别的工具 | 路由描述 / 工具边界 |
| `bad_args` | 参数不合法/缺字段 | schema description |
| `loop` | 重复调用、无进展 | 状态提示 / 步骤上限 |
| `quality` | 工具都对，产物不合格 | prompt / 上下文 / 模型 |
| `infra` | 超时、崩溃、限流 | 运行时工程（Stage 3） |

**这张表的价值**：它把「失败了」变成「该修哪一层」。`no_tool` 和 `quality` 的修法完全不同——一个改工具描述，一个改写作纪律。混在一起就会得出「换个更强的模型」这种昂贵且无效的结论。

### 6.5 评测自身的指标

| 指标 | 公式 | 为什么要有 |
|---|---|---|
| 噪声地板 | 同配置重复跑的成功率极差 | 判断改动是否超过噪声 |
| 留出集分数 | holdout 上的 pass^k | 检测过拟合 |
| case 覆盖率 | 有 case 的失败桶 / 全部桶 | 找盲区 |
| eval 成本/时长 | Σ token × 单价；wall clock | 决定敢不敢天天跑 |
| judge κ | 见 4.6 | 决定 judge 能不能用 |

### 6.6 诚实表：talemate 现在能算 vs 暂时算不了

| 指标 | 现在 | 缺什么 |
|---|---|---|
| 完成率 / pass^k | ⚠️ 需 runner | `eval/` 不存在 |
| token / 成本 | ✅ 可算 | `SessionMeta.usage` 已有 |
| 上下文构成 | ✅ 可算 | `usage.parts` 已有 |
| 工具成功率 | ⚠️ 可算但不准 | `error` 是自由文本，无分类 |
| 工具耗时 | ✅ 可算 | `ToolPart.time` |
| **LLM 延迟 / 首 token** | ❌ | **事件无时间戳（§5.4）** |
| 压缩比 | ⚠️ 需反推 | 无 compaction span |
| 主编否决率 | ❌ | 无「拍板」事件记录 |
| 安全违规 | ❌ | 无分类埋点 |

**这张表就是 Stage 1 的施工顺序**：从上往下，先补 ✅ 的聚合，再补 ⚠️ 的埋点，最后补 ❌ 的事件。

---

## 7. 落地路线：14 步

每一步都有：**做什么 / 改哪里 / 验收 / 耗时 / 坑**。按顺序做，前一步的产出是后一步的输入。

### Stage 1 · 评测地基（10 步，约 12 个工作日）

#### S1-1 冻结基线（半天）

- **做什么**：把现有 3 个 probe 变体 + style-bench 的 5 个用例，统一成 `eval/cases/*.json`；跑一遍，结果写成 `reports/baseline-<date>.md` **进 git**。
- **改哪里**：新建 `eval/`；复用 `experiments/style-bench/cases/*.md` 的内容。
- **验收**：`bun run eval --case all --runs 1` 产出一张表；把表贴进 report，commit。
- **坑**：现在的 `experiments/output/` 没进版本控制（这正是"报告是空的"的原因）。**报告必须进 git，原始 trace 可以不进。**

#### S1-2 事件时间戳与 trace sink（1 天）

- **做什么**：加 `src/trace/{types,tracer,file-sink}.ts`；在 4 个位置埋点（§5.4）；一次运行落 `traces/<runId>/spans.jsonl`。
- **改哪里**：`src/session/session.ts`（turn）、`src/session/loop.ts`（chat）、`src/tool/registry.ts`（tool runner）、`src/session/compaction.ts`（compaction）。
- **验收**：`bun run cli` 跑一轮，`jq` 能算出「这次 LLM 调用花了 3.2s」。
- **坑**：**不要改 `LLMEvent`**。它是 UI 契约，改它要动 `desktop/` 渲染层。走平行通道。

#### S1-3 manifest 与 prompt hash（半天）

- **做什么**：实现 §4.7 的 `buildManifest`；每次 run 写 `manifest.json`；报告表头抄四行。
- **验收**：改一个字（比如 `mate.system.txt` 加一个空格），`promptHash` 变；改 `design/core.md`，`contextHash` 变而 `promptHash` 不变。
- **坑**：hash 装配后的字节，不是源文件。`context/assemble.ts` 的拼接逻辑改了也要能反映。

#### S1-4 指标聚合（1 天）

- **做什么**：`eval/metrics.ts` 实现六个核心指标：pass^k、工具成功率、重试率、P50、每任务成本、上下文峰值。
- **验收**：`bun run eval:metrics traces/<id>` 输出表；拿一个手算的数字对一遍。
- **坑**：分位数对原始样本取，不要对均值取（§5.6 坑 1）。

#### S1-5 replay provider（2 天）

- **做什么**：`src/llm/replay.ts` + `provider.ts` 加一个 `case "replay"`；录制模式在 `chat()` 里落 `RecordedCall`。
- **验收**：录一次运行，`--replay` 重跑，messages 序列逐字节一致；故意改一个字，**必须抛错并指出第一处差异**。
- **坑**：requestHash 不能包含 `callId` / `sessionId`（回放会重新生成）；工具副作用要在临时 HOME 里重建。

#### S1-6 规则 judge（半天）

- **做什么**：实现 §3.3 的 L1/L2 断言；给每个 case 配 3–6 条。**先写这条再写 rubric**，因为格式不合法时 rubric 分毫无意义。
- **验收**：故意破坏一个 case 的初始状态 → 对应 check 变红；恢复 → 变绿。
- **坑**：断言要测「世界状态」，不要测正文措辞（`probe` 的教训：关键词分不开）。

#### S1-7 rubric judge 与 κ 校准（2 天）

- **做什么**：写 2–3 份 rubric（正文质量 / 设计提案质量 / 工具路由）；抽 30 条人工打分；judge 重打；算二次加权 κ；按 §4.6 的判定线决定它能用在哪个粒度（κ<0.7 就回去改 rubric 再算）。
- **验收**：`eval/judge/calibration.json` 进 git，报告里写 κ。
- **坑**：κ 低通常是 rubric 不可判定，不是 judge 笨。**先改判据，再换模型。**

#### S1-8 扩到 30 个 case（2 天）

- **做什么**：按 §4.4 的四类来源配比补齐；打 `family` / `difficulty` / `holdout` 标签。
- **验收**：`family` 至少 4 类，每类 ≥ 5 个；`holdout` 10 个且调参期间不看。
- **坑**：不要写 30 个"同一个故事换皮"。case 的价值是**覆盖失败模式**，不是数量。

#### S1-9 对比报告与预注册（1 天）

- **做什么**：`eval/report.ts` 生成 §4.9 的格式；做一次真实改动（比如给 `prose.rules.txt` 加一条），走完整闭环。
- **验收**：报告含：结论一句话 / 主表带 CI / 分层 / 失败桶迁移 / 成本 / 预注册判定。
- **坑**：只报好指标 = 自欺。必须写"没通过的指标"。

#### S1-10 CI 三层（半天）

- **做什么**：`eval:check`（静态）/ `eval:smoke`（mock，6 case）/ `eval`（全量）。`bun test` 保持离线。
- **验收**：故意写错一个变体替换串 → `eval:check` 失败；mock smoke 30 秒内跑完。
- **坑**：不要把 eval 塞进 `bun test`。一个是"代码没坏"，一个是"质量变没变"。

### Stage 2 · 可观测性（4 步，约 6 个工作日）

#### S2-1 OTel 对齐与导出（1 天）

- **做什么**：span 的 `name` / `attrs` 按 §5.3 的词汇表改名；写一个 JSONL → OTLP 的导出器（可选，先不接后端）。
- **验收**：随便挑一个开源 trace 查看器（Jaeger / Langfuse），能把一次会话导进去看到三层树。
- **坑**：不要为了"标准"引入重依赖。schema 对了，导出器是小事。

#### S2-2 聚合与告警（1 天）

- **做什么**：实现 §5.7 的三条规则；输出 `reports/health-<date>.md`；带「哪三个 case 导致的」。
- **验收**：人为制造一次工具失败率上升（改坏一个工具），规则能报出来并定位到 case。
- **坑**：最小样本量（≥20 call）。没有它，告警全是噪声，三天后你就把它关了。

#### S2-3 终端 trace viewer（2 天）

- **做什么**：`talemate trace <runId>` 输出三视图（时间轴 / 上下文增长 / 压缩前后 diff）。**先做终端，不要先做 GUI。**
- **验收**：能回答「第几步逼近窗口」「压缩丢了哪几条 tool 结果」。
- **坑**：视图 ③ 才是核心。时间轴好看但信息量低。

#### S2-4 压缩可观测（2 天）

- **做什么**：compaction span 带 before/after token 和 **dropped 列表**（哪些消息类型、多少字符）；统计「压缩后引用丢失」。
- **验收**：报告里有一行「本次压缩丢弃 tool 结果 14 条 / 38,200 字符」。
- **坑**：这是 talemate 最贵的一条判据（tool 结果活不过压缩），必须能被数据证明，而不是只写在文档里。

### 每步的共同产出

1. **代码**（进 git）
2. **一条 ADR**：`docs/adr/NNNN-<title>.md`，四段：背景 / 决定 / 放弃的方案 / 什么条件下推翻
3. **一次 commit**，message 写清"为什么"而不是"改了什么"

---

## 8. 验收：Stage 1–2 的可执行清单

把 [能力评估与补强规划.md](能力评估与补强规划.md#L196) 的 checkbox 翻译成「能跑的命令 + 判定标准」。

### Stage 1

```bash
# ① 30 个 case，每个有 rubric 与锚点
bun run eval:check
#    → 期望：cases=30, families>=4, 每个 case 有 checks；有 rubric 的 >= 15

# ② 能回放任意一次历史运行
bun run eval --replay traces/<runId> --runs 1
#    → 期望：逐字节一致；输入漂移时抛错并指出第一处差异

# ③ 每次运行记录 prompt_hash / model / params
jq '.manifest | {promptHash, contextHash, model, codeCommit}' traces/*/manifest.json
#    → 期望：非空；两次不同 commit 的 hash 不同

# ④ 五项指标
bun run eval:metrics traces/<runId>
#    → 期望：completion / tool_success / retry / p50 / cost 全部有值

# ⑤ 主编否决率
#    → 期望：reports/ 里有这个数，且分母写的是「被拍板提案数」

# ⑥ 一份「改动 → 指标变化」报告
ls reports/*-vs-baseline.md
#    → 期望：≥1 份，含预注册判定
```

### Stage 2

```bash
# ① 三层 span，对齐 OTel
jq -r '.name' traces/<runId>/spans.jsonl | sort | uniq -c
#    → 期望：invoke_agent / chat / execute_tool（+ compaction）

# ② 本地 viewer
bun run cli trace <runId>
#    → 期望：三个视图都能看；上下文增长表有 token 列

# ③ 工具失败率异常能自动报出
bun run eval:health --since 7d
#    → 期望：人为改坏工具后能报，且指出 case
```

### 一个反验收：**这套东西能不能被证伪**

> 找一个你已经相信的结论（比如「加了交回契约会减少越界」），用这套机器去跑。
> 如果它给出**相反**的结果，你敢不敢改结论？

不敢改，说明这套机器还只是装饰。**这是 8 分和 9 分的真正分界。**

---

## 9. 从 9 到 10：把机器用于「模型换代」

原规划里第三个缺口是「没有模型换代后重估的动作」。Stage 1 建好后，这件事变成一个**矩阵实验**：

```
               弱模型（产品档）      强模型（前沿档）
  守卫全开         A                    B
  守卫全关         C                    D
```

**要回答的三个问题**：

1. **哪些守卫是"补贴弱模型"的？** 对比 A vs B：如果 B 在守卫全关（D）时仍然 ≥ A，那这套守卫对强模型是纯成本。
2. **哪些守卫是"结构性正确"的？** 如果 B 在 D 下显著变差，说明守卫不是补丁，是本质。
3. **删掉之后省多少？** token / 延迟 / 每通过任务成本。

talemate 有三个现成候选：

| 守卫 | 假设 | 检验 |
|---|---|---|
| 两段式提案（propose → apply） | 强模型可能不需要两段 | 关掉 apply 的 CAS 校验，看夹带率 |
| 四层权限 | 强模型可能不越权 | 放宽 `deny`，看越权调用数 |
| 压缩纪律（harness 注入正文规范） | 强模型可能自己记得 | 改成"模型自觉加载"，看压缩后违规率 |

**产出**：`docs/adr/` 里每条关键防护都注一句「依赖 `<模型档位>`」。这句注释就是原规划要的「模型换代后重估一切」的载体。

> **10 分的判据不是"做了这个实验"，是"实验结果改变了一个设计"。** 比如：发现某条守卫在强模型上零收益 → 删掉它 → 代码变短、成本下降、质量不变。**能删掉自己建的东西，才是 8 分以上最硬的证据。**

---

## 10. 反模式：十二个会毁掉整套东西的做法

| # | 反模式 | 后果 | 对策 |
|---|---|---|---|
| 1 | 先做 judge，后做 trace | judge 无料可判，只能重跑模型 | 顺序：schema → trace → metrics → judge |
| 2 | 用关键词判质量 | "列菜单"和"替你决定"都含"角色" | 行为断言（世界状态） |
| 3 | 单次运行下结论 | 掷骰子 | ≥3 次 + 配对 |
| 4 | 没有 baseline | 没有对比就没有 eval | 先冻基线 |
| 5 | 混淆 prompt hash 与 context hash | "同 prompt 不同结果"无法解释 | 两个都记 |
| 6 | 替换串静默失败 | 假阴性 | `mustReplace` 抛错 + `--check` |
| 7 | 只报总分 | 方向相反的改动互相抵消 | 按 family 分层 |
| 8 | 只报通过的指标 | 自欺，且下次一定翻车 | 必须写"没通过的" |
| 9 | 同一批 case 调参又验收 | 过拟合 | holdout |
| 10 | judge 当真理 | κ=0.4 的 judge 在指挥你改 prompt | 校准 + 抽检 |
| 11 | eval 塞进 `bun test` | 测试变慢、变贵、随机失败 | 独立命令 |
| 12 | 把 eval 做成门禁 | 大家开始"为了过 eval"写代码 | eval 是测量仪，门禁靠结构 |

---

## 11. 附录

### A · case 模板

```jsonc
{
  "id": "prose-ch01-urban",
  "family": "prose",
  "difficulty": "medium",
  "brief": "写第一章。主角在武汉老城区接手一家濒临倒闭的旧书店。",
  "followUps": ["按这个方向来", "再压一下开头"],
  "setup": {
    "files": {
      "design/core.md": "# 核心设定\n…",
      "design/wiki/world.md": "# 世界\n…"
    }
  },
  "checks": [
    { "kind": "fileWrittenUnder", "dir": "chapters/" },
    { "kind": "notContains", "path": "chapters/", "text": "（待定）" },
    { "kind": "wordCountBetween", "path": "chapters/", "min": 2200, "max": 4200 }
  ],
  "rubric": "prose-v1",
  "anchors": { "low": "anchors/prose-low.md", "mid": "anchors/prose-mid.md", "high": "anchors/prose-high.md" },
  "budget": { "maxTurns": 3, "maxSteps": 12, "maxTokens": 90000 },
  "tags": ["都市", "开篇"]
}
```

### B · rubric 模板

```markdown
# <名称> v1

先读三遍再打分。**不要评"文笔好不好"**，只评下面每一条。

每项 1–5：1 = 明显不是，3 = 一般，5 = 很到位。

| 维度 | 1 分的样子 | 5 分的样子 | 锚点 |
|---|---|---|---|
| <维度1> | <具体、可观察> | <具体、可观察> | anchors/x-low.md |
| <维度2> | … | … | … |

## 三个必答问题（给人和 judge 都看）
1. <能定位到原文的具体问题>
2. …
3. …

## 不要做的事
- 不要因为"更高级"给高分。
- 不要因为"长"给高分。
```

### C · 术语表

| 术语 | 一句话 |
|---|---|
| **case** | 一个固定输入 + 环境 + 判据的测试单元 |
| **变体（variant）** | 相对 baseline 只改一处的配置 |
| **基线（baseline）** | 当前产品的配置，所有对比的参照 |
| **噪声地板** | 同配置重复跑的自然波动 |
| **pass^k** | k 次全过（可靠性） |
| **pass@k** | k 次有 1 次过（能力上限） |
| **净翻转** | A→B 与 B→A 的 case 数之差（配对比较的核心） |
| **holdout** | 不参与调参、只用于验收的 case |
| **κ** | judge 与人工的一致度（二次加权） |
| **trace** | 一次运行的全部 span 树 |
| **span** | 一个有起止时间与属性的操作片段 |
| **replay** | 用记录的事件重放一次运行，不调模型 |

### D · 迁移到别的项目（通用性检查）

这套设计不依赖 talemate，也不依赖 TS。换项目时只需回答五个问题：

1. **模型调用的唯一出口在哪？** → 那里是 `chat` span 和 replay provider 的挂点。
2. **工具执行的唯一出口在哪？** → 那里是 `execute_tool` span 和失败分类的挂点。
3. **「一次任务结束」的判定在哪？** → 那里是 `invoke_agent` span 的边界。
4. **上下文是从哪几个载体拼出来的？** → 决定 prompt hash 的分段。
5. **环境怎么隔离？** → 一个临时目录 / 容器 / 前缀，决定 case 能不能并行。

五个问题答完，剩下的是同一套代码换名字。

### E · 一页速查

```
判断 prompt 好坏的顺序：
  1. 写判据（可判定 + 锚点）
  2. 测噪声地板
  3. 单变量改 + 断言替换命中
  4. 跑 N≥3 次，配对比较
  5. 净翻转 ≥6/30 才算显著
  6. 分层看 + 看失败桶迁移
  7. 按预注册判定，写进报告（含没通过的指标）

指标口诀：
  完成率看底线，pass^k 看可靠，
  工具成功率看路由，重试率看自愈，
  P50 看体感，P95 看长尾（样本要够），
  成本看"每通过任务"，质量看"失败桶"。
```

---

> **最后一句**：这份手册的每一节都可以被推翻。真正要留下的不是这些步骤，而是**「先测噪声、再下结论；先证明替换发生、再比较结果」**这两个习惯。它们在任何模型、任何项目上都成立——这才叫判据。



