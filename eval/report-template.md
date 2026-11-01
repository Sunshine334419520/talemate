# <改动名> vs baseline

> runId：`<runId>` · case 数：`<n>` · 重复：`<k>` · 时钟：`<TALEMATE_TODAY>` · 日期：`<date>`

## 结论（一句话）

采用 / 不采用 / 证据不足。

## 主表

| family | cases | pass^k | rubric | pairwise | 步数（Δ） | token（Δ） |
|---|---:|---:|---:|---:|---:|---:|
| workflow |  |  | — | — |  |  |
| prose |  |  |  |  |  |  |
| design |  |  | — | — |  |  |
| context |  |  |  |  |  |  |
| routing |  |  | — | — |  |  |
| safety |  |  | — | — |  |  |

## 分层

按 difficulty / case 列出失败项；不要只给总数。

## 失败桶迁移

| 失败桶 | baseline | 本次 | 说明 |
|---|---:|---:|---|
| no-tool |  |  |  |
| wrong-tool |  |  |  |
| approval-skipped |  |  |  |
| file-wrong |  |  |  |
| constraint-lost |  |  |  |
| timeout |  |  |  |
| provider-error |  |  |  |
| budget-exceeded |  |  |  |

## 成本

相对 baseline 的 token / 步数 / 墙钟变化；给出 ±%。

## 判断

- [ ] base case 100% 通过（pass^k，k=3）
- [ ] 目标 family 达到事先写的阈值
- [ ] 成本不超过 baseline +15%
- [ ] 其他 family 没有超过阈值的回退
- [ ] holdout 上没有反向证据
- [ ] 与事先写好的决策规则逐条对照

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
