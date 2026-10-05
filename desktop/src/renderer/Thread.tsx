/**
 * 对话区。**这一块是界面里最要紧的**，因为它同时装着性质完全不同的东西：
 * 用户说的话、mate 说的话、跑过的工具、摆出来的提案、要用户点头的落盘、要用户回答的问题。
 * 全画成一样的块，就会糊成一片——所以按"谁在说话 / 要不要你动手"分四种画法：
 *
 * | 是什么 | 怎么画 |
 * |---|---|
 * | 用户说的话 | **右侧气泡**（只有它是气泡：它是一次打断，不是正文） |
 * | mate 说的话 | **页面正文**（宋体、无边框、内容列宽），靠 markdown 结构分区 |
 * | 跑过的工具 | **折成一组**：一行"用了 N 步"，展开才看见细节。工具是过程，不是内容 |
 * | 要动手的 | **卡片**：提案 / 落盘确认 / 提问，动作按钮长在卡片上 |
 *
 * **正文不铺在这里**（用户定的）：mate 写一章时那几千字是"稿子"，对话里只给一张进度卡——
 * 写着写着把对话淹掉，是这一类界面最容易变乱的地方。
 */
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useMemo, useState } from "react";
import type { AskRequest, ConfirmRequest, StoredMessage } from "../shared/api";
import { VERDICT_TEXT } from "../shared/verdict";

/**
 * mate 说的话是 **markdown**（加粗、列表、行内代码），所以得渲染，不能当纯文本贴出来——
 * 贴出来就是一堆 `**星号**`，而"渲染过的回复"正是别人那套看起来不像草稿的原因之一。
 *
 * **必过 DOMPurify**：它和右栏预览走的是同一件事（外部文本进渲染层），而渲染层有网络。
 * 两处共用 `.md` 那一套元素样式（在 `styles.css` 里只写一份）。
 */
function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false })), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

export type LiveItem =
  | { kind: "me"; text: string }
  | { kind: "text"; text: string }
  | { kind: "think"; text: string }
  | { kind: "tool"; name: string; subject?: string; output?: string }
  | { kind: "chapter"; path: string; words: number }
  | { kind: "proposal"; text: string }
  | { kind: "note"; text: string };

/** 一格"跑的这些东西"：连续的几个工具调用 + 稿子进度，合成一段可展开的过程。 */
export type Step =
  | { kind: "tool"; name: string; subject?: string; output?: string }
  | { kind: "chapter"; path: string; words: number };

/**
 * 工具调用按**它动的是什么**分两种画法。
 *
 * `write` 往 `chapters/` 里写 = 写正文：那几千字不进对话，只报"正在写第几章、多少字"。
 * 别的（读文档、委派、查资料）都是过程，折进"用了 N 步"里。
 */
export function classifyStep(name: string, input?: string): Step {
  if (name === "write" && input !== undefined) {
    try {
      const args = JSON.parse(input) as { path?: string; content?: string };
      if (typeof args.path === "string" && args.path.startsWith("chapters/")) {
        return { kind: "chapter", path: args.path, words: (args.content ?? "").length };
      }
    } catch {
      // input 不是合法 JSON（流被截断等）→ 当普通工具处理，别把一格内容弄丢
    }
  }
  return { kind: "tool", name };
}

