# 待录制的 case

这里放已经写好、但还没有 cassette 的 case。`eval/check.ts` 与 `eval/run.ts` 只扫 `eval/cases/`，
所以它们不会让门禁红；录完把目录移回 `eval/cases/` 即可。

当前：

- `context-compaction-retains`：需要 5 轮 + 低压缩阈值，录制成本约 60–100k token，且可能暴露压缩丢约束的真实问题。
- `routing-delegate-planner`：与 `workflow-plan-gate` 重叠（都验证 task），优先级低。

录制前先量一次：`bun run eval:run --case <id> --record --repeat 1 --max-tokens 100000`。
