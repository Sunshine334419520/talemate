/**
 * 工作台：左栏（会话 + 这本书的文档）、中栏对话、右栏预览。
 *
 * 读模型是这里唯一的状态：进会话先拉一次历史投影（`tm.history`），之后靠 `LLMEvent` 增量往上拼，
 * 界面不发明任何业务状态——一条消息是谁写的、写完了没有，harness 说了算。这一层只管编排
 * （谁在哪儿、什么时候取数），画法全在 `Thread` 里。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AskRequest, ConfirmRequest, DocNode, LLMEvent, OpenInfo, ProjectCard, SessionRow, SessionState, StoredMessage, StyleCatalog } from "../shared/api";
import { DocTree } from "./DocTree";
import { SidePane, type Pane } from "./SidePane";
import { Thread, classifyStep, subjectOf, type LiveItem } from "./Thread";
import { tokens } from "../shared/tokens";
import { contextWindow } from "../../../src/core/windows";

/** 目录树里所有能打开的节点，拉平成一列——`@` 的候选就是它。 */
function flatDocs(nodes: DocNode[]): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  for (const n of nodes) {
    if (n.path !== undefined) out.push({ name: n.name, path: n.path });
    if (n.children !== undefined) out.push(...flatDocs(n.children));
  }
  return out;
}

/** 右栏默认宽度，以及它的上下限——两边都不许把对方挤没。 */
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

