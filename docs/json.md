# JSON mode

JSON mode runs one or more prompts against the session and writes every event as JSON lines (NDJSON) on stdout:

```bash
vela --mode json "Review this repository"
```

Vela writes one `session` header line, then one line per v0.9 [`RuntimeEvent` or `StreamDeltaEvent`](../packages/vela/src/runtime/events.ts) (plus `run_finished` at the end of each turn), and exits when the prompts are done. For long-lived bidirectional control from another process, use `connectRuntime()` from `@glows777/vela` (see [SDK](sdk.md)).

## Running

```bash
vela --mode json "first prompt" "second prompt"   # prompts run in order, in one session
git diff | vela --mode json "Review this diff"     # piped stdin is prepended to the first prompt
echo "Summarize README.md" | vela --mode json      # stdin alone is the prompt
vela --mode json -c "Continue where we left off"   # continue the most recent session
```

The usual session and model flags apply (`-c`, `--session <id>`, `--no-session`, `--model`, `--thinking`, `-e`, `--no-extensions`, `--approve`); see [CLI](cli.md). `-r` is interactive only and exits with code 2 here.

When stdin is not a terminal, Vela reads it to the end before starting, even if a prompt is given on the command line. From a script that has an open but unused stdin, pass `< /dev/null`.

JSON mode has no UI. Extension dialogs answer "no": `confirm` returns `false`, `select` and `input` return `undefined`. `ui.notify()` becomes a `notify` `RuntimeEvent`. Project extensions in an untrusted folder are skipped unless you pass `--approve`; see [Security](security.md).

## Framing and process I/O

Each record is one JSON object terminated by LF (`\n`). Split records only on LF. Unicode line and paragraph separators (U+2028, U+2029) are valid inside JSON strings and are not record boundaries, so don't use Node's `readline`, which splits on them; use a byte or UTF-8 stream decoder and split on `\n`.

Stdout carries only JSON lines. Diagnostics and warnings go to stderr (and extension `logger`/`console` output during daemon execution goes to `<VELA_DIR>/daemon.log`).

Vela waits for stdout to drain when the pipe is full, so a slow reader slows Vela down instead of growing its memory. Keep reading until the process exits. If the reader closes stdout early (`vela --mode json "..." | head -3`), Vela stops and exits quietly with code 0.

`Error` values are written as `{ "name": "...", "message": "..." }`. Bigints are written as strings.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | All prompts finished. |
| `1` | A prompt failed or was aborted (the reason is on stderr and in `run_finished.error`), or no usable model was found at startup. |
| `2` | Usage or configuration error: unknown flag, missing prompt, retired command (`vela serve` / `--mode rpc`), `-r` outside interactive mode, invalid `--thinking` or `--session` id, broken `config.json` or `vela.db`. |

When a prompt fails, the remaining prompts are not run.

## Session header and event stream

The first line describes the session, followed by `RuntimeEvent` (persisted state transitions carrying a monotonic `seq`) and `StreamDeltaEvent` (`text_delta`, `thinking_delta`, `toolcall_end`, `tool_output_delta`, `bash_output_delta`) frames:

```json
{"type":"session","id":"20261127-010000-b74a","cwd":"/tmp/demo","model":"mock/mock-model","thinkingLevel":"medium"}
{"type":"run_started","runId":"...","trigger":"user","seq":1,"sessionId":"20261127-010000-b74a","projectId":null,"timestamp":"2026-11-27T01:00:00.000Z"}
{"type":"message_committed","runId":"...","messageId":"...","message":{"role":"user","content":"list files"},"seq":2,"sessionId":"20261127-010000-b74a","projectId":null,"timestamp":"2026-11-27T01:00:00.001Z"}
{"type":"toolcall_end","sessionId":"20261127-010000-b74a","runId":"...","contentIndex":0,"toolCall":{"toolCallId":"call-1","toolName":"bash","input":{"command":"ls"}}}
{"type":"message_committed","runId":"...","messageId":"...","message":{"role":"assistant","content":[{"type":"tool_call","toolCallId":"call-1","toolName":"bash","input":{"command":"ls"}}]},"seq":3,"sessionId":"20261127-010000-b74a","projectId":null,"timestamp":"2026-11-27T01:00:00.010Z"}
{"type":"tool_started","runId":"...","toolCallId":"call-1","toolName":"bash","input":{"command":"ls"},"seq":4,"sessionId":"20261127-010000-b74a","projectId":null,"timestamp":"2026-11-27T01:00:00.011Z"}
{"type":"tool_finished","runId":"...","toolCallId":"call-1","toolName":"bash","isError":false,"durationMs":3,"result":"notes.txt\n","seq":5,"sessionId":"20261127-010000-b74a","projectId":null,"timestamp":"2026-11-27T01:00:00.014Z"}
{"type":"message_committed","runId":"...","messageId":"...","message":{"role":"tool","content":[{"type":"tool_result","toolCallId":"call-1","toolName":"bash","output":{"type":"text","value":"notes.txt\n"}}]},"seq":6,"sessionId":"20261127-010000-b74a","projectId":null,"timestamp":"2026-11-27T01:00:00.015Z"}
{"type":"text_delta","sessionId":"20261127-010000-b74a","runId":"...","contentIndex":0,"delta":"The tool returned:\nnotes.txt\n"}
{"type":"message_committed","runId":"...","messageId":"...","message":{"role":"assistant","content":[{"type":"text","text":"The tool returned:\nnotes.txt\n"}]},"seq":7,"sessionId":"20261127-010000-b74a","projectId":null,"timestamp":"2026-11-27T01:00:00.020Z"}
{"type":"run_finished","runId":"...","status":"completed","seq":8,"sessionId":"20261127-010000-b74a","projectId":null,"timestamp":"2026-11-27T01:00:00.021Z"}
```

Core write/edit auditing also emits `{"type":"audit","runId":"...","toolName":"write","path":"..."}` events even under `--no-extensions`.

Print only the final assistant text with `jq`:

```bash
vela --mode json "List files" < /dev/null 2>/dev/null \
  | jq -r 'select(.type == "message_committed" and .message.role == "assistant")
           | [.message.content[]? | select(.type == "text") | .text] | join("")
           | select(. != "")'
```

For plain text output use `vela -p` instead, which writes only the last answer to stdout. See [CLI](cli.md).

A failed `run_finished` event carries `status: "failed"`, raw `error`, and `errorKind`; see [failure kinds](sdk.md#failed-agent-runs).
