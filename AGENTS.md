## Agent boundaries

- The user's current instructions take precedence over this file, skills and earlier context. Read only the source, config, tests and docs relevant to the task; small changes don't require walking the whole repo.
- Define an observable done condition first. Authorized, reversible implementation, checks and fixes are carried through to completion, not handed back after the first patch; pause only for unknowns that change scope or outcome, or for irreversible or external writes.
- Before adding complexity for a speculative or vanishingly unlikely race or security edge case, explain the concrete failure mode, likelihood, and complexity cost to the user and get their buy-in. Do not silently expand scope for theoretical robustness.
- Pick verification by risk: run the affected Bun tests for targeted regressions; widen to the full `bun test`, typecheck or build for cross-module, runtime or protocol changes. Don't run unrelated full suites for low-risk changes.
- When diagnosing tool findings, read the relevant [agent lessons](agent-lessons.md) on demand; don't preload unrelated incident history.
- `.skills/<name>/SKILL.md` is an on-demand workflow entry point. Keep a skill's trigger description short and precise; put multi-flow content behind references or scripts (progressive disclosure), don't preload unrelated text, and don't write one task's temporary steps into shared rules.
- **Prompt the What, not the How.** When exploration is needed, the agent builds its own iterative tools, such as several variants and checks that can be compared. It does not go back and forth with a human on trial and error.

## Work loop

GitHub issues and PRs are the source of truth. A piece of work starts with a **Goal** (the user-visible change), **Non-goals** (scope boundary), and **Acceptance** (how we will know it is done). Labels such as `to:vela` and implementation notes are process suggestions, not the goal.

- `status:draft` means Goal or Acceptance is still missing or contested. Do not start implementation, and do not treat a verbal clarification in chat as enough until it is written on the issue.
- `status:ready` means Goal and Acceptance are clear enough to start. For enhancements and larger UX changes, only **Leader** applies `to:*` + `status:ready` after reviewing scope; implementers do not self-ready unreviewed features. `status:ready` is not permission to invent the design only in the PR.
- **Source issue & restatement (tiered by change size)**:
  - Features, UX changes, and non-trivial bugs must have a source issue.
  - For small features and ordinary bugs, comment on the source issue restating Goal and Acceptance in your own words before opening the PR (if it does not match, ask first).
  - For larger work with an approved plan on the source issue, that plan approval already establishes alignment—do not repeat a boilerplate restatement before opening each PR.
  - Pure doc fixes, typos, and urgent red-`main` CI fixes may open a PR directly without creating a source issue first.
- **Merging a PR is not done.** Done requires the agreed verification (tests, `verify-vela`, or the acceptance checks) posted on the original issue or PR with evidence someone else can rerun. For multi-PR slices (`Part of #N`), the final slice PR must verify every Acceptance item on `#N` and close it (`Closes #N`).
- After a UX miss, eval failure, or repeated incident, open two issues when both apply: one to fix the product, and one to change the process (`AGENTS.md`, templates, or `REVIEW.md`). Agents may propose process changes; Leader reviews them; Liam decides whether they land.

### Roles

- **Liam**: sets product direction, resolves deadlocks, and approves merges that touch the high-risk gate below.
- **Leader** (team leader, model-agnostic): gates enhancements and larger UX changes, reviews Friday's plans and PRs (assisted by Codex and Cursor Bugbot), and watches overall repo health.
- **Vela**: default implementer for `to:vela` + `status:ready` (including small bugs); does not review or merge.
- **Friday**: takes cross-module, public-API, security/permissions, and real-environment work; reviews Vela's plans, acceptance, and PRs, plus `To WCG` and external PRs.
- **Forge**: optional helper (files issues and may review when quota allows); does not handle bugs and is not a merge blocker.
- **Taste**: exercises merged user-facing changes and files UX/bug issues.
- **Prism**: tracks comparable products and files high-value feature gap issues.

### Merge gate & decisions that need Liam

