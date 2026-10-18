/**
 * 工作台：左栏（会话 + 这本书的文档）、中栏对话、右栏预览。
 *
 * 读模型是这里唯一的状态：进会话先拉一次历史投影（`tm.history`），之后靠 `LLMEvent` 增量往上拼，
 * 界面不发明任何业务状态——一条消息是谁写的、写完了没有，harness 说了算。这一层只管编排
 * （谁在哪儿、什么时候取数），画法全在 `Thread` 里。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AskAnswer, AskRecord, AskView, ConfirmRequest, DocNode, LLMEvent, OpenInfo, PermissionDefault, ProjectCard, ProposalDisplay, SessionRow, SessionState, StoredMessage, StyleCatalog, WriteChange } from "../shared/api";
import { composeAnnotationMessage, type Annotation } from "./annotations";
import { AskDock } from "./AskCard";
import { COMMANDS } from "./commands";
import { ConfirmDock } from "./ConfirmDock";
import { ProposalCard, type ProposalVerdict } from "./ProposalCard";
import { DocTree } from "./DocTree";
import { ChevronIcon, DropdownIcon, HistoryIcon, PanelIcon, PlusIcon, ShieldIcon, SlidersIcon } from "./icons";
import { applyReadingSize, DEFAULT_READING_SIZE } from "./reading";
import { SidePane, type Pane } from "./SidePane";
import { Thread, classifyStep, subjectOf, type LiveItem } from "./Thread";
import type { ChangeScope } from "./TurnChanges";
import { tokens } from "../shared/tokens";
import { contextWindow } from "../../../src/core/windows";

/**
 * 目录树里所有能打开的节点，拉平成一列——`@` 的候选、改动清单的显示名与先后都走它。
 *
 * `section` 是它所在的顶栏分段（角色 / 正文 / 现状…）。改动清单在扁平的行里还需要这层
 * 信息，否则"沈越"和"第 6 章"看不出是哪一段的。
 */
function flatDocs(nodes: DocNode[], section = ""): { name: string; path: string; section: string }[] {
  const out: { name: string; path: string; section: string }[] = [];
  for (const n of nodes) {
    const sec = section === "" ? n.name : section;
    if (n.path !== undefined) out.push({ name: n.name, path: n.path, section: sec });
    if (n.children !== undefined) out.push(...flatDocs(n.children, sec));
  }
  return out;
}

/** 扁平后的一行怎么叫：角色/世界观这类分组带上段名，正文与顶层文档不重复写。 */
function changeLabel(d: { name: string; section: string }): string {
  return d.section === d.name || d.section === "正文" ? d.name : `${d.section} · ${d.name}`;
}

