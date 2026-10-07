/**
 * 工具汇总：按领域拆模块（file / read / research / design / framework / core / web），这里只做聚合注册。
 * 加工具 = 在对应领域文件定义一个 + 放进该组数组；不要往这个文件堆实现。
 */
import type { RegisteredTool } from "./define";
import { DESIGN_TOOLS } from "./design_tools";
import { FILE_TOOLS } from "./file_tools";
import { FRAMEWORK_TOOLS } from "./framework_tools";
import { READ_TOOLS } from "./read_tools";
import { RESEARCH_TOOLS } from "./research_tools";
import { CORE_TOOLS } from "./core_tools";
import { WEB_TOOLS } from "./web_tools";

export { DESIGN_TOOLS, FRAMEWORK_TOOLS, READ_TOOLS, RESEARCH_TOOLS, CORE_TOOLS, WEB_TOOLS, FILE_TOOLS };
export * from "./define";
export type { RegisteredTool };

/**
 * 全部内置工具（session 注册用）。顺序无意义，权限/可见由 AgentDef.tools 白名单决定。
 * 删文件走 `file_tools` 的 `delete`（通用，谁都能删，引用检查照做），没有角色专用的删卡工具。
 */
export const BUILTIN_TOOLS: RegisteredTool[] = [
  ...FILE_TOOLS,
  ...READ_TOOLS,
  ...RESEARCH_TOOLS,
  ...DESIGN_TOOLS,
  ...FRAMEWORK_TOOLS,
  ...CORE_TOOLS,
  ...WEB_TOOLS,
];
