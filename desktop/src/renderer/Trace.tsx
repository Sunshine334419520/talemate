/**
 * 轨迹：和对话同一份消息，但不折叠过程。
 *
 * 对话视图把"用了 N 步"收成一行——那是给读者看的；排查时要看的是每一步本身：思考全文、
 * 工具入参、工具输出、耗时、错误、halt，以及 `task` 委派到的子会话。
 *
 * 它只读，不改任何状态；路径那格是给"去文件系统里看完整 jsonl"用的。
 */
import { useMemo, useState } from "react";
import type { AskRecord, OpenInfo, StoredMessage } from "../shared/api";
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

export function Trace({
  history,
  live,
  info,
}: {
  history: StoredMessage[];
  live: LiveItem[];
  info: OpenInfo | null;
}) {
  const [filter, setFilter] = useState<TraceFilter>("all");
  const [copied, setCopied] = useState(false);
  const rows = useMemo(() => traceRows(history), [history]);
  const visible = useMemo(() => filterTraceRows(rows, filter), [rows, filter]);

  async function copyPath(): Promise<void> {
    if (info?.messagesPath === undefined) return;
    try {
      await navigator.clipboard.writeText(info.messagesPath);
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
        <span className="trace-count">
          {visible.length} / {rows.length} 条
        </span>
        {info?.messagesPath !== undefined && (
          <button type="button" className="trace-path" title={info.messagesPath} onClick={() => void copyPath()}>
            {copied ? "已复制路径" : "复制会话文件路径"}
          </button>
        )}
      </div>

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
    </div>
  );
}
