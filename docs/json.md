# JSON mode

JSON mode runs one or more prompts and writes everything that happens as JSON lines on stdout:

```bash
vela --mode json "Review this repository"
```

Vela writes one session header, then one line per event, and exits when the prompts are done. [RPC mode](rpc.md) writes the same event lines but has no session header, because it is a long-lived, bidirectional protocol.

Events are Vela's own `VelaEvent` type, the same events `session.subscribe()` delivers in the [SDK](sdk.md#events), not pi's `AgentSessionEvent`. This page covers what is specific to JSON mode: running it, framing, exit codes and the session header.

## Running

```bash
vela --mode json "first prompt" "second prompt"   # prompts run in order, in one session
git diff | vela --mode json "Review this diff"     # piped stdin is prepended to the first prompt
echo "Summarize README.md" | vela --mode json      # stdin alone is the prompt
vela --mode json -c "Continue where we left off"   # continue the most recent session
```

The usual session and model flags apply (`-c`, `--session <id>`, `--no-session`, `--model`, `--thinking`, `-e`, `--no-extensions`, `--approve`); see [CLI](cli.md). `-r` is interactive only and exits with a usage error here.

When stdin is not a terminal, Vela reads it to the end before starting, even if a prompt is given on the command line. From a script that has an open but unused stdin, pass `< /dev/null`.

