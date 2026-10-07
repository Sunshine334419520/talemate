/**
 * 设置：**一个居中的弹窗**（左边清单、右边字段），不是一整屏。
 *
 * 一屏会把写作台整个盖掉——而"配模型"是随手改一下就走的事，不该把用户从工作里拽出来换个界面。
 * 弹窗也天然回答了"改完去哪"：关掉就回到刚才在的地方。
 *
 * 两条写在这里免得被改没的：
 * - **一套都没有时一律退回环境变量**：`.env` 那套照旧能用，不是被这里替代了。
 * - **改清单 ≠ 切会话**：这里改默认只管下一次新建；当前会话用哪套，在状态栏那一格上切。
 */
import { useEffect, useState } from "react";
import type { ModelProfile, ProfileView } from "../shared/api";

/** 表单里的一份草稿。**密钥单独一栏**：它是"只进不出"的——显示时永远只有"已有/没有"。 */
type Draft = Omit<ModelProfile, "apiKey"> & { apiKey: string };

const BLANK: Draft = {
  name: "",
  provider: "openai",
  models: [],
  baseURL: "",
  apiKey: "",
  maxTokens: 16000,
  reasoning: "low",
};

/** 模型那一组：逐个可删，下面一行加新的。**一个厂商配多个模型是常态**（同端点上有快有慢）。 */
function Models({
value,
onChange,
input,
setInput,
}: {
value: string[];
onChange: (next: string[]) => void;
input: string;
setInput: (v: string) => void;
}) {
  return (
    <div className="models">
      {value.map((m) => (
        <span className="chip on" key={m}>
          {m}
          <button className="x" title="移除" onClick={() => onChange(value.filter((x) => x !== m))}>
            ✕
          </button>
        </span>
      ))}
      <input
        value={input}
        placeholder="加模型 id"
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const v = input.trim();
          if (v !== "" && !value.includes(v)) onChange([...value, v]);
          setInput("");
        }}
      />
    </div>
  );
}

