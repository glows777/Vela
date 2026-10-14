# Sessions

Each run is a session saved as JSONL under `VELA_DIR/projects/<cwd-slug>/sessions/<id>.jsonl`. Users continue the latest one with `-c`, open one with `--session <id>`, pick one with `-r`, fork with `--fork`, and export HTML with `--export`.

## Sub-features

- `sess-persist` a TUI or `-p` run writes `<id>.jsonl` with the user and assistant messages.
- `sess-continue` `vela -c -p "<prompt>"` appends to the latest session.
- `sess-export` `vela --export <id> out.html` writes HTML and exits.
- `sess-memory` `--no-session` writes no session file.

## How to get to it (user POV)

- The session id is shown at startup (`Vela session <id>`) and in the footer.
- `vela -c`, `vela --session <id>`, `vela -r`, `vela --export <id> [out]`.

## Driving it with vela-verify.sh (print + tmux)

Preconditions:

- Fresh `$RUN`; do the steps in order with the same run id.

- **Persist.** Run `$H print $RUN s1 -p "list files"`. `ls /tmp/vela-verify/$RUN/home/projects/*/sessions/` shows one `.jsonl` containing `"list files"`.
- **Continue.** Run `$H print $RUN s2 -c -p "read a.txt"`. Still one session file; it now also contains `read a.txt`.
- **Export.** Run `$H print $RUN s3 --export <id> /tmp/vela-evidence/$RUN/session.html`. Exit 0 and the HTML file exists.
- **Proof.** `$H cleanup $RUN` copies the session JSONL into `/tmp/vela-evidence/$RUN/`.

## Gotchas

- Sessions are keyed by cwd. `print` always runs in `/tmp/vela-verify/$RUN/work`, so `-c` finds the earlier one; running vela from elsewhere won't.
- `print` re-seeds `a.txt`/`sample-data.txt` but does not delete `home/`, so sessions survive between `print` calls in the same run.
- Not yet driven end to end by this skill; treat the expected outputs as unverified until a run confirms them.
