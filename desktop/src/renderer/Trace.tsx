/**
 * 轨迹：和对话同一份消息，但不折叠过程。
 *
 * 对话视图把"用了 N 步"收成一行——那是给读者看的；排查时要看的是每一步本身：思考全文、
 * 工具入参、工具输出、耗时、错误、halt，以及 `task` 委派到的子会话。
 *
 * 它只读，不改任何状态；路径那格是给"去文件系统里看完整 jsonl"用的。
 */
import { useMemo, useState } from "react";
import type { AskRecord, OpenInfo, RequestDetail, StoredMessage, TraceModel } from "../shared/api";
import { filterTraceRows, traceRows, type TraceFilter, type TraceRow } from "../shared/trace";
import type { LiveItem } from "./Thread";

const FILTERS: { value: TraceFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "tools", label: "工具" },
  { value: "thinking", label: "思考" },
  { value: "errors", label: "错误" },
];

const STATE_LABEL: Record<string, string> = {
  pending: "等待",
  running: "执行中",
  completed: "完成",
  error: "错误",
};

function shortTime(ts?: number): string {
  if (ts === undefined) return "";
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

function preview(text: string, max = 180): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}

/** 工具入参里能认出"派给谁"的，单独提出来——轨迹里最常看的就是这一格。 */
function taskAgentOf(input?: string): string | undefined {
  if (input === undefined) return undefined;
  try {
    const args = JSON.parse(input) as { agent?: unknown };
    return typeof args.agent === "string" ? args.agent : undefined;
  } catch {
    return undefined;
  }
}

/** `task` 的输出里带着子会话 id；抓出来给排查用（子会话不在左栏列表里）。 */
function taskSessionOf(output?: string): string | undefined {
  if (output === undefined) return undefined;
  return /<task\b[^>]*\bsession="([^"]+)"/.exec(output)?.[1];
}

function ToolRow({ row }: { row: TraceRow }) {
  const agent = taskAgentOf(row.input);
  const session = taskSessionOf(row.output);
  return (
    <details className={`trace-row trace-tool${row.state === "error" ? " trace-error" : ""}`}>
      <summary className="trace-summary">
        <span className="trace-tag">工具</span>
        <b className="trace-name">{row.toolName ?? "(未知)"}</b>
        <span className={`trace-state${row.state === "error" ? " bad" : ""}`}>
          {STATE_LABEL[row.state ?? ""] ?? row.state ?? ""}
        </span>
        {row.halt === true && <span className="trace-state halt">halt</span>}
        {agent !== undefined && <span className="trace-sub">子代理 · {agent}</span>}
        <span className="trace-meta">
          seq {row.seq ?? "—"}
          {row.ms === undefined ? "" : ` · ${row.ms} ms`}
          {row.at === undefined ? "" : ` · ${shortTime(row.at)}`}
        </span>
        {row.output !== undefined && <span className="trace-preview">{preview(row.output)}</span>}
      </summary>
      {session !== undefined && (
        <div className="trace-line">
          子会话：<code>{session}</code>
        </div>
      )}
      {row.input !== undefined && (
        <div className="trace-block">
          <div className="trace-label">入参</div>
          <pre className="trace-pre">{row.input}</pre>
        </div>
      )}
      {row.output !== undefined && (
        <div className="trace-block">
          <div className="trace-label">输出</div>
          <pre className="trace-pre">{row.output}</pre>
        </div>
      )}
      {row.error !== undefined && (
        <div className="trace-block">
          <div className="trace-label bad">错误</div>
          <pre className="trace-pre">{row.error}</pre>
        </div>
      )}
      {row.change !== undefined && (
        <div className="trace-line">
          落盘：<code>{row.change.path}</code>（{row.change.kind} · +{row.change.additions} / -{row.change.deletions}）
        </div>
      )}
      {row.ask !== undefined && (
        <div className="trace-line">
          提问：{row.ask.outcome} · {row.ask.questions.length} 题
          {row.ask.answers === undefined ? "" : ` · 已答 ${row.ask.answers.length}`}
        </div>
      )}
    </details>
  );
}

