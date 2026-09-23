/**
 * design-tools：design/ 通用文档操作（read / list / search / propose / apply / append / remove）。
 * 一工具一职责；description 在 prompts/tools/<id>.txt。
 *
 * 写侧是**两段式**：propose-design（不写盘，渲染提案并 halt 本回合）→ 用户回话 → apply-design
 * （落提案那一份）。**两者都要先在草稿模式里**——三向只有那一条通道。
 *
 * 写侧全是**薄壳**：拼出 `FileOp` 交给 `framework/write_ops.ts` 那条唯一路径，校验、不变量后验、
 * diff、权限、CAS、原子写都在那一处。领域语义（按标题寻址、引用检查、骨架守卫）留在本文件。
 *
 * 注意：`AgentDef.tools` 白名单只决定模型看到哪些 schema，**不是执行边界**（session 传的是全局 registry）。
 * 撤一个工具必须真删定义，只从白名单拿掉等于没拿掉。
 */
import {
  CHARACTER_FIELDS,
  missingSkeletonSections,
  nameFromPath,
  rejectShallowHeading,
} from "../framework/characters";
import { DRAFT_MODE } from "../agent/modes";
import type { ToolContext } from "../core/types";
import { DESIGN_SPECS } from "../framework/design_spec";
import { checkInvariants } from "../framework/invariants";
import type { LayerId } from "../framework/layers";
import { findHeading, getSection, listHeadings } from "../framework/markdown";
import { renderProposal, reviewable } from "../framework/proposal";
import { writeFile } from "../framework/write_ops";
import { readPrompt } from "../prompts";
import { notInDraft } from "./core_tools";
import { defineTool, type RegisteredTool } from "./define";

const P = (id: string) => readPrompt(`tools/${id}`);

/**
 * 主文档是**一个文件**的层。`characters` 与 `outline` 不在内——它们的 `file` 是目录（`characters/`、
 * `outline/`），会取到目录名本身。角色卡走 `name:"characters/<名>.md"`，卷纲/序列纲各走 `name`。
 */
const MAIN_LAYERS = ["core", "world"] as const;

/**
 * 定这次要写哪个文件：固定层用 `layer`（路径由代码定），自由命名的文档用 `name`。
 *
 * 固定层的主文档路径不能由模型拼：常驻表只认 `wiki/world.md`，写到 `design/world.md`
 * 的世界层不会被常驻注入、且用户看不出来。
 * `name` 分支同样要拦——模型可以绕开 layer 直接给 `name:"world.md"`。
 */
function resolveDoc(args: { layer?: unknown; name?: unknown }): { name: string } | { error: string } {
  const layer = typeof args.layer === "string" ? args.layer.trim().toLowerCase() : "";
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (layer && name) {
    return { error: "layer 与 name 只能给一个：核心层/世界观用 layer（路径由工具定），其余文档一律用 name。" };
  }
  if (layer) {
    if (!(MAIN_LAYERS as readonly string[]).includes(layer)) {
      return {
        error:
          `layer 只收 core / world（收到：${layer}）——这两个层的主文档是一个固定文件。` +
          `大纲是一卷一个文件，没有"整本"可写，用 name:"outline/vol_<N>.md"（序列纲再下移一层）；` +
          `角色是一角色一卡，用 name:"characters/<名>.md"。`,
      };
    }
    return { name: DESIGN_SPECS[layer as LayerId].file };
  }
  if (!name) {
    return { error: "propose-design/apply-design 缺少 layer 或 name——核心层/世界观给 layer，其余文档给 name。" };
  }
  // 守卫：某一层的主文档不许写到别处
  const base = name.split("/").pop() ?? name;
  const clash = Object.values(DESIGN_SPECS).find((s) => s.file !== name && s.file.split("/").pop() === base);
  if (clash) {
    return {
      error: `${clash.title}的主文档是 design/${clash.file}，不是 ${name}——这一层请用 layer:"${clash.layer}"（路径由工具定）；或者换个文件名。`,
    };
  }
  return { name };
}

/**
 * 整篇提案打到**已存在**的角色卡上时给用户的告警（不阻断，只摆在提案前面）。
 *
 * 这是 `add-character` 那条查重逻辑的替代品：从前重复建卡会被工具直接拒绝，现在"创建"与
 * "重写"是同一条通道，只能靠把后果摆出来区分。提案渲染只列**新**内容——不显式说一句，
 * 用户看不出来旧卡上哪些小节会被抹掉。
 */
function cardRewriteWarn(current: string | undefined): string | undefined {
  if (current === undefined) return undefined;
  const heads = listHeadings(current, 3).map((h) => h.title);
  return (
    `⚠️ 这张角色卡已存在（${heads.length} 个小节：${heads.join("、")}）——本提案会**整篇重写**它，` +
    "上面没出现的旧小节都会消失。只想改一格的话，用 `edit` 改那一格（不必整篇提案）。"
  );
}

