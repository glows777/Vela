# Slash commands

In the TUI, lines starting with `/` run built-in commands: `/usage` (token usage and cache hit rate), `/context` (context window breakdown), `/cache on|off` (mock-model cache simulation), `/hotkeys`, `/login`, and others.

## Sub-features

- `cmd-status` `/status` shows the session id, file path (not written yet until the first save; in-memory when the session is not saved; custom storage when the location is not reported), model, context estimate and token usage. The dollar amount matches the footer.
- `cmd-usage` `/usage` shows Input / Cache write / Cache read / Output and a `Cache hit rate` bar.
- `cmd-context` `/context` shows context usage.
- `cmd-cache` `/cache off` then `/usage` shows cache reads stop growing.
- `cmd-hotkeys` `/hotkeys` lists key bindings.

## How to get to it (user POV)

- Type `/` in the TUI editor (shows the command list), then the command name and Enter.

## Driving it with vela-verify.sh (tmux)

Interactive path; needs tmux on PATH (`launch` detects only; `doctor` reports `MISSING`, never installs). If missing, skip and use non-interactive features instead.

Preconditions:

- `$H launch $RUN`, `$H doctor $RUN` → `DOCTOR OK` (tmux already on PATH).

- **Status.** Run `$H send $RUN "/status"` and `$H wait $RUN '\[status\]'`. On a fresh session the block names the session id and says `not written yet` (it does not present a `.jsonl` path as a file that already exists), plus `mock/mock-model` and a context estimate. After a turn that writes the session, `Path` is the real file (shortened under `$VELA_DIR` or `~` only when the file is under that directory) and the `Usage:` dollar amount matches the footer. The Path line is fitted to the terminal width, and a fresh session keeps `not written yet` when the id is too long to show beside it.
- **Not saved.** `$H launch $RUN --no-session`, then `/status`. The block says `in-memory (not saved)` and does not name a `.jsonl` file. After exit, no session file is written.
- **Empty usage.** Run `$H send $RUN "/usage"` and `$H wait $RUN 'Cache hit rate'`. Shows `No cacheable input yet`.
- **After turns.** Send `list files` twice (waiting for `\[FILE\] a.txt` each time), then `/usage` again. `Cache read` is non-zero and the hit rate rises.
- **Context.** Run `$H send $RUN "/context"` and `$H snap $RUN cmd-context`.
- **Proof.** `$H snap $RUN cmd-usage-after` captures the numbers; the footer `↑…↓…` counters match.

## Gotchas

- The first `/usage` right after launch has zero numbers by design.
- Typing `/` opens a completion menu; `send` types the full line so the menu closes on Enter, but an ambiguous prefix may select a different command. Always type the full name.
- Cache numbers come from the mock model's simulation, not a real provider.
