/**
 * design-tools：design/ 的三向提案（propose / apply），两段式、两者都要先在草稿模式里；三个读口
 * 在 `read_tools.ts`，已是项目级、与 design/ 无关。全是薄壳：校验、不变量后验、diff、权限、CAS、
 * 原子写都在 `framework/write_ops.ts` 那条唯一路径。`AgentDef.tools` 白名单不是执行边界——撤工具
 * 必须真删定义，只从白名单拿掉等于没拿掉。
 */
import { DRAFT_MODE } from "../agent/modes";
import { checkInvariants } from "../framework/invariants";
import { SPECS } from "../framework/design_spec";
import { listHeadings } from "../framework/markdown";
import { renderProposal, reviewable } from "../framework/proposal";
import { writeFile } from "../framework/write_ops";
import { readPrompt } from "../prompts";
import { notInDraft } from "./core_tools";
import { defineTool, type RegisteredTool } from "./define";

const P = (id: string) => readPrompt(`tools/${id}`);

/**
 * 提案只写 `design/` 下的文档（章节正文走 `write`）；"某一层主文档不许写到别处"按 `SPECS` 的
 * `target` 判，不另抄一份文件清单。
 */
function resolveDoc(path: unknown): { path: string } | { error: string } {
  const clean = (typeof path === "string" ? path : "").replace(/\\/g, "/").trim();
  if (!clean) {
    // JSON.stringify(undefined) 回的是 undefined（不是字符串），.slice 会炸——所以先兜一层
    const got = JSON.stringify(path ?? null) ?? "undefined";
    return {
      error: `propose-design/apply-design 缺少 path（收到：${got.slice(0, 200)}）——给 design/ 下的相对路径，如 design/core.md。`,
    };
  }
  if (!clean.startsWith("design/")) {
    return {
      error: `提案只写 design/ 下的文档（收到：${clean}）——章节正文与状态走 write/edit。`,
    };
  }
  const base = clean.split("/").pop() ?? clean;
  const clash = SPECS.find((s) => s.target !== undefined && s.target !== clean && s.target.split("/").pop() === base);
  if (clash?.target) {
    return {
      error: `${clash.title}的主文档是 ${clash.target}，不是 ${clean}——写它请用 path:"${clash.target}"；或者换个文件名。`,
    };
  }
  return { path: clean };
}

/**
 * 整篇提案打到已存在的角色卡上时给用户的告警（不阻断，只放在提案前面）。
 * 创建与重写走同一条通道，且提案渲染只列新内容——不显式说一句，用户看不出旧卡上哪些小节会被抹掉。
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
 * propose-design：把一版整篇结论交给用户审阅——不写盘，并把本回合交给用户（halt）。
 * 提案只有整篇一种形态：局部修改走二向的 `edit`（看 diff 就够），哪怕只动一格也整篇提出来，
 * 渲染里的 `★本版改动` 会指出动过哪几格。
 */
export const proposeDesignTool: RegisteredTool<{ path: string; content: string }> = defineTool<{
  path: string;
  content: string;
}>({
  id: "propose-design",
  description: P("propose-design"),
  halt: true,
  input: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Project-relative path of the document, incl. its root and .md — design/core.md, design/wiki/world.md, design/wiki/<topic>.md, design/outline/vol_<N>.md, design/outline/vol_<N>/s<M>.md, design/characters/<name>.md (a character card is created and rewritten this way; there is no character-specific tool)",
      },
      content: {
        type: "string",
        description:
          "The complete document. It IS the file: on approval it is written byte for byte, so it may contain document text only — no notes to the user, no rationale, no questions; undecided fields become （待定）",
      },
    },
    required: ["path", "content"],
  },
  async execute(args, ctx) {
    // 本工具带 halt，runner 对任何 return 都置 halt（见 `tool/runner.ts`）——所以自愈路径必须 throw，
    // 否则回合会停在一个本可自愈的错误上，用户看到的是回合莫名结束（提案没交出去，CLI 的提案块也不出现）；
    // `tests/framework.test.ts` 的 "tool runner · halt" 钉着这条
    const target = resolveDoc(args.path);
    if ("error" in target) throw new Error(target.error);
    const path = target.path;
    // 三向只有草稿模式那一条通道；不在里面交出去也只是个二向的弹窗，不如让模型先把模式切过去
    if (ctx.getMode() !== DRAFT_MODE) throw new Error(notInDraft("把这一版整篇草稿提出来"));
    const content = (args.content ?? "").trim();
    if (!content) {
      throw new Error(
        `propose-design 缺少 content（收到：${JSON.stringify(args).slice(0, 200)}）——请带完整字段重新调用。`,
      );
    }
    const current = await ctx.readDoc(path);

    // 不变量在这里先跑一遍（落盘时还会再判一次）：提案必须先把注定落不下去的草稿挡住，否则用户批完
    // 要到 apply-design 才知道不行。同一份注册表两处共用，判据不会各说各话；路径原样传，三处同一口径
    const violation = checkInvariants({ path, opKind: "write", before: current, after: content });
    if (violation) throw new Error(violation);
    if (!reviewable(path, content)) {
      throw new Error(
        "这版草稿没法逐格审阅（正文里没有小节标题，或没按该层规范的小节组织），用户看到的会是一页空白却照样落盘。" +
          "请每格一个 `## 标题`（先调 design-spec 拿这一层的形状）。",
      );
    }

    const prev = ctx.getProposal(path);
    ctx.setProposal({ name: path, content, base: current, approved: false, at: Date.now() });
    const rendered = renderProposal({ name: path, content, previous: prev?.content });
    const warn = cardRewriteWarn(current);
    ctx.showProposal(warn ? `${warn}\n\n${rendered}` : rendered);

    return {
      output:
        "提案已交给用户审阅（尚未写入任何文件）。本回合已结束，等用户回话：用户认可 → apply-design；" +
        "用户要改 → 用新内容再 propose-design（改了内容必须重新提案）。" +
        (warn ? `\n\n${warn}` : ""),
      metadata: { path },
    };
  },
});

/**
 * apply-design：把待落盘提案写进文件，不收正文——内容只从提案登记里取。
 * 四道闸（没有提案 / 用户没同意 / 提案后文件被改过 CAS / 规则表不许）全在 `write_ops` 上，这里
 * 一句校验都不写；同意由 harness 按用户回话判定而不是模型自述，"模型夹带没看过的字节"是写不出来，
 * 因为 `via:"pending"` 压根不接受正文。
 */
export const applyDesignTool: RegisteredTool<{ path: string }> = defineTool<{
  path: string;
}>({
  id: "apply-design",
  description: P("apply-design"),
  permission: "edit",
  input: {
    type: "object",
    properties: {
      path: { type: "string", description: "The same project-relative path you proposed it with" },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const target = resolveDoc(args.path);
    if ("error" in target) return { output: target.error };
    const path = target.path;
    const r = await writeFile(ctx, {
      via: "pending",
      proposalKey: path,
      action: `落盘 ${path}`,
    });
    if (!r.ok) return { output: r.output };
    ctx.clearProposal(path);
    const diff = r.isNew ? "(新建)" : `(+${r.additions} / -${r.deletions} 行)`;
    return { output: `已按提案写入 ${path} ${diff}`, metadata: { path } };
  },
});

export const DESIGN_TOOLS: RegisteredTool[] = [proposeDesignTool, applyDesignTool];
