/**
 * 设置：一个大弹窗，左边是段（通用设置 / 模型），右边是内容。
 *
 * 两条写在这里免得被改没的：**界面里不出现 `.env`**——那是开发自用的退路，不是产品配置，
 * 用户只该看到自己配的那几套；改清单 ≠ 切会话——这里改的默认只管下一次新建，当前会话
 * 在输入框那一格上切。通用设置改完立即生效，没有"保存"按钮。
 */
import { useEffect, useState, type ReactNode } from "react";
import type { Appearance, ModelProfile, PermissionDefault, Prefs, ProfileView, WebSettingsView } from "../shared/api";
import { DEFAULT_PERMISSION_MODE } from "../shared/api";
import { applyReadingSize, DEFAULT_READING_SIZE, MAX_READING_SIZE, MIN_READING_SIZE } from "./reading";

/** 表单里的一份草稿。密钥单独一栏：它是"只进不出"的——显示时永远只有"已有/没有"。 */
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

const SIZES = Array.from({ length: MAX_READING_SIZE - MIN_READING_SIZE + 1 }, (_, i) => MIN_READING_SIZE + i);

const APPEARANCES: { value: Appearance; label: string; icon: ReactNode }[] = [
  { value: "light", label: "浅色", icon: <SunIcon /> },
  { value: "dark", label: "深色", icon: <MoonIcon /> },
  { value: "system", label: "跟随系统", icon: <MonitorIcon /> },
];

/** 模型那一组：逐个可删，下面一行加新的。一个厂商配多个模型是常态（同端点上有快有慢）。 */
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
        placeholder="加模型 id，回车加入"
        onChange={(e) => setInput(e.target.value)}
        onBlur={() => {
          const v = input.trim();
          if (v !== "" && !value.includes(v)) onChange([...value, v]);
          if (v !== "") setInput("");
        }}
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