export function Settings({ onClose }: { onClose: () => void }) {
  const [profiles, setProfiles] = useState<ProfileView[]>([]);
  const [env, setEnv] = useState<ProfileView | null>(null);
  const [defaultName, setDefaultName] = useState<string | undefined>();
  /** `null` = 在看清单；有值 = 在编辑某一套（`fromEnv` 表示它还没进清单，是从 .env 借来改的） */
  const [editing, setEditing] = useState<{ draft: Draft; saved: boolean } | null>(null);
  const [modelInput, setModelInput] = useState("");

  const asDraft = (p: ProfileView): Draft => ({ ...p, apiKey: "" });

  async function reload(): Promise<void> {
    const { profiles: list, default: d, env: e } = await window.tm.models();
    setProfiles(list);
    setDefaultName(d);
    setEnv(e);
  }
  useEffect(() => {
    void reload();
  }, []);

  const draft = editing?.draft;
  const canSave = draft !== undefined && draft.name.trim() !== "" && draft.models.length > 0;

  async function save(): Promise<void> {
    if (draft === undefined || !canSave) return;
    const { apiKey, ...rest } = draft;
    // 密钥那栏留空 = 没重填 → **整项省掉**，让主进程沿用存着的那一份（它只进不出）
    await window.tm.saveProfile({
      ...rest,
      name: draft.name.trim(),
      ...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }),
    });
    await reload();
    setEditing(null); // 存完回清单：这一屏干完了
  }

  const setDraft = (next: Draft): void => setEditing((e) => (e === null ? e : { ...e, draft: next }));

  return (
    <div className="mask" onClick={onClose}>
      {/* 点弹窗自己不该关掉它——只有点在周围那层才算"改完了" */}
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          {editing === null ? (
            <>
              <h2>模型</h2>
            </>
          ) : (
            <>
              <button className="back" onClick={() => setEditing(null)}>
                ‹ 返回
              </button>
              <h2>{editing.saved ? draft?.name : "新建供应商"}</h2>
            </>
          )}
          <button className="close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>

        {/* 清单：设置进来先看这个。点一行才进编辑——**一屏只干一件事**，
            不然"现在是在新建还是在改"要靠看按钮猜（上一版就是这么错的）。 */}
        {editing === null ? (
          <div className="body plain">
            {profiles.map((p) => (
              <button key={p.name} className="row" onClick={() => setEditing({ draft: asDraft(p), saved: true })}>
                <span className="nm">
                  {p.name}
                  {defaultName === p.name && <span className="tag">默认</span>}
                </span>
                <span className="md">
                  {p.provider} · {p.models.join(" · ")}
                </span>
              </button>
            ))}
            {env !== null && (
              <button className="row env" onClick={() => setEditing({ draft: asDraft(env), saved: false })}>
                <span className="nm">{env.name}</span>
                <span className="md">
                  {env.provider} · {env.models.join(" · ")}
                </span>
              </button>
            )}
            <button className="row add" onClick={() => setEditing({ draft: { ...BLANK }, saved: false })}>
              ＋ 新建供应商
            </button>
          </div>
        ) : (
          <>
            <div className="body fields">
              <label>
                名字
                <input
                  autoFocus
                  placeholder="如：DeepSeek"
                  value={draft?.name ?? ""}
                  onChange={(e) => draft !== undefined && setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label>
                服务
                <select
                  value={draft?.provider ?? "openai"}
                  onChange={(e) =>
                    draft !== undefined && setDraft({ ...draft, provider: e.target.value as ModelProfile["provider"] })
                  }
                >
                  <option value="openai">openai（兼容 DeepSeek / Moonshot 等）</option>
                  <option value="anthropic">anthropic</option>
                  <option value="mock">mock（离线自检用）</option>
                </select>
              </label>
              <label>
                模型<span className="hint">第一个为默认</span>
                <Models
                  value={draft?.models ?? []}
                  onChange={(models) => draft !== undefined && setDraft({ ...draft, models })}
                  input={modelInput}
                  setInput={setModelInput}
                />
              </label>
              <label>
                API 地址
                <input
                  value={draft?.baseURL ?? ""}
                  placeholder="https://api.deepseek.com"
                  onChange={(e) => draft !== undefined && setDraft({ ...draft, baseURL: e.target.value })}
                />
              </label>
              <label>
                密钥
                <span className="hint">{editing.saved ? "留空不改" : ""}</span>
                <input
                  type="password"
                  value={draft?.apiKey ?? ""}
                  placeholder={editing.saved ? "已有密钥" : ""}
                  onChange={(e) => draft !== undefined && setDraft({ ...draft, apiKey: e.target.value })}
                />
              </label>
              <div className="two">
                <label>
                  最大输出
                  <input
                    type="number"
                    value={draft?.maxTokens ?? 16000}
                    onChange={(e) =>
                      draft !== undefined && setDraft({ ...draft, maxTokens: Number(e.target.value) || 16000 })
                    }
                  />
                </label>
                <label>
                  推理强度
                  <select
                    value={draft?.reasoning ?? "low"}
                    onChange={(e) =>
                      draft !== undefined && setDraft({ ...draft, reasoning: e.target.value as ModelProfile["reasoning"] })
                    }
                  >
                    <option value="off">关</option>
                    <option value="low">低</option>
                    <option value="high">高</option>
                    <option value="max">最高</option>
                  </select>
                </label>
              </div>
            </div>

            <footer>
              {editing.saved && draft !== undefined && defaultName !== draft.name && (
                <button
                  className="btn"
                  onClick={async () => {
                    await window.tm.setDefaultProfile(draft.name);
                    await reload();
                  }}
                >
                  设为默认
                </button>
              )}
              {editing.saved && draft !== undefined && (
                <button
                  className="btn zhu"
                  onClick={async () => {
                    await window.tm.deleteProfile(draft.name);
                    await reload();
                    setEditing(null);
                  }}
                >
                  删除
                </button>
              )}
              <span className="spacer" />
              <button className="btn primary" onClick={() => void save()} disabled={!canSave}>
                {editing.saved ? "保存" : "存为一套配置"}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
