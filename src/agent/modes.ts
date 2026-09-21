/**
 * 会话模式：临时叠在 primary agent 上的一层——**注入一段纪律 + 从白名单里减掉几个工具**。
 *
 * 与 `AgentDef` 的分工：agent 回答"你是谁"（长期），模式回答"眼下在干什么"（一次一仗）。
 * 所以模式**必须有界**——像"写某一章"：进去、做完、出来。开放式的谈话（比如和用户聊设计）
 * 不该套模式，那会把人关在里面出不来（`design-docs.md` 的「editor 没有阶段状态机」讲的是同一件事）。
 *
 * 模式**只活在会话内存里**，和待执行提案同生命周期：进程重启即回到普通模式。硬保证不靠它——
 * 写正文那道门挂在 `task(writer)` 上（查一份 approved 的节拍），模式只是把"计划期间别乱动"
 * 也变成结构性的，外加一个放纪律正文的地方。
 */
import { readPrompt } from "../prompts";

export interface ModeDef {
  id: string;
  /** 进入 system 的纪律正文，来自 `prompts/modes/<id>.txt` */
  discipline: string;
  /** 这个模式下从 agent 白名单里**减掉**的工具 */
  deny: string[];
}

/**
 * 现在是**一种**模式。表留着，因为模式的价值在于它是通用的一层——将来"规划下一卷"之类的
 * 有界流程可以复用同一套机制（换一份纪律、换一份 deny），而不是再发明一遍状态。
 */
export const MODES: Record<string, ModeDef> = {
  plan: {
    id: "plan",
    discipline: readPrompt("modes/plan"),
    /**
     * 藏掉**一切会落盘的**：`task`（子代理里就是写手）、以及设计文档的四个写入口。
     *
     * 判据是"这个工具能不能写文件"，不是"它是不是写正文"——计划模式的全部意义就是**期间不动世界**。
     * 所以设计文档也一起藏：规划某一章时顺手改设定是**范围漂移**，而且它改的正是你正在据以规划的
     * 那份材料。真需要改就先 `exit-plan`，改完再进来——那是一次看得见的中断，不是偷偷发生的。
     *
     * `save-chapter` 现在不在 editor 白名单里，列在这里是为了**以后加进来时不会破功**。
     * 这份表是 deny 式（失败时放行），所以`tests/framework.test.ts` 有一条用例拿 editor 的真实
     * 白名单去查漏——加了写作工具却忘了加进来，那条会红。
     */
    deny: ["task", "apply-design", "append-design", "remove-design-section", "remove-character", "save-chapter"],
  },
};
