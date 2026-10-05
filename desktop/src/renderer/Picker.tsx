/**
 * 首屏：**书架**。一部长篇的周期以年计，一个人手里不会超过十本——所以这张屏值得占满，
 * 每本书也值得占一张**纵向长卡**（像一本立着的书），一屏三本、多了往下滚。
 *
 * 创建与修改共用同一套"基本盘"：**书名 · 频道 · 题材**。这三样是前期就能定下来的东西，
 * 选项来自 `shared/genres.ts`（那一份是产品数据，界面按它画、按它筛）。
 *
 * 它们写进 `talemate.json`（书架的元信息），**不是作品文档**——所以不经模型、不问权限。
 * `design/core.md` 里的「题材 · 频道」是模型据此展开的定位：前者是用户的声明，后者是产物。
 */
import { useState } from "react";
import type { ProjectCard } from "../shared/api";
import { CHANNELS, genresFor } from "../shared/genres";

/** "写到第 3 章" / "还没有正文"。 */
function progress(card: ProjectCard): string {
  return card.chapter === null ? "还没有正文" : `写到第 ${card.chapter} 章`;
}

function when(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const today = new Date();
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === today.toDateString() ? `今天 ${hhmm}` : `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 封面位上那一个字。取不到就用「书」；西文一律大写（封面上的字不会小写起头）。 */
function coverChar(title: string): string {
  const first = [...title.trim()][0];
  return first === undefined ? "书" : first.toUpperCase();
}

export function Picker({
  projects,
  onOpen,
  onCreated,
}: {
  projects: ProjectCard[];
  onOpen: (card: ProjectCard) => void;
  onCreated: () => Promise<void>;
}) {
  const [creating, setCreating] = useState(projects.length === 0);

  return (
    <div className="picker">
      <header className="shelf">
        <h1>talemate</h1>
        <p className="sub">
          {projects.length === 0 ? "还没有作品——给它起个名字就能开始。" : `${projects.length} 部作品`}
        </p>
      </header>

      <div className="cards">
        {projects.map((card) => (
          <Card key={card.id} card={card} onOpen={onOpen} />
        ))}
        {creating ? (
          <NewCard
            onCreated={onCreated}
            onOpen={onOpen}
            onCancel={projects.length > 0 ? () => setCreating(false) : undefined}
          />
        ) : (
          <button className="card new" onClick={() => setCreating(true)}>
            ＋ 新建作品
          </button>
        )}
      </div>
    </div>
  );
}

/** 书名 · 频道 · 题材——创建与修改共用的那一块。 */
function Basics({
  title,
  channel,
  genre,
  onChange,
}: {
  title: string;
  channel: string;
  genre: string;
  onChange: (next: { title?: string; channel?: string; genre?: string }) => void;
}) {
  return (
    <>
      <input
        autoFocus
        placeholder="书名"
        value={title}
        onChange={(e) => onChange({ title: e.target.value })}
      />
      <div className="chips">
        {CHANNELS.map((c) => (
          <button
            key={c}
            type="button"
            className="chip"
            aria-pressed={channel === c}
            // 换频道时把不在这个频道里的题材丢掉——留着会造出一个"女频 · 玄幻"这种不存在的组合
            onClick={() =>
              onChange({ channel: c, genre: genresFor(c).some((g) => g.name === genre) ? genre : "" })
            }
          >
            {c}
          </button>
        ))}
      </div>
      <div className="chips genres">
        {genresFor(channel).map((g) => (
          <button
            key={g.name}
            type="button"
            className="chip"
            aria-pressed={genre === g.name}
            onClick={() => onChange({ genre: genre === g.name ? "" : g.name })}
          >
            {g.name}
          </button>
        ))}
      </div>
    </>
  );
}

/** 一本书的卡。默认只读；点铅笔切到修改（书名 / 频道 / 题材）。 */
function Card({ card, onOpen }: { card: ProjectCard; onOpen: (c: ProjectCard) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: card.title, channel: card.channel ?? "", genre: card.genre ?? "" });
  const [busy, setBusy] = useState(false);

  async function save(): Promise<void> {
    if (busy || !draft.title.trim()) return;
    setBusy(true);
    try {
      await window.tm.updateProject(card.id, draft);
      card.title = draft.title.trim();
      card.channel = draft.channel || undefined;
      card.genre = draft.genre || undefined;
      setEditing(false);
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className="card create">
        <span className="meta">改这本书</span>
        <Basics {...draft} onChange={(next) => setDraft((d) => ({ ...d, ...next }))} />
        <div className="row">
          <button className="btn primary" onClick={() => void save()} disabled={busy || !draft.title.trim()}>
            保存
          </button>
          <button className="btn" onClick={() => setEditing(false)}>
            取消
          </button>
        </div>
      </div>
    );
  }

  const meta = [card.channel, card.genre, progress(card)].filter(Boolean).join(" · ");
  return (
    <div
      className="card"
      role="button"
      tabIndex={0}
      onClick={() => onOpen(card)}
      onKeyDown={(e) => e.key === "Enter" && onOpen(card)}
    >
      <div className="cover" aria-hidden="true">
        {coverChar(card.title)}
      </div>
      <div className="body">
        <div className="line1">
          <span className="title">{card.title}</span>
          <button
            className="pencil"
            title="改书名 / 频道 / 题材"
            onClick={(e) => {
              e.stopPropagation();
              setDraft({ title: card.title, channel: card.channel ?? "", genre: card.genre ?? "" });
              setEditing(true);
            }}
          >
            ✎
          </button>
        </div>
        <div className="meta">{meta}</div>
        {card.blurb !== undefined && <div className="blurb">{card.blurb}</div>}
        <div className="when">{when(card.updatedAt)}</div>
      </div>
    </div>
  );
}

/** 新建：与书卡同尺寸，免得点"新建"时整个版面跳一下。 */
function NewCard({
  onCreated,
  onOpen,
  onCancel,
}: {
  onCreated: () => Promise<void>;
  onOpen: (c: ProjectCard) => void;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState({ title: "", channel: "男频", genre: "" });
  const [busy, setBusy] = useState(false);

  async function create(): Promise<void> {
    if (!draft.title.trim() || busy) return;
    setBusy(true);
    try {
      const { id } = await window.tm.createProject(draft.title, draft.channel, draft.genre);
      await onCreated();
      onOpen({
        id,
        title: draft.title.trim(),
        channel: draft.channel || undefined,
        genre: draft.genre || undefined,
        chapter: null,
        updatedAt: Date.now(),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card create">
      <span className="meta">新的作品</span>
      <Basics {...draft} onChange={(next) => setDraft((d) => ({ ...d, ...next }))} />
      <div className="row">
        <button className="btn primary" onClick={() => void create()} disabled={busy || !draft.title.trim()}>
          开始
        </button>
        {onCancel && (
          <button className="btn" onClick={onCancel}>
            取消
          </button>
        )}
      </div>
    </div>
  );
}
