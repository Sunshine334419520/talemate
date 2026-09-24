# CLAUDE.md

talemate — an AI novel-writing agent. TypeScript on Bun; CLI + agent harness. What it is and why: `docs/product.md`.

## Commands

```bash
bun test                 # unit tests — all offline, no LLM calls
bun run typecheck        # tsc --noEmit   (tsconfig excludes tests/ — test files are not typechecked)
bun run probe --check    # validates ablation patch strings; no model calls
bun run smoke            # mock-provider end-to-end, needs no API key
```

**IMPORTANT — this is the definition of done: `bun test` + `bun run typecheck` must pass.** If you touched `prompts/` or `src/probe/`, also run `bun run probe --check`: a prompt edit silently invalidates the ablation baseline, and the check is the only thing that notices.

## Language

The split is by **audience**, and it is not negotiable:

- **Model-facing → English.** Tool `description`, JSON-schema field descriptions, `prompts/*.txt` and `prompts/tools/*.txt`, this file.
- **Human-facing → Chinese.** `src/**` comments, tool `output` and error text, `confirm` text, CLI output, `docs/**`, `prompts/README.md`.

So: a new tool's `description` is English, but the message it returns on success is Chinese.

## Code conventions

- **No `export default`** — zero in this codebase. Always inline named exports.
- **`export function` / `export async function`** — never `export const x = () => {}`.
- **Every source file opens with a `/** ... */` block comment** stating what the module is and where its boundaries are. Files that own a policy (see `framework/design_ops.ts`, `tool/web_tools.ts`) put the policy there as a numbered list or ASCII diagram. (`src/legacy/` predates this rule and is exempt — it's dead code.)
- **Comments explain *why*, not *what*.** This is the strongest habit in the repo — comments record the bug that motivated the code, the thing that was tried and rejected, the invariant that must hold. Match that; a comment restating the line below it is noise.
- **Types**: cross-layer ones live in `src/core/types.ts`; module-local ones are defined in place next to their module. Export `interface` / `type` — never a bare object-shape alias.
- **`strict` TypeScript, no escape hatches**: no `any`, no `@ts-ignore`, no `@ts-expect-error`.
- **No linter or formatter is configured.** Match the surrounding file: 2-space indent, double quotes, semicolons.
- **`as const`** only to narrow a literal (a string that feeds a union, an array used as a source of truth). `_` prefix for unused params (`_args`) and runtime marker fields (`_type`).
- **`src/legacy/` is dead code** — nothing imports it. Don't copy from it, don't fix it.

## Tool conventions

```ts
const P = (id: string) => readPrompt(`tools/${id}`);   // top of every file that DEFINES a tool, verbatim

export const skillTool: RegisteredTool<{ name: string }> = defineTool<{ name: string }>({
  id: "skill",
  description: P("skill"),                              // never inline the description
  input: { type: "object", properties: { name: { type: "string", description: "Skill name" } }, required: ["name"] },
  async execute(args, ctx) { /* ... */ },
});
```

- **`description` always comes from `P(id)`** — i.e. from `prompts/tools/<id>.txt`, 1:1 with the tool id. The TS filename is the *domain* (`read_tools.ts` holds the three read verbs); the id is the *action*.
- **Errors the model can fix go through `return`, not `throw`.** Bad argument, missing section, guard rejection — return `{ output: "..." }` with a message that lets the model correct its own call; that message *is* what recovers the turn. Failures it cannot fix by re-calling (HTTP status, size limit, binary content) may `throw` — `runner.ts` catches and turns it into an `error` part, so the message still reaches the model. What's forbidden is catching and re-throwing.
- **Error messages have three shapes** — keep them: `"<tool> 缺少 <field>（收到：<JSON.stringify(args).slice(0, 200)>）——请…重新调用"`; `"没有找到 <X>「<名>」。可用小节：\n<list>"`; and `"<why not>——<what to do instead>。<next action>"`.
- Optional hooks: `needsConfirm(args)` (returns a Chinese summary), `halt: true` (ends the turn — **only when the call succeeded**), `metadata` (only when there's machine-readable info).
- **`AgentDef.tools` is not an enforcement boundary.** It only decides which schemas the model sees; execution looks up the global registry. **Removing a tool means deleting its definition** — taking it out of the whitelist does nothing.
- **Adding a tool touches 7 places**: define it → add to its domain array → (new domain only) `tool/index.ts` → create `prompts/tools/<id>.txt` → add to an agent whitelist in `agent/registry.ts` → it must appear in `docs/agents.md` (enforced by `tests/docs.test.ts`) → if a probe patches that prompt, sync the `before` string in `src/probe/advance.ts`.

## Tests

- **All tests are offline** — no network, no LLM. A test that needs either is a bug.
- **Assert on a list of failures**, not one `expect` per loop iteration: collect `missing.push(...)` then `expect(missing).toEqual([])`. The failure message is then the whole list.

## Non-obvious decisions

- **Agents are data.** Adding a role = one `AgentDef` + a whitelist. Don't touch the loop or registry code.
- **Never hand-copy a list that can be derived.** This repo has been burned twice — a character index file that went stale, and a field list duplicated into `design_spec.ts` that was missed during a refactor. Either compute it or make a test guard it.
- **A new document kind is one registry row.** Want a structural spec for it? Add a row to `design_spec.SPECS`. Want it to look different in `list`? Add a row to `summaries.SUMMARIES`. Nothing else cascades — no new type, no whitelist, no tool. (This used to be expensive: a fifth `LayerId` touched five places.) Details: `docs/roadmap.md`.
- **Design documents are written in two phases** (`propose-design` → user replies → `apply-design`). Nothing else may write to `design/` directly — the point is that the bytes the user saw are the bytes that land.
- **Data-fetching knows no domain.** The read side takes *locations* and returns *content*; any judgment about "which part of this document matters" is policy, and policy is a registry selected by path — `INVARIANTS` (does the result still hold together), `SUMMARIES` (what this document looks like in `list`), `SPECS` (what shape this kind has). All three share one path-glob vocabulary. A per-kind `if` inside a reader is the bug they replaced.
- **A rename must be forced by a fact, never by symmetry.** The three read tools lost `-design` because their scope widened past `design/`; `design-spec` kept it because its scope did not (chapters have no structural spec, so the name never lies). "The family should be consistent" is not a reason.
- **An addressing convention only holds when every tool agrees.** The flip to project-relative paths landed on every tool at once, read and write together — flipping the write side first would have made `design-spec` advertise an address the read tools resolve wrongly (`design/design/core.md`). Never change a convention in halves.

## Navigation

| Question | Read |
|---|---|
| What is this product, and what is it deliberately *not*? | `docs/product.md` |
| How is the code organised; what happens in one turn? | `docs/architecture.md` |
| Agents, tools, skills — how to classify and add them | `docs/agents.md` |
| The four design doc families; two-phase writes; chapter production | `docs/design-docs.md` |
| Who plans a chapter, who approves it, who writes it — and what that retires | `docs/chapter-planning.md` |
| Character cards | `docs/characters.md` |
| Volumes and sequences; why there is no whole-book outline | `docs/outline.md` |
| Who may do what, and what needs asking | `docs/permissions.md` |
| What isn't built yet | `docs/roadmap.md` |
| How prompts are organised and written | `prompts/README.md` |

Every file in `docs/` opens with a Status block (职责 / 读者 / 对齐代码). If you change a fact one of them describes, bump that file's 对齐代码 date. `tests/docs.test.ts` enforces this, plus that no doc mentions a deleted tool.
