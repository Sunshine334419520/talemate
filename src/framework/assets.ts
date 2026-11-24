/**
 * assets：资产层的解析、索引与增删改查原语。
 *
 * 资产 = 作品里一件有身份的东西：概览、世界观条目、角色、大纲、节拍、章节、角色现状、伏笔账、
 * 章节流水。**身份是项目相对路径**（与 `FileOp.path`、权限 pattern、语料层同一口径），头部
 * frontmatter 只放机器字段，正文完全自由——所以用户手改、git diff、Agent 读文本三件事都成立。
 *
 * 种类定义不在本文件：一种资产一个 txt，住 `assets/kinds/`，由 `framework/assetkinds.ts` 加载。
 * 本文件只消费注册表，不认识任何具体种类；加一种资产不需要改这里。
 *
 * 四条边界，写在这里防止它们散到别处：
 *
 *   1. **种类由路径判定，frontmatter 只补充。** `kindOf` 是唯一的种类判据；注册表加一个 txt
 *      就多一种资产，别处不许按目录名再判一次。
 *   2. **校验只报 problem，不拒绝读取。** 头写坏了、必填缺了，资产照样可读可列——UI 要显示它、
 *      用户要修它。拒绝只发生在写入（`validate` 返回错误 → 不落盘）。
 *   3. **节拍是独立文件，指向它的大纲只有一处真相。** 节拍头的 `outline` 是唯一归属声明；
 *      大纲文件里不存节拍清单，也不存章号——章范围每次由 `chapterRangeOf` 现算。
 *   4. **没有派生索引文件。** `listAssets` 每次扫盘现算；存一份就是迟早脱节的缓存。
 */
import { dirname } from "node:path";
import { match } from "../permission";
import { docAbs, enumerateDocs, readDoc } from "../storage/corpus";
import { removeIfUnchanged, StaleContentError, writeIfUnchanged } from "../storage/atomic";
import { safeRelPath } from "../storage/util";
import { assetKindById, assetKinds, type AssetKind } from "./assetkinds";
import {
  asInteger,
  asString,
  parseFrontmatter,
  splitFrontmatter,
  withFrontmatter,
  type Frontmatter,
  type FrontmatterValue,
} from "./frontmatter";

export { assetKinds, assetKindById as assetKind, clearAssetKindCache } from "./assetkinds";
export type { AssetField, AssetKind, AssetOption } from "./assetkinds";

/** 路径 → 种类。命中的模式里更长的胜出（同 design_spec 的 `specFor`），注册表顺序不参与。 */
export function kindOf(path: string): AssetKind | undefined {
  const clean = path.replace(/\\/g, "/");
  let best: AssetKind | undefined;
  let bestLen = -1;
  for (const kind of assetKinds()) {
    for (const pattern of kind.match) {
      if (!match(clean, pattern)) continue;
      if (pattern.length > bestLen) {
        best = kind;
        bestLen = pattern.length;
      }
    }
  }
  return best;
}

export interface Asset {
  kind: string;
  /** 项目相对路径，资产的唯一身份 */
  path: string;
  /** 显示名：frontmatter.title / name → 正文 H1 → 文件名 */
  title: string;
  frontmatter: Frontmatter;
  /** 去掉 frontmatter 的正文 */
  body: string;
  /** 读到的原始字节（CAS 的 `expected`），不参与业务逻辑 */
  content: string;
  /** 这份文件自身的毛病（头坏了、字段类型不对、必填缺了）。有毛病也照样可读。 */
  problems: string[];
}

export interface AssetProblem {
  path: string;
  message: string;
}

export interface AssetIndex {
  assets: Asset[];
  /** 只有登记过的种类才进 assets；未登记的 .md 路径列在这里，不静默丢 */
  unregistered: string[];
  /** 整个索引层面的问题：文件自身的毛病 + 悬空引用 */
  problems: AssetProblem[];
}

function frontmatterOrder(kind: AssetKind): string[] {
  return ["kind", ...kind.fields.map((f) => f.key)];
}

function firstHeading(body: string): string | undefined {
  for (const line of body.split("\n")) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

function baseName(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/, "");
}

function titleOf(path: string, kind: AssetKind, data: Frontmatter, body: string): string {
  const named = asString(data.title) ?? asString(data.name);
  if (named !== undefined && named !== "") return named;
  if (kind.id === "character" || kind.id === "state-character") return baseName(path);
  return firstHeading(body) ?? baseName(path);
}

