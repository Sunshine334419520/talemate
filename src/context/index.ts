/**
 * 上下文组装：
 * 1) buildSystemPrompt：env 块 + 角色 system + 项目 AGENTS.md(常驻全量) + skill 目录清单
 * 2) toNeutralMessages：把持久化消息窗口（loadModelWindow 之后）转成 LLM NeutralMsg[]。
 *
 * 存储→LLM 映射规则：
 * - compaction 消息 → 一条 <story-state> 前情摘要 user 消息
 * - user → user
 * - assistant：单条存储消息 = 一次模型回复。若含工具 part，展开为
 *     assistant(toolCalls) + 每条 completed tool 一条 role:"tool" 结果消息
 */
import type { StoredMessage } from "../core/types";
import type { NeutralMsg } from "../llm";

export function buildSystemPrompt(parts: {
  projectTitle: string;
  agentName: string;
  roleSystem: string;
  rules: string; // AGENTS.md 全文（可为空）
  skills: string; // <available_skills>（可为空）
}): string {
  const blocks: string[] = [];
  const env = `${new Date().toISOString().slice(0, 10)} 作品：${parts.projectTitle} 当前角色：${parts.agentName}`;
  blocks.push(env);
  blocks.push(parts.roleSystem);
  if (parts.rules) blocks.push(`Instructions from: AGENTS.md\n${parts.rules}`);
  if (parts.skills) {
    blocks.push(
      "Skills provide specialized instructions and workflows. Use a skill tool to load one when a task matches its description.\n" +
        parts.skills,
    );
  }
  return blocks.join("\n\n");
}

export function toNeutralMessages(messages: StoredMessage[]): NeutralMsg[] {
  const out: NeutralMsg[] = [];
  for (const m of messages) {
    switch (m.role) {
      case "compaction": {
        const recent = m.recent ? `\n<recent>\n${m.recent}\n</recent>` : "";
        out.push({
          role: "user",
          text: `<story-state>\n<summary>\n${m.summary ?? ""}\n</summary>${recent}\n</story-state>\n（以上是前情摘要。请基于它继续，不要重复已发生的事。）`,
        });
        break;
      }
      case "user":
        out.push({ role: "user", text: m.text ?? "" });
        break;
      case "assistant": {
        const parts = m.parts ?? [];
        const text = parts
          .filter((p): p is Extract<(typeof parts)[number], { type: "text" }> => p.type === "text")
          .map((p) => p.text)
          .join("");
        const toolParts = parts.filter((p) => p.type === "tool");
        const toolCalls = toolParts.map((p) => ({
          id: p.id,
          name: p.name,
          input: (p.input ? safeJson(p.input) : {}) as Record<string, unknown>,
        }));
        out.push({
          role: "assistant",
          text: text || undefined,
          toolCalls: toolCalls.length ? toolCalls : undefined,
        });
        // tool 结果：只回放已完成/出错的
        for (const p of toolParts) {
          if (p.state === "completed" && p.output !== undefined) {
            out.push({ role: "tool", toolCallId: p.id, name: p.name, output: p.output });
          } else if (p.state === "error") {
            out.push({
              role: "tool",
              toolCallId: p.id,
              name: p.name,
              output: `[工具执行失败] ${p.error ?? "未知错误"}`,
            });
          }
        }
        break;
      }
    }
  }
  return out;
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
