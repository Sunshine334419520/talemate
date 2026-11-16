# judge 校准

## 打分

看 `eval/rubric/<rubric>.md`，四个维度各给 **1 / 3 / 5**（不要 2 / 4），然后填进
`calibration.jsonl` 的 `human`：

```json
{"id":"A","sample":"eval/judge/samples/A.md","human":4.0}
```

`human` 可以是四维平均（1–5），不要求和 judge 的维度一一对应；κ/MAE 只比总分。

## 跑

```bash
bun run eval:judge --calibration eval/judge/calibration.jsonl --rubric prose-chapter-basic
```

输出：每个样本的 judge 分、维度、理由；有 `human` 时打印 quadratic weighted κ 与 MAE。
`n < 5` 时 κ 只能当方向，不能当结论。

## 当前样本

- `samples/A.md`、`samples/B.md`：同一道题的两个版本，盲评对在 `reports/2026-11-01-pairwise/`；
  两版只差一处——`prose.rules` 的「No AI tells」是否删除。
- `samples/C.md`、`samples/D.md`：`prose-chapter-basic` 两次复跑的正文（同题，取自 `traces/`）。
- `samples/E.md`：`prose-chapter-pairwise` 另一次复跑的正文。
- 五份样本的 `human` 仍全为 null，所以还没有 κ；judge 给 A/B 都是 5.0，暂时分不出差异。

A/B 同题、C/D 同题，样本间不完全独立；κ 只当方向指标，不要拿它当精确的评分器质检。
