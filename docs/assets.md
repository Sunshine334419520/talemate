# 资产：种类、载体与增删改查

> **职责**：回答"一本书里有哪些资产、每种资产的文件长什么样、frontmatter 放什么、节拍怎么挂在大纲上、增删改查的语义是什么"。
> **读者**：要加一种资产、改存储格式、做 UI/CLI 的人；以及要确认"我的书能不能这样组织"的用户。
> **对齐代码**：2026-11-25 · 种类定义在 `assets/kinds/*.json`（`framework/assetkinds.ts` 加载）；解析与增删改查在 `framework/assets.ts`，CLI 命令在 `cli_assets.ts`（`/assets`、`/asset new|show|set|move|delete`），头部格式在 `framework/frontmatter.ts`；桌面 UI 尚未接入
> **相邻**：`design-docs.md`（四层活文档与 diff 落盘）· `characters.md` · `outline.md` · `state.md` · `architecture.md`

## 0. 一句话

**资产 = 作品里一件有身份的东西**。身份是项目相对路径（`design/characters/沈越.md`），头部
frontmatter 只放机器字段，正文完全自由。种类由**路径**判定，**加一种资产 = 在 `assets/kinds/` 加一个 JSON**。

```
design/characters/沈越.md          ← 角色
design/wiki/漕运.md                ← 世界观条目
design/outline/第1卷.md            ← 大纲
design/outline/第1卷/beats/b01.md  ← 节拍（独立文件，头里写 outline 指向）
chapters/chapter_ch1_v1.md         ← 章节
state/foreshadowing.md             ← 伏笔账
```

## 1. 为什么是 markdown + frontmatter

| 选择 | 理由 |
|---|---|
| **文件是唯一真源** | 用户手改、git diff、Agent 按文本读三件事同时成立；不引入数据库与第二份索引 |
| **frontmatter 只放机器字段** | `kind` / `title` / `order` / `status` / 链接；正文不规定结构，模板可选 |
| **路径是身份** | 与 `FileOp.path`、权限 pattern、语料层同一口径，没有第二套 ID 词表 |
| **索引现算** | `listAssets` 每次扫盘解析；存一份索引就是迟早脱节的缓存 |
| **kind 写进头部** | 文件被移动/被外部工具处理时仍知道自己是什么；路径判定仍是第一判据，两者不一致会报 problem |

## 2. 种类总表

路径口径与代码一致（glob，`*` 跨 `/`，更长的模式胜出）。`kind` 是写进头部的稳定 id，**不要改名**。

**种类本身也是数据**：每种一个 `assets/kinds/<id>.json`，里面写 id、标签、分组、order、路径模式、
create 模板与字段（中文标签 / 枚举中文名 / 默认值）。代码只加载、校验、消费；改标签或加字段改那个
JSON 即可，不碰 TypeScript。格式见 `assets/kinds/README.md`。定义里**不放正文约定**——正文怎么写
归本文与将来的模板，定义只保留机器要用的字段。

| id | 中文名 | 路径 | 机器字段（frontmatter） | 正文 |
|---|---|---|---|---|
| `brief` | 概览 | `design/brief.md`（兼容 `design/core.md`） | `title` · `channel` · `genre` · `style` | 一句话简介、基调、读者承诺，自由 |
| `world` | 世界观总纲 | `design/wiki/world.md` | `title` | 世界性质、舞台、规则、术语，自由 |
| `world-entry` | 世界观条目 | `design/wiki/<题>.md` | `title` · `order` · `tags` | 一个专题，自由 |
| `character` | 角色 | `design/characters/<名>.md` | `title` · `name` · `aliases` · `role` · `status` · `order` | 自由；建议写性格矛盾、想要/最怕、底线、说话方式，不强制 |
| `outline` | 大纲 | `design/outline/**/*.md`（节拍除外） | `title` · `startChapter` · `status` · `order` | 这一份大纲的走向，自由；**不写节拍清单、不写章号** |
| `beat` | 节拍 | `design/outline/<大纲>/beats/b<NN>.md` | `title` · **`outline`（必填）** · `order` · `chapters` · `status` | 这一拍发生什么；章范围现算，不写 |
| `chapter` | 章节 | `chapters/*.md` | `title` · `status` · `beat`（可选） · `order` | 章节正文 |
| `state-character` | 角色现状 | `state/characters/<名>.md` | `title` · `name` · `aliases` · `status` | 此刻处境、知道什么、关系 |
| `foreshadowing` | 伏笔账 | `state/foreshadowing.md` | — | 埋/收/放弃的清单 |
| `progress` | 章节流水 | `state/progress.md` | — | 最近章节的滚动窗口，一章一节 |

