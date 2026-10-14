---
name: verify-vela
description: Drive the real Vela terminal agent (interactive TUI via tmux, `-p`/piped/`--mode json` print modes, and the `createVela()` SDK) offline with VELA_MODEL=mock, and capture transcripts plus file side effects as proof. Use when you must show that a Vela CLI/TUI or SDK behavior actually works end to end, not just that unit tests pass.
---

# verify-vela

Vela is a TypeScript agent. Primary surface: the `vela` TUI (`src/cli/main.ts`, pi-tui). Secondary: print mode (`-p`, piped stdin, `--mode json|rpc`) and the SDK `createVela()` (`src/index.ts`, faux model in `src/testing`). There is no server; every drive is a fresh, short-lived process.

Everything below goes through one helper, run from the repo root:

```bash
H=.cursor/skills/verify-vela/scripts/vela-verify.sh   # bash, executable
RUN=verify-$(date +%s)                                  # one id per verification run
```

Provider boundary: `VELA_MODEL=mock` (keyword-driven offline demo model, `src/testing/demo-model.ts`) replaces the LLM only. Tools, sessions, extensions and the TUI are the real code. Never point a verification run at a real API key.

## Launch

Prerequisites (once per box): `bun --version` ≥ 1.4 (repo default runtime; system Node here may be < 22.18, so the helper runs `bun src/cli/main.ts`, no build needed), `tmux` **for interactive TUI journeys**, and `bun install` in the repo. Optional for grep/find tools and `@` file completion: `rg` and `fd` on PATH (`apt install ripgrep fd-find`; `ln -s $(which fdfind) ~/.local/bin/fd`).

**Without tmux:** interactive paths (`launch` / `send` / `keys` / `wait` / `snap` / TUI `doctor`) are unavailable. Use `print`, `pipe`, and the SDK examples instead — they cover `-p`, piped stdin, `--mode json`, and `createVela()` without a terminal multiplexer. Do not substitute `screen`/`expect` unless you are extending the harness; print-mode + SDK is the supported fallback.

```bash
$H launch $RUN            # extra args go to vela, e.g. $H launch $RUN --no-extensions
```

What it does: creates `/tmp/vela-verify/$RUN/{home,userhome,work}`, seeds `work/sample-data.txt` (`1. Tool registration` / `2. Agent loop` / `3. Sessions`) and `work/a.txt`, then starts `bun src/cli/main.ts` in a private tmux server (`tmux -L vela-verify-$RUN`, session `vela`, 120x40) under an `env -i` allowlist (`PATH`, `TERM`, `LANG`/`LC_*`, `VELA_DIR=…/home`, `VELA_MODEL=mock`, `VELA_OFFLINE=1`, `HOME=…/userhome`), cwd `work/`. Channel creds (`FEISHU_*`) and `VELA_RECORD` are never inherited. Ready = footer shows `mock/mock-model` (printed as `READY run=…`). It fails after 30 s and dumps the pane. Teardown is `$H cleanup $RUN`.

Instances are isolated by run id (own tmux socket, VELA_DIR, HOME and cwd), so parallel runs are safe. Never drive the user's own `~/.vela` or a tmux session you did not start.

## Doctor

```bash
$H doctor $RUN
```

Read-only. Checks: the run's tmux session exists, the pane PID is alive, prints bun / vela version (`0.2.0`) / git sha, the footer says `mock/mock-model`, the footer path is the run's `work/` dir, vela has not exited (`[vela exited] <code>` would show), and the live child environ has no `FEISHU_*` / out-of-tree `VELA_RECORD`. Prints `DOCTOR OK` or `DOCTOR FAIL` (exit 1). Run it first and whenever output looks wrong.

## Drive

TUI (stable handles are text on screen: footer `mock/mock-model`, spinner `Answering… (Esc to interrupt)`, tool blocks like `edit_file sample-data.txt`, `[audit] <tool> → <path>`):