/** 长结果只留个头，并说清"还有多少"——**别让一句证据占掉半屏**，也别让人以为就这么多。 */
function truncate(text: string, max = 160): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max)}…（还有 ${one.length - max} 字）`;
}

/**
 * 推理：**收起成一行**，点开看全文。它是过程，不是结论；但"它想过什么"有时正是你要的。
 *
 * 两个状态用同一个词：正在跑是**「思考中…」+ 脉搏 + 秒数**（这是"它没死"最直接的那句话），
 * 跑完是**「思考过程」+ 字数**，并且**默认重新收起**（过程不该事后还占着地方）。
 * 两处的形状也一样：一个词 + 一个灰色的数字，只有词在变。
 */
function Thought({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="steps">
      <button className="steps-head" onClick={() => setOpen((v) => !v)}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        {live && <span className="pulse" />}
        {live ? "思考中…" : "思考过程"}
        {!open && <span className="secs">{text.length.toLocaleString()} 字</span>}
      </button>
      {open && <div className="steps-body thought">{text}</div>}
    </div>
  );
}

/**
 * 一行的"它在干活"状态，跑的时候**带秒数**。
 *
 * 秒数不是装饰：默认 `TALEMATE_REASONING=off` 时根本没有推理流，模型就是静静想三十秒——
 * 光一句「思考中」，用户还是不知道它是在想还是死了。数字在动，就说明它还活着。
 * 秒数从**这个组件挂上来的那一刻**算起，等于这一段的起点，不用外面再传一个时间进来。
 */
function Activity() {
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(since);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.round((now - since) / 1000);
  return (
    <div className="activity">
      <span className="pulse" />
      思考中…
      {secs >= 2 && <span className="secs">{secs}s</span>}
    </div>
  );
}

/**
 * 工具 id → **人话**。两条规矩：
 *
 * 1. **不带"了"。** 这一行是"这一步在做什么"的摘要，不是记账；每一条都缀一个"了"，
 *    读起来就是流水账（"读了…、写了…、交了…"）。用动词短语的名词式：查阅、撰写、委派。
 * 2. **一个都不许漏。** 表里没有的 id 会把英文名直接漏到界面上（`enter-draft` 就是这么露出来的），
 *    漏了就是界面在说行话。
 */
const TOOL_WORDS: Record<string, string> = {
  read: "查阅文档",
  list: "翻看目录",
  search: "检索项目",
  write: "写文件",
  edit: "修改文档",
  delete: "删除文档",
  task: "委派子代理",
  websearch: "检索资料",
  webfetch: "查阅网页",
  recall: "翻考据本",
  remember: "记录考据",
  "ask-user": "向你提问",
  confirm: "征求确认",
  "propose-plan": "提交章节规划",
  "propose-design": "提交设计稿",
  "apply-design": "落盘设计稿",
  "enter-draft": "进入草稿模式",
  "exit-draft": "离开草稿模式",
  "design-spec": "取结构规范",
  skill: "载入规范",
};

/** 工具 id → 人话；认不出就照名字说（"调用 xxx"），不硬凑动词。 */
function toolWord(name: string): string {
  return TOOL_WORDS[name] ?? `调用 ${name}`;
}

/**
 * **它动的是什么**：读了哪个文件、搜了什么词、派给谁。
 *
 * 这些都在工具调用的入参里，而展开那一行原来**只有名字**——"读了文档"却不说是哪一份，
 * 等于没说。取值按常见字段挨个试：`path` / `query` / `url` / `agent` / `name`，规划还看 `chapter`。
 */
export function subjectOf(input?: string): string | undefined {
  if (input === undefined || input === "") return undefined;
  try {
    const a = JSON.parse(input) as Record<string, unknown>;
    for (const key of ["path", "query", "url", "agent", "name", "section"]) {
      const v = a[key];
      if (typeof v === "string" && v.trim() !== "") return v;
    }
    if (typeof a.chapter === "number") return `第 ${a.chapter} 章`;
    return undefined;
  } catch {
    return undefined; // 入参不是合法 JSON（流被截断等）→ 只是没细节，别把这一格弄丢
  }
}

/** 一组过程说成一句话：同名归并加次数，按先后顺序排。 */
function stepWords(steps: Step[]): string {
  const counts = new Map<string, number>();
  for (const s of steps) {
    const word = s.kind === "chapter" ? "撰写正文" : toolWord(s.name);
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts].map(([word, n]) => (n > 1 ? `${word} ${n} 次` : word)).join(" · ");
}

/** `chapters/chapter_ch3_v2.md` → 第 3 章 · 第 2 稿。改不动就原样显示。 */
function chapterLabel(path: string): string {
  const m = /^chapters\/chapter_ch(\d+)_v(\d+)\.md$/.exec(path);
  return m === null ? path : `第 ${m[1]} 章 · 第 ${m[2]} 稿`;
}

export function Thread({
  history,
  live,
  busy,
  confirm,
  ask,
  onReply,
  onVerdict,
  onOpenDoc,
  onOpenDiff,
}: {
  history: StoredMessage[];
  live: LiveItem[];
  /** 这一轮还没跑完——用它决定"正在想"要不要动 */
  busy: boolean;
  confirm: ConfirmRequest | null;
  ask: AskRequest | null;
  onReply: (id: string, value: string) => void;
  onVerdict: (text: string) => void;
  /** 点"稿子"卡 → 右栏读全文（对话里只留这一行） */
  onOpenDoc: (path: string) => void;
  /** 点"看改动" → 右栏显示 diff */
  onOpenDiff: (name: string, text: string) => void;
}) {
  const rows: React.ReactNode[] = [];
  history.forEach((m, i) => rows.push(<Stored key={m.seq ?? i} m={m} onOpenDoc={onOpenDoc} />));

  // 实时那一段：把连续的过程合成一组，"说出来的话"才另起一块
  let steps: Step[] = [];
  const flush = (): void => {
    if (steps.length) {
      rows.push(<Steps key={`s${rows.length}`} steps={steps} running={steps.length > 0} onOpenDoc={onOpenDoc} />);
      steps = [];
    }
  };
  live.forEach((it, i) => {
    if (it.kind === "tool") steps.push({ kind: "tool", name: it.name, subject: it.subject, output: it.output });
    else if (it.kind === "chapter") steps.push({ kind: "chapter", path: it.path, words: it.words });
    else {
      flush();
      if (it.kind === "me") rows.push(<Me key={`l${i}`} text={it.text} />);
      if (it.kind === "text") rows.push(<Said key={`l${i}`} text={it.text} />);
      if (it.kind === "think") rows.push(<Thought key={`l${i}`} text={it.text} live={busy && i === live.length - 1} />);
      if (it.kind === "proposal") rows.push(<Proposal key={`l${i}`} text={it.text} onVerdict={onVerdict} />);
      if (it.kind === "note") rows.push(<p key={`l${i}`} className="note">{it.text}</p>);
    }
  });
  flush();

  // 末尾那条"它在干活"：屏幕上已经有在动的东西（正在想的推理 / 正在做的步骤 / 正在涌出的正文）时
  // 不再叠一句——**同一件事说两遍，比不说更乱**。
  const lastLive = live[live.length - 1];
  const showingActivity =
    lastLive !== undefined &&
    (lastLive.kind === "think" || lastLive.kind === "tool" || lastLive.kind === "chapter" || lastLive.kind === "text");
  if (busy && !showingActivity && confirm === null && ask === null) rows.push(<Activity key="act" />);

  if (confirm !== null) rows.push(<Confirm key="c" req={confirm} onReply={onReply} onOpenDiff={onOpenDiff} />);
  if (ask !== null) rows.push(<Ask key="a" req={ask} onReply={onReply} />);

  return <div className="thread">{rows}</div>;
}

/** 一条落盘的消息。认不出的角色与单元一律不画——界面不替 harness 编故事。 */
function Stored({ m, onOpenDoc }: { m: StoredMessage; onOpenDoc: (path: string) => void }) {
  if (m.role === "user") return <Me text={m.text ?? ""} />;
  if (m.role === "compaction") return <p className="note">（前情摘要：{m.summary?.slice(0, 50) ?? ""}…）</p>;
  if (m.role !== "assistant") return null;

  const out: React.ReactNode[] = [];
  let steps: Step[] = [];
  const flush = (): void => {
    if (steps.length) {
      out.push(<Steps key={`s${out.length}`} steps={steps} onOpenDoc={onOpenDoc} />);
      steps = [];
    }
  };
  (m.parts ?? []).forEach((p, i) => {
    // **`output` 必须带上**：从盘上载入的历史里原来只取了 input，于是展开那一行只剩一个名字
    if (p.type === "tool") {
      const step = classifyStep(p.name, p.input);
      steps.push(step.kind === "chapter" ? step : { ...step, subject: subjectOf(p.input), output: p.output });
    }
    else if (p.type === "text") {
      flush();
      out.push(<Said key={`t${i}`} text={p.text} />);
    }
    // 推理不画：要看它得做成折叠块，那是后面的事
  });
  flush();
  return <>{out}</>;
}

function Me({ text }: { text: string }) {
  return (
    <div className="me">
      <div className="bubble">{text}</div>
    </div>
  );
}

function Said({ text }: { text: string }) {
  return <Markdown text={text} />;
}

/** 过程折叠：一行摘要 + 展开。工具是过程，一眼扫过就行，别占着对话的地方。 */
function Steps({ steps, running, onOpenDoc }: { steps: Step[]; running?: boolean; onOpenDoc: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const words = stepWords(steps);

  return (
    <div className="steps">
      <button className="steps-head" onClick={() => setOpen((v) => !v)}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        {words}
      </button>
      {open && (
        <div className="steps-body">
          {steps.map((s, i) =>
            s.kind === "chapter" ? (
              <button className="chapter" key={i} onClick={() => onOpenDoc(s.path)} title="在右栏打开">
                <span className="label">稿子</span>
                {chapterLabel(s.path)}
                <span className="words">{s.words.toLocaleString()} 字</span>
                <span className="caret">›</span>
              </button>
            ) : (
              <div className="step" key={i}>
                <span className="tool-name">{toolWord(s.name)}</span>
                {s.subject !== undefined && <span className="tool-subject">{truncate(s.subject, 60)}</span>}
                {s.output !== undefined && <span className="tool-out">{truncate(s.output)}</span>}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 摆出来的提案（设计稿 / 章节规划）。**动作长在卡片上**——三向裁决就是三个按钮，不另起一行问。
 * 按钮说的是 `VERDICT_TEXT` 里那两句固定的话（判定在 harness，见 `shared/verdict.ts`）。
 */
function Proposal({ text, onVerdict }: { text: string; onVerdict: (text: string) => void }) {
  const [done, setDone] = useState<string | null>(null);
  const [refining, setRefining] = useState(false);
  const [note, setNote] = useState("");

  return (
    <div className="card-box">
      <div className="card-title">有一份要你拍板的东西</div>
      <pre className="proposal">{text}</pre>
      {done === null ? (
        refining ? (
          <div className="card-actions">
            <input
              autoFocus
              placeholder="要改哪里？"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && note.trim()) {
                  onVerdict(note.trim());
                  setDone("已提意见");
                }
              }}
            />
            <button className="btn primary" onClick={() => note.trim() && (onVerdict(note.trim()), setDone("已提意见"))}>
              提
            </button>
            <button className="btn" onClick={() => setRefining(false)}>
              算了
            </button>
          </div>
        ) : (
          <div className="card-actions">
            <button
              className="btn primary"
              onClick={() => {
                onVerdict(VERDICT_TEXT.accept);
                setDone("已接受");
              }}
            >
              接受
            </button>
            <button
              className="btn zhu"
              onClick={() => {
                onVerdict(VERDICT_TEXT.reject);
                setDone("已拒绝");
              }}
            >
              拒绝
            </button>
            <button className="btn" onClick={() => setRefining(true)}>
              提意见…
            </button>
          </div>
        )
      ) : (
        <div className="card-done">{done}（mate 接着往下做）</div>
      )}
    </div>
  );
}

/** 落盘确认：影响面在上、这次动什么在下（材料顺序同 harness 给的那两段）。 */
function Confirm({
  req,
  onReply,
  onOpenDiff,
}: {
  req: ConfirmRequest;
  onReply: (id: string, value: string) => void;
  onOpenDiff: (name: string, text: string) => void;
}) {
  const lines = req.summary.split("\n");
  const head = lines[0] ?? "";
  const body = lines.slice(1).join("\n").trim();

  return (
    <div className="card-box">
      <div className="card-title">要落盘</div>
      <div className="confirm-head">{req.action}</div>
      <pre className="proposal">{head}</pre>
      {body !== "" && (
        // 细节去右栏（"需要展示详细的都在右侧"）：这一行只是个**入口**，不在这里摊开
        <button className="steps-head" onClick={() => onOpenDiff(req.action, body)}>
          <span className="caret">›</span>
          看改动（右栏）
        </button>
      )}
      <div className="card-actions">
        <button className="btn primary" onClick={() => onReply(req.id, "once")}>
          允许一次
        </button>
        <button className="btn" onClick={() => onReply(req.id, "always")}>
          这一类都允许
        </button>
        <button className="btn zhu" onClick={() => onReply(req.id, "no")}>
          拒绝
        </button>
      </div>
    </div>
  );
}

/** 提问：mate 在等一个答案（`askUser`）。有选项就给按钮，没有就给输入框。 */
function Ask({ req, onReply }: { req: AskRequest; onReply: (id: string, value: string) => void }) {
  const [value, setValue] = useState("");
  const answer = (v: string): void => onReply(req.id, v);
  return (
    <div className="card-box">
      <div className="card-title">mate 在问你</div>
      <div className="ask-q">{req.question}</div>
      {req.options.length > 0 ? (
        <div className="card-actions">
          {req.options.map((o) => (
            <button key={o} className="btn" onClick={() => answer(o)}>
              {o}
            </button>
          ))}
        </div>
      ) : (
        <div className="card-actions">
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && value.trim() && answer(value.trim())}
          />
          <button className="btn primary" onClick={() => value.trim() && answer(value.trim())}>
            回答
          </button>
        </div>
      )}
    </div>
  );
}