/** 共用一份空数组：右栏没有备注时传它，免得每次渲染都换一个新数组让记号 effect 重跑。 */
const NO_ANNOTATIONS: Annotation[] = [];

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
  const [ask, setAsk] = useState<AskView | null>(null);
  /** 提问卡是否收起成提示条；收起时输入框回来 */
  const [askHidden, setAskHidden] = useState(false);
  /** 排队中的迟到回答：等主进程送达后，把只读卡补进对话 */
  const queuedAsk = useRef<AskRecord | null>(null);
  /** 本屏已经答过的提问：让历史里那条 pending 过程行立刻停止“等待回答” */
  const [answeredAskIds, setAnsweredAskIds] = useState<Set<string>>(() => new Set());
  /**
   * 等待拍板的提案。和 ask / confirm 一样是道门：它在，输入框就让位，
   * 用户只能在卡里接受 / 拒绝 / 提意见；没有超时，没有收起。
   */
  const [proposal, setProposal] = useState<{ id: number; text: string; view?: ProposalDisplay } | null>(
    null,
  );
  const proposalSeq = useRef(0);
  /** 防止双击/回车+点击同时触发两次裁决：第一下之后就锁住，直到下一份提案进来。 */
  const resolvingProposal = useRef(false);
  /**
   * 这次请求累计产生的落盘改动。提案/提问会让回合提前结束，但用户要的是一整件事做完之后
   * 一张汇总卡——所以跨 halt 累计，直到“真的没有待拍板/待回答的东西”时再挂出去。
   */
  const taskChanges = useRef<WriteChange[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** 提醒（不是错误）：如"这套配置还没密钥"。与 `error` 分开，因为"会失败"和"已经失败"该分开说 */
  const [warn, setWarn] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [tree, setTree] = useState<DocNode[]>([]);
  const [pane, setPane] = useState<Pane | null>(null);
  /** 从改动记录点进某一份文档时，记着回去的那一屏 */
  const [backPane, setBackPane] = useState<Pane | null>(null);
  const [historyScope, setHistoryScope] = useState<ChangeScope>("session");
  /** 未提交的批注按文档路径存：切走再回来还在，关掉应用就没了（不落盘） */
  const [annotations, setAnnotations] = useState<Record<string, Annotation[]>>({});
  const [stale, setStale] = useState(false);
  const [state, setState] = useState<SessionState>({});
  const [paneWidth, setPaneWidth] = useState(460);
  /** 正常的打开动作会把"返回改动记录"清掉；从记录里点开的详情单独走 setBackPane */
  const openPane = useCallback((next: Pane | null): void => {
    setBackPane(null);
    setPane(next);
  }, []);
  /** 目录树的显示名与先后：改动清单按它排序、取名，不另写一份文档清单 */
  const docIndex = useMemo(() => {
    const map = new Map<string, { label: string; rank: number }>();
    flatDocs(tree).forEach((d, rank) => map.set(d.path, { label: changeLabel(d), rank }));
    return map;
  }, [tree]);
  const labelOf = useCallback(
    (path: string): string => docIndex.get(path)?.label ?? path.split("/").pop() ?? path,
    [docIndex],
  );
  const rankOf = useCallback(
    (path: string): number => docIndex.get(path)?.rank ?? Number.MAX_SAFE_INTEGER,
    [docIndex],
  );
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
      // 重开/刷新后仍开着的提问（主进程从 journal 或消息投影里取回）
      setAsk(opened.ask ?? null);
      setAskHidden(false);
      queuedAsk.current = null;
      setAnsweredAskIds(new Set());
      setProposal(null);
      resolvingProposal.current = false;
      taskChanges.current = [];
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
      const prefs = await window.tm.prefs();
      if (typeof prefs.paneWidth === "number") setPaneWidth(clampPane(prefs.paneWidth));
      applyReadingSize(prefs.fontSize ?? DEFAULT_READING_SIZE);
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
          case "tool-call.start":
            // 参数还在流：先占一个“准备中”的过程项，等 tool-call 到了再换成真步骤
            next.push({ kind: "tool", id: e.id, name: e.name, preparing: true });
            break;
          case "tool-call": {
            // 写正文只报进度、不铺字——那一块由 Thread 画成稿子卡
            const step = classifyStep(e.name, e.input);
            // 入参里就有"它动的是什么"——收在这一刻，别等结果回来才想起没记住
            const real = step.kind === "chapter" ? step : { ...step, id: e.id, subject: subjectOf(e.input) };
            const pending = next.findIndex(
              (it) => it.kind === "tool" && it.preparing === true && (it.id === e.id || it.name === e.name),
            );
            if (pending >= 0) next[pending] = real;
            else next.push(real);
            break;
          }
          case "step.end":
            // 被 halt 挡掉的剩余调用不会再有 tool-call；别让“准备中”永远挂在界面上
            return next.filter((it) => !(it.kind === "tool" && it.preparing === true));
          case "tool.result": {
            for (let i = next.length - 1; i >= 0; i--) {
              const it = next[i];
              if (it.kind === "tool" && it.name === e.name && it.output === undefined) {
                next[i] = { ...it, output: e.output.slice(0, 120), change: e.change, ask: e.ask };
                break;
              }
            }
            // 答完/取消的提问在对话里留一张只读卡；pending 的由底部卡片负责
            const asked = e.ask;
            if (
              asked !== undefined &&
              asked.outcome !== "pending" &&
              !next.some((it) => it.kind === "ask" && it.record.callId === asked.callId)
            ) {
              next.push({ kind: "ask", record: asked });
            }
            break;
          }
          default:
            break;
        }
        return next;
      });
      if (e.type === "tool.result" && e.change !== undefined) taskChanges.current.push(e.change);
      if (e.type === "proposal") {
        proposalSeq.current += 1;
        resolvingProposal.current = false;
        setProposal({
          id: proposalSeq.current,
          text: e.text,
          ...(e.view === undefined ? {} : { view: e.view }),
        });
      }
      if (e.type === "usage") setUses((prev) => [...prev, { input: e.input, output: e.output, parts: e.parts }]);
      if (e.type === "session.status") setBusy(e.status === "busy");
    });
    window.tm.onSessionState(setState);
    window.tm.onConfirm(setConfirm);
    window.tm.onAsk((view) => {
      setAsk(view);
      setAskHidden(false);
    });
    window.tm.onAskPending((p) => {
      setAsk((prev) =>
        prev !== null && prev.callId === p.callId
          ? { ...prev, pending: true, reason: p.reason, deadline: undefined }
          : prev,
      );
    });
    window.tm.onAskClosed((p) => {
      setAsk((prev) => (prev !== null && prev.callId === p.callId ? null : prev));
      setAskHidden(false);
      // 排队中的迟到回答送达了：把本地那份只读卡补进对话（同回合的回答由 tool.result 补）
      const rec = queuedAsk.current;
      if (rec !== null && rec.callId === p.callId) {
        queuedAsk.current = null;
        setLive((prev) =>
          prev.some((it) => it.kind === "ask" && it.record.callId === rec.callId)
            ? prev
            : [...prev, { kind: "ask", record: rec }],
        );
      }
    });
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

  /**
   * 「本轮改动」是**一次请求**的汇总，不是每个 halt、也不是每次落盘的汇总。
   *
   * `busy` 是 runLoop 的整体状态：最后一次工具调用、收尾的思考、以及最终那段总结都跑完，
   * 才会收到 session.status=idle。所以卡是在最终总结之后才挂到 live 末尾的——不是产物一落盘就出。
   *
   * 一次“新建两个角色和一份大纲”会因为提案/提问分成好几个回合；改动先在 taskChanges 里攒着，
   * 直到 busy=false 且真的没有待拍板提案（state.pending）、待回答问题、待确认审批时，才挂一张卡。
   * 用 state.pending 而不是界面里提案卡的数量：用户可能直接在输入框里回“没问题”，卡片没点过，
   * 但 harness 已经知道提案结了。
   */
  useEffect(() => {
    if (busy) return;
    // 提案弹窗本身也要算“还没完”：state.pending 与 proposal 事件是两条通道，任一条在等都先不挂卡
    if (proposal !== null || state.pending !== undefined || ask !== null || confirm !== null) return;
    const changes = taskChanges.current;
    if (changes.length === 0) return;
    taskChanges.current = [];
    setLive((prev) => [...prev, { kind: "changes", changes }]);
  }, [busy, proposal, state.pending, ask, confirm]);

  /** 点一份文档：取全文，右栏开着。现取——刚写完的那一版才是要看的 */
  const openDoc = useCallback(
    async (node: DocNode): Promise<void> => {
      if (node.path === undefined) return; // 纯分组节点（如"角色"）：点它不开文档
      const text = await window.tm.docText(project.id, node.path);
      openPane(text === undefined ? null : { kind: "doc", name: node.name, path: node.path, text });
    },
    [project.id, openPane],
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

  /** 对话里那张"稿子"卡：按路径去取全文，在右栏打开。显示名优先用目录里的那一个。 */
  const openChapter = useCallback(
    async (path: string): Promise<void> => {
      const text = await window.tm.docText(project.id, path);
      const name = flatDocs(tree).find((d) => d.path === path)?.name ?? path.split("/").pop() ?? path;
      openPane(text === undefined ? null : { kind: "doc", name, path, text });
    },
    [project.id, tree],
  );

  /** 打开改动记录：主进程按会话聚合，右栏只负责把路径换成显示名并分组。 */
  const openHistory = useCallback(
    async (scope: ChangeScope): Promise<void> => {
      try {
        const groups = await window.tm.changes(project.id);
        setHistoryScope(scope);
        setBackPane(null);
        setPane({ kind: "changes", name: "改动记录", groups, currentSessionId: current ?? "" });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [project.id, current],
  );

  /** 从改动记录点进一份文档：记住那一屏，左上角的「← 改动记录」才能回去。 */
  const openHistoryDoc = useCallback(
    async (path: string): Promise<void> => {
      const text = await window.tm.docText(project.id, path);
      if (text === undefined) return;
      setBackPane(pane);
      setPane({ kind: "doc", name: labelOf(path), path, text });
    },
    [project.id, pane, labelOf],
  );

  const openHistoryDiff = useCallback(
    (name: string, text: string, path: string): void => {
      setBackPane(pane);
      setPane({ kind: "diff", name, text, path });
    },
    [pane],
  );

  const goBack = useCallback((): void => {
    if (backPane === null) return;
    setPane(backPane);
    setBackPane(null);
  }, [backPane]);

  /**
   * 发一句话。`shown` 是气泡里显示的，`sent` 是真正发给 harness 的——两者可以不同：`@世界观`
   * 拼出来的 `<mentioned>` 段是给模型看的材料，不该糊在用户自己的气泡里（存进历史也一样丑）。
   * 三向裁决也走这里——按钮说的是固定短语，判定仍然在 harness（见 `shared/verdict.ts`）。
   */
  const say = useCallback((text: string, sent?: string): void => {
    setLive((prev) => [...prev, { kind: "me", text }]);
    window.tm.prompt(sent ?? text);
  }, []);

  /**
   * 提案拍板：发固定短语/意见 → 关掉弹窗 → 在对话里留一条只读记录。
   * 记录带着 view，点开能回看完整提案；「本轮改动」仍然等这一轮真正结束。
   */
  const resolveProposal = useCallback(
    (text: string, kind: ProposalVerdict): void => {
      const current = proposal;
      if (current === null || resolvingProposal.current) return;
      resolvingProposal.current = true;
      window.tm.prompt(text);
      setProposal(null);
      setLive((prev) => [
        ...prev,
        {
          kind: "proposal-done",
          title: current.view?.title ?? "提案",
          text: current.text,
          verdict: kind,
          ...(current.view === undefined ? {} : { view: current.view }),
        },
      ]);
    },
    [proposal],
  );

  /**
   * 回答底部提问卡。main 决定走哪条路：工具调用还开着 → 同一回合；已 pending → 新回合；
   * 这一轮还在跑 → 先排队。界面只根据返回值把卡片收起/翻成 pending。
   */
  const submitAsk = useCallback(
    async (answers: AskAnswer[]): Promise<"ok" | "stale" | "invalid" | "queued"> => {
      const currentAsk = ask;
      if (currentAsk === null) return "stale";
      let verdict: "ok" | "stale" | "invalid" | "queued";
      try {
        verdict = await window.tm.answerAsk({ callId: currentAsk.callId, answers });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return "invalid";
      }
      if (verdict === "ok" || verdict === "queued") {
        const record: AskRecord = {
          callId: currentAsk.callId,
          questions: currentAsk.questions,
          outcome: "answered",
          answers,
          at: Date.now(),
        };
        setAnsweredAskIds((prev) => new Set(prev).add(currentAsk.callId));
        // 只留只读回看卡，不再把答案伪装成用户手打的一句话塞进对话流
        setLive((prev) =>
          prev.some((it) => it.kind === "ask" && it.record.callId === record.callId)
            ? prev
            : [...prev, { kind: "ask", record }],
        );
        if (verdict === "queued") {
          queuedAsk.current = record;
          setAsk((prev) =>
            prev !== null && prev.callId === currentAsk.callId
              ? { ...prev, pending: true, deadline: undefined }
              : prev,
          );
          setLive((prev) => [...prev, { kind: "note", text: "这条回答先记着；这一轮结束后会自动送达。" }]);
        } else {
          setAsk(null);
          setAskHidden(false);
        }
      } else if (verdict === "stale") {
        setAsk(null);
        setAskHidden(false);
        setError("这个问题已经结束了——可能是另一个窗口先答了。");
      } else {
        setError("这条回答没有通过校验，请重新选一次。");
      }
      return verdict;
    },
    [ask],
  );

  /** 从过程行重新打开一个仍 pending 的提问；草稿由 AskDock 从本机恢复。 */
  const reopenAsk = useCallback((record: AskRecord) => {
    setAsk({
      callId: record.callId,
      questions: record.questions,
      pending: record.outcome === "pending",
      ...(record.outcome === "pending" ? { reason: "restarted" as const } : {}),
    });
    setAskHidden(false);
  }, []);

  /**
   * 提交翻到右栏里的备注：拼成一条普通用户消息，和手打走同一个 `say`；发出去就清空。
   * 发送失败会走 `tm:error` 在对话里说话——这条消息已经在对话里，不把备注放回来。
   */
  const submitAnnotations = useCallback(
    (path: string, label: string, notes: readonly Annotation[]): void => {
      const message = composeAnnotationMessage(label, path, notes);
      if (message === "") return;
      say(message);
      setAnnotations((prev) => ({ ...prev, [path]: NO_ANNOTATIONS }));
    },
    [say],
  );

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
          openPane({ kind: "text", name: "现状", text: await window.tm.projectStatus(project.id) });
        } else if (name === "permissions") {
          openPane({ kind: "text", name: "规则表", text: await window.tm.permissions() });
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
          <b>Talemate</b>
          <button className="book-exit" onClick={onExit}>所有作品</button>
        </div>
        <button className="newbtn" onClick={() => void enter()}>
          <PlusIcon /> 新会话
        </button>
        {/* 一整条滚动，两段各自可折叠：不再有两个嵌套滚动条，也没有拍脑袋的高度上限 */}
        <div className="rail-scroll">
          <button className="section-head" aria-expanded={showSessions} onClick={() => setShowSessions((v) => !v)}>
            <ChevronIcon open={showSessions} />
            <span className="section-title">{project.title}（会话）</span>
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
          <button
            type="button"
            className="history-entry"
            title="本次会话的改动记录"
            aria-current={pane?.kind === "changes" ? "true" : undefined}
            onClick={() => void openHistory("session")}
          >
            <HistoryIcon />
            改动记录
          </button>
        </header>

        <div className="scroll" ref={scrollRef}>
          <Thread
            history={history}
            live={live}
            busy={busy}
            confirmOpen={confirm !== null}
            proposalOpen={proposal !== null}
            askOpen={ask !== null}
            answeredAskIds={answeredAskIds}
            onOpenDoc={(path) => void openChapter(path)}
            onOpenDiff={(name, text, path) => openPane({ kind: "diff", name, text, path })}
            onOpenAsk={reopenAsk}
            labelOf={labelOf}
            rankOf={rankOf}
            onOpenHistory={() => void openHistory("session")}
          />
          {warn !== null && <p className="note zhu">［提醒］{warn}</p>}
          {error !== null && <p className="note">［错误］{error}</p>}
        </div>

        {/* 审批是道门：占住输入框、不能收起；没有回答方时主进程直接按拒绝处理 */}
        {confirm !== null ? (
          <div className="askdock">
            <ConfirmDock
              req={confirm}
              onReply={(value) => {
                window.tm.reply(confirm.id, value);
                setConfirm(null);
              }}
              onOpenDiff={(name, text) => openPane({ kind: "diff", name, text })}
            />
          </div>
        ) : proposal !== null ? (
          <div className="askdock">
            <ProposalCard
              key={proposal.id}
              text={proposal.text}
              view={proposal.view}
              onVerdict={resolveProposal}
            />
          </div>
        ) : ask !== null ? (
          <div className="askdock">
            <AskDock
              key={ask.callId}
              view={ask}
              sessionId={current ?? ""}
              hidden={askHidden}
              onHidden={setAskHidden}
              onSubmit={submitAsk}
              onHold={(mode) => window.tm.holdAsk(ask.callId, mode)}
            />
          </div>
        ) : null}

        {confirm === null && proposal === null && (ask === null || askHidden) && (
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
              placeholder={busy ? "搭档正在处理…（可以按 ■ 停止）" : "说点什么…"}
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
              <PermissionChip
                value={state.permissionMode ?? "accept-edits"}
                onChange={(v) => void window.tm.savePrefs({ permissionMode: v })}
              />
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
        )}
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
          busy={busy}
          onBack={backPane !== null ? goBack : undefined}
          historyScope={historyScope}
          onHistoryScope={setHistoryScope}
          labelOf={labelOf}
          rankOf={rankOf}
          onOpenDoc={(path) => void openHistoryDoc(path)}
          onOpenDiff={openHistoryDiff}
          annotations={pane.kind === "doc" ? (annotations[pane.path] ?? NO_ANNOTATIONS) : NO_ANNOTATIONS}
          onAnnotationsChange={(notes) => {
            if (pane.kind !== "doc") return;
            setAnnotations((prev) => ({ ...prev, [pane.path]: notes }));
          }}
          onSubmitAnnotations={(notes) => {
            if (pane.kind !== "doc") return;
            const label = flatDocs(tree).find((d) => d.path === pane.path)?.name ?? pane.name;
            submitAnnotations(pane.path, label, notes);
          }}
          onEditingChange={(v) => {
            editingRef.current = v;
          }}
          onClose={() => {
            openPane(null);
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
 * 输入区左侧的权限入口：和设置里的「权限」是同一个偏好。
 *
 * 它只回答"写文件要不要逐次确认"；计划/设计提案与 pending 落盘是另外几道门，
 * 不在这枚开关里，也不会被它自动点头。
 */
function PermissionChip({
  value,
  onChange,
}: {
  value: PermissionDefault;
  onChange: (value: PermissionDefault) => void;
}) {
  const [open, setOpen] = useState(false);
  const OPTIONS: [PermissionDefault, string, string][] = [
    ["accept-edits", "工作区内修改", "落盘不再逐次确认；计划与提案照常审阅"],
    ["ask", "每次询问", "每次改文件都先给你看 diff"],
  ];
  const current = OPTIONS.find(([v]) => v === value) ?? OPTIONS[0];

  return (
    <span className="pop-wrap">
      <button
        type="button"
        className="chip permission-chip"
        title="写文件权限"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <ShieldIcon />
        {current[1]}
        <DropdownIcon open={open} />
      </button>
      {open && <Mask onClose={() => setOpen(false)} />}
      {open && (
        <span className="pop perm-pop">
          {OPTIONS.map(([v, label, hint]) => (
            <button
              key={v}
              type="button"
              className="pop-item"
              aria-current={v === value ? "true" : undefined}
              onClick={() => {
                onChange(v);
                setOpen(false);
              }}
            >
              <span>{label}</span>
              <span className="pop-hint">{hint}</span>
            </button>
          ))}
        </span>
      )}
    </span>
  );
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
        <DropdownIcon open={level !== "closed"} />
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
        <DropdownIcon open={open} />
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
          <DropdownIcon open={open} />
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
