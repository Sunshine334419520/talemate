/**
 * 工作台：左栏（会话 + 这本书的文档）、中栏对话、右栏预览。
 *
 * **读模型**是这里唯一的状态：进会话先拉一次**历史投影**（`tm.history`），之后靠 `LLMEvent`
 * 增量往上拼——这正是 `architecture.md` 给薄壳写下的那条（"先拉投影 + 事件增量更新本地读模型"）。
 * 界面不发明任何业务状态：一条消息是谁写的、写完了没有，harness 说了算。
 *
 * 这一层只管**编排**（谁在哪儿、什么时候取数），画法全在 `Thread` 里——对话区是这套界面最容易糊成
 * 一片的地方，它的规矩单独立一份文件讲。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AskRequest, ConfirmRequest, DocNode, LLMEvent, OpenInfo, ProjectCard, SessionRow, SessionState, StoredMessage } from "../shared/api";
import { DocTree } from "./DocTree";
import { SidePane, type Pane } from "./SidePane";
import { Thread, classifyStep, subjectOf, type LiveItem } from "./Thread";

/** 右栏默认宽度，以及它的上下限——**两边都不许把对方挤没**。 */
const DEFAULT_PANE = 460;
const MIN_PANE = 320;
const clampPane = (w: number): number =>
  Math.round(Math.min(Math.max(w, MIN_PANE), Math.max(MIN_PANE + 40, window.innerWidth * 0.6)));

