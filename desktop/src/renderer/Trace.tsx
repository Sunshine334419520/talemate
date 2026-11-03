/**
 * 轨迹：一张从 canonical 事件折出来的记录表 + 右侧检查器。
 *
 * 界面形状对齐 DSH Trajectory：左侧两列（类型 / 一行摘要），选中一行才在右侧展开详情；
 * 不再用一叠 <details> 卡片，也不分「事件 / 消息」两个模式。system、user、assistant、tool、
 * compaction、attempt、rewind 都是同一张表里的记录。
 */
import { Fragment, useMemo, useState } from "react";
import type {
  AskRecord,
  OpenInfo,
  RequestDetail,
  StoredMessage,
  TrajectoryRecord,
  TrajectoryView,
} from "../shared/api";
import type { LiveItem } from "./Thread";

const KIND_LABEL: Record<TrajectoryRecord["kind"], string> = {
  system: "系统",
  user: "用户",
  assistant: "正文",
  tool: "工具",
  compaction: "压缩",
  attempt: "失败",
  rewind: "回退",
};

const KIND_CLASS: Record<TrajectoryRecord["kind"], string> = {
  system: "system",
  user: "user",
  assistant: "assistant",
  tool: "tool",
  compaction: "compaction",
  attempt: "attempt",
  rewind: "rewind",
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

function preview(text: string, max = 220): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}

