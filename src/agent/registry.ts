/**
 * Agent 注册表 + 默认角色声明（规范化，见 05-agent-spec.md / 06 §6）。
 *
 * 提示词放 prompts/*.txt（见 prompts/README.md）；persona 只留角色壳（inline，一句）。
 * 语义：
 * - editor = 唯一 primary（日常对话面 + 项目执掌）。无导演/评审 agent，拍板只属于人。
 * - planner / writer = subagent，只能被 task 委派；"何时派"写在各 subagent 的 description，
 *   由 describeTask 自动拼进 task 工具目录。
 * - summarizer = hidden 内部 agent（compaction 用）。
 * - Agent 是数据：talemate.json 的 agents.<id> 可覆盖（model/system/steps…）。
 */
import type { AgentDef, ProjectMeta } from "../core/types";
import { readPrompt } from "../prompts";

// persona 只放角色壳（定语气）；机制/方法归数据与条件协议，见 06 §6.6。
const EDITOR_SYSTEM =
  "You are talemate's chief editor — the user's creative partner, and the steward of a novel's project space.";

const WRITER_SYSTEM = readPrompt("writer.system");
const PLANNER_SYSTEM = readPrompt("planner.system");
const SUMMARIZER_SYSTEM = readPrompt("summarizer.system");

const DEFAULT_AGENTS: AgentDef[] = [
  {
    id: "editor",
    name: "主编",
    description: "日常对话与项目执掌：维护 docs 四层活文档，设计段引导创作，写作段编排 planner/writer",
    mode: "primary",
    tools: [
      "task",
      "read-doc",
      "write-doc",
      "edit-doc",
      "append-doc",
      "remove-doc-section",
      "search-docs",
      "list-docs",
      "skill",
      "ask-user",
      "confirm",
      "add-character",
      "update-character",
      "remove-character",
      "doc-spec",
      "webfetch",
      "websearch",
    ],
    system: EDITOR_SYSTEM,
  },
  {
    id: "planner",
    name: "规划",
    description:
      "把材料梳理成结构/规划（章节节拍、整本/分卷大纲综合、结构重排）。何时用：用户要'第 N 章的节拍/细纲'、'把现有 docs 综合成整本/分卷大纲'，或一次设定改动要级联重整多份 docs 时——需要读全量材料再产出一致结构的活派它。",
    mode: "subagent",
    tools: ["read-doc", "list-docs", "skill", "webfetch", "websearch"],
    system: PLANNER_SYSTEM,
  },
  {
    id: "writer",
    name: "写手",
    description:
      "按设定切片与节拍写一章正文。何时用：用户要写正文且该章已有细纲/节拍（没有就先派 planner 出节拍）——它独立上下文专注成稿，成品由你（主编）拍板后落盘。",
    mode: "subagent",
    tools: ["read-doc", "list-docs", "skill", "save-chapter"],
    system: WRITER_SYSTEM,
  },
  {
    id: "summarizer",
    name: "摘要器",
    description: "（内部）上下文压缩时生成前情摘要",
    mode: "primary",
    hidden: true,
    tools: [],
    system: SUMMARIZER_SYSTEM,
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

  /** 默认 primary：第一个非 hidden 的 primary（editor）。 */
  getDefaultPrimary(): AgentDef {
    const p = [...this.agents.values()].find((a) => a.mode === "primary" && !a.hidden);
    if (!p) throw new Error("没有可见的 primary agent");
    return p;
  }

  list(): AgentDef[] {
    return [...this.agents.values()];
  }

  /** 可见 subagent（可被 task 委派；hidden 不在此列） */
  listSubagents(): AgentDef[] {
    return [...this.agents.values()].filter((a) => a.mode === "subagent" && !a.hidden);
  }

  /** task 工具的动态目录文本（describeTask，照 opencode registry.describeTask） */
  subagentCatalog(): string {
    const subs = this.listSubagents();
    if (!subs.length) return "";
    return subs.map((a) => `- ${a.id}: ${a.description}`).join("\n");
  }
}

export { DEFAULT_AGENTS, EDITOR_SYSTEM, WRITER_SYSTEM, PLANNER_SYSTEM, SUMMARIZER_SYSTEM };
