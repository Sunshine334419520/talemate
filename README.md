# talemate

AI 小说创作 Agent —— 以"活的小说项目空间"为中心的创作系统。设计段把企划做厚、写作段结构先行（先出节拍再写正文），用户当主编拍板；**不设事后打分/评判循环**。

## 运行

```bash
bun install

bun run cli          # 进入 REPL
bun run smoke        # mock provider 离线冒烟（无需 API key）
bun test             # 单元测试
bun run typecheck    # tsc --noEmit
```

CLI 用法：`talemate new <书名> [题材]` · `talemate ls` · `talemate use <id|书名>`；REPL 内 `/help` 看命令。

模型配置走环境变量（`TALEMATE_PROVIDER` / `TALEMATE_MODEL` / `TALEMATE_REASONING` / `TALEMATE_MAX_TOKENS` / `TALEMATE_API_KEY` …），mock provider 无需 key。

## 一次创作长什么样

```
talemate new 我的小说 悬疑
  → 进 editor 会话，聊想法 → 企划长成 design/ 四层活文档
  → "写第 1 章" → 先出节拍，你拍板 → 再写正文（writer）→ 落 chapters/
```

项目落在 `~/.talemate/novels/<id>/`（可用 `TALEMATE_HOME` 改），目录结构见 `docs/architecture.md`。

## 代码结构

| 模块 | 职责 |
|---|---|
| `src/cli.ts` `src/smoke.ts` | CLI + REPL 入口 / 离线冒烟 |
| `src/agent/` | Agent 注册表：editor(primary) / writer / summarizer(hidden) |
| `src/session/` | 会话接线、agent 循环、上下文压缩 |
| `src/tool/` | 工具框架 + 内置工具（design / character / framework / core / web 五个领域） |
| `src/framework/` | 写作领域层：层规范、写盘唯一实现、提案渲染、markdown 手术、角色卡、引用搜索 |
| `src/llm/` | provider 抽象（anthropic / openai 兼容 / mock）+ 流式多轮 |
| `src/storage/` | 文件系统项目 / 会话存储 |
| `src/skill/` | SKILL.md 发现与解析 |
| `src/prompts.ts` | 加载 `prompts/*.txt` |
| `src/probe/` `src/legacy/` | 消融实验工具、遗留代码（开发用，不属产品路径） |

## 文档

| 想知道 | 去哪 |
|---|---|
| 这个产品为什么存在、不做什么 | [`docs/product.md`](docs/product.md) |
| 代码怎么组织、一次交互怎么走 | [`docs/architecture.md`](docs/architecture.md) |
| Agent / 工具 / Skill 怎么分类与触发 | [`docs/agents.md`](docs/agents.md) |
| 企划的四层活文档与两段式落盘 | [`docs/design-docs.md`](docs/design-docs.md) |
| 角色卡长什么样、怎么维护 | [`docs/characters.md`](docs/characters.md) |
| 大纲由什么构成、为什么没有整本大纲 | [`docs/outline.md`](docs/outline.md) |
| 还没做什么 | [`docs/roadmap.md`](docs/roadmap.md) |
| prompt 怎么组织、怎么写 | [`prompts/README.md`](prompts/README.md) |
| 写代码的约定与硬约束 | [`CLAUDE.md`](CLAUDE.md) |