function shortTime(ts?: number): string {
  if (ts === undefined) return "";
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

function recordSummary(record: TrajectoryRecord): string {
  if (record.kind === "tool") {
    const result = record.output === undefined ? "" : ` → ${preview(record.output, 120)}`;
    return `${record.input === undefined ? "" : preview(record.input, 90)}${result}`;
  }
  if (record.kind === "compaction") return record.text === undefined ? "" : preview(record.text);
  if (record.kind === "attempt") return record.error ?? record.status ?? "";
  if (record.kind === "rewind") return `回退到 seq ${record.targetSeq ?? "?"}`;
  return record.text === undefined ? (record.reasoning === undefined ? "" : preview(record.reasoning)) : preview(record.text);
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

function RequestDetail({ detail }: { detail: RequestDetail | null | undefined }) {
  if (detail === undefined) return <p className="trace-note">读取请求详情…</p>;
  if (detail === null) return <p className="trace-note">读不到这一段的请求详情。</p>;
  return (
    <div className="trace-request">
      <div className="trace-kv">
        <span>模型</span>
        <b>
          {detail.config.provider} / {detail.config.model}
        </b>
      </div>
      <div className="trace-kv">
        <span>参数</span>
        <b>
          temp {detail.config.temperature ?? "—"} · max {detail.config.maxTokens}
          {detail.context?.contextWindow === undefined ? "" : ` · window ${detail.context.contextWindow}`}
        </b>
      </div>
      {detail.system !== undefined && (
        <details open>
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
      <details>
        <summary>messages · {detail.messages.length} 条</summary>
        {detail.messages.map((message, i) => {
          const text = messageText(message);
          return (
            <div className="trace-message" key={`${message.seq ?? i}-${i}`}>
              <b>{message.role}</b>
              <pre>{text.length > 6000 ? `${text.slice(0, 6000)}…（截断展示）` : text}</pre>
            </div>
          );
        })}
      </details>
    </div>
  );
}

function RecordDetail({
  record,
  requestDetail,
  onRequest,
}: {
  record: TrajectoryRecord;
  requestDetail: RequestDetail | null | undefined;
  onRequest: () => void;
}) {
  return (
    <div className="trace-record-detail">
      <div className="trace-record-title">
        <span className={`trace-kind ${KIND_CLASS[record.kind]}`}>{KIND_LABEL[record.kind]}</span>
        {record.toolName !== undefined && <b>{record.toolName}</b>}
        {record.status !== undefined && <span className="trace-muted">{record.status}</span>}
        {record.step !== undefined && <span className="trace-muted">step {record.step}</span>}
      </div>
      <div className="trace-muted">
        {shortTime(record.at)}
        {record.durationMs === undefined ? "" : ` · ${record.durationMs} ms`}
        {record.seq === undefined ? "" : ` · seq ${record.seq}`}
      </div>

      {(record.kind === "user" || record.kind === "assistant" || record.kind === "system") && record.text !== undefined && (
        <pre className="trace-fulltext">{record.text}</pre>
      )}
      {record.kind === "assistant" && record.reasoning !== undefined && (
        <details open>
          <summary>思考 · {record.reasoning.length} 字</summary>
          <pre>{record.reasoning}</pre>
        </details>
      )}
      {record.kind === "tool" && (
        <>
          {record.input !== undefined && (
            <details open>
              <summary>入参</summary>
              <pre>{record.input}</pre>
            </details>
          )}
          {record.output !== undefined && (
            <details open>
              <summary>输出</summary>
              <pre>{record.output}</pre>
            </details>
          )}
          {record.error !== undefined && (
            <details open>
              <summary>错误</summary>
              <pre>{record.error}</pre>
            </details>
          )}
          {record.change !== undefined && (
            <div className="trace-kv">
              <span>落盘</span>
              <b>
                {record.change.path}（{record.change.kind}）
              </b>
            </div>
          )}
        </>
      )}
      {record.kind === "compaction" && record.text !== undefined && <pre className="trace-fulltext">{record.text}</pre>}
      {record.kind === "attempt" && record.error !== undefined && <pre className="trace-fulltext">{record.error}</pre>}
      {record.kind === "rewind" && <div className="trace-muted">回退到 seq {record.targetSeq ?? "?"}</div>}

      {record.requestSeq !== undefined && (
        <>
          <button type="button" className="trace-detail-button" onClick={onRequest}>
            请求详情
          </button>
          <RequestDetail detail={requestDetail} />
        </>
      )}
    </div>
  );
}

function LiveRow({ item }: { item: LiveItem }) {
  if (item.kind === "tool") {
    return (
      <div className="trace-live-row">
        <span className="trace-kind tool">工具</span>
        <b>{item.name}</b>
        <span className="trace-muted">{item.preparing === true ? "准备中" : "实时"}</span>
        {item.subject !== undefined && <span className="trace-muted">{preview(item.subject, 120)}</span>}
      </div>
    );
  }
  if (item.kind === "think" || item.kind === "text") {
    return (
      <div className="trace-live-row">
        <span className={`trace-kind ${item.kind === "think" ? "system" : "assistant"}`}>
          {item.kind === "think" ? "思考" : "正文"}
        </span>
        <span className="trace-muted">实时</span>
        <span className="trace-live-text">{preview(item.text)}</span>
      </div>
    );
  }
  if (item.kind === "me") {
    return (
      <div className="trace-live-row">
        <span className="trace-kind user">用户</span>
        <span className="trace-live-text">{preview(item.text)}</span>
      </div>
    );
  }
  if (item.kind === "ask") return <AskLine record={item.record} live />;
  if (item.kind === "chapter") {
    return (
      <div className="trace-live-row">
        <span className="trace-kind assistant">稿子</span>
        <code>{item.path}</code>
        <span className="trace-muted">{item.words.toLocaleString()} 字</span>
      </div>
    );
  }
  if (item.kind === "changes") {
    return (
      <div className="trace-live-row">
        <span className="trace-kind tool">改动</span>
        <span className="trace-muted">{item.changes.length} 个文件</span>
      </div>
    );
  }
  if (item.kind === "proposal-done") {
    return (
      <div className="trace-live-row">
        <span className="trace-kind system">提案</span>
        <span className="trace-live-text">{item.title} · {item.verdict}</span>
      </div>
    );
  }
  return (
    <div className="trace-live-row">
      <span className="trace-muted">{item.text}</span>
    </div>
  );
}

function AskLine({ record, live }: { record: AskRecord; live?: boolean }) {
  return (
    <div className="trace-live-row">
      <span className="trace-kind user">提问</span>
      <span className="trace-muted">
        {record.outcome} · {record.questions.length} 题{live === true ? " · 实时" : ""}
      </span>
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
  const [selected, setSelected] = useState<TrajectoryRecord | null>(null);
  const [requestDetails, setRequestDetails] = useState<Record<number, RequestDetail | null>>({});
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

  async function openRequest(seq: number): Promise<void> {
    if (seq in requestDetails) return;
    const detail = await window.tm.sessionRequestDetail(seq).catch(() => null);
    setRequestDetails((prev) => ({ ...prev, [seq]: detail }));
  }

  function selectRecord(record: TrajectoryRecord): void {
    setSelected(record);
    if (record.requestSeq !== undefined) void openRequest(record.requestSeq);
  }

  async function copyPath(): Promise<void> {
    if (info?.eventsPath === undefined) return;
    try {
      await navigator.clipboard.writeText(info.eventsPath);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用就算了
    }
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

      <div className="trace-body">
        <div className="trace-table-wrap">
          {trajectory === null && <p className="trace-note">轨迹读取中…</p>}
          {trajectory !== null && turns.length === 0 && live.length === 0 && (
            <p className="trace-note">还没有可看的轨迹。</p>
          )}
          {turns.length > 0 && (
            <table className="trace-table">
              <colgroup>
                <col className="trace-col-kind" />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th className="trace-col-kind">事件</th>
                  <th>内容</th>
                </tr>
              </thead>
              <tbody>
                {turns.map((turn) => (
                  <Fragment key={turn.index}>
                    <tr className="trace-turn-row">
                      <td colSpan={2}>
                        第 {turn.index + 1} 轮 · {turn.agent} · {turn.status}
                        {turn.endedAt === undefined ? "" : ` · ${turn.endedAt - turn.startedAt} ms`}
                      </td>
                    </tr>
                    {turn.records.map((record) => (
                      <tr
                        key={record.id}
                        className={`trace-record-row${selected?.id === record.id ? " selected" : ""}${record.error !== undefined ? " error" : ""}`}
                        onClick={() => selectRecord(record)}
                        tabIndex={0}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            selectRecord(record);
                          }
                        }}
                      >
                        <td className="trace-kind-cell">
                          <span className={`trace-kind ${KIND_CLASS[record.kind]}`}>{KIND_LABEL[record.kind]}</span>
                        </td>
                        <td className="trace-content-cell">
                          <span className="trace-row-text">
                            {record.toolName !== undefined ? <b>{record.toolName} </b> : null}
                            {recordSummary(record)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}

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

        {selected !== null && (
          <aside className="trace-details" aria-label="记录详情">
            <div className="trace-details-head">
              <span>记录详情</span>
              <button type="button" className="trace-close" onClick={() => setSelected(null)} aria-label="关闭详情">
                ×
              </button>
            </div>
            <RecordDetail
              record={selected}
              requestDetail={selected.requestSeq === undefined ? undefined : requestDetails[selected.requestSeq]}
              onRequest={() => {
                if (selected.requestSeq !== undefined) void openRequest(selected.requestSeq);
              }}
            />
          </aside>
        )}
      </div>
    </div>
  );
}
