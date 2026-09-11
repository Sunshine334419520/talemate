/**
 * Agent 注册表 + 默认角色声明（规范化，见 05-agent-spec.md / prompts/README.md）。
 *
 * persona（system）全部放 prompts/*.txt，readPrompt 加载（英文）；description 内联于此（短数据，路由契约）。
 * 语义：
 * - editor = 唯一 primary（日常对话面 + 项目执掌）。无导演/评审 agent，拍板只属于人。
 * - planner / writer = subagent，只能被 task 委派；"何时派"写在各 subagent 的 description，
 *   由 subagentCatalog() 自动拼进 task 工具目录（照 opencode describeTask）。
 * - summarizer = hidden 内部 agent（compaction 用）。
 * - Agent 是数据：talemate.json 的 agents.<id> 可覆盖（model/system/steps…）。
 */
import type { AgentDef, ProjectMeta } from "../core/types";
import { readPrompt } from "../prompts";

// persona 放角色壳（定语气）与必要的编排残差；机制/方法归数据与工具，见 prompts/README.md 归属纪律。
const EDITOR_SYSTEM = readPrompt("editor.system");
const WRITER_SYSTEM = readPrompt("writer.system");
const PLANNER_SYSTEM = readPrompt("planner.system");
const SUMMARIZER_SYSTEM = readPrompt("summarizer.system");

const DEFAULT_AGENTS: AgentDef[] = [
  {
    id: "editor",
    name: "主编",
    description: "The chief editor. Runs the project, maintains the design docs (design/), and orchestrates planning/writing via task.",
    mode: "primary",
    tools: [
      "task",
      "read-design",
      "write-design",
      "edit-design",
      "append-design",
      "remove-design-section",
      "search-designs",
      "list-designs",
      "skill",
      "ask-user",
      "confirm",
      "add-character",
      "update-character",
      "remove-character",
      "design-spec",
      "webfetch",
      "websearch",
    ],
    system: EDITOR_SYSTEM,
  },
  {
    id: "planner",
    name: "规划",
    description:
      "The structural designer. Turns source material into a usable plan: chapter beat sheets, whole-novel or volume outlines, or cascading restructures across the design docs.\n" +
      "Use this when you need a chapter's beat plan (细纲 / 节拍), to synthesize the whole outline (design/outline/outline.md) from the existing docs, or when a setting change must cascade and re-consolidate several docs — jobs that require reading the full material and returning one consistent structure.",
    mode: "subagent",
    tools: ["read-design", "list-designs", "skill", "webfetch", "websearch"],
    system: PLANNER_SYSTEM,
  },
  {
    id: "writer",
    name: "写手",
    description:
      "The prose writer. Writes one chapter's prose strictly from the provided setting slices + beat plan.\n" +
      "Use this when the user asks for a chapter's prose AND that chapter already has an approved beat plan (design/outline/plan_ch<N>.md); if there is no plan yet, first delegate planner to produce one. It runs in an isolated context to focus on the draft; you (chief editor) review and approve the piece before it lands in chapters/.",
    mode: "subagent",
    tools: ["read-design", "list-designs", "skill", "save-chapter"],
    system: WRITER_SYSTEM,
  },
  {
    id: "summarizer",
    name: "摘要器",
    description: "Internal: generates a prior-state summary during context compaction. (hidden, never surfaced)",
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
    // 空 description = 路由契约未写 → 明示"只能由用户手动调用"，不让模型自动委派（照 opencode）。
    return subs
      .map(
        (a) =>
          `- ${a.id}: ${a.description.trim() || "This subagent should only be called manually by the user."}`,
      )
      .join("\n");
  }
}

export { DEFAULT_AGENTS, EDITOR_SYSTEM, WRITER_SYSTEM, PLANNER_SYSTEM, SUMMARIZER_SYSTEM };
