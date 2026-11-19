## Agent boundaries

- The user's current instructions take precedence over this file, skills and earlier context. Read only the source, config, tests and docs relevant to the task; small changes don't require walking the whole repo.
- Define an observable done condition first. Authorized, reversible implementation, checks and fixes are carried through to completion, not handed back after the first patch; pause only for unknowns that change scope or outcome, or for irreversible or external writes.
- Before adding complexity for a speculative or vanishingly unlikely race or security edge case, explain the concrete failure mode, likelihood, and complexity cost to the user and get their buy-in. Do not silently expand scope for theoretical robustness.
- Pick verification by risk: run the affected Bun tests for targeted regressions; widen to the full `bun test`, typecheck or build for cross-module, runtime or protocol changes. Don't run unrelated full suites for low-risk changes.
- When diagnosing tool findings, read the relevant [agent lessons](agent-lessons.md) on demand; don't preload unrelated incident history.
- `.skills/<name>/SKILL.md` is an on-demand workflow entry point. Keep a skill's trigger description short and precise; put multi-flow content behind references or scripts (progressive disclosure), don't preload unrelated text, and don't write one task's temporary steps into shared rules.
- **Prompt the What, not the How.** When exploration is needed, the agent builds its own iterative tools, such as several variants and checks that can be compared. It does not go back and forth with a human on trial and error.

## Work loop

GitHub issues and PRs are the source of truth. A piece of work starts with a Goal (the user-visible change) and Acceptance (how we will know it is done). Labels such as `to:vela` and implementation notes are process suggestions, not the goal.

- `status:draft` means Goal or Acceptance is still missing or contested. Do not start implementation, and do not treat a verbal clarification in chat as enough until it is written on the issue.
- `status:ready` means Goal and Acceptance are clear enough to start. It is not permission to invent the design only in the PR.
- Before opening a PR, the implementer comments on the same issue, restating Goal and Acceptance in their own words. If that restatement does not match, ask on the issue; do not open the PR yet.
- Merging a PR is not done. Done requires the agreed verification (tests, verify-vela, or the acceptance checks), posted on the original issue or PR, with evidence someone else can rerun. If acceptance is unmet, the work is not delivered.
- After a UX miss, eval failure, or a repeated incident, open two issues when both apply: one to fix the product, and one to change the process (AGENTS.md, templates, or REVIEW.md). Agents may propose process changes; Claude reviews them; Liam decides whether they land.

Roles stay as they are: Liam sets direction and merges high-risk work; Claude gates large enhancements and UX; Vela is the default implementer for `to:vela` + `status:ready`; Friday handles work Vela should not take and reviews Vela PRs; Forge handles small bugs and reviews Friday PRs; Taste files UX and bug issues after merges.

### Decisions that need Liam

Ask Liam, and do not proceed, for: merging to `main`, public API or eval-baseline changes he has not already authorized, and operations that can lose user or production data.

Friday or Claude may block a change without asking Liam first when the risk is already covered by repo rules, such as a missing Evidence section, or a worktree force-push that could overwrite work.

### Anti-examples

- Merging because CI is green and a reviewer is ready, without Liam's own words, when the change is high-risk or the author was told not to self-merge.
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
- Package unit tests live in `packages/*/test/unit/`, mirroring their own `src/`; workspace architecture tests live in `test/unit/`; end-to-end flows live in `test/e2e/` and use `createTestVela()` from `test/support/vela.ts` and the scripted faux model from `packages/core/src/testing/faux.ts`.
- Fix a bug by first writing a faux scenario that reproduces it; when you change events, the faux interface or test conventions, update test/README.md.

## Review

When reviewing a pull request, follow [REVIEW.md](REVIEW.md). When opening one, fill in [the PR template](.github/pull_request_template.md).

## Product verification (verify-vela)

After implementing or changing user-facing CLI/TUI/SDK behavior, **follow** [`.skills/verify-vela/SKILL.md`](.skills/verify-vela/SKILL.md) before claiming done: use the change as a user would, through the real CLI or an SDK script, with the mock or a faux scenario model. Tests don't replace this. What to drive per feature: [`journeys.md`](.skills/verify-vela/journeys.md); SDK onboarding and core checks: [`core.md`](.skills/verify-vela/core.md).

"tests passed" and "looks good" are not evidence. Claiming done requires command results someone else can rerun. User-visible CLI/TUI/SDK changes still go through the verify-vela skill above.

Before opening a pull request, the implementer verifies the change and does one fresh-context self-review in a new thread that sees only the diff. Vela is the default implementer. Friday follows the same rules.
