/**
 * 右栏正文的批注层：划词 → 写备注 → 段落左边留一个朱砂记号 → 右下角一次提交。
 *
 * 备注不直接改文件。提交时只是把"哪里、想改什么"拼成一条普通用户消息，走和手打完全相同的
 * 发送路径；改不改、怎么改，仍然由 harness 的写入口决定。
 *
 * 只给 doc 用。diff 是证据、text 是命令输出，没有"这一段要改"这回事。
 */
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Annotation } from "./annotations";

/**
 * 能挂备注的块。标题、列表项、引用、代码块都算一块；表格单元格也算，免得整张表只有一处能标。
 * 序号就是这份列表里的下标——只用来排序和挂记号，不进消息。
 */
const BLOCK_SELECTOR = "p, li, blockquote, h1, h2, h3, h4, pre, td";

/** 选区相对批注层的坐标。浮层都按这一套算，滚动时统一收起。 */
interface Rect {
  top: number;
  left: number;
  bottom: number;
  width: number;
}

interface Pending {
  block: number;
  quote: string;
  rect: Rect;
}

interface Toolbar extends Pending {
  x: number;
  y: number;
  above: boolean;
}

interface Popover {
  block: number;
  left: number;
  top: number;
}

export function AnnotatedDoc({
  text,
  annotations,
  onChange,
  onSubmit,
  busy,
}: {
  text: string;
  annotations: Annotation[];
  onChange: (notes: Annotation[]) => void;
  /** 交给上层拼消息并发送；上层负责清空备注 */
  onSubmit: (notes: readonly Annotation[]) => void;
  /** 搭档正在跑一轮：提交钮置灰，备注继续留着 */
  busy: boolean;
}) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false })), [text]);
  const layerRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [toolbar, setToolbar] = useState<Toolbar | null>(null);
  const [target, setTarget] = useState<Pending | null>(null);
  const [composerText, setComposerText] = useState("");
  const [popover, setPopover] = useState<Popover | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);

  function showToast(message: string): void {
    setToast(message);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }

  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  /**
   * 正文换了（mate 落了新稿）：旧选区与浮层作废。正在写的备注不关——已经打的字不能因为
   * 文件刷新就没了；备注本身留在外层，不跟着丢。
   */
  useEffect(() => {
    setToolbar(null);
    setPopover(null);
  }, [text]);

  /** 读当前选区，算出它属于哪一块、引用是什么、工具条该贴在哪。 */
  function readSelection(): void {
    const root = docRef.current;
    const layer = layerRef.current;
    if (root === null || layer === null) return;
    const sel = window.getSelection();
    if (sel === null || sel.isCollapsed || sel.rangeCount === 0) {
      setToolbar(null);
      return;
    }
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) {
      setToolbar(null);
      return;
    }
    const start =
      range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    const blockEl = start?.closest<HTMLElement>(BLOCK_SELECTOR) ?? null;
    if (blockEl === null || !root.contains(blockEl)) {
      setToolbar(null);
      return;
    }
    const quote = sel.toString().trim();
    if (quote === "") {
      setToolbar(null);
      return;
    }
    const block = blocksOf(root).indexOf(blockEl);
    if (block < 0) {
      setToolbar(null);
      return;
    }
    const r = range.getBoundingClientRect();
    const lr = layer.getBoundingClientRect();
    const rect: Rect = { top: r.top - lr.top, left: r.left - lr.left, bottom: r.bottom - lr.top, width: r.width };
    const above = rect.top > 54;
    const x = Math.max(58, Math.min(rect.left + rect.width / 2, lr.width - 58));
    setToolbar({ block, quote, rect, x, y: above ? rect.top - 8 : rect.bottom + 8, above });
    setPopover(null);
  }

  /** 给每个有备注的块挂一个数字记号。DOM 是 dangerouslySetInnerHTML 画出来的，React 不接管里面。 */
  useEffect(() => {
    const root = docRef.current;
    if (root === null) return;
    root.querySelectorAll(".anno-mark").forEach((b) => b.remove());
    root.querySelectorAll(".anno-para").forEach((el) => el.classList.remove("anno-para"));

    const blocks = blocksOf(root);
    const counts = new Map<number, number>();
    for (const n of annotations) counts.set(n.block, (counts.get(n.block) ?? 0) + 1);

    for (const [block, count] of counts) {
      const el = blocks[block];
      if (el === undefined) continue;
      el.classList.add("anno-para");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "anno-mark";
      b.textContent = String(count);
      b.title = `${count} 条备注`;
      b.setAttribute("aria-label", `这一段有 ${count} 条备注`);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        // 点记号不是要选文字；不清掉的话 mouseup 会把旧的工具条又弹出来
        window.getSelection()?.removeAllRanges();
        const layer = layerRef.current;
        if (layer === null) return;
        const lr = layer.getBoundingClientRect();
        const mr = b.getBoundingClientRect();
        let left = mr.right - lr.left + 10;
        if (left + 322 > lr.width - 12) left = mr.left - lr.left - 322 - 10;
        setPopover({ block, left: Math.max(12, left), top: Math.max(12, mr.top - lr.top - 6) });
        setToolbar(null);
        setTarget(null);
      });
      el.appendChild(b);
    }

    return () => {
      root.querySelectorAll(".anno-mark").forEach((b) => b.remove());
      root.querySelectorAll(".anno-para").forEach((el) => el.classList.remove("anno-para"));
    };
  }, [annotations, html]);

  /** 备注卡片贴着选区放；放不下就翻到上面。 */
  useLayoutEffect(() => {
    const el = composerRef.current;
    const layer = layerRef.current;
    if (target === null || el === null || layer === null) return;
    const lr = layer.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.min(Math.max(12, target.rect.left), Math.max(12, lr.width - w - 12));
    let top = target.rect.bottom + 10;
    if (top + h > lr.height - 12) top = target.rect.top - h - 10;
    top = Math.max(12, Math.min(top, Math.max(12, lr.height - h - 12)));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [target]);

  /** 点开记号时把卡片夹回栏内；内容多了它自己滚动（CSS 的 max-height）。 */
  useLayoutEffect(() => {
    const el = popoverRef.current;
    const layer = layerRef.current;
    if (popover === null || el === null || layer === null) return;
    const lr = layer.getBoundingClientRect();
    const h = el.offsetHeight;
    el.style.left = `${popover.left}px`;
    el.style.top = `${Math.max(12, Math.min(popover.top, Math.max(12, lr.height - h - 12)))}px`;
  }, [popover]);

  /** 点空白处收起浮层；正在写的备注不关（点正文的人可能只是回去看一眼原文）。 */
  useEffect(() => {
    function onDown(e: MouseEvent): void {
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest(".anno-toolbar, .anno-composer, .anno-pop, .anno-mark")) return;
      setToolbar(null);
      setPopover(null);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key !== "Escape") return;
      setToolbar(null);
      setTarget(null);
      setComposerText("");
      setPopover(null);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  function openComposer(): void {
    if (toolbar === null) return;
    setTarget({ block: toolbar.block, quote: toolbar.quote, rect: toolbar.rect });
    setToolbar(null);
    setPopover(null);
    setComposerText("");
  }

  function saveNote(): void {
    if (target === null) return;
    const body = composerText.trim();
    if (body === "") return;
    const id = annotations.reduce((max, n) => Math.max(max, n.id), 0) + 1;
    onChange([...annotations, { id, block: target.block, quote: target.quote, text: body }]);
    setTarget(null);
    setComposerText("");
    showToast("已加 1 条备注 · 右下角可以一起提交");
  }

  function removeNote(id: number): void {
    const next = annotations.filter((n) => n.id !== id);
    onChange(next);
    if (popover !== null && next.every((n) => n.block !== popover.block)) setPopover(null);
    showToast("已删除 1 条备注");
  }

  function submit(): void {
    if (busy || annotations.length === 0) return;
    const count = annotations.length;
    setToolbar(null);
    setTarget(null);
    setComposerText("");
    setPopover(null);
    onSubmit(annotations);
    showToast(`${count} 条备注已提交`);
  }

  const popoverNotes =
    popover === null ? [] : annotations.filter((n) => n.block === popover.block);

  return (
    <div className="anno-layer" ref={layerRef}>
      <div
        className="md pane-body anno-doc"
        ref={docRef}
        onMouseUp={() => window.setTimeout(readSelection, 0)}
        onKeyUp={(e) => {
          if (e.shiftKey && e.key.startsWith("Arrow")) window.setTimeout(readSelection, 0);
        }}
        onScroll={() => {
          setToolbar(null);
          setPopover(null);
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />

      {toolbar !== null && (
        <div
          className={`anno-toolbar ${toolbar.above ? "above" : "below"}`}
          style={{ left: toolbar.x, top: toolbar.y }}
        >
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={openComposer}>
            <PenIcon /> 加备注
          </button>
        </div>
      )}

      {target !== null && (
        <div
          className="anno-composer"
          ref={composerRef}
          style={{ left: 12, top: 12 }}
          role="dialog"
          aria-label="添加备注"
        >
          <div className="anno-composer-head">
            <span>给这段加备注</span>
            <button
              type="button"
              className="anno-x"
              aria-label="关闭"
              onClick={() => {
                setTarget(null);
                setComposerText("");
              }}
            >
              ×
            </button>
          </div>
          <div className="anno-quote">{target.quote}</div>
          <textarea
            className="anno-input"
            autoFocus
            value={composerText}
            placeholder="想让搭档怎么改？比如：这里的节奏太快，补一段他和牙人的拉扯。"
            onChange={(e) => setComposerText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                saveNote();
              }
            }}
          />
          <div className="anno-composer-foot">
            <span className="anno-kbd">⌘ ↵ 保存</span>
            <span className="spacer" />
            <button
              type="button"
              className="btn"
              onClick={() => {
                setTarget(null);
                setComposerText("");
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={composerText.trim() === ""}
              onClick={saveNote}
            >
              保存备注
            </button>
          </div>
        </div>
      )}

      {popover !== null && popoverNotes.length > 0 && (
        <div
          className="anno-pop"
          ref={popoverRef}
          style={{ left: popover.left, top: popover.top }}
          role="dialog"
          aria-label="这一段备注"
        >
          <div className="anno-pop-head">
            <span>
              这一段 · {popoverNotes.length} 条备注
            </span>
            <button type="button" className="anno-x" aria-label="关闭" onClick={() => setPopover(null)}>
              ×
            </button>
          </div>
          {popoverNotes.map((n) => (
            <div className="anno-pop-item" key={n.id}>
              <div className="anno-quote">{n.quote}</div>
              <div className="anno-note">{n.text}</div>
              <button type="button" className="anno-del" onClick={() => removeNote(n.id)}>
                删除这条
              </button>
            </div>
          ))}
        </div>
      )}

      {annotations.length > 0 && (
        <button
          type="button"
          className="anno-fab"
          disabled={busy}
          title={
            busy
              ? "搭档正在跑这一轮，等它结束再提交"
              : `把这 ${annotations.length} 条备注作为一条消息发给搭档`
          }
          onClick={submit}
        >
          <span className="anno-fab-dot" />
          <span>
            提交 <b>{annotations.length}</b> 条备注
          </span>
          <UpIcon />
        </button>
      )}

      {toast !== null && (
        <div className="anno-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function blocksOf(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR));
}

function PenIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M3 13l1-4 7-7 3 3-7 7-4 1z" />
    </svg>
  );
}

function UpIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M8 13V3M4 7l4-4 4 4" />
    </svg>
  );
}
