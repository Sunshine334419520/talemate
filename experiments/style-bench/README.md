# 文风测试台

**目的**：用固定用例、固定模型、固定提示，只换「写作底线」和「文风卡」，生成一组匿名样本，由人来盲评。它回答的不是“文笔好不好”，而是：

- 同一段故事，哪种配置更像网上那种小说？
- 瓶颈在文风卡，还是在旧的文学向纪律（已冻结在 `rules/literary.txt`）？
- 长清单式文风卡和“短指纹 + 范例”哪种更稳？

它不是 `bun test`：要调真实模型、花 token、带随机性。`bun test` 仍然保持离线。

## 先看这个判断

重构前 `prompts/prose.rules.txt` 是一套文学向纪律：不解释、不直说情绪、对话不承担信息、每句必须承重。网文的常见手法恰好相反：心理直给、对话交代信息、背景快进、叙述者点评。`style-01-wangwen` 说“直给不藏”，规则说“别直给”，模型收到的是互相打架的指令。

现在产品里只留六条基础条款；文学向的规则（不解释、不直说情绪、对话说一半、限知、少破折号）曾移进旧默认卡 `prose`，旧卡已归档在 `cards/prose-v1.md`，产品里不再提供。旧规则冻结在 `rules/literary.txt`，作为“重构前”的对照。测试台的规则有三个值：

- `literary`：`rules/literary.txt`（旧文学向规则，冻结副本）
- `base`：`rules/relaxed.txt`（六条基础条款）
- `none`：不给底线

| 配置 | 规则 | 文风卡 | 它回答什么 |
|---|---|---|---|
| `baseline-literary` | 旧文学向 | 无 | 重构前，没有文风卡时默认写成什么样 |
| `wangwen-long-literary` | 旧文学向 | `style-01-wangwen`（长卡） | 旧规则下，现有网文卡能不能活 |
| `baseline-base` | 六条基础 | 无 | 新底线本身会把默认声口带到哪 |
| `wangwen-long-base` | 六条基础 | 长卡 | 新底线 + 长卡 |
| `wangwen-short-base` | 六条基础 | 短卡 + 范例 | 新底线 + 短卡 + 范例 |
| `wangwen-short-base-noex` | 六条基础 | 短卡，不给范例 | 范例是否真的有用 |
| `wangwen-short-none` | 无规则 | 短卡 + 范例 | 只靠卡和范例够不够 |
| `guyan-base` | 六条基础 | `style-02-guyan`（女频古言） | 女频古言卡的实际声音 |
| `excerpts-only` | 无规则 | 无卡，只给范例 | 范例本身能教出多少味道 |

**第一轮建议只跑这 5 个**（一个用例 5 次生成，够判断“旧规则 vs 新底线”和“长卡 vs 短卡”）：

```bash
bun run experiments/style-bench/run.ts \
  --case 01-opening \
  --config baseline-literary,wangwen-long-literary,baseline-base,wangwen-long-base,wangwen-short-base
```

## 用例

- `cases/01-opening.md`：都市异能开篇，考“黄金三章”的抓人能力。
- `cases/02-bargain.md`：旧货市场讨价还价，考对话、心理、算账、爽点。
- `cases/03-relationship.md`：旧铺子里的关系对话，考非动作场景会不会写成纯文学。
- `cases/04-storytelling.md`：年代市井开篇，考“讲述体”——叙述者在场、段落完整、因果接上、日常过程铺开。
- `cases/05-high-stakes.md`：单场高赌注戏——下午五点前必须拿到三百块手术费；拆机、诊断、同行竞争、赖账、翻盘。
- `cases/06-guyan.md`：女频古言·重生嫡女的退婚局——内宅对峙、嫁妆、人情与算计。

前三个用例的输入只写“必须发生什么”，不写具体台词和事件顺序；模型有自由度。

## 第二轮：讲述体

第一轮跑完，反馈是：五篇都比较一般，C 稍好（对话更自然），但整体都有“很急、像镜头切”的味道。用户给的目标样本 `example/style01/01.md` 是**讲述体**：叙述者在场，段落是完整的一件事，身世、家境、称重、算账都铺开讲，像说书人讲故事，而不是一串分镜。

第一轮的量化差异也指向同一件事：

| | 平均句长 | 40 字以上长句 | 因果/时间连接词 |
|---|---:|---:|---:|
| 参考样本 `example/style01/01.md` | 60.6 字 | 33 个 | 32 处 |
| 五篇生成 | 18.6–27.3 字 | 7–22 个 | 0–4 处 |

C（用户觉得稍好）正好是生成里平均句长最长的（27.3 字）。问题不只是段落长短，是句子被切成了镜头。

所以第二轮不改规则，改目标：

- `skills/storytelling/SKILL.md`：讲述体卡（叙述者在场、段落完整、因果连接、心理带理由、日常铺开写、转场用叙述带过）。
- `references/storytelling-excerpts.md`：目标样本的两段摘录（开场身世 + 称重算账），仅测试用。
- `cases/04-storytelling.md`：年代市井开篇，明确要求讲述体、不要镜头切。
- `rubric.md` 已改：第一项从“快”换成“讲述感”，并专门检查“镜头切”。

第二轮建议跑这 4 个：

```bash
bun run style-bench --case 04-storytelling \
  --config baseline-base,wangwen-short-base,storytelling-base,storytelling-base-noex,storytelling-none
```

它回答：

