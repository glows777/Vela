# Slash commands

In the TUI, lines starting with `/` run built-in commands: `/usage` (token usage and cache hit rate), `/context` (context window breakdown), `/cache on|off` (mock-model cache simulation), `/hotkeys`, `/login`, and others.

## Sub-features

- `cmd-usage` `/usage` shows Input / Cache write / Cache read / Output and a `Cache hit rate` bar.
- `cmd-context` `/context` shows context usage.
- `cmd-cache` `/cache off` then `/usage` shows cache reads stop growing.
- `cmd-hotkeys` `/hotkeys` lists key bindings.

## How to get to it (user POV)

- Type `/` in the TUI editor (shows the command list), then the command name and Enter.

## Driving it with vela-verify.sh (tmux)

Preconditions:

- `$H launch $RUN`, `$H doctor $RUN` → `DOCTOR OK`.

- **Empty usage.** Run `$H send $RUN "/usage"` and `$H wait $RUN 'Cache hit rate'`. Shows `No cacheable input yet`.
- **After turns.** Send `list files` twice (waiting for `\[FILE\] a.txt` each time), then `/usage` again. `Cache read` is non-zero and the hit rate rises.
- **Context.** Run `$H send $RUN "/context"` and `$H snap $RUN cmd-context`.
- **Proof.** `$H snap $RUN cmd-usage-after` captures the numbers; the footer `↑…↓…` counters match.

## Gotchas

- The first `/usage` right after launch has zero numbers by design.
- Typing `/` opens a completion menu; `send` types the full line so the menu closes on Enter, but an ambiguous prefix may select a different command. Always type the full name.
- Cache numbers come from the mock model's simulation, not a real provider.
