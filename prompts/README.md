# prompts/ —— talemate 自带提示词规范

所有给模型的常驻/协议/工具说明都放这里（照 opencode `*.txt`），TS 侧 `readPrompt()`（`src/prompts.ts`）加载。改提示词 = 改文件，diff/review 干净。

## 布局

```
prompts/
├── README.md                 本规范
├── writer.system.txt         writer subagent 人格
├── planner.system.txt        planner subagent 人格
├── summarizer.system.txt     内部 hidden summarizer（compaction）
└── tools/<tool_id>.txt       每个工具的 description
```

> editor persona 仅一句角色壳，inline 于 `src/agent/registry.ts`。

---

## 语言策略

- **操作/元层 = 英文**：system、协议、工具 description。省 token、跨模型稳。
- **内容层 = 中文**：作品标记（`## 一句话简介`、`（待定）`）、docs、用户可见文案、运行时文案。
- 一份文件内**不中英混排**；中文只在确属"内容/示例字面量"（文档名、小节标题、占位符）时出现。

## 每条提示词的骨架（按需取用）

1. **首行角色 + 边界**："You are…；Your only job…；not a prose writer"。
2. **能力 = 可执行步骤 / "收到什么→产出什么"**，不写形容词。
3. **负向清单**（Rules / Do NOT / 别）——防越界、防多余。
4. **输出契约**：机器/固定格式消费时钉结构；正文类钉"只输出正文"。
5. **few-shot**：需要时给样例，胜过"要高质量"。

## 归属纪律（重要——决定哪些内容根本不进 prompt）

凡能由以下载体承载的，一律归位，不进常驻 prompt（详见 `../06-framework-and-mode-notes.md` §6.6）：

- **数据**：项目是什么 / 文档结构 → 常驻设定注入（core/world 全文，`framework/anchor.ts` `buildResidentDocs`）+ 文档文件骨架（模型每轮看得到，别在 persona 重复）。
- **工具**：能做什么 / 覆盖要 confirm / 删前查引用 → 工具实现 + 工具 description。
- **子代理**：派谁、何时派 → 子代理自己的 `description`（运行时拼进 task 目录）。
- **条件注入/按需规范**：某阶段的做事方法 → 需要时由读取类工具给出（如 doc-spec 返回某层该有哪些小节与成稿做法；写作协议后续）。
- **用户项目规矩** → AGENTS.md（用户管理）。

**因此 persona 只留"角色壳"；每份文件只讲一件事、只在其生效时刻以它自己的载体出现。**

## 反模式（不要写进 prompt）

- 解释"子代理是全新上下文"这类代码已保证的机制。
- 重复工具 description / 重复常驻设定里已有的信息（core/world 全文已每轮注入）。
- 把会随项目变的细节写死成固定文本。
- 一份里塞多个职责；中英混排；长句堆形容词。

## Review checklist（写/改完过一遍）

- [ ] 语言：操作英文；中文只作内容字面量；文件内不混排。
- [ ] 首行定角色 + 边界（协议类除外，但首行也说明"这是什么阶段/干嘛"）。
- [ ] 能力写成步骤或 材料→产出；不要只说"你要负责好 X"。
- [ ] 关键越界点有负向约束（Do NOT）。
- [ ] 输出被机器/固定格式消费 → 有输出契约。
- [ ] 该删的"归属纪律"内容没残留（见上）。
- [ ] 长度克制：agent system ≤ ~80 词；工具 description ≤ ~90 词；协议 ≤ ~250 词（超了拆职责或改载体）。
- [ ] 新文件已接上（registry/builtin 引到 `readPrompt`），`bun run smoke` 能加载不报错。

## 新增一条提示词怎么做

1. 判断它属于：人格 / 协议 / 工具说明，落在 `prompts/` 对应位置。
2. 按骨架写 → 用 `readPrompt("…")` 接进 `src/agent/registry.ts` 或 `src/tool/（按领域模块：doc_tools / character_tools / framework_tools / core_tools（工具 id 用 kebab））`。
3. 先过归属纪律：这份内容有没有更合适的载体（数据/工具/AGENTS/协议）？
4. 过 checklist → `bun run typecheck && bun run smoke`。
