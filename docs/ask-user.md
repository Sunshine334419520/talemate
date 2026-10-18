# 提问：一次创作决策怎么问、怎么答

> **职责**：回答"一次提问怎么问、怎么答、超时/跳过/收起各算什么、回答走哪条路"。
> **读者**：要改 `ask-user`、`confirm`、提问卡片、超时或迟到回答的人。
> **对齐代码**：2026-10-18 · 规则在 `src/session/asks.ts`；工具在 `src/tool/core_tools.ts`；journal 与迟到回答在 `src/session/session.ts` 与 `src/storage/session-store.ts`；计时与路由在 `desktop/src/main/index.ts`；界面在 `desktop/src/renderer/AskCard.tsx`
> 相邻：`agents.md`（工具名册）· `permissions.md`（`question` 权限）· `ui.md`（中栏与输入区）· `architecture.md`（一次请求怎么走）

## 一句话

**提问是创作决策，不是审批。** 一次可以问 1–3 题；用户可能答、跳过、收起、走开。走开不是同意，
收起也不是回答；只有提交或显式跳过才产生答案。超时返回 `pending`，这一轮先停，问题仍然可以回答。

## 线上形状

```ts
interface AskQuestion {
  id: string;                 // 稳定 id；答案里回传
  header?: string;            // 卡片左上角的小标题
  question: string;           // 用户语言；界面按 markdown 渲染
  options?: { label: string; description?: string }[];  // 2–5 个；省略 = 自由回答
  multi_select?: boolean;     // JSON 里 snake_case，域模型是 multiSelect
}

interface AskAnswer { id: string; selected: string[]; custom?: string }
```

- **跳过 = `selected: []` 且没有 `custom`。** 线上没有 `status` 字段；跳过本身就是合法答案，不是 pending。
- **推荐项不另设字段。** label 以「（推荐）」或「(Recommended)」结尾，放在第一项；界面只认这一种写法。
  回传给模型的仍是原 label。
- **单选时 `custom` 覆盖 `selected`**（界面会把 selected 清空）；**多选时两者并存**。
- `timeout` 是整个批次的秒数，默认 120；`-1` 表示不限时，只在该答案必不可少时用。

## 三态与状态机

```
open ──提交──────────────────> answered
 ├──逐题跳过───────────────> answered（该项 selected: []）
 ├──收起───────────────────> open（不发任何消息）
 ├──超时 / 稍后────────────> pending ──回答──> answered（作为新回合送达）
 └──没有回答方 / 中止──────> cancelled
```

| 结局 | 含义 | 工具侧 |
|---|---|---|
| `answered` | 用户提交了（含逐题跳过） | 不 halt，把答案回灌模型 |
| `pending` | 没在截止时间前拿到答案，或用户选择稍后 | **halt**；问题进 journal / tool part，仍可回答 |
| `cancelled` | 没有可用的回答方，或这一轮被中断 | **halt**；不得当成同意 |

**`pending` 必须 halt**，但不等于取消：助手消息照常落盘，tool part 上带着 `ask` 记录；用户回来答，
答案作为一条 `answer_to_pending_question` 用户消息开新回合。模型每轮还会看到 `<open-question>` 注记：
问题还挂着、沉默不是同意、不要替用户回答。

## 回答只走一条路

| 此刻 | 回答去哪 | 结果 |
|---|---|---|
| 工具调用还开着（`waiting` 里有这个 callId） | resolve 等待中的 Promise | 同一回合继续 |
| 已经 pending | 追加一条 `answersTo` 用户消息 | 开一个新回合 |
| 会话正在跑别的回合 | 主进程先排队 | 这一轮结束后自动送达 |
| callId 不认识 | 拒绝，回 `stale` | 卡片显示“这个问题已经结束了” |
| 子代理调用 | `question: deny` 在工具层挡下 | 返回自愈文案，不弹用户的脸 |

主进程在提交前用 `validateAnswers` 再校验一次：答案必须覆盖每一题、label 必须属于该题、单选只能一个。
界面传来的东西不直接进模型上下文。

## 持久化：消息是真相，journal 只补窗口

- **tool part 上的 `ask` 记录**：callId、问题、结局、答案、时间。同一回合答完的追问回看靠它。
- **用户消息上的 `answersTo`**：迟到回答自包含地带回问题原文与答案；压缩之后回看卡仍画得出来。
- **`.talemate/sessions/<id>/pending-ask.json`**：只覆盖“提问已开始、助手消息还没提交”那段窗口。
  助手消息一提交，`openAsks` 就能从 tool part 投影出同一个问题，journal 随即清掉（`Session.hydrate`）。
  它不是第二份问题状态，是 write-ahead 记录。

未答问题从**全部消息**投影，不是模型窗口：压缩只影响上下文，不该让一个没答的问题从界面上消失。
`openAsks` + `mergeJournalAsk` 是唯一判据。

## 界面规则

1. **卡片占住输入框的位置。** 打开时输入框整块让位，卡片像底部弹窗一样贴在中栏底部；上面的对话仍可读。
   收起后输入框回来，留一条“搭档在等你回答”的提示条。
