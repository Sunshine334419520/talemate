/**
 * assetkinds：资产种类定义（`assets/kinds/<id>.json`）的加载与校验。
 *
 * 一种资产一个 JSON：`id` / `label` / `section` / `order` / `match` / `create` / `fields`。
 * 定义是产品数据，不是代码——改标签、加字段、调枚举都在 JSON 里改，人可以直接读、直接 diff；
 * 代码只做加载、校验、消费。**加一种资产 = 加一个 JSON**，没有第二处要改。
 *
 * 为什么不是自定义的 txt 语法：定义里剩下的全是结构化数据（路径模式、字段类型、枚举值与默认值），
 * 没有需要保留的散文。JSON 现成能解析、能严格校验、IDE 与 diff 都认识；自定义语法只会多一个
 * 要维护的解析器。人类可读性靠缩进与键名保证——`docs/assets.md` 与同目录 README 解释每个键。
 *
 * 为什么运行时读盘而不是 `import "./x.json"`：`src/` 同时跑在 Bun、Node（测试/桌面探针）与
 * Electron 主进程（esbuild）里，静态导入要三套构建配置各教一次；`prompts/` 已经证明了
 * "资源根 + 运行时读"这条路的打包分发是通的（`setResourceRoot` 在 prelude 里钉根）。
 *
 * 边界：只产出 `AssetKind`。路径判定、frontmatter 校验与增删改查都在 `framework/assets.ts`；
 * 这里不认识任何一个具体种类。
 */
import { readKindDefinitions, kindDefinitionsDir } from "../storage/kind_definitions";
import type { FrontmatterValue } from "./frontmatter";

/** 枚举的一个取值：`value` 是写进 frontmatter 的稳定值，`label` 是给人看的。 */
export interface AssetOption {
  value: string;
  label: string;
}

export interface AssetField {
  /** frontmatter 的键，同时是校验的字段名 */
  key: string;
  /** 中文标签，给 UI 与文档用；代码里不拿它当判据 */
  label: string;
  type: "string" | "number" | "enum" | "string-list";
  /** type=enum 时的合法值 */
  values?: readonly AssetOption[];
  required?: boolean;
  /** 新建时写进 frontmatter 的缺省值；读取时不回填 */
  default?: FrontmatterValue;
  /** 允许的最小值（number），不填不限 */
  min?: number;
}

export interface AssetKind {
  /** 稳定 id，写进 frontmatter.kind；不要改名（改名要迁移所有文件） */
  id: string;
  /** 中文名，给用户看的 */
  label: string;
  /** 一段简短定位，给模型看的；不是正文规范，也不做校验 */
  description?: string;
  /** 目录树的分组名 */
  section: string;
  /** 列表与目录里的排序权重（同 section 内按它，再按标题） */
  order: number;
  /** 路径模式，glob（`*` 跨 `/`）。同一路径命中多个时更长的模式胜出 */
  match: readonly string[];
  /** `design/characters/{title}.md` 这样的模板；不给 = 只能显式传 path（如章节） */
  createPath?: (title: string) => string;
  fields: readonly AssetField[];
}

/** 定义文件所在目录：随包数据根（或仓库根）下的 `assets/kinds/`。 */
export function assetKindsDir(): string {
  return kindDefinitionsDir();
}

