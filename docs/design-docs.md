# 设计文档体系：四层活文档与两段式落盘

> **职责**：回答"企划由哪些文档构成、怎么写进去、怎么改"。
> **读者**：要改 `src/framework/`（design_spec / write_ops / proposal / summaries）或 `src/tool/design_tools.ts` 的人。
> **对齐代码**：2026-09-23 · 结构规范 `framework/design_spec.ts`，语料读写 `storage/corpus.ts`，落盘 `framework/write_ops.ts`
> 相邻：`characters.md`（人物层单独一份）· `outline.md`（情节层单独一份）· `agents.md`（工具的注册与触发）· `product.md`（产品主流程）

## 四层

设计段的产物是**一组分层、持续迭代、随时可改的活文档**。分层的意义：层间**变化频率、影响范围、再生成范围**不同，维护与注入都按层处理。

| 层 | 文档 | 变化特征 | 注入方式 |
|---|---|---|---|
| **核心层** | `design/core.md` | 极少变、一改牵全身、用户必须拍板 | **常驻**注入 |
| **世界层** | `design/wiki/world.md` + `design/wiki/<题>.md` | 慢变、追加为主；长尾拆专题页 | 总纲**常驻**；专题页按需读 |
| **人物层** | `design/characters/<名>.md` | 慢变 | 按需读（见 `characters.md`） |
| **情节层** | `design/outline/vol_<N>.md`（卷纲）+ `design/outline/vol_<N>/s<序号>.md`（序列纲） | 快变、最局部 | 按需读（当前卷 / 序列切片） |

**"层"是产品词汇，不是代码里的一个类型。** 它指的是 `design/` 下的四个目录、以及状态卡与 `mate` 对用户说的那四个名字（核心设定 / 世界观 / 角色 / 大纲）。代码里**没有** `LayerId`、没有按层登记的规范表、也没有 `layer` 参数——文档的归属由**路径**说，别的都不需要。（从前这三样都有，于是"层"这个概念同时当了寻址键、规范匹配键和注入分组；实测下来，只有第一条是多余的。）

**常驻只有两份**：`design/core.md` 与 `design/wiki/world.md`——`anchor.RESIDENT_DOCS` 就是**两条路径**，不再经过"层 id → 路径"那一跳。其余按需 `read`。常驻注入只给可见的 primary（mate）。

**文档格式**：Markdown，`##` 即一格。**读**按"**项目相对路径** + 小节标题"寻址（`read` 的 `path` 与 `section`）；**写**按**锚点**寻址（`edit` 给一段原文与替换文本，见"两种落盘形态"）。不做条目级 ID 引用。

**全仓只有一种路径口径**：项目相对（`design/core.md` / `chapters/chapter_ch2_v1.md`）——工具入参、`FileOp.path`、权限 pattern、`invariants` 与 `SPECS` 的匹配键，全是它。

## 懒建：文件不预种

`createProject` 只建目录、不种文件——`design/` 初始为空。用户要完善某处时，mate 调 `design-spec` 拿那**份文档**（或那个**目录**）的结构规范（该有哪些小节、每格装什么、成稿做法），据此成稿。

**结构与内容分离**：`design_spec.ts` 只定义"长什么样"；文件一旦建立即内容与真相。所以 `design-spec` 是**参考**，不是校验器——文档不按规范组织也能存在，只是模型没拿到引导。规范描述的是**还不存在的文档**，所以它按"将来那个路径"取，不必等文件出现。

## 两种落盘形态

> **用户看过的字节 == 落盘的字节。** 两条路各用各的材料来满足它，都走**同一条流水线**
> （`framework/write_ops.ts`），区别只在**字节从哪来**：

| | 字节从哪来 | 模型可见的工具 | 用户看到什么 |
|---|---|---|---|
| **二向** | 模型**当场组合**（它给 `content` 或 `find`/`replace`） | `write` · `edit` | 一段 **diff**，弹窗问 接受 / 拒绝 |
| **三向** | **从已审阅的提案取**（模型给不了字节） | `apply-design` | 一份**逐格提案**，回话 接受 / 拒绝 / 提意见 |

落盘那条路上，两者汇进同一个 `writeFile`：解析目标 → 读 → 算结果 → 算 diff → 取批准 → CAS + 原子写。

**三向**（`propose-design` → 用户回话 → `apply-design`）：