function SettingRow({
  label,
  desc,
  children,
}: {
  label: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <div className="setting-label">{label}</div>
        {desc !== undefined && <div className="setting-desc">{desc}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function GeneralSettings({ prefs, onChange }: { prefs: Prefs; onChange: (patch: Prefs) => void }) {
  const appearance = prefs.appearance ?? "system";
  return (
    <div className="settings-section">
      <SettingRow label="权限" desc="默认权限模式；新会话与重开会话都从这里起步">
        <select
          className="setting-select"
          value={prefs.permissionMode ?? DEFAULT_PERMISSION_MODE}
          onChange={(e) => onChange({ permissionMode: e.target.value as PermissionDefault })}
        >
          <option value="accept-edits">工作区内修改</option>
          <option value="ask">每次询问</option>
        </select>
      </SettingRow>

      <SettingRow label="语言" desc="目前仅支持中文">
        <select
          className="setting-select"
          value={prefs.language ?? "zh"}
          onChange={(e) => onChange({ language: e.target.value as "zh" })}
        >
          <option value="zh">中文</option>
        </select>
      </SettingRow>

      <div className="setting-block">
        <div className="setting-label">外观</div>
        <div className="setting-desc">浅色、深色或跟随系统</div>
        <div className="appearance-grid">
          {APPEARANCES.map((a) => (
            <button
              key={a.value}
              type="button"
              className={`appearance-card${appearance === a.value ? " active" : ""}`}
              onClick={() => onChange({ appearance: a.value })}
            >
              {a.icon}
              <span>{a.label}</span>
            </button>
          ))}
        </div>
      </div>

      <SettingRow label="字号大小" desc="影响对话与文件内容的字号">
        <div className="font-size-control">
          <select
            className="setting-select"
            value={prefs.fontSize ?? DEFAULT_READING_SIZE}
            onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
          >
            {SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className="font-size-unit">px</span>
        </div>
      </SettingRow>
    </div>
  );
}

/**
 * 联网：DeepSeek 的 Search / Fetch。
 *
 * 它放在设置里而不是每本书的配置里——同一台机器上的联网能力是作者的，不跟小说走（同模型清单）。
 * key 只进不出：已配置时输入框留空 = 沿用原来那把；清除要单独点。
 */
function WebSettingsSection() {
  const [view, setView] = useState<WebSettingsView | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState("https://api.deepseek.com/v1/tools");
  const [count, setCount] = useState(10);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.tm.webSettings().then((v) => {
      setView(v);
      setBaseURL(v.deepseek.baseURL);
      setCount(v.deepseek.count);
    });
  }, []);

  async function save(): Promise<void> {
    setBusy(true);
    try {
      const next = await window.tm.saveWebSettings({
        ...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }),
        baseURL,
        count,
      });
      setView(next);
      setCount(next.deepseek.count);
      setApiKey("");
      setNote(next.deepseek.configured ? "已保存。下一次联网调用就走 DeepSeek。" : "已保存，但还没有密钥。");
    } catch (e) {
      setNote(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function clear(): Promise<void> {
    setBusy(true);
    try {
      const next = await window.tm.saveWebSettings({ clearKey: true });
      setView(next);
      setApiKey("");
      setNote("已清除密钥，联网回到直连 / 其他搜索后端。");
    } catch (e) {
      setNote(`清除失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-section">
      <h2 className="settings-title">联网</h2>
      <p className="settings-desc">
        配了 DeepSeek 的 API Key 之后，webfetch 与 websearch 优先走 DeepSeek 的 Search / Fetch API
        （与模型同一把 key，按成功请求计费）；不配则维持直连与原来的搜索后端。
      </p>
      <div className="settings-fields">
        <label>
          状态
          <span className="hint">
            {view === null ? "读取中…" : view.deepseek.configured ? "已配置 DeepSeek" : "未配置"}
          </span>
        </label>
        <label>
          API 密钥
          <span className="hint">{view?.deepseek.configured === true ? "已存，留空不改" : ""}</span>
          <input
            type="password"
            value={apiKey}
            placeholder={view?.deepseek.configured === true ? "已有密钥" : "sk-…"}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
        <label>
          API 地址
          <span className="hint">含 /v1/tools 前缀</span>
          <input
            value={baseURL}
            placeholder="https://api.deepseek.com/v1/tools"
            onChange={(e) => setBaseURL(e.target.value)}
          />
        </label>
        <label>
          每次搜索结果数
          <span className="hint">1–50，默认 10；websearch 单次最多返回 10 条</span>
          <input
            type="number"
            min={1}
            max={50}
            value={count}
            onChange={(e) => setCount(Number(e.target.value) || 10)}
          />
        </label>
      </div>
      {note !== null && <p className="settings-desc">{note}</p>}
      <div className="settings-actions">
        <span className="spacer" />
        {view?.deepseek.configured === true && (
          <button className="btn zhu" onClick={() => void clear()} disabled={busy}>
            清除密钥
          </button>
        )}
        <button className="btn primary" onClick={() => void save()} disabled={busy}>
          保存
        </button>
      </div>
    </div>
  );
}

export function Settings({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<"general" | "models" | "web">("general");
  const [prefs, setPrefs] = useState<Prefs>({});
  const [profiles, setProfiles] = useState<ProfileView[]>([]);
  const [defaultName, setDefaultName] = useState<string | undefined>();
  /** `null` = 在看清单；有值 = 在编辑某一套（`saved: false` 表示它还没进清单、还没存过） */
  const [editing, setEditing] = useState<{ draft: Draft; saved: boolean } | null>(null);
  const [modelInput, setModelInput] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  // 不要展开 ProfileView：它带着 hasKey/isDefault，写回 models.json 会变成脏字段。
  const asDraft = (p: ProfileView): Draft => ({
    name: p.name,
    provider: p.provider,
    models: [...p.models],
    baseURL: p.baseURL ?? "",
    maxTokens: p.maxTokens,
    reasoning: p.reasoning,
    apiKey: "",
  });

  async function reloadModels(): Promise<void> {
    const { profiles: list, default: d } = await window.tm.models();
    setProfiles(list);
    setDefaultName(d);
  }

  useEffect(() => {
    void window.tm.prefs().then(setPrefs);
    void reloadModels();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** 通用设置立即生效并落盘；字号顺手应用到 CSS 变量。 */
  function savePrefs(patch: Prefs): void {
    setPrefs((p) => ({ ...p, ...patch }));
    void window.tm.savePrefs(patch);
    if (patch.fontSize !== undefined) applyReadingSize(patch.fontSize);
  }

  const draft = editing?.draft;

  async function save(): Promise<void> {
    if (draft === undefined) return;
    // 模型输入框里的文字还没按回车时，不能因为 draft.models 为空就把「保存」当没看见。
    const typed = modelInput.trim();
    const models = typed !== "" && !draft.models.includes(typed) ? [...draft.models, typed] : draft.models;
    if (draft.name.trim() === "") {
      setSaveError("先给这套配置起个名字。");
      return;
    }
    if (models.length === 0) {
      setSaveError("至少填一个模型。输入模型 id 后按回车，或直接点保存。");
      return;
    }

    setSaveError(null);
    const { apiKey, ...rest } = draft;
    try {
      // 密钥那栏留空 = 没重填 → 整项省掉，让主进程沿用存着的那一份（它只进不出）
      await window.tm.saveProfile({
        ...rest,
        models,
        name: draft.name.trim(),
        ...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }),
      });
      await reloadModels();
      setModelInput("");
      setEditing(null); // 存完回清单
    } catch (e) {
      setSaveError(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const setDraft = (next: Draft): void => setEditing((e) => (e === null ? e : { ...e, draft: next }));

  return (
    <div className="mask" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <h1>设置</h1>
          <button className="settings-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>

        <div className="settings-body">
          <nav className="settings-nav">
            <button
              type="button"
              className={`settings-nav-item${section === "general" ? " active" : ""}`}
              onClick={() => setSection("general")}
            >
              <GearIcon />
              通用设置
            </button>
            <button
              type="button"
              className={`settings-nav-item${section === "models" ? " active" : ""}`}
              onClick={() => setSection("models")}
            >
              <ModelsIcon />
              模型
            </button>
            <button
              type="button"
              className={`settings-nav-item${section === "web" ? " active" : ""}`}
              onClick={() => setSection("web")}
            >
              <GlobeIcon />
              联网
            </button>
          </nav>

          <div className="settings-content">
            {section === "general" ? (
              <GeneralSettings prefs={prefs} onChange={savePrefs} />
            ) : section === "web" ? (
              <WebSettingsSection />
            ) : editing === null ? (
              <div className="settings-section">
                <h2 className="settings-title">模型</h2>
                <p className="settings-desc">填入各提供商的 API 密钥即可使用其模型。</p>
                <div className="profile-list">
                  {profiles.map((p) => (
                    <div className="profile-card" key={p.name}>
                      <div className="profile-main">
                        <div className="profile-name">
                          {p.name}
                          {defaultName === p.name && <span className="profile-badge">默认</span>}
                          {!p.hasKey && <span className="profile-badge zhu">没密钥</span>}
                        </div>
                        <div className="profile-meta">
                          {p.provider} · {p.models.join(" · ")}
                        </div>
                      </div>
                      <div className="profile-actions">
                        {defaultName !== p.name && (
                          <button
                            className="btn small"
                            onClick={async () => {
                              await window.tm.setDefaultProfile(p.name);
                              await reloadModels();
                            }}
                          >
                            设为默认
                          </button>
                        )}
                        <button className="btn small" onClick={() => setEditing({ draft: asDraft(p), saved: true })}>
                          编辑
                        </button>
                      </div>
                    </div>
                  ))}
                  <button
                    className="profile-add"
                    onClick={() => {
                      setSaveError(null);
                      setEditing({ draft: { ...BLANK }, saved: false });
                    }}
                  >
                    ＋ 添加模型提供商
                  </button>
                </div>
              </div>
            ) : (
              <div className="settings-section">
                <div className="settings-form-head">
                  <button className="settings-back" onClick={() => setEditing(null)}>
                    ‹ 返回
                  </button>
                  <h2 className="settings-form-title">{editing.saved ? draft?.name : "新建供应商"}</h2>
                </div>

                <div className="settings-fields">
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
                          draft !== undefined &&
                          setDraft({ ...draft, reasoning: e.target.value as ModelProfile["reasoning"] })
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

                {saveError !== null && <p className="settings-error">{saveError}</p>}

                <div className="settings-actions">
                  {editing.saved && draft !== undefined && defaultName !== draft.name && (
                    <button
                      className="btn"
                      onClick={async () => {
                        await window.tm.setDefaultProfile(draft.name);
                        await reloadModels();
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
                        await reloadModels();
                        setEditing(null);
                      }}
                    >
                      删除
                    </button>
                  )}
                  <span className="spacer" />
                  <button className="btn primary" onClick={() => void save()}>
                    {editing.saved ? "保存" : "存为一套配置"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function GlobeIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.7 8h10.6M8 2.5c1.6 1.5 2.4 3.4 2.4 5.5S9.6 12 8 13.5C6.4 12 5.6 10.1 5.6 8S6.4 4 8 2.5z" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v2M8 12.2v2M2.8 8h2M11.2 8h2M3.9 3.9l1.4 1.4M10.7 10.7l1.4 1.4M12.1 3.9l-1.4 1.4M5.3 10.7l-1.4 1.4" />
    </svg>
  );
}

function ModelsIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <rect x="2.5" y="3" width="11" height="4" rx="1.2" />
      <rect x="2.5" y="9" width="11" height="4" rx="1.2" />
      <path d="M5 5h.01M5 11h.01" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="2.6" />
      <path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 9.6A5.4 5.4 0 0 1 6.4 3a5.4 5.4 0 1 0 6.6 6.6z" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="3" width="11" height="7.5" rx="1.2" />
      <path d="M6 13h4M8 10.5V13" />
    </svg>
  );
}
