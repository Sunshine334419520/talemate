/**
 * 提案卡：和 ask / confirm 一样占住输入框的“门”，区别是它没有超时——用户必须拍板。
 *
 * 打开时输入框让位，用户只能在卡里接受 / 拒绝 / 提意见（提意见的输入框就在卡内）。
 * 拍板后卡片关闭、输入框回来，对话里留一条只读记录，点开还能回看当时的完整提案。
 * 判定仍然在 harness：按钮只替用户说固定短语，提意见就是用户自己写的那段话。
 */
import { useState } from "react";
import type { ProposalDisplay } from "../shared/api";
import { VERDICT_TEXT } from "../shared/verdict";
import { Markdown } from "./Markdown";

export type ProposalVerdict = "accept" | "reject" | "refine";

/** 提案正文的只读渲染：卡片和回看记录共用，避免两处 markdown/标记各写一套。 */
function ProposalContent({ view }: { view: ProposalDisplay }) {
  return (
    <>
      {view.warning !== undefined && <p className="note zhu proposal-warning">{view.warning}</p>}
      {view.previousNote !== undefined && <p className="proposal-note">{view.previousNote}</p>}

      {view.loose !== undefined && (
        <section className="proposal-section">
          <div className="proposal-section-head">
            <span className="proposal-section-title">开头</span>
            {view.looseChanged === true && <span className="proposal-badge">本版改动</span>}
          </div>
          <Markdown text={view.loose} className="md proposal-md" />
        </section>
      )}

      {view.body !== undefined && (
        <Markdown text={view.body} className="md proposal-md proposal-whole" />
      )}

      {view.sections.map((s) => {
        // 整篇兜底那一格叫「全文」；标题已经在卡头，别再画一个“全文”小节头
        const whole = s.heading === "全文";
        return (
          <section className="proposal-section" key={s.heading}>
            {(!whole || s.changed || s.blank) && (
              <div className="proposal-section-head">
                {!whole && <span className="proposal-section-title">{s.heading}</span>}
                {s.changed && <span className="proposal-badge">本版改动</span>}
                {s.blank && <span className="proposal-badge muted">待定</span>}
              </div>
            )}
            {!s.blank && <Markdown text={s.body} className="md proposal-md" />}
          </section>
        );
      })}

      {view.blankNote !== undefined && <p className="proposal-blank-note">{view.blankNote}</p>}
    </>
  );
}

export function ProposalCard({
  text,
  view,
  onVerdict,
}: {
  text: string;
  view?: ProposalDisplay;
  onVerdict: (text: string, kind: ProposalVerdict) => void;
}) {
  const [refining, setRefining] = useState(false);
  const [note, setNote] = useState("");

  function accept(): void {
    onVerdict(VERDICT_TEXT.accept, "accept");
  }

  function reject(): void {
    onVerdict(VERDICT_TEXT.reject, "reject");
  }

  function refine(): void {
    const value = note.trim();
    if (value === "") return;
    onVerdict(value, "refine");
  }

  const actions = refining ? (
    <div className="proposal-refine">
      <input
        autoFocus
        placeholder="要改哪里？"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") {
            e.preventDefault();
            refine();
          }
        }}
      />
      <button type="button" className="ask-btn primary" onClick={refine}>
        提
      </button>
      <button type="button" className="ask-btn" onClick={() => setRefining(false)}>
        算了
      </button>
    </div>
  ) : (
    <div className="ask-actions">
      <span className="ask-grow" />
      <button type="button" className="ask-btn" onClick={() => setRefining(true)}>
        提意见…
      </button>
      <button type="button" className="ask-btn zhu" onClick={reject}>
        拒绝
      </button>
      <button type="button" className="ask-btn primary" onClick={accept}>
        接受
      </button>
    </div>
  );

  // 没有结构化视图时退回终端文本：旧事件/旧会话仍能看，不把卡片整个丢掉
  if (view === undefined) {
    return (
      <section className="ask-sheet proposal-sheet" aria-label="提案">
        <header className="proposal-head">
          <div className="proposal-eyebrow">有一份要你拍板的东西</div>
        </header>
        <div className="proposal-body">
          <pre className="proposal">{text}</pre>
        </div>
        <footer className="ask-sheet-foot">{actions}</footer>
      </section>
    );
  }

  return (
    <section className="ask-sheet proposal-sheet" aria-label="提案">
      <header className="proposal-head">
        <div className="proposal-eyebrow">有一份要你拍板的东西</div>
        <div className="proposal-title">{view.title}</div>
        {view.subtitle !== undefined && <div className="proposal-sub">{view.subtitle}</div>}
      </header>

      <div className="proposal-body">
        <ProposalContent view={view} />
      </div>

      <footer className="ask-sheet-foot">{actions}</footer>
    </section>
  );
}

const VERDICT_LABEL: Record<ProposalVerdict, string> = {
  accept: "已接受",
  reject: "已拒绝",
  refine: "已提意见",
};

/**
 * 拍板后的只读记录。卡片关掉之后，用户仍然能点开回看当时的完整提案；
 * 默认收起，避免在对话里再占一大块。
 */
export function ProposalRecord({
  title,
  text,
  view,
  verdict,
}: {
  title: string;
  text: string;
  view?: ProposalDisplay;
  verdict: ProposalVerdict;
}) {
  const [open, setOpen] = useState(false);
  const icon = verdict === "reject" ? "×" : verdict === "refine" ? "…" : "✓";

  return (
    <div className="ask-history">
      <button
        type="button"
        className="ask-history-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className={`ask-history-check${verdict === "reject" ? " cancelled" : ""}`}
          aria-hidden="true"
        >
          {icon}
        </span>
        <span>提案 · {title}</span>
        <span className="ask-history-sub">{VERDICT_LABEL[verdict]}</span>
        <span className="ask-history-chev">{open ? "⌄" : "›"}</span>
      </button>
      {open && (
        <div className="proposal-record-body">
          {view === undefined ? <pre className="proposal">{text}</pre> : <ProposalContent view={view} />}
        </div>
      )}
    </div>
  );
}
