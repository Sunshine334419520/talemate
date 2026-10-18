/**
 * 提问卡片：底部弹窗（占住输入框的位置）+ 收起后的提示条 + 只读回看卡。
 *
 * 这一层只负责“怎么问”：分页、选项、自定义、跳过、倒计时显示、草稿。
 * 答案合不合法、超时算不算同意、回答走哪条路，全在 harness（session/asks.ts 与主进程）——
 * 界面不替用户点头，也不把沉默翻译成答案。
 */
import { useEffect, useRef, useState } from "react";
import type {
  AskAnswer,
  AskPendingReason,
  AskQuestion,
  AskRecord,
  AskView,
} from "../shared/api";
import { isRecommended, stripRecommended } from "../../../src/session/asks";
import {
  EMPTY_DRAFT,
  draftKey,
  hasDraftIn,
  initialDrafts,
  loadDraft,
  removeDraft,
  saveDraft,
  type Draft,
  type SavedDraft,
} from "./ask_draft";
import { PencilIcon } from "./icons";
import { Markdown } from "./Markdown";

function fmt(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function reasonText(reason: AskPendingReason | undefined): string {
  if (reason === "deferred") return "已稍后";
  if (reason === "interrupted") return "已中断";
  if (reason === "restarted") return "上次没答完";
  return "已超时";
}

/**
 * 只读回看卡。两种来源共用：tool part 的 `ask` 记录（同一回合答完），
 * 或用户消息的 `answersTo`（pending 之后补答）。两者都带问题原文，所以压缩后也画得出来。
 */
export function AskHistory({
  record,
  questions,
  answers,
  defaultOpen = true,
}: {
  record?: AskRecord;
  questions?: AskQuestion[];
  answers?: AskAnswer[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const qs = record?.questions ?? questions ?? [];
  const as = record?.answers ?? answers ?? [];
  const outcome = record?.outcome ?? "answered";
  const cancelled = outcome === "cancelled";
  const pending = outcome === "pending";
  const byId = new Map(as.map((a) => [a.id, a]));
  const label = pending ? "提问 · 等待回答" : cancelled ? "提问 · 已取消" : "提问 · 已回答";

  return (
    <div className="ask-history">
      <button
        type="button"
        className="ask-history-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`ask-history-check${cancelled ? " cancelled" : ""}`} aria-hidden="true">
          {cancelled ? "×" : pending ? "?" : "✓"}
        </span>
        <span>{label}</span>
        <span className="ask-history-sub">{qs.length} 个问题</span>
        <span className="ask-history-chev">{open ? "⌄" : "›"}</span>
      </button>
      {open && (
        <div className="ask-history-body">
          {cancelled && <p className="ask-history-note">这次提问被取消，没有答案。</p>}
          {qs.map((q) => {
            const a = byId.get(q.id);
            const skipped = a === undefined || (a.selected.length === 0 && (a.custom ?? "").trim() === "");
            return (
              <div className="ask-history-q" key={q.id}>
                <div className="ask-history-qtext">
                  <Markdown text={q.question} />
                </div>
                <div className="ask-history-a">
                  {pending ? (
                    <span className="ask-skip">还没有回答</span>
                  ) : cancelled ? (
                    <span className="ask-skip">没有回答</span>
                  ) : skipped ? (
                    <span className="ask-skip">当时跳过</span>
                  ) : (
                    <>
                      {a.selected.map((s) => (
                        <span className="ask-pick" key={s}>
                          {stripRecommended(s)}
                        </span>
                      ))}
                      {(a.custom ?? "").trim() !== "" && (
                        <span className="ask-pick custom">{(a.custom ?? "").trim()}</span>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function AskDock({
  view,
  sessionId,
  hidden,
  onHidden,
  onSubmit,
  onHold,
}: {
  view: AskView;
  sessionId: string;
  hidden: boolean;
  onHidden: (hidden: boolean) => void;
  onSubmit: (answers: AskAnswer[]) => Promise<"ok" | "stale" | "invalid" | "queued">;
  onHold: (mode: "pause" | "resume" | "hold" | "defer") => void;
}) {
  const key = draftKey(sessionId, view.callId);
  const initialRef = useRef<SavedDraft | null | undefined>(undefined);
  if (initialRef.current === undefined) initialRef.current = loadDraft(localStorage, key) ?? null;
  const initial = initialRef.current;

  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    initialDrafts(view.questions, initial?.answers),
  );
  const [page, setPage] = useState(() => {
    const p = initial?.page ?? 0;
    return p >= 0 && p < view.questions.length ? p : 0;
  });
  const [held, setHeld] = useState(initial?.held === true);
  const [pending, setPending] = useState(view.pending);
  const [reason, setReason] = useState<AskPendingReason | undefined>(view.reason);
  const [deadline, setDeadline] = useState<number | undefined>(view.deadline);
  const [pausedRemaining, setPausedRemaining] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  /** 已排队的迟到回答：主进程会在这一轮结束后送达，别让用户重复提交。 */
  const [sent, setSent] = useState(false);
  const customRef = useRef<HTMLTextAreaElement>(null);
  /** 单选点击后的自动前进。手动翻页/跳过必须先清掉它，否则会连着跳两页。 */
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 主进程说“已经 pending”时以它为准：reason 决定措辞，问题本身仍然可答
  useEffect(() => {
    setPending(view.pending);
    setReason(view.reason);
    if (view.pending) setDeadline(undefined);
  }, [view.pending, view.reason]);

  useEffect(() => {
    setDeadline(view.deadline);
  }, [view.deadline]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => {
      clearInterval(t);
      if (advanceTimer.current !== null) clearTimeout(advanceTimer.current);
    };
  }, []);

  useEffect(() => {
    if (pending || held || pausedRemaining !== null || deadline === undefined) return;
    if (now >= deadline) {
      setPending(true);
      setReason("timeout");
    }
  }, [now, pending, held, pausedRemaining, deadline]);

  useEffect(() => {
    saveDraft(localStorage, key, { page, answers: drafts, hidden, held });
  }, [key, page, drafts, hidden, held]);

  // 刷新/重开同一会话时恢复收起状态；卡片按 callId 重新挂载，所以只跑一次
  useEffect(() => {
    if (initial?.hidden === true) onHidden(true);
    // eslint 没有配置；这里故意只依赖首次挂载的 initial
  }, []);

  const q = view.questions[page];
  const d = drafts[q.id] ?? EMPTY_DRAFT;
  const total = view.questions.length;
  const last = page === total - 1;
  const allDrafted = view.questions.every((x) => hasDraftIn(drafts, x.id));
  const currentDraft = drafts[q.id] ?? EMPTY_DRAFT;

  function go(next: number): void {
    if (advanceTimer.current !== null) {
      clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
    setPage(Math.max(0, Math.min(next, total - 1)));
  }

  useEffect(() => {
    const el = customRef.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 92)}px`;
  }, [currentDraft.custom, page, hidden]);

  const updateDraft = (id: string, patch: Partial<Draft>): void => {
    setDrafts((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? EMPTY_DRAFT), ...patch },
    }));
  };

  function nextDraftsFor(label: string): Record<string, Draft> {
    if (q.multiSelect === true) {
      const selected = d.selected.includes(label)
        ? d.selected.filter((x) => x !== label)
        : [...d.selected, label];
      return { ...drafts, [q.id]: { ...d, selected, skipped: false } };
    }
    return { ...drafts, [q.id]: { ...d, selected: [label], custom: "", skipped: false } };
  }

  function buildAnswers(map: Record<string, Draft>): AskAnswer[] {
    return view.questions.map((x) => {
      const xd = map[x.id] ?? EMPTY_DRAFT;
      if (xd.skipped) return { id: x.id, selected: [] };
      const custom = xd.custom.trim();
      const selected = x.multiSelect === true ? xd.selected : custom !== "" ? [] : xd.selected;
      return { id: x.id, selected, ...(custom === "" ? {} : { custom }) };
    });
  }

  function submitWith(map: Record<string, Draft>): void {
    if (busy) return;
    setBusy(true);
    void onSubmit(buildAnswers(map))
      .then((verdict) => {
        setBusy(false);
        if (verdict === "ok" || verdict === "stale") removeDraft(localStorage, key);
        if (verdict === "queued") setSent(true);
      })
      .catch(() => setBusy(false));
  }

  function submit(): void {
    if (!allDrafted) {
      const i = view.questions.findIndex((x) => !hasDraftIn(drafts, x.id));
      if (i >= 0) go(i);
      return;
    }
    submitWith(drafts);
  }

  function jumpToFirstUndrafted(map: Record<string, Draft>): void {
    const i = view.questions.findIndex((x) => !hasDraftIn(map, x.id));
    if (i >= 0) go(i);
  }

  function selectOption(label: string, viaKeyboard: boolean): void {
    if (advanceTimer.current !== null) {
      clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
    const next = nextDraftsFor(label);
    setDrafts(next);
    if (viaKeyboard) {
      // 键盘 Enter：整批都有草稿就提交；否则跳到第一道还没答的题
      if (view.questions.every((x) => hasDraftIn(next, x.id))) submitWith(next);
      else jumpToFirstUndrafted(next);
      return;
    }
    if (q.multiSelect !== true && !last) {
      advanceTimer.current = setTimeout(() => {
        advanceTimer.current = null;
        setPage((p) => Math.min(p + 1, total - 1));
      }, 160);
    }
  }

  function toggleSkip(): void {
    if (advanceTimer.current !== null) {
      clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
    const skipping = !d.skipped;
    updateDraft(q.id, {
      skipped: skipping,
      selected: skipping ? [] : d.selected,
      custom: skipping ? "" : d.custom,
    });
    if (skipping && !last) {
      advanceTimer.current = setTimeout(() => {
        advanceTimer.current = null;
        setPage((p) => Math.min(p + 1, total - 1));
      }, 140);
    }
  }

  function forward(): void {
    if (last) {
      submit();
      return;
    }
    if (!hasDraftIn(drafts, q.id)) return;
    go(page + 1);
  }

  /**
   * 收起：只折成提示条，不提交。焦点在卡片上时倒计时会暂停，收起必须把它接回来——
   * 否则卡片一折，主进程的计时器就永远停在暂停状态。
   */
  function hide(): void {
    if (pausedRemaining !== null && !held && !pending) {
      setDeadline(Date.now() + pausedRemaining);
      setPausedRemaining(null);
      onHold("resume");
    }
    onHidden(true);
  }

  function slowDown(): void {
    setHeld(true);
    setPausedRemaining(null);
    setDeadline(undefined);
    onHold("hold");
  }

  function defer(): void {
    setPending(true);
    setReason("deferred");
    setHeld(false);
    setPausedRemaining(null);
    setDeadline(undefined);
    onHold("defer");
  }

  function onFocusCapture(): void {
    if (pending || held || pausedRemaining !== null || deadline === undefined) return;
    setPausedRemaining(Math.max(0, deadline - Date.now()));
    onHold("pause");
  }

  function onBlurCapture(e: React.FocusEvent<HTMLElement>): void {
    const next = e.relatedTarget;
    if (next instanceof Node && e.currentTarget.contains(next)) return;
    if (pausedRemaining === null) return;
    setDeadline(Date.now() + pausedRemaining);
    setPausedRemaining(null);
    onHold("resume");
  }

  function onCardKeyDown(e: React.KeyboardEvent<HTMLElement>): void {
    if (e.nativeEvent.isComposing) return;
    // 文本输入里方向键是在移动光标；只有 Esc 还归卡片
    const inTextarea = e.target instanceof HTMLTextAreaElement;
    if (inTextarea && e.key !== "Escape") return;
    if (e.key === "Escape") {
      e.preventDefault();
      hide();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const options = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>(".ask-opt"));
    if (options.length === 0) return;
    const active = document.activeElement;
    const current = options.findIndex((o) => o === active);
    const next =
      current < 0
        ? e.key === "ArrowDown"
          ? 0
          : options.length - 1
        : (current + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    e.preventDefault();
    options[next].focus();
  }

  const reasonLabel = reasonText(reason);
  const note = pending ? (
    <span className="ask-note-pending">{reasonLabel}。你现在回答，会作为一条新消息发给搭档。</span>
  ) : held ? (
    <>
      不限时。搭档会一直等你。
      {" · "}
      <button type="button" className="ask-link" onClick={defer}>
        稍后回答
      </button>
    </>
  ) : pausedRemaining !== null ? (
    <>
      已暂停（你正在看这道题），移开光标后继续计时。
      {" · "}
      <button type="button" className="ask-link" onClick={defer}>
        稍后回答
      </button>
    </>
  ) : deadline !== undefined ? (
    <>
      {fmt(deadline - now)} 后自动继续 ·{" "}
      <button type="button" className="ask-link" onClick={slowDown}>
        慢慢回答
      </button>
      {" · "}
      <button type="button" className="ask-link" onClick={defer}>
        稍后回答
      </button>
    </>
  ) : (
    <>
      不限时。搭档会一直等你。
      {" · "}
      <button type="button" className="ask-link" onClick={defer}>
        稍后回答
      </button>
    </>
  );

  if (hidden) {
    const time = pending ? reasonLabel : held || deadline === undefined ? "不限时" : fmt(deadline - now);
    return (
      <button type="button" className="ask-pill" onClick={() => onHidden(false)} aria-label="打开提问">
        <span className="ask-pill-q" aria-hidden="true">
          ?
        </span>
        <span className="ask-pill-main">搭档在等你回答 · {total} 个问题</span>
        <span className="ask-pill-time">{time}</span>
        <span className="ask-pill-open">打开</span>
      </button>
    );
  }

  const forwardDisabled = last ? !allDrafted : !hasDraftIn(drafts, q.id);
  const forwardLabel = last ? (pending ? "回答（作为新消息）" : "提交") : "下一题";

  return (
    <section
      className="ask-sheet"
      aria-label="搭档的提问"
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
      onKeyDown={onCardKeyDown}
    >
      <header className="ask-sheet-head">
        <span className="ask-eyebrow">{q.header ?? "需要你定一下"}</span>
        <span className={`ask-status${pending ? " pending" : ""}`}>
          {page + 1} / {total}
          {pending ? ` · ${reasonLabel}` : ""}
        </span>
        <button
          type="button"
          className="ask-collapse"
          title="收起（不会提交）"
          aria-label="收起提问"
          onClick={hide}
        >
          ⌄
        </button>
      </header>

      <div className="ask-body">
        <div className="ask-q">
          <Markdown text={q.question} />
        </div>
        <div className="ask-options">
          {(q.options ?? []).map((o, i) => {
            const on = d.selected.includes(o.label);
            const multi = q.multiSelect === true;
            return (
              <button
                type="button"
                key={o.label}
                className={`ask-opt${on ? " on" : ""}`}
                role={multi ? "checkbox" : "radio"}
                aria-checked={on}
                onClick={() => selectOption(o.label, false)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.key !== "Enter") return;
                  e.preventDefault();
                  selectOption(o.label, true);
                }}
              >
                {multi ? (
                  <span className="ask-opt-box" aria-hidden="true">
                    {on ? "✓" : ""}
                  </span>
                ) : (
                  <span className="ask-opt-num">{i + 1}</span>
                )}
                <span className="ask-opt-main">
                  <span className="ask-opt-label">
                    {stripRecommended(o.label)}
                    {isRecommended(o.label) && <span className="ask-rec">推荐</span>}
                  </span>
                  {o.description !== undefined && <span className="ask-opt-desc">{o.description}</span>}
                </span>
                {!multi && on && (
                  <span className="ask-opt-tick" aria-hidden="true">
                    ✓
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className={`ask-custom${d.custom.trim() !== "" ? " on" : ""}`}>
          {q.multiSelect === true ? (
            <button
              type="button"
              className={`ask-custom-box${d.custom.trim() !== "" ? " on" : ""}`}
              aria-label="使用自定义答案"
              aria-pressed={d.custom.trim() !== ""}
              onClick={() => {
                if (d.custom.trim() !== "") {
                  updateDraft(q.id, { custom: "" });
                  customRef.current?.focus();
                } else {
                  customRef.current?.focus();
                }
              }}
            >
              {d.custom.trim() !== "" ? "✓" : ""}
            </button>
          ) : (
            <span className="ask-custom-pen">
              <PencilIcon />
            </span>
          )}
          <textarea
            ref={customRef}
            rows={1}
            className="ask-custom-input"
            placeholder="输入你的答案"
            aria-label="自定义答案"
            value={d.custom}
            onChange={(e) => {
              const value = e.target.value;
              updateDraft(q.id, {
                custom: value,
                selected: q.multiSelect === true ? d.selected : [],
                skipped: false,
              });
              if (value.trim() !== "" && !held) {
                setHeld(true);
                setPausedRemaining(null);
                setDeadline(undefined);
                onHold("hold");
              }
              e.currentTarget.style.height = "auto";
              e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 92)}px`;
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                forward();
              }
            }}
          />
        </div>
      </div>

      <footer className="ask-sheet-foot">
        <div className="ask-note">{note}</div>
        <div className="ask-actions">
          <div className="ask-pager">
            <button
              type="button"
              className="ask-pg"
              aria-label="上一题"
              disabled={page === 0}
              onClick={() => go(page - 1)}
            >
              ‹
            </button>
            <span className="ask-pg-count">
              {page + 1}/{total}
            </span>
            <button
              type="button"
              className="ask-pg"
              aria-label="下一题"
              disabled={last}
              onClick={() => go(page + 1)}
            >
              ›
            </button>
          </div>
          <span className="ask-grow" />
          <button type="button" className="ask-btn" onClick={toggleSkip}>
            {d.skipped ? "取消跳过" : "跳过"}
          </button>
          <button
            type="button"
            className="ask-btn primary"
            disabled={forwardDisabled || busy || sent}
            onClick={forward}
          >
            {sent ? "已收到，等待送达" : forwardLabel}
          </button>
        </div>
      </footer>
    </section>
  );
}