function TextRow({ row }: { row: TraceRow }) {
  const label =
    row.kind === "user" ? "用户" : row.kind === "reasoning" ? "思考" : row.kind === "compaction" ? "压缩" : "正文";
  const text = row.text ?? "";
  return (
    <details className={`trace-row trace-${row.kind}`} open={row.kind === "compaction"}>
      <summary className="trace-summary">
        <span className={`trace-tag ${row.kind}`}>{label}</span>
        <span className="trace-meta">
          seq {row.seq ?? "—"}
          {row.at === undefined ? "" : ` · ${shortTime(row.at)}`}
          {row.finish === undefined ? "" : ` · ${row.finish}`}
        </span>
        <span className="trace-preview">{preview(text)}</span>
      </summary>
      <pre className="trace-pre">{text}</pre>
    </details>
  );
}

function Row({ row }: { row: TraceRow }) {
  return row.kind === "tool" ? <ToolRow row={row} /> : <TextRow row={row} />;
}

/** 实时那一轮：`live` 里的东西还没落盘，轨照样把它按原样铺出来。 */
function LiveRow({ item }: { item: LiveItem }) {
  if (item.kind === "tool") {
    return (
      <div className="trace-row trace-tool trace-live-row">
        <div className="trace-summary">
          <span className="trace-tag">工具</span>
          <b className="trace-name">{item.name}</b>
          {item.preparing === true ? <span className="trace-state">准备中</span> : <span className="trace-state">实时</span>}
          {item.subject !== undefined && <span className="trace-sub">{preview(item.subject, 100)}</span>}
        </div>
        {item.input !== undefined && <pre className="trace-pre">{item.input}</pre>}
        {item.output !== undefined && <pre className="trace-pre">{item.output}</pre>}
      </div>
    );
  }
  if (item.kind === "think") {
    return (
      <div className="trace-row trace-reasoning trace-live-row">
        <div className="trace-summary">
          <span className="trace-tag reasoning">思考</span>
          <span className="trace-state">实时</span>
          <span className="trace-preview">{preview(item.text)}</span>
        </div>
        <pre className="trace-pre">{item.text}</pre>
      </div>
    );
  }
  if (item.kind === "text") {
    return (
      <div className="trace-row trace-text trace-live-row">
        <div className="trace-summary">
          <span className="trace-tag">正文</span>
          <span className="trace-state">实时</span>
        </div>
        <pre className="trace-pre">{item.text}</pre>
      </div>
    );
  }
  if (item.kind === "me") {
    return (
      <div className="trace-row trace-user trace-live-row">
        <div className="trace-summary">
          <span className="trace-tag user">用户</span>
        </div>
        <pre className="trace-pre">{item.text}</pre>
      </div>
    );
  }
  if (item.kind === "note") {
    return <div className="trace-row trace-live-row">{item.text}</div>;
  }
  if (item.kind === "ask") {
    return <AskLine record={item.record} live />;
  }
  if (item.kind === "chapter") {
    return (
      <div className="trace-row trace-live-row">
        稿子：<code>{item.path}</code>（{item.words.toLocaleString()} 字）
      </div>
    );
  }
  return null;
}

