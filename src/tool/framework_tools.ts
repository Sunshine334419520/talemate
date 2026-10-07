/**
 * framework-tools：框架层工具；当前仅 design-spec——查形状（某份文档该有哪些小节、每格装什么、
 * 成稿做法），不是文档操作。
 */
import { renderSpec } from "../framework/design_spec";
import { readPrompt } from "../prompts";
import { defineTool, type RegisteredTool } from "./define";

const P = (id: string) => readPrompt(`tools/${id}`);

/**
 * design-spec：返回结构规范（该有哪些小节 + 成稿/补缺做法），懒建时模型靠它成稿。
 * 只收一个路径：给文档路径就取那一份的规范（规范描述的是还不存在的文档，给"将来那个路径"即可），
 * 给目录（`design/outline/`）就返回该目录名下登记的每一种。曾有过第二个入口 `layer`，那是"少拼
 * 一次路径"的糖——糖能表达的路径本来就能表达，而它多带一套词表、还和注册表各说各话，所以否决。
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
          "A project-relative path under design/: a document whose kind has a spec (design/core.md, design/wiki/world.md, design/characters/林晚.md, design/outline/vol_1.md, design/outline/vol_1/s2.md), or a directory to get every kind under it (design/outline/). Documents with no spec are written free-form.",
      },
    },
    required: ["path"],
  },
  async execute(args) {
    const path = (args.path ?? "").trim();
    const rendered = path ? renderSpec(path) : undefined;
    if (rendered === undefined) {
      return {
        output: `${path || "（空路径）"} 没有登记结构规范——按自由形状成稿即可（专题页属此类）。目录型入口可带尾斜杠取整层，如 design/outline/。`,
      };
    }
    return { output: rendered, metadata: { path } };
  },
});

export const FRAMEWORK_TOOLS: RegisteredTool[] = [designSpecTool];
