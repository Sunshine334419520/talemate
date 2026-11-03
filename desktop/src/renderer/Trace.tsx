/**
 * 轨迹：一张从 canonical 事件折出来的记录表。
 *
 * 不再分「事件 / 消息」两个模式——system、user、assistant、tool、compaction、attempt、rewind 都是
 * 同一张表里的记录；内容与耗时/token 在同一行。原始事件日志走 `/trace`，不在这里重复。
 */
import { useMemo, useState } from "react";
import type { AskRecord, OpenInfo, RequestDetail, StoredMessage, TrajectoryRecord, TrajectoryView } from "../shared/api";
import type { LiveItem } from "./Thread";

const KIND_LABEL: Record<string, string> = {
  system: "系统",
  user: "用户",
  assistant: "正文",
  tool: "工具",
  compaction: "压缩",
  attempt: "失败",
  rewind: "回退",
};

const FILTERS: { value: "all" | TrajectoryRecord["kind"] | "error"; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "system", label: "系统" },
  { value: "user", label: "用户" },
  { value: "assistant", label: "正文" },
  { value: "tool", label: "工具" },
  { value: "compaction", label: "压缩" },
  { value: "error", label: "错误" },
];

function shortTime(ts?: number): string {
  if (ts === undefined) return "";
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

function preview(text: string, max = 180): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}

