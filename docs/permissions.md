# 权限：谁能做什么、什么要问

> **职责**：回答"一次动作要不要问用户、能不能做、由谁决定"。
> **读者**：要加工具、加 agent、加模式，或改任何"确认"行为的人。
> **对齐代码**：2026-09-22 · 规则实现在 `src/permission.ts`，规则表在 `agent/registry.ts` 与 `agent/modes.ts`
> 相邻：`agents.md`（角色与工具名册）· `design-docs.md`（两段式落盘）· `architecture.md`（一次请求怎么走）

## 一句话

**每个会改变世界的动作，都要先问一句"这个动作、这个对象，现在该怎么办"。答案来自一张有序的规则表，而不是散落在工具里的 `if`。**

## 三个概念

```
动作 = (permission, pattern)      做什么 · 对什么做
规则 = { permission, pattern, action }
规则集 = Rule[]                   有序，后写的优先级高
```

- `permission` 是**动作类别**，只有四个（见下）
- `pattern` 是**这次的具体对象**——文件路径 / 子代理 id / URL。用通配符匹配，`*` **跨 `/`**，所以 `design/*` 就是 design 下一切
- `action` 三档：`allow` / `ask` / `deny`

## 四个动作类别

| permission | 覆盖哪些工具 | pattern 是什么 |
|---|---|---|
| **`edit`** | `write` · `edit` · `delete` · `apply-design` | 目标文件在 `design/` 或 `chapters/` 下的相对路径（**项目相对**，与工具入参同一口径） |
| **`delegate`** | `task` | 子代理 id |
| **`extern`** | `webfetch` · `websearch` | URL / 查询词 |
| **`question`** | `ask-user` · `confirm` | `*`（这两个工具没有"对什么做"） |

**刻意不设权限的**：`read-design` / `list-designs` / `search-designs`（读设计文档是这个产品的日常，且我们没有 `.env` 那种"读了就是泄露"的对应物）· `design-spec` / `skill`（只往上下文里放东西）· `propose-design` / `propose-plan`（**两段式已经是一道更严的门**，见文末）· `enter-draft` / `exit-draft`（模式切换）。

**少一类就少一处要维护的规则。** 真需要时再加是加法，不是改法。

## 求值

```ts
evaluate(permission, pattern, ...rulesets): Rule
```

三步，**顺序不能换**：

1. **`deny` 先判**：把**所有**规则集里匹配 `(permission, pattern)` 的 `deny` 找出来——找到任意一条就拒。**这一步不受顺序影响。**
2. 否则在这些规则集上 `findLast` 找**最后一条**匹配的规则，按它的 `action` 走。
3. 一条都没匹配 → **`ask`**（默认问，不是默认放行）。

**第一步是我们和 opencode 的唯一分歧。** opencode 只做第二步（顺序即一切，用户配置最强）。我们额外让 `deny` 单调：**"不许"不该被别处的"允许"盖掉。**

这不是新发明——**opencode 自己在子代理那里就是这么做的**（父的 `deny` 继承、父的 `allow` 不继承）。我们只是把同一条原则推广到求值。

好处：**`draft` 模式的只读不可绕过**——不管用户怎么配、不管层级顺序。想写就退出模式。

## 三档的真实语义

| action | 效果 |
|---|---|
| `allow` | 直接做，不打扰用户 |
| `ask` | 弹给用户，等他回话 |
| **`deny` + pattern `*`** | **工具从 schema 里消失**——模型根本看不到它 |
| `deny` + 具体 pattern | 工具还在，调用时被拒并给出原因 |

第一行和第三行的区别很重要：**`deny *` 是"这个模式下没有这个工具"，不是"有这个工具但会被拒"。** 前者不占上下文、不会诱导模型去试；后者是给"这一类里有一个例外"用的。

## 规则从哪来：四层，顺序即优先级

```
内置默认  →  agent 声明  →  模式覆盖  →  用户配置
```

```ts
// src/permission.ts —— 内置默认
export const BASE_PERMISSIONS: PermissionConfig = {
  edit: "ask", delegate: "ask", extern: "ask", question: "allow",
}
```

**后一层覆盖前一层的 `allow`/`ask` 取舍；`deny` 不受顺序影响（见求值第 1 步）。**

