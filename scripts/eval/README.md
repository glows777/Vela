# Real-model evaluations

This opt-in Bun runner measures real Vela sessions against DeepSeek. It is outside
`bun run test` and CI. It makes paid requests. Run it only with an approved budget.
The issue and approved plan are [#203](https://github.com/glows777/Vela/issues/203)
and [Claude's corrections](https://github.com/glows777/Vela/issues/203#issuecomment-6413801436).

```sh
bun install --frozen-lockfile
bun test scripts/eval/graders.test.ts
bun scripts/eval/run.ts --help
bun scripts/eval/run.ts
bun scripts/eval/run.ts --only C1,C2,C3,C4,C5,C6 --thinking high
```

Provide `OPENAI_KEY` in the invoking process environment. The model is
`deepseek-flash` using Responses at `https://api.deepseek.com`, thinking `max`.
There is no key/protocol fallback or credential discovery. Workers receive the key
through stdin and keep it outside their environment and tool subprocesses.
Each worker gets a private `bun` executable link and a keyless `BASH_ENV` that
restores PATH after login-shell startup.

Options:

| Option | Default | Meaning |
|---|---|---|
| `--only C1,G2` | all eleven | Comma-separated scenario IDs |
| `--runs 3` | 3 | Repetitions per arm |
| `--thinking max` | max | Vela thinking level; `high` is used for the additional CLI round |
| `--max-cost-usd 3` | 3 | Estimated admission cap for this invocation |
| `--repo /path/to/Vela` | runner's repo | Checkout used for the new arm |

Install the selected checkout's dependencies first. Git, Bun, ripgrep and fd must
be on PATH. The runner installs the baseline's frozen dependencies in an owned
temporary worktree. Both arms get fresh task worktrees at
`7fac1dfd6b06e003a990d17867c10090b6f8efc2`; production modules and helpers come
from each arm's revision. Baseline G2 is skipped because its `task` API cannot
represent the current `title`/`brief` checks. A default round has 63 executable
slots and three skips. Worktrees provide context isolation, not a security sandbox.

## Results and cost

The Markdown stdout table is intended for PRs. Detailed results, all attempts,
per-turn answers, tool-call arguments/outcomes, checks, usage and every saved
group/topic session live in `.vela-eval/<time>-<commit>/`. Nothing there is tracked.
Credentials, request headers and raw provider errors are not dumped. Temporary
task worktrees are removed; preserve artifacts when investigating failures.

Statuses are `pass`, `fail`, `error`, `skipped`. API errors and deadlines get one
fresh whole-scenario retry; ordinary grading failures do not. Product request
retries remain enabled. Errors are listed separately and excluded from valid-run
pass denominators and medians. Retried errors remain in the artifacts and cost.
Unknown token usage is flagged as unknown, never charged as a known zero, and
does not stop scheduling. It means the estimated total may omit billed usage.

Estimated cost uses official peak list prices with source/date, including all
attempts, concurrent sessions and compaction. Input is total input; cached is its
cache-hit subset; output includes reasoning. `main`/`summary` count provider
invocations, including failed ones. Usage is collected once at the provider boundary.

The cap is checked before every attempt. An active attempt may overshoot. At the
cap the runner prints partial results and an unstarted-slot count, then exits
nonzero. Unknown usage means the estimate may omit billed usage.
**For a budget shared across multiple commands, subtract the preceding commands'
estimated costs from the approved total and pass only the remaining allowance to
the next command.** Retain both `results.json` files as the combined ledger; do not
treat each command's default $3 as a separate authorization.

Medians include completed passes/failures; deltas are new minus old. "Too easy"
means both arms passed every repetition; "flaky" means mixed passes/failures in one
arm. C6 is recorded only. The C1/C4 combined answer median has a ≤1000-char target,
not a per-run gate. C4's headline length is turn 4, C5's is continuation; all turn
answers are saved. G2 group/topic deliveries are separately scoped.

## Scenarios and checks

`scenarios.ts` holds exact prompts/fixtures. C1/C4 preserve historical Chinese
prompts; C2/C6 use seeded projects and independent probes; C3 uses a local page.
C6 observes actual test inputs through a local Bun preload, allowing equivalent
test syntax while requiring empty, specified mixed and frozen inputs.
C5 uses staged turns, padded notes and a shared reduced provider window recorded
in `results.json`; it observes automatic compaction, recalls progress and finishes
without recreating completed files. No manual compaction is used.

G1–G5 fake only Feishu transport. Cards/reactions are not answers; empty G2 group
acknowledgement is allowed. G5 seeds a completed report through topic history.

Overlap means a whitespace-normalized shared contiguous span of at least 30 Unicode
code points. Sentence boundaries are `。！？.!?` followed by whitespace or end of
text; code spans/blocks and list markers are ignored, and each numbered list item
counts once. Lengths count trimmed visible Unicode code points, excluding reasoning.

To add a scenario, add its ID, prompt/fixture and pure named predicates. Write a
canned pass and isolated failure for every predicate before implementing it.
Do not change production prompts/tools to make evaluations pass.

Simple scenarios have five-minute deadlines; C4–C6 have ten minutes. Sessions are
flushed on cleanup. A worker has an additional fifteen-second shutdown allowance.
Incomplete workers retain usage checkpoints and are reported as errors, not fails.

```sh
bun test scripts/eval/graders.test.ts
bun run typecheck
bun run lint
```

Offline faux verification covers routing/tools/artifacts and C5 calibration, not
real-model behavior, provider compatibility or billing.
