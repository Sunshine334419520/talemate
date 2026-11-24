# glob / grep 工具设计（对照 opencode）

> **职责**：定下 `glob` 与 `grep` 两个基础工具的 schema、语义、输出、限额与实现落点。
> **读者**：要实现这两个工具、替换 `list`/`search`、改 prompt/白名单/测试的人。
> **状态**：2026-11-24 · 设计稿，未实现。
> **相邻**：`notes/工具面重构.md` §9（为什么删 `list`/`search`）· `docs/agents.md` · `docs/architecture.md`

## 0. 结论

做**两个**工具，**一个共享扫描器**：

- `glob`：按模式找**文件路径**，不读内容；
- `grep`：按正则找**文件内容**，返回文件 + 行号 + 行文本。

实现不引 ripgrep、不 spawn 子进程：我们的语料是**语料根注册表**里那些目录下的 `.md`（今天登记
`design/` / `chapters/` / `state/`），`storage/corpus.ts` 已经有唯一 walker；把"过滤 + 渲染"接在它
上面就行。opencode 值得抄的是**工具形状与限额**，不是它的 rg 引擎。

## 1. opencode 是怎么实现的（事实）

### 1.1 glob

`packages/opencode/src/tool/glob.ts`：

```ts
Parameters = { pattern: string, path?: string }   // path 是目录，默认 cwd
ripgrep.glob({ cwd: search, pattern, limit: 100 })
```

- `path` 指向一个**目录**；指向文件直接报 `glob path must be a directory`；
- 越出工作区要过 `external_directory` 权限；
- `rg --files --glob=<pattern> .` 拿文件，去掉开头的 `./`；
- 结果**绝对路径**，上限 100；到 100 就标 truncated 并提示"缩小 path/pattern"；
- 空结果输出 `No files found`。

### 1.2 grep

`packages/opencode/src/tool/grep.ts`：

```ts
Parameters = { pattern: string, path?: string, include?: string }
ripgrep.grep({ cwd, pattern, include, limit: 100 })
```

- `pattern` 是**正则**；`path` 可以是目录或**具体文件**；`include` 是文件 glob（如 `*.ts`）；
- 内部 `rg --json`，取 `path` / `line_number` / `lines.text` / `submatches`；
- 输出按文件分组：

  ```
  Found 3 matches (more matches available)

  /abs/path/a.ts:
    Line 12: ...
  ```

- 上限 100；截断提示"用更具体的 path/pattern"；空结果 `No files found`；
- 单行超过 2000 字符截断；非法正则从 rg stderr 里识别成 `InvalidPatternError`。

### 1.3 共享引擎

`packages/core/src/ripgrep.ts` 是唯一执行层：

- `glob` → `rg --no-config --files --glob=<pattern> --glob=!**/.git/** .`
- `grep` → `rg --json --hidden --no-messages [--glob=include] -- pattern <path>`
- `glob` / `find` / `grep` 三个入口共用 `run()`：流式读 stdout、`limit + 1` 判断截断、
  识别 rg 的退出码 0/1/2、把 JSON 逐行解码；二进制由 `ripgrep/binary.ts` 按平台下载到
  `Global.Path.bin`（v15.1.0，win/mac/linux 各架构）。

**架构要点**：工具不自己 walk 文件系统；它们只声明"搜什么、范围、上限、怎么展示"，执行与截断统一
在一个引擎里。这是 opencode 最值得抄的一条。

## 2. 抄什么、不抄什么

| 抄 | 理由 |
|---|---|
| **两个独立动词** `glob` / `grep` | 找路径与找内容是两类问题；合成一个工具会让 schema 含糊 |
| **`pattern` + 范围** | 范围用 `path`（目录/文件）+ `include`（文件 glob），与用户心智一致 |
| **固定上限 + 截断说明** | 不让模型用 `head_limit`/分页把上下文撑爆；到顶就明说 |
| **空结果是正常结果** | 回"没有匹配"，不回错误 |
| **正则、字面量、忽略大小写** | 三种最常用的搜索方式；`literal` 避免模型为中文标点转义 |
| **按文件分组的输出** | 与现有 `search` 的排版一致，读起来是"文件 → 行" |

