# Running Vela on a Harbor benchmark

`vela_agent.py` is a [Harbor](https://github.com/harbor-framework/harbor) agent adapter that makes
`harbor run` use the Vela CLI as the agent under test. Harbor has no built-in Vela agent, so the
adapter is loaded through Harbor's custom import path (`--agent module.path:ClassName`).

Each trial installs `@glows777/vela` from npm on Node, then runs one headless session:

```sh
vela --print --mode json --model <provider>/<id> "<task instruction>"
```

Status, cost estimates and the accepted plan live in
[#426](https://github.com/glows777/Vela/issues/426). Benchmark rows that put a harness next to a
model — the only kind this adapter can compete in — come from Terminal-Bench, FrontierHarness and
Harness-Bench; see the issue for why SWE-bench Verified and SWE-bench Pro are not among them.

## Requirements

- Harbor installed with a Python that can import its own packages, e.g.
  `uv tool install "harbor[runta]" --python 3.12`.
- `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the Harbor process environment
  (or `agents[].env` in a job config). Harbor resolves the key for `--model <provider>/<id>` and
  passes it into the environment; Vela's built-in providers read the same variables.
- A Harbor environment that can reach the npm registry and the model endpoint (`docker`, `runta`,
  `modal`, ...).

## Usage

From the repository root:

```sh
export PYTHONPATH="$PWD/scripts/eval/harbor:$PYTHONPATH"
export DEEPSEEK_API_KEY=...        # the provider of the model below
export RUNTA_CONFIG=~/.config/runta/config.toml   # runta only

harbor run \
  -d frontier-harness-eval/frontier-harness-eval@v1.1.0 \
  -a vela_agent:Vela \
  -m deepseek/deepseek-v4-pro \
  -e runta -l 1 --override-storage-mb 32768
```

Datasets this was checked against (`harbor dataset list`, 2026-11-17):

| Dataset | Tasks | Note |
|---|---|---|
| `terminal-bench/terminal-bench` | 66 | Terminal-Bench 4.x; the public board runs 5 attempts per task |
| `terminal-bench/terminal-bench-2-1` | 89 | The 2.1 revision of the 2.0 task set |
| `frontier-harness-eval/frontier-harness-eval@v1.1.0` | 62 | 4 scored attempts per task on the public board |

`-i` filters by full task name including the org prefix (`-i terminal-bench/fix-git`), not by bare
name; a bare name matches nothing.

Add `--dry-run` first to check credentials and flags without running anything, and `-k 3 -l N` to
measure variance over several tasks and attempts. Keep an `-a oracle` run of the same dataset as the
upper bound: oracle always scores 1.0 when the task and verifier are healthy, so an oracle pass with
a Vela miss measures Vela, while an oracle miss means the task or environment is broken.

## Options

Pass through `--ak name=value`:

| Option | Effect |
|---|---|
| `thinking=<level>` | `--thinking off … max`. In a fresh container Vela defaults to `high`. |
| `version=<x.y.z>` | Pin the npm package instead of `@latest`. |
| `skip_install=true` | Use a `vela` already in the image (the image must provide Node ≥ 22.18). |

## What lands in the job folder

- `agent/vela.txt` — Vela's JSON event stream (stdout and stderr merged).
- `agent/vela/` — `VELA_DIR`: the session transcript, usage records and memory.
- `verifier/` — reward, verifier stdout and CTRF report, as for any Harbor agent.

## Limits

- No ATIF trajectory conversion and no resume/load support: each trial is one fresh session.
- The adapter installs Node and Vela inside the environment on every trial (a few minutes). Bake
  them into the image and use `skip_install=true` for large sweeps.
- `agent/vela.txt` mixes stderr into the JSON stream, so it is for inspection, not strict parsing.
- The adapter does not implement `populate_context_post_run`, so Harbor's `result.json` records no
  token or cost totals for a Vela trial. Read `agent/vela/projects/*/usage/requests.jsonl` inside
  the trial folder instead; it has per-request tokens, cache reads and cost.
