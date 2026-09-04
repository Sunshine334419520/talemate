/**
 * 配置与路径解析。
 * - TALEMATE_HOME：受管根目录（默认 ~/.talemate），其下 novels/<project-id> 一小说一目录。
 * - 模型配置沿用现有环境变量（TALEMATE_PROVIDER/MODEL/REASONING/MAX_TOKENS/…），兼容已有 .env。
 */
import { homedir } from "node:os";
import { join } from "node:path";
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

/** 项目目录与内部结构 */
export function projectPaths(home: string, projectId: string) {
  const root = join(home, "novels", projectId);
  return {
    root,
    meta: join(root, "talemate.json"),
    agents: join(root, "AGENTS.md"),
    docs: join(root, "docs"),
    chapters: join(root, "chapters"),
    skills: join(root, "skills"),
    sessions: join(root, ".talemate", "sessions"),
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