export function Workspace({
  project,
  onExit,
  onSettings,
}: {
  project: ProjectCard;
  onExit: () => void;
  onSettings: () => void;
}) {
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
  /** 输入框里正在打的 `@…` 或 `/…`：`at` 是那个符号在文本里的位置 */
  const [menu, setMenu] = useState<{ kind: "at" | "slash"; token: string; at: number } | null>(null);
  /** 高亮在第几项——键盘和鼠标共用这一个，否则两边会各选各的 */
  const [menuIndex, setMenuIndex] = useState(0);
  const [profiles, setProfiles] = useState<{ name: string; models: string[] }[]>([]);
  /** 这本书用的文风 + 库里可选的卡。**文件事实，不是会话状态**——所以它跟着盘上一起变。 */
  const [style, setStyle] = useState<StyleCatalog | null>(null);
  /** 每一轮请求的用量（`usage` 事件）——界面靠它显示占比与走势 */
  const [uses, setUses] = useState<{ input: number; output: number }[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef(false);

  const loadSessions = useCallback(async (): Promise<SessionRow[]> => {
    const rows = await window.tm.listSessions(project.id);
    setSessions(rows);
    return rows;
  }, [project.id]);

  const loadStyle = useCallback(async (): Promise<void> => {
    setStyle(await window.tm.styleCatalog(project.id));
  }, [project.id]);

  /**
   * 换文风：写下去之后把目录重读一遍再改本地状态——**不乐观更新**。
   * 判据是盘上那份文件，界面显示"已经换了"而其实被 CAS 拒掉，是这里最坏的失败。
   */
  const pickStyle = useCallback(
    async (name: string): Promise<void> => {
      const verdict = await window.tm.setStyle(project.id, name);
      if (verdict === "unknown") {
        setError(`文风库里没有「${name}」这张卡，没写进核心设定。`);
        return;
      }
      if (verdict === "stale") {
        setError("核心设定刚被别处改过，没敢覆盖——重开一次再换文风。");
        return;
      }
      await loadStyle();
    },
    [loadStyle, project.id],
  );

  /** 进一个会话：开它（续聊或新建）+ 拉历史投影。这两步是分开的——历史不依赖会话对象。 */
  const enter = useCallback(
    async (sessionId?: string): Promise<void> => {
      const opened = await window.tm.openSession(project.id, sessionId);
      setInfo(opened);
      setCurrent(opened.sessionId);
      setHistory(sessionId ? await window.tm.history(project.id, opened.sessionId) : []);
      setLive([]);
      setBusy(false);
      setError(null);
      // 用量由 harness 记在会话元信息里：切会话切回来在、重启也还在
      setUses(await window.tm.sessionUsage(project.id, opened.sessionId));
      setState(await window.tm.sessionState(project.id));
      await loadSessions();
    },
    [loadSessions, project.id],
  );

  useEffect(() => {
    void (async () => {
      // 上次拖出来的宽度先用上，免得开场先闪一下默认宽度
      setProfiles((await window.tm.models()).profiles);
      await loadStyle();
      const saved = (await window.tm.prefs()).paneWidth;
      if (typeof saved === "number") setPaneWidth(clampPane(saved));
      const rows = await loadSessions();
      await enter(rows[0]?.id);
    })();
  }, [enter, loadSessions, loadStyle]);

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
            // 入参里就有"它动的是什么"——收在这一刻，别等结果回来才想起没记住
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
      if (e.type === "usage") setUses((prev) => [...prev, { input: e.input, output: e.output }]);
      if (e.type === "session.status") setBusy(e.status === "busy");
    });
    window.tm.onSessionState(setState);
    window.tm.onConfirm(setConfirm);
    window.tm.onAsk(setAsk);
    window.tm.onError(setError);
    // 订阅只挂一次；事件是推的，不轮询
  }, []);

  /** 文档树现取。一轮结束之后再取一次：mate 刚写的正文/状态要出现在树上，不然用户以为它没写。 */
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

  /** 点一份文档：取全文，右栏开着。现取——刚写完的那一版才是要看的 */
  const openDoc = useCallback(
    async (node: DocNode): Promise<void> => {
      if (node.path === undefined) return; // 纯分组节点（如"角色"）：点它不开文档
      const text = await window.tm.docText(project.id, node.path);
      setPane(text === undefined ? null : { kind: "doc", name: node.name, path: node.path, text });
    },
    [project.id],
  );

  /** 右栏正在编辑时，别处改了盘上的文件只插标记——不抢用户的光标（见 SidePane 的 stale）。 */
  const editingRef = useRef(false);
  const paneRef = useRef<Pane | null>(null);
  useEffect(() => {
    paneRef.current = pane;
  }, [pane]);

  useEffect(() => {
    window.tm.onDocsChanged(() => {
      // 盘上变的不只是文档：会话的名字也会变（第一句话发出去之后按它命名），所以列表也跟着刷
      void refreshTree();
      void loadSessions();
      // 文风是 core.md 里的一格：mate 或用户手改过，状态栏那一格也得跟着变
      void loadStyle();
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
  }, [project.id, refreshTree, loadSessions, loadStyle]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [live, history, confirm, ask]);

  /** 对话里那张"稿子"卡：按路径去取全文，在右栏打开。 */
  const openChapter = useCallback(
    async (path: string): Promise<void> => {
      const text = await window.tm.docText(project.id, path);
      setPane(text === undefined ? null : { kind: "doc", name: path.split("/").pop() ?? path, path, text });
    },
    [project.id],
  );

  /**
   * 发一句话。`shown` 是气泡里显示的，`sent` 是真正发给 harness 的——两者可以不同：`@世界观`
   * 拼出来的 `<mentioned>` 段是给模型看的材料，不该糊在用户自己的气泡里（存进历史也一样丑）。
   * 三向裁决也走这里——按钮说的是固定短语，判定仍然在 harness（见 `shared/verdict.ts`）。
   */
  const say = useCallback((text: string, sent?: string): void => {
    setLive((prev) => [...prev, { kind: "me", text }]);
    window.tm.prompt(sent ?? text);
  }, []);

  // 窗口大小按当前模型查表（认不出给保守默认值）——显示时永远带"约"，不把估算说成事实
  const win = contextWindow(info?.model ?? "");

  /** 光标前那一段是不是 `@…` 或 `/…`。只在词首认：`a@b` 里的 @ 是邮箱，不是提及。 */
  function scanMenu(text: string, caret: number): void {
    const before = text.slice(0, caret);
    const at = before.lastIndexOf("@");
    if (at >= 0 && (at === 0 || /\s/.test(before[at - 1] ?? "")) && !/\s/.test(before.slice(at + 1))) {
      setMenu({ kind: "at", token: before.slice(at + 1), at });
      setMenuIndex(0); // 每换一次候选都从头高亮：默认选中第一个，回车就用它
      return;
    }
    const slash = /^\/([^\s]*)$/.exec(before);
    if (slash !== null) {
      setMenu({ kind: "slash", token: slash[1], at: 0 });
      setMenuIndex(0);
      return;
    }
    setMenu(null);
  }

  /** 选中一个候选：把 `@token` 那段换成它 */
  const pick = useCallback(
    (value: string, run?: () => void): void => {
      if (menu === null) return;
      if (run !== undefined) {
        setDraft("");
        setMenu(null);
        run();
        return;
      }
      const next = `${draft.slice(0, menu.at)}@${value} ${draft.slice(menu.at + 1 + menu.token.length)}`;
      setDraft(next);
      setMenu(null);
    },
    [draft, menu],
  );

  /** 眼下这一层候选：`@` 取文档，`/` 取命令。 */
  const menuItems = useMemo((): { key: string; label: string; hint?: string; run: () => void }[] => {
    if (menu === null) return [];
    if (menu.kind === "at") {
      return flatDocs(tree)
        .filter((d) => d.name.includes(menu.token))
        .slice(0, 8)
        .map((d) => ({ key: d.path, label: d.name, hint: d.path, run: () => pick(d.name) }));
    }
    const cmds: [string, () => void][] = [
      ["新会话", () => void enter()],
      ["设置", onSettings],
      ["所有作品", onExit],
    ];
    return cmds
      .filter(([label]) => label.includes(menu.token))
      .map(([label, run]) => ({ key: label, label: `/${label}`, run: () => pick("", run) }));
  }, [enter, menu, onExit, onSettings, pick, tree]);

  function send(): void {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    setMenu(null);
    // `@名字` 只是你看的：真正发出去时补一段"指的是哪些文件"，mate 拿的是确切地址。
    // 我们看到的和模型拿到的不必是同一个东西——而让模型猜"核心设定"是哪个文件，是没必要的风险。
    const hit = flatDocs(tree).filter((d) => text.includes(`@${d.name}`));
    const body =
      hit.length === 0
        ? text
        : `${text}\n\n<mentioned>\n${hit.map((d) => `${d.name} → ${d.path}`).join("\n")}\n</mentioned>`;
    say(text, body);
  }

  return (
    <div className="app">
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
          <DocTree
            nodes={tree}
            current={pane?.kind === "doc" ? pane.path : null}
            onOpen={(n) => void openDoc(n)}
            onMention={(n) => setDraft((d) => (d === "" ? `@${n.name} ` : `${d}@${n.name} `))}
          />
        </div>
      </aside>

      <main className="main">
        <header className="head">
          <div className="book-name">{info?.book ?? "正在开会话…"}</div>
          <span className="sub">{info ? `${info.agent}${busy ? " · ● 正在写" : ""}` : ""}</span>
        </header>

        <div className="scroll" ref={scrollRef}>
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
            {menu !== null && menuItems.length > 0 && (
              <div className="menu">
                {menuItems.map((it, i) => (
                  <button
                    key={it.key}
                    className={`pop-item${i === menuIndex ? " sel" : ""}`}
                    onMouseEnter={() => setMenuIndex(i)}
                    onClick={() => it.run()}
                  >
                    {it.label}
                    {it.hint !== undefined && <span className="pop-hint">{it.hint}</span>}
                  </button>
                ))}
              </div>
            )}
            <textarea
              value={draft}
              placeholder="说点什么…"
              onChange={(e) => {
              setDraft(e.target.value);
              scanMenu(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
              onKeyDown={(e) => {
                // 菜单展开时键盘事件优先给菜单，回车选中项而非发送
                if (menu !== null && menuItems.length > 0) {
                  const n = menuItems.length;
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setMenuIndex((i) => (i + 1) % n);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setMenuIndex((i) => (i - 1 + n) % n);
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    menuItems[menuIndex]?.run();
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setMenu(null);
                    return;
                  }
                }
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
          title="拖动改宽度"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            dragRef.current = true;
          }}
          onPointerMove={(e) => {
            if (!dragRef.current) return;
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

      <footer className="statusbar">
        <span className="left">
          {state.mode !== undefined && <span className="badge">{state.mode}</span>}
          {state.pending !== undefined && <span className="badge zhu">待你拍板：{state.pending}</span>}
        </span>
        <span className="right">
          {info !== null && (
            <Cell label={info.model}>
              {(close) =>
                profiles.map((p) => (
                  <span key={p.name} className="pop-group">
                    <span className="pop-title">{p.name}</span>
                    {p.models.map((m) => (
                      <button
                        key={m}
                        className="pop-item"
                        aria-current={m === info.model}
                        onClick={() => {
                          void window.tm.useProfile(p.name, m);
                          setInfo({ ...info, model: m });
                          close();
                        }}
                      >
                        {m}
                      </button>
                    ))}
                  </span>
                ))
              }
            </Cell>
          )}
          <StyleCell view={style} onPick={(n) => void pickStyle(n)} />
          {info !== null && (
            <EffortCell
              value={info.effort}
              onChange={(v) => {
                setInfo({ ...info, effort: v });
                void window.tm.setEffort(v);
              }}
            />
          )}
          <ContextCell uses={uses} win={win} />
          <button className="cell clickable" title="模型与设置" onClick={onSettings}>
            ⚙ 设置
          </button>
        </span>
      </footer>
    </div>
  );
}

/** 状态栏里可点的一格：平时是个按钮，点开向上弹一层。 */
function Cell({
  label,
  children,
}: {
  label: React.ReactNode;
  /** 收 `close`：**选完自己收**。开关状态在 `Cell` 里，孩子够不着它，所以要递下去。 */
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <span className="pop-wrap">
      <button className="cell clickable" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {label}
        <span className="caret">▴</span>
      </button>
      {open && (
        <>
          {/* 点外面就收：一层透明垫子比全局监听便宜，也不会漏掉哪个角落 */}
          <span className="pop-mask" onClick={close} />
          <span className="pop">{children(close)}</span>
        </>
      )}
    </span>
  );
}

/**
 * 文风：这本书用哪种声音写。选中即写进核心设定的「文风」格——**不经过模型**。
 *
 * 触发按钮上显示的是卡的**中文名**（`title`），不是写进 core.md 的那个 id：id 是稳定标识，
 * 给人看的是另一回事。
 */
function StyleCell({ view, onPick }: { view: StyleCatalog | null; onPick: (name: string) => void }) {
  if (view === null) return null;
  const now = view.cards.find((c) => c.name === view.current.name);
  return (
    <Cell label={`文风 ${now?.title ?? view.current.name}`}>
      {(close) => (
        <>
          {/* 格里的字不是卡名时 harness 会带一句说明，且实际用的是默认那张——这一行必须显示出来，
              否则用户以为在用 A、其实在用 B，正是 prose.ts 特意不静默的那件事 */}
          {view.current.note !== undefined && <div className="pop-note">{view.current.note}</div>}
          {view.cards.map((c) => (
            <button
              key={c.name}
              className="pop-item lined"
              aria-current={c.name === view.current.name}
              onClick={() => {
                close(); // 先收：选完这一格就没事了——写盘和可能的报错在别处
                onPick(c.name);
              }}
            >
              {c.title}
              <span className="sub">{c.description}</span>
            </button>
          ))}
          {/*
            自定义文风的入口**现在只占位、故意 disabled**。
            真做起来比"选一张现成的卡"复杂一档：要能写一张卡（正文 + 六维声音层 + 反例）并把它
            落进库里（内置库是只读的，得进全局库或项目库），还要处理重名——那是另一件事。
            先摆在这里免得忘掉；**不做成"能点但什么都不发生"**，那比不摆更糟。
          */}
          <button className="pop-item lined" disabled>
            自定义…
            <span className="sub">还没做——先占个位置</span>
          </button>
        </>
      )}
    </Cell>
  );
}

/** effort：四档，选了当场换这个会话的（不动全局默认）。 */
function EffortCell({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const OPTIONS: [string, string][] = [["off", "关"], ["low", "低"], ["high", "高"], ["max", "最高"]];
  const now = OPTIONS.find(([v]) => v === value)?.[1] ?? value;
  return (
    <Cell label={`effort ${now}`}>
      {(close) =>
        OPTIONS.map(([v, text]) => (
          <button
            key={v}
            className="pop-item"
            aria-current={v === value}
            onClick={() => {
              onChange(v);
              close();
            }}
          >
            {text}
            <span className="pop-hint">{v}</span>
          </button>
        ))
      }
    </Cell>
  );
}

/**
 * 上下文：点开是真实的用量——总数，以及每一轮的走势。
 *
 * 不给构成（系统提示 / 工具 / 消息各占多少）：那是 `claude /context` 干的事，它自己知道每一段
 * 各有多长；我们只知道 provider 报回来的总数，要拆就得估，所以不估也不画。走势是真的。
 */
function ContextCell({ uses, win }: { uses: { input: number; output: number }[]; win: number }) {
  // 没有统计就是 0：这一格在不在，只该由"有没有这个会话"决定，不该由"发没发过话"决定
  const last = uses[uses.length - 1] ?? { input: 0, output: 0 };
  const pct = Math.round((last.input / win) * 100);
  const peak = Math.max(1, ...uses.map((u) => u.input));
  return (
    <Cell
      label={
        <span className={`ctx${last.input / win > 0.8 ? " hot" : ""}`}>
          <span className="bar">
            <i style={{ width: `${Math.min(100, pct)}%` }} />
          </span>
          上下文约 {tokens(last.input)} / {tokens(win)}
        </span>
      }
    >
      {() => (
        <>
          <div className="pop-big">
            约 {tokens(last.input)} <span className="pop-hint">/ {tokens(win)} · {pct}%</span>
          </div>
          <div className="pop-hint">输出 {last.output}</div>
          <div className="chart" title="每一轮发出去的 token">
            {(uses.length > 0 ? uses : [last]).map((u, i) => (
              <i key={i} style={{ height: `${Math.max(6, Math.round((u.input / peak) * 100))}%` }} />
            ))}
          </div>
          <div className="pop-hint">{uses.length} 轮</div>
        </>
      )}
    </Cell>
  );
}
