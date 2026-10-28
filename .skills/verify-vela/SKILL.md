---
name: verify-vela
description: Use Vela as a real user would (the TUI in tmux, -p / --mode json / rpc, a small SDK script), offline with the mock or a scripted faux model, and keep screens and side effects as proof. Use after changing CLI/TUI/SDK or core behavior, for feature acceptance, and to learn the SDK.
---

# verify-vela

Tests prove the code; this proves the product. Drive the real CLI and SDK the way a user does, try the edge cases, judge what the user sees, and keep evidence. Only the model is fake, so model wording is never verified: tools, sessions, extensions and the TUI are.

Everything runs under `env -i` with its own `VELA_DIR`, `HOME` and working directory (`/tmp/vela-verify/<run>/work`, seeded with `a.txt` and `sample-data.txt`). No API key or `~/.vela` reaches Vela, and nothing touches other runs.

Needs `bun install`, `tmux` for the TUI only, and `rg` / `fd` on PATH for the grep / find tools and `@` completion (`VELA_OFFLINE=1` blocks their download).

## Helper

```bash
REPO=$PWD; H=$REPO/.skills/verify-vela/scripts/vela-verify.sh; RUN=verify-$(date +%s)   # from the repo root
```

| Command | Does |
|---|---|
| `$H launch $RUN [vela args]` | Start the TUI in a private tmux server; returns at the footer, the project trust question or a picker |
| `$H send $RUN "<text>"` | Type a line and press Enter (prompts and `/commands`) |
| `$H keys $RUN Escape` | Raw tmux keys: `Escape`, `C-c`, `C-d`, `M-Enter`, `BTab`, `Up`, `Enter` |
| `$H wait $RUN '<regex>' [s]` | Until the regex matches more lines than before the last `send` / `keys` and nothing is running |
| `$H snap $RUN <name>` / `grab $RUN <file>` | Save the screen with scrollback / copy a file from `work/` into the evidence dir |
| `$H run $RUN [--stdin] <name> [vela args]` | One non-interactive Vela run; saves `<name>.{cmd,stdout,stderr,exit}` |
| `$H exec $RUN [--stdin] <name> <cmd…>` | The same for any command (SDK scripts, `examples/rpc-client.ts`) |
| `$H doctor $RUN` | Versions, and whether the TUI is still up |
| `$H cleanup $RUN` | Stop the run, copy `VELA_DIR` into the evidence, delete the scratch dir |

`run` / `exec` close stdin unless you pass `--stdin` (Vela waits for an open stdin forever). Calls with the same run id share the fixture, so sessions and edits carry over. Evidence lives in `/tmp/vela-evidence/$RUN/` (root: `VELA_EVIDENCE_ROOT`) and survives `cleanup`.

## Choose the model

`VERIFY_MODEL=mock` (default) is the keyword demo model in `packages/core/src/testing/demo-model.ts`:

| Prompt | Model does |
|---|---|
| `list files`, `ls` | `list_directory .` |
| `read a.txt` | `read_file` |
| `test edit` | `edit_file` on `sample-data.txt` (once per fixture) |
| `test bash` / `test grep` / `test find` | `bash` echo / `grep` / `find` |
| `test parallel` | three tools in one step |
| `test loop` | `list_directory` every step while the last user message contains `test loop`. After 10 identical calls the agent inserts a warning and the next step is the canned reply, so press Esc while `Esc to interrupt` is showing |
| `test retry` | two 429 errors, then an answer |
| anything else | a canned greeting, streamed slowly |

Keywords match the last user message. After a memory save, or once a knowledge base has sources, that index is appended after the prompt, so a later keyword in the same run no longer matches. Use a fresh run for keyword prompts after that.

For anything else (extension or MCP tools, memory, web, errors, hangs, exact replies) write a faux scenario and pass `VERIFY_MODEL=faux:/abs/path.json`. Each response is used once, in order:

```json
{ "responses": [
  { "toolCalls": [{ "name": "hello-tool_greet", "input": { "name": "Liam" } }] },
  { "text": "done" },
  { "error": "429 Too Many Requests" }
] }
```

The fields (`text`, `toolCalls`, `error`, `streamError`, `hang`, `usage`, …) are in [test/README.md](../../test/README.md). A scenario that shows a bug belongs in `test/fixtures/scenarios/` with a case in `test/e2e/cli.test.ts`.

## Drive

```bash
$H launch $RUN && $H snap $RUN edit-before
$H send $RUN "test edit" && $H wait $RUN 'Successfully replaced'
$H snap $RUN edit-after && $H grab $RUN sample-data.txt      # line 1 now ends with "(updated)"
$H run $RUN json --mode json "list files"                    # one JSON event per line
$H cleanup $RUN
```

- `wait` regexes should match only the result, not the typed text or a `/command` name.
- A project with `.vela/` or `.skills/` stops at the trust question: `send y`, or launch with `--approve`.
- For the SDK, write a short script in `work/` that imports `$REPO/packages/vela/src/index.ts` and `$REPO/packages/vela/src/testing/index.ts`, and run it with `$H exec $RUN sdk bun consumer.ts`.
- For the Feishu channel, start from [scripts/feishu-journeys.ts](scripts/feishu-journeys.ts): the real extension and gateway with a fake transport and a router faux model (see [journeys.md](journeys.md#sdk)).

What to drive for each feature: [journeys.md](journeys.md). Using the SDK and checking core behavior (agent loop, sessions, context, extensions API): [core.md](core.md).

## Report

- What you drove (commands), what you saw (evidence paths), and the side effects you checked: edited files, session JSONL under `evidence/vela-dir/`, exit codes.
- Problems found, including rough edges in what the user sees, not only failures.
- What you could not reach offline and why. Never count it as verified through another path.
- Run `cleanup` after every run, failed ones too. Never `pkill bun`: other agents share the box.