**分节不规定。** 任何资产都允许出现任意 `##`/`###`；模板（§6）只是新建时的一种起点。

### 枚举的稳定值

| 字段 | 值（frontmatter 存稳定值；中文名在种类定义里） |
|---|---|
| `brief.channel` | `男频` / `女频` / `双频` / `不限`（直接存中文标签——它是封闭集合且不参与逻辑） |
| `character.role` | `protagonist`（主角） / `antagonist`（反派） / `supporting`（配角） / `minor`（龙套） |
| `character.status` / `state-character.status` | `active` / `archived`（角色）；`active` / `dead` / `missing` / `unknown`（现状） |
| `outline.status` | `planning` / `in_progress` / `done` |
| `beat.status` | `pending` / `in_progress` / `done` |
| `chapter.status` | `draft` / `published` |
| `beat.chapters` | 整数 ≥ 1 |
| `outline.startChapter` | 整数 ≥ 1 |

## 3. 头部格式（frontmatter）

```md
---
kind: beat
title: 进内城
outline: design/outline/第1卷.md
order: 1
chapters: 3
status: pending
---
主角第一次进内城，撞见漕运的人。
```

规则：

- 只在**第一行**是 `---` 时才算头部；不闭合 = 没有头部（正文原样）。BOM 会被剥掉。
- 支持：字符串（裸写或引号）、整数/小数、`true`/`false`/`null`、行内列表 `[a, b]`、块列表
  （`- item`）。**不支持嵌套映射**——碰到会报 problem，不静默吞。
- 未知字段**原样保留**：以后加字段，旧版本写回不会把它删掉。
- 字段顺序：`kind` → 注册表声明的字段 → 其余按字典序。写回稳定，diff 干净。
- 数组写 `tags: [甲, 乙]`；空数组写 `[]`；标题里带冒号/引号会被自动加引号。
- 头部坏了（语法错误、类型不对、必填缺）只进 `problems`，**文件仍可读可列**；写入时拒绝。
- `kind` 与路径不一致 → problem；路径是种类判定的第一判据。

## 4. 节拍：独立文件，挂在大纲上

### 4.1 位置与归属

- 节拍目录由大纲路径派生：`design/outline/第1卷.md` → `design/outline/第1卷/beats/`；
  `design/outline/vol_1/s1.md` → `design/outline/vol_1/s1/beats/`。
- 文件名 `b<NN>.md`（`b01.md`），**顺序的真相是 `order` 字段**，文件名只是排布。
- 归属的真相是头部的 `outline` 字段（项目相对路径）。大纲文件里**不存节拍清单**——
  两份清单就是两份真相。

### 4.2 章范围（不存章号）

```
大纲.startChapter = 10
b01 chapters=2  →  第 10–11 章
b02 chapters=5  →  第 12–16 章
b03 chapters=1  →  第 17 章
```

现算函数：`chapterRangeOf(outline, beats, beatPath)`。改 `chapters`，后面每一拍的范围自动跟着变；
改顺序，重排 `order` 即可。**节拍头里不写起始章**。

### 4.3 大纲的正文写什么

写方向、阶段、因果，不写节拍清单，也不写"第几章发生什么"——那些各是节拍文件。大纲的
`startChapter` 只定这一份大纲的起点，节拍在其上累计。

## 5. 增删改查的语义

四个原语都在 `framework/assets.ts`，不是模型工具、不弹审批；将来的 UI/CLI 就是"点头的人"。
落盘走 `storage/atomic`：CAS + 原子写（先临时文件再 rename）。

| 操作 | 契约 |
|---|---|
| **create** | 种类 + 标题 → 路径（或显式 `path`，必须与种类对上）；排他创建，同名即拒；`order` 自动排在同类末尾；节拍必须给 `outline` 且大纲已存在；概览只允许一份（`brief.md` 与 legacy `core.md` 都算） |
| **update** | 按字段合并；未知字段保留；`drop` 显式删键；CAS 基准是调用方读到的字节（不给则现读）；头部有问题时拒绝更新，先修头 |
| **move** | 改名/换位置；种类必须不变、目标不能已存在；大纲还有节拍指向它时拒绝；节拍只能在自己的节拍目录里移动 |
| **delete** | 默认**不级联**：大纲还有节拍 → 拒绝并列出节拍；`cascade` 才连带删。正文里按名字提到角色这类引用**不做检查**（不在底座范围） |

**已知代价**（记在这里，免得当成 bug）：

