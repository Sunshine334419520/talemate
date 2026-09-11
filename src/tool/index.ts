/**
 * 工具汇总：按领域拆模块（design / character / framework / core / web），这里只做聚合注册。
 * 加工具 = 在对应领域文件定义一个 + 放进该组数组；不要往这个文件堆实现。
 */
import type { RegisteredTool } from "./define";
import { CHARACTER_TOOLS } from "./character_tools";
import { DESIGN_TOOLS } from "./design_tools";
import { FRAMEWORK_TOOLS } from "./framework_tools";
import { CORE_TOOLS } from "./core_tools";
import { WEB_TOOLS } from "./web_tools";

export { DESIGN_TOOLS, CHARACTER_TOOLS, FRAMEWORK_TOOLS, CORE_TOOLS, WEB_TOOLS };
export * from "./define";
export type { RegisteredTool };

/** 全部内置工具（session 注册用）。顺序无意义，权限/可见由 AgentDef.tools 白名单决定。 */
export const BUILTIN_TOOLS: RegisteredTool[] = [
  ...DESIGN_TOOLS,
  ...CHARACTER_TOOLS,
  ...FRAMEWORK_TOOLS,
  ...CORE_TOOLS,
  ...WEB_TOOLS,
];