### 写规则只有一种形状

四层**全部**用配置形（`PermissionConfig`）——`talemate.json` 的 `permissions`、`AgentDef.permission`、`ModeDef.permission` 都一样：

```ts
type PermissionConfig = Record<string, Action | Record<string, Action>>;
```

```json
{ "edit": "ask", "extern": { "*": "deny", "localhost*": "allow" } }
```

规则数组（`Rule[]`）是**求值用的内部表示**，手写它很难看，所以对外不暴露。层与层之间用 `mergeConfigs(...)` 拼——**参数的顺序就是优先级**；别在外面手搓 `merge(fromConfig(a), …)`，那是同一条纪律的分散副本。

### 用户可以配什么

写在 `talemate.json`，是这个项目的**长期偏好**（区别于模式的"眼下这一仗"）：

```json
{ "permissions": { "edit": { "*": "allow", "design/core.md": "ask" } } }
```

| 场景 | 写法 | 为什么不能用别的表达 |
|---|---|---|
| 不想被问落盘 | `{ "edit": "allow" }` | 等价于常驻 `accept-edits`——模式会随会话消失，这个是持久的 |
| 联网的开关 | `{ "extern": "deny" }` / `"allow"` | `webfetch`/`websearch` 默认每次都要问，而**联网没有对应的模式** |
| **放宽大部分、收紧一个** | `{ "edit": { "*": "allow", "design/core.md": "ask" } }` | 只有 pattern 能表达。注意用 `ask` 不是 `deny`——默认本来就是 `ask`，用户要的不是"更严"而是"只守这一个" |

**`deny` 单调意味着用户配置不能给模式松绑**：模式写 `edit: deny` 时，用户配 `edit: allow` 也进不去。想写就退出模式。

### 配完怎么确认它生效了

REPL 里 `/permissions` 打印当前规则表——先给**结论**（每类动作现在是什么、**是哪一层定的**），再给**分层**（每层各自贡献了什么）：

```
规则表 · 搭档 · 模式：草稿模式
  现在（按 `*` 算；点名到具体文件的例外见「分层」）：
    edit      deny   ← 草稿模式
    delegate  deny   ← 草稿模式
    extern    ask    ← 内置默认
    question  allow  ← 内置默认

  分层（后写的优先；deny 例外——任何一层说不许就是不许）：
    · 内置默认 — edit: *→ask   delegate: *→ask   extern: *→ask   question: *→allow
    · agent 搭档 — （无）
    · 草稿模式 — edit: *→deny   delegate: *→deny
    · 项目配置 talemate.json —（无）
    · 会话已批准 —（无）
```

**来源那一列是重点。** 只显示结论没用：用户配了一条想放宽、看到的却还是 `deny`，得能一眼看出是被模式盖住了。

提示符上也挂着当前模式（`[草稿模式] 书名/搭档>`）——模式改了能做什么，而它在会话里是隐形的，不显示就没人知道还开着。

## 工具侧怎么声明

**只有一个入口：`ctx.ask`。** 从前那两处（`ToolDef.needsConfirm` 与工具内部的 `confirmBody`）已经并成它一个；
而落盘类工具更进一步——**它们连 `ctx.ask` 都不直接调**，只把 op 交给 `write_ops`，由那一条路径统一去问。

```ts
const verdict = await ctx.ask({
  permission: "edit",
  pattern: "design/characters/林晚.md",   // 这次动什么（**项目相对**，与工具入参同一口径）
  always: "design/characters/*",          // 用户选「以后都允许」时，记下这条规则
  summary: "改写 design/characters/林晚.md",
  detail: "（引用检查等额外材料，可选）\n\n  ## 说话方式\n- 短句、直给。\n+ 越在乎越呛，反话里藏担心。",
})
// verdict: "allow" | "reject" | "deny"
```

- `allow` → 做
- `reject` → 工具返回 `用户已拒绝 …`
- `deny` → 工具返回 `当前模式不允许改文件。要改就先离开这个模式。`

**`detail` 是给人做判断的材料——传的是 diff。** 从前传的是**完整内容**；改成 diff 是因为局部修改要看的是"改了哪一段、落在哪"，而全文恰恰看不出这一点（还吵）。opencode 也是传 diff。

