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
  /** 这个模式是否替换 agent 的 role system（prompt id；不填则用 agent.system） */
  system?: string;
  /** 进 system 的短注记（英文，面向模型）：这个模式是什么、为什么有些工具不见了。不装工作流 */
  note: string;
  /** 模式对权限的覆盖（配置形）。`deny` 单调——不受层级顺序影响（见 `permission.evaluate` 第 1 步） */
  permission: PermissionConfig;
}

/**
 * 正文模式：只换 system，不改权限；进出由 enter-prose / exit-prose 与 plan done 管。
 * 没有"草稿模式"：审阅走写前 diff / 整篇预览，不再是一层把落盘藏起来的模式（见 docs/assets.md）。
 */
export const PROSE_MODE = "prose";

export const MODES: Record<string, ModeDef> = {
  [PROSE_MODE]: {
    id: PROSE_MODE,
    title: "正文",
    note: readPrompt("modes/prose"),
    system: "prose.system",
    // 不覆盖权限：用户在设置里选「每次询问」时，写正文仍然要问；选 accept-edits 时照旧允许。
    permission: {},
  },

  /** 落盘不问，其余照问：委派和联网仍是 `ask`，只放开 `edit` 这一类。 */
  "accept-edits": {
    id: "accept-edits",
    title: "工作区内修改",
    note: readPrompt("modes/accept-edits"),
    permission: { edit: "allow" },
  },
};
