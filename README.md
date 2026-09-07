# talemate

AI 小说创作 Agent —— 以"活的小说项目空间"为中心的创作系统。设计段把企划做厚、写作段结构先行(规划→节拍)+ 用户当主编拍板;不设事后打分/评判循环。

```
受管根目录（TALEMATE_HOME，默认 ~/.talemate/）
└── novels/<project-id>/        ← 一小说一目录（用户只认书名）
    ├── talemate.json           # 项目元信息（id/书名/题材/创建时间/角色覆盖）
    ├── AGENTS.md               # 项目规则（常驻注入）
    ├── design/                 # 设计段：企划活文档（懒建，按需 doc-spec 成稿）
    │   ├── core.md             #   核心层：小说介绍（常驻）
    │   ├── wiki/world.md       #   世界层总纲（常驻）；wiki/<题>.md 专题页按需读
    │   ├── characters/         #   人物层：一角色一卡 <名>.md + _index.md 总表
    │   └── outline/            #   情节层：outline.md 整本 + plan_ch<N>.md 章节细纲
    ├── chapters/               # 写作段：成品正文 chapter_ch<N>_v<M>.md
    ├── skills/                 # 项目级 SKILL.md（可选）
    └── .talemate/sessions/<id> # 会话元 + messages.jsonl
```

## 运行

```bash
bun install

bun run cli          # 进入 REPL
bun run smoke        # mock provider 离线冒烟（无需 API key）
bun run test         # bun test
bun run typecheck    # tsc --noEmit
```

CLI 用法：`talemate new <书名> [题材]` · `talemate ls` · `talemate use <id|书名>`；REPL 内 `/help` 看命令。

## 结构

| 模块 | 职责 |
|---|---|
| `src/cli.ts` | CLI + REPL 入口 |
| `src/agent/registry.ts` | Agent 注册表：editor(primary) / planner / writer(subagent) / summarizer(hidden) |
| `src/session/*` | 会话接线、agent 循环(runLoop)、上下文压缩(compaction) |
| `src/tool/*` | 工具框架 + 16 个内置工具(doc/character/framework/core) |
| `src/framework/*` | 写作领域层：doc_spec / markdown 区块手术 / characters 角色卡 / search 引用 / report 现状卡 / anchor 常驻设定 |
| `src/llm/*` | provider 抽象(anthropic / openai 兼容 / mock) + 流式多轮 + 工具循环 |
| `src/storage/*` | 文件系统项目/会话存储 |
| `src/skill/*` | SKILL.md 发现与解析 |
| `src/prompts.ts` | 加载 `prompts/*.txt` 提示词 |

模型配置走环境变量（`TALEMATE_PROVIDER / TALEMATE_MODEL / TALEMATE_REASONING / TALEMATE_MAX_TOKENS / TALEMATE_API_KEY …`），mock 无需 key。

## 文档

当前基准：**`08-architecture.md`**（当前架构与流程总览）、`05-agent-spec.md`（Agent/工具规范，与代码一致）、`prompts/README.md`。设计演进记录：`04-harness-design.md`（harness 顶层）、`02-product-definition.md`（产品定义）、`06-framework-and-mode-notes.md`（§7/§8 为现行）、`07-editor-framework-design.md`、`03-implementation-plan.md`（注意 §3/§4 已成历史）。
