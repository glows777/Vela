# Sessions and context

A session is one conversation: its message history, queued messages, compaction state, token usage, tool results, role and run lock. Like pi, Vela appends each message to the session file as it enters the history, so a crash loses at most the step in progress, and you can continue the session later. This page covers where sessions live, how to continue them, and how Vela keeps a long session within the model's context window.

For the API, see [SDK](sdk.md#sessions). For the file contents, see [Session format](session-format.md).

## Session ids and storage

Every session has an id, which is also its file name. Ids use letters, digits, `.`, `_` and `-`, don't start with `.`, and are at most 128 characters.

- The CLI starts a new session on every launch with an id made from the local time and four random characters, such as `20261008-081441-da14`.
- Channel sessions get `<channel>-<conversationId>-<senderId>`, one per chat and sender (hashed when the ids have other characters). See [Channels](channels.md).
- In the SDK you choose the id: `vela.session('support-42')`. The default is `default`.

The CLI stores each session in the sessions directory of the [project data directory](settings.md#data-directory): `sessions/<id>.jsonl` holds the session's entries (messages, compactions, setting changes) and `sessions/<id>/` the long tool output and tool call history.

To delete a session, delete `<id>.jsonl` and the `<id>/` directory.

In the SDK, sessions are stored in `<dataDir>/sessions/` when you pass `dataDir`, in memory when you don't, or wherever a custom `sessionStorage` puts them. See [SDK](sdk.md#session-storage).

## Continue or switch sessions

The CLI's `-c`, `-r`, `--session` and `--no-session` flags choose which session a run opens; see [CLI](cli.md#sessions). In print, JSON and RPC modes use `--session` or `-c`.

In interactive mode:

| Command | Effect |
|---|---|
| `/new` | Close this session and start a new one |
| `/resume` | Pick a saved session and switch to it |
| `/name [name]` | Show or set the session's display name, shown in the picker |
| `/compact [focus]` | Compact the context now (see [Compaction](#compaction)) |
| `/context` | Show what fills the context window |
| `/usage` | Show this session's token usage, cache hit rate and cost |

In the SDK, `vela.session(id)` opens a session with an empty history; call `await session.resume()` to continue a saved one. Prompting a session whose id already has saved history without resuming it fails (`Session <id> already has saved history: call resume() to continue it, or use another session id`) rather than mixing two conversations in one file; messages added with `session.append()` to such a session are not written either (`session_save_failed`).

The picker lists sessions newest first by name (or first message), id, message count and time. Sessions with no messages are not listed.

## Multiple sessions

One Vela can run many sessions at once. They share tool definitions, extensions, skills, memory, the knowledge base and channels; each keeps its own history, queues, compaction, usage, tool results, role and run lock. This is a difference from pi, where one process holds one active session. A channel like Feishu needs it: every sender gets their own session, and one slow conversation doesn't block the others. Messages from one sender are handled in order.

The CLI shows one session at a time, but channels started from it run their own sessions in the same process. In the SDK, open as many as you need with `vela.session(id)`; see [03-multi-session.ts](../examples/sdk/03-multi-session.ts).

## Queueing: steer and follow-up

A session runs one agent loop at a time. Input that arrives while it runs is queued in one of two ways:

| Mode | When it is sent | Interactive | SDK |
|---|---|---|---|
| steer | After the current step's tools finish, before the next model request | Enter | `session.steer(text)` |
| follow-up | When the model would otherwise stop (no tool calls and no steer) | Alt+Enter | `session.followUp(text)` |

By default one queued message is taken at a time (`steeringMode` and `followUpMode` can be set to `all`). Steer messages go first. If the loop ends early (an error or loop detection), the remaining messages run in a new loop. After an abort the loop stops and the queue is kept.

In interactive mode the queue is shown above the editor. Alt+Up moves queued messages back into the editor; Esc aborts the run and moves them back too.

`prompt()` in the SDK resolves only after the queue is drained and emits `agent_settled` last.

## Compaction

Vela estimates the size of each request before sending it (system prompt, tool definitions and messages, about 0.3 tokens per character) and compacts when it gets too large. The check runs before every model request, including requests that continue after tool calls. Compaction has two stages.

### Microcompaction

When the estimate reaches `microcompactThreshold`, Vela folds old tool results: their text is replaced by a reference to a file holding the full output (`[tool result preview omitted; original available at path]`). The model can read it back with `read_file`.

- Only results of `read_file`, `bash`, `grep`, `find`, `list_directory`, `edit_file` and `write_file` are folded.
- The five most recent tool calls are kept as they are.
- Failed or timed-out results, and failed bash commands, are kept. A folded successful `bash` result keeps its `exit=0` line.

Microcompaction is applied only if it saves at least `minMicroSavings` tokens and brings the request below `summaryThreshold`. It emits a `context` event with `action: 'micro'`. Each changed tool message is recorded as a `context_edit` entry (pi's context edit); the original output stays in the session file. Because it changes messages only from the oldest ones forward, most of the cached prompt prefix survives.

### Summary

When the estimate reaches `summaryThreshold` (and microcompaction wasn't enough), Vela asks the model to summarize the earlier history:

1. It picks a split point at a user message, at least six messages from the end, where every tool call before it has its result.
2. It sends the full current request plus one instruction asking for a JSON summary: the user's goal and lists of completed work, pending work, constraints and key facts. Every item must be a verbatim quote from a removed message; quotes that don't match the original text are rejected.
3. In the context, the removed messages are replaced by one user message, `[Summary of the earlier conversation]`, followed by the summary and a guide to the tool call history file, so the model can still look up earlier tool calls and outputs.
4. Like pi, a `compaction` entry is appended to the session (summary and the first kept message); the summarized messages stay in the file. `compaction_start` and `compaction_end` events (`reason: 'threshold'`) are emitted around it.

If the summary fails (the model returns invalid JSON, tool calls, unverifiable quotes, or the result is still too large), the turn stops with an error and the original history is kept. Nothing is lost; fix the cause (for example switch to a model with a larger window) and try again.

The summary request uses the same model, system prompt and tool definitions as the main request, so it reuses the prompt cache. Its token usage is recorded like any other request.

### Manual compaction

`/compact [focus]` in interactive mode, `session.compact(focus)` in the SDK and the `compact` RPC command summarize now, whatever the thresholds. `focus` tells the summary which quotes to prefer. It emits `compaction_start` / `compaction_end` with `reason: 'manual'`. It can't run while the session is running. When there is no earlier turn to summarize (an empty or short session: the split must be at a user message that is not the first message, with at least six messages from it to the end and every earlier tool call answered), it fails with `Nothing to compact (session too small)`, as in pi.

### Thresholds and context window

The thresholds are the `microcompactThreshold`, `summaryThreshold`, `minMicroSavings` and `maxInputTokens` limits. Their defaults match a 200k window; when the model entry has a `contextWindow`, they are derived from it and recomputed when you switch models. Values set in the `limits` setting or the `limits` option of `createVela()` always win. See [Settings](settings.md#limits) for the defaults and formulas.

A request that is still above `maxInputTokens` after compaction is not sent; the turn stops with an error.

## Long tool output

A tool result longer than the tool's limit (12,000 characters for `grep` and `find`, 3,000 for most other tools; `read_file` pages and `bash` previews have their own limits; see [Tools](tools.md#result-size-and-truncation)) is saved in full to `<dataDir>/sessions/<id>/tool-results/<callId>.txt`. The model gets a preview (the first 60% and last 40% of the limit) with the file path, size and a hint to page through it with `read_file`.

Every tool call and its result is also appended to a tool call history file (`<dataDir>/sessions/<id>/<historyId>/tool-history.jsonl`), which survives compaction. See [Session format](session-format.md#tool-call-history).

Vela doesn't expire tool results by age: content changes only through microcompaction and summaries, when the thresholds above are reached.

## Loop detection

Vela watches the last 30 tool calls of a run for repetition:

| Detector | Warning | Critical |
|---|---|---|
| `generic_repeat`: the same tool with the same arguments | 10 calls | 20 calls |
| `ping_pong`: alternating between two calls | 10 alternations | 20 alternations |

A warning emits `loop_detected` and adds a user message after that step telling the model to change approach. A critical detection emits `loop_detected` and ends the run with `agent_end` reason `loop`. The window starts fresh with each prompt.

## Retries

When a model request fails with a transient error, Vela retries it with exponential backoff and jitter: `min(retryBaseMs × 2^(attempt-1), retryMaxMs)`, then ±25% jitter, up to `maxRetries` times (defaults 500 ms, 30 s, 3). Like pi, the failed attempt's assistant message ends with `stopReason: 'error'` (the TUI keeps its partial text marked as failed) and is not kept in the history; `auto_retry_start` is emitted before each new attempt, and `auto_retry_end` when the request succeeds or retrying gives up. A request is never sent again once its tools have started running.

Retryable errors are HTTP 408, 409, 429, 5xx and 529 (as reported by the provider), connection resets, timeouts, network failures and streams that produced no output. Other 4xx errors fail right away. An abort is never retried.

## Interrupted and failed turns

When a turn is aborted or fails for good, it ends like in pi:

- If the model had finished its message and its tools were running, the message stays in the history and each tool call gets a result: its real result if it finished, otherwise an error result (`Operation aborted`, as in pi), so the model knows what already happened.
- If the message was cut off while it streamed, it is appended to the session with `stopReason: 'aborted'` or `'error'` (the text and whole tool calls received so far), but it is not part of the history sent to the model, now or after a resume. None of its tools ran: tools run only after the model finishes its message. Its `message_end` has the same `stopReason`.

`agent_end` reports `aborted` or `error`, and `prompt()` rejects, as before.

## Truncated responses

When the model hits its output token limit (`stopReason: 'length'`) while writing tool calls, their arguments may be cut off, so the tools are not run. Like pi, each call gets an error result telling the model the response was truncated and to re-issue the call with complete arguments, and the loop continues.

## Context overflow

The size estimate can be wrong. When the provider rejects a request because the context is too long (recognized with pi's list of provider error messages, for example Anthropic's `prompt is too long`), Vela summarizes the history like `/compact` (`compaction_start` / `compaction_end` with `reason: 'overflow'` and `willRetry: true`) and sends the same step again, once, like pi. If it overflows again, or there is nothing to summarize, the run fails with the provider's error.

## Prompt caching

With Anthropic models, Vela marks the system prompt, the last tool definition and the last message as cache breakpoints (`cache_control: ephemeral`, the default 5-minute cache), like pi. Each request then reads the prefix the previous one wrote; `/usage` shows the cache hit rate. Other providers ignore the markers (OpenAI caches automatically).

## Usage

Every model request records input, output, cache-read and cache-write tokens and, when the price is known, a cost. The price comes from the model entry's `cost` in `models.json`, otherwise from a small built-in table of common models; a model in neither has no cost, so Vela shows its tokens without a dollar amount. Set `cost` for such a model to see its cost (see [Models](models.md#model-fields)).

- `/usage` shows the session's totals, cache hit rate, the cost and what it would have cost without caching. The cost lines only appear when at least one request had a known price.
- `/context` shows how the context window is filled: system prompt, tool definitions, memory, the skills index and messages, plus the autocompact buffer, the part of the window above `summaryThreshold`.
- The footer in interactive mode shows the current context estimate as a percentage of the window.
- `session.usage` in the SDK returns `{ tokens, percent, needsAction, totals }`.
- Each request is appended to `<dataDir>/usage/today.jsonl`.

`usage` events carry the same numbers per request. See [SDK](sdk.md#events).