/** 字段校验：缺必填 / 类型不对 / 枚举越界 / 数值越界。返回给用户看的中文句子。 */
function validateFields(kind: AssetKind, data: Frontmatter): string[] {
  const problems: string[] = [];
  for (const field of kind.fields) {
    const value = data[field.key];
    const absent = value === undefined || value === null || value === "";
    if (absent) {
      if (field.required) problems.push(`缺必填字段「${field.label}」（${field.key}）`);
      continue;
    }
    if (field.type === "string") {
      if (Array.isArray(value) || typeof value !== "string") {
        problems.push(`「${field.label}」（${field.key}）应该是字符串`);
      }
      continue;
    }
    if (field.type === "string-list") {
      if (Array.isArray(value) && value.some((item) => item !== null && typeof item === "object")) {
        problems.push(`「${field.label}」（${field.key}）应该是字符串列表`);
      }
      continue;
    }
    if (field.type === "enum") {
      const text = Array.isArray(value) ? undefined : String(value);
      const allowed = field.values ?? [];
      if (text === undefined || !allowed.some((o) => o.value === text)) {
        problems.push(
          `「${field.label}」（${field.key}）只能是 ${allowed.map((o) => `${o.value}（${o.label}）`).join(" / ")}（收到：${String(value)}）`,
        );
      }
      continue;
    }
    const num = asInteger(value);
    if (num === undefined) {
      problems.push(`「${field.label}」（${field.key}）应该是整数（收到：${String(value)}）`);
      continue;
    }
    if (field.min !== undefined && num < field.min) {
      problems.push(`「${field.label}」（${field.key}）不能小于 ${field.min}（收到：${num}）`);
    }
  }
  return problems;
}

/**
 * 解析一份文件。未登记的路径返回 `undefined`（它不是资产，但可能仍是可读文档）。
 * `problems` 不阻止读取——列表要显示它、用户要修它。
 */
export function parseAsset(path: string, content: string): Asset | undefined {
  const kind = kindOf(path);
  if (kind === undefined) return undefined;
  const split = splitFrontmatter(content);
  const parsed = split.raw === undefined ? { data: {}, problems: [] } : parseFrontmatter(split.raw);
  const data = parsed.data;
  const problems = [...parsed.problems];

  const declared = data.kind;
  if (declared !== undefined) {
    const text = Array.isArray(declared) ? undefined : String(declared);
    if (text !== kind.id) {
      problems.push(`frontmatter 的 kind=${String(declared)} 与路径判定的 ${kind.id} 不一致`);
    }
  }
  problems.push(...validateFields(kind, data));

  return {
    kind: kind.id,
    path: path.replace(/\\/g, "/"),
    title: titleOf(path, kind, data, split.body),
    frontmatter: data,
    body: split.body,
    content,
    problems,
  };
}

/** 标题 → 路径段。**去掉不安全字符而不是报错**：标题是给人写的，路径是给机器用的。 */
function safeSegment(title: string): string {
  const text = title
    .trim()
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/[^\w一-鿿.\-]+/g, "")
    .replace(/^\.+/, "")
    .trim();
  return text === "" ? "未命名" : text;
}

function safeAssetPath(rel: string): string | undefined {
  return safeRelPath(rel);
}

/** 一份大纲的节拍目录：`design/outline/vol_1.md` → `design/outline/vol_1/beats`。 */
export function beatDirOf(outlinePath: string): string {
  const clean = outlinePath.replace(/\\/g, "/");
  const stem = baseName(clean);
  const parent = dirname(clean);
  return `${parent}/${stem}/beats`;
}

function isBeatPath(path: string, outlinePath: string): boolean {
  const prefix = `${beatDirOf(outlinePath)}/`;
  return path.startsWith(prefix) && path.endsWith(".md");
}

function validateBeatLink(projectId: string, data: Frontmatter): Promise<string | undefined> {
  const link = asString(data.outline);
  if (link === undefined || link.trim() === "") return Promise.resolve("节拍必须声明所属大纲（frontmatter 的 outline）");
  const clean = link.replace(/\\/g, "/");
  const kind = kindOf(clean);
  if (kind?.id !== "outline") return Promise.resolve(`节拍所属大纲的路径不是一份大纲：${clean}`);
  return readDoc(projectId, clean).then((content) =>
    content === undefined ? `节拍指向的大纲不存在：${clean}` : undefined,
  );
}