/**
 * 文档不存在时的文案。它是给模型的**路由线索**——"可用：…"让模型知道该写哪一份，
 * 所以带上清单，而不是只说一句"找不到"。
 */
async function designNotFound(ctx: ToolContext, name: string): Promise<string> {
  return `没有找到文档 ${name}。可用：\n${await ctx.listDesigns()}`;
}

/** 要追加的块里，有哪个一级小节标题是文档里已经有的（有则返回那个标题）。 */
function duplicateHeading(block: string, current: string): string | undefined {
  const heads = listHeadings(block, 2);
  if (!heads.length) return undefined;
  const existing = new Set(listHeadings(current, 2).map((h) => h.title));
  return heads.find((h) => existing.has(h.title))?.title;
}

/** read-design：读整篇或按小节读 */
export const readDesignTool: RegisteredTool<{ name: string; section?: string }> = defineTool<{
  name: string;
  section?: string;
}>({
  id: "read-design",
  description: P("read-design"),
  input: {
    type: "object",
    properties: {
      name: { type: "string", description: "Document filename under design/ (incl. .md)" },
      section: { type: "string", description: "Optional: exact section heading to read only that section" },
    },
    required: ["name"],
  },
  async execute(args, ctx) {
    const content = await ctx.readDesign(args.name);
    if (content === undefined) return { output: await designNotFound(ctx, args.name) };
    if (args.section) {
      const s = getSection(content, args.section);
      if (!s.found) {
        return {
          output: `文档 ${args.name} 里没有小节「${args.section}」。可用小节：\n${(s.available ?? []).join("\n")}`,
        };
      }
      return { output: `# ${args.name} › ${args.section}\n${s.block ?? ""}`, metadata: { name: args.name, section: args.section } };
    }
    return { output: `# ${args.name}\n${content}`, metadata: { name: args.name } };
  },
});

/** list-designs：列文档 + 每文档小节标题 */
export const listDesignsTool: RegisteredTool<Record<string, never>> = defineTool<Record<string, never>>({
  id: "list-designs",
  description: P("list-designs"),
  input: { type: "object", properties: {} },
  async execute(_args, ctx) {
    return { output: await ctx.listDesigns() };
  },
});

/** search-designs：跨文档查引用 */
export const searchDesignsTool: RegisteredTool<{ query: string }> = defineTool<{ query: string }>({
  id: "search-designs",
  description: P("search-designs"),
  input: {
    type: "object",
    properties: { query: { type: "string", description: "Term to search (character / setting / term)" } },
    required: ["query"],
  },
  async execute(args, ctx) {
    return { output: await ctx.searchDesigns(args.query) };
  },
});

/**
 * propose-design：把一版**整篇**结论交给用户审阅——不写盘，并把本回合交给用户（halt）。
 *
 * **提案只有整篇一种形态。** 局部修改走二向的 `edit`（用户看 diff 就够，不必读一遍全文）；
 * 想让用户细看的那一版，哪怕只动了一格，也整篇摆出来——渲染里的 `★本版改动` 会指出动过哪几格。
 * 这一刀把"提案"和"改一格"彻底分开，两边的审查材料也就不再互相将就。
 */
export const proposeDesignTool: RegisteredTool<{ layer?: string; name?: string; content: string }> = defineTool<{
  layer?: string;
  name?: string;
  content: string;
}>({
  id: "propose-design",
  description: P("propose-design"),
  halt: true, // 结论摆出来了，接下来该用户说话——本回合到此为止（不靠模型自觉）
  input: {
    type: "object",
    properties: {
      layer: {
        type: "string",
        description:
          "Which fixed-file layer to write: core | world. The path is fixed by the tool — prefer this over name for those two.",
      },
      name: {
        type: "string",
        description:
          "Document path under design/ for every other document: outline/vol_<N>.md (volume outline), outline/vol_<N>/s<M>.md (sequence outline), wiki/<topic>.md, outline/plan_ch<N>.md, characters/<name>.md (a character card is created and edited this way; there is no character-specific tool)",
      },
      content: {
        type: "string",
        description:
          "The complete document. It IS the file: on approval it is written byte for byte, so it may contain document text only — no notes to the user, no rationale, no questions; undecided fields become （待定）",
      },
    },
    required: ["content"],
  },
  async execute(args, ctx) {
    const target = resolveDoc(args);
    if ("error" in target) return { output: target.error };
    const name = target.name;
    // 三向只有草稿模式那一条通道（见 agent/modes.ts）。不在里面就没有"提意见"这一路，
    // 摆出来也只是个二向的弹窗——不如让模型先把模式切过去。
    if (ctx.getMode() !== DRAFT_MODE) return { output: notInDraft("把这一版整篇草稿摆出来") };
    const content = (args.content ?? "").trim();
    if (!content) {
      return {
        output: `propose-design 缺少 content（收到：${JSON.stringify(args).slice(0, 200)}）——请带完整字段重新调用。`,
      };
    }
    const current = await ctx.readDesign(name);

    // 不变量**在这里先跑一遍**：它们判的是"结果长什么样"（见 framework/invariants.ts），落盘时还会
    // 再判一次；但提案必须先挡住——否则用户批了一版注定落不下去的草稿，要到 apply-design 才知道不行。
    // 同一份注册表两处共用，所以提案时的判据与落盘时的判据不会各说各话。
    const violation = checkInvariants({ path: `design/${name}`, opKind: "write", before: current, after: content });
    if (violation) return { output: violation };
    if (!reviewable(name, content)) {
      return {
        output:
          "这版草稿没法逐格审阅（正文里没有小节标题，或没按该层规范的小节组织），摆给用户会是一页空白却照样落盘。" +
          "请每格一个 `## 标题`（先调 design-spec 拿这一层的形状）。",
      };
    }

    const prev = ctx.getProposal(name);
    ctx.setProposal({ name, content, base: current, approved: false, at: Date.now() });
    const rendered = renderProposal({ name, content, previous: prev?.content });
    const warn = cardRewriteWarn(current);
    ctx.showProposal(warn ? `${warn}\n\n${rendered}` : rendered);

    return {
      output:
        "提案已交给用户审阅（尚未写入任何文件）。本回合已结束，等用户回话：用户认可 → apply-design；" +
        "用户要改 → 用新内容再 propose-design（改了内容必须重新提案）。" +
        (warn ? `\n\n${warn}` : ""),
      metadata: { name },
    };
  },
});