JSON mode has no UI. Extension dialogs answer "no": `confirm` returns `false`, `select` and `input` return `undefined`. `ui.notify()` becomes a [`notify`](sdk.md#events) event. Project extensions in an untrusted folder are skipped unless you pass `--approve`; see [Security](security.md).

## Framing and process I/O

Each record is one JSON object terminated by LF (`\n`). Split records only on LF. Unicode line and paragraph separators (U+2028, U+2029) are valid inside JSON strings and are not record boundaries, so don't use Node's `readline`, which splits on them; use a byte or UTF-8 stream decoder and split on `\n`.

Stdout carries only JSON lines. Diagnostics, extension `console.log` output and warnings such as `[rag] embedding ... not configured` go to stderr.

Vela waits for stdout to drain when the pipe is full, so a slow reader slows Vela down instead of growing its memory. Keep reading until the process exits. If the reader closes stdout early (`vela --mode json "..." | head -3`), Vela stops and exits quietly with code 0.

`Error` values inside events (for example `agent_end.error`) are written as `{ "name": "...", "message": "..." }`. Bigints are written as strings.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | All prompts finished. |
| `1` | A prompt failed or was aborted (the reason is on stderr, and in `agent_end` when the agent loop had started), or no usable model was found at startup. |
| `2` | Usage or configuration error: unknown flag, missing prompt, `-r` outside interactive mode, invalid `--thinking` or `--session` id, broken `settings.json`. |

When a prompt fails, the remaining prompts are not run.

## Session header

The first line describes the session:

```json
{"type":"session","id":"20261009-052052-b74a","cwd":"/tmp/demo","model":"mock/mock-model","thinkingLevel":"medium"}
{"type":"agent_start","input":"list files","sessionId":"20261009-052052-b74a"}
{"type":"message_start","message":{"role":"user","content":"list files"},"sessionId":"20261009-052052-b74a"}
{"type":"message_end","message":{"role":"user","content":"list files"},"sessionId":"20261009-052052-b74a"}
{"type":"turn_start","turn":1,"sessionId":"20261009-052052-b74a"}
{"type":"message_start","message":{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call-1791523252060-16g6","toolName":"list_directory","input":{}}]},"sessionId":"20261009-052052-b74a"}
{"type":"message_update","message":{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call-1791523252060-16g6","toolName":"list_directory","input":{}}]},"assistantMessageEvent":{"type":"toolcall_start","contentIndex":0},"sessionId":"20261009-052052-b74a"}
{"type":"message_update","message":{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call-1791523252060-16g6","toolName":"list_directory","input":{"path":"."}}]},"assistantMessageEvent":{"type":"toolcall_delta","contentIndex":0,"delta":"{\"path\":\".\"}"},"sessionId":"20261009-052052-b74a"}
{"type":"message_update","message":{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call-1791523252060-16g6","toolName":"list_directory","input":{"path":"."}}]},"assistantMessageEvent":{"type":"toolcall_end","contentIndex":0,"toolCall":{"type":"tool-call","toolCallId":"call-1791523252060-16g6","toolName":"list_directory","input":{"path":"."}}},"sessionId":"20261009-052052-b74a"}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call-1791523252060-16g6","toolName":"list_directory","input":{"path":"."}}]},"stopReason":"toolUse","sessionId":"20261009-052052-b74a"}
{"type":"tool_execution_start","toolCallId":"call-1791523252060-16g6","toolName":"list_directory","args":{"path":"."},"sessionId":"20261009-052052-b74a"}
{"type":"tool_execution_end","toolCallId":"call-1791523252060-16g6","toolName":"list_directory","result":"[FILE] notes.txt","isError":false,"durationMs":0,"sessionId":"20261009-052052-b74a"}
{"type":"usage","modelId":"mock-model","usage":{"inputTokens":3,"outputTokens":23,"cacheReadTokens":0,"cacheWriteTokens":941},"record":{"cost":0.00129425,"kind":"main","...":"..."},"sessionId":"20261009-052052-b74a"}
{"type":"message_start","message":{"role":"tool","content":[{"type":"tool-result","toolCallId":"call-1791523252060-16g6","toolName":"list_directory","output":{"type":"text","value":"[FILE] notes.txt"}}]},"sessionId":"20261009-052052-b74a"}
{"type":"message_end","message":{"role":"tool","content":[{"type":"tool-result","toolCallId":"call-1791523252060-16g6","toolName":"list_directory","output":{"type":"text","value":"[FILE] notes.txt"}}]},"sessionId":"20261009-052052-b74a"}
{"type":"turn_end","turn":1,"message":{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call-1791523252060-16g6","toolName":"list_directory","input":{"path":"."}}]},"toolResults":[{"type":"tool-result","toolCallId":"call-1791523252060-16g6","toolName":"list_directory","output":{"type":"text","value":"[FILE] notes.txt"}}],"sessionId":"20261009-052052-b74a"}
{"type":"turn_start","turn":2,"sessionId":"20261009-052052-b74a"}
{"type":"message_start","message":{"role":"assistant","content":[]},"sessionId":"20261009-052052-b74a"}
{"type":"message_update","message":{"role":"assistant","content":[]},"assistantMessageEvent":{"type":"text_start","contentIndex":0},"sessionId":"20261009-052052-b74a"}
{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"F"}]},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"F"},"sessionId":"20261009-052052-b74a"}
{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"Fi"}]},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"i"},"sessionId":"20261009-052052-b74a"}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Files in the current directory:\n[FILE] notes.txt"}]},"stopReason":"stop","sessionId":"20261009-052052-b74a"}
{"type":"usage","modelId":"mock-model","usage":{"inputTokens":65,"outputTokens":23,"cacheReadTokens":941,"cacheWriteTokens":0},"record":{"cost":0.0002855,"kind":"main","...":"..."},"sessionId":"20261009-052052-b74a"}
{"type":"turn_end","turn":2,"message":{"role":"assistant","content":[{"type":"text","text":"Files in the current directory:\n[FILE] notes.txt"}]},"toolResults":[],"sessionId":"20261009-052052-b74a"}
{"type":"agent_end","messages":["...the user, assistant, tool and assistant messages above..."],"reason":"done","sessionId":"20261009-052052-b74a"}
{"type":"agent_settled","sessionId":"20261009-052052-b74a"}
```

Print only the final assistant text with `jq`:

```bash
vela --mode json "List files" < /dev/null 2>/dev/null \
  | jq -r 'select(.type == "message_end" and .message.role == "assistant")
           | [.message.content[]? | select(.type == "text") | .text] | join("")
           | select(. != "")'
```

For plain text output use `vela -p` instead, which writes only the last answer to stdout. See [CLI](cli.md).