async function fileExists(projectId: string, path: string): Promise<boolean> {
  return (await readDoc(projectId, path)) !== undefined;
}

/**
 * 资产清单：扫三个根、解析每份登记过的文档，再把悬空引用折成索引级问题。
 * 每次现算，不写索引文件。
 */
export async function listAssets(projectId: string): Promise<AssetIndex> {
  const assets: Asset[] = [];
  const unregistered: string[] = [];
  const problems: AssetProblem[] = [];
  for (const path of await enumerateDocs(projectId)) {
    const content = await readDoc(projectId, path);
    if (content === undefined) continue;
    const asset = parseAsset(path, content);
    if (asset === undefined) {
      unregistered.push(path);
      continue;
    }
    assets.push(asset);
    for (const message of asset.problems) problems.push({ path: asset.path, message });
  }

  const outlinePaths = new Set(assets.filter((a) => a.kind === "outline").map((a) => a.path));
  const beatPaths = new Set(assets.filter((a) => a.kind === "beat").map((a) => a.path));
  for (const asset of assets) {
    if (asset.kind === "beat") {
      const link = asString(asset.frontmatter.outline);
      if (link !== undefined) {
        const cleanLink = link.replace(/\\/g, "/");
        if (!outlinePaths.has(cleanLink)) {
          problems.push({ path: asset.path, message: `指向的大纲不存在：${link}` });
        } else if (!isBeatPath(asset.path, cleanLink)) {
          problems.push({ path: asset.path, message: `不在所属大纲的节拍目录里：${beatDirOf(cleanLink)}/` });
        }
      }
    }
    if (asset.kind === "chapter") {
      const link = asString(asset.frontmatter.beat);
      if (link !== undefined && link !== "" && !beatPaths.has(link.replace(/\\/g, "/"))) {
        problems.push({ path: asset.path, message: `指向的节拍不存在：${link}` });
      }
    }
  }

  assets.sort(compareAssets);
  return { assets, unregistered, problems };
}

function kindRank(id: string): number {
  const at = assetKinds().findIndex((k) => k.id === id);
  return at < 0 ? assetKinds().length : at;
}

function compareAssets(a: Asset, b: Asset): number {
  const byKind = kindRank(a.kind) - kindRank(b.kind);
  if (byKind !== 0) return byKind;
  const ao = asInteger(a.frontmatter.order) ?? 0;
  const bo = asInteger(b.frontmatter.order) ?? 0;
  if (ao !== bo) return ao - bo;
  return a.title.localeCompare(b.title, "zh", { numeric: true });
}

/** 读一份资产；不存在 / 路径未登记 → `undefined`。 */
export async function readAsset(projectId: string, path: string): Promise<Asset | undefined> {
  const content = await readDoc(projectId, path);
  if (content === undefined) return undefined;
  return parseAsset(path, content);
}

export interface CreateAssetInput {
  kind: string;
  title: string;
  /** 显式路径；不给就按种类的 createPath 算。必须与 kind 对得上。 */
  path?: string;
  frontmatter?: Frontmatter;
  body?: string;
}

export type AssetResult = { ok: true; asset: Asset } | { ok: false; error: string };

function nextOrder(assets: readonly Asset[], kind: string, outline?: string): number {
  const siblings = assets.filter(
    (a) => a.kind === kind && (outline === undefined || asString(a.frontmatter.outline) === outline),
  );
  const max = siblings.reduce((acc, a) => Math.max(acc, asInteger(a.frontmatter.order) ?? 0), 0);
  return max + 1;
}

function defaultsOf(kind: AssetKind): Frontmatter {
  const out: Frontmatter = {};
  for (const field of kind.fields) {
    if (field.default !== undefined) out[field.key] = field.default;
  }
  return out;
}

/**
 * 新建一份资产。路径不与种类对上、必填缺、节拍指向的大纲不存在 → 拒绝并说清。
 * 落盘是排他的（期望不存在）：同名文件已存在时返回错误而不是覆盖。
 */