| 不抄 | 理由 |
|---|---|
| **ripgrep 二进制 / 子进程** | 我们要在 Bun、Node、Electron 主进程三处一致运行；发一个平台二进制（还要下载/校验）成本远大于收益。语料是几十到几百个 `.md`，JS 扫描足够 |
| **绝对路径** | talemate 全仓只有一个路径口径：项目相对（`design/characters/沈越.md`） |
| **`.gitignore` / hidden / follow** | 语料的边界是**语料根注册表**（`talemate.json.corpusRoots`，见 `core/roots.ts`），不是整个项目目录；不跟随符号链接，不读 `.talemate/` |
| **每工具的 permission ask** | `glob`/`grep` 是只读；范围已经由注册表锁死。Claude Code 的 Read/Glob/Grep 在工作目录内也不问 |
| **`output_mode` / `before`/`after`/`offset` 等全量参数** | 先给最小面；`context` 留到有实测需求再加（见 §7） |

## 3. 我们的语义

### 3.1 共享扫描器

```
tool/glob ─┐
           ├─→ framework/find.ts ─→ storage/corpus.enumerateDocs(projectId, scope)
tool/grep ─┘                         └→ readDoc（只有 grep 需要）
```

- 候选集 = **语料根注册表里所有可读的根**下的 `.md`（今天 `design/` / `chapters/` / `state/`），
  不读 `.talemate/`；注册表加一家，这里自动多一家，**工具代码一行不改**；
- 路径一律**项目相对**；
- 过滤顺序：范围（`path`）→ 模式（`pattern` / `include`）→ 读内容（仅 grep）；
- 一次调用只 walk 一次目录。

### 3.2 `glob`

```jsonc
{
  "pattern": "design/**/*.md", // 必填
  "path": "design"             // 可选：目录，默认项目根
}
```

**pattern 语法**（第一版只支持这四样，写进 description）：

| 写法 | 含义 |
|---|---|
| `*` | 段内任意字符，**不跨 `/`** |
| `**` | 任意层目录（`**/` 可匹配零层） |
| `?` | 段内一个字符 |
| 无 `/` 的模式 | 按**文件名**在任意深度匹配（`*.md` = 所有 md，等价 ripgrep 的 `--glob=*.md`） |

不支持：brace `{a,b}`、extglob、取反 `!`。要排除就缩小 `path`。

**规则**

- `path` 必须是目录（指向文件 → 回"path 是文件；glob 只收目录"）；
- `path` 不存在 → 回"没有这个目录 + 可用根"（自愈文案）；
- 输出项目相对路径，按 `localeCompare("zh", { numeric: true })` 排序（`vol_2` 在 `vol_10` 前）；
- 上限 **100** 个文件；到顶 → 截断提示；
- 0 个 → `没有匹配的文件。`（可带一句"用更具体的 path/pattern"）；
- 不返回目录项。

**输出**

```
design/characters/沈越.md
design/outline/vol_1.md
design/outline/vol_1/beats/b01.md

（结果已截断：只显示前 100 个文件；缩小 path 或 pattern 再试。）
```

### 3.3 `grep`

```jsonc
{
  "pattern": "伏笔",              // 必填；正则
  "path": "design",               // 可选：目录或具体文件；默认项目根
  "include": "characters/*.md",   // 可选：在 path 之下再按文件 glob 过滤
  "literal": false,               // true = 当普通文本（中文标点不必转义）
  "ignoreCase": false,
  "context": 0                    // 可选 0–3：匹配行前后各带几行
}
```

**规则**

- `path` 是文件 → 只搜这一份（`include` 忽略）；是目录 → 搜其下；
- `path`/`include` 不能穿出项目根（拒绝绝对路径、`..`）；
- 只搜 `.md`；跳过读不出来的文件（不报错，继续）；
- 正则写坏 → 回一条中文自愈文案，不抛裸异常：
  `正则写坏了：<JS 错误>——改一下 pattern；要按普通文本搜就加 literal:true。`
- 上限：总 **100** 条命中、单文件 **20** 条；单行超过 **500 字符**截断；
- 行号 1 起；`context>0` 时上下文行用 `-` 分隔（grep 惯例）；
- 命中里包含 frontmatter 与标题行（grep 是文本搜索，不做语义过滤）。

**输出**（分组，沿用 `framework/search.ts` 的排版）

```
「伏笔」命中 3 处，显示全部：
design/outline/vol_1.md
  42: 旧债：漕运那本账册在第 3 章埋下，本卷必须收。
  57: 禁揭：不要提前说出沈越的身份。
state/foreshadowing.md
  8: 漕运账册 → 第 12 章收（已暗示）。

（单文件超过 20 条时只显示前 20 条，并标注"本文件还有 N 处未显示"。）
```

