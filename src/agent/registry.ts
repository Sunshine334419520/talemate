/**
 * Agent 注册表 + 默认角色声明（规范化，见 docs/agents.md / prompts/README.md）。
 *
 * persona（system）全部放 prompts/*.txt，readPrompt 加载（英文）；description 内联于此（短数据，路由契约）。
 * 语义：
 * - mate = 唯一 primary（日常对话面 + 项目执掌）。无导演/评审 agent，拍板只属于人（**人是主编**，
 *   agent 是搭档——两者不能共用一个头衔）。
 * - writer = subagent，只能被 task 委派；"何时派"写在它的 description，
 *   由 subagentCatalog() 自动拼进 task 工具目录。
 * - researcher = subagent，同上。**只读 + 只联网**（`edit` 是类别拒）——它考据外部世界，
 *   产出入带出处的事实，落盘仍归 mate。
 * - summarizer = hidden 内部 agent（compaction 用）。
 * - Agent 是数据：talemate.json 的 agents.<id> 可覆盖（model/system/steps…）。
 * - permissions：`tools` 是**广告**（模型看得到哪些 schema），`permission` 才是**边界**（见
 *   `docs/permissions.md`）。子代理派生时只继承父的 deny、不继承父的 allow。
 */
import type { AgentDef, ProjectMeta } from "../core/types";
import { readPrompt } from "../prompts";

// persona 放角色壳（定语气）与必要的编排残差；机制/方法归数据与工具，见 prompts/README.md 归属纪律。
const MATE_SYSTEM = readPrompt("mate.system");
const WRITER_SYSTEM = readPrompt("writer.system");
const RESEARCHER_SYSTEM = readPrompt("researcher.system");
const SUMMARIZER_SYSTEM = readPrompt("summarizer.system");

const DEFAULT_AGENTS: AgentDef[] = [
  {
    id: "mate",
    name: "搭档",
    description:
      "The writing partner. Runs the project, maintains the design docs (design/), and orchestrates chapter production.",
    mode: "primary",
    tools: [
      "task",
      "read",
      "write",
      "edit",
      "delete",
      "propose-design",
      "apply-design",
      "propose-plan",
      "enter-draft",
      "exit-draft",
      "search",
      "list",
      "skill",
      "ask-user",
      "confirm",
      "design-spec",
      "webfetch",
      "websearch",
    ],
    system: MATE_SYSTEM,
  },
  {
    id: "writer",
    name: "写手",
    description:
      "The prose writer. Writes one chapter's prose strictly from the provided setting slices + beat plan.\n" +
      "Use this when the user asks for a chapter's prose AND you hold a beat plan for that chapter the user has already approved via propose-plan; if there is no beat plan yet, write it yourself and propose-plan it first. It runs in an isolated context to focus on the draft; you (the writing partner) review and approve the piece before it lands in chapters/.\n" +
      "Do not use it for anything but prose: a real-world fact goes to the researcher, and a design call belongs to the user.",
    mode: "subagent",
    tools: ["read", "list", "skill", "write"],
    permission: {
      // 子代理跑在隔离上下文里、用户不在场：不能提问（会把用户从自己的对话里硬拽出来），
      // 也不能委派（防链式 spawn）。其余按默认（落盘仍然问）。
      question: "deny",
      delegate: "deny",
      // **写手的活动范围**：只写得了 chapters/，碰不了 design/。
      //
      // 从前这条边界是靠一个专用工具（save-chapter）表达的，现在是**一条数据**——加一个要保护的
      // 目录就加一条规则，不用再造工具。注意用的是**具体 pattern 的 deny**，不是 `"*": "deny"`：
      // 后者会让 `write` 整个从 schema 里消失（visibleTools 在 pattern `*` 上求值），
      // 而这里要的是"工具还在，但有一个目录例外"。
      edit: { "design/*": "deny" },
    },
    system: WRITER_SYSTEM,
  },
  {
    id: "researcher",
    name: "考据",
    description:
      "The fact-checker. Researches the real world and returns findings with their sources — how a period's office or tax really worked, what a thing was called, how far a weapon reached.\n" +
      "Use this when the novel needs a fact you must not assert from memory and settling it will take several searches and reads: it returns the conclusion and its sources, not the pages it read to get there. For a fact one lookup settles, call webfetch yourself instead. It reads the project but never writes it — you decide what lands.",
    mode: "subagent",
    tools: ["read", "list", "search", "webfetch", "websearch"],
    permission: {
      // 子代理跑在隔离上下文里、用户不在场：不能提问（会把用户从自己的对话里硬拽出来），
      // 也不能委派（防链式 spawn）。
      question: "deny",
      delegate: "deny",
      // **只读，而且是类别拒**——`edit` 上的 `"*"` deny 让 write / edit / delete / apply-design
      // 整个从 schema 里消失（不是"看得见但会被拒"）。研究者一个字节都动不了：
      // 落盘由 mate 做，它只提供材料，不决定什么进书。
      edit: "deny",
    },
    system: RESEARCHER_SYSTEM,
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

  /** task 工具的动态目录文本 */
  subagentCatalog(): string {
    const subs = this.listSubagents();
    if (!subs.length) return "";
    // 空 description = 路由契约未写 → 明示"只能由用户手动调用"，不让模型自动委派。
    return subs
      .map(
        (a) =>
          `- ${a.id}: ${a.description.trim() || "This subagent should only be called manually by the user."}`,
      )
      .join("\n");
  }
}

export { DEFAULT_AGENTS, MATE_SYSTEM, WRITER_SYSTEM, RESEARCHER_SYSTEM, SUMMARIZER_SYSTEM };
