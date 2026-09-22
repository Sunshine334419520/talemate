/**
 * design-tools：design/ 通用文档操作（read / list / search / propose / apply / append / remove）。
 * 一工具一职责；description 在 prompts/tools/<id>.txt。
 *
 * 写侧分两段：propose-design（不写盘，渲染提案并 halt 本回合）→ 用户回话 → apply-design（写提案那一份）。
 * 写侧都是**薄壳**：校验、confirm(完整内容)、变换、落盘全在 framework/design_ops.ts 那一份实现里
 * （apply-design 也委派它）。读侧不走 design_ops。
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
import { applyDesignOp, designNotFound } from "../framework/design_ops";
import { DESIGN_SPECS } from "../framework/design_spec";
import type { LayerId } from "../framework/layers";
import { getSection, listHeadings } from "../framework/markdown";
import { isBlankBody, renderProposal, reviewable } from "../framework/proposal";
import { readPrompt } from "../prompts";
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
 * 角色卡的结构守卫：卡上的小节一律 `###`（`# 角色：X` 是 H1）。
 * 出现 `##` 会让 proposal.ownItems 取到更浅的层，于是卡里**所有** `###` 都从逐格审阅里消失——
 * 用户没看过的字节照样落盘。这是静默的，必须在写入口拦住。
 */
function cardHeadingError(name: string, text: string): string | undefined {
  if (!nameFromPath(name)) return undefined;
  const shallow = rejectShallowHeading(text);
  return shallow
    ? `角色卡的小节一律用 \`###\`（收到 \`## ${shallow}\`）——更浅的标题会让卡里所有 \`###\` 从逐格审阅里消失，用户看不到却被落盘。`
    : undefined;
}

/**
 * 角色卡的**整篇**提案必须带齐必有五格（`characters.CHARACTER_FIELDS`），缺则拒绝并列出缺哪几格。
 * 单格提案（带 section）不适用——它的 content 是小节正文，本来就没有标题。
 *
 * 为什么拦：`add-character` 删掉之后（2026-09-19），再没有任何构造器会替模型把空格子建出来，
 * 骨架保证只剩这一道。它只看**标题在不在**；内容空不空由名单行的「待补」判（pendingRequiredLabels）
 * ——写个空标题能过这里，但会在 `list-designs` 里显示为待补。
 */
function cardSkeletonError(name: string, content: string, section?: string): string | undefined {
  if (section || !nameFromPath(name)) return undefined;
  const missing = missingSkeletonSections(content);
  if (!missing.length) return undefined;
  return (
    `角色卡缺这几格：${missing.join("、")}——整篇提案必须带齐必有五格，没定的写（待定）。` +
    "补齐后重新 propose-design。"
  );
}

/**
 * 整篇提案打到**已存在**的角色卡上时给用户的告警（不阻断，只摆在提案前面）。
 *
 * 这是 `add-character` 那条查重逻辑的替代品：从前重复建卡会被工具直接拒绝，现在"创建"与
 * "重写"是同一条通道，只能靠把后果摆出来区分。提案渲染只列**新**内容——不显式说一句，
 * 用户看不出来旧卡上哪些小节会被抹掉。
 */
function cardRewriteWarn(current: string | undefined, section?: string): string | undefined {
  if (section || current === undefined) return undefined;
  const heads = listHeadings(current, 3).map((h) => h.title);
  return (
    `⚠️ 这张角色卡已存在（${heads.length} 个小节：${heads.join("、")}）——本提案会**整篇重写**它，` +
    "上面没出现的旧小节都会消失。只想改一格的话请带 section 重新提案。"
  );
}