## `always`：会话级的"以后都允许"

用户回话时除了"行/不行"，还能说"**这一类以后都别问**"。这会把 `always` 那一条规则推进一张**会话级 approved 表**，此后同 `(permission, pattern)` 直接放行。

它和待执行提案一样**只在会话内存里**，进程重启即清。它是"每次问"和"模式全放行"之间的中间档——**让它存在，用户才不必为了少问几次而进一个更宽的模式**。

## 子代理：`deny` 继承，`allow` 不继承

`task` 派生一个子会话时，它的规则集是**拼出来的**，不是继承父的：

```ts
deriveSubagentPermission(parent: Ruleset, sub: AgentDef): Ruleset
= [ ...parent.filter((r) => r.action === "deny"),   // ← 只挑 deny
    ...sub.permission,                               // ← 子自己的规则
    ...(子声明了 delegate ? [] : [{ permission: "delegate", pattern: "*", action: "deny" }]) ]
```

**父的 `allow` 不往下传。** 所以 `mate` 在 `accept-edits` 模式里落盘不问，**`writer` 不会跟着免确认**——它按自己的规则走。

**子代理默认不能委派**（除非它自己声明了 `delegate`），这是防链式 spawn。`writer` 也不能 `question`——**子代理跑在隔离上下文里，用户不在场，它一旦能提问就会把用户从自己的对话里硬拽出来。**

## 现在有哪些规则

| 来源 | 规则 | 效果 |
|---|---|---|
| 内置默认 | 见上 | 写盘/委派/联网都要问；提问放行 |
| **agent `mate`** | 无覆盖 | 同默认 |
| **agent `writer`** | `question: deny *` · `delegate: deny *`（默认） | 不能烦用户、不能链式 spawn |
| **模式 `accept-edits`** | `edit: allow` | **落盘不问**；委派与联网照问 |
| **模式 `draft`** | `edit: deny *` · `delegate: deny *` | 只读：那些工具**不在 schema 里** |

**模式用权限表达之后，"加了新工具忘了加进 deny 名单"这个洞从结构上消失了**——`deny *` 自动覆盖所有声明了该类权限的工具。

## 与两种落盘形态的关系

**二向**（`write` / `edit`）走权限：`ctx.ask` 是它唯一那道门。
**三向**（`propose-design` / `propose-plan`）**不走权限**，因为它们是**更严的一道门**：

| | 权限系统（二向） | 三向（草稿模式的出口） |
|---|---|---|
| 问什么 | "这个动作现在能不能做" | "用户看过的字节，是不是就是落盘的字节" |
| 谁判同意 | `ctx.ask` 的返回值 | harness 按用户回话判**三种结局**（`session.draftVerdict`），**模型自述无效** |
| 记忆 | 会话级 `always`（可被覆盖） | 单份提案 + `base` 快照（并发保护） |
| 出口 | 用户当场接受/拒绝 | **接受或拒绝**才退出草稿模式；提意见留在里面接着改 |

所以 `apply-design` **不需要**再问一次——用户已经在提案里看过内容了；但它**仍然过规则表**，
"不许"不因为问过一次就失效（`write_ops` 的 `via:"pending"` 分支）。同理 `propose-plan` 之后的
`task(writer)` 不再问 `edit`：用户批的是那个动作。

## 相关源码

| 文件 | 职责 |
|---|---|
| `src/permission.ts` | `match` / `fromConfig` / `merge` / **`mergeConfigs`**（按层拼的唯一写法）/ `evaluate` / `evaluateWithSource`（说清是哪一层定的）/ `visibleTools` |
| `src/agent/registry.ts` | `AgentDef.permission`：每个角色自己的规则 |
| `src/agent/modes.ts` | `ModeDef.permission`：每个模式的规则（取代今天的 `deny` 名单） |
| `src/session/session.ts` | 持当前规则集；实现 `ctx.ask`；按 `visibleTools` 过滤 schema；`permissionView` 把规则表摊开给人看 |
| `src/tool/runner.ts` | 只管执行 + 类别兜底（`deny *`）；权限判定在工具里走 `ctx.ask`，落盘类工具走 `write_ops` |
| `src/cli.ts` | `/permissions` 打印规则表；提示符挂当前模式与待写入提案 |
