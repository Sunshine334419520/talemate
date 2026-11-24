/**
 * prose 的候选池：这一步可能进上下文的东西，按六条信号线 + 材料现取。
 *
 * 只读、只拼候选；不决定层级、不写 trace。取不到载体时给一条带 `gap` 的候选——
 * "这里本来该有读者账/知识账"本身是 trace 要回答的问题，不能静默少一条。
 *
 * 边界：不认识 Session；规划正文由调用方传入（它已经在 pending / 盘上）。
 */
import { hashText } from "../core/hash";
import type { ContextCandidate, DecisionEntry } from "../core/types";
import { CARD_DIR, nameFromPath } from "../framework/characters";
import { chapterNumberOf, planRelPath } from "../framework/plan";
import { buildProseBrief } from "../framework/prose";
import { enumerateDocs, readDoc } from "../storage/corpus";
import { lastSections, openPromises } from "./project_state";

export interface ProseCandidateInput {
  projectId: string;
  chapter: number;
  /** 已批准规划的全文（盘上的那一份优先） */
  planText: string;
  /** 规划正文是否已经在 system 里（`proseWindow` 读到盘上那一份才会注入）。 */
  planInContext?: boolean;
  /** 这一轮用户的原话 */
  instruction?: string;
  /** 当前会话的拍板记录 */
  decisions: readonly DecisionEntry[];
}

interface CandidateOpts {
  authority?: ContextCandidate["authority"];
  freshness?: ContextCandidate["freshness"];
  cost?: ContextCandidate["cost"];
  alreadyInContext?: boolean;
  gap?: string;
  expandable?: ContextCandidate["expandable"];
}

function revOf(content: string): string {
  return hashText(content).slice(0, 6);
}

function make(
  id: string,
  line: ContextCandidate["line"],
  text: string,
  source: ContextCandidate["source"],
  opts: CandidateOpts = {},
): ContextCandidate {
  return {
    id,
    line,
    text,
    chars: text.length,
    authority: opts.authority ?? "authoritative",
    freshness: opts.freshness ?? "fresh",
    source,
    cost: opts.cost ?? "cheap",
    ...(opts.expandable === undefined ? {} : { expandable: opts.expandable }),
    ...(opts.alreadyInContext === undefined ? {} : { alreadyInContext: opts.alreadyInContext }),
    ...(opts.gap === undefined ? {} : { gap: opts.gap }),
  };
}

function pathOnly(id: string, line: ContextCandidate["line"], path: string): ContextCandidate {
  return make(
    id,
    line,
    "",
    { kind: "doc", path },
    {
      authority: "supporting",
      cost: "expensive",
      expandable: { tool: "read", path },
    },
  );
}

function endingOf(text: string): string {
  const paragraphs = text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const last = paragraphs.at(-1) ?? text.trim();
  return last.length > 1200 ? `…${last.slice(-1200)}` : last;
}

/** 第 N 章的上一章正文：最大章号 < N，同一章取最高稿号。 */
function previousChapterOf(paths: readonly string[], chapter: number): string | undefined {
  let best: { path: string; chapter: number; version: number } | undefined;
  for (const path of paths) {
    const n = chapterNumberOf(path);
    if (n === undefined || n >= chapter) continue;
    const version = Number(/^chapters\/chapter_ch\d+_v(\d+)\.md$/.exec(path)?.[1] ?? "0");
    if (best === undefined || n > best.chapter || (n === best.chapter && version > best.version)) {
      best = { path, chapter: n, version };
    }
  }
  return best?.path;
}

