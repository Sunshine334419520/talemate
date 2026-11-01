# write-no-edit-hint vs baseline

> 时钟：`2026-11-01` · case：1 · 变体：write-no-edit-hint · 去掉 write 描述里「局部改用 edit」的提示，看设计编辑 case 会不会改走整篇写

## 结论

两组结果没有差异（判据维度）。

## 主表

| case | family | baseline | variant | 判据变化 | token Δ |
|---|---|---|---|---|---:|
| design-edit-section | design | ✅ | ✅ | — | 48% |

## 成本

- baseline 首轮 token：16243
- write-no-edit-hint 首轮 token：24061
- 失败桶：无

## Manifest

```json
{
  "runId": "design-edit-section-r0",
  "caseHash": "177e5cc637473cfb20d1b249dc4578c473536ef1bd9121563c3ceef9ad12add2",
  "promptHash": "5a43c1d02ac87331ae7acae49c636a92e7dc8e898927e3328ad45197657d82e1",
  "promptParts": {
    "system": "1fb13f7a7d2296e91482087827392eaad6be3b3f217246b178441e05670e0876",
    "tools": "47b600ba9526c5dae957ad0fda941dc6acf2225cfd1171e46d32cfe859ca226c",
    "messages": "743bb01713b50eb182b0e65df8c617b277902503ed60c38fd2329f36ae36833b"
  },
  "contextHash": "9eb4f8525f61aef93a1780380fd1e8cad66a88e64074265e6ec4c9206d7cee3e",
  "toolsHash": "47b600ba9526c5dae957ad0fda941dc6acf2225cfd1171e46d32cfe859ca226c",
  "model": {
    "provider": "openai",
    "model": "deepseek-v4-flash",
    "reasoning": "low",
    "temperature": 0.8,
    "maxTokens": 32000
  },
  "codeCommit": "80b6fe5eb89dcbdb0dea5786fd7dfda108bbd128",
  "bun": "1.4.0",
  "clock": "2026-11-01"
}
```
