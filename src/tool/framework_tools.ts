/**
 * framework-tools：框架层工具。
 * 当前仅 design-spec——**查形状**（某层该有哪些小节 + 成稿/补缺做法），不是文档操作。
 *
 * 说明：framework-status（跨层待定清单）已删除——它与入口现状卡片/常驻设定注入/read-design 职责重叠。
 * 曾把"归档归位表"作为 design-spec 的无参模式塞进来，已撤：spec 与"这段讨论记到哪"是两个职责。
 */
import type { LayerId } from "../framework/layers";
import { renderDesignSpec } from "../framework/design_spec";
import { readPrompt } from "../prompts";
import { defineTool, type RegisteredTool } from "./define";

const P = (id: string) => readPrompt(`tools/${id}`);

/** design-spec：按层返回结构规范（该层该有哪些小节 + 成稿/补缺做法）——懒建时模型靠它成稿。 */
export const designSpecTool: RegisteredTool<{ layer: string }> = defineTool<{ layer: string }>({
  id: "design-spec",
  description: P("design-spec"),
  input: {
    type: "object",
    properties: {
      layer: { type: "string", description: "core | world | characters | outline" },
    },
    required: ["layer"],
  },
  async execute(args) {
    const layer = (args.layer ?? "").trim().toLowerCase() as LayerId;
    if (!["core", "world", "characters", "outline"].includes(layer)) {
      return { output: `design-spec 的 layer 应为：core / world / characters / outline（收到：${args.layer}）。` };
    }
    return { output: renderDesignSpec(layer), metadata: { layer } };
  },
});

export const FRAMEWORK_TOOLS: RegisteredTool[] = [designSpecTool];
