/**
 * 右栏：看细节的地方。对话只放"提到它的那一行"，细节一律来这里——一章正文、一次落盘的改动、
 * 将来还有别的，所以它装的是一个联合，不是"文档预览"那一种。
 *
 * 两条纪律：
 * - markdown 必过 DOMPurify：文档里可能贴进任何东西（查证时从网页抄来的片段、用户自己粘的
 *   HTML），而渲染层是有网络的那一侧。一个 `<img onerror>` 就够把稿子送出去。不是洁癖。
 * - diff 按行着色，不渲染 markdown：它是逐字的证据，加粗斜体只会把 `+`/`-` 淹掉。
 */
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo, useState } from "react";

export type Pane =
  | { kind: "doc"; name: string; path: string; text: string }
  /** 一次落盘的改动（`write_ops` 给用户看的那两段：先影响面，后这次动了什么） */
  | { kind: "diff"; name: string; text: string }
  /**
   * 纯文本的一屏（`/` 命令的输出，如 `/status`、`/permissions`）。
   *
   * **不走 markdown**：那两份都是对齐过的、一行一条的文本，markdown 会把空格吃掉、把 `◇` 开头的行
   * 并成一段。也不给编辑——命令输出不是作品，改它没有去处。
   */
  | { kind: "text"; name: string; text: string };

export function SidePane({
  pane,
  onClose,
  onSave,
  stale,
  onEditingChange,
  width,
}: {
  pane: Pane;
  /** 宽度由外面给——分隔缝拖动改的是它（见 Workspace 的 splitter） */
  width: number;
  onClose: () => void;
  /** 进了/出了编辑态——外面据此决定"别处改了文件"时是静默刷新还是只插标记 */
  onEditingChange: (editing: boolean) => void;
  /** 保存一份文档；回 `stale` 表示打开之后它在别处被改过 */
  onSave: (text: string) => Promise<"ok" | "stale">;
  /** 别处把这一份改了（界面据此提示，不抢正在编辑的光标） */
  stale: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const dirty = editing && draft !== pane.text;

  async function save(): Promise<void> {
    const verdict = await onSave(draft);
    if (verdict === "ok") {
      setEditing(false);
      onEditingChange(false);
      setNote(null);
    } else {
      setNote("这份在别处被改过了——先关掉重开看看新的，别把它盖掉。");
    }
  }

  return (
    <div className="sidepane" style={{ width }}>
      {/* 顶行与参考界面一致：一个文件标签 + 右侧的图标动作；整行可拖窗口 */}
      <div className="doc-tabs">
        <span className="tab active">
          <FileIcon />
          {pane.name}
        </span>
        <span className="end">
          {pane.kind === "doc" && !editing && (
            <button
              className="iconbtn"
              title="编辑"
              onClick={() => {
                setDraft(pane.text);
                setEditing(true);
                onEditingChange(true);
              }}
            >
              <PencilIcon />
            </button>
          )}
          {pane.kind === "doc" && editing && (
            <>
              <button className="iconbtn" title="保存" disabled={!dirty} onClick={() => void save()}>
                <SaveIcon />
              </button>
              <button
                className="iconbtn"
                title="放弃"
                onClick={() => {
                  setEditing(false);
                  onEditingChange(false);
                }}
              >
                <UndoIcon />
              </button>
            </>
          )}
          <button className="iconbtn" title="关闭" onClick={onClose}>
            <XIcon />
          </button>
        </span>
      </div>
      <div className="pathbar">
        {pane.kind === "doc" ? pane.path : pane.kind === "diff" ? "改动" : "命令"}
        {stale && !editing && <span className="stale">已在别处更新</span>}
      </div>
      {note !== null && <div className="pane-note">{note}</div>}
      {pane.kind === "diff" ? (
        <Diff text={pane.text} />
      ) : pane.kind === "text" ? (
        <div className="pane-body plain">{pane.text}</div>
      ) : editing ? (
        <textarea className="pane-edit" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
      ) : (
        <Doc text={pane.text} />
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

function UndoIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 4 2.5 6.5 5 9" />
      <path d="M2.5 6.5H10a3.5 3.5 0 0 1 0 7H8" />
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

function Doc({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false })), [text]);
  return <div className="md pane-body" dangerouslySetInnerHTML={{ __html: html }} />;
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