export async function createAsset(projectId: string, input: CreateAssetInput): Promise<AssetResult> {
  const kind = assetKindById(input.kind);
  if (kind === undefined) {
    return {
      ok: false,
      error: `没有这种资产：${input.kind}。已登记：${assetKinds().map((k) => k.id).join(" / ")}`,
    };
  }
  const title = input.title.trim();
  if (title === "") return { ok: false, error: "资产标题不能为空" };

  const index = await listAssets(projectId);
  const provided = input.frontmatter ?? {};
  const declaredKind = asString(provided.kind);
  if (declaredKind !== undefined && declaredKind !== kind.id) {
    return { ok: false, error: `frontmatter.kind=${declaredKind} 与要新建的 ${kind.id} 不一致` };
  }
  const frontmatter: Frontmatter = {
    ...defaultsOf(kind),
    ...provided,
    kind: kind.id,
    title,
  };
  const outlineLink = asString(frontmatter.outline)?.replace(/\\/g, "/");
  const wantsOrder = kind.fields.some((f) => f.key === "order");
  // order 的缺省值不能先于"排在谁后面"算：先落 0 会把新资产永远拍在最前，路径名也会与顺序脱节。
  const order =
    wantsOrder && provided.order === undefined
      ? nextOrder(index.assets, kind.id, kind.id === "beat" ? outlineLink : undefined)
      : undefined;
  if (order !== undefined) frontmatter.order = order;

  let path = input.path?.replace(/\\/g, "/");
  if (path === undefined) {
    if (kind.id === "beat") {
      if (outlineLink === undefined) {
        return { ok: false, error: "新建节拍要给出所属大纲（frontmatter.outline），路径由大纲决定" };
      }
      path = `${beatDirOf(outlineLink)}/b${String(order ?? 1).padStart(2, "0")}.md`;
    } else if (kind.createPath !== undefined) {
      const candidate = kind.createPath(safeSegment(title));
      if (candidate === undefined) return { ok: false, error: `「${kind.label}」不支持按标题新建，请显式给 path` };
      path = candidate;
    } else {
      return { ok: false, error: `「${kind.label}」需要显式给 path` };
    }
  }
  const cleanPath = safeAssetPath(path);
  if (cleanPath === undefined) return { ok: false, error: `路径不合法：${path}` };
  const pathKind = kindOf(cleanPath);
  if (pathKind?.id !== kind.id) {
    return { ok: false, error: `路径 ${cleanPath} 不是「${kind.label}」的位置（判定为：${pathKind?.label ?? "未登记"}）` };
  }

  if (kind.id === "beat") {
    if (outlineLink === undefined) return { ok: false, error: "节拍必须声明所属大纲（frontmatter.outline）" };
    if (!isBeatPath(cleanPath, outlineLink)) {
      return { ok: false, error: `节拍要放在所属大纲的节拍目录里：${beatDirOf(outlineLink)}/` };
    }
    const linkProblem = await validateBeatLink(projectId, frontmatter);
    if (linkProblem !== undefined) return { ok: false, error: linkProblem };
  }
  if (kind.id === "brief") {
    const existing = index.assets.find((a) => a.kind === "brief");
    if (existing !== undefined) return { ok: false, error: `这本书已经有概览：${existing.path}` };
  }
  if (await fileExists(projectId, cleanPath)) return { ok: false, error: `文件已存在：${cleanPath}` };

  if (kind.id === "character") frontmatter.name = asString(frontmatter.name) ?? title;

  const problems = validateFields(kind, frontmatter);
  if (problems.length > 0) return { ok: false, error: problems.join("；") };

  const body = input.body?.trim() ? input.body : `# ${title}\n`;
  const content = withFrontmatter(frontmatter, body, frontmatterOrder(kind));
  const abs = docAbs(projectId, cleanPath);
  if (abs === undefined) return { ok: false, error: `路径不在三个根之内：${cleanPath}` };
  try {
    await writeIfUnchanged({ abs, expected: null, content });
  } catch (e) {
    if (e instanceof StaleContentError) return { ok: false, error: `文件在创建过程中被改动：${cleanPath}` };
    throw e;
  }
  const asset = parseAsset(cleanPath, content);
  if (asset === undefined) return { ok: false, error: `新建后解析失败：${cleanPath}` };
  return { ok: true, asset };
}

export interface UpdateAssetInput {
  path: string;
  /** 调用方读到的那份字节；不给就现读一次（仍会 CAS，但保护不到"读与更之间"） */
  expected?: string;
  frontmatter?: Frontmatter;
  /** 要删掉的 frontmatter 键（传 undefined 不会删，要删请列在这里） */
  drop?: readonly string[];
  body?: string;
}

