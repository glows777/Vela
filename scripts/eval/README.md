# Real-model evaluations

This opt-in Bun runner measures real Vela sessions against DeepSeek. It is outside
`bun run test` and CI. It makes paid requests. Run it only with an approved budget.
The issue and approved plan are [#203](https://github.com/glows777/Vela/issues/203)
and [Claude's corrections](https://github.com/glows777/Vela/issues/203#issuecomment-6413801436).

G7/G8 now default to the versioned `workspace-v1` isolation profile. It requires
Linux, `bwrap` (Bubblewrap), and permitted user namespaces. The worker checks that
workspace files are readable and a private artifact canary is not readable **before
any model request**. An unavailable boundary is an error, never an unconfined retry.
`--isolation legacy` explicitly selects the earlier execution environment for
historical investigation; it must not be described as isolated.

In `workspace-v1`, disk tools retain their revision-local names, schemas and native
implementations, but execute without network access in a filesystem containing the
workspace, read-only memory `.md` files, system binaries and tool dependencies.
Evaluation source, artifacts, raw sessions and `.dream` inboxes are not mounted.
File read/overwrite state is kept per session across isolated tool processes.
Only the invoking session's native tool-result directory is mounted, so long
outputs remain pageable without exposing task-topic tool output to recall.
Neutral state paths and topic IDs replace benchmark-labelled model-facing paths;
the real session/state files are copied to the artifact directory after cleanup.
Both phases retain disk-tool results and an `isolation` audit, and `requests.jsonl`
retains the actual prompts/tools/reasoning setting without headers or credentials.

This is a changed evaluation environment, **not a memory product fix**. Version-2
batches record `memoryProfile` and `graderVersion`; do not pool their pass rates
with older unconfined runs. Store/recall checks and the two-of-three exit bar remain
the same. The grader now treats absolute and relative paths within the legitimate
workspace consistently; raw session/evaluation paths inside it are still rejected.
Historical artifacts are never rewritten.

For isolated paid G7/G8, the budget is also enforced before each provider request:
reserve the selected model's full 1M input at uncached peak prices plus an enforced
8192-token output limit ([provider parameter contract](https://api-docs.deepseek.com/api/create-response/)). Known usage releases unused reserve; missing usage keeps
the full reserve. Concurrent requests wait up to 30 seconds for an existing
reservation to settle before admitting another; unknown usage is never released
to make room. The reservation is checkpointed before calling the provider.
`costUpperBound` is separate from the normal usage estimate. A refused reservation
stops the batch without a fresh paid retry. This bound assumes the provider honors
the documented model context/output limits and the recorded peak prices. Other
scenarios and explicit legacy runs retain their older admission-cap behavior.
The output limit is part of this profile and is recorded in request evidence.

Offline kernel-boundary regressions (no provider calls):

```sh
VELA_EVAL_SANDBOX_TESTS=1 bun --no-env-file test --timeout 30000 scripts/eval/isolation.test.ts scripts/eval/budget.test.ts
```

The kernel tests are opt-in for developer environments that do not permit user
namespaces. CI installs Bubblewrap and enables them. A real isolated evaluation
always runs its preflight.

```sh
bun install --frozen-lockfile
bun test scripts/eval/graders.test.ts
bun scripts/eval/run.ts --help
bun scripts/eval/run.ts
bun scripts/eval/run.ts --only C1,C2,C3,C4,C5,C6 --thinking high
```

Provide `OPENAI_KEY` in the invoking process environment. The model is
`deepseek-flash` using Responses at `https://api.deepseek.com`, thinking `max`.
The named `eval` provider sets explicit DeepSeek compatibility flags (stateless history, system role, plaintext reasoning stream); older baseline loaders ignore unknown flags and keep their existing hostname behavior. There is no key/protocol fallback or credential discovery. Workers receive the key
through stdin and keep it outside their environment and tool subprocesses.
Each worker gets a private `bun` executable link and a keyless `BASH_ENV` that
restores PATH after login-shell startup.

Options:

| Option | Default | Meaning |
|---|---|---|
| `--only C1,G2` | original fourteen | Comma-separated scenario IDs; M1 is explicit-only |
| `--runs 3` | 3 | Repetitions per arm |
| `--thinking max` | max | Vela thinking level; `high` is used for the additional CLI round |
| `--max-cost-usd 3` | 3 | Invocation allowance; isolated G7/G8 also enforce per-request peak reservations |
| `--repo /path/to/Vela` | runner's repo | Checkout used for the new arm (both M1 arms) |
| `--dream on` | off | Run manual dream in the new M1/G8 arm before recall |
| `--isolation workspace-v1` | workspace-v1 | G7/G8 filesystem boundary; `legacy` explicitly selects the historical environment |

`VELA_EVAL_TODO=1` in the invoking environment loads the `todo` extension in the
new arm when that revision provides it. Revisions without the extension (the old
arm and older checkouts) are unchanged. Use it to compare a revision that adds
the extension against a clean checkout without turning it on by default.

Install the selected checkout's dependencies first. Git, Bun, ripgrep and fd must
be on PATH. The runner installs each selected baseline's frozen dependencies in
an owned temporary worktree. C1–C6 and G1–G5 retain `OLD_COMMIT`;
G6/G7/G8 use the exact peeled `v0.4.0` commit
`5b976e26706686a2213f514895d05110f50af2a5`. `results.json` records the per-scenario
`baselineCommits` map as well as the legacy `oldCommit`. Both arms get fresh task worktrees at
`7fac1dfd6b06e003a990d17867c10090b6f8efc2`; production modules and helpers come
from each arm's revision. Baseline G2 is skipped because its `task` API cannot
represent the current `title`/`brief` checks. A default round has 81 executable
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

G1–G5 fake only Lark transport. Cards/reactions are not answers; empty G2 group
acknowledgement is allowed. G5 seeds a completed report through topic history.

G6/G7/G8 also use the revision-local fake transport (`fakeLark()` today) with the real extension, gateway, tools and separate
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
that snapshot; `recall` requires topic 2's last delivered answer to contain the
fact and an observed source in that topic: a memory read/search/list/lint result,
an injected memory index, `read_file`/`grep` of its legitimate memory files, or
matching `lark_search_history` (historically `feishu_search_history`) message text. A tool name, save acknowledgement,
empty search, Bash output alone or guessed answer is not a source. Recall-topic
disk-tool references to raw sessions, the eval artifact tree or another attempt
fail recall, even if a valid memory/history result was also retrieved. The grader resolves ordinary
relative and absolute paths against the actual group workspace, including Bash
parent traversal; it does not sandbox tools or interpret arbitrary shell code.
The workspace/data layout is unchanged, and these are behavioral failures, not
runtime errors. A memory written during recall cannot earn store credit. The two
checks are reported separately, including their own repetition totals.

Attempt evidence retains task-topic `memory` tool results as well as recall-topic
results. Execution success alone does not prove persistence: a save can return
`Save failed: ...` without throwing. Use the returned text to diagnose that call
and the pre-recall snapshot to determine whether the fact was actually stored.

G8 uses the same snapshot, store/recall predicates and isolated same-group topics
(`g8_store`, `g8_recall`). Topic 1 asks for a two-line on-call note about a deploy
delayed to 22:00 and mentions the staging server's rename to kestrel in passing.
It never asks to remember or save the fact. After that run ends and
`memory-after-topic-1.json` is written, topic 2 asks for the current staging server
name. G7's explicit remember request is unchanged. Claude owns the paid G8
`v0.4.0` baseline and posts it on [#218](https://github.com/glows777/Vela/issues/218).

The G6 exit bar and each G7/G8 component require two passes in three valid runs per
arm. Notes say `incomplete` when three valid runs are unavailable (including
one-run pilots or errors); errors are never behavioral failures. The main G7
and G8 pass/valid columns still count attempts satisfying both predicates; the
separate store/recall notes are the exit assessments. Claude owns the real DeepSeek
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

The runtime layout adapter selects the target revision's Lark or historical Feishu factory/helpers. Grading normalizes only structured tool and session identifiers, leaving raw paths, arguments, output and saved evidence untouched. G7/G8 contamination recognizes both physical session-name schemes; their source and timing predicates are unchanged.

The `channel_*` topic-tool rename (#281) is breaking at runtime: no `lark_*`
topic aliases remain. The grader accepts historical `feishu_*` / `lark_*` topic
identifiers and current `channel_*` identifiers without changing predicates.
`lark_search_history` remains Lark-specific. This normalization affects grading
only, never recorded evidence, prompts, fixtures or baseline commits. Compare
pre/post-rename dispatch/topic runs with identical scenarios, models and settings;
offline injected-model runs establish routing/tool execution, not live-model
choice or prompt-quality equivalence.

### #281 reproducible offline rename comparison

Use the checked-in verification script against both checkouts (Bun, Git, ripgrep
and fd on PATH; install each checkout's frozen dependencies first):

```sh
CANDIDATE=$PWD
SCRATCH=$(mktemp -d)
BASELINE=$SCRATCH/before-runtime
OUT=$SCRATCH/evidence
mkdir -p "$OUT" "$SCRATCH/home"
git worktree add --detach "$BASELINE" 538fd2b1bd153299ca1d639a7559bd46d4383213
(cd "$BASELINE" && bun install --frozen-lockfile)
bun install --frozen-lockfile
SCRIPT=$CANDIDATE/.skills/verify-vela/scripts/dispatch-rename-eval.ts
env -i PATH="$PATH" HOME="$SCRATCH/home" VELA_DIR="$SCRATCH/home/.vela" VELA_OFFLINE=1 \
  bun --no-env-file "$SCRIPT" --runtime "$BASELINE" --output "$OUT/before" --prefix lark
env -i PATH="$PATH" HOME="$SCRATCH/home" VELA_DIR="$SCRATCH/home/.vela" VELA_OFFLINE=1 \
  bun --no-env-file "$SCRIPT" --runtime "$CANDIDATE" --output "$OUT/after" --prefix channel
# Preserve $OUT, then remove the baseline worktree when finished.
git worktree remove "$BASELINE"
```

The output directory must not already exist. Each run saves `results.json`,
model-visible `G*/requests.json`, and real worker artifacts/session transcripts.
Both use unchanged G1–G5 prompts/fixtures, the same scripted faux responses except
renamed tool identifiers, thinking `off`, one repetition, and fake Lark transport
through the real extension/gateway/tools. No new grader or threshold is introduced.
Worker token/cost estimates are synthetic here, not provider usage or billing.

Recorded offline comparison: **G1–G5 passed all 12 checks in both arms**. Model
request counts were **1/3/2/2/1** in each arm; tool-call counts were **0/1/1/1/0**.
Checks, deliveries and topic titles matched. Model-visible tool sets matched after
the exact topic rename, with no old topic aliases and `lark_search_history`
preserved. Baseline offline eval suite: **188 passed, 0 failed**; candidate suite
and candidate graders against the baseline runtime: **200 passed, 0 failed**
(the additional 12 tests cover identifier parity and routine-substitution rejection).

**LIVE BLOCKED:** the required invoking-process `OPENAI_KEY` was unavailable.
No provider requests were made. These results establish scripted dispatch/tool
execution only, not live-model tool selection, prompt-quality equivalence or a
live-model pass rate. The paid before/after comparison remains unverified.


### #306 offline memory consolidation comparison

Run only after approval for the model and total budget (the command makes paid
`deepseek/deepseek-flash` calls through the existing eval provider):

```sh
bun --no-env-file scripts/eval/run.ts --only M1,G8 --dream on --runs 3 --max-cost-usd <approved-remaining-budget>
```

`M1` uses the candidate runtime for **both** arms. It seeds a note saying deploys
happen on Friday, then a separate correction session says Monday while asking for
an announcement. Both task sessions expose only memory tools, with an eval-only hook blocking
write actions, so they cannot silently repair the fixture. Memory remains enabled
for inbox collection. The new arm calls SDK `session.prompt('/dream')`; the old control does
not. A fresh memory-only session asks the deployment day, with neither weekday
in its question. The two checks require a persisted Monday correction and a
Monday recall answer, excluding Friday in each. Snapshot evidence is saved as
`memory-after-correction.json`. A useful comparison passes with dream and fails
without it; report actual results rather than assuming that outcome.

`G8` keeps its existing prompts, fresh group topics, grader and historical
`v0.4.0` runtime in the old arm. With `--dream on`, only the new arm runs `/dream`
through the first topic's SDK session before the persisted-memory snapshot and
second topic. Automatic dream is disabled in eval attempts to make timing explicit.
[#306](https://github.com/glows777/Vela/issues/306) requests comparison against a
historical **1/6** reference attributed to #218. The visible [#218 measurement](https://github.com/glows777/Vela/issues/218#issuecomment-6439949087)
reports **store 0/6** and contaminated recall instead. Resolve the batch and metric
behind 1/6 before presenting it as a verified baseline. Historical aggregates are
references, never fabricated attempts in this batch. Save and report new
store/recall counts, errors and per-run costs.
G8 without this flag retains its prior behavior.

The existing provider-boundary usage wrapper includes isolated dream calls in
its `summary` (non-streaming) bucket and total token/cost estimates. The product's
usage ledger separately identifies them as dream usage. All attempts retain
`usage.json`, `result.json` and session files, with combined costs in `results.json`.
This harness does not establish real Lark transport behavior. The v0.6 unified
acceptance still requires an automatic dream in a real Lark group and `/memory`
in that group showing the completed run and inbox status.

Offline checks: `bun test scripts/eval/dream.test.ts scripts/eval/graders.test.ts`.
Faux results prove fixture plumbing and grading, not real-model quality or billing.
