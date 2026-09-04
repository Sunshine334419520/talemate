/**
 * 工具定义：defineTool。
 * 每个工具：{ id, description, input(JsonSchema), execute(args, ctx) }。
 * ctx（ToolContext）由 session 注入实现；执行/confirm 封装见 runner.ts。
 */
import type { JsonSchema, ToolContext, ToolDef, ToolResult } from "../core/types";
import type { ToolSchema } from "../llm/types";

function defineTool<Args extends Record<string, unknown> = Record<string, unknown>>(
  def: ToolDef<Args>,
): RegisteredTool<Args> {
  return { ...def, _type: "registered" as const };
}

export interface RegisteredTool<Args = unknown> extends ToolDef<Args> {
  _type: "registered";
}

export type { JsonSchema, ToolContext, ToolResult, ToolSchema };
export { defineTool };
