/**
 * 工作台：左栏（会话 + 这本书的文档）、中栏对话、右栏预览。
 *
 * 读模型是这里唯一的状态：进会话先拉一次历史投影（`tm.history`），之后靠 `LLMEvent` 增量往上拼，
 * 界面不发明任何业务状态——一条消息是谁写的、写完了没有，harness 说了算。这一层只管编排
 * （谁在哪儿、什么时候取数），画法全在 `Thread` 里。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AskRequest, ConfirmRequest, DocNode, LLMEvent, OpenInfo, ProjectCard, SessionRow, SessionState, StoredMessage, StyleCatalog } from "../shared/api";
import { COMMANDS } from "./commands";
import { DocTree } from "./DocTree";
import { ChevronIcon, PanelIcon, PlusIcon, SlidersIcon } from "./icons";
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

/** 一轮请求的用量。`parts` 是三段的字符数，界面据此把真总数分摊开（见 core/types 的 usage 事件）。 */
type Usage = {
  input: number;
  output: number;
  parts?: { system: number; tools: number; messages: number };
};

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
  /** 提醒（不是错误）：如"这套配置还没密钥"。与 `error` 分开，因为"会失败"和"已经失败"该分开说 */
  const [warn, setWarn] = useState<string | null>(null);
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
  const [uses, setUses] = useState<Usage[]>([]);
  /** 窗口外观按系统分区：macOS 无标题栏、Windows 一整行。见 `main/index.ts` 的 `WINDOW_CHROME`。 */
  const platform = window.tm.platform;
  const [collapsed, setCollapsed] = useState(false);
  /** 左栏两段各自的折叠状态：默认都展开，用户想专心看目录时可以收掉会话。 */
  const [showSessions, setShowSessions] = useState(true);
  const [showTree, setShowTree] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /**
   * 贴着底部才跟着新内容走。
   *
   * 不加这条的话流式输出期间**滑不上去**：`live` 每来一个 `text.delta` 就变一次，
   * 每次都把 scrollTop 拉到 scrollHeight——用户往上翻一像素就被拽回来。
   * 只在"他本来就在底部附近"时才跟，他主动往上翻了就由他。
   */
  const pinnedRef = useRef(true);
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
      setWarn(opened.modelWarning ?? null);
      // 切会话落在底部：上一个会话里往上翻过的位置不该带过来（历史整个换掉了）
      pinnedRef.current = true;
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
      if (e.type === "usage") setUses((prev) => [...prev, { input: e.input, output: e.output, parts: e.parts }]);
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

  // 位置由用户的滚动决定，不由每次渲染算——内容变高但 scrollTop 没动时不会触发 scroll 事件，
  // 所以"他没动过"这一点能一直保持，不会被新内容自己推翻
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const onScroll = (): void => {
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!pinnedRef.current) return;
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

  /** 输入框工具栏的 `@`：插在光标处并**立刻把候选菜单打开**——不打开的话，按钮看着没反应。 */
  const insertMention = (): void => {
    const el = textareaRef.current;
    if (el === null) return;
    const at = el.selectionStart ?? draft.length;
    const next = `${draft.slice(0, at)}@${draft.slice(at)}`;
    setDraft(next);
    el.focus();
    // 等 React 把新值写进 DOM，再定光标位置并扫描
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = at + 1;
      scanMenu(next, at + 1);
    });
  };

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

  /**
   * 跑一条 `/` 命令。表在 `commands.ts`（名字与 CLI 一致），行为在这里——与 CLI 那个 switch 同形。
   *
   * 输出一律进右栏：`docs/ui.md` 那条"需要展示详细的，都在右栏"，对话里连一行都不留
   * （右栏弹出来就是反馈，再在对话里说一句"我打开了右栏"是噪音）。
   */
  const runCommand = useCallback(
    async (name: string): Promise<void> => {
      try {
        if (name === "status") {
          setPane({ kind: "text", name: "现状", text: await window.tm.projectStatus(project.id) });
        } else if (name === "permissions") {
          setPane({ kind: "text", name: "规则表", text: await window.tm.permissions() });
        }
      } catch (err) {
        // 命令失败要说出来：静默什么都不发生，人就以为是自己打错了
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [project.id],
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
    // 前缀匹配：命令表就两条，打一半就该收窄；子串匹配会让 `/e` 这种明明没戏的前缀也留下候选
    return COMMANDS.filter((c) => c.name.startsWith(menu.token)).map((c) => ({
      key: c.name,
      label: `/${c.name}`,
      hint: c.hint,
      run: () => pick("", () => void runCommand(c.name)),
    }));
  }, [menu, pick, runCommand, tree]);

  function send(): void {
    const text = draft.trim();
    if (!text || busy) return;
    // 斜杠开头的行永远不发给模型——与 CLI 一致（那边 `startsWith("/")` 拦下一切，未知的只回一句）。
    // 命令不存在时菜单里已经写着「没有这个命令」，这里不发送、也不清草稿，文本留着让人改。
    if (text.startsWith("/")) return;
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

  const isMac = platform === "darwin";
  const isWin = platform === "win32";
  const collapseLabel = collapsed ? "展开侧边栏" : "收起侧边栏";
  /** 中栏顶部显示的是**会话名**（书名在左栏品牌行里）——与参考界面一致。 */
  const sessionTitle = sessions.find((s) => s.id === current)?.title ?? info?.book ?? "正在开会话…";

  return (
    <div className={`app platform-${platform}`} data-collapsed={collapsed}>
      {isWin && (
        <div className="titlebar">
          <button className="collapse" aria-label={collapseLabel} aria-pressed={collapsed} onClick={() => setCollapsed((v) => !v)}>
            <PanelIcon open={collapsed} />
          </button>
        </div>
      )}
      <div className="shell">
      <aside className="side">
        {!isWin && (
          <div className={`railtop${isMac ? " has-lights" : ""}`}>
            <button className="collapse" aria-label={collapseLabel} aria-pressed={collapsed} onClick={() => setCollapsed((v) => !v)}>
              <PanelIcon open={collapsed} />
            </button>
          </div>
        )}
        <div className="brand">
          <span className="mark">t</span>
          <b>talemate</b>
          <span className="bookname">{project.title}</span>
          <button className="book-exit" onClick={onExit}>所有作品</button>
        </div>
        <button className="newbtn" onClick={() => void enter()}>
          <PlusIcon /> 新会话
        </button>
        {/* 一整条滚动，两段各自可折叠：不再有两个嵌套滚动条，也没有拍脑袋的高度上限 */}
        <div className="rail-scroll">
          <button className="section-head" aria-expanded={showSessions} onClick={() => setShowSessions((v) => !v)}>
            <ChevronIcon open={showSessions} />
            会话
            <span className="count">{sessions.length}</span>
          </button>
          {showSessions && (
            <div className="list sessions">
              {sessions.map((s) => (
                <button key={s.id} className="sess" aria-current={s.id === current} onClick={() => void enter(s.id)}>
                  <span className="title">{s.title}</span>
                  <span className="when">{when(s.updatedAt)}</span>
                </button>
              ))}
            </div>
          )}

          <button className="section-head" aria-expanded={showTree} onClick={() => setShowTree((v) => !v)}>
            <ChevronIcon open={showTree} />
            目录
          </button>
          {showTree && (
            <div className="list docs">
              <DocTree
                nodes={tree}
                current={pane?.kind === "doc" ? pane.path : null}
                onOpen={(n) => void openDoc(n)}
                onMention={(n) => setDraft((d) => (d === "" ? `@${n.name} ` : `${d}@${n.name} `))}
              />
            </div>
          )}
        </div>
        {/* 设置从左下角起（原来是状态栏最右）——对应参考界面账号的位置 */}
        <div className="rail-tail">
          <button className="settings" title="模型与设置" onClick={onSettings}>
            <span className="avatar"><SlidersIcon /></span>
            <span>设置</span>
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="head">
          <div className="book-name">{sessionTitle}</div>
          {/* 模式徽章从中栏顶部起（原来在状态栏左侧） */}
          {state.mode !== undefined && <span className="mode"><i />{state.mode}</span>}
          {state.pending !== undefined && <span className="badge zhu">待你拍板：{state.pending}</span>}
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
          {warn !== null && <p className="note zhu">［提醒］{warn}</p>}
          {error !== null && <p className="note">［错误］{error}</p>}
        </div>

        <div className="composer">
          <div className="box">
            {menu !== null && (
              <div className="menu">
                {menuItems.length === 0 ? (
                  // 空候选也要说一句：什么都不显示，人会以为是自己打错了键
                  <div className="menu-empty">
                    {menu.kind === "slash" ? "（没有这个命令）" : "（没有这个文档）"}
                  </div>
                ) : (
                  menuItems.map((it, i) => (
                    <button
                      key={it.key}
                      className={`pop-item${i === menuIndex ? " sel" : ""}`}
                      onMouseEnter={() => setMenuIndex(i)}
                      onClick={() => it.run()}
                    >
                      {it.label}
                      {it.hint !== undefined && <span className="pop-hint">{it.hint}</span>}
                    </button>
                  ))
                )}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={draft}
              placeholder="说点什么…"
              onChange={(e) => {
              setDraft(e.target.value);
              scanMenu(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
              onKeyDown={(e) => {
                // 输入法正在组合时，回车是在选字（中文输入的常规操作）——不是发送，也不是选命令
                if (e.nativeEvent.isComposing) return;
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
              <button className="tool" title="提及文档" onClick={insertMention}>
                @
              </button>
              <span className="spacer" />
              {info !== null && (
                <ModelEffortChip
                  model={info.model}
                  effort={info.effort}
                  profile={info.profile}
                  profiles={profiles}
                  onModel={(profile, m) => {
                    void window.tm.useProfile(profile, m);
                    setInfo({ ...info, model: m });
                  }}
                  onEffort={(v) => {
                    setInfo({ ...info, effort: v });
                    void window.tm.setEffort(v);
                  }}
                />
              )}
              <StyleChip view={style} onPick={(n) => void pickStyle(n)} />
              {busy && (
                <button className="tool stop" title="停下" onClick={() => window.tm.stop()}>
                  ■
                </button>
              )}
              <button className="send" title="发送" onClick={send} disabled={busy || !draft.trim()}>
                ↑
              </button>
            </div>
          </div>
          {/* 上下文与用量：居中的一条细信息（原来占着整条状态栏） */}
          <ContextStats uses={uses} win={win} baseline={info?.contextParts} />
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

    </div>
  );
}

/** 点外面就收：一层透明垫子，比全局监听便宜，也不会漏掉哪个角落。 */
function Mask({ onClose }: { onClose: () => void }) {
  return <span className="pop-mask" onClick={onClose} />;
}

/**
 * 模型 + 推理强度合成一个入口（`模型 · 推理`）。
 *
 * 两级：一级两行（模型 / 推理等级），二级是各自的候选。**Esc 退一级**——二级回到一级，
 * 一级再按才收起。这条是照着参考界面的操作逻辑来的，不是一次全关。
 */
function ModelEffortChip({
  model,
  effort,
  profile,
  profiles,
  onModel,
  onEffort,
}: {
  model: string;
  effort: string;
  /** 当前这套配置在清单里的名字。模型只在**同一个厂商**里换，不该跨厂商。 */
  profile?: string;
  profiles: { name: string; models: string[] }[];
  onModel: (profile: string, model: string) => void;
  onEffort: (v: string) => void;
}) {
  const EFFORT: [string, string][] = [["off", "关"], ["low", "低"], ["high", "高"], ["max", "最高"]];
  const [level, setLevel] = useState<"closed" | "menu" | "model" | "effort">("closed");
  const close = useCallback(() => setLevel("closed"), []);
  const effortText = EFFORT.find(([v]) => v === effort)?.[1] ?? effort;
  // 认厂商：优先用会话记着的那个名字；旧会话没记名字时，只有"唯一一个包含这个模型"的
  // 配置才敢认它（两个配置都有同名模型时宁可不猜）。
  const owners = profiles.filter((p) => p.models.includes(model));
  const current = profiles.find((p) => p.name === profile) ?? (owners.length === 1 ? owners[0] : undefined);

  useEffect(() => {
    if (level === "closed") return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      // 二级 → 一级；一级 → 收起。
      setLevel((l) => (l === "menu" ? "closed" : "menu"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [level]);

  return (
    <span className="pop-wrap">
      <button
        className="chip"
        aria-expanded={level !== "closed"}
        aria-haspopup="menu"
        onClick={() => setLevel((l) => (l === "closed" ? "menu" : "closed"))}
      >
        <span className="dot" />
        {model} · {effortText}
        <span className="caret">▾</span>
      </button>

      {level !== "closed" && <Mask onClose={close} />}

      {level === "menu" && (
        <span className="pop modelpop">
          <button className="mrow" onClick={() => setLevel("model")}>
            <span className="mlabel">模型</span>
            <span className="mval">{model}</span>
            <span className="chev">›</span>
          </button>
          <button className="mrow" onClick={() => setLevel("effort")}>
            <span className="mlabel">推理等级</span>
            <span className="mval">{effortText}</span>
            <span className="chev">›</span>
          </button>
        </span>
      )}

      {level === "model" && (
        <span className="pop modelpop">
          {current === undefined ? (
            // 认不出厂商（如环境变量那套）：只报当前的，不给跨厂商切
            <button className="pop-item" aria-current="true" onClick={close}>
              {model}
              <span className="pop-hint">当前</span>
            </button>
          ) : (
            current.models.map((m) => (
              <button
                key={m}
                className="pop-item"
                aria-current={m === model}
                onClick={() => {
                  onModel(current.name, m);
                  close();
                }}
              >
                {m}
              </button>
            ))
          )}
        </span>
      )}

      {level === "effort" && (
        <span className="pop modelpop">
          {EFFORT.map(([v, text]) => (
            <button
              key={v}
              className="pop-item"
              aria-current={v === effort}
              onClick={() => {
                onEffort(v);
                close();
              }}
            >
              {text}
              <span className="pop-hint">{v}</span>
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

/**
 * 文风：这本书用哪种声音写。选中即写进核心设定的「文风」格——**不经过模型**。
 *
 * 触发按钮上显示的是卡的**中文名**（`title`），不是写进 core.md 的那个 id。
 */
function StyleChip({ view, onPick }: { view: StyleCatalog | null; onPick: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  if (view === null) return null;
  const now = view.cards.find((c) => c.name === view.current.name);
  return (
    <span className="pop-wrap">
      <button className="chip" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((v) => !v)}>
        文风 {now?.title ?? view.current.name}
        <span className="caret">▾</span>
      </button>
      {open && (
        <>
          <Mask onClose={close} />
          <span className="pop stylepop">
            {/* 格里的字不是卡名时 harness 会带一句说明，且实际用的是默认那张——这一行必须显示出来 */}
            {view.current.note !== undefined && <div className="pop-note">{view.current.note}</div>}
            {view.cards.map((c) => (
              <button
                key={c.name}
                className="pop-item lined"
                aria-current={c.name === view.current.name}
                onClick={() => {
                  close(); // 先收：写盘和可能的报错在别处
                  onPick(c.name);
                }}
              >
                {c.title}
                <span className="sub">{c.description}</span>
              </button>
            ))}
            {/* 占位入口，故意 disabled：能点却什么都不发生比不摆更糟 */}
            <button className="pop-item lined" disabled>
              自定义…
              <span className="sub">还没做——先占个位置</span>
            </button>
          </span>
        </>
      )}
    </span>
  );
}

/**
 * 上下文：一个环形百分比，点开是**真实总量 + 分摊出来的构成**。
 *
 * 构成只给比例：`usage.parts` 是这次请求三段的字符数，界面按比例摊 provider 报回的真总数，
 * 所以分量标「~」。总量是真的，构成是分摊的——不冒充精确（参考界面也是这么标的）。
 */
function ContextStats({
  uses,
  win,
  baseline,
}: {
  uses: Usage[];
  win: number;
  /** 这一次请求的段大小（新建/续聊时由 harness 算好）。一行正文都没写时靠它显示基线。 */
  baseline?: { system: number; tools: number; messages: number };
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const last = uses[uses.length - 1] ?? { input: 0, output: 0 };
  // 有真用量用真的；还没有就退回基线——系统提示词与工具定义在第一次请求之前就已经占着窗口了。
  const parts = last.parts ?? baseline;
  const chars = parts === undefined ? 0 : parts.system + parts.tools + parts.messages;
  /** 粗估 token（只给基线用）：中英混排按约 2.5 字符一个。标「~」，不冒充真数。 */
  const estimated = Math.round(chars / 2.5);
  const measured = uses.length > 0;
  const input = measured ? last.input : estimated;
  const pct = Math.round((input / win) * 100);
  const share = (n: number): number => (chars === 0 ? 0 : Math.round((last.input * n) / chars));
  const R = 7;
  const C = 2 * Math.PI * R;

  return (
    <div className="stats">
      <span className="pop-wrap">
        <button className="ctxbtn" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((v) => !v)}>
          <svg className="ring" viewBox="0 0 18 18" aria-hidden="true">
            <circle className="track" cx="9" cy="9" r={R} fill="none" strokeWidth="2.4" />
            <circle
              className="arc"
              cx="9"
              cy="9"
              r={R}
              fill="none"
              strokeWidth="2.4"
              strokeDasharray={`${(C * Math.min(100, pct)) / 100} ${C}`}
            />
          </svg>
          {measured ? `${pct}%` : `~${pct}%`}
        </button>
        {open && (
          <>
            <Mask onClose={close} />
            <span className="pop ctxpop">
              <div className="ctxhead">
                <span>上下文已用 <b>{pct}%</b></span>
                <span className="total">{measured ? tokens(last.input) : `~${tokens(estimated)}`} / {tokens(win)}</span>
              </div>
              {parts !== undefined && (
                <>
                  <span className="segbar" aria-hidden="true">
                    <i className="sys" style={{ width: `${(parts.system / chars) * 100}%` }} />
                    <i className="tool" style={{ width: `${(parts.tools / chars) * 100}%` }} />
                    <i className="msg" style={{ width: `${(parts.messages / chars) * 100}%` }} />
                  </span>
                  <div className="legend">
                    <div className="lrow"><span className="sq sys" />系统提示词<span className="v">~{tokens(share(parts.system))}</span></div>
                    <div className="lrow"><span className="sq tool" />工具定义<span className="v">~{tokens(share(parts.tools))}</span></div>
                    <div className="lrow"><span className="sq msg" />对话消息<span className="v">~{tokens(share(parts.messages))}</span></div>
                  </div>
                  <div className="ctxfoot">总量是 provider 报回的真数；构成按请求各段的字数分摊，所以标“~”。</div>
                </>
              )}
              {parts === undefined && <div className="ctxfoot">还没有可用的分段数据。</div>}
              {!measured && parts !== undefined && (
                <div className="ctxfoot">还没发过话；这是按请求各段字数估的基线，标「~」。</div>
              )}
            </span>
          </>
        )}
      </span>
      <span>上下文约 {measured ? tokens(last.input) : `~${tokens(estimated)}`} / {tokens(win)}</span>
      <span className="sep">·</span><span>{uses.length} 轮</span>
    </div>
  );
}
