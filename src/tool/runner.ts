/**
 * 工具执行：一次工具调用 → 对应的 assistant part（completed/error）。
 * 流程：查表 → 若声明了 needsConfirm 先向用户确认 → execute → 包成 part。
 * 工具不存在 / 被拒 / 抛异常 → 包成 error part（不抛裸异常，让模型自纠）。
 * 这是纯工具层逻辑，不依赖 Session（上下文由调用方注入 ToolContext）。
 */
import type { AssistantPart, ToolCall, ToolContext } from "../core/types";
import type { ToolRegistry } from "./registry";

export async function executeToolPart(
  agentId: string,
  call: ToolCall,
  registry: ToolRegistry,
  ctx: ToolContext,
): Promise<AssistantPart> {
  const tool = registry.has(call.name) ? registry.get(call.name) : undefined;
  const base: AssistantPart = {
    type: "tool",
    id: call.id,
    name: call.name,
    state: "running",
    input: call.input ? JSON.stringify(call.input) : undefined,
    time: { ran: Date.now() },
  };
  if (!tool) {
    return { ...base, state: "error", error: `未知工具 ${call.name}`, time: { ...base.time, completed: Date.now() } };
  }
  // 极简权限：工具声明了 needsConfirm 就先问用户
  if (tool.needsConfirm) {
    const summary = tool.needsConfirm(call.input as never);
    if (summary) {
      const ok = await ctx.confirm(tool.id, summary);
      if (!ok) {
        return { ...base, state: "error", error: "用户拒绝了该操作", time: { ...base.time, completed: Date.now() } };
      }
    }
  }
  try {
    const args = call.input as never;
    const res = await tool.execute(args, ctx);
    return { ...base, state: "completed", output: res.output, time: { ...base.time, completed: Date.now() } };
  } catch (e) {
    return {
      ...base,
      state: "error",
      error: e instanceof Error ? e.message : String(e),
      time: { ...base.time, completed: Date.now() },
    };
  }
}
