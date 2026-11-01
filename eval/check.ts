/**
 * `bun run eval:check`：只校验 case 契约，不调模型。
 *
 * 它是 M0 的完成标志：case 能被 runner 无歧义地读懂、fixtures 与 rubric 都存在。
 * 有结构问题就一次列全并退出 1，不要等花了 token 才发现 case 读不了。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAll, validateVariants } from "./validate";

const root = dirname(fileURLToPath(import.meta.url));
const { cases, base, holdout, issues } = await validateAll(root);
const variants = await validateVariants(root);
const all = [...issues, ...variants.issues];

if (all.length > 0) {
  console.error(`✘ ${all.length} 个问题：`);
  for (const issue of all) console.error(`  · ${issue.where}：${issue.message}`);
  process.exit(1);
}

console.log(`✔ ${cases} 个 case（base ${base} · holdout ${holdout}）· ${variants.variants} 个变体`);
