/**
 * 右栏：**看细节的地方**。对话只放"提到它的那一行"，细节一律来这里——
 * 一章正文、一次落盘的改动、将来还有别的。所以它装的是**一个联合**，不是"文档预览"那一种。
 *
 * 两条纪律：
 * - **markdown 必过 DOMPurify**：文档里可能贴进任何东西（查证时从网页抄来的片段、用户自己粘的 HTML），
 *   而渲染层是有网络的那一侧。一个 `<img onerror>` 就够把稿子送出去。不是洁癖。
 * - **diff 按行着色**，不渲染 markdown：它是**逐字的证据**，加粗斜体只会把 `+`/`-` 淹掉。
 */
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo, useState } from "react";

export type Pane =
  | { kind: "doc"; name: string; path: string; text: string }
  /** 一次落盘的改动（`write_ops` 给用户看的那两段：先影响面，后这次动了什么） */
  | { kind: "diff"; name: string; text: string };

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
  /** 别处把这一份改了（界面据此提示，**不抢正在编辑的光标**） */
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
      <div className="pane-head">
        <span className="name">{pane.name}</span>
        <span className="path">{pane.kind === "doc" ? pane.path : "改动"}</span>
        {stale && !editing && <span className="stale">已在别处更新</span>}
        <span className="spacer" />
        {pane.kind === "doc" &&
          (editing ? (
            <>
              <button className="btn primary" disabled={!dirty} onClick={() => void save()}>
                保存
              </button>
              <button className="btn" onClick={() => { setEditing(false); onEditingChange(false); }}>放弃</button>
            </>
          ) : (
            <button
              className="btn"
              onClick={() => {
                setDraft(pane.text);
                setEditing(true);
                onEditingChange(true);
              }}
            >
              编辑
            </button>
          ))}
        <button className="btn" onClick={onClose}>
          关闭
        </button>
      </div>
      {note !== null && <div className="pane-note">{note}</div>}
      {pane.kind === "diff" ? (
        <Diff text={pane.text} />
      ) : editing ? (
        <textarea className="pane-edit" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
      ) : (
        <Doc text={pane.text} />
      )}
    </div>
  );
}

function Doc({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false })), [text]);
  return <div className="md pane-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** 逐行着色：`+` 新增、`-` 删除，其余原样。行号不给——`write_ops` 的 diff 自带上下文行。 */
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
