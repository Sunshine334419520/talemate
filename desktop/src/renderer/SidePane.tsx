/**
 * 右栏：看细节的地方。对话只放"提到它的那一行"，细节一律来这里——一章正文、一次落盘的改动、
 * 将来还有别的，所以它装的是一个联合，不是"文档预览"那一种。
 *
 * 两条纪律：
 * - markdown 必过 DOMPurify：文档里可能贴进任何东西（查证时从网页抄来的片段、用户自己粘的
 *   HTML），而渲染层是有网络的那一侧。一个 `<img onerror>` 就够把稿子送出去。不是洁癖。
 * - diff 按行着色，不渲染 markdown：它是逐字的证据，加粗斜体只会把 `+`/`-` 淹掉。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AnnotatedDoc } from "./AnnotatedDoc";
import type { Annotation } from "./annotations";
import { HistoryIcon } from "./icons";
import { ChangeHistory, type ChangeScope } from "./TurnChanges";
import type { ChangeRow } from "./changes";
import type { SessionTurnChanges } from "../shared/api";

/**
 * 编辑态交给上层的那两件事：离开之前先把草稿存下去，或者干脆放下它。
 *
 * 上层（Workspace）负责"什么时候要走"——切文档、关栏、回上一屏都从它那儿过；这里只负责
 * "这份草稿现在是什么状态"。
 */
export interface DraftApi {
  /** 存草稿。`force` = 用户明确要用自己的版本覆盖别处的新稿；回 false = 没存上 */
  flush(force?: boolean): Promise<boolean>;
  /** 放下没存上的改动（离开时选了"丢掉"） */
  discard(): void;
}

/** 停手多久之后自动落盘。700ms 够把一句话打完，又短到切屏前基本已经存上。 */
const AUTOSAVE_MS = 700;

/** 右栏顶部的动作（目前只有命令输出用：把 `/trace` 的轨迹导出成脱敏副本）。 */
export interface PaneAction {
  label: string;
  title?: string;
  run(): void | Promise<void>;
}

export type Pane =
  | { kind: "doc"; name: string; path: string; text: string }
  /** 一次落盘的改动（`write_ops` 给用户看的那两段：先影响面，后这次动了什么）；带路径时显示具体文件 */
  | { kind: "diff"; name: string; text: string; path?: string }
  /**
   * 纯文本的一屏（`/` 命令的输出，如 `/status`、`/permissions`）。
   *
   * **不走 markdown**：那两份都是对齐过的、一行一条的文本，markdown 会把空格吃掉、把 `◇` 开头的行
   * 并成一段。也不给编辑——命令输出不是作品，改它没有去处。
   */
  | { kind: "text"; name: string; text: string; actions?: PaneAction[] }
  /** 改动记录：按轮分组的时间线；点一行再进 doc/diff，右上角留返回 */
  | { kind: "changes"; name: string; groups: SessionTurnChanges[]; currentSessionId: string };