```bash
$H send $RUN "test edit"              # types the line literally, then Enter
$H wait $RUN 'Successfully replaced' 20  # regex on screen AND spinner gone; dumps pane on timeout
$H keys $RUN Escape                   # raw tmux keys: Escape (interrupt), C-c (clear), C-d (exit)
$H send $RUN "/usage"                 # slash commands are typed the same way
```

Mock-model prompts that trigger real tools (`src/testing/demo-model.ts`): `list files` → `list_directory`; `read a.txt` → `read_file`; `test edit` → `edit_file` on `sample-data.txt`; `test bash` → `bash` echo; `test grep` / `test find` (need rg/fd); `test parallel` → several tools in one turn; anything else → a canned greeting.

Print mode (stdin closed for you, stdout/stderr/exit captured; same `env -i` allowlist as launch):

```bash
$H print $RUN p-list -p "list files"            # → evidence/p-list.{cmd,stdout,stderr,exit}
$H print $RUN p-json --mode json "list files"   # one JSON event per line
```

Piped stdin (isolated env, captures like print):

```bash
echo "list files" | $H pipe $RUN p-pipe
```

SDK: `bun examples/sdk/01-minimal.ts </dev/null` (faux model, prints `Hello! I am a scripted faux model.` and `messages: 2`).

Feature recipes: [features/README.md](features/README.md).

## Evidence

Location: `/tmp/vela-evidence/$RUN/` (override root with `VELA_EVIDENCE_ROOT`). Cleanup never deletes it.

```bash
$H snap $RUN 01-after-edit        # pane + 200 lines scrollback → 01-after-edit.txt
$H grab $RUN sample-data.txt      # copy a side-effect file from work/ → work-sample-data.txt
```

`cleanup` also copies session JSONL under `evidence/$RUN/sessions/`, preserving paths relative to `VELA_DIR` (e.g. `sessions/projects/<project>/sessions/<id>.jsonl` and `…/sessions/<id>/<uuid>/tool-history.jsonl`) so nested `tool-history.jsonl` files from multiple sessions do not collide.

Proof standards:
- Drive the user path (typed prompts, CLI flags), not internal setters or test helpers.
- Snap before and after the action, so the evidence shows the action and its result.
- Check side effects (edited file contents, session JSONL entries, exit code), not just the screen.
- The mock model is the only mock. It stands in for the LLM provider, which is already a separate boundary in the code. Say so in reports: model *wording* is not verified, tool/TUI/session behavior is.

## Cleanup

```bash
$H cleanup $RUN
```

Kills only this run's private tmux server (`tmux -L vela-verify-$RUN kill-server`) and everything under it, copies session logs into evidence (path-preserving under `sessions/`), and removes `/tmp/vela-verify/$RUN`. Prints what is left in the evidence dir. Run it after every failed iteration too. Never `pkill bun`/`pkill -f vela`: other agents share this box.

## Helpers

`scripts/vela-verify.sh <cmd> <run-id> [args]`. Commands: `launch [vela args]`, `doctor`, `send <text>`, `keys <tmux keys…>`, `wait <regex> [timeout_s]`, `snap <name>`, `grab <relpath>`, `print <name> <vela args…>`, `pipe <name> [vela args…]` (stdin → vela), `cleanup`. Run without args for usage.

Full proven example (edit tool through the TUI):

```bash
H=.cursor/skills/verify-vela/scripts/vela-verify.sh; RUN=verify-$(date +%s)
$H launch $RUN && $H doctor $RUN
$H snap $RUN 00-ready
$H send $RUN "test edit" && $H wait $RUN 'Successfully replaced' 20
$H snap $RUN 01-after-edit && $H grab $RUN sample-data.txt
$H cleanup $RUN
grep -q '(updated)' /tmp/vela-evidence/$RUN/work-sample-data.txt && echo PROOF-OK
```
