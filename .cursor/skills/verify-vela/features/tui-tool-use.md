# Tool use in the TUI

A user types a request in the interactive TUI; the agent calls a tool (edit, read, list, bash), the TUI renders the call and result (diff for edits, `[audit]` line), and the file system changes accordingly.

## Sub-features

- `tool-edit` edit_file applies a replacement and renders a diff.
- `tool-list` list_directory shows `[FILE]`/`[DIR]` entries.
- `tool-read` read_file shows file contents.
- `tool-bash` bash runs a command and shows output.
- `tool-parallel` several tool calls in one turn all run.
- `tool-interrupt` Esc stops a running answer.

## How to get to it (user POV)

- Run `vela` in a terminal and type a request at the editor, then Enter.
- With the mock model: `test edit`, `list files`, `read a.txt`, `test bash`, `test parallel`.

## Driving it with vela-verify.sh (tmux)

Needs tmux for this interactive path only. `$H launch` / `$H doctor` call `ensure_tmux` (install if missing); if that fails, skip this feature and use print/pipe/SDK instead.

Preconditions:

- `$H launch $RUN` and `$H doctor $RUN` print `READY` / `DOCTOR OK` (tmux present or successfully installed).
- `work/sample-data.txt` starts with `1. Tool registration` (fresh launch).

- **Before.** Run `$H snap $RUN tool-edit-before`. The footer shows `mock/mock-model` and an empty conversation.
- **Edit.** Run `$H send $RUN "test edit"` and `$H wait $RUN 'Successfully replaced' 20`. Screen shows `edit_file sample-data.txt`, a `-1`/`+1` diff, and `[audit] edit_file → sample-data.txt`.
- **Side effect.** Run `$H snap $RUN tool-edit-after` and `$H grab $RUN sample-data.txt`. `work-sample-data.txt` line 1 is `1. Tool registration (updated)`.
- **List.** Run `$H send $RUN "list files"` and `$H wait $RUN '\[FILE\] a.txt'`. Shows `a.txt` and `sample-data.txt`.
- **Bash.** Run `$H send $RUN "test bash"` and `$H wait $RUN 'Hello from bash!'`.
- **Interrupt.** Send a prompt, then `$H keys $RUN Escape` while `Answering…` is visible. The spinner disappears and the editor accepts input again.

## Gotchas

- `test edit` only works once per fresh fixture: the second time `1. Tool registration` (without suffix) no longer matches and the tool reports an error.
- `$H print` re-seeds `work/` and resets `sample-data.txt`; don't mix it with a live TUI run you're still asserting on.
- `wait` regexes also match your own typed prompt; pick a string only the result contains.
- `test grep`/`test find` fail with `fd (fd) is not installed` unless rg/fd are on PATH (VELA_OFFLINE=1 blocks auto-download).
- Startup lines `[rag] … knowledge base disabled` and `[feishu] … not configured` are expected noise offline.