/** 按字段合并更新；未知字段原样保留。CAS 失败返回 stale 文案，不覆盖别人的改动。 */
export async function updateAsset(projectId: string, input: UpdateAssetInput): Promise<AssetResult> {
  const path = input.path.replace(/\\/g, "/");
  const current = await readAsset(projectId, path);
  if (current === undefined) return { ok: false, error: `没有这份资产：${path}` };
  if (current.problems.length > 0) {
    return { ok: false, error: `这份文件的头部有问题，先修好再改：${current.problems.join("；")}` };
  }
  const kind = assetKindById(current.kind);
  if (kind === undefined) return { ok: false, error: `未登记的资产种类：${current.kind}` };

  const merged: Frontmatter = { ...current.frontmatter, ...(input.frontmatter ?? {}) };
  for (const key of input.drop ?? []) delete merged[key];
  if (merged.kind === undefined) merged.kind = kind.id;
  if (merged.title === undefined && current.frontmatter.title === undefined) merged.title = current.title;

  const problems = validateFields(kind, merged);
  if (problems.length > 0) return { ok: false, error: problems.join("；") };
  if (kind.id === "beat") {
    const linkProblem = await validateBeatLink(projectId, merged);
    if (linkProblem !== undefined) return { ok: false, error: linkProblem };
    const link = asString(merged.outline);
    if (link === undefined || !isBeatPath(path, link.replace(/\\/g, "/"))) {
      return {
        ok: false,
        error: `节拍不在所属大纲的节拍目录里（${beatDirOf((link ?? "").replace(/\\/g, "/"))}/）；先 move 到正确位置再改归属`,
      };
    }
  }

  const body = input.body ?? current.body;
  const content = withFrontmatter(merged, body, frontmatterOrder(kind));
  const abs = docAbs(projectId, path);
  if (abs === undefined) return { ok: false, error: `路径不在三个根之内：${path}` };
  try {
    await writeIfUnchanged({ abs, expected: input.expected ?? current.content, content });
  } catch (e) {
    if (e instanceof StaleContentError) return { ok: false, error: `文件在读取之后被改动过，请重新读：${path}` };
    throw e;
  }
  const asset = parseAsset(path, content);
  return asset === undefined ? { ok: false, error: `更新后解析失败：${path}` } : { ok: true, asset };
}

export interface MoveAssetInput {
  path: string;
  to: string;
  expected?: string;
}

/** 改名/换位置。种类必须不变、目标不能已存在；大纲有节拍时拒绝（先处理节拍）。 */
export async function moveAsset(projectId: string, input: MoveAssetInput): Promise<AssetResult> {
  const from = input.path.replace(/\\/g, "/");
  const to = input.to.replace(/\\/g, "/");
  const asset = await readAsset(projectId, from);
  if (asset === undefined) return { ok: false, error: `没有这份资产：${from}` };
  if (asset.problems.length > 0) return { ok: false, error: `这份文件的头部有问题，先修好再动：${asset.problems.join("；")}` };

  const cleanTo = safeAssetPath(to);
  if (cleanTo === undefined) return { ok: false, error: `目标路径不合法：${to}` };
  const toKind = kindOf(cleanTo);
  if (toKind?.id !== asset.kind) {
    return { ok: false, error: `目标 ${cleanTo} 不是「${kindLabelOf(asset)}」的位置（判定为：${toKind?.label ?? "未登记"}）` };
  }
  if (asset.kind === "beat") {
    const link = asString(asset.frontmatter.outline);
    if (link === undefined || !isBeatPath(cleanTo, link)) {
      return { ok: false, error: `节拍只能在所属大纲的节拍目录里移动：${link === undefined ? "（缺 outline）" : beatDirOf(link)}/` };
    }
  }
  if (asset.kind === "outline") {
    const beats = (await listAssets(projectId)).assets.filter(
      (a) => a.kind === "beat" && asString(a.frontmatter.outline) === from,
    );
    if (beats.length > 0) {
      return { ok: false, error: `这份大纲有 ${beats.length} 个节拍指向它，先改节拍的 outline 或先移动节拍：${beats.map((b) => b.path).join("、")}` };
    }
  }
  if (await fileExists(projectId, cleanTo)) return { ok: false, error: `目标已存在：${cleanTo}` };

  const toAbs = docAbs(projectId, cleanTo);
  const fromAbs = docAbs(projectId, from);
  if (toAbs === undefined || fromAbs === undefined) return { ok: false, error: "路径不在三个根之内" };
  try {
    await writeIfUnchanged({ abs: toAbs, expected: null, content: asset.content });
    await removeIfUnchanged({ abs: fromAbs, expected: asset.content });
  } catch (e) {
    if (e instanceof StaleContentError) {
      // 没搬干净就先撤新文件，避免留两份（失败也不吞，下一次 list 会看见）
      await removeIfUnchanged({ abs: toAbs, expected: asset.content }).catch(() => undefined);
      return { ok: false, error: `文件在移动过程中被改动过：${from}` };
    }
    throw e;
  }
  const moved = parseAsset(cleanTo, asset.content);
  return moved === undefined ? { ok: false, error: `移动后解析失败：${cleanTo}` } : { ok: true, asset: moved };
}

