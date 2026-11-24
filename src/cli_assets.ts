/**
 * CLI 的资产命令（`/assets` 与 `/asset ...`）的**纯逻辑**：参数解析、调用 `framework/assets.ts`
 * 的原语、把结果排成给人看的文本。
 *
 * 为什么单独一个模块：REPL 只能在真终端里驱动，而"建/列/改/移/删"这些契约必须有自动化验证。
 * 这里不碰 readline、不碰会话，删除确认也做成回调——CLI 传 `rl.question`，测试传 `() => true/false`。
 * 这样 `tests/cli_assets.test.ts` 能在离线环境里把整条链路跑一遍。
 *
 * 边界：只做展示与参数适配；资产语义（种类、路径、校验、落盘）全在 framework/assets.ts。
 */
import {
  assetKinds,
  beatsOf,
  chapterRangeOf,
  createAsset,
  deleteAsset,
  listAssets,
  moveAsset,
  readAsset,
  updateAsset,
  type Asset,
} from "./framework/assets";
import { asInteger, asString } from "./framework/frontmatter";
import { readDoc } from "./storage/corpus";

export type ConfirmAssetDelete = (path: string) => Promise<boolean>;

const USAGE = [
  "用法：",
  "  /asset new <kind> <标题>                 新建（kind 写 id 或中文名）",
  "  /asset new chapter <path> <标题>         章节要显式给路径",
  "  /asset new beat <大纲path> <标题>        节拍落在该大纲的 beats/ 下",
  "  /asset show <path>                       看一份资产全文",
  "  /asset set <path> <字段> <值>            改一个 frontmatter 字段",
  "  /asset move <path> <新path>              改名/换位置",
  "  /asset delete <path> [--cascade]         删除（大纲有节拍时要 cascade）",
].join("\n");

function kindByCli(input: string) {
  const clean = input.trim();
  const kinds = assetKinds();
  return kinds.find((k) => k.id === clean) ?? kinds.find((k) => k.label === clean);
}

function kindChoices(): string {
  return assetKinds().map((k) => `${k.id}（${k.label}）`).join(" / ");
}

/** 枚举值的中文名；不是枚举或没定义 → 原值。 */
function enumLabel(kindId: string, key: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const field = assetKinds().find((k) => k.id === kindId)?.fields.find((f) => f.key === key);
  return field?.values?.find((o) => o.value === value)?.label ?? value;
}

/**
 * 资产在清单里占几行：标题 + 路径 + 对写作有用的量（节拍覆盖的章范围、状态）。
 * 章范围现算，改一拍章数这里立刻跟着变。
 */
export function assetLine(asset: Asset, all: readonly Asset[]): string {
  const parts: string[] = [];
  if (asset.kind === "outline") {
    const beats = beatsOf(all, asset.path);
    if (beats.length === 0) {
      parts.push("没有节拍");
    } else {
      const start = asInteger(asset.frontmatter.startChapter) ?? 1;
      const last = beats[beats.length - 1];
      const end = last === undefined ? undefined : chapterRangeOf(asset, beats, last.path)?.end;
      parts.push(`${beats.length} 拍`, end === undefined ? `起于第 ${start} 章` : `第 ${start}–${end} 章`);
    }
  }
  if (asset.kind === "beat") {
    const link = asString(asset.frontmatter.outline);
    const outline = link === undefined ? undefined : all.find((a) => a.kind === "outline" && a.path === link);
    const range = outline === undefined ? undefined : chapterRangeOf(outline, beatsOf(all, outline.path), asset.path);
    if (range !== undefined) parts.push(`第 ${range.start}–${range.end} 章`);
    const status = enumLabel(asset.kind, "status", asString(asset.frontmatter.status));
    if (status !== undefined) parts.push(status);
  }
  if (asset.kind === "chapter") {
    const status = enumLabel(asset.kind, "status", asString(asset.frontmatter.status));
    if (status !== undefined) parts.push(status);
  }
  const mark = asset.problems.length > 0 ? "⚠" : "·";
  const head = `  ${mark} [${asset.kind}] ${asset.title}${parts.length > 0 ? ` · ${parts.join(" · ")}` : ""}`;
  const tail = `\n      ${asset.path}`;
  const problems = asset.problems.length > 0 ? `\n      ⚠ ${asset.problems.join("；")}` : "";
  return head + tail + problems;
}

/** `/assets [kind]` 的全部输出（没有 ANSI 颜色，测试直接比文本）。 */
export async function renderAssetList(projectId: string, filterText = ""): Promise<string> {
  const index = await listAssets(projectId);
  const filter = filterText.trim() ? kindByCli(filterText) : undefined;
  if (filterText.trim() && filter === undefined) {
    return `没有这种资产：${filterText}。可用：${kindChoices()}`;
  }
  const shown = filter === undefined ? index.assets : index.assets.filter((a) => a.kind === filter.id);
  if (shown.length === 0) {
    return filter ? `还没有「${filter.label}」。` : "这本书还没有资产。用 /asset new <kind> <标题> 建一个。";
  }
  const lines = [`资产 ${shown.length} 件${filter ? `（${filter.label}）` : ""}：`];
  for (const asset of shown) lines.push(assetLine(asset, index.assets));
  if (index.problems.length > 0) {
    lines.push("", `问题 ${index.problems.length} 条：`);
    for (const p of index.problems) lines.push(`  ⚠ ${p.path}：${p.message}`);
  }
  if (index.unregistered.length > 0) {
    const preview = index.unregistered.slice(0, 6).join("、");
    const more = index.unregistered.length > 6 ? "…" : "";
    lines.push("", `另有 ${index.unregistered.length} 份未登记文档（/asset show 可看）：${preview}${more}`);
  }
  return lines.join("\n");
}