function when(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const today = new Date();
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === today.toDateString() ? `今天 ${hhmm}` : `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function Workspace({ project, onExit }: { project: ProjectCard; onExit: () => void }) {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [history, setHistory] = useState<StoredMessage[]>([]);
  const [live, setLive] = useState<LiveItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<OpenInfo | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [ask, setAsk] = useState<AskRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [tree, setTree] = useState<DocNode[]>([]);
  const [pane, setPane] = useState<Pane | null>(null);
  const [stale, setStale] = useState(false);
  const [state, setState] = useState<SessionState>({});
  const [paneWidth, setPaneWidth] = useState(460);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef(false);

  const loadSessions = useCallback(async (): Promise<SessionRow[]> => {
    const rows = await window.tm.listSessions(project.id);
    setSessions(rows);
    return rows;
  }, [project.id]);

  /** 进一个会话：开它（续聊或新建）+ 拉历史投影。**这两步是分开的**——历史不依赖会话对象。 */
  const enter = useCallback(
    async (sessionId?: string): Promise<void> => {
      const opened = await window.tm.openSession(project.id, sessionId);
      setInfo(opened);
      setCurrent(opened.sessionId);
      setHistory(sessionId ? await window.tm.history(project.id, opened.sessionId) : []);
      setLive([]);
      setBusy(false);
      setError(null);
      setState(await window.tm.sessionState(project.id));
      await loadSessions();
    },
    [loadSessions, project.id],
  );

  useEffect(() => {
    void (async () => {
      // 上次拖出来的宽度先用上，免得开场先闪一下默认宽度
      const saved = (await window.tm.prefs()).paneWidth;
      if (typeof saved === "number") setPaneWidth(clampPane(saved));
      const rows = await loadSessions();
      await enter(rows[0]?.id);
    })();
  }, [enter, loadSessions]);

  useEffect(() => {
    window.tm.onEvent((e: LLMEvent) => {
      setLive((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        switch (e.type) {
          case "text.delta":
            if (last?.kind === "text") next[next.length - 1] = { kind: "text", text: last.text + e.text };
            else next.push({ kind: "text", text: e.text });
            break;
          case "reasoning.delta": {
            // 推理也是"过程"：收成一行"想了想 ⌄"，不铺开
            const lastThink = last?.kind === "think" ? last : undefined;
            if (lastThink) next[next.length - 1] = { kind: "think", text: lastThink.text + e.text };
            else next.push({ kind: "think", text: e.text });
            break;
          }
          case "tool-call": {
            // 写正文只报进度、不铺字——那一块由 Thread 画成稿子卡
            const step = classifyStep(e.name, e.input);
            // 入参里就有"它动的是什么"——**收在这一刻**，别等结果回来才想起没记住
            next.push(step.kind === "chapter" ? step : { ...step, subject: subjectOf(e.input) });
            break;
          }
          case "tool.result":
            for (let i = next.length - 1; i >= 0; i--) {
              const it = next[i];
              if (it.kind === "tool" && it.name === e.name && it.output === undefined) {
                next[i] = { ...it, output: e.output.slice(0, 120) };
                break;
              }
            }
            break;
          case "proposal":
            next.push({ kind: "proposal", text: e.text });
            break;
          default:
            break;
        }
        return next;
      });
      if (e.type === "session.status") setBusy(e.status === "busy");
    });
    window.tm.onSessionState(setState);
    window.tm.onConfirm(setConfirm);
    window.tm.onAsk(setAsk);
    window.tm.onError(setError);
    // 订阅只挂一次；事件是推的，不轮询
  }, []);

  /** 文档树现取。**一轮结束之后再取一次**：mate 刚写的正文/状态要出现在树上，不然用户以为它没写。 */
  const refreshTree = useCallback(async (): Promise<void> => {
    setTree(await window.tm.docsTree(project.id));
  }, [project.id]);

  useEffect(() => {
    void refreshTree();
  }, [refreshTree]);

  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) void refreshTree();
    wasBusy.current = busy;
  }, [busy, refreshTree]);

  /** 点一份文档：取全文，右栏开着。**现取**——刚写完的那一版才是要看的 */
  const openDoc = useCallback(
    async (node: DocNode): Promise<void> => {
      if (node.path === undefined) return; // 纯分组节点（如"角色"）：点它不开文档
      const text = await window.tm.docText(project.id, node.path);
      setPane(text === undefined ? null : { kind: "doc", name: node.name, path: node.path, text });
    },
    [project.id],
  );

  /** 右栏正在编辑时，别处改了盘上的文件**只插标记**——不抢用户的光标（见 SidePane 的 stale）。 */
  const editingRef = useRef(false);
  const paneRef = useRef<Pane | null>(null);
  useEffect(() => {
    paneRef.current = pane;
  }, [pane]);

  useEffect(() => {
    window.tm.onDocsChanged(() => {
      // 盘上变的不只是文档：**会话的名字也会变**（第一句话发出去之后按它命名），所以列表也跟着刷
      void refreshTree();
      void loadSessions();
      const open = paneRef.current;
      if (open === null || open.kind !== "doc") return;
      if (editingRef.current) {
        setStale(true);
        return;
      }
      // 没在编辑就静默换成新版：mate 刚落的稿子，用户开着的那一栏本来就该跟着变
      void window.tm.docText(project.id, open.path).then((text) => {
        if (text !== undefined) setPane({ ...open, text });
      });
    });
  }, [project.id, refreshTree, loadSessions]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [live, history, confirm, ask]);

  /** 对话里那张"稿子"卡：按路径去取全文，在右栏打开（对话里只留那一行）。 */
  const openChapter = useCallback(
    async (path: string): Promise<void> => {
      const text = await window.tm.docText(project.id, path);
      setPane(text === undefined ? null : { kind: "doc", name: path.split("/").pop() ?? path, path, text });
    },
    [project.id],
  );

  /** 发一句话给 mate。三向裁决也走这里——按钮说的是固定短语，判定仍然在 harness（见 shared/verdict.ts）。 */
  const say = useCallback((text: string): void => {
    setLive((prev) => [...prev, { kind: "me", text }]);
    window.tm.prompt(text);
  }, []);

  function send(): void {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    say(text);
  }

  return (
    <div className="shell">
      <aside className="side">
        <div className="book">
          <b>{project.title}</b>
          <button onClick={onExit}>所有作品</button>
        </div>
        <div className="label">会话</div>
        <div className="list sessions">
          {sessions.map((s) => (
            <button key={s.id} className="sess" aria-current={s.id === current} onClick={() => void enter(s.id)}>
              {s.title}
              <span className="when">{when(s.updatedAt)}</span>
            </button>
          ))}
        </div>
        <button className="new" onClick={() => void enter()}>
          ＋ 新会话
        </button>

        <div className="label split">目录</div>
        <div className="list docs">
          <DocTree nodes={tree} current={pane?.kind === "doc" ? pane.path : null} onOpen={(n) => void openDoc(n)} />
        </div>
      </aside>

      <main className="main">
        <header className="head">
          <div className="book-name">{info?.book ?? "正在开会话…"}</div>
          <span className="sub">
            {info ? `${info.agent} · ${info.model}` : ""}
            {state.mode !== undefined ? ` · ${state.mode}` : ""}
            {state.pending !== undefined ? ` · 待你拍板：${state.pending}` : ""}
            {busy ? " · ● 正在写" : ""}
          </span>
        </header>

        <div className="scroll" ref={scrollRef}>
          {history.length === 0 && live.length === 0 && (
            <p className="hint">这是新会话。说点什么开始——比如"写第 1 章"。</p>
          )}
          <Thread
            history={history}
            live={live}
            busy={busy}
            confirm={confirm}
            ask={ask}
            onReply={(id, value) => {
              window.tm.reply(id, value);
              setConfirm(null);
              setAsk(null);
            }}
            onVerdict={say}
            onOpenDoc={(path) => void openChapter(path)}
            onOpenDiff={(name, text) => setPane({ kind: "diff", name, text })}
          />
          {error !== null && <p className="note">［错误］{error}</p>}
        </div>

        <div className="composer">
          <div className="box">
            <textarea
              value={draft}
              placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <div className="box-actions">
              {busy && (
                <button className="ghost" title="停下" onClick={() => window.tm.stop()}>
                  ■
                </button>
              )}
              <button className="send" title="发送" onClick={send} disabled={busy || !draft.trim()}>
                ↑
              </button>
            </div>
          </div>
        </div>
      </main>

      {pane !== null && (
        <div
          className="splitter"
          title="拖动改宽度（双击回默认）"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            dragRef.current = true;
          }}
          onPointerMove={(e) => {
            if (!dragRef.current) return;
            // 从窗口右边量：右栏宽度 = 窗口宽 - 指针位置 - 外壳右边距
            setPaneWidth(clampPane(window.innerWidth - e.clientX - 10));
          }}
          onPointerUp={(e) => {
            if (!dragRef.current) return;
            dragRef.current = false;
            e.currentTarget.releasePointerCapture(e.pointerId);
            void window.tm.savePrefs({ paneWidth });
          }}
          onDoubleClick={() => {
            setPaneWidth(DEFAULT_PANE);
            void window.tm.savePrefs({ paneWidth: DEFAULT_PANE });
          }}
        />
      )}
      {pane !== null && (
        <SidePane
          width={paneWidth}
          pane={pane}
          stale={stale}
          onEditingChange={(v) => {
            editingRef.current = v;
          }}
          onClose={() => {
            setPane(null);
            setStale(false);
          }}
          onSave={async (text) => {
            if (pane.kind !== "doc") return "ok";
            const verdict = await window.tm.saveDoc(project.id, pane.path, text);
            if (verdict === "ok") {
              setPane({ ...pane, text });
              setStale(false);
            }
            return verdict;
          }}
        />
      )}
    </div>
  );
}
