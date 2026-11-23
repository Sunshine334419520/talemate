/**
 * framework-tools：框架层工具；当前仅 design-spec——查设计指南（为什么写、要回答什么、好例/反例），
 * 不是文档操作，也不规定必填小节。
 */
import { renderGuide } from "../framework/design_guides";
import { readPrompt } from "../prompts";
import { defineTool, type RegisteredTool } from "./define";

const P = (id: string) => readPrompt(`tools/${id}`);

/**
 * design-spec：返回设计指南（为什么写、一份好文档回答哪些问题、好例/反例、尺寸），不返回
 * “必须有哪些小节”。只收一个路径：给文档路径就取那一份的指南，给目录（`design/outline/`）
 * 就返回该目录名下登记的每一种。
 */
export const designSpecTool: RegisteredTool<{ path: string }> = defineTool<{
  path: string;
}>({
  id: "design-spec",
  description: P("design-spec"),
  input: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "A project-relative path under design/: a document whose kind has a guide (design/core.md, design/wiki/world.md, design/characters/林晚.md, design/outline/vol_1.md, design/outline/vol_1/s2.md), or a directory to get every guide under it (design/outline/). Documents with no guide are written free-form.",
      },
    },
    required: ["path"],
  },
  async execute(args) {
    const path = (args.path ?? "").trim();
    const rendered = path ? renderGuide(path) : undefined;
    if (rendered === undefined) {
      return {
        output: `${path || "（空路径）"} 没有登记设计指南——按自由形状成稿即可（专题页属此类）。目录型入口可带尾斜杠取整层，如 design/outline/。`,
      };
    }
    return { output: rendered, metadata: { path } };
  },
});

export const FRAMEWORK_TOOLS: RegisteredTool[] = [designSpecTool];