- 讲述体卡能不能把“镜头切”扭成“讲故事”？
- 范例有没有用（`storytelling-base` vs `storytelling-base-noex`）？
- 六条基础条款是不是必要的（`storytelling-base` vs `storytelling-none`）？
- 它和旧短卡比，读者更愿意听哪一个（`storytelling-base` vs `wangwen-short-base`）？

## 第三轮：高赌注场景 + 叙述者态度

第二轮反馈：A/B（讲述体卡）读起来顺了不少，但整体还是“一般”。诊断：

- 用例离参考样本太近，模型在仿写“孤儿 + 病重奶奶 + 收废品 + 旧机器 + 讨价还价”的骨架，声音对了，故事像仿写。
- 叙述者只有描述，没有态度；参考里的“可惜的是”“做人做到这个份上”“哪里还能这么浪费呢”这类判断和反问，A/B 里很少。
- 赌注太低：收音机只值几块钱，跟踪的人很模糊；事情不够大，叙述得再顺也平。

第三轮同时改两处：

- `cards/storytelling-v1.md`：上一版卡冻结，作为对照。
- `references/storytelling-excerpts.md`：目标样本的两段摘录，仅测试用；内置卡不依赖它。
- `skills/storytelling/SKILL.md`：v2 加“叙述者的态度”——该夸就夸、该损就损、允许口语和反问、长句与短句要有落差、细节要有生活、人物要有具体的想要和怕。已经是可选内置卡，不依赖参考摘录。
- `cases/05-high-stakes.md`：单场戏，下午五点前必须拿到三百块手术费；拆机、诊断、同行竞争、赖账、翻盘。有明确欲望、障碍、期限和代价，不再是“一天的流水”。

第三轮建议跑这 4 个：

```bash
bun run style-bench --case 05-high-stakes \
  --config storytelling-v1-base,storytelling-base,storytelling-base-noex,storytelling-none,wangwen-short-base
```

它回答：

- v2 的“叙述者态度”有没有把“顺”推到“像故事”（`storytelling-base` vs `storytelling-v1-base`）？
- 范例还有没有用（`storytelling-base` vs `storytelling-base-noex`）？
- 六条基础条款是不是必要的（`storytelling-base` vs `storytelling-none`）？
- 旧短卡在高赌注场景里是不是仍然像镜头切（`wangwen-short-base`）？

## 用 Gemini 3.8 Flash 跑

用 Gemini 的 OpenAI 兼容层，不修改 `.env`。把 key 放进一个临时 `.env.gemini`（`.env.*` 已被 gitignore），跑完删掉：

```bash
echo 'GEMINI_API_KEY=...' > .env.gemini
bun run style-bench:gemini --case 05-high-stakes --config storytelling-base --samples 3
rm .env.gemini
```

脚本会设：

- `TALEMATE_PROVIDER=openai`
- `TALEMATE_API_BASE=https://generativelanguage.googleapis.com/v1beta/openai/`
- `TALEMATE_MODEL=gemini-3.8-flash`（可用 `GEMINI_MODEL` 覆盖）
- `TALEMATE_REASONING=low`（可用 `GEMINI_REASONING` 覆盖）
- `TALEMATE_TEMPERATURE=0.8`（可用 `GEMINI_TEMPERATURE` 覆盖）

Gemini 的兼容层只认 `reasoning_effort`，不认 DeepSeek 的 `thinking` 字段；`src/llm/provider.ts` 按 base URL 分流，DeepSeek 的调用不受影响。

## 跑法

先干跑，不花钱，检查提示拼装：

```bash
bun run experiments/style-bench/run.ts --dry-run --case 01-opening
```

小批量跑（一次用例、每个配置一篇）：

```bash
TALEMATE_TEMPERATURE=0.8 bun run experiments/style-bench/run.ts --case 01-opening --samples 1
```

只跑某个配置：

```bash
bun run experiments/style-bench/run.ts --config wangwen-short-base --case 02-bargain
```

模型用 `.env` 里的 `TALEMATE_PROVIDER / TALEMATE_MODEL / TALEMATE_API_KEY`。**同一轮测试必须用同一个模型和温度**，否则比较不成立。脚本会把 `model` 与 `temperature` 写进 `manifest.json`。

## 看结果

输出在 `outputs/<时间戳>/`：

- `<配置>/<用例>--s<序号>.md`：原始样本，带配置名。
- `blind/<用例>/A.md`、`B.md`…：匿名样本。**先读这个**，不要先看 `key.json`。
- `key.json`：标签到配置的映射。
- `manifest.json`：模型、温度、配置、用例。
- `prompts/`：`--dry-run` 时的提示拼装结果。

评分用 `rubric.md`。建议一个用例一次只评 4–6 篇，读完三遍再打分。

## 调参循环

1. 固定用例和模型，跑一轮。
2. 盲评，写下“最不像网文的那一段”和原因。
3. 只改一处：规则、卡里的某条指纹、或范例。
4. 再跑同一批用例，盲评对比。
5. 只保留能稳定赢的改动。不要一次改五处，否则不知道是哪处起作用。

## 边界

- 这是开发实验，不是产品功能；不要把 `run.ts` 接进 `bun test`。
- 文风卡是“声音”，不是“结构指南”。章末钩子、爽点节奏、期待感属于卷纲/章规划；这里只在用例的“必须发生”里给最小结构，避免把结构问题和文风问题混在一起。
- 不要在测试里用 LLM judge 当最终裁判。可以让它做初筛，但“像不像网文”由人来判。
