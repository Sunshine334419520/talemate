/**
 * framework-tools：框架层工具。
 * 当前仅 design-spec——**查形状**（某份文档该有哪些小节、每格装什么、成稿做法），不是文档操作。
 */
import { renderSpec } from "../framework/design_spec";
import { readPrompt } from "../prompts";
import { defineTool, type RegisteredTool } from "./define";

const P = (id: string) => readPrompt(`tools/${id}`);

/**
 * design-spec：返回结构规范（该有哪些小节 + 成稿/补缺做法）——懒建时模型靠它成稿。
 *
 * **只收一个路径**：给一份文档的路径就取那一份的规范（规范描述的是**还不存在的**文档，所以给
 * "将来那个路径"就行）；给一个目录（`design/outline/`）就把该目录名下登记的每一种文档一并返回。
 * 从前还有第二个入口 `layer`（`core | world | …`），那是"少拼一次路径"的糖——路径口径统一之后
 * 它没有存在的理由：糖能表达的路径本来就能表达，而它多带一套词表、还和注册表各说各话。
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
          "A project-relative path under design/: a document whose kind has a spec (design/core.md, design/wiki/world.md, design/characters/林晚.md, design/outline/vol_1.md, design/outline/vol_1/s2.md), or a directory to get every kind under it (design/outline/). Documents with no spec (topic pages, chapter plans) are written free-form.",
      },
    },
    required: ["path"],
  },
  async execute(args) {
    const path = (args.path ?? "").trim();
    const rendered = path ? renderSpec(path) : undefined;
    if (rendered === undefined) {
      return {
        output: `${path || "（空路径）"} 没有登记结构规范——按自由形状成稿即可（专题页、章节细纲都属此类）。目录型入口可带尾斜杠取整层，如 design/outline/。`,
      };
    }
    return { output: rendered, metadata: { path } };
  },
});

export const FRAMEWORK_TOOLS: RegisteredTool[] = [designSpecTool];
