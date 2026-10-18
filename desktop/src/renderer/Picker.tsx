/**
 * 首屏：书架。一部长篇的周期以年计，一个人手里不会超过十本，所以这张屏占满，每本书也占一张
 * 纵向长卡（像一本立着的书），一屏三本、多了往下滚。
 *
 * 创建与修改共用同一套基本盘：书名 · 频道 · 题材，选项来自 `shared/genres.ts` 那份产品数据。
 * 它们写进 `talemate.json` 的书架元信息，不是作品文档，所以不经模型也不问权限；`design/core.md`
 * 里的「题材 · 频道」才是模型据此展开的定位——书架上的是用户的声明，那份是产物。
 */
import { useState } from "react";
import type { ProjectCard } from "../shared/api";
import { CHANNELS, genresFor } from "../shared/genres";
import { SlidersIcon } from "./icons";

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

/** 封面位上那一个字。取不到就用「书」；西文一律大写——封面上的字不会小写起头。 */
function coverChar(title: string): string {
  const first = [...title.trim()][0];
  return first === undefined ? "书" : first.toUpperCase();
}

export function Picker({
  projects,
  onOpen,
  onChanged,
  onSettings,
}: {
  projects: ProjectCard[];
  onOpen: (card: ProjectCard) => void;
  /** 书架变了（新建 / 改名 / 删掉）——重取一遍，界面不留自己那一份 */
  onChanged: () => Promise<void>;
  onSettings: () => void;
}) {
  const [creating, setCreating] = useState(projects.length === 0);
  const platform = window.tm.platform;

  return (
    <div className={`app picker-app platform-${platform}`}>
      {/* 和写作台同一套窗口外观：macOS 没有标题栏（这一行给系统红绿灯留位），
          Windows 是一整行标题栏。两者都是拖拽区——这一屏原来整屏拖不动就是漏了它。 */}
      {platform === "win32" ? (
        <div className="titlebar" />
      ) : (
        <div className={`railtop${platform === "darwin" ? " has-lights" : ""}`} />
      )}
    <div className="picker">
      <header className="shelf">
        <h1>Talemate</h1>
        <p className="sub">
          {projects.length === 0 ? "还没有作品" : `${projects.length} 部作品`}
        </p>
      </header>

      <div className="cards">
        {projects.map((card) => (
          <Card key={card.id} card={card} onOpen={onOpen} onChanged={onChanged} />
        ))}
        {creating ? (
          <NewCard
            onChanged={onChanged}
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
      {/* 设置与写作台同款、同位置：左下角 */}
      <div className="picker-foot">
        <button className="settings" title="模型与设置" onClick={onSettings}>
          <span className="avatar"><SlidersIcon /></span>
          <span>设置</span>
        </button>
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

/**
 * 一本书的卡。默认只读；点铅笔切到修改（书名 / 频道 / 题材）。
 *
 * 删除也长在修改态里，不另挂一个悬停图标：它跟"改个名"不是一个量级的动作，并列会挤、也会误触。
 * 进来两步才够得着，外面还有一层确认——一本书是几年心血，这条路上不该有一步是随手能踩的。
 */
function Card({
  card,
  onOpen,
  onChanged,
}: {
  card: ProjectCard;
  onOpen: (c: ProjectCard) => void;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: card.title, channel: card.channel ?? "", genre: card.genre ?? "" });
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function remove(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.tm.deleteProject(card.id);
      await onChanged();
    } catch (err) {
      // 删不动（回收站不可用之类）照实说，不假装删掉了——那会让人以为书没了
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <>
        <div className="card create">
          <span className="meta">改这本书</span>
          <Basics {...draft} onChange={(next) => setDraft((d) => ({ ...d, ...next }))} />
          <div className="row">
            <button className="btn zhu" onClick={() => setConfirming(true)} disabled={busy}>
              删除这本书
            </button>
            <span className="spacer" />
            <button className="btn primary" onClick={() => void save()} disabled={busy || !draft.title.trim()}>
              保存
            </button>
            <button className="btn" onClick={() => setEditing(false)} disabled={busy}>
              取消
            </button>
          </div>
        </div>
        {confirming && (
          <div className="mask" onClick={() => !busy && setConfirming(false)}>
            {/* 点弹层自己不该关掉它——只有点在周围那层才算反悔 */}
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <header>
                <h2>删除《{card.title}》</h2>
              </header>
              <div className="confirm">
                <p>整本书都会移出书架：企划、正文、现状，连同它的会话记录。</p>
                <p>它会进系统回收站——后悔了可以从那里找回来。</p>
                {error !== null && <p className="note zhu">［没删掉］{error}</p>}
              </div>
              <footer>
                <button className="btn zhu" onClick={() => void remove()} disabled={busy}>
                  删除这本书
                </button>
                <span className="spacer" />
                <button className="btn" onClick={() => setConfirming(false)} disabled={busy}>
                  取消
                </button>
              </footer>
            </div>
          </div>
        )}
      </>
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
  onChanged,
  onOpen,
  onCancel,
}: {
  onChanged: () => Promise<void>;
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
      await onChanged();
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