- 标题 → 路径会去掉不安全字符（空格、`·`、标点）：`漕运 · 河道` → `漕运河道.md`。想保留
  文件名就显式给 `path`，但 `path` 仍受 `safeRelPath` 的字符类限制（`·` 写不进去）。
- 删除大纲 + `cascade` 时先删节拍再删大纲；中途失败可能留下"节拍已删、大纲还在"的半截状态，
  下一次 list 看得见，重试即可。
- 移动**带节拍的大纲**不自动搬节拍目录：拒绝并让调用方先处理，避免路径派生规则在移动里被绕过。

## 6. 模板与旧文件

- 新建时给"空白 / 按模板"两种起点：模板只是**初始正文**（从旧的结构规范整理过来），
  之后怎么改都行，不校验、不拒绝。
- 旧项目**零迁移**可读：
  - 无 frontmatter 的 `core.md` / `characters/*.md` / `vol_*.md` / `chapters/*.md` 照常成资产，
    `kind` 由路径判定，标题取"文件名或正文 H1"。
  - 旧角色卡的必有五格、旧卷纲的六格都只是正文内容，不再是门槛。
  - 第一次 `update` 会补上 `kind` 与 `title`，其余字节按合并规则写回。

## 7. 怎么加一种资产

1. 在 `assets/kinds/` 加一个 `<id>.json`：文件名即 `id`；写 `id` / `label` / `section` / `order` /
   `match` / `create`（可选）/ `fields`。格式见同目录 `README.md`。
2. 路径模式不能与已登记的种类冲突（加载时会直接报错）。先想清楚"新种类会不会被旧模式吃掉"；
   同一路径命中多个模式时**更长的胜出**，但重复登记不被允许。
3. 需要机器读的字段才进 `fields`；不认识的键、缺 `values` 的枚举、类型不对的默认值都会在加载时
   报错（带文件路径），不会静默忽略。
4. 加用例到 `tests/assets.test.ts`（新定义的路径判定 + 新建 + 读取回环；坏定义的报错形态）。
5. 本文件 §2 加一行。**代码没有第二个地方要改**：`kindOf` / `listAssets` / `createAsset` 都从
   目录加载；打包时 `assets/` 会自动随 `prompts/` `skills/` 一起发（见 `desktop/electron-builder.yml`）。

## 8. 明确不做（这一版）

- **不做 UI**：目录树、表单、拖拽都还没接；CLI 这一层已经能验收底座（`/assets` 列清单、
  `/asset new|show|set|move|delete`）。
- **不做派生索引文件**（`.json` / 数据库）：每次现算。
- **不校验正文**：不要求必有小节、不要求角色五格、不拒绝自由结构。
- **不做关系图谱**：节拍→章范围是现算；伏笔/关系仍是弱引用，不建外键表。
- **不做引用级联**：删除只处理"节拍→大纲"这一层，其余交给调用方。
- **工具面已经拆完**：规范查询、两段式提案、草稿模式与旧确认工具都已删除；整篇成稿是一次
  `write`（用户看 diff）。剩余的拆层记录在 `notes/资产优先工作台重构.md`。

## 9. 相关源码

| 文件 | 职责 |
|---|---|
| `framework/assetkinds.ts` | 种类定义加载器：按目录发现 `assets/kinds/*.json`、严格校验（id 与文件名一致、路径模式不重复、枚举/默认值合法） |
| `storage/kind_definitions.ts` | 定义的取数口：把 `assets/kinds/` 读成 `{name, path, text}`（framework 不直接碰文件系统） |
| `framework/assets.ts` | 消费注册表：`kindOf`、`parseAsset`、`listAssets`、四个 CRUD 原语、`beatsOf` / `chapterRangeOf` |
| `framework/frontmatter.ts` | 头部格式的最小 YAML 子集：解析、序列化、round-trip |
| `cli_assets.ts` | `/assets` 与 `/asset ...` 的参数解析、清单与结果文本；删除确认由调用方注入（CLI 传 `rl.question`，测试传回调） |
| `cli.ts` | 斜杠命令的转发层（不碰资产语义） |
| `storage/corpus.ts` | 三个根的枚举与读取（资产扫描的取数口） |
| `storage/atomic.ts` | CAS + 原子写；创建/更新/移动/删除的落盘原语 |
| `storage/util.ts` | `safeRelPath`：路径字符类与穿越防护 |

> UI 接入时只需调这四个原语，**不要**在壳里另写一套"读目录 / 拼路径 / 直接写文件"：
> 种类判定与路径安全必须只有一处。