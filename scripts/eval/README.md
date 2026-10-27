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
| `--only C1,G2` | all thirteen | Comma-separated scenario IDs |
| `--runs 3` | 3 | Repetitions per arm |
| `--thinking max` | max | Vela thinking level; `high` is used for the additional CLI round |
| `--max-cost-usd 3` | 3 | Estimated admission cap for this invocation |
| `--repo /path/to/Vela` | runner's repo | Checkout used for the new arm |

Install the selected checkout's dependencies first. Git, Bun, ripgrep and fd must
be on PATH. The runner installs each selected baseline's frozen dependencies in
an owned temporary worktree. C1–C6 and G1–G5 retain `OLD_COMMIT`;
G6/G7 use the exact peeled `v0.4.0` commit
`5b976e26706686a2213f514895d05110f50af2a5`. `results.json` records the per-scenario
`baselineCommits` map as well as the legacy `oldCommit`. Both arms get fresh task worktrees at
`7fac1dfd6b06e003a990d17867c10090b6f8efc2`; production modules and helpers come
from each arm's revision. Baseline G2 is skipped because its `task` API cannot
represent the current `title`/`brief` checks. A default round has 75 executable
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
C2/C6 observe successful Bash results containing Bun's runner header, target test
file and nonzero executed-test summary, including the baseline's stored preview.
This accepts `cd task && bun test limits.test.ts` without parsing shell commands;
the grader's independent verification run does not count as the model running tests.
C6 observes actual test inputs through a local Bun preload, allowing equivalent
test syntax while requiring empty, specified mixed and frozen inputs.
C5 fixture `user-ballast-v3` puts inert reference ballast in the first three staged
user-message bodies, with unpadded notes and the same shared 40,000-token provider
window. Its version and padding sizes are recorded in `results.json`. Pagination
cannot omit this context. Both arms are calibrated offline with one-line note
reads; successful automatic compaction must occur before the status turn (phase
0–2). It then recalls progress and finishes without recreating completed files.
No manual compaction is used. Preserve the original live batches when changing a
fixture or grader; any targeted rerun is a separate batch with its own metadata.
V3 keeps the total 67,584 ballast bytes and the first two turns' combined 20,480
bytes, but distributes them as 19,456 / 1,024 / 47,104. The first checkpoint can
discard 9,216 more bytes with the completed first step. Calibration must replay
recorded provider usage and the entire continuation, including final verification
calls, through both revisions' real context managers and local request guards;
observing compaction alone does not establish that the fixture can finish.

V3 investigation (saved-cloud artifacts, not part of a fresh checkout):

```sh
# Offline; uses saved responses/usage and both revisions' native estimators.
C5_REPLAY_PADDING=10240,10240,47104,0,0,0 bun --no-env-file .vela-eval/c5-v3-calibration/replay.ts C5 recorded
# Above reproduces the old allocation's failure; below completes both arms.
bun --no-env-file .vela-eval/c5-v3-calibration/replay.ts C5 recorded
```

The recorded continuation reaches 23,745 tokens with the old allocation (cap
23,616). V3 completes with maxima 21,751 / 20,626 on old/new. Ballast-only usage
adjustments are simulated and bracketed at 0.20–0.26 tokens/character; they are
not real-provider measurements. A separate real v3 pilot and three-slot-per-arm
run finish C5 on both revisions: targeted old 1/1 valid (four structure errors),
new 3/3, with zero input-cap errors. The baseline errors are independently
captured JSON objects in fields that its unchanged schema requires to be arrays;
they remain errors. See the local calibration guide for commands and safe
diagnostic-helper source. This investigation does not change any grade threshold.

G1–G5 fake only Feishu transport. Cards/reactions are not answers; empty G2 group
acknowledgement is allowed. G5 seeds a completed report through topic history.

G6/G7 also use `fakeFeishu()` with the real extension, gateway, tools and separate
topic sessions in one group. G6 starts B (`g6_b`) needing a code, then asks A
(`g6_a`) to read `task/handoff.txt` in the actual group workspace and hand the
fact to B. Neither task prompt contains the code. Only B's last delivered answer
can satisfy the fact check; A/group replies do not count. The transport input
trace must contain just those two initial tasks, in order. No human relay or
synthetic wake-up is injected. Unsupported hand-off behavior can validly fail.

G7 tells topic 1 (`g7_store`) the staging server is called kestrel and asks it to
remember. After its run ends, the worker snapshots actual group memory entries
(not the index, acknowledgement or tool arguments) to
`memory-after-topic-1.json`. A fresh topic (`g7_recall`) then asks for the server
name without importing topic 1's conversation. `store` checks entry content in
that snapshot; `recall` checks only topic 2's last delivered answer. A memory
written during recall cannot earn store credit. The two checks are reported
separately, including their own repetition totals.

The G6 exit bar and each G7 component require two passes in three valid runs per
arm. Notes say `incomplete` when three valid runs are unavailable (including
one-run pilots or errors); errors are never behavioral failures. The main G7
pass/valid columns still count attempts satisfying both predicates; the separate
store/recall notes are the exit assessments. Claude owns the real DeepSeek
baseline runs for [#219](https://github.com/glows777/Vela/issues/219).

Overlap means a whitespace-normalized shared contiguous span of at least 30 Unicode
code points. C4 counts the union of positions covered by these spans against all
earlier answers, once per position, and divides by that answer's trimmed Unicode
codepoint length. Normalized whitespace matches map back to the actual answer's
positions. Per-turn counts/percentages and the scenario maximum are stored in
`results.json`; the column beside character medians shows each arm's worst observed
T2/T3/T4 percentages across valid runs, then its overall maximum. JSON and grading
use unrounded percentages; the table rounds to two decimals. Passing requires
turns 2 and 3 to be at most 15%; turn 4 is reported but not gated, because it asks
for a summary of the earlier turns. **15% is Claude's provisional judgment, not an
empirically calibrated threshold.** Report the actual measurements so it can be
revisited. Turn 4's three-sentence check is unchanged. G2/G5 still use the original
any-shared-span predicate. Sentence boundaries are `。！？.!?` followed by whitespace or end of
text; code spans/blocks and list markers are ignored, and each numbered list item
counts once. Lengths count trimmed visible Unicode code points, excluding reasoning.

To add a scenario, add its ID, prompt/fixture and pure named predicates. Write a
canned pass and isolated failure for every predicate before implementing it.
Do not change production prompts/tools to make evaluations pass.

Simple scenarios have five-minute deadlines; C4–C6 have ten minutes. Sessions are
flushed on cleanup. A worker has an additional fifteen-second shutdown allowance.
Incomplete workers retain usage checkpoints and are reported as errors, not fails.

```sh
bun test scripts/eval
bun run typecheck
bun run lint
```

Offline faux verification covers routing/tools/artifacts and C5 calibration, not
real-model behavior, provider compatibility or billing.
The exit tests exercise the real worker with injected scripted models: readable
group fixtures, isolated persisted topic sessions, memory snapshots, successful
and unsuccessful independent grades, and model errors excluded from grading.
