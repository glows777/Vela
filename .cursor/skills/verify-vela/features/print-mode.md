# Print and piped mode

Non-interactive use: `vela -p "<prompt>"`, `echo "<prompt>" | vela`, or `vela --mode json "<prompt>"` runs the prompt(s), prints the final answer (or JSON events) on stdout, and exits.

## Sub-features

- `print-p` `-p` prints only the last answer, exit 0.
- `print-pipe` piped stdin is used as the prompt when stdin is not a TTY.
- `print-json` `--mode json` emits one JSON event per line (`session`, `agent_start`, `turn_start`, `message_*`, …).
- `print-version` `--version` prints `0.2.0`.
- `print-sigterm` SIGTERM during a bash tool exits 143 and kills the tool's process group.

## How to get to it (user POV)

- `vela -p "list files"`
- `echo "list files" | vela`
- `vela --mode json "list files"`

## Driving it with vela-verify.sh (print)

Preconditions:

- No launch needed; `print` seeds `/tmp/vela-verify/$RUN/work` itself.

- **-p.** Run `$H print $RUN p-list -p "list files"`. `p-list.exit` is `0`; `p-list.stdout` is `Files in the current directory:` followed by `[FILE] a.txt` and `[FILE] sample-data.txt`; `p-list.stderr` holds only the `[rag]` notice.
- **JSON.** Run `$H print $RUN p-json --mode json "list files"`. First stdout line is `{"type":"session",…,"model":"mock/mock-model",…}`; a `tool_execution_end` event for `list_directory` follows.
- **Piped.** Run `cd /tmp/vela-verify/$RUN/work && echo "list files" | env VELA_DIR=/tmp/vela-verify/$RUN/home VELA_MODEL=mock VELA_OFFLINE=1 bun <repo>/src/cli/main.ts > /tmp/vela-evidence/$RUN/p-pipe.stdout; echo $?`. Same answer, exit 0.
- **Version.** Run `$H print $RUN p-version --version`. stdout `0.2.0`.

## Gotchas

- `vela -p` from a non-TTY shell **with stdin left open** waits for stdin forever (it treats redirected stdin as input). Always `</dev/null` or pipe something; the helper does this.
- The SIGTERM e2e test (`test/e2e/cli.test.ts` "-p: SIGTERM stops a running bash command…") fails on this box: the killed child stays visible to `kill -0` after exit. Likely a zombie under the container's `tini` init rather than a Vela bug; unverified.
- Run `$H cleanup $RUN` afterwards to remove `/tmp/vela-verify/$RUN`.
