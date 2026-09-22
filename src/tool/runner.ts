/**
 * 工具执行：一次工具调用 → 对应的 assistant part（completed/error）。
 * 流程：查表 → 类别兜底（`deny *`）→ execute → 包成 part。权限判定在 execute 里走 `ctx.ask`。
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
  // 粗粒度兜底：`deny *` 盖住的类别一律拒——哪怕这个工具是被幻觉调出来的（它已经从 schema 里
  // 消失了，但执行查的是全局 registry，所以这里必须再挡一次）。细粒度（具体 pattern 的
  // allow/ask）由工具自己走 `ctx.ask`，因为只有它知道这次动的是哪个对象。
  if (tool.permission && ctx.check(tool.permission, "*") === "deny") {
    return {
      ...base,
      state: "error",
      error: `当前模式不允许 ${tool.id}（这一类动作被禁用）`,
      time: { ...base.time, completed: Date.now() },
    };
  }
  try {
    const args = call.input as never;
    const res = await tool.execute(args, ctx);
    return {
      ...base,
      state: "completed",
      output: res.output,
      // 只有**成功**才允许结束本回合：被拒/校验失败必须留给模型同轮自纠，
      // 否则循环会死在一个本可自愈的错误上（见 prompt 工具返回的"可用小节"这类自愈文案）。
      halt: tool.halt === true,
      time: { ...base.time, completed: Date.now() },
    };
  } catch (e) {
    return {
      ...base,
      state: "error",
      error: e instanceof Error ? e.message : String(e),
      time: { ...base.time, completed: Date.now() },
    };
  }
}