/**
 * apply-design：把待落盘提案写进文件。**不收正文**——内容只从提案登记里取。
 *
 * 四道闸全在 `write_ops` 那条唯一路径上，这里一句校验都不写：
 * 没有提案 / 用户没同意（同意由 harness 按用户回话判定，不由模型自述）/ 文档在提案后被改过（CAS）/
 * 规则表不许。「模型夹带用户没看过的字节」是**写不出来**，不是被检查拦住——`via:"pending"`
 * 那条路压根不接受正文。
 */
export const applyDesignTool: RegisteredTool<{ layer?: string; name?: string }> = defineTool<{
  layer?: string;
  name?: string;
}>({
  id: "apply-design",
  description: P("apply-design"),
  permission: "edit",
  input: {
    type: "object",
    properties: {
      layer: { type: "string", description: "Same key you proposed it with: core | world" },
      name: {
        type: "string",
        description: "Same document path you proposed it with, for every document that is not core or world",
      },
    },
  },
  async execute(args, ctx) {
    const target = resolveDoc(args);
    if ("error" in target) return { output: target.error };
    const name = target.name;
    const r = await writeFile(ctx, {
      via: "pending",
      proposalKey: name,
      action: `落盘 design/${name}`,
    });
    if (!r.ok) return { output: r.output };
    ctx.clearProposal(name);
    const diff = r.isNew ? "(新建)" : `(+${r.additions} / -${r.deletions} 行)`;
    return { output: `已按提案写入 design/${name} ${diff}`, metadata: { name } };
  },
});

/** append-design：末尾追加一块（新设定小节等） */
export const appendDesignTool: RegisteredTool<{ name: string; block: string }> = defineTool<{ name: string; block: string }>({
  id: "append-design",
  description: P("append-design"),
  permission: "edit",
  input: {
    type: "object",
    properties: {
      name: { type: "string", description: "Document filename under design/ (incl. .md)" },
      block: { type: "string", description: "Markdown block to append (with its own ## / ### headings)" },
    },
    required: ["name", "block"],
  },
  async execute(args, ctx) {
    const current = await ctx.readDesign(args.name);
    if (current === undefined) return { output: await designNotFound(ctx, args.name) };

    // **重名守卫留在这里、不做成不变量**：它需要"这次要追加的那一块"这个信息，而结果是
    // before/after 两份全文，反推"新增了哪个重名标题"要绕一圈，还容易误伤原本就重名的老文档。
    // 而且它是**前置**——在算之前就知道不行，比让管线算完再拒更早、文案也更准。
    // 卡上 `##` 那类守卫不在这里：那几条判的是结果，归 invariants。
    const dup = duplicateHeading(args.block, current);
    if (dup) {
      return { output: `「${dup}」已存在于 ${args.name}——想改它请用 edit 改那一节，别再追加一份。` };
    }

    const r = await writeFile(ctx, {
      via: "confirm",
      op: { kind: "append", path: `design/${args.name}`, block: args.block },
      action: `追加到 design/${args.name}`,
    });
    if (!r.ok) return { output: r.output };
    return { output: `已追加到 design/${args.name}（+${r.additions} 行）`, metadata: { name: args.name } };
  },
});

export const DESIGN_TOOLS: RegisteredTool[] = [
  readDesignTool,
  listDesignsTool,
  searchDesignsTool,
  proposeDesignTool,
  applyDesignTool,
  appendDesignTool,
];