/** 角色卡上不许删**必有格**——删掉会造出半身卡，绕过 cardSkeletonError 守的不变量。自由长尾随便删。 */
function cardRequiredSectionError(name: string, section: string): string | undefined {
  if (!nameFromPath(name)) return undefined;
  const hit = CHARACTER_FIELDS.find((f) => f.label === section.trim());
  return hit
    ? `「${hit.label}」是角色卡的必有格，不能删——删了会造出半身卡。要清空这一格，请用 propose-design 带 section 把正文改成（待定）。`
    : undefined;
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
 * propose-design：把一版结论交给用户审阅——不写盘，并把本回合交给用户（halt）。
 * 带 section = 只改一格，不带 = 整篇成稿。
 */
export const proposeDesignTool: RegisteredTool<{ layer?: string; name?: string; content: string; section?: string }> =
  defineTool<{ layer?: string; name?: string; content: string; section?: string }>({
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
            "The text to write. It IS the file: on approval it is written byte for byte, so it may contain document text only — no notes to the user, no rationale, no questions; undecided fields become （待定）. The complete document when section is omitted; that section's new body WITHOUT the heading line when section is given",
        },
        section: {
          type: "string",
          description: "Optional: exact section heading to rewrite; omit to propose the whole document",
        },
      },
      required: ["content"],
    },
    async execute(args, ctx) {
      const target = resolveDoc(args);
      if ("error" in target) return { output: target.error };
      const name = target.name;
      const content = (args.content ?? "").trim();
      const section = args.section?.trim() || undefined;
      if (!content) {
        return {
          output: `propose-design 缺少 content（收到：${JSON.stringify(args).slice(0, 200)}）——请带完整字段重新调用。`,
        };
      }
      const headingErr = cardHeadingError(name, content);
      if (headingErr) return { output: headingErr };
      const skeletonErr = cardSkeletonError(name, content, section);
      if (skeletonErr) return { output: skeletonErr };

      const current = await ctx.readDesign(name);
      let oldBody: string | undefined;
      if (section) {
        // 单格提案：文档与小节都必须存在（在**提案时**校验——否则用户批准了却写不进去）
        if (current === undefined) return { output: await designNotFound(ctx, name) };
        const s = getSection(current, section);
        if (!s.found) {
          return { output: `文档 ${name} 里没有小节「${section}」。可用小节：\n${(s.available ?? []).join("\n")}` };
        }
        if (/^#{1,6}\s/.test(content)) {
          return { output: `section 的 content 不要带标题行（「${section}」这个标题由工具自己写）——请只给这一格的正文。` };
        }
        if (isBlankBody(content)) {
          return { output: `「${section}」这一格的正文是空的——要清掉它请用 remove-design-section。` };
        }
        oldBody = s.body ?? "";
      } else if (!reviewable(name, content)) {
        return {
          output:
            "这版草稿没法逐格审阅（正文里没有小节标题，或没按该层规范的小节组织），摆给用户会是一页空白却照样落盘。" +
            "请每格一个 `## 标题`（先调 design-spec 拿这一层的形状）。",
        };
      }

      const prev = ctx.getProposal(name);
      ctx.setProposal({ name, content, section, base: current, approved: false, at: Date.now() });
      const rendered = renderProposal({
        name,
        content,
        section,
        oldBody,
        previous: prev?.content,
      });
      const warn = cardRewriteWarn(current, section);
      ctx.showProposal(warn ? `${warn}\n\n${rendered}` : rendered);

      return {
        output:
          "提案已交给用户审阅（尚未写入任何文件）。本回合已结束，等用户回话：用户认可 → apply-design；" +
          "用户要改 → 用新内容再 propose-design（改了内容必须重新提案）。" +
          (warn ? `\n\n${warn}` : ""),
        metadata: { name, section },
      };
    },
  });

/**
 * apply-design：把待落盘提案写进文件。**不收正文**——内容只从提案来。
 * 两道闸：没有提案 / 用户没同意（同意由 harness 按用户回话判定，不由模型自述）→ 拒绝。
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
    const p = ctx.getProposal(name);
    if (!p) {
      return {
        output: `没有 ${name} 的待落盘提案——先用 propose-design 把这一版交给用户过目，等用户回话再来。`,
      };
    }
    if (!p.approved) {
      return {
        output:
          `用户还没同意这一版提案，不能落盘。请按用户这几轮说的话重新 propose-design；` +
          "落盘的永远只能是用户看过并认可的那一版。",
      };
    }
    const current = await ctx.readDesign(name);
    if ((current ?? null) !== (p.base ?? null)) {
      return {
        output: `${name} 在提案之后被改动过（或新建/删除了），现在落盘会盖掉那些改动——请重新 propose-design 出一版新的。`,
      };
    }

    const r = await applyDesignOp(
      ctx,
      p.section
        ? { kind: "edit", name, section: p.section, content: p.content, confirm: false }
        : { kind: "write", name, content: p.content, confirm: false },
    );
    if (!r.ok) return { output: r.output };
    ctx.clearProposal(name);
    if (p.section) {
      return { output: `已按提案改写 ${r.file} › ${p.section}`, metadata: { name, section: p.section } };
    }
    const diff = r.isNew ? "(新建)" : `(旧 ${r.oldLen} 字 → 新 ${r.newLen} 字)`;
    return { output: `已按提案写入 ${r.file} ${diff}`, metadata: { name } };
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
    const headingErr = cardHeadingError(args.name, args.block);
    if (headingErr) return { output: headingErr };
    const r = await applyDesignOp(ctx, { kind: "append", name: args.name, block: args.block });
    if (!r.ok) return { output: r.output };
    return { output: `已追加到 ${r.file}`, metadata: { name: args.name } };
  },
});

/** remove-design-section：删一个小节（删前引用检查进 confirm） */
export const removeDesignSectionTool: RegisteredTool<{ name: string; section: string; term?: string }> = defineTool<{
  name: string;
  section: string;
  term?: string;
}>({
  id: "remove-design-section",
  description: P("remove-design-section"),
  permission: "edit",
  input: {
    type: "object",
    properties: {
      name: { type: "string", description: "Document filename under design/ (incl. .md)" },
      section: { type: "string", description: "Section heading to delete" },
      term: { type: "string", description: "Optional: entity term for the reference check; defaults to the section heading" },
    },
    required: ["name", "section"],
  },
  async execute(args, ctx) {
    const requiredErr = cardRequiredSectionError(args.name, args.section);
    if (requiredErr) return { output: requiredErr };
    const r = await applyDesignOp(ctx, {
      kind: "cut",
      name: args.name,
      section: args.section,
      term: args.term,
    });
    if (!r.ok) return { output: r.output };
    return { output: `已删除 ${r.file} › ${args.section}`, metadata: { name: args.name, section: args.section } };
  },
});

export const DESIGN_TOOLS: RegisteredTool[] = [
  readDesignTool,
  listDesignsTool,
  searchDesignsTool,
  proposeDesignTool,
  applyDesignTool,
  appendDesignTool,
  removeDesignSectionTool,
];