- **`propose-design` 的 `halt`**：结束本回合，把控制权交回用户。同回合剩下的 tool call 不再执行——但必须补 `error` part（见 `architecture.md` 的 halt 说明）。
- **"同意"由 harness 判**：`Session.markPendingApproval` 按用户回话判**三种结局**（`draftVerdict`：接受 / 拒绝 / 提意见），**模型自述无效**。fail-closed：措辞不常见一律算"提意见"，多走一轮，绝不误判成接受。
- **出口条件是"接受或拒绝"，不是"提案成功"**：提意见留在草稿模式里接着改，所以一次设计会话只进一次模式。
- **并发保护**：提案登记 `base` 快照，落盘前若文件已变则拒绝（CAS）。
- **`apply-design` 不弹窗**——用户已在提案里看过内容；但它**仍然过规则表**，"不许"不因为问过一次就失效。

**为什么三向要这么设计**：一段式（模型当场给字节又自己声称"用户同意了"）等于没有门。三向里
`apply-design` **拿不到正文**——字节只从提案登记取（`proposal.ProposalOp`）——所以模型**想夹带
用户没看过的字也夹带不了**，是"写不出来"而不是"会被检查拦住"。

**提案只有整篇一种形态。** 局部修改走二向的 `edit`：用户看 diff 就够，不必再读一遍全文。想让
用户细看的那一版，哪怕只动了一格，也整篇提出来——渲染里的 `★本版改动` 会指出动过哪几格。

## 寻址：只有路径

提案与落盘都只收一个 `path`：**项目相对路径**（`design/core.md`、`design/characters/林晚.md`、`design/outline/vol_1/s2.md`）。没有第二套词表。

```
propose-design { path: "design/wiki/world.md", content: "…" }   → 用户回话 → apply-design { path: "design/wiki/world.md" }
edit           { path: "design/characters/林晚.md", find: "…", replace: "…" }
read           { path: "chapters/chapter_ch2_v1.md" }
```

**曾经有一个 `layer` 参数**（`core | world | …`），当的是"少拼一次路径"的糖。它被删掉的理由：糖能表达的路径本来就能表达，而它多带一套词表——于是同一个"世界层在哪"在代码里有两处定义（一份只装四个短名的表，与 `design_spec.ts` 的路径表），模型也见过两种地址形式。路径口径统一之后，那份间接只剩成本。

**两条守卫**（都在 `design_tools.resolveDoc`，都回**字面路径**让模型自纠）：

- **提案只写 `design/` 下的文档**：`path: "chapters/…"` 会被拒——章节正文走 `write` / `edit`，那条路不需要"用户先看整篇再接受"。
- **主文档不许写到别处**：`design/world.md` 会被拒并指回 `design/wiki/world.md`。起因是实测模型把世界层写成前者，而常驻注入只认后者的路径——**写错位置的世界层不会被注入，等于白写且用户看不出来**。判据是注册表里那条规范的 `target`，不另抄一份文件清单。

## 文档级的守卫

- **可审阅性**：判据是"**字节摆得到用户眼前吗**"，不是"分不分格"。有规范登记的文档，没按该规范的小节组织 → 拒绝提案（否则几格全显示「待定」，整段散文却照样落盘）；**无规范登记的文档放行**——整篇散文会被兜底成"整篇一格"摆出来。
- **不在任何格里的字节也单独摆一段**（`proposal.uncoveredText`）：文档标题行、`##` 之前的导语。渲染只认 `items[].body` 的话，这些字节会被整个跳过，而它们照样落盘——"用户看过的字节 == 落盘的字节"就成了假的。
- **重名小节**：寻址按标题，两个同名 `##` 之后"读第 2 节"永远命中前一个——此后工具读不懂这份文档。`framework/invariants.ts` 的 `design.no-duplicate-heading` 拦"**新造出来**的重名"。
- **角色卡的 `##` 陷阱**：`proposal.ownItems` 取**最浅**标题层。角色卡上冒出任意一个 `##`，卡里**所有** `###` 都从逐格审阅里消失。`characters.no-shallow-heading` 拦它——**判结果**，所以 `write` / `edit` / `propose-design` 哪条路都绕不过。详见 `characters.md`。
- **删除**：`delete` 内置 `search` 引用检查（**整个项目**：正文里也会提到角色与设定名），命中结果摆进 confirm——**级联清理由模型自己用 `edit` 做**，工具只负责把影响面摆出来。