export function SidePane({
  pane,
  onClose,
  onSave,
  onRegisterDraft,
  stale,
  onEditingChange,
  width,
  annotations,
  onAnnotationsChange,
  onSubmitAnnotations,
  busy,
  onBack,
  historyScope,
  onHistoryScope,
  labelOf,
  rankOf,
  onOpenDoc,
  onOpenDiff,
  onOpenRefs,
}: {
  pane: Pane;
  /** 宽度由外面给——分隔缝拖动改的是它（见 Workspace 的 splitter） */
  width: number;
  onClose: () => void;
  /** 进了/出了编辑态——外面据此决定"别处改了文件"时是静默刷新还是只插标记 */
  onEditingChange: (editing: boolean) => void;
  /** 保存一份文档；回 `stale` 表示打开之后它在别处被改过。`expected` 就是界面相信盘上那一份 */
  onSave: (text: string, opts: { expected: string; force: boolean }) => Promise<"ok" | "stale">;
  /** 把草稿口交给上层：切屏/关栏之前上层要能先存一笔（`null` = 不在编辑态） */
  onRegisterDraft: (api: DraftApi | null) => void;
  /** 别处把这一份改了（界面据此提示，不抢正在编辑的光标） */
  stale: boolean;
  /** 当前文档的未提交备注。按文档路径存在外面，切走再回来还在 */
  annotations: Annotation[];
  onAnnotationsChange: (notes: Annotation[]) => void;
  /** 把备注交给上层拼成一条用户消息；清空也由上层做 */
  onSubmitAnnotations: (notes: readonly Annotation[]) => void;
  /** 搭档正在跑一轮：提交钮置灰 */
  busy: boolean;
  /** 从改动记录点进来的详情才有：回到那一屏 */
  onBack?: () => void;
  /** 改动记录的范围，以及切换它 */
  historyScope: ChangeScope;
  onHistoryScope: (scope: ChangeScope) => void;
  /** 文档的显示名与先后（改动记录用；来自目录树） */
  labelOf: (path: string) => string;
  rankOf: (path: string) => number;
  onOpenDoc: (path: string) => void;
  onOpenDiff: (name: string, text: string, path: string) => void;
  /** 历史行只有指针：上层按 (sessionId, messageSeq, callId) 去取 diff */
  onOpenRefs?: (sessionId: string, row: ChangeRow) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  /**
   * 我们相信盘上就是这一份。存成功就跟着往前走——`dirty` 由它算，不等父组件的 props 回流，
   * 否则"用户还在打"和"存完的回执"会互相追着改。
   */
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** 自动保存撞了 CAS：停手，等用户明确说"覆盖"——不能拿他的稿子去盖 mate 刚落的 */
  const [conflict, setConflict] = useState(false);

  // 切屏那一瞬要读到最新草稿，所以真相另存一份 ref：state 是给渲染用的，ref 是给 flush 用的
  const draftRef = useRef("");
  const savedRef = useRef("");
  const editingRef = useRef(false);
  const conflictRef = useRef(false);
  /** 同一份文件同时只写一次：自动保存和「完成」很容易撞在同一毫秒上 */
  const inflight = useRef<Promise<"ok" | "stale"> | null>(null);

  const dirty = editing && pane.kind === "doc" && draft !== saved;

  const endEdit = useCallback((): void => {
    setEditing(false);
    editingRef.current = false;
    onEditingChange(false);
  }, [onEditingChange]);

  // 换文档/换一屏时退出编辑态；同一份文档的正文刷新不动它（见 stale 分支）
  useEffect(() => {
    endEdit();
    setNote(null);
    setConflict(false);
    conflictRef.current = false;
    setSavedAt(null);
  }, [pane.kind, pane.kind === "doc" ? pane.path : "", endEdit]);

  const beginEdit = useCallback((): void => {
    if (pane.kind !== "doc") return;
    setDraft(pane.text);
    draftRef.current = pane.text;
    setSaved(pane.text);
    savedRef.current = pane.text;
    setEditing(true);
    editingRef.current = true;
    setNote(null);
    setConflict(false);
    conflictRef.current = false;
    setSavedAt(null);
    onEditingChange(true);
  }, [pane, onEditingChange]);

  // 上层传下来的保存函数每次渲染都是新的（它闭包着 pane）；写进 ref，别让它的身份
  // 变化把「停手 700ms」的计时器一遍遍重置——流式输出时每来一个 token 都会重渲染
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  /**
   * 把当前草稿存下去。回 "ok" 才推进基准；回 "stale" 保留草稿并停掉自动保存。
   *
   * 串行：上一笔没回来就等它——磁盘上同一份文件两次写交错，后写的那个会把前一个盖掉。
   */
  const saveNow = useCallback(
    async (force: boolean): Promise<"ok" | "stale"> => {
      while (inflight.current !== null) {
        try {
          await inflight.current;
        } catch {
          // 上一笔的错它自己已经报过，这里只是等它让路
        }
      }
      const text = draftRef.current;
      if (text === savedRef.current) return "ok";
      setSaving(true);
      const run = onSaveRef.current(text, { expected: savedRef.current, force });
      inflight.current = run;
      let verdict: "ok" | "stale" = "stale";
      try {
        verdict = await run;
      } catch {
        setNote("保存失败了，改动还在编辑器里——再试一次，或者先复制出去。");
        return "stale";
      } finally {
        inflight.current = null;
        setSaving(false);
      }
      if (verdict === "ok") {
        savedRef.current = text;
        setSaved(text);
        // 覆盖成功之后冲突就结束了，否则自动保存会一直停着、标题栏一直挂着"未保存"
        conflictRef.current = false;
        setConflict(false);
        setSavedAt(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
        setNote(null);
      } else {
        conflictRef.current = true;
        setConflict(true);
        setNote("这份在别处被改过了。你的改动还在——点「用我的覆盖」保留你的版本，或关掉重开看新版。");
      }
      return verdict;
    },
    [],
  );

  // 自动保存：停手 AUTOSAVE_MS 之后落一笔。冲突了就停，直到用户拍板
  useEffect(() => {
    if (!editing || conflict || draft === saved) return;
    const timer = window.setTimeout(() => void saveNow(false), AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [editing, conflict, draft, saved, saveNow]);

  const flush = useCallback(
    async (force = false): Promise<boolean> => {
      if (!editingRef.current || draftRef.current === savedRef.current) return true;
      // 没让用户点头就不覆盖：自动保存撞过 CAS，说明盘上是别人的新稿
      if (!force && conflictRef.current) return false;
      return (await saveNow(force)) === "ok";
    },
    [saveNow],
  );

  const discard = useCallback((): void => {
    draftRef.current = savedRef.current;
    setDraft(savedRef.current);
    setNote(null);
    setConflict(false);
    conflictRef.current = false;
    endEdit();
  }, [endEdit]);

  useEffect(() => {
    onRegisterDraft({ flush, discard });
    return () => onRegisterDraft(null);
  }, [flush, discard, onRegisterDraft]);

  /** 「完成」：存下最后一笔再退出编辑。存不上就留在编辑态，note 里已经说了为什么。 */
  async function finish(): Promise<void> {
    if (draft !== saved && (await saveNow(false)) !== "ok") return;
    endEdit();
  }

  /** 冲突之后用户明确选择用自己的版本盖过去 */
  async function overwrite(): Promise<void> {
    await saveNow(true);
  }

  return (
    <div className="sidepane" style={{ width }}>
      {/* 顶行与参考界面一致：一个文件标签 + 右侧的图标动作；整行可拖窗口 */}
      <div className="doc-tabs">
        <span className="tab active">
          {pane.kind === "changes" ? <HistoryIcon /> : <FileIcon />}
          {pane.name}
        </span>
        <span className="end">
          {onBack !== undefined && (
            <button className="btn tiny" type="button" onClick={onBack}>
              ← 改动记录
            </button>
          )}
          {pane.kind === "doc" && !editing && (
            <button className="iconbtn" title="编辑" onClick={beginEdit}>
              <PencilIcon />
            </button>
          )}
          {pane.kind === "doc" && editing && (
            <>
              <span className={`save-state ${saving ? "busy" : conflict ? "bad" : ""}`}>
                {saving
                  ? "保存中…"
                  : conflict
                    ? "未保存"
                    : dirty
                      ? "待保存…"
                      : savedAt !== null
                        ? `已保存 ${savedAt}`
                        : "自动保存"}
              </span>
              <button className="iconbtn" title="保存并完成" disabled={saving} onClick={() => void finish()}>
                <SaveIcon />
              </button>
            </>
          )}
          {pane.kind === "text" &&
            pane.actions?.map((action) => (
              <button
                key={action.label}
                className="btn tiny"
                type="button"
                title={action.title ?? action.label}
                onClick={() => void action.run()}
              >
                {action.label}
              </button>
            ))}
          <button className="iconbtn" title="关闭" onClick={onClose}>
            <XIcon />
          </button>
        </span>
      </div>
      <div className="pathbar">
        {pane.kind === "doc"
          ? pane.path
          : pane.kind === "diff"
            ? (pane.path ?? "改动")
            : pane.kind === "changes"
              ? (historyScope === "session" ? "本次会话" : "本书")
              : "命令"}
        {stale && pane.kind === "doc" && <span className="stale">已在别处更新</span>}
      </div>
      {note !== null && (
        <div className="pane-note">
          <span>{note}</span>
          {conflict && (
            <button className="btn tiny" type="button" onClick={() => void overwrite()}>
              用我的覆盖
            </button>
          )}
        </div>
      )}
      {pane.kind === "diff" ? (
        <Diff text={pane.text} />
      ) : pane.kind === "text" ? (
        <div className="pane-body plain">{pane.text}</div>
      ) : pane.kind === "changes" ? (
        <div className="pane-body">
          <ChangeHistory
            groups={pane.groups}
            currentSessionId={pane.currentSessionId}
            scope={historyScope}
            onScope={onHistoryScope}
            labelOf={labelOf}
            rankOf={rankOf}
            onOpenDoc={onOpenDoc}
            onOpenDiff={onOpenDiff}
            {...(onOpenRefs === undefined ? {} : { onOpenRefs })}
          />
        </div>
      ) : editing ? (
        <textarea
          className="pane-edit"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            draftRef.current = e.target.value;
          }}
          spellCheck={false}
        />
      ) : (
        <AnnotatedDoc
          key={pane.path}
          text={pane.text}
          annotations={annotations}
          onChange={onAnnotationsChange}
          onSubmit={onSubmitAnnotations}
          busy={busy}
        />
      )}
    </div>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 2.5h5l3 3v8H4z" />
      <path d="M9 2.5v3h3" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 13h2.5L13 5.5 10.5 3 3 10.5z" />
    </svg>
  );
}

function SaveIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 2.5h8l2 2v9H3z" />
      <path d="M5.5 2.5v3h5v-3M5.5 13v-3.5h5V13" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}

/** 逐行着色：`+` 新增、`-` 删除，其余原样。不给行号——`write_ops` 的 diff 自带上下文行。 */
function Diff({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="pane-body diff">
      {lines.map((line, i) => {
        const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "";
        return (
          <div className={cls} key={i}>
            {line === "" ? " " : line}
          </div>
        );
      })}
    </div>
  );
}
