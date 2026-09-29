/**
 * Agent 注册表 + 默认角色声明（规范化，见 docs/agents.md / prompts/README.md）。
 *
 * persona（system）全部放 prompts/*.txt，readPrompt 加载（英文）；description 内联于此（短数据，路由契约）。
 * 语义：
 * - mate = 唯一 primary（日常对话面 + 项目执掌）。无导演/评审 agent，拍板只属于人（**人是主编**，
 *   agent 是搭档——两者不能共用一个头衔）。
 * - planner = subagent，只能被 task 委派；"何时派"写在它的 description，
 *   由 subagentCatalog() 自动拼进 task 工具目录。**只读 + 只联网**——它产出一份规划，落盘归 mate。
 * - researcher = subagent，同上。**作品只读 + 只联网**（`edit` 是类别拒）——它考据外部世界，
 *   产出入带出处的事实，落盘仍归 mate。
 *   唯一被允许写的是**它自己的考据本**（`.talemate/research/`，`notes` 权限，引擎工作区、非作品）：
 *   同一个问题不该被查第二遍。见 `framework/research.ts`。
 * - summarizer = hidden 内部 agent（compaction 用）。
 * - Agent 是数据：talemate.json 的 agents.<id> 可覆盖（model/system/steps…）。
 * - permissions：`tools` 是**广告**（模型看得到哪些 schema），`permission` 才是**边界**（见
 *   `docs/permissions.md`）。子代理派生时只继承父的 deny、不继承父的 allow。
 */
import type { AgentDef, ProjectMeta } from "../core/types";
import { readPrompt } from "../prompts";

// persona 放角色壳（定语气）与必要的编排残差；机制/方法归数据与工具，见 prompts/README.md 归属纪律。
const MATE_SYSTEM = readPrompt("mate.system");
const PLANNER_SYSTEM = readPrompt("planner.system");
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
    id: "planner",
    name: "规划者",
    description:
      "The chapter planner. Turns one chapter's intent into an executable plan: the beats in order, the characters it must land, the facts that had to be checked with their sources, and the artifacts the chapter lands in.\n" +
      "Use this when the user asks for a chapter's prose and no plan for that chapter exists yet — it reads the design docs end to end and returns one plan you then put in front of the user via propose-plan.\n" +
      "Not for prose — you write that yourself. Not for a fact one lookup settles, or for a design call: use webfetch, the researcher, or the user.",
    mode: "subagent",
    // `recall` 只读：规划者自己也在查证（它的 persona 就是"不能凭记忆断言的事实自己查"），
    // 而考据本里可能已经有答案——没它就只会上网重查一遍。只给 `recall`，**永远不给 `remember`**：
    // 记什么、什么时候记，是研究员那份契约。
    tools: ["read", "list", "search", "webfetch", "websearch", "recall"],
    permission: {
      // 子代理跑在隔离上下文里、用户不在场：不能提问（会把用户从自己的对话里硬拽出来），
      // 也不能委派（防链式 spawn）。
      question: "deny",
      delegate: "deny",
      // **只读，而且是类别拒**（与 researcher 同款）——`edit` 上的 `"*"` deny 让 write / edit /
      // delete / apply-design 整个从 schema 里消失。规划者是"读全套材料、回一份工作单"，
      // 落盘由 mate 做（`propose-plan` 把规划落到 `.talemate/plans/`）。
      edit: "deny",
      // 考据本是研究员的（`notes: "allow"` 在它那边）。这里明写 deny 而不是留空：留空 = 默认
      // `ask` = 一次 `io.confirm`，而用户不在场。顺带这一条也让 `remember` 从它的 schema 里消失。
      notes: "deny",
    },
    system: PLANNER_SYSTEM,
  },
  {
    id: "researcher",
    name: "考据",
    description:
      "The fact-checker. Researches the real world and returns findings with their sources — how a period's office or tax really worked, what a thing was called, how far a weapon reached.\n" +
      "Use this when the novel needs a fact you must not assert from memory and settling it will take several searches and reads: it returns the conclusion and its sources, not the pages it read to get there. For a fact one lookup settles, call webfetch yourself instead. It reads the project but never writes the book — you decide what lands. Findings it expects to be asked again it keeps in its own research notes, so a later session does not look them up twice.",
    mode: "subagent",
    tools: ["read", "list", "search", "webfetch", "websearch", "recall", "remember"],
    permission: {
      // 子代理跑在隔离上下文里、用户不在场：不能提问（会把用户从自己的对话里硬拽出来），
      // 也不能委派（防链式 spawn）。
      question: "deny",
      delegate: "deny",
      // **作品只读，而且是类别拒**——`edit` 上的 `"*"` deny 让 write / edit / delete / apply-design
      // 整个从 schema 里消失（不是"看得见但会被拒"）。作品文档一个字节都动不了：落盘由 mate 做，
      // 它只提供材料，不决定什么进书。
      edit: "deny",
      // 唯一被允许写的是**它自己的考据本**（引擎工作区，不是作品）。这不是记账、是机制：
      // 留空 → 默认 `ask` → `ctx.ask` → `io.confirm`，一个跑在隔离上下文里的子代理去弹用户的脸，
      // 正是上面 `question: "deny"` 要防的那件事。`notes` 也不能并进 `edit`——见 `permission.ts`。
      notes: "allow",
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

export { DEFAULT_AGENTS, MATE_SYSTEM, PLANNER_SYSTEM, RESEARCHER_SYSTEM, SUMMARIZER_SYSTEM };
