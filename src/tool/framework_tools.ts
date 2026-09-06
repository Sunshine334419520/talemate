/**
 * framework-tools：框架层工具。
 * 当前仅 doc-spec——按需返回某层"结构规范 + 成稿做法"（懒建时模型靠它成稿）。
 *
 * 说明：framework-status（跨层待定清单）已删除——它与入口现状卡片/常驻设定注入/read-doc 职责重叠、
 * 会让模型在"看状态"时误调多个工具。"整体到哪了"看现状卡片 + list-chapters/list-docs；"某层内容"用 read-doc。
 */
import type { DocId } from "../framework/dockind";
import { renderDocSpec } from "../framework/doc_spec";
import { readPrompt } from "../prompts";
import { defineTool, type RegisteredTool } from "./define";

const P = (id: string) => readPrompt(`tools/${id}`);

/** doc-spec：按需返回某层的结构规范（该有哪些小节 + 成稿/补缺做法）——懒建时模型靠它成稿。 */
export const docSpecTool: RegisteredTool<{ layer: string }> = defineTool<{ layer: string }>({
  id: "doc-spec",
  description: P("doc-spec"),
  input: {
    type: "object",
    properties: {
      layer: { type: "string", description: "core | world | characters | outline" },
    },
    required: ["layer"],
  },
  async execute(args, ctx) {
    const layer = (args.layer ?? "").trim().toLowerCase() as DocId;
    if (!["core", "world", "characters", "outline"].includes(layer)) {
      return { output: `doc-spec 的 layer 应为：core / world / characters / outline（收到：${args.layer}）。` };
    }
    return { output: renderDocSpec(layer), metadata: { layer } };
  },
});

export const FRAMEWORK_TOOLS: RegisteredTool[] = [docSpecTool];
