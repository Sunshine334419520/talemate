/**
 * 提问草稿：本机 localStorage 的读写与初始化。
 *
 * 抽成纯函数是为了能离线测：传入一个 Map 假存储就能验证“收起/刷新后草稿还在”“旧草稿里的
 * 选项已被删掉时不把非法 label 递出去”。存储不可用（隐私模式等）只影响恢复，不影响作答。
 */
import type { AskQuestion } from "../shared/api";
import { isRecommended } from "../../../src/session/asks";

export interface Draft {
  selected: string[];
  custom: string;
  skipped: boolean;
}

export interface SavedDraft {
  page: number;
  answers: Record<string, Draft>;
  hidden: boolean;
  held: boolean;
}

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const EMPTY_DRAFT: Draft = { selected: [], custom: "", skipped: false };

export function draftKey(sessionId: string, callId: string): string {
  return `tm.ask.${sessionId}.${callId}`;
}

export function loadDraft(storage: DraftStorage, key: string): SavedDraft | undefined {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as Partial<SavedDraft>;
    if (typeof parsed.page !== "number" || typeof parsed.answers !== "object" || parsed.answers === null) {
      return undefined;
    }
    return {
      page: parsed.page,
      answers: parsed.answers as Record<string, Draft>,
      hidden: parsed.hidden === true,
      held: parsed.held === true,
    };
  } catch {
    return undefined; // 草稿坏了就当没有；卡片仍然能答
  }
}

export function saveDraft(storage: DraftStorage, key: string, draft: SavedDraft): void {
  try {
    storage.setItem(key, JSON.stringify(draft));
  } catch {
    // 本机草稿不可用只影响“刷新后恢复”，不影响作答
  }
}

export function removeDraft(storage: DraftStorage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // 同上
  }
}

/** 新草稿的起点：每题默认选中第一个带「（推荐）」的选项；旧草稿的非法 label 会被滤掉。 */
export function initialDrafts(
  questions: AskQuestion[],
  saved?: Record<string, Draft>,
): Record<string, Draft> {
  const out: Record<string, Draft> = {};
  for (const q of questions) {
    const options = q.options ?? [];
    const recommended = options.find((o) => isRecommended(o.label));
    const fallback: Draft = {
      selected: recommended === undefined ? [] : [recommended.label],
      custom: "",
      skipped: false,
    };
    const raw = saved?.[q.id];
    if (raw === undefined) {
      out[q.id] = fallback;
      continue;
    }
    const valid = new Set(options.map((o) => o.label));
    const selected = Array.isArray(raw.selected)
      ? raw.selected.filter((s) => typeof s === "string" && valid.has(s))
      : [];
    out[q.id] = {
      selected,
      custom: typeof raw.custom === "string" ? raw.custom : "",
      skipped: raw.skipped === true,
    };
  }
  return out;
}

export function hasDraftIn(map: Record<string, Draft>, id: string): boolean {
  const d = map[id] ?? EMPTY_DRAFT;
  return d.skipped || d.selected.length > 0 || d.custom.trim() !== "";
}
