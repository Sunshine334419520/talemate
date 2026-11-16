# <改动名> vs baseline

> 时钟：`<TALEMATE_TODAY>` · case：`<n>` · 变体：`<id>` · `<note>`

## 结论

**采用 / 不采用 / 证据不足** — 规则通过 `<n>`、未验证 `<n>`、不通过 `<n>`。

`<k>` 个 case 的结果变了：`<id>`、`<id>`。

## 主表

| case | family | baseline | variant | 判据变化 | token Δ |
|---|---|---|---|---|---:|
| `<case-id>` | `<family>` | ✅ | ❌ | `+tool-called` | +12% |

## 分层

| family | baseline 通过 | variant 通过 | 变化 |
|---|---:|---:|---:|
| `<family>` | `<a>/<n>` | `<b>/<n>` | `+1` |

## 配对显著性

- 由过变败 b=`<n>`，由败变过 c=`<n>`；McNemar 精确双侧 p=`<p>`。

## 失败桶迁移

| 桶 | baseline | variant | Δ |
|---|---:|---:|---:|
| `<failureBucket>` | `<n>` | `<n>` | `+1` |

## 成本

- baseline 首轮：token `<n>` · 步数 `<n>`
- `<variant>` 首轮：token `<n>`（`+x%`）· 步数 `<n>`（`+y%`）
- 人民币：未接价目表（costYuan 固定为 0）

## 判断

| # | 规则 | 结果 | 依据 |
|---:|---|---|---|
| 1 | base case 100% 通过（pass^k） | ✅ 通过 | `<n>` 个 base case 全过 |
| 2 | 目标 family 达阈值 | ⚠ 未验证 | 没有指定 `--target-family` |
| 3 | 成本 ≤ baseline +15% | ✅ 通过 | token `+x%`，步数 `+y%` |
| 4 | 其他 family 无回退 | ✅ 通过 | `<n>` 个 case 无回退 |
| 5 | holdout 无反向证据 | ⚠ 未验证 | 本轮没有 holdout case |

## Manifest

```json
{
  "promptHash": "",
  "contextHash": "",
  "toolsHash": "",
  "model": { "provider": "", "model": "" },
  "codeCommit": "",
  "bun": "",
  "clock": ""
}
```