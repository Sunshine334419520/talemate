# prose-no-ai-tells vs baseline

> 时钟：`2026-11-01` · case：1 · 变体：prose-no-ai-tells · 删掉 prose.rules 的「No AI tells」整条，看正文质量是否变差

## 结论

两组结果没有差异（判据维度）。

## 主表

| case | family | baseline | variant | 判据变化 | token Δ |
|---|---|---|---|---|---:|
| prose-chapter-pairwise | prose | ✅ | ✅ | — | -5% |

## 成本

- baseline 首轮 token：40932
- prose-no-ai-tells 首轮 token：38935
- 失败桶：无

## Manifest

```json
{
  "runId": "prose-chapter-pairwise-r0",
  "caseHash": "3b7a1b18463addad9b5e9b23f3a42c9b592e08c4a546559158c9cd012d18d9a8",
  "promptHash": "07229d06416d9ca169970bd92cf5ced7eea0811c7519ada40f6cfc4f0aef3cd1",
  "promptParts": {
    "system": "66a9a936d0f8e7bee818c9bc81a0207b815bf1225fc6868211bc2e15b885255b",
    "tools": "47b600ba9526c5dae957ad0fda941dc6acf2225cfd1171e46d32cfe859ca226c",
    "messages": "db036618aae2754b5104ff9b86886166c921a645a3f93d60d458fdfde6fd0a24"
  },
  "contextHash": "c6c5759b6b2d5814c93923a3e2fe577aa2db393b40cbabca20cc607b74865a0f",
  "toolsHash": "47b600ba9526c5dae957ad0fda941dc6acf2225cfd1171e46d32cfe859ca226c",
  "model": {
    "provider": "openai",
    "model": "deepseek-v4-flash",
    "reasoning": "low",
    "temperature": 0.8,
    "maxTokens": 32000
  },
  "codeCommit": "fe97fb64392c8779759bf467b4baab7e5124d51c",
  "bun": "1.4.0",
  "clock": "2026-11-01"
}
```