Ask Liam, and do not merge without his explicit confirmation, when a PR:
- changes the public API (`api/public-api.txt`) or eval baselines without prior authorization,
- carries data-loss or security risk,
- modifies `.github/` workflows/templates,
- lands an enhancement whose scope/plan was not previously approved, or
- was authored by Leader.

For routine bug fixes, pure docs/tests, and slice PRs inside an already-approved plan—when the reviewer (Friday for Vela/external PRs, Leader for Friday PRs) has reviewed the current head with no remaining blockers, CI is green, and rerun-able Evidence is posted—the reviewer or Leader may squash-merge directly (using `--match-head-commit` with the full SHA) and leave a brief merge note.

Friday or Leader may block a change without asking Liam first when the risk is already covered by repo rules, such as a missing Evidence section, or a worktree force-push that could overwrite work.

### Prompt cache discipline

Any change touching what the model sees (system prompt, tool definitions, injected context) must account for prompt-cache stability. Keep cross-turn rules in the stable prefix; carry per-input, per-wake, or mutable runtime facts with the message instead of mutating the system prompt. State in the plan/PR what stays in the cached prefix and what rides on messages.

### Anti-examples

- Merging a PR that hits Liam's high-risk gate without his explicit words, or self-merging your own PR.
- Treating "open an issue", "wait for review", or "add a label" as the goal, instead of the user-visible acceptance.
- Force-pushing a worktree or shared branch in a way that can discard someone else's commits, instead of stopping and reporting the risk.

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

`packages/*/src/` contains the six npm packages (each compiled to its own `dist/`) and must run on Node ≥ 22.18 and Bun: use only `node:` modules and web-standard APIs, never `Bun.*` globals or `bun:` modules (RAG's SQLite goes through `packages/rag/src/sqlite.ts`, which adapts both). Relative imports carry the `.ts` extension. `bun run build` emits `dist/`; `bun run smoke:consumer` checks each package independently in empty Node and Bun projects. The Bun API advice below applies only to `scripts/` and `test/`.

All code, comments, messages and docs in the repo are in English.

- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

How tests are organized, how to verify a change and how to add tests: see [test/README.md](test/README.md) (read it before changing tests or the agent loop, assembly, events, context or CLI). In short:

- `bun run test` runs unit + e2e (a few minutes, no network, no environment variables); target with `bun test test/unit/<module>` or `bun test test/e2e/<scenario>`.
- Package unit tests live in `packages/*/test/unit/`, mirroring their own `src/`; workspace architecture tests live in `test/unit/`; end-to-end flows live in `test/e2e/` and use `createTestVela()` from `test/support/vela.ts` and the scripted faux model from `packages/vela/src/testing/core/faux.ts`.
- Fix a bug by first writing a faux scenario that reproduces it; when you change events, the faux interface or test conventions, update test/README.md.

## Review

When reviewing a pull request, follow [REVIEW.md](REVIEW.md). When opening one, fill in [the PR template](.github/pull_request_template.md).

## Product verification (verify-vela)

After implementing or changing user-facing CLI/TUI/SDK behavior, **follow** [`.skills/verify-vela/SKILL.md`](.skills/verify-vela/SKILL.md) before claiming done: use the change as a user would, through the real CLI or an SDK script, with the mock or a faux scenario model. Tests don't replace this. What to drive per feature: [`journeys.md`](.skills/verify-vela/journeys.md); SDK onboarding and core checks: [`core.md`](.skills/verify-vela/core.md).

"tests passed" and "looks good" are not evidence. Claiming done requires command results someone else can rerun. User-visible CLI/TUI/SDK changes still go through the verify-vela skill above.

Before opening a pull request, the implementer reviews their own diff, runs the verification matching the risk, and fills in the PR template (including Evidence and the test-to-acceptance table); a PR missing Evidence is bounced without counting as a review round. Vela is the default implementer. Friday follows the same rules.