## 章节生产

```mermaid
flowchart TD
    W[用户: 根据序列 X 写第 N 章] --> W1[read 取当前序列纲 + 相关切片]
    W1 --> W2[mate 自己写这一章的节拍]
    W2 --> W3[propose-plan 摆给用户 —— halt，回合到此为止]
    W3 --> W4{用户拍板}
    W4 -- 要改 --> W2
    W4 -- 认可 --> W5[task writer 带切片 + 节拍写正文]
    W5 --> W6[writer 用 write 落 chapters/ —— 用户看 diff 后点头]
```

**一次只规划一章**，因为节拍是**序列纲的投影**：序列纲说"这一节要兑现什么"，节拍说"这一章怎么兑现"。

**门有两道，都挂在 `propose-plan` 这一环上：**

- **摆出来就停**：它带 `halt`，不靠模型自觉。
- **没拍板就不许写**：它把节拍登记进会话内存，用户回话后由 harness 置 `approved`；`task(writer)` 查这一位，没批准就拒绝，并把"先 propose-plan"给回去。**这和 `apply-design` 是同一套**——propose 登记 → harness 判同意 → 执行工具查它。门开在**执行那一头**而不是给整个会话加个模式，是为了让设计流程与正文流程**共用一种"用户拍板"的语义**。

节拍**不落盘**：它批准的是**动作**（去写正文），不是一份文档。那份登记只活在会话内存里（`Session.pending`，storage 层完全不认识它），靠 `renderPendingNote` 每轮注入 system 抵抗压缩。**一次批准只换一次写作**——`task(writer)` 成功后即清，下一章要重新摆、重新拍板。

**mate 没有阶段状态机**："设计段/写作段"不是代码里的状态，而是**用户点名驱动**——说"完善核心设定"就走企划成型，说"写第 N 章"就走章节生产。

## 写作依赖当前版本

每次 task 委派写手，prompt 里带"当前 core 切片 + 相关 world/characters 切片 + 细纲切片"——**绝不缓存旧设定**。写作/task 委派时一律现读。

## 相关源码

| 文件 | 职责 |
|---|---|
| `storage/corpus.ts` | **语料层**：枚举 / 读 / 扫词的唯一实现（项目相对口径、两个根、一条 walker）。只读，没有任何写口 |
| `framework/design_spec.ts` | **一张**规范表：按路径 glob 登记（`SPECS`），**更具体的模式胜出**。每份规范 = 该有哪些小节 + 写/别写/写成 + 成稿工作法。`specFor` / `renderSpec`（目录入口会把名下每种文档一并返回） |
| `framework/summaries.ts` | 目录摘要器注册表：**某种文档在 `list` 里占哪一行**（角色卡一人一行、不分格的给首句）。形状照抄 `invariants` |
| `framework/search.ts` | 扫词命中的**渲染**（`renderHits`：按文件分组 + 小节标注）。取数在 `corpus` |
| `framework/write_ops.ts` | **写盘唯一路径**：解析目标 → 读 → 算结果 → diff → 取批准 → CAS + 原子写。二向与三向都走它 |
| `framework/file_ops.ts` | `FileOp` → 新内容（纯函数）：整篇 / 锚点替换 / 删除**三种**。行尾适配在这一层 |
| `framework/match.ts` | 锚点匹配的回退阶梯（唯一性、跨度失控兜底） |
| `framework/invariants.ts` | **对算出来的结果做后验**（角色卡三条 + 重名小节一条）。提案时也跑同一份，所以判据不会两处说两套 |
| `framework/proposal.ts` | 提案渲染（`ownItems` / `itemsOf` / `reviewable` / `renderProposal`）＋ `proposalOp`（提案 → 写盘 op）。规范查询转发给 `design_spec.specFor` |
| `framework/markdown.ts` | 区块**读**手术（`getSection` / `removeSection` / `listHeadings`）。改一格不再走这里——见 `edit` |
| `framework/anchor.ts` | 常驻注入（`RESIDENT_DOCS` 两条路径）+ `buildIndex`（`list` 的索引） |
| `tool/read_tools.ts` | `read` / `list` / `search` 三个薄壳（**项目级**，与 design 无关） |
| `tool/design_tools.ts` | `propose-design` / `apply-design`——上面的工具壳，守卫（`resolveDoc`）都在这里 |
