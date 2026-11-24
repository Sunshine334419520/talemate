/**
 * 上下文组装：buildSystemPrompt 拼 env 块 + 角色 system + 项目 AGENTS.md（常驻全量）+ skill 清单；
 * toNeutralMessages 把持久化消息窗口（loadModelWindow 之后）转成 provider 无关的 NeutralMsg[]。
 *
 * 作品文档不进 system：模型要靠 `read` / `glob` / `grep` 现取，这样它知道读的是哪一份、哪一节。
 *
 * 存储 → LLM 不是 1:1：折叠记录（role:"context"）渲染成一条 <context-state> user 消息；旧
 * compaction 消息渲染成 <story-state>；一条含工具 part 的 assistant 展开成 assistant(toolCalls)
 * + 每条 completed tool 一条 role:"tool" 结果。
 */
import { today } from "../core/config";
import type { CompactionRecord, StoredMessage } from "../core/types";
import type { NeutralMsg } from "../llm/types";
import { renderEvidenceLine } from "./ledger";
import { renderPinned } from "./project_state";

export function buildSystemPrompt(parts: {
  projectTitle: string;
  agentName: string;
  roleSystem: string;
  rules: string; // AGENTS.md 全文（可为空）
  skills: string; // <available_skills>（可为空）
}): string {
  const blocks: string[] = [];
  const env = `${today()} 作品：${parts.projectTitle} 当前角色：${parts.agentName}`;
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

/**
 * 折叠记录的渲染：`<context-state>` 是"对话投影 + 恢复坐标"，不是第二份 canon。
 *
 * 世界规则、人物卡、章节原文一个字都不进来；需要时按 `<evidence>` 的路径重读。
 */
export function renderContextState(record: CompactionRecord): string {
  const lines: string[] = ["<context-state>"];
  const pinned = renderPinned(record.pinned);
  if (pinned !== "") lines.push(pinned);
  const archive = record.summary.archive?.trim();
  if (archive !== undefined && archive !== "") lines.push(`<archive>\n${archive}\n</archive>`);
  const session = record.summary.session.trim();
  if (session !== "") lines.push(`<session>\n${session}\n</session>`);
  if (record.pinned.decisions.length) {
    const decisions = record.pinned.decisions.map((d) => {
      const what = d.chapter === undefined ? d.proposal : `${d.proposal}（第 ${d.chapter} 章）`;
      return `- ${d.verdict} ${what}${d.note === undefined ? "" : ` — ${d.note}`}`;
    });
    lines.push(`<decisions>\n${decisions.join("\n")}\n</decisions>`);
  }
  if (record.evidence.length) {
    lines.push(`<evidence>\n${record.evidence.map(renderEvidenceLine).join("\n")}\n</evidence>`);
  }
  if (record.summary.open.length) {
    lines.push(
      `<open>\n${record.summary.open.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n</open>`,
    );
  }
  if (record.summary.pointers.length) {
    lines.push(`<pointers>\n${record.summary.pointers.map((p) => `- ${p}`).join("\n")}\n</pointers>`);
  }
  if (record.degraded) {
    lines.push("（这次折叠是确定性降级：只保留了对话原文与指针，没有生成叙事。）");
  }
  lines.push("</context-state>");
  lines.push("（以上是上一段对话的投影。书的事实以项目文件为准；不确定时按上面的路径重读。）");
  return lines.join("\n");
}

export function toNeutralMessages(messages: StoredMessage[]): NeutralMsg[] {
  const out: NeutralMsg[] = [];
  for (const m of messages) {
    switch (m.role) {
      case "context": {
        if (m.context !== undefined) {
          out.push({ role: "user", text: renderContextState(m.context) });
        }
        break;
      }
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
        // DeepSeek 思考模式要求把 assistant 的 reasoning_content 随历史带回；
        // 丢了它，下一轮带 tool_calls 的请求会直接 400。
        const reasoning = parts
          .filter((p): p is Extract<(typeof parts)[number], { type: "reasoning" }> => p.type === "reasoning")
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
          ...(reasoning === "" ? {} : { reasoning }),
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
