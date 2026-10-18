/**
 * 改动清单：对话末尾的「本轮改动」与右栏的历史记录共用同一份分组与行样式。
 *
 * 记录来自 tool part 上的 `WriteChange`；这里只负责画。什么算一份作品文档由目录树给，
 * 所以显示名和先后都从这里传进来的 `labelOf` / `rankOf` 走。
 */
import { useMemo } from "react";
import type { WriteChange } from "../../../src/core/types";
import type { SessionTurnChanges } from "../shared/api";
import { groupChanges, type ChangeRow } from "./changes";

export type ChangeScope = "session" | "book";

/** 行点击：新建/没有 diff 的打开全文；修改/删除看合并 diff。 */
function openChange(
  row: ChangeRow,
  onOpenDoc: (path: string) => void,
  onOpenDiff: (name: string, text: string, path: string) => void,
): void {
  if (row.kind === "created" || row.diff === "") onOpenDoc(row.path);
  else onOpenDiff(row.label, row.diff, row.path);
}

function isCharacter(path: string): boolean {
  return path.startsWith("characters/") || path.includes("/characters/");
}

function chipText(row: ChangeRow): string {
  if (row.kind === "created") return "新建";
  if (row.kind === "deleted") return "已删除";
  return `修改 ${row.count} 处`;
}

function chipClass(row: ChangeRow): string {
  return `change-chip${row.kind === "created" ? " new" : row.kind === "deleted" ? " del" : ""}`;
}

export function ChangeList({
  rows,
  onOpenDoc,
  onOpenDiff,
}: {
  rows: ChangeRow[];
  onOpenDoc: (path: string) => void;
  onOpenDiff: (name: string, text: string, path: string) => void;
}) {
  return (
    <div className="changes-list">
      {rows.map((row) => (
        <button
          key={row.path}
          type="button"
          className="change-row"
          onClick={() => openChange(row, onOpenDoc, onOpenDiff)}
        >
          <span className="change-ico" aria-hidden="true">
            {isCharacter(row.path) ? <PersonIcon /> : <FileIcon />}
          </span>
          <span className="change-main">
            <span className="change-name">{row.label}</span>
            <span className="change-path">{row.path}</span>
          </span>
          <span className={chipClass(row)}>{chipText(row)}</span>
          <span className="change-chev" aria-hidden="true">
            ›
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * 搭档最后一句话下面的那张卡。
 *
 * 只在一轮真的落了文件时出现；同一个文件被改了三次也只占一行。
 */
export function TurnChangesCard({
  changes,
  labelOf,
  rankOf,
  onOpenDoc,
  onOpenDiff,
  onOpenHistory,
}: {
  changes: readonly WriteChange[];
  labelOf: (path: string) => string;
  rankOf: (path: string) => number;
  onOpenDoc: (path: string) => void;
  onOpenDiff: (name: string, text: string, path: string) => void;
  onOpenHistory: () => void;
}) {
  const rows = useMemo(() => groupChanges(changes, labelOf, rankOf), [changes, labelOf, rankOf]);
  if (rows.length === 0) return null;

  return (
    <section className="changes" aria-label="本轮改动">
      <div className="changes-head">
        <span className="changes-title">本轮改动</span>
        <span className="changes-count">{rows.length} 份文档</span>
        <span className="changes-hint">{changes.length} 次写入，已合并 · 点开在右栏看</span>
      </div>
      <ChangeList rows={rows} onOpenDoc={onOpenDoc} onOpenDiff={onOpenDiff} />
      <div className="changes-foot">
        <span>只列作品文档；计划与考据不列出。</span>
        <button className="changes-more" type="button" onClick={onOpenHistory}>
          查看全部改动 →
        </button>
      </div>
    </section>
  );
}

/**
 * 右栏的改动记录：按轮分组的时间线。
 *
 * 范围是「本次会话 / 本书」；数据由主进程按会话聚合，这里只筛与排。
 */
export function ChangeHistory({
  groups,
  currentSessionId,
  scope,
  onScope,
  labelOf,
  rankOf,
  onOpenDoc,
  onOpenDiff,
}: {
  groups: SessionTurnChanges[];
  currentSessionId: string;
  scope: ChangeScope;
  onScope: (scope: ChangeScope) => void;
  labelOf: (path: string) => string;
  rankOf: (path: string) => number;
  onOpenDoc: (path: string) => void;
  onOpenDiff: (name: string, text: string, path: string) => void;
}) {
  const turns = useMemo(
    () =>
      groups
        .filter((g) => scope === "book" || g.sessionId === currentSessionId)
        .map((g) => ({ group: g, rows: groupChanges(g.changes, labelOf, rankOf) }))
        .filter((t) => t.rows.length > 0),
    [groups, scope, currentSessionId, labelOf, rankOf],
  );
  const docs = turns.reduce((n, t) => n + t.rows.length, 0);

  return (
    <div className="history-page">
      <div className="history-head">
        <div className="history-title-row">
          <h1 className="history-title">改动记录</h1>
          <div className="seg" role="tablist" aria-label="改动范围">
            <button
              type="button"
              role="tab"
              aria-selected={scope === "session"}
              className={`seg-btn${scope === "session" ? " active" : ""}`}
              onClick={() => onScope("session")}
            >
              本次会话
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={scope === "book"}
              className={`seg-btn${scope === "book" ? " active" : ""}`}
              onClick={() => onScope("book")}
            >
              本书
            </button>
          </div>
        </div>
      </div>
      <p className="history-meta">
        {turns.length} 轮 · {docs} 份文档
      </p>

      {turns.length === 0 ? (
        <p className="history-empty">
          {scope === "session" ? "这个会话还没有文件改动。" : "这本书还没有文件改动。"}
        </p>
      ) : (
        <div className="history">
          {turns.map(({ group, rows }, i) => (
            <section className="history-group" key={`${group.sessionId}-${group.ts}-${i}`}>
              <div className="history-group-head">
                <span className="history-time">
                  {when(group.ts)} · {group.sessionTitle}
                </span>
                <span className="history-count">
                  {rows.length} 份文档 · {group.changes.length} 次写入
                </span>
              </div>
              {group.user !== "" && <p className="history-turn">“{group.user}”</p>}
              <div className="history-rows">
                <ChangeList rows={rows} onOpenDoc={onOpenDoc} onOpenDiff={onOpenDiff} />
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function when(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === now.toDateString()
    ? `今天 ${hhmm}`
    : `${d.getMonth() + 1}月${d.getDate()}日`;
}

function FileIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <path d="M4 2h5l3 3v9H4z" />
      <path d="M9 2v3h3" />
    </svg>
  );
}

function PersonIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <circle cx="8" cy="5.2" r="2.1" />
      <path d="M3.8 13c.5-2.1 2.1-3.2 4.2-3.2s3.7 1.1 4.2 3.2" />
    </svg>
  );
}
