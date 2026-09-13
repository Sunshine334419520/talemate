/**
 * framework-tools：框架层工具。
 * 当前仅 design-spec——**查形状**（某层该有哪些小节、每格装什么、成稿做法），不是文档操作。
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
