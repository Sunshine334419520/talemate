/**
 * 工具框架：defineTool + registry。
 * 每个工具：{ id, description, input(JsonSchema), execute(args, ctx) }。
 * ctx（ToolContext）由 session 注入实现：confirm/ask_user/read_doc/write_doc/list_docs/run_subagent/load_skill/save_chapter。
 *
 * 极简权限：默认放行；工具可给 needsConfirm(args) 返回摘要，session 在执行前向用户确认。
 */
import type { JsonSchema, ToolContext, ToolDef, ToolResult } from "../core/types";
import type { ToolSchema } from "../llm";

function defineTool<Args extends Record<string, unknown> = Record<string, unknown>>(
  def: ToolDef<Args>,
): RegisteredTool<Args> {
  return { ...def, _type: "registered" as const };
}

export interface RegisteredTool<Args = unknown> extends ToolDef<Args> {
  _type: "registered";
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register(t: RegisteredTool): void {
    this.tools.set(t.id, t);
  }

  get(id: string): RegisteredTool {
    const t = this.tools.get(id);
    if (!t) throw new Error(`未知工具：${id}`);
    return t;
  }

  has(id: string): boolean {
    return this.tools.has(id);
  }

  /** 该 agent 可见的工具 schema（喂给模型选工具） */
  schemasFor(agentTools: string[]): ToolSchema[] {
    return agentTools
      .map((id) => this.tools.get(id))
      .filter((t): t is RegisteredTool => !!t)
      .map((t) => ({ name: t.id, description: t.description, inputSchema: t.input }));
  }

  list(): string[] {
    return [...this.tools.keys()];
  }
}

export type { JsonSchema, ToolContext, ToolResult };
export { defineTool };