const TYPES = new Set(["string", "number", "enum", "string-list"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  at: string,
): string[] {
  return Object.keys(value)
    .filter((k) => !allowed.includes(k))
    .map((k) => `${at}：不认识的键「${k}」；只认 ${allowed.join(" / ")}`);
}

/**
 * 解析一份定义。格式与每个键的含义见 `assets/kinds/README.md`。
 * 解析/校验失败直接抛，消息里带文件名——定义坏了是维护者的问题，不该静默降级成"这种资产不存在"。
 */
export function parseAssetKind(text: string, file: string): AssetKind {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file}：不是合法 JSON（${(e as Error).message}）`);
  }
  if (!isRecord(raw)) throw new Error(`${file}：顶层应该是一个对象`);

  const problems = expectKeys(raw, ["id", "label", "description", "section", "order", "match", "create", "fields"], file);
  const readString = (key: string): string => {
    const v = raw[key];
    if (typeof v !== "string" || v.trim() === "") throw new Error(`${file}：${key} 必须是非空字符串`);
    return v;
  };
  const id = readString("id");
  const label = readString("label");
  const descriptionValue = raw.description;
  if (descriptionValue !== undefined && (typeof descriptionValue !== "string" || descriptionValue.trim() === "")) {
    throw new Error(`${file}：description 如果是字符串，必须非空`);
  }
  const section = readString("section");

  const orderValue = raw.order;
  if (typeof orderValue !== "number" || !Number.isInteger(orderValue)) {
    throw new Error(`${file}：order 必须是整数`);
  }

  const matchValue = raw.match;
  if (!Array.isArray(matchValue) || matchValue.length === 0 || matchValue.some((m) => typeof m !== "string" || m.trim() === "")) {
    throw new Error(`${file}：match 必须是非空字符串数组`);
  }

  const createValue = raw.create;
  if (createValue !== undefined && (typeof createValue !== "string" || createValue.trim() === "")) {
    throw new Error(`${file}：create 必须是非空字符串模板`);
  }

  const fieldsValue = raw.fields;
  if (!Array.isArray(fieldsValue)) throw new Error(`${file}：fields 必须是数组`);

  const fields: AssetField[] = [];
  for (let i = 0; i < fieldsValue.length; i += 1) {
    const item = fieldsValue[i];
    const at = `${file}：fields[${i}]`;
    if (!isRecord(item)) throw new Error(`${at} 应该是对象`);
    problems.push(...expectKeys(item, ["key", "label", "type", "values", "required", "default", "min"], at));
    const key = item.key;
    const fieldLabel = item.label;
    const type = item.type;
    if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
      throw new Error(`${at}：key 不合法（${String(key)}）`);
    }
    if (typeof fieldLabel !== "string" || fieldLabel.trim() === "") throw new Error(`${at}：label 必须是非空字符串`);
    if (typeof type !== "string" || !TYPES.has(type)) {
      throw new Error(`${at}：type 只能是 string / number / enum / string-list（收到：${String(type)}）`);
    }
    if (fields.some((f) => f.key === key)) throw new Error(`${at}：字段「${key}」重复`);

    const field: AssetField = {
      key,
      label: fieldLabel,
      type: type as AssetField["type"],
    };
    if (item.required !== undefined) {
      if (typeof item.required !== "boolean") throw new Error(`${at}：required 必须是 true/false`);
      if (item.required) field.required = true;
    }
    if (item.min !== undefined) {
      if (typeof item.min !== "number" || !Number.isInteger(item.min)) throw new Error(`${at}：min 必须是整数`);
      field.min = item.min;
    }
    if (field.type === "enum") {
      const values = item.values;
      if (!Array.isArray(values) || values.length === 0) throw new Error(`${at}：enum 字段必须给 values`);
      const options: AssetOption[] = [];
      for (const option of values) {
        if (!isRecord(option) || typeof option.value !== "string" || typeof option.label !== "string") {
          throw new Error(`${at}：values 每项应该是 { value, label }`);
        }
        if (options.some((o) => o.value === option.value)) throw new Error(`${at}：枚举值「${option.value}」重复`);
        options.push({ value: option.value, label: option.label });
      }
      field.values = options;
    } else if (item.values !== undefined) {
      throw new Error(`${at}：只有 enum 字段能写 values`);
    }
    if (item.default !== undefined) {
      field.default = parseDefault(field, item.default, at);
    }
    fields.push(field);
  }

  if (problems.length > 0) throw new Error(problems.join("；"));

  const kind: AssetKind = {
    id,
    label,
    ...(typeof descriptionValue === "string" ? { description: descriptionValue.trim() } : {}),
    section,
    order: orderValue,
    match: matchValue,
    fields,
  };
  if (typeof createValue === "string") {
    kind.createPath = (title: string): string =>
      createValue.includes("{title}") ? createValue.replaceAll("{title}", title) : createValue;
  }
  return kind;
}

function parseDefault(field: AssetField, value: unknown, at: string): FrontmatterValue {
  if (field.type === "number") {
    if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${at}：默认值应该是整数`);
    if (field.min !== undefined && value < field.min) throw new Error(`${at}：默认值不能小于 ${field.min}`);
    return value;
  }
  if (field.type === "enum") {
    if (typeof value !== "string" || !field.values?.some((o) => o.value === value)) {
      throw new Error(`${at}：默认值不在 values 里（${String(value)}）`);
    }
    return value;
  }
  if (field.type === "string-list") {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      throw new Error(`${at}：默认值应该是字符串数组`);
    }
    return value;
  }
  if (typeof value !== "string") throw new Error(`${at}：默认值应该是字符串`);
  return value;
}

/**
 * 扫目录加载全部定义，按 `order` 再按文件名排序。目录不存在或一个定义都没有 → 抛错：
 * 那是打包漏了资源或仓库结构坏了，静默返回空表会让"所有文档都不是资产"这种故障看起来像空书。
 */
export function loadAssetKinds(dir = assetKindsDir()): AssetKind[] {
  const files = readKindDefinitions(dir).filter((f) => f.name.endsWith(".json"));
  if (files.length === 0) throw new Error(`资产定义目录里没有 .json：${dir}`);

  const kinds: AssetKind[] = [];
  for (const file of files) {
    const kind = parseAssetKind(file.text, file.path);
    const expectedId = file.name.replace(/\.json$/, "");
    if (kind.id !== expectedId) {
      throw new Error(`${file.path}：id=${kind.id} 与文件名不一致（文件名即 id）`);
    }
    if (kinds.some((k) => k.id === kind.id)) throw new Error(`${file.path}：id=${kind.id} 重复`);
    kinds.push(kind);
  }
  const seen = new Map<string, string>();
  for (const kind of kinds) {
    for (const pattern of kind.match) {
      const prev = seen.get(pattern);
      if (prev !== undefined) throw new Error(`路径模式 ${pattern} 同时被 ${prev} 与 ${kind.id} 登记`);
      seen.set(pattern, kind.id);
    }
  }
  kinds.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return kinds;
}

let cache: readonly AssetKind[] | undefined;

/** 进程内缓存：一次进程只解析一次。`clearAssetKindCache` 只给测试与开发者用。 */
export function assetKinds(): readonly AssetKind[] {
  cache ??= loadAssetKinds();
  return cache;
}

export function clearAssetKindCache(): void {
  cache = undefined;
}

export function assetKindById(id: string): AssetKind | undefined {
  return assetKinds().find((k) => k.id === id);
}

/**
 * 给模型的资产目录：每种文档一段简短定位 + 一个路径模式。
 * 它不是正文规范，也不进校验；只回答"这个文件是干什么的"。
 */
export function renderAssetCatalog(kinds: readonly AssetKind[] = assetKinds()): string {
  const lines = ["<assets>", "Design document kinds and what each is for:"];
  for (const kind of kinds) {
    const path = kind.match[0] ?? "";
    const what = kind.description === undefined ? "" : `: ${kind.description}`;
    lines.push(`- ${kind.label} (${path})${what}`);
  }
  lines.push("</assets>");
  return lines.join("\n");
}