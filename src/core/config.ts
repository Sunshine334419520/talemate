/**
 * 配置与路径解析。
 * - TALEMATE_HOME：受管根目录（默认 ~/.talemate），其下 novels/<project-id> 一小说一目录。
 * - 模型配置沿用现有环境变量（TALEMATE_PROVIDER/MODEL/REASONING/MAX_TOKENS/…），兼容已有 .env。
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelConfig, Provider, Reasoning } from "./types";

export function talemateHome(env = process.env): string {
  return env.TALEMATE_HOME || join(homedir(), ".talemate");
}

/** 受管根目录下的目录/文件路径 */
export function paths(home = talemateHome()) {
  return {
    home,
    novelsRoot: join(home, "novels"),
    globalSkills: join(home, "skills"),
    globalAgents: join(home, "AGENTS.md"),
  };
}

/**
 * 作品的三个根。
 *
 * **读口与写口共用这一份清单。** 从前它们各写一遍（`corpus.DOC_ROOTS` 与 `write_ops.WRITE_ROOTS`），
 * 靠两处注释互相指认"我们是同一套"。加一个根时那两处必须同时改，而漏改一处的后果是
 * **写得进去读不回来**（或反过来），且**不报错**——正是 `CLAUDE.md` 里"绝不手抄一份能推出来的清单"
 * 那条要防的事。收在这里之后，加根只改这一行，两边同时到位。
 *
 * 三个根的分工：`design/` 与 `chapters/` 是**作品**（设定与正文），`state/` 是**当前状态**
 * （每章都在变的东西：谁在场、谁知道什么、伏笔收到哪了）。判据见 `docs/state.md`。
 */
export const DOC_ROOTS = ["design", "chapters", "state"] as const;

export type DocRoot = (typeof DOC_ROOTS)[number];

/**
 * 某个根在某项目下的绝对目录——**唯一**一处"根 → 目录"的映射。
 *
 * 从前读口写口各有一句 `root === "design" ? pp.design : pp.chapters`：那种三元在加第三个根时会
 * **静默地把 state 也指到 chapters/**。改成按键取之后，"根没有对应目录"是编译期错误。
 */
export function rootAbs(projectId: string, root: DocRoot): string {
  return projectPaths(talemateHome(), projectId)[root];
}

/**
 * 仓库自带的 skill 库（`<repo>/skills/`）——随产品发布的那一份，如正文文风纪律 `prose`。
 *
 * 它与 `paths().globalSkills`（用户全局库）**不是一回事**：这个跟着代码走、改了要发版，
 * 那个是作者的、跨作品积累的。所以它排在发现顺序的**最后**——用户自己的同名 skill 压得过它，
 * 而它压不过任何人。相对 `import.meta.url` 解析，不依赖 cwd（同 `prompts.ts`）。
 */
export function builtinSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
}

/** 项目目录与内部结构 */
export function projectPaths(home: string, projectId: string) {
  const root = join(home, "novels", projectId);
  const design = join(root, "design");
  return {
    root,
    meta: join(root, "talemate.json"),
    agents: join(root, "AGENTS.md"),
    design,
    wiki: join(design, "wiki"),
    characters: join(design, "characters"),
    outline: join(design, "outline"),
    chapters: join(root, "chapters"),
    // 状态层：每章都在变的东西（谁在场、谁知道什么、伏笔收到哪了）。**与作品平级而不是
    // 在 design/ 下面**——它是"现在到哪了"，不是"这本书是什么样"，同一条边界也把规划工件
    // 挡在 .talemate/ 里。判据见 docs/state.md。
    state: join(root, "state"),
    skills: join(root, "skills"),
    sessions: join(root, ".talemate", "sessions"),
    // 章节规划工件（框架章节生产那条链的中间态）。**归 .talemate/ 而不是 design/**：
    // design/ 与 chapters/ 是作品（用户审阅、进版本控制），这一份是引擎的工作区。
    plans: join(root, ".talemate", "plans"),
  };
}

export function sessionPaths(home: string, projectId: string, sessionId: string) {
  const dir = join(home, "novels", projectId, ".talemate", "sessions", sessionId);
  return { dir, meta: join(dir, "session.json"), messages: join(dir, "messages.jsonl") };
}

/** 从环境变量加载项目默认模型（各角色可覆盖） */
export function loadModelConfig(env = process.env): ModelConfig {
  const provider = (env.TALEMATE_PROVIDER as Provider) || "anthropic";
  const reasoning = (env.TALEMATE_REASONING as Reasoning) || "off";
  const userMaxTokens = Number(env.TALEMATE_MAX_TOKENS) || 16000;
  // 思考模式会先烧大量 token 做推理；开着思考时抬高输出预算防截断
  const maxTokens = reasoning !== "off" ? Math.max(userMaxTokens, 32000) : userMaxTokens;
  const temperature = env.TALEMATE_TEMPERATURE ? Number(env.TALEMATE_TEMPERATURE) : undefined;
  return {
    provider,
    apiKey: env.TALEMATE_API_KEY || undefined,
    model:
      env.TALEMATE_MODEL ||
      (provider === "anthropic" ? "claude-opus-5" : provider === "openai" ? "gpt-4o" : "mock-1"),
    baseURL: env.TALEMATE_API_BASE || undefined,
    maxTokens,
    reasoning,
    temperature,
  };
}

/** 是否具备可用凭据（mock 不需 key，供离线冒烟） */
export function hasCredentials(cfg: ModelConfig, env = process.env): boolean {
  if (cfg.provider === "mock") return true;
  return Boolean(cfg.apiKey || (cfg.provider === "anthropic" && env.ANTHROPIC_API_KEY));
}