export async function collectProseCandidates(input: ProseCandidateInput): Promise<ContextCandidate[]> {
  const { projectId, chapter, planText } = input;
  const out: ContextCandidate[] = [];

  // P0：已批准规划与这一轮原话。两者都由现有 system/messages 承载，shadow 阶段不重复注入。
  out.push(
    make("task.plan", "task", planText, { kind: "derived", path: planRelPath(chapter), rev: revOf(planText), label: "approved-plan" }, {
      authority: "authoritative",
      cost: "free",
      ...(input.planInContext === true ? { alreadyInContext: true } : {}),
    }),
  );
  if (input.instruction !== undefined && input.instruction.trim() !== "") {
    out.push(
      make("task.instruction", "task", input.instruction, { kind: "user", label: "current instruction" }, {
        authority: "authoritative",
        cost: "free",
        alreadyInContext: true,
      }),
    );
  }

  // P1：声音。正文规范与文风卡在 system 里，记录它是为了去重，不是为了再注入一份。
  try {
    const brief = await buildProseBrief(projectId, chapter);
    out.push(
      make("voice.brief", "voice", brief, { kind: "derived", label: "prose-window" }, {
        authority: "authoritative",
        cost: "free",
        alreadyInContext: true,
      }),
    );
  } catch (err) {
    out.push(
      make("voice.brief", "voice", "", { kind: "derived", label: "prose-window" }, {
        gap: `声音简报构建失败：${err instanceof Error ? err.message : String(err)}`,
      }),
    );
  }

  // P1：叙事窗口与承诺账；progress 是缓存，承诺是 actual 状态。
  const progress = await readDoc(projectId, "state/progress.md");
  const recentProgress = progress === undefined ? undefined : lastSections(progress, 7);
  if (progress !== undefined && recentProgress !== undefined) {
    out.push(
      make("narrative.progress", "narrative", recentProgress, { kind: "state", path: "state/progress.md", rev: revOf(progress) }, {
        authority: "supporting",
      }),
    );
  }
  const foreshadowing = await readDoc(projectId, "state/foreshadowing.md");
  const promises = foreshadowing === undefined ? undefined : openPromises(foreshadowing);
  if (foreshadowing !== undefined && promises !== undefined) {
    out.push(
      make("narrative.promises", "narrative", promises, {
        kind: "state",
        path: "state/foreshadowing.md",
        rev: revOf(foreshadowing),
      }),
    );
  }

  // 读者账、关系账、知识账、工艺账：载体还没建，也先记成 missing，别静默少一条信号线。
  const stateCarriers: { path: string; id: string; line: ContextCandidate["line"]; authority: ContextCandidate["authority"] }[] = [
    { path: "state/knowledge.md", id: "character.knowledge", line: "character", authority: "authoritative" },
    { path: "state/relations.md", id: "character.relations", line: "character", authority: "authoritative" },
    { path: "state/reader.md", id: "reader.state", line: "reader", authority: "current" },
    { path: "state/craft.md", id: "voice.craft", line: "voice", authority: "current" },
  ];
  for (const carrier of stateCarriers) {
    const content = await readDoc(projectId, carrier.path);
    if (content !== undefined && content.trim() !== "") {
      out.push(
        make(carrier.id, carrier.line, content, { kind: "state", path: carrier.path, rev: revOf(content) }, {
          authority: carrier.authority,
        }),
      );
    } else {
      out.push(make(carrier.id, carrier.line, "", { kind: "state", path: carrier.path }, { gap: `${carrier.path} 未建立` }));
    }
  }

  // 在场人物：规划里点名的角色卡 + 角色此刻。卡是基线，状态是"现在"。
  const cardPaths = await enumerateDocs(projectId, CARD_DIR);
  const chapterPaths = await enumerateDocs(projectId, "chapters/");
  for (const path of cardPaths) {
    const name = nameFromPath(path);
    if (name === undefined) continue;
    if (!planText.includes(name)) {
      out.push(pathOnly(`character.doc.${path}`, "character", path));
      continue;
    }
    const card = await readDoc(projectId, path);
    if (card !== undefined) {
      out.push(
        make(`character.card.${name}`, "character", card, { kind: "doc", path, rev: revOf(card) }, {
          authority: "authoritative",
        }),
      );
    }
    const statePath = `state/characters/${name}.md`;
    const state = await readDoc(projectId, statePath);
    if (state !== undefined && state.trim() !== "") {
      out.push(
        make(`character.state.${name}`, "character", state, { kind: "state", path: statePath, rev: revOf(state) }, {
          authority: "current",
        }),
      );
    } else {
      out.push(
        make(`character.state.${name}`, "character", "", { kind: "state", path: statePath }, {
          gap: `${statePath} 未建立`,
        }),
      );
    }
  }

  // P1：上一章结尾——比整章便宜，比 progress 的一行具体。
  const previous = previousChapterOf(chapterPaths, chapter);
  if (previous !== undefined) {
    const text = await readDoc(projectId, previous);
    if (text !== undefined && text.trim() !== "") {
      out.push(
        make("narrative.prev-ending", "narrative", endingOf(text), { kind: "doc", path: previous, rev: revOf(text) }, {
          authority: "current",
        }),
      );
    }
  }

  // P2：会话里的拍板原话，按时间取最近几条；压缩后进中部。
  for (const [index, decision] of input.decisions.slice(-5).entries()) {
    const text = [decision.proposal, decision.verdict, decision.note ?? ""].filter((s) => s !== "").join(" · ");
    out.push(
      make(`author.decision.${index}`, "author", text, { kind: "session", label: "proposal/decision" }, {
        authority: "authoritative",
      }),
    );
  }

  // P3：知道在哪里、但这一步不展开的材料。只给坐标，正文留在工具后面。
  for (const path of chapterPaths) {
    if (path === previous) continue;
    const n = chapterNumberOf(path);
    if (n !== undefined && n >= chapter) continue;
    out.push(pathOnly(`narrative.chapter.${path}`, "narrative", path));
  }
  for (const path of await enumerateDocs(projectId, "design/wiki/")) {
    out.push(pathOnly(`world.doc.${path}`, "world", path));
  }
  for (const path of await enumerateDocs(projectId, "design/outline/")) {
    out.push(pathOnly(`narrative.outline.${path}`, "narrative", path));
  }

  return out;
}