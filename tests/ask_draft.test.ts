/**
 * 提问草稿的离线测试：假存储 + 纯函数，验证“收起/刷新后草稿还在”“旧草稿里的选项已不存在时
 * 不把非法 label 递出去”。不涉及 React 与真实 localStorage。
 */
import { describe, expect, test } from "bun:test";
import type { AskQuestion } from "../src/core/types";
import {
  draftKey,
  hasDraftIn,
  initialDrafts,
  loadDraft,
  removeDraft,
  saveDraft,
  type Draft,
  type DraftStorage,
  type SavedDraft,
} from "../desktop/src/renderer/ask_draft";

function makeStorage(): DraftStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

const QUESTIONS: AskQuestion[] = [
  {
    id: "focus",
    question: "重心放在哪？",
    options: [{ label: "先写县城（推荐）" }, { label: "先写陈六" }],
  },
  {
    id: "artifacts",
    question: "还要落什么？",
    multiSelect: true,
    options: [{ label: "角色卡" }, { label: "伏笔账" }],
  },
];

describe("ask draft · 读写", () => {
  test("key 与会话/调用绑定；保存后可原样读回", () => {
    const storage = makeStorage();
    const key = draftKey("session-1", "call-1");
    expect(key).toBe("tm.ask.session-1.call-1");
    const draft: SavedDraft = {
      page: 1,
      answers: {
        focus: { selected: ["先写县城（推荐）"], custom: "", skipped: false },
        artifacts: { selected: ["角色卡"], custom: "再加一条", skipped: false },
      },
      hidden: true,
      held: true,
    };
    saveDraft(storage, key, draft);
    expect(loadDraft(storage, key)).toEqual(draft);
  });

  test("没有、损坏、形状不对都当没有——卡片仍然能答", () => {
    const storage = makeStorage();
    const key = draftKey("s", "c");
    expect(loadDraft(storage, key)).toBeUndefined();
    storage.setItem(key, "{not json");
    expect(loadDraft(storage, key)).toBeUndefined();
    storage.setItem(key, JSON.stringify({ answers: {} }));
    expect(loadDraft(storage, key)).toBeUndefined();
    removeDraft(storage, key);
    expect(loadDraft(storage, key)).toBeUndefined();
  });

  test("存储抛错时不把异常带到界面", () => {
    const broken: DraftStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadDraft(broken, "k")).toBeUndefined();
    expect(() =>
      saveDraft(broken, "k", { page: 0, answers: {}, hidden: false, held: false }),
    ).not.toThrow();
    expect(() => removeDraft(broken, "k")).not.toThrow();
  });
});

describe("ask draft · 初始化", () => {
  test("没有旧草稿：推荐项预选，其余为空", () => {
    const drafts = initialDrafts(QUESTIONS);
    expect(drafts.focus.selected).toEqual(["先写县城（推荐）"]);
    expect(drafts.artifacts.selected).toEqual([]);
  });

  test("旧草稿优先；已不存在的 label 被滤掉，custom/skipped 保留", () => {
    const drafts = initialDrafts(QUESTIONS, {
      focus: { selected: ["先写陈六", "已经删掉的选项"], custom: "自己写的", skipped: false },
      artifacts: { selected: ["角色卡"], custom: "", skipped: true },
    });
    expect(drafts.focus.selected).toEqual(["先写陈六"]);
    expect(drafts.focus.custom).toBe("自己写的");
    expect(drafts.artifacts.skipped).toBe(true);
  });

  test("旧草稿的 selected 不是数组也不炸", () => {
    const drafts = initialDrafts(QUESTIONS, {
      focus: { selected: "坏值", custom: 3, skipped: "yes" } as unknown as Draft,
    });
    expect(drafts.focus.selected).toEqual([]);
    expect(drafts.focus.custom).toBe("");
    expect(drafts.focus.skipped).toBe(false);
  });

  test("英文推荐标记也认", () => {
    const drafts = initialDrafts([
      { id: "q", question: "?", options: [{ label: "A (Recommended)" }, { label: "B" }] },
    ]);
    expect(drafts.q.selected).toEqual(["A (Recommended)"]);
  });
});

describe("ask draft · 是否已有草稿", () => {
  test("选中、自定义、跳过都算；空白自定义不算", () => {
    const map: Record<string, Draft> = initialDrafts(QUESTIONS);
    expect(hasDraftIn(map, "artifacts")).toBe(false);
    expect(hasDraftIn(map, "focus")).toBe(true);
    map.artifacts = { selected: [], custom: "   ", skipped: false };
    expect(hasDraftIn(map, "artifacts")).toBe(false);
    map.artifacts = { selected: [], custom: "一句话", skipped: false };
    expect(hasDraftIn(map, "artifacts")).toBe(true);
    map.artifacts = { selected: [], custom: "", skipped: true };
    expect(hasDraftIn(map, "artifacts")).toBe(true);
    expect(hasDraftIn(map, "missing")).toBe(false);
  });
});
