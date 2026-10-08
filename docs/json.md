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

Vela waits for stdout to drain when the pipe is full, so a slow reader slows Vela down instead of growing its memory. Keep reading until the process exits.

`Error` values inside events (for example `agent_end.error`) are written as `{ "name": "...", "message": "..." }`. Bigints are written as strings.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | All prompts finished. |
| `1` | A prompt failed or was aborted (the reason is in `agent_end` and on stderr), or no usable model was found at startup. |
| `2` | Usage or configuration error: unknown flag, missing prompt, `-r` outside interactive mode, invalid `--thinking`, broken `settings.json`. |

When a prompt fails, the remaining prompts are not run.

## Session header

The first line describes the session:

```json
{"type":"session","id":"20261008-081417-a872","cwd":"/home/me/project","model":"anthropic/<model-id>","thinkingLevel":"medium"}
```

| Field | Meaning |
|---|---|
| `id` | Session id. Pass it to `--session <id>` to continue this session later. |
| `cwd` | Working directory. |
| `model` | Model as `provider/id`. Omitted when the model can't be resolved. |
| `thinkingLevel` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. |

This is not the same as the first line of the session file; see [Session format](session-format.md).

## Event lines

Every event line is a `VelaEvent`, the same events `session.subscribe()` delivers in the SDK, with an added `sessionId`. The event types, their fields and the order they arrive in are listed in [SDK](sdk.md#events). Only events of the session being run are written; channel sessions and other sessions in the same process are filtered out, so `channel_message`, `channel_reply` and `channel_error` never appear here.

Vela has no `message_start`/`message_update`/`message_end` like pi. Stream `text_delta` for display, then take the final text from the assistant `message` event, which is authoritative. An assistant `message` holds `text`, `reasoning` and `tool-call` parts; a tool message holds `tool-result` parts:

```json
{"type":"message","message":{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call-1","toolName":"list_directory","input":{"path":"."}}]},"sessionId":"..."}
{"type":"message","message":{"role":"tool","content":[{"type":"tool-result","toolCallId":"call-1","toolName":"list_directory","output":{"type":"text","value":"[FILE] notes.txt"}}]},"sessionId":"..."}
```

Use `toolCallId` to pair `tool_call` with its `tool_result` or `tool_error`. Tools have no partial-result event. In JSON mode an extension's `ui.notify()` is written as a `notify` event.

The TypeScript definition is `VelaEvent` in `@glows777/vela`:

```ts
import type { VelaEvent } from '@glows777/vela'
```

## Example

A run captured with the offline demo model (`VELA_MODEL=mock`) in a folder with one file. The demo model streams one character per `text_delta`; most of them are cut here, and the `usage.record` objects are shortened.

```bash
VELA_MODEL=mock vela --mode json "list files" < /dev/null
```

```json
{"type":"session","id":"20261008-081417-a872","cwd":"/tmp/demo","model":"mock/mock-model","thinkingLevel":"medium"}
{"type":"agent_start","input":"list files","sessionId":"20261008-081417-a872"}
{"type":"message","message":{"role":"user","content":"list files"},"sessionId":"20261008-081417-a872"}
{"type":"turn_start","turn":1,"sessionId":"20261008-081417-a872"}
{"type":"tool_call","toolCallId":"call-1791447257865-ypzk","toolName":"list_directory","input":{"path":"."},"sessionId":"20261008-081417-a872"}
{"type":"tool_result","toolCallId":"call-1791447257865-ypzk","toolName":"list_directory","input":{"path":"."},"output":"[FILE] notes.txt","sessionId":"20261008-081417-a872"}
{"type":"usage","modelId":"mock-model","usage":{"inputTokens":3,"outputTokens":23,"cacheReadTokens":0,"cacheWriteTokens":1055},"record":{"cost":0.00143675,"kind":"main","...":"..."},"sessionId":"20261008-081417-a872"}
{"type":"message","message":{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call-1791447257865-ypzk","toolName":"list_directory","input":{"path":"."}}]},"sessionId":"20261008-081417-a872"}
{"type":"message","message":{"role":"tool","content":[{"type":"tool-result","toolCallId":"call-1791447257865-ypzk","toolName":"list_directory","output":{"type":"text","value":"[FILE] notes.txt"}}]},"sessionId":"20261008-081417-a872"}
{"type":"turn_end","turn":1,"needsToolCall":true,"sessionId":"20261008-081417-a872"}
{"type":"turn_start","turn":2,"sessionId":"20261008-081417-a872"}
{"type":"text_delta","text":"F","sessionId":"20261008-081417-a872"}
{"type":"text_delta","text":"i","sessionId":"20261008-081417-a872"}
{"type":"usage","modelId":"mock-model","usage":{"inputTokens":65,"outputTokens":23,"cacheReadTokens":1055,"cacheWriteTokens":0},"record":{"cost":0.0002855,"kind":"main","...":"..."},"sessionId":"20261008-081417-a872"}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Files in the current directory:\n[FILE] notes.txt"}]},"sessionId":"20261008-081417-a872"}
{"type":"turn_end","turn":2,"needsToolCall":false,"sessionId":"20261008-081417-a872"}
{"type":"agent_end","reason":"done","sessionId":"20261008-081417-a872"}
{"type":"agent_settled","sessionId":"20261008-081417-a872"}
```

Print only the final assistant text with `jq`:

```bash
vela --mode json "List files" < /dev/null 2>/dev/null \
  | jq -r 'select(.type == "message" and .message.role == "assistant")
           | [.message.content[]? | select(.type == "text") | .text] | join("")
           | select(. != "")'
```

For plain text output use `vela -p` instead, which writes only the last answer to stdout. See [CLI](cli.md).
