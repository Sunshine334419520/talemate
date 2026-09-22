/**
 * 会话模式：临时叠在 primary agent 上的一层。**它管的是权限**——外加一句"这个模式是什么"。
 *
 * 模式**不装工作流**。"进了 plan 模式之后该怎么设计"不归它管，那归工具自己的输入契约与工作协议。
 * 它只回答：现在是什么模式、这个模式下什么能做、什么要问、什么不能做。
 *
 * 与 `AgentDef` 的分工：agent 回答"你是谁"（长期），模式回答"眼下在干什么"（一次一仗）。所以模式
 * **必须有界**——进去、做完、出来。开放式的谈话（和用户聊设计）不套模式，那会把人关在里面出不来。
 *
 * 模式**只活在会话内存里**，和待执行提案同生命周期：进程重启即回到默认。硬保证不靠模式——写正文
 * 那道门挂在 `task(writer)` 上（查一份 approved 的节拍）。
 */
import type { PermissionConfig } from "../permission";
import { readPrompt } from "../prompts";

export interface ModeDef {
  id: string;
  /** 这个模式是什么（一句话，给人看；模式切换工具的文案用它） */
  title: string;
  /** 进 system 的短注记（英文，面向模型）：这个模式是什么、为什么有些工具不见了。**不装工作流** */
  note: string;
  /** 模式对权限的覆盖（配置形）。`deny` 单调——不受层级顺序影响（见 `permission.evaluate` 第 1 步） */
  permission: PermissionConfig;
}

/**
 * 三向审阅所在的模式 id。
 *
 * 工具的前置判断（`propose-*` 不在它里面就回自愈文案）与 harness 的退出判断（接受/拒绝才退出）
 * 都引这个常量，不各写一遍字面量——两边写岔了，模型会看见"工具说可以提案、harness 却不认"。
 */
export const DRAFT_MODE = "draft";

export const MODES: Record<string, ModeDef> = {
  /**
   * 只读，产出一份东西交给用户审阅——**三向（接受 / 拒绝 / 提意见）的唯一通道**。
   *
   * 名字叫"草稿"而不是"计划"：它的本质是 produce-before-commit，出口有两个（`propose-design`
   * 出设计草稿、`propose-plan` 出节拍），不是只有"做计划"。名字钉死在其中一半上，读的人就会
   * 以为另一半不归它管——这个仓库已经因为这类漂移吃过几次亏。
   *
   * 出口条件是**用户接受或拒绝**，不是"提案成功"（见 `session.verdictEffect`）：提意见留在模式里
   * 接着改，所以一次设计会话只进一次模式。
   *
   * 权限用 `deny` 而不是"从白名单里减掉名字"——所以它**自动覆盖所有声明了 `edit` 的工具**，
   * 将来加了新的写作工具也不会破功，而且带 `*` 的 deny 会让它们从 schema 里消失（不是"有但会被拒"）。
   */
  [DRAFT_MODE]: {
    id: DRAFT_MODE,
    title: "草稿模式",
    note: readPrompt("modes/draft"),
    permission: { edit: "deny", delegate: "deny" },
  },

  /** 落盘不问，其余照问。委派和联网仍然是 `ask`——"少问一类"不等于"什么都别问"。 */
  "accept-edits": {
    id: "accept-edits",
    title: "免确认落盘",
    note: readPrompt("modes/accept-edits"),
    permission: { edit: "allow" },
  },
};