function messageText(message: StoredMessage): string {
  if (message.role === "compaction") return [message.summary, message.recent].filter(Boolean).join("\n\n");
  if (message.role === "assistant") {
    return (message.parts ?? [])
      .map((part) => {
        if (part.type === "text" || part.type === "reasoning") return part.text;
        if (part.type === "tool") {
          return [`[tool ${part.name}] ${part.input ?? ""}`, part.output === undefined ? "" : `→ ${part.output}`]
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

function RecordRow({
  record,
  requestDetail,
  onOpenRequest,
}: {
  record: TrajectoryRecord;
  requestDetail: RequestDetail | null | undefined;
  onOpenRequest: (seq: number) => void;
}) {
  const label = KIND_LABEL[record.kind] ?? record.kind;
  const bodyText = record.text ?? record.reasoning ?? "";
  const summary = [record.toolName, record.error, record.text, record.reasoning].filter(Boolean).join(" · ");
  const failed = record.error !== undefined || record.status === "error" || record.status === "interrupted";

  return (
    <details className={`trace-row trace-${record.kind}${failed ? " trace-error" : ""}`} open={record.kind === "attempt"}>
      <summary className="trace-summary">
        <span className={`trace-tag ${record.kind}`}>{label}</span>
        {record.toolName !== undefined && <b className="trace-name">{record.toolName}</b>}
        {record.status !== undefined && (
          <span className={`trace-state${failed ? " bad" : ""}`}>{record.status}</span>
        )}
        {record.step !== undefined && <span className="trace-sub">step {record.step}</span>}
        <span className="trace-meta">
          {record.at === undefined ? "" : shortTime(record.at)}
          {record.durationMs === undefined ? "" : ` · ${record.durationMs} ms`}
          {record.seq === undefined ? "" : ` · seq ${record.seq}`}
        </span>
        {summary !== "" && <span className="trace-preview">{preview(summary)}</span>}
      </summary>

      {record.kind === "system" && record.text !== undefined && <pre className="trace-pre">{record.text}</pre>}
      {(record.kind === "user" || record.kind === "assistant") && bodyText !== "" && (
        <pre className="trace-pre">{record.kind === "assistant" && record.reasoning !== undefined && record.text === undefined ? record.reasoning : bodyText}</pre>
      )}
      {record.kind === "assistant" && record.text !== undefined && record.reasoning !== undefined && (
        <details>
          <summary className="trace-line">思考 · {record.reasoning.length} 字</summary>
          <pre className="trace-pre">{record.reasoning}</pre>
        </details>
      )}
      {record.kind === "tool" && (
        <>
          {record.input !== undefined && (
            <div className="trace-block">
              <div className="trace-label">入参</div>
              <pre className="trace-pre">{record.input}</pre>
            </div>
          )}
          {record.output !== undefined && (
            <div className="trace-block">
              <div className="trace-label">输出</div>
              <pre className="trace-pre">{record.output}</pre>
            </div>
          )}
          {record.error !== undefined && (
            <div className="trace-block">
              <div className="trace-label bad">错误</div>
              <pre className="trace-pre">{record.error}</pre>
            </div>
          )}
          {record.change !== undefined && (
            <div className="trace-line">
              落盘：<code>{record.change.path}</code>（{record.change.kind}）
            </div>
          )}
        </>
      )}
      {record.kind === "compaction" && (
        <div className="trace-line">
          {record.model ?? ""} · {record.durationMs ?? "—"} ms
          {record.text !== undefined && <pre className="trace-pre">{record.text}</pre>}
        </div>
      )}
      {record.kind === "attempt" && record.error !== undefined && (
        <div className="trace-block">
          <div className="trace-label bad">错误</div>
          <pre className="trace-pre">{record.error}</pre>
        </div>
      )}
      {record.kind === "rewind" && <div className="trace-line">回退到 seq {record.targetSeq ?? "?"}</div>}
      {record.requestSeq !== undefined && (
        <>
          <button type="button" className="trace-path" onClick={() => onOpenRequest(record.requestSeq!)}>
            请求详情
          </button>
          {requestDetail !== undefined && <RequestDetailView detail={requestDetail} />}
        </>
      )}
    </details>
  );
}

function LiveRow({ item }: { item: LiveItem }) {
  if (item.kind === "tool") {
    return (
      <div className="trace-row trace-tool trace-live-row">
        <div className="trace-summary">
          <span className="trace-tag">工具</span>
          <b className="trace-name">{item.name}</b>
          <span className="trace-state">{item.preparing === true ? "准备中" : "实时"}</span>
          {item.subject !== undefined && <span className="trace-sub">{preview(item.subject, 100)}</span>}
        </div>
        {item.input !== undefined && <pre className="trace-pre">{item.input}</pre>}
        {item.output !== undefined && <pre className="trace-pre">{item.output}</pre>}
      </div>
    );
  }
  if (item.kind === "think" || item.kind === "text") {
    return (
      <div className={`trace-row trace-${item.kind === "think" ? "reasoning" : "text"} trace-live-row`}>
        <div className="trace-summary">
          <span className="trace-tag">{item.kind === "think" ? "思考" : "正文"}</span>
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
  if (item.kind === "ask") return <AskLine record={item.record} live />;
  if (item.kind === "chapter") {
    return (
      <div className="trace-row trace-live-row">
        稿子：<code>{item.path}</code>（{item.words.toLocaleString()} 字）
      </div>
    );
  }
  if (item.kind === "changes") {
    return <div className="trace-row trace-live-row">本轮改动 {item.changes.length} 个文件</div>;
  }
  if (item.kind === "proposal-done") {
    return (
      <div className="trace-row trace-live-row">
        提案 · {item.title} · {item.verdict}
      </div>
    );
  }
  return <div className="trace-row trace-live-row">{item.text}</div>;
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
  live,
  info,
  trajectory,
}: {
  live: LiveItem[];
  info: OpenInfo | null;
  trajectory: TrajectoryView | null;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["value"]>("all");
  const [details, setDetails] = useState<Record<number, RequestDetail | null>>({});
  const [copied, setCopied] = useState(false);

  const turns = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (trajectory?.turns ?? [])
      .map((turn) => ({
        ...turn,
        records: turn.records.filter((record) => {
          if (filter === "error") {
            if (record.error === undefined && record.status !== "error" && record.status !== "interrupted") return false;
          } else if (filter !== "all" && record.kind !== filter) {
            return false;
          }
          if (q === "") return true;
          return [record.text, record.reasoning, record.toolName, record.input, record.output, record.error]
            .filter((value): value is string => typeof value === "string")
            .some((value) => value.toLowerCase().includes(q));
        }),
      }))
      .filter((turn) => turn.records.length > 0);
  }, [filter, query, trajectory]);

  const count = turns.reduce((n, turn) => n + turn.records.length, 0);

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

  async function openRequest(seq: number): Promise<void> {
    if (seq in details) return;
    const detail = await window.tm.sessionRequestDetail(seq).catch(() => null);
    setDetails((prev) => ({ ...prev, [seq]: detail }));
  }

  return (
    <div className="trace">
      <div className="trace-bar">
        <input
          className="trace-search"
          value={query}
          placeholder="搜索轨迹"
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="trace-filters">
          {FILTERS.map((entry) => (
            <button
              key={entry.value}
              type="button"
              className="trace-chip"
              aria-current={filter === entry.value}
              onClick={() => setFilter(entry.value)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <span className="trace-count">{count} 条</span>
        {info?.eventsPath !== undefined && (
          <button type="button" className="trace-path" title={info.eventsPath} onClick={() => void copyPath()}>
            {copied ? "已复制路径" : "复制事件日志路径"}
          </button>
        )}
      </div>

      {trajectory === null && <p className="note">轨迹读取中…</p>}
      {trajectory !== null && turns.length === 0 && live.length === 0 && <p className="note">还没有可看的轨迹。</p>}

      {turns.map((turn) => (
        <section className="trace-turn" key={turn.index}>
          <div className="trace-turn-head">
            第 {turn.index + 1} 轮 · {turn.agent} · {turn.status}
            {turn.endedAt === undefined ? "" : ` · ${turn.endedAt - turn.startedAt} ms`}
          </div>
          {turn.records.map((record) => (
            <RecordRow
              key={record.id}
              record={record}
              requestDetail={record.requestSeq === undefined ? undefined : details[record.requestSeq]}
              onOpenRequest={(seq) => void openRequest(seq)}
            />
          ))}
        </section>
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