function kindLabelOf(asset: Asset): string {
  return assetKindById(asset.kind)?.label ?? asset.kind;
}

export interface DeleteAssetInput {
  path: string;
  expected?: string;
  /** 删大纲时连带删掉指向它的节拍。默认 false：删除不级联，先让调用方决定 */
  cascade?: boolean;
}

export interface DeleteAssetResult {
  ok: true;
  removed: string[];
  warnings: string[];
}

export type DeleteAssetOutcome = DeleteAssetResult | { ok: false; error: string };

/**
 * 删除一份资产。不级联是默认：大纲还有节拍时拒绝并列出它们。
 * 引用检查只做到"节拍 → 大纲"这一层；正文里按名字提到角色这类引用不在这个底座里做。
 */
export async function deleteAsset(projectId: string, input: DeleteAssetInput): Promise<DeleteAssetOutcome> {
  const path = input.path.replace(/\\/g, "/");
  const asset = await readAsset(projectId, path);
  if (asset === undefined) return { ok: false, error: `没有这份资产：${path}` };

  const beats = (await listAssets(projectId)).assets.filter(
    (a) => a.kind === "beat" && asString(a.frontmatter.outline) === path,
  );
  if (asset.kind === "outline" && beats.length > 0 && input.cascade !== true) {
    return { ok: false, error: `这份大纲还有 ${beats.length} 个节拍，先删节拍或传 cascade：${beats.map((b) => b.path).join("、")}` };
  }

  const removed: string[] = [];
  const abs = docAbs(projectId, path);
  if (abs === undefined) return { ok: false, error: `路径不在三个根之内：${path}` };
  try {
    if (input.cascade === true) {
      for (const beat of beats) {
        const beatAbs = docAbs(projectId, beat.path);
        if (beatAbs === undefined) continue;
        await removeIfUnchanged({ abs: beatAbs, expected: beat.content });
        removed.push(beat.path);
      }
    }
    await removeIfUnchanged({ abs, expected: input.expected ?? asset.content });
    removed.push(path);
  } catch (e) {
    if (e instanceof StaleContentError) return { ok: false, error: `文件在读取之后被改动过，请重新读：${path}` };
    throw e;
  }
  return { ok: true, removed, warnings: [] };
}

/** 某份大纲的节拍，按 order 升序。 */
export function beatsOf(assets: readonly Asset[], outlinePath: string): Asset[] {
  return assets
    .filter((a) => a.kind === "beat" && asString(a.frontmatter.outline) === outlinePath)
    .sort((a, b) => (asInteger(a.frontmatter.order) ?? 0) - (asInteger(b.frontmatter.order) ?? 0));
}

export interface ChapterRange {
  /** 1 起的章号，含 */
  start: number;
  /** 含；chapters=1 时与 start 相同 */
  end: number;
}

/**
 * 某一拍覆盖的章号：从大纲的 startChapter 起，按节拍顺序把各自 `chapters` 累加。
 *
 * 不存章号是刻意的——存了就有两份真相，改一拍章数要回头改后面每一拍。公式与 reveric 的
 * `startChapterNum + 累计 chapterCount` 同构；差别是这里把归属声明放在节拍头上。
 */
export function chapterRangeOf(
  outline: Asset,
  beats: readonly Asset[],
  beatPath: string,
): ChapterRange | undefined {
  const startChapter = asInteger(outline.frontmatter.startChapter) ?? 1;
  let start = startChapter;
  for (const beat of beats) {
    const chapters = asInteger(beat.frontmatter.chapters) ?? 1;
    const end = start + Math.max(1, chapters) - 1;
    if (beat.path === beatPath) return { start, end };
    start = end + 1;
  }
  return undefined;
}

/** 读一份资产；不存在 / 路径未登记 → `undefined`。 */