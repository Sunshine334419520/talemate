# 资产种类定义

一种资产一个 JSON（文件名即 id：`character.json` → `kind: character`）。代码扫这个目录加载；
**加一种资产 = 加一个文件**，不需要改 TypeScript。

## 一个完整例子

```json
{
  "id": "character",
  "label": "角色",
  "description": "One character: who they are, what they want, what they fear, where their line is, and how they speak. Write what will constrain their next action and line; not a biography.",
  "section": "角色",
  "order": 40,
  "match": ["design/characters/*.md"],
  "create": "design/characters/{title}.md",
  "fields": [
    { "key": "title", "label": "标题", "type": "string" },
    {
      "key": "role",
      "label": "定位",
      "type": "enum",
      "default": "supporting",
      "values": [
        { "value": "protagonist", "label": "主角" },
        { "value": "supporting", "label": "配角" }
      ]
    }
  ]
}
```

## 键

| 键 | 必填 | 含义 |
|---|---|---|
| `id` | 是 | 稳定 id，与文件名一致；写进正文文件的 `frontmatter.kind`。**不要改名** |
| `label` | 是 | 中文名，给人看的 |
| `description` | 否 | 一段简短定位，给模型看；不是正文规范，也不做校验 |
| `section` | 是 | 目录树的分组名 |
| `order` | 是 | 整数；列表与目录里的组序权重 |
| `match` | 是 | 路径 glob 数组（`*` 跨 `/`）；同一路径命中多个时更长的模式胜出，但**不允许重复登记** |
| `create` | 否 | 新建时的路径模板，`{title}` 会被替换；不写 = 只能显式传 path（如章节） |
| `fields` | 是 | 字段数组，可为空 |

## 字段

| 键 | 必填 | 含义 |
|---|---|---|
| `key` | 是 | 写进 frontmatter 的键，`[A-Za-z_][A-Za-z0-9_-]*` |
| `label` | 是 | 中文标签，给 UI 用 |
| `type` | 是 | `string` / `number` / `enum` / `string-list` |
| `values` | enum 必填 | `[{ "value": "...", "label": "..." }]`；`value` 是存进 frontmatter 的稳定值 |
| `required` | 否 | `true` 时新建/更新必须给值 |
| `default` | 否 | 新建时的默认值；enum 必须在 `values` 里，number 必须是整数 |
| `min` | 否 | 仅 `number`，最小值 |

## 校验

加载时直接报错（带文件路径）的情形：不是合法 JSON、顶层不是对象、出现不认识的键、
`id` 与文件名不一致、路径模式重复、enum 缺 `values`、默认值不合法。**写错不会静默忽略。**

## 说明

定义里除一段简短 `description`（资产定位，给模型看）外，只放机器要用的东西。正文怎么写归 `docs/` 里的文档与将来的模板，不在这里重复；维护者的备注也写在这里（本文件）或 `docs/assets.md`，不塞进定义。