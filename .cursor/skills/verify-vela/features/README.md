# Vela verification map

The maintained source for verifying Vela's user-facing behavior. Read this index, then use the matching feature file as the recipe. All commands use the helper `H=.cursor/skills/verify-vela/scripts/vela-verify.sh` from the repo root (see ../SKILL.md).

## Baseline preconditions

- `bun` ≥ 1.4, `bun install` done. Interactive TUI journeys need `tmux` (verification only): `launch`/`doctor` run `ensure_tmux` and attempt a non-interactive install if missing; if install fails, skip TUI and use `print`/`pipe`/SDK (those never need tmux). `rg`/`fd` on PATH for search tools.
- `RUN=verify-$(date +%s)`; `$H launch $RUN` creates a disposable `VELA_DIR`, `HOME` and `work/` with `sample-data.txt` and `a.txt`.
- `$H doctor $RUN` prints `DOCTOR OK` with `mock/mock-model` before you drive anything.
- Never drive an instance that this run did not start.

## Driving conventions

- TUI actions: `$H send $RUN "<text>"`, then `$H wait $RUN '<regex>'`. Never fixed sleeps.
- Print-mode actions: `$H print $RUN <name> <vela args>` (stdin closed) or `echo … | $H pipe $RUN <name>` (piped stdin). Both use `env -i` isolation.
- Prompts are literal. The mock model matches keywords (`test edit`, `list files`, …).
- Run `$H cleanup $RUN` at the end and after every failure.

## Proof and skip reporting

- TUI proof: a `snap` before and after the action, plus the side effect (`grab`ed file, session JSONL).
- CLI proof: `.cmd`, `.stdout`, `.stderr`, `.exit` from `print`.
- Record the feature ID and entry point with each artifact name (e.g. `tool-edit-tui-after.txt`).
- An unreachable path is reported with the command and the missing precondition. Never count it as verified through another path.

## Features

- [Tool use in the TUI](./tui-tool-use.md): prompt → tool call → rendered diff/result → file side effect.
- [Print and piped mode](./print-mode.md): `-p`, piped stdin, `--mode json`, exit codes.
- [Slash commands](./slash-commands.md): `/usage`, `/context`, `/cache`, `/hotkeys`.
- [Sessions](./sessions.md): persistence to JSONL, `--continue`, `--session`, `--export`.
- [SDK createVela](./sdk.md): embedding with the faux model.