2. **一题一页，提交整批。** 1–3 题用翻页器走；标题、翻页器、提交按钮固定，长问题内部滚动。
3. **单选点击选中并前进；最后一题不自动提交。** 多选只切换。提交永远是一次明确的动作。
4. **Enter / 输入法。** 输入框里 Enter 继续、Shift+Enter 换行；组合中的 Enter 只确认候选。
   聚焦选项按 Enter 是键盘用户的快捷路径：整批都有草稿就提交，否则跳到第一道没答的题。
5. **推荐只是预选。** 第一项带标记时先勾上，但不暂停计时、不提交。
6. **每个会话 + 每个 callId 一份草稿。** 存在本机 `localStorage`；刷新、收起、重开都能恢复。
7. **倒计时会停，但不会停死。** 聚焦暂停；首次编辑或「慢慢回答」转不限时；「稍后回答」立即转 pending；
   收起会把焦点暂停的计时接回来。
8. **已答/已跳过/已超时都以只读卡回看。** 卡占满对话列，表头、问题、答案 pill 逐题列；跳过的说明“当时跳过”。
   **回答不另造一条用户气泡**：迟到回答在落盘时是一条带 `answersTo` 的用户消息，但界面只画只读卡——
   把给模型看的带标记正文渲染成“我手打的一句话”，会像凭空多了一次输入。
9. **问题正文 markdown，选项 label 纯文本。** 问题可以长；选项不做富文本。
10. **工具行与提示条都能重开。** pending 的提问在过程里有一行“提问 · 等待回答 · 打开”。

## 提示词

`prompts/tools/ask-user.txt` 管“怎么问”：1–3 题、2–5 个选项、推荐项放第一并以「（推荐）」结尾、
pending 不是跳过更不是同意。`prompts/mate.system.txt` 的 `# Asking` 管“什么时候不该问”：
能从项目里读到的不问，不拿提问当权限门，跳过或超时都不是同意。

## 为什么不合 `confirm`

两者共享底部弹窗外壳（`ConfirmDock` 用同一套 `.ask-sheet` 样式），但契约必须分开。
审批卡没有收起按钮：它占住输入框直到用户给答复，收起会让搭档一直卡在工具调用里。

- **沉默的安全默认相反。** 提问超时 → pending（问题还在，不授权）；审批没有回答方 → 拒绝。
- **答案形状与副作用不同。** 提问回 `selected + custom`；审批回 `once / always / no`，`always` 会写会话级规则。
- **路由不同。** 提问可以 pending 后补答；审批只在工具调用开着时有意义，是道门。
- **信任边界不同。** 真正的权限门是 `ctx.ask`，不是卡片。合并会把“回答问题”和“批准动作”混成同一件事。

## 验收

- `tests/ask_user.test.ts`：入参校验、答案校验、文案、pending 投影、runner 的 `ask`/`halt`。
- `tests/ask_session.test.ts`：mock provider 下 pending 落盘、迟到回答成为 `answersTo` 用户消息、
  journal 在助手消息提交前救回问题。
- `tests/ask_broker.test.ts`：假时钟下的超时、跳过、重复回答 stale、暂停/恢复、慢慢回答、稍后、
  中断、没有回答方 fail closed。
- `tests/ask_draft.test.ts`：收起/刷新后的草稿恢复、旧草稿非法 label 过滤、坏存储不抛错。
- `tests/ask_ui.test.ts`：卡片限高、正文内部滚动、头尾固定的静态不变量。
- `tests/agents.test.ts`：每个 subagent 都 `question: deny`（子代理不能弹用户的脸）。
- 纯视觉项（长问题与选项的真实像素）仍以 `desktop/prototype/ask-card.html` 或无头浏览器截图为准；
  静态检查只防“限高/滚动/固定头尾”被样式重构删掉。

## 相关源码

| 文件 | 职责 |
|---|---|
| `src/session/asks.ts` | `parseAskArgs` / `validateAnswers` / 结果文案 / `openAsks` / `renderOpenAskNote` |
| `src/core/types.ts` | `AskQuestion` / `AskAnswer` / `AskOutcome` / `AskRecord` / `PendingAskRecord` |
| `src/tool/core_tools.ts` | `ask-user` 的 schema 与 execute；pending/cancelled 时 per-result `halt` |
| `src/tool/runner.ts` | 把 `ask` 记录挂到 tool part，并尊重 per-result `halt` |
| `src/session/session.ts` | journal、`preparePendingAnswer`、`resumeAfterAnswer`、未答注记 |
| `src/storage/session-store.ts` | `pending-ask.json` 的读写 |
| `desktop/src/main/index.ts` | 回答路由与排队；审批 fail closed |
| `desktop/src/main/ask_broker.ts` | 等待表：截止时间、暂停/恢复/稍后、stale、重开视图（可注入时钟） |
| `desktop/src/renderer/AskCard.tsx` | 底部卡片、提示条、只读回看卡 |
| `desktop/src/renderer/ask_draft.ts` | 本机草稿的读写与初始化（纯函数，可离线测） |
