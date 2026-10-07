/**
 * 会话模式：临时叠在 primary agent 上的一层，管权限与"这个模式是什么"。
 *
 * 与 `AgentDef` 的分工：agent 回答"你是谁"（长期），模式回答"眼下在干什么"（一次一仗），
 * 所以模式必须有界——进去、做完、出来；开放式谈话不套模式。它不装工作流，只活在会话内存里
 * （进程重启回默认），硬保证归工具的 `halt` 而不是模式。
 */
import type { PermissionConfig } from "../permission";
import { readPrompt } from "../prompts";

export interface ModeDef {
  id: string;
  /** 这个模式是什么（一句话，给人看；模式切换工具的文案用它） */
  title: string;
  /** 进 system 的短注记（英文，面向模型）：这个模式是什么、为什么有些工具不见了。不装工作流 */
  note: string;
  /** 模式对权限的覆盖（配置形）。`deny` 单调——不受层级顺序影响（见 `permission.evaluate` 第 1 步） */
  permission: PermissionConfig;
}

/**
 * 三向审阅所在的模式 id。工具的前置判断与 harness 的退出判断都引它，不各写一遍字面量
 * ——两边写岔了，模型会看到"工具说可以提案、harness 却不认"。
 */
export const DRAFT_MODE = "draft";

export const MODES: Record<string, ModeDef> = {
  /**
   * 只读，产出一份东西交给用户审阅——三向（接受 / 拒绝 / 提意见）的唯一通道。
   *
   * 出口条件是用户接受或拒绝，不是"提案成功"（见 `session.verdictEffect`）：提意见留在模式里
   * 接着改，所以一次设计会话只进一次模式。
   *
   * 权限用 `deny` 而不是从白名单里减名字，因此自动覆盖所有声明了 `edit` 的工具，将来新增的
   * 写作工具也不会破功；带 `*` 的 deny 会让它们从 schema 里消失，而不是"有但会被拒"。
   */
  [DRAFT_MODE]: {
    id: DRAFT_MODE,
    title: "草稿模式",
    note: readPrompt("modes/draft"),
    permission: { edit: "deny", delegate: "deny" },
  },

  /** 落盘不问，其余照问：委派和联网仍是 `ask`，只放开 `edit` 这一类。 */
  "accept-edits": {
    id: "accept-edits",
    title: "免确认落盘",
    note: readPrompt("modes/accept-edits"),
    permission: { edit: "allow" },
  },
};