0 条 → 沿用现有文案：`「<pattern>」在文档里没有命中。`

### 3.4 例子

| 目的 | 调用 |
|---|---|
| 列出所有角色卡 | `glob {"pattern":"design/characters/*.md"}` |
| 找所有卷纲 | `glob {"pattern":"**/vol_*.md"}` |
| 找节拍文件 | `glob {"pattern":"design/outline/**/beats/*.md"}` |
| 全书搜"伏笔" | `grep {"pattern":"伏笔"}` |
| 只搜角色 | `grep {"pattern":"底线","path":"design/characters"}` |
| 只搜章节里的章号写法 | `grep {"pattern":"第[一二三四五六七八九十]+章","path":"chapters"}` |
| 搜含 `·` 的专名 | `grep {"pattern":"漕运·河道","literal":true}` |

## 3.5 新增目录：候选集由注册表给，不由工具给

"三个根"不是工具的知识，是**语料层的注册表**。glob/grep 只调 `enumerateDocs(projectId)`，
所以新增目录的正确处理方式是**往注册表里加一条**，不是改工具：

### 现状：项目级注册表（已实现）

根表住在项目元数据里：`talemate.json` 的 `corpusRoots`，类型 `CorpusRoot` 在 `core/roots.ts`。
`createProject` 种下默认三根；老项目没有这个字段就按默认三根，零迁移。`corpus.enumerateDocs`、
`write_ops`、`glob`/`grep` 与权限 pattern 都从 `projectCorpusRoots(projectId)` 取数：

```jsonc
{
  "corpusRoots": [
    { "id": "design",   "dir": "design",   "read": true, "write": true,  "search": true },
    { "id": "chapters", "dir": "chapters", "read": true, "write": true,  "search": true },
    { "id": "state",    "dir": "state",    "read": true, "write": true,  "search": true },
    { "id": "notes",    "dir": "notes",    "read": true, "write": true,  "search": true }
  ]
}
```

- `enumerateDocs` 取 `search && read` 的根；`write_ops` 取 `write` 的根；权限 pattern 按 `id` 生成；
- **glob/grep 仍然一行不改**——它们只需要一个"可搜索路径集合"；
- 新增目录 = 改项目元数据（或产品默认值），不需要发版；工具代码一行不动。
- `write` 蕴含 `read`（写之前必须读得到，否则 CAS 无从谈起）；一个合法条目都没有时回默认三根。

### 不要做的三件事

1. **不要 walk 整个项目目录**：`.talemate/sessions`、未来的二进制/引擎目录会被搜进来；
   用"注册表 + 能力位"表达范围，不要用"排除了哪些目录"。
2. **不要在 glob/grep 里再写一份根清单或排除清单**：第二份清单一出现，读写与搜索就会各说各话。
3. **不要让 glob 返回 `read` 读不到、或 `write` 写不了的路径**：候选集与可寻址集必须是同一份。
   这条要用测试钉住（见下）。

### 守卫（建议随 glob/grep 一起加）

- `glob("**/*.md")` 的结果集合 == `enumerateDocs(projectId)`；
- `enumerateDocs` 里每一条都能被 `readDoc` 读到；
- 每个 `write` 根都同时是 `read` 根（写之前必须读得到）；
- 注册表里的每个根都能在 `projectPaths` 里解析到绝对路径（新加根忘了映射 → 编译期或测试红）。

## 4. 实现落点

| 位置 | 做什么 |
|---|---|
| `framework/glob.ts`（新） | `globToRegExp(pattern)` / `matchGlob(path, pattern)`；处理 `*`/`**`/`?`/无斜杠 basename；Windows 大小写不敏感；单测盯语义 |
| `framework/find.ts`（新） | 共享扫描：解析范围 → `enumerateDocs` → 过滤 → `glob` 渲染 / `grep` 逐行扫描与上下文 → 截断 |
| `tool/find_tools.ts`（新） | `globTool` / `grepTool` 两个薄壳；description 用 `P("glob")` / `P("grep")` |
| `prompts/tools/glob.txt` / `grep.txt`（新） | 英文、面向模型；写清语法、范围、上限与"何时用 Task" |
| `core/types.ts` + `session.ts` | `ToolContext` 加 `globDocs(pattern, path?)` 与 `grepDocs(opts)`；实现转给 `framework/find.ts` |
| `tool/read_tools.ts` | 删 `list` / `search` 定义（`read` 不动） |
| `agent/registry.ts` | mate / planner / researcher 的白名单：`list`/`search` → `glob`/`grep` |
| `docs/agents.md` | 工具表换两行；触发矩阵里"list/read/search"改成"glob/read/grep" |
| `prompts/tools/read.txt` | "Run list first" → "Run glob first" |
| `framework/anchor.buildIndex` / `summaries.ts` | **先保留**：只服务 `read` 的"没有找到文档，可用：…"；不再有模型入口 |
| `storage/corpus.scanDocs` | **保留**：`delete` 的引用检查仍用它（内部能力，不是工具） |