/** `/asset set` 的取值按字段类型转换；不认识的字段按字符串存（自定义字段允许）。 */
function cliValueFor(kindId: string, key: string, text: string): string | number | string[] {
  const field = assetKinds().find((k) => k.id === kindId)?.fields.find((f) => f.key === key);
  if (field?.type === "number") {
    const n = Number(text);
    if (!Number.isInteger(n)) throw new Error(`「${field.label}」应该是整数（收到：${text}）`);
    return n;
  }
  if (field?.type === "string-list") {
    return text.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
  }
  return text;
}

/** `/asset <子命令>` 的全部输出。删除确认由调用方注入。 */
export async function runAssetCommand(
  projectId: string,
  arg: string,
  confirm: ConfirmAssetDelete,
): Promise<string> {
  const tokens = arg.trim() === "" ? [] : arg.trim().split(/\s+/);
  const sub = tokens[0];
  const rest = tokens.slice(1);

  if (sub === "new") {
    const kindArg = rest[0];
    if (kindArg === undefined) return USAGE;
    const kind = kindByCli(kindArg);
    if (kind === undefined) return `没有这种资产：${kindArg}。可用：${kindChoices()}`;

    const tail = rest.slice(1);
    let title = tail.join(" ");
    let path: string | undefined;
    let frontmatter: Record<string, string> | undefined;
    if (kind.id === "chapter") {
      const [p, ...t] = tail;
      if (p === undefined) return "章节需要显式路径：/asset new chapter <path> <标题>";
      path = p;
      title = t.join(" ");
    } else if (kind.id === "beat") {
      const [outline, ...t] = tail;
      if (outline === undefined) return "节拍需要所属大纲：/asset new beat <大纲path> <标题>";
      frontmatter = { outline };
      title = t.join(" ");
    }
    if (title === "") return "标题不能为空。";

    const created = await createAsset(projectId, {
      kind: kind.id,
      title,
      ...(path === undefined ? {} : { path }),
      ...(frontmatter === undefined ? {} : { frontmatter }),
    });
    if (!created.ok) return `没建成：${created.error}`;

    const lines = [`已新建 [${created.asset.kind}] ${created.asset.title} → ${created.asset.path}`];
    if (created.asset.kind === "beat") {
      const all = (await listAssets(projectId)).assets;
      const outlinePath = asString(created.asset.frontmatter.outline);
      const outline = outlinePath === undefined ? undefined : all.find((a) => a.kind === "outline" && a.path === outlinePath);
      const range =
        outline === undefined ? undefined : chapterRangeOf(outline, beatsOf(all, outline.path), created.asset.path);
      if (range !== undefined) lines.push(`  覆盖第 ${range.start}–${range.end} 章`);
    }
    return lines.join("\n");
  }

  if (sub === "show") {
    const path = rest.join(" ");
    if (!path) return USAGE;
    const content = await readDoc(projectId, path);
    if (content === undefined) return `没有这份文件：${path}`;
    const asset = await readAsset(projectId, path);
    const lines: string[] = [];
    if (asset === undefined) {
      lines.push("（未登记种类，按普通文档显示）");
    } else {
      lines.push(`[${asset.kind}] ${asset.title}  ${asset.path}`);
      if (asset.problems.length > 0) lines.push(`问题：${asset.problems.join("；")}`);
    }
    lines.push(content);
    return lines.join("\n");
  }

  if (sub === "set") {
    const [path, key, ...valueParts] = rest;
    if (path === undefined || key === undefined || valueParts.length === 0) return USAGE;
    const asset = await readAsset(projectId, path);
    if (asset === undefined) return `没有这份资产：${path}`;
    let value: string | number | string[];
    try {
      value = cliValueFor(asset.kind, key, valueParts.join(" "));
    } catch (e) {
      return (e as Error).message;
    }
    const updated = await updateAsset(projectId, {
      path,
      expected: asset.content,
      frontmatter: { [key]: value },
    });
    return updated.ok ? `已改 ${path} 的 ${key}` : `没改成：${updated.error}`;
  }

  if (sub === "move") {
    const [from, to] = rest;
    if (from === undefined || to === undefined) return USAGE;
    const moved = await moveAsset(projectId, { path: from, to });
    return moved.ok ? `已移动 → ${moved.asset.path}` : `没移动：${moved.error}`;
  }

  if (sub === "delete") {
    const path = rest.find((t) => t !== "--cascade");
    const cascade = rest.includes("--cascade");
    if (path === undefined) return USAGE;
    if (!(await confirm(path))) return "没有删。";
    const deleted = await deleteAsset(projectId, { path, cascade });
    return deleted.ok ? `已删除 ${deleted.removed.join("、")}` : `没删成：${deleted.error}`;
  }

  return USAGE;
}

/** `/asset` 不带子命令时的用法；也给 `/help` 引用。 */
export function assetUsage(): string {
  return USAGE;
}