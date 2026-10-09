# RPC mode

RPC mode runs Vela as a long-lived child process controlled with JSON lines on stdin and stdout. Use it to drive Vela from another language, from an editor, or from a custom UI in a separate process.

For an in-process Node.js or Bun integration, use the [SDK](sdk.md) instead: it gives you the full API without a process boundary.

| Interface | Process boundary | Control model | Best fit |
|---|---|---|---|
| [SDK](sdk.md) | In process | TypeScript methods and `subscribe()` events | Node.js or Bun hosts that want the full API |
| RPC | Child process | JSONL commands, responses and events | Other languages, isolated processes, editors, custom clients |
| [JSON mode](json.md) | Child process | Prompts on the command line, events out | One-shot scripted runs |

Command names, the `response` record and the extension UI sub-protocol follow pi's RPC protocol, so a pi client needs few changes. The events are different: Vela sends its own `VelaEvent` records; see [Differences from pi](#differences-from-pi).

## Start RPC mode

```bash
vela --mode rpc
```

RPC mode takes no prompt on the command line (that exits with a usage error, code 2); send prompts with the [`prompt`](#prompt) command. The other CLI flags still apply: `--model`, `--thinking`, `-c`, `--session <id>`, `--no-session`, `-e`, `--no-extensions`, `--approve`. See [CLI](cli.md). `-r` is interactive only.

| Startup flag | Session opened |
|---|---|
| none | A new session. |
| `-c` | The most recent saved session, resumed (a new one if there is none). |
| `--session <id>` | That session, resumed. |
| `--no-session` | A new session kept in memory only. |

Vela starts even when no model is configured. The error goes to stderr and the client can send [`set_model`](#set_model) before prompting.

To try it offline, use the demo model and a throwaway agent directory:

```bash
VELA_MODEL=mock VELA_DIR=$(mktemp -d) vela --mode rpc
```

## Protocol records

| Direction | Record | Purpose |
|---|---|---|
| stdin | Command | Prompt, inspect state, change settings, manage sessions. |
| stdout | `response` | Whether one command succeeded, with its data. |
| stdout | Event | What the active session is doing: a `VelaEvent` plus `sessionId`. See [SDK events](sdk.md#events) and [JSON mode](json.md#event-lines). |
| both | `extension_ui_request` / `extension_ui_response` | Extension dialogs and notifications. See [Extension UI](#extension-ui). |

### Commands and responses

A command is an object with a `type` and an optional `id`. Its response repeats the `id`:

```json
{"id":"req-1","type":"get_state"}
{"id":"req-1","type":"response","command":"get_state","success":true,"data":{"sessionId":"20261008-105115-a006","...":"..."}}
```

`data` is omitted when the command returns nothing.

Commands are dispatched as soon as their line arrives and run concurrently, so a quick command can answer before a slower one sent earlier. Give every command a unique `id` and match responses by `id`, not by order.

Events have no `id`. Every event carries the `sessionId` of the session it belongs to, and only the active session's events are sent.

## Framing

Each record is one JSON object terminated by LF (`\n`). Vela splits stdin on `\n` only, strips a trailing `\r`, and ignores blank lines. Read stdout the same way: split on `\n`, and don't use Node's `readline`, which also splits on U+2028 and U+2029, characters that are valid inside JSON strings.

Stdout carries only protocol records. Logs, extension `console.log` output and startup warnings go to stderr; don't parse stderr as protocol data.

Vela waits for stdout to drain when the pipe is full. Keep reading stdout, or Vela stalls.

## Run lifecycle

A successful `prompt` response means the prompt was accepted, not that the model finished:

```json
{"id":"req-2","type":"prompt","message":"Review this repository"}
{"id":"req-2","type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}
```

| `disposition` | Meaning | What to wait for |
|---|---|---|
| `started` | A run started. | `agent_settled` |
| `queued` | A run is in progress; the message was queued as a steer or follow-up. | `agent_settled` of the current run |
| `handled` | The message was an extension command (`/name args`) and has finished. | Nothing; no run started. |

Keep reading events after the response. `agent_end` closes one agent loop, but queued steer and follow-up messages can still run after it. `agent_settled` means the session is idle and nothing else will run on its own.

A prompt can also fail after it was answered with `started`, before the agent loop begins: no model is selected, the model doesn't support the thinking level, or an extension hook throws. No `agent_end` follows in that case, so Vela sends a second response with the same `id` and `success: false`. It comes after the run's `agent_settled`, so a client that stops reading at `agent_settled` misses it; keep reading until Vela exits (as the clients below do):

```json
{"id":"req-2","type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}
{"id":"req-2","type":"response","command":"prompt","success":false,"error":"No model selected. Use --model provider/id, set defaultModel in ~/.vela/settings.json (providers are in ~/.vela/models.json; built-in openai / anthropic read OPENAI_API_KEY / ANTHROPIC_API_KEY), or set OPENAI_API_KEY + OPENAI_API_MODEL_NAME. For an offline demo use VELA_MODEL=mock."}
```

Failures inside the loop (provider errors, aborts) are reported in `agent_end` only.

## Commands

### Prompting

#### prompt

Send a user message.

```json
{"id":"1","type":"prompt","message":"Hello"}
{"id":"2","type":"prompt","message":"Use the other file","streamingBehavior":"steer"}
```

| Field | Type | Meaning |
|---|---|---|
| `message` | string | The text. |
| `streamingBehavior` | `"steer"` \| `"followUp"` | Required while a run is in progress; ignored when idle. |

Response data: `{ "disposition": "started" | "queued" | "handled" }`.

- When idle, the message starts a run.
- While a run is in progress, `streamingBehavior` decides the queue: `steer` is delivered after the current step's tool calls, before the next model request; `followUp` is delivered when the model would otherwise stop. Without `streamingBehavior` the command fails with `A task is already running: ...`.
- A message `/name args` that matches an extension command (see [`get_commands`](#get_commands)) runs the command, even during a run, and the response comes when the command finishes, with `disposition: "handled"`. Any other text starting with `/` is sent to the model as is; the interactive CLI's own slash commands (`/model`, `/context`, ...) don't exist in RPC mode.

#### steer

```json
{"id":"3","type":"steer","message":"Stop and look at src/ instead"}
```

Queues a steering message during a run (`disposition: "queued"`). When idle it starts a run like `prompt` (`disposition: "started"`). Extension commands are rejected: send them with `prompt`.

#### follow_up

```json
{"id":"4","type":"follow_up","message":"After that, also update the docs"}
```

Same as `steer`, but delivered when the model would otherwise stop.

Queueing works only during a prompt's run: while a compaction (or an extension command's loop) holds the session, `steer`, `follow_up` and `prompt` with `streamingBehavior` fail with `A task is already running: ...`; retry after it finishes.

#### abort

```json
{"id":"5","type":"abort"}
```

Aborts the running loop and extension commands, and responds once the agent loop (or compaction) has stopped; extension commands are signalled but not awaited. Queued messages stay queued and are delivered with the next prompt; send `clear_queue` first to drop them.

#### clear_queue

```json
{"id":"6","type":"clear_queue"}
```

Removes all queued messages and returns them: `{ "steering": string[], "followUp": string[] }`. To mirror the TUI's Esc behavior, send `clear_queue`, then `abort`, then put the returned text back in your input box.

### State

#### get_state

```json
{"id":"7","type":"get_state"}
```

```json
{"id":"7","type":"response","command":"get_state","success":true,"data":{"sessionId":"20261008-105115-a006","sessionName":"demo","model":"anthropic/<model-id>","thinkingLevel":"medium","isStreaming":false,"steeringMode":"one-at-a-time","followUpMode":"one-at-a-time","messageCount":2,"pendingMessageCount":0}}
```

| Field | Meaning |
|---|---|
| `sessionId` | Active session id. |
| `sessionName` | Display name; omitted when unset. |
| `model` | `provider/id`; omitted when no model can be resolved. |
| `thinkingLevel` | Current thinking level. |
| `isStreaming` | Whether a run or a compaction is in progress. A running extension command alone doesn't count. |
| `steeringMode`, `followUpMode` | `one-at-a-time` or `all`. |
| `messageCount` | Messages in the history. |
| `pendingMessageCount` | Queued steer plus follow-up messages. |

#### get_messages

```json
{"id":"8","type":"get_messages"}
```

Data: `{ "messages": ModelMessage[] }`, the session history as AI SDK messages (the same objects as in the `message_end` events).

### Sessions

#### new_session

```json
{"id":"9","type":"new_session"}
```

Closes the active session and opens a new, empty one. Data: `{ "sessionId": string }`. Fails while a run is in progress.

#### switch_session

```json
{"id":"10","type":"switch_session","sessionId":"20261008-081417-a872"}
```

Closes the active session and opens a saved one, restoring its history, model and thinking level. The id must appear in `list_sessions`. Data: `{ "sessionId": string }`. Fails while a run is in progress.

#### list_sessions

```json
{"id":"11","type":"list_sessions"}
```

Data: `{ "sessions": [{ "id", "name"?, "updatedAt", "messageCount", "firstMessage" }] }`, newest first. Sessions without messages are not listed. With `--no-session` only sessions of this process are listed.

#### set_session_name

```json
{"id":"12","type":"set_session_name","name":"refactor auth"}
```

Sets the display name shown in session lists; an empty or missing `name` clears it. It is saved right away when idle, or when the current run ends.

### Model and thinking

#### set_model

```json
{"id":"13","type":"set_model","model":"anthropic/<model-id>"}
{"id":"14","type":"set_model","provider":"anthropic","modelId":"<model-id>"}
```

Either `model` as `provider/id`, or pi's `provider` plus `modelId`. Takes effect from the next request. Data: the model info `{ "id", "provider", "ref", "name"?, "contextWindow"?, "reasoning"?, "cost"? }`. Fails for an unknown provider. See [Models](models.md).

#### get_available_models

Data: `{ "models": ModelInfo[] }`, the models listed by the configured providers (`models.json` and extensions). A provider accepts ids that aren't listed, so this is not the full set of usable models.

#### set_thinking_level

```json
{"id":"15","type":"set_thinking_level","level":"high"}
```

`level` is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. A model that doesn't support thinking fails on the next prompt, not here.

#### get_available_thinking_levels

Data: `{ "levels": ["off","minimal","low","medium","high","xhigh","max"] }`.

### Queue modes

#### set_steering_mode, set_follow_up_mode

```json
{"id":"16","type":"set_steering_mode","mode":"all"}
{"id":"17","type":"set_follow_up_mode","mode":"one-at-a-time"}
```

`one-at-a-time` (default) delivers one queued message per step; `all` delivers every queued message at once. Any other value fails.

### Compaction

#### compact

```json
{"id":"18","type":"compact","customInstructions":"Keep the API decisions"}
```

Summarizes earlier history now, keeps recent messages and saves. `customInstructions` (optional) is what the summary should keep. Data: the `context` event of the compaction, `{ "type": "context", "action": "compact", "before", "after", ... }`. Fails while a run is in progress, with `No model selected. ...` when no model is set, and with `Nothing to compact (session too small)` when there is no earlier turn to summarize (as in pi). A summary splits at a user message that is not the first message, has at least six messages from it to the end, and has every earlier tool call answered, so a new or short session has nothing to compact.

### Commands

#### get_commands

```json
{"id":"19","type":"get_commands"}
```

```json
{"id":"19","type":"response","command":"get_commands","success":true,"data":{"commands":[{"name":"memory","description":"List memories; /memory search <keywords> to search, /memory lint to check","extension":"memory","source":"extension"},{"name":"dream","description":"Have the model clean up the memory store (merge duplicates, delete stale entries)","extension":"memory","source":"extension"},{"name":"skill:code-review","description":"Review the current diff","source":"skill"}]}}
```

Extension commands (`source: "extension"`, with the `extension` that registered them), prompt templates (`source: "prompt"`) and skills (`source: "skill"`, named `skill:<name>`), as in pi. Run any of them with `prompt` and `/name args`. The interactive CLI's built-in commands are not listed.

## Extension UI

Extensions talk to the user through `ctx.ui` (see [Extensions](extensions.md)). In RPC mode each call becomes an `extension_ui_request` on stdout. In extension handlers `ctx.hasUI` is `true`.

Dialog requests (`confirm`, `select`, `input`) wait for an `extension_ui_response` on stdin with the same `id`. They have no timeout: the extension waits until the client answers, the run is aborted, or stdin closes. Notification requests (`notify`, `setStatus`, `setWidget`) expect no answer; display them or ignore them.

| `method` | Fields | Answer |
|---|---|---|
| `confirm` | `title`, `message` | `confirmed: true` / `false`, or `cancelled: true` |
| `select` | `title`, `options` (string array) | `value` (one of `options`), or `cancelled: true` |
| `input` | `title`, `placeholder?` | `value`, or `cancelled: true` |
| `notify` | `message`, `notifyType` (`info`, `warning`, `error`) | none |
| `setStatus` | `statusKey`, `statusText?` | none; a missing or empty `statusText` clears the entry |
| `setWidget` | `widgetKey`, `widgetLines?` | none; missing or empty `widgetLines` clears the widget |

Requests:

```json
{"type":"extension_ui_request","id":"d424a52c-ad36-4985-94a8-1bb4603e9dc8","method":"confirm","title":"Delete files?","message":"rm build.log"}
{"type":"extension_ui_request","id":"5b1f...","method":"select","title":"Pick a branch","options":["main","dev"]}
{"type":"extension_ui_request","id":"9c2e...","method":"input","title":"Commit message","placeholder":"fix: ..."}
{"type":"extension_ui_request","id":"c848642d-de54-43c8-a759-4418a8ccda61","method":"notify","message":"[memory] 0 memories, 0 with warnings","notifyType":"info"}
{"type":"extension_ui_request","id":"1e7a...","method":"setStatus","statusKey":"my-ext","statusText":"indexing"}
{"type":"extension_ui_request","id":"77d0...","method":"setWidget","widgetKey":"my-ext","widgetLines":["3 todos"]}
```

Responses:

```json
{"type":"extension_ui_response","id":"d424a52c-ad36-4985-94a8-1bb4603e9dc8","confirmed":false}
{"type":"extension_ui_response","id":"5b1f...","value":"main"}
{"type":"extension_ui_response","id":"9c2e...","cancelled":true}
```

The extension sees `cancelled` as `false` for `confirm` and `undefined` for `select` and `input`. A `confirm` answer counts as yes only when `confirmed` is exactly `true`. An `extension_ui_response` gets no `response` record back, and one with an unknown `id` is ignored.

## Errors

A failed command gets `success: false` and an `error` message; the process keeps running:

```json
{"id":"4","type":"response","command":"nope","success":false,"error":"Unknown command: nope"}
{"id":"e","type":"response","command":"set_model","success":false,"error":"No provider named nope (available: openai, anthropic)"}
{"id":"h","type":"response","command":"set_follow_up_mode","success":false,"error":"mode must be one of one-at-a-time / all"}
```

A line that isn't JSON, or has no string `type`, gets a `parse` response without an `id`:

```json
{"type":"response","command":"parse","success":false,"error":"Failed to parse command: JSON Parse error: Expected '}'"}
```

## Shutdown

Close Vela's stdin to stop it. Vela then answers open dialogs as cancelled, aborts the running task, waits for in-flight commands, saves and disposes the session and extensions, and exits with code 0. Also handle unexpected exits and signals in the client.

## Transcript

A run with the offline demo model (`VELA_MODEL=mock`), from `>` client to `<` Vela. The demo model's one-character `text_delta` updates and part of the `usage` record are left out.

```
> {"id":"1","type":"get_state"}
< {"id":"1","type":"response","command":"get_state","success":true,"data":{"sessionId":"20261008-105115-a006","model":"mock/mock-model","thinkingLevel":"medium","isStreaming":false,"steeringMode":"one-at-a-time","followUpMode":"one-at-a-time","messageCount":0,"pendingMessageCount":0}}
> {"id":"2","type":"prompt","message":"hello"}
< {"id":"2","type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}
< {"type":"agent_start","input":"hello","sessionId":"20261008-105115-a006"}
< {"type":"message_start","message":{"role":"user","content":"hello"},"sessionId":"20261008-105115-a006"}
< {"type":"message_end","message":{"role":"user","content":"hello"},"sessionId":"20261008-105115-a006"}
< {"type":"turn_start","turn":1,"sessionId":"20261008-105115-a006"}
< {"type":"message_start","message":{"role":"assistant","content":[]},"sessionId":"20261008-105115-a006"}
< {"type":"message_update","message":{"role":"assistant","content":[]},"assistantMessageEvent":{"type":"text_start","contentIndex":0},"sessionId":"20261008-105115-a006"}
< {"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"Hi! I'm the Vela demo model, with prompt caching and cost tracking wired up :) Chat for a few turns, then type /usage to see how much you saved."}]},"assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"Hi! I'm the Vela demo model, with prompt caching and cost tracking wired up :) Chat for a few turns, then type /usage to see how much you saved."},"sessionId":"20261008-105115-a006"}
< {"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Hi! I'm the Vela demo model, with prompt caching and cost tracking wired up :) Chat for a few turns, then type /usage to see how much you saved."}]},"stopReason":"stop","sessionId":"20261008-105115-a006"}
< {"type":"usage","modelId":"mock-model","usage":{"inputTokens":2,"outputTokens":23,"cacheReadTokens":0,"cacheWriteTokens":941},"record":{"cost":0.00129325,"kind":"main","...":"..."},"sessionId":"20261008-105115-a006"}
< {"type":"turn_end","turn":1,"message":{"role":"assistant","content":[{"type":"text","text":"Hi! I'm the Vela demo model, with prompt caching and cost tracking wired up :) Chat for a few turns, then type /usage to see how much you saved."}]},"toolResults":[],"sessionId":"20261008-105115-a006"}
< {"type":"agent_end","messages":[{"role":"user","content":"hello"},{"role":"assistant","content":[{"type":"text","text":"Hi! I'm the Vela demo model, with prompt caching and cost tracking wired up :) Chat for a few turns, then type /usage to see how much you saved."}]}],"reason":"done","sessionId":"20261008-105115-a006"}
< {"type":"agent_settled","sessionId":"20261008-105115-a006"}
> {"id":"3","type":"set_session_name","name":"demo"}
< {"id":"3","type":"response","command":"set_session_name","success":true}
> {"id":"4","type":"nope"}
< {"id":"4","type":"response","command":"nope","success":false,"error":"Unknown command: nope"}
```

An extension dialog, captured with the [confirm-dangerous](../examples/extensions/confirm-dangerous.ts) example extension (`-e examples/extensions/confirm-dangerous.ts`) and a scripted [faux model](testing.md) that calls `bash` with `rm build.log`:

```
> {"id":"p1","type":"prompt","message":"delete the build log"}
< {"id":"p1","type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}
< {"type":"agent_start","input":"delete the build log","sessionId":"20261008-105126-f165"}
< {"type":"message_start","message":{"role":"user","content":"delete the build log"},"sessionId":"20261008-105126-f165"}
< {"type":"message_end","message":{"role":"user","content":"delete the build log"},"sessionId":"20261008-105126-f165"}
< {"type":"turn_start","turn":1,"sessionId":"20261008-105126-f165"}
< {"type":"message_start","message":{"role":"assistant","content":[]},"sessionId":"20261008-105126-f165"}
< {"type":"message_update","message":{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call-1","toolName":"bash","input":{}}]},"assistantMessageEvent":{"type":"toolcall_start","contentIndex":0},"sessionId":"20261008-105126-f165"}
< {"type":"message_update","message":{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call-1","toolName":"bash","input":{"command":"rm build.log"}}]},"assistantMessageEvent":{"type":"toolcall_end","contentIndex":0,"toolCall":{"type":"tool-call","toolCallId":"call-1","toolName":"bash","input":{"command":"rm build.log"}}},"sessionId":"20261008-105126-f165"}
< {"type":"message_end","message":{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call-1","toolName":"bash","input":{"command":"rm build.log"}}]},"stopReason":"toolUse","sessionId":"20261008-105126-f165"}
< {"type":"tool_execution_start","toolCallId":"call-1","toolName":"bash","args":{"command":"rm build.log"},"sessionId":"20261008-105126-f165"}
< {"type":"extension_ui_request","id":"d424a52c-ad36-4985-94a8-1bb4603e9dc8","method":"confirm","title":"Delete files?","message":"rm build.log"}
> {"type":"extension_ui_response","id":"d424a52c-ad36-4985-94a8-1bb4603e9dc8","confirmed":false}
< {"type":"tool_execution_end","toolCallId":"call-1","toolName":"bash","result":"[Blocked by hook] User did not allow the deletion","isError":false,"durationMs":3912,"sessionId":"20261008-105126-f165"}
...
< {"type":"agent_settled","sessionId":"20261008-105126-f165"}
```

The dialog comes from the extension's `tool_call` handler, which runs after `tool_execution_start` and before the tool; `tool_execution_end` follows the answer.

## Client example

[examples/rpc-client.ts](../examples/rpc-client.ts) is a small TypeScript client using only `node:` modules. It starts `bun src/cli/main.ts --mode rpc` (set `VELA_RPC_COMMAND=vela` to use an installed CLI), sends one prompt, prints streamed text and tool calls, cancels any extension dialog, waits for `agent_settled` and closes stdin. From the repository root:

```bash
VELA_MODEL=mock VELA_DIR=$(mktemp -d) bun examples/rpc-client.ts "list files"
```

A minimal Python client:

```python
import json
import subprocess

process = subprocess.Popen(["vela", "--mode", "rpc"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)

process.stdin.write(json.dumps({"id": "p1", "type": "prompt", "message": "Hello"}).encode() + b"\n")
process.stdin.flush()

# readline() on a binary pipe splits on b"\n" only
while line := process.stdout.readline():
    record = json.loads(line)
    if record["type"] == "message_update" and record["assistantMessageEvent"]["type"] == "text_delta":
        print(record["assistantMessageEvent"]["delta"], end="", flush=True)
    elif record["type"] == "response" and not record["success"]:
        print(record["error"])
    elif record["type"] == "agent_settled":
        print()
        # Closing stdin makes Vela exit; keep reading until then so a late prompt failure is still printed
        process.stdin.close()

process.wait()
```

## Differences from pi

| | pi | Vela |
|---|---|---|
| Events | `AgentSessionEvent` (`message_start` / `message_update` / `message_end`, `tool_execution_*`, `compaction_*`, `auto_retry_*`) | `VelaEvent` plus `sessionId`: the same message, tool and retry events, but messages are AI SDK `ModelMessage`s and the stop reason is on `message_end`; compaction is a `context` event; Vela adds `usage`, `loop_detected` and others. See [SDK events](sdk.md#events). |
| `prompt` / `steer` / `follow_up` | Accept `images` | Text only |
| `steer` / `follow_up` when idle | Queued | Start a run (`disposition: "started"`) |
| `new_session`, `switch_session` | Return `{ cancelled }`; `switch_session` takes `sessionPath` | Return `{ sessionId }`; `switch_session` takes `sessionId` |
| `set_model` | `provider` + `modelId` | Also accepts `model: "provider/id"` |
| `get_state` | `model` is an object; also `sessionFile`, `isCompacting`, `autoCompactionEnabled` | `model` is a `provider/id` string; no session file |
| Extra commands | | `list_sessions` |
| `get_commands` | Extension commands, prompt templates, skills, with `source` / `sourceInfo` | Same entries and `source`; extension commands also carry `extension`, no `sourceInfo` |
| Extension UI | Also `editor`, `setTitle`, `set_editor_text`, `timeout` | `confirm`, `select`, `input`, `notify`, `setStatus`, `setWidget` |
| Typed client | `RpcClient` exported | No client export; see [examples/rpc-client.ts](../examples/rpc-client.ts) |

pi commands Vela doesn't have: `cycle_model`, `cycle_thinking_level`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`, `bash`, `abort_bash`, `get_session_stats`, `export_html`, `fork`, `clone`, `get_fork_messages`, `get_entries`, `get_tree`, `get_last_assistant_text`. Sending one returns `Unknown command`.