**为什么 `glob`/`grep` 也走 `ToolContext`**：`tests/layering.test.ts` 禁止 `src/tool` 直接 import
`storage/`。工具层只能拿渲染好的结果；取数与路径口径留在 framework/storage。

## 5. 测试矩阵

**matcher（`framework/glob.ts`）**

- `*.md` 命中任意深度的文件名；`design/*.md` 只命中一层；`design/**/*.md` 命中多层；
- `**/vol_*.md` 命中 `design/outline/vol_2.md`，不命中 `vol_2/s1.md`；
- `?` 单字符；`*` 不跨 `/`；`**` 跨 `/`；Windows 下大小写不敏感；
- 不支持的语法（`{a,b}`、`!x`）按字面处理并写进文档，不静默当成通配。

**glob 工具**

- 只返回文件、排序（`vol_2` < `vol_10`）；
- `path` 是文件 → 自愈错误；`path` 不存在 → 自愈错误；
- 空结果文案；>100 截断文案与 `truncated` metadata。

**grep 工具**

- 正则 / `literal`（`漕运·河道`）/ `ignoreCase`；
- `path` 目录 / 文件 / `include` 三者组合；
- 非法正则的自愈文案；0 命中；
- 单文件 21 条 → 显示 20 条 + "本文件还有 1 处"；
- 总分 101 条 → 显示 100 条 + 截断；单行 600 字符截断；
- `context: 1` 的前后行格式；CRLF 文件的行切分；
- 中文路径与中文正文。

**替换守卫**

- `BUILTIN_TOOLS` 不再含 `list`/`search`；`docs/agents.md` 工具表同步（`tests/docs.test.ts` 会抓）；
- agent 白名单里不再有 `list`/`search`；`tests/agents.test.ts` 更新；
- `read` 的 "use list" 文案更新（`tests/prompts.test.ts` 若覆盖）。

## 6. 迁移顺序

1. `framework/glob.ts` + `framework/find.ts` + 单测（不接工具，先绿）；
2. `ToolContext` 两个方法 + session 实现；
3. `tool/find_tools.ts` + prompt 两篇 + 白名单；
4. 删 `list`/`search` 工具与 prompt；改 `read.txt` / planner / researcher；
5. 更新 docs/agents、README 工具相关段落与测试；
6. `bun test` + `typecheck`（没碰 prompts/probe 的替换串，不用 `probe --check`）。

## 7. 开放问题

1. **无斜杠模式的语义**：`*.md` 是"任意深度按文件名匹配"（本设计，ripgrep/opencode 行为），
   还是"只在根目录一层"（标准 glob 行为）？我选前者——模型与用户都更常想"所有 md"。
2. **输出分组还是逐行**：本设计选按文件分组（沿用现有 `search` 的排版）；若模型解析更偏好
   `path:line:text`，改成逐行只是一处渲染。
3. **`context` 第一版要不要**：本设计给 0–3；opencode 没有，reveric 有。若想更小，先删掉它，
   等"要看前后文"成为实测需求再加。
4. **上限是否可调**：opencode 固定 100；本设计固定（glob 100 / grep 100 总、20 单文件）。
   不给 `limit` 参数，避免模型用分页把上下文撑爆。
5. **要不要把 `glob`/`grep` 并成一个 `find`**：不并。两个动词两个问题，schema 也更清楚。
6. **根注册表这一轮做到哪一步**：已完成——项目级 `talemate.json.corpusRoots`（`core/roots.ts`），
   glob/grep 与读写两侧都从同一张表取数。
   但 §3.5 的能力位（read/write/search）现在就想清楚——将来迁移时工具不用动。