function AskLine({ record, live }: { record: AskRecord; live?: boolean }) {
  return (
    <div className="trace-row trace-live-row">
      <span className="trace-tag">提问</span> {record.outcome} · {record.questions.length} 题
      {live === true ? " · 实时" : ""}
    </div>
  );
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

function messageText(message: StoredMessage): string {
  if (message.role === "compaction") return [message.summary, message.recent].filter(Boolean).join("\n\n");
  if (message.role === "assistant") {
    return (message.parts ?? [])
      .map((part) => {
        if (part.type === "text" || part.type === "reasoning") return part.text;
        if (part.type === "tool") {
          return [
            `[tool ${part.name}] ${part.input ?? ""}`,
            part.output === undefined ? "" : `→ ${part.output}`,
          ]
            .filter(Boolean)
            .join("\n");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return message.text ?? "";
}

function RequestDetailView({ detail }: { detail: RequestDetail | null }) {
  if (detail === null) return <div className="trace-line">读不到这一段的请求详情。</div>;
  return (
    <div className="trace-detail">
      <div className="trace-line">
        {detail.config.provider} / {detail.config.model} · temp {detail.config.temperature ?? "—"} · max{" "}
        {detail.config.maxTokens}
        {detail.context?.contextWindow === undefined ? "" : ` · window ${detail.context.contextWindow}`}
      </div>
      {detail.system !== undefined && (
        <details>
          <summary>system · {detail.system.text.length} 字</summary>
          <pre>{detail.system.text}</pre>
        </details>
      )}
      {detail.tools !== undefined && (
        <details>
          <summary>tools · {detail.tools.length} 个</summary>
          <pre>{JSON.stringify(detail.tools, null, 2)}</pre>
        </details>
      )}
      <details open>
        <summary>messages · {detail.messages.length} 条</summary>
        {detail.messages.map((message, i) => {
          const text = messageText(message);
          return (
            <div className="trace-line" key={`${message.seq ?? i}-${i}`}>
              <b className="trace-name">{message.role}</b>
              {message.role === "compaction" ? " · compaction" : ""}
              <pre>{text.length > 4000 ? `${text.slice(0, 4000)}…（截断展示）` : text}</pre>
            </div>
          );
        })}
      </details>
    </div>
  );
}

/** 事件面：turn → step → attempt / tool。正文仍在「消息」面；这里看结构、状态、耗时与 hash。 */
function EventTrace({ model }: { model: TraceModel | null }) {
  const [details, setDetails] = useState<Record<number, RequestDetail | null>>({});

  async function openDetail(seq: number): Promise<void> {
    if (seq in details) return;
    const detail = await window.tm.sessionRequestDetail(seq).catch(() => null);
    setDetails((prev) => ({ ...prev, [seq]: detail }));
  }

  if (model === null) return <p className="note">事件模型读取中…</p>;
  if (model.turns.length === 0) return <p className="note">还没有可看的事件。</p>;
  return (
    <div className="trace-events">
      {model.turns.map((turn) => (
        <details className="trace-row trace-turn" key={turn.index} open>
          <summary className="trace-summary">
            <span className="trace-tag">轮</span>
            <b className="trace-name">#{turn.index + 1}</b>
            <span className={`trace-state${turn.status === "error" || turn.status === "aborted" ? " bad" : ""}`}>
              {turn.status}
            </span>
            <span className="trace-sub">{turn.agent}</span>
            <span className="trace-meta">
              {turn.endedAt === undefined ? "进行中" : `${turn.endedAt - turn.startedAt} ms`}
            </span>
          </summary>
          {turn.error !== undefined && (
            <div className="trace-line">
              <span className="trace-state bad">{turn.error.name}</span>：{turn.error.message}
            </div>
          )}
          {turn.steps.map((step) => (
            <details className="trace-step" key={step.index} open>
              <summary className="trace-summary">
                <span className="trace-tag">步</span>
                <b className="trace-name">{step.index}</b>
                <span className={`trace-state${step.status === "error" || step.status === "interrupted" ? " bad" : ""}`}>
                  {step.status}
                </span>
                {step.finish !== undefined && <span className="trace-sub">{step.finish}</span>}
                {step.usage !== undefined && (
                  <span className="trace-sub">
                    in {step.usage.input} · out {step.usage.output}
                  </span>
                )}
                <span className="trace-meta">{step.durationMs === undefined ? "—" : `${step.durationMs} ms`}</span>
              </summary>
              {step.request !== undefined && (
                <div className="trace-line">
                  prompt <code>{shortHash(step.request.promptHash)}</code> · system{" "}
                  {step.request.systemChars} · tools {step.request.toolsChars} · messages{" "}
                  {step.request.messagesChars} · {step.request.model}
                  {step.requestSeq !== undefined && (
                    <button type="button" className="trace-path" onClick={() => void openDetail(step.requestSeq!)}>
                      请求详情
                    </button>
                  )}
                </div>
              )}
              {step.requestSeq !== undefined && details[step.requestSeq] !== undefined && (
                <RequestDetailView detail={details[step.requestSeq] ?? null} />
              )}
              {step.attempts.map((attempt, i) => (
                <div className="trace-line" key={`a-${i}`}>
                  <span className="trace-state bad">{attempt.outcome}</span> · {attempt.error.message} ·{" "}
                  {attempt.durationMs} ms · 流出 {attempt.streamedChars} 字
                </div>
              ))}
              {step.tools.map((tool) => (
                <div className="trace-line" key={tool.callId}>
                  <b className="trace-name">{tool.name}</b>{" "}
                  <span className={`trace-state${tool.state === "error" ? " bad" : ""}`}>{tool.state}</span> ·
                  in {tool.inputChars} / out {tool.outputChars ?? "—"} · {tool.durationMs ?? "—"} ms
                  {tool.error !== undefined && <span className="trace-state bad"> · {tool.error}</span>}
                  {tool.change !== undefined && <span> · {tool.change.path}</span>}
                </div>
              ))}
            </details>
          ))}
          {turn.tools.map((tool) => (
            <div className="trace-line" key={tool.callId}>
              <b className="trace-name">{tool.name}</b>{" "}
              <span className={`trace-state${tool.state === "error" ? " bad" : ""}`}>{tool.state}</span> ·
              harness 直调 · {tool.durationMs ?? "—"} ms
            </div>
          ))}
          {turn.compactions.map((compaction, i) => (
            <div className="trace-line" key={`c-${i}`}>
              压缩 · {compaction.model ?? "?"} · {compaction.ok === false ? "失败" : "完成"} ·{" "}
              {compaction.durationMs ?? "—"} ms
            </div>
          ))}
        </details>
      ))}
      {model.rewinds.map((rewind, i) => (
        <div className="trace-line" key={`r-${i}`}>
          回退到 seq {rewind.targetSeq}
        </div>
      ))}
    </div>
  );
}

export function Trace({
  history,
  live,
  info,
  model,
}: {
  history: StoredMessage[];
  live: LiveItem[];
  info: OpenInfo | null;
  model: TraceModel | null;
}) {
  const [mode, setMode] = useState<"events" | "messages">("events");
  const [filter, setFilter] = useState<TraceFilter>("all");
  const [copied, setCopied] = useState(false);
  const rows = useMemo(() => traceRows(history), [history]);
  const visible = useMemo(() => filterTraceRows(rows, filter), [rows, filter]);

  async function copyPath(): Promise<void> {
    if (info?.eventsPath === undefined) return;
    try {
      await navigator.clipboard.writeText(info.eventsPath);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用就算了：路径本身在 `/debug` 里也有
    }
  }

  return (
    <div className="trace">
      <div className="trace-bar">
        <div className="trace-filters">
          <button
            type="button"
            className="trace-chip"
            aria-current={mode === "events"}
            onClick={() => setMode("events")}
          >
            事件
          </button>
          <button
            type="button"
            className="trace-chip"
            aria-current={mode === "messages"}
            onClick={() => setMode("messages")}
          >
            消息
          </button>
        </div>
        {mode === "messages" && (
        <div className="trace-filters">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className="trace-chip"
              aria-current={filter === f.value}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
        )}
        <span className="trace-count">
          {mode === "events"
            ? model === null
              ? "读取中"
              : `${model.turns.length} 轮 · ${model.turns.reduce((n, t) => n + t.steps.length, 0)} 步`
            : `${visible.length} / ${rows.length} 条`}
        </span>
        {info?.eventsPath !== undefined && (
          <button type="button" className="trace-path" title={info.eventsPath} onClick={() => void copyPath()}>
            {copied ? "已复制路径" : "复制事件日志路径"}
          </button>
        )}
      </div>

      {mode === "events" ? (
        <EventTrace model={model} />
      ) : (
        <>
          {visible.length === 0 && live.length === 0 && (
            <p className="note">还没有可看的轨迹。发一句话，或切到「对话」。</p>
          )}

          {visible.map((row) => (
            <Row key={row.key} row={row} />
          ))}

          {live.length > 0 && (
            <div className="trace-live">
              <div className="trace-live-head">
                <span className="pulse" />
                本轮（实时，尚未落盘）
              </div>
              {live.map((item, i) => (
                <LiveRow key={`live-${i}`} item={item} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
