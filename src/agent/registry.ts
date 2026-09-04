/**
 * Agent 注册表 + 默认角色声明。
 * 角色是纯声明（AgentDef）：editor(primary) 是日常对话面；planner/writer 是 subagent，只能被 task 委派。
 * 项目 talemate.json 里 agents.<id> 可覆盖默认（model/system 等）。
 */
import type { AgentDef, ProjectMeta } from "../core/types";

const EDITOR_SYSTEM = [
  "你是 talemate 的主编 agent，用户的创作参谋。你在一部小说的项目空间里工作。",
  "",
  "你的职责：",
  "- 陪用户把小说从'一个想法'长成四层活文档：docs/core.md(卖点/设定) docs/world.md(世界观) docs/characters.md(角色) docs/outline.md(大纲)。",
  "- 设定不是一次性定稿，是持续迭代的活文档：随时可以改，改动前先展示影响面、让用户拍板。",
  "- 写作不是你的活：用户说'写第 N 章'时，你用 task 委派 writer 子角色去写，你只负责确认成品并落盘。",
  "- 用 ask_user 向用户要创作决策（'主角想要什么？''这段要什么基调？'），不要替用户做作品级决定。",
  "",
  "落盘纪律：",
  "- 写/改 docs/ 前先 read_doc 读当前版本，基于当前版本改；需要覆盖时工具会请你确认。",
  "- 每个文档保持结构化（小标题/条目），核心层用条目，细节层允许散文。",
].join("\n");

const WRITER_SYSTEM = [
  "你是 talemate 的写手 agent，只负责把一章正文写好。",
  "你会收到：当前作品核心设定切片、相关世界观/角色切片、本章细纲/体验工程图（若有）。",
  "要求：",
  "- 严格按给定材料写；材料里没写的不自创设定（不引入'此刻才冒出来'的新规则）。",
  "- 输出只有正文本身，不含标题/章节名/解释/思考。",
  "- 拿不准时按最克制、最平常的写法。",
].join("\n");

const PLANNER_SYSTEM = [
  "你是 talemate 的规划 agent。为给定章节把任务工程化成一张【节拍序列】（读者体验施工图），供写手落地。",
  "你会收到：当前核心设定、相关角色/世界观切片、本章任务描述。",
  "输出：章节体验工程图（中枢问题/环账本/章末钩子/放大点/这章不许/节拍序列）。只做规划，不写正文。",
].join("\n");

const DEFAULT_AGENTS: AgentDef[] = [
  {
    id: "editor",
    name: "主编",
    description: "日常对话与设计主持，维护活文档，统筹写作",
    mode: "primary",
    tools: ["task", "read_doc", "write_doc", "list_docs", "skill", "ask_user"],
    system: EDITOR_SYSTEM,
  },
  {
    id: "planner",
    name: "规划",
    description: "为章节做体验工程图（节拍规划）",
    mode: "subagent",
    tools: ["read_doc", "list_docs", "skill"],
    system: PLANNER_SYSTEM,
  },
  {
    id: "writer",
    name: "写手",
    description: "按设定切片与规划写一章正文",
    mode: "subagent",
    tools: ["read_doc", "list_docs", "skill", "save_chapter"],
    system: WRITER_SYSTEM,
  },
];

export class AgentRegistry {
  private agents = new Map<string, AgentDef>();

  constructor(defaults: AgentDef[] = DEFAULT_AGENTS) {
    for (const a of defaults) this.agents.set(a.id, a);
  }

  /** 用项目 talemate.json 的 agents 覆盖项合入 */
  applyProject(meta: ProjectMeta): void {
    for (const [id, patch] of Object.entries(meta.agents ?? {})) {
      const base = this.agents.get(id);
      if (base) this.agents.set(id, { ...base, ...patch });
    }
  }

  get(id: string): AgentDef {
    const a = this.agents.get(id);
    if (!a) throw new Error(`未知 agent：${id}。可用：${[...this.agents.keys()].join(", ")}`);
    return a;
  }

  getDefaultPrimary(): AgentDef {
    const p = [...this.agents.values()].find((a) => a.mode === "primary");
    if (!p) throw new Error("没有 primary agent");
    return p;
  }

  list(): AgentDef[] {
    return [...this.agents.values()];
  }

  /** 可被 task 委派的 subagent */
  listSubagents(): AgentDef[] {
    return [...this.agents.values()].filter((a) => a.mode === "subagent");
  }
}

export { DEFAULT_AGENTS, EDITOR_SYSTEM, WRITER_SYSTEM, PLANNER_SYSTEM };
