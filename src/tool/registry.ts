/**
 * 工具注册表：按 agent/permission 过滤。登记 defineTool 产生的 RegisteredTool；
 * schemasFor 给出该 agent 可见工具的描述，供 LLM 选工具。
 */
import type { ToolDef, ToolContext, ToolResult, JsonSchema } from "../core/types";
import type { ToolSchema } from "../llm/types";
import type { RegisteredTool } from "./define";

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

export type { ToolDef, ToolContext, ToolResult, JsonSchema, ToolSchema };
