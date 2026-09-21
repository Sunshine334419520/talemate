/**
 * framework-tools：框架层工具。
 * 当前仅 design-spec——**查形状**（某层/某份文档该有哪些小节、每格装什么、成稿做法），不是文档操作。
 */
import { LAYERS, type LayerId } from "../framework/layers";
import { renderDesignSpec, renderNamedSpec } from "../framework/design_spec";
import { readPrompt } from "../prompts";
import { defineTool, type RegisteredTool } from "./define";

const P = (id: string) => readPrompt(`tools/${id}`);

/** 层 id 从 LAYERS 现取，不在这里另抄一份——抄了就会和它可以脱节。 */
const LAYER_IDS: readonly string[] = LAYERS.map((l) => l.id);

/**
 * design-spec：返回结构规范（该有哪些小节 + 成稿/补缺做法）——懒建时模型靠它成稿。
 * 两个入口：`layer` 取整层（情节层会返回它名下的卷纲 + 序列纲两种），`name` 取某一份文档。
 */
export const designSpecTool: RegisteredTool<{ layer?: string; name?: string }> = defineTool<{
  layer?: string;
  name?: string;
}>({
  id: "design-spec",
  description: P("design-spec"),
  input: {
    type: "object",
    properties: {
      layer: {
        type: "string",
        description: `One layer by id: ${LAYER_IDS.join(" | ")}. Use this when the layer's main document is a single file.`,
      },
      name: {
        type: "string",
        description:
          "A document path under design/ whose kind has its own spec — outline/vol_<N>.md or outline/vol_<N>/s<M>.md. Give this or layer, not both.",
      },
    },
    required: [],
  },
  async execute(args) {
    const name = (args.name ?? "").trim();
    if (name) {
      const rendered = renderNamedSpec(name);
      if (rendered === undefined) {
        return {
          output: `${name} 没有单独登记结构规范——按自由形状成稿即可（专题页、章节细纲都属此类）。要取整层的规范请用 layer。`,
        };
      }
      return { output: rendered, metadata: { name } };
    }
    const layer = (args.layer ?? "").trim().toLowerCase();
    if (!LAYER_IDS.includes(layer)) {
      return {
        output: `design-spec 的 layer 应为：${LAYER_IDS.join(" / ")}（收到：${args.layer}）。有自己规范的文档（大纲的卷纲 / 序列纲）改用 name 给路径。`,
      };
    }
    return { output: renderDesignSpec(layer as LayerId), metadata: { layer } };
  },
});

export const FRAMEWORK_TOOLS: RegisteredTool[] = [designSpecTool];
