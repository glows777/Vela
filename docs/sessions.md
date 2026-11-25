# Sessions and context

A session is one conversation: its message history, queued messages, compaction state, token usage, tool results and run lock. Like pi, Vela appends each message to the session file as it enters the history, so a crash loses at most the step in progress, and you can continue the session later. This page covers where sessions live, how to continue them, and how Vela keeps a long session within the model's context window.

For the API, see [SDK](sdk.md#sessions). For the file contents, see [Session format](session-format.md).

## Session ids and storage

Every session has an id (`sessions.id`). Ids use letters, digits, `.`, `_` and `-`, don't start with `.`, and are at most 128 characters.

- The CLI starts a new session on every launch with an id made from the local time and four random characters, such as `20261008-081441-da14`.
- Channel sessions get `<channel>-<conversationId>`, one shared session per chat (hashed when the ids have other characters). See [Channels](channels.md).
- In the SDK you choose the id: `vela.session('support-42')`. The default is `default`.

Vela persists active sessions in SQLite at `<dataDir>/vela.db` (`sessions`, `vela_messages`, `vela_tool_calls`, `runs`, `approvals`, `usage_records`), inside the [project data directory](settings.md#data-directory). Spilled long tool outputs for a session live under `<dataDir>/sessions/<id>/tool-results/`. Opening and closing an empty session leaves no rows in `vela.db`; `--no-session` (`ephemeralSessions: true`) uses an in-memory SQLite database (`:memory:`) and a temporary spill directory removed when the session closes. Memory and the knowledge base are unchanged.

Persistent session deletion is manual. Before deleting a session's rows from `vela.db` or removing `<dataDir>/sessions/<id>/`, record the exact session ID and the environments in its saved `location` metadata and branch entries. For each Docker environment the session used, match the container to that environment name and the same owner data directory. Inside that container, `~/.vela/uploads/<id>/` under the guest user's home is the cache for this session. A fork or clone has its own ID and cache.

The owner can retain or remove each matching guest directory as part of the same retention decision. Deleting the host session alone leaves these container caches in place. The canonical downloads belong to the chat's private `files/` directory and can be shared across topics. Archiving and closing a persistent session preserve its files.

In the SDK, sessions are stored in `<dataDir>/vela.db` when you pass `dataDir`, in memory (`:memory:`) when you don't, or in an explicitly shared `db` handle. See [SDK](sdk.md#session-storage).

## Continue or switch sessions

The CLI's `-c`, `-r`, `--session` and `--no-session` flags choose which session a run opens; see [CLI](cli.md#sessions). In print, JSON and RPC modes use `--session` or `-c`.

In interactive mode:

| Command | Effect |
|---|---|
| `/new` | Close this session and start a new one |
| `/resume` | Pick a saved session and switch to it |
| `/name [name]` | Show or set the session's display name, shown in the picker |
| `/tree` | Move to another point in the session (see [Session tree](#session-tree)) |
| `/fork` | Start a new session from before an earlier message of this one |
| `/clone` | Copy the current branch into a new session |
| `/export [path]` | Write the current branch as HTML, or as JSONL when the path ends in `.jsonl` |
| `/compact [focus]` | Compact the context now (see [Compaction](#compaction)) |
| `/status` | Show this session: CLI version, id, where it is saved (or that it is not written yet), model, context and token usage |
| `/context` | Show what fills the context window |
| `/usage` | Show this session's token usage, cache hit rate and cost |

In the SDK, `vela.session(id)` opens a session with an empty history; call `await session.resume()` to continue a saved one. Prompting a session whose id already has saved history without resuming it fails (`Session <id> already has saved history: call resume() to continue it, or use another session id`) rather than mixing two conversations in the database.

The picker lists sessions newest first by name (or first message), id, message count and time. Sessions with no messages are not listed. Archived sessions are left out (see below).

## Archive and search saved sessions

`vela.setSessionArchived(id, true)` takes a saved session out of `vela.listSessions()` and the interactive picker; `false` brings it back. The flag is persisted directly in SQLite (`sessions.archived`), so it survives a restart and no message is deleted. The session keeps its id and can still be opened and resumed by id; a fork or clone of it starts active. Archiving does not need the session to be opened.

`vela.searchSessions(text)` scans the user and assistant message text of saved sessions and returns `{ id, match }[]`, newest first: one hit per session, with a short excerpt around the first match. Tool output, `!` commands, summaries and extension messages are not searched. There is no index: every saved session is read once per search. Pass `{ includeArchived: true }` to search archived sessions too.

## Session tree

Like pi, a session is a tree: moving back to an earlier entry does not erase the branch you leave. The model sees only the current branch.

| Action | Result | Use it when |
|---|---|---|
| `/tree` | Moves within the same session file | Related alternatives should stay together |
| `/fork` | Creates a new session from before an earlier user message | The alternative should become separate work |
| `/clone` | Copies the current branch into a new session | You want a separate copy of the current state |

`/tree` lists the session's messages as a tree (indented where the conversation branches), with the current branch marked `•`, the current position `← current` and labels in brackets. Pick an entry, then:

- **No summary**: move there. Picking one of your messages puts its text back in the editor and moves to just before it; edit and send it to start a new branch. Picking any other entry continues after it with an empty editor.
- **Summarize the branch I leave** (or **with a focus**): the same, after summarizing the part of the current branch the move leaves (below the shared entry) with the [summary](#summary) model call. The summary is attached where you move and the model sees it as `[Summary of the conversation branch you left]`, so what was tried there is not lost.
- **Set a label**: bookmark the entry; an empty label clears it.

`/fork` lists every user message of the session; the new session holds the branch up to just before the one you pick, and its text goes into the editor. `/clone` copies the current branch. Both switch to the new session (with a new id) and record the original as its `parentSession`; the original is kept as it was. `--fork <id>` does the same before interactive (or print) mode starts, copying a saved session.

Moving in the tree only changes what the model sees. Files the abandoned branch changed and commands it ran are not undone (pi doesn't either), and its tool calls stay in the session's tool call history.

In the SDK these are `session.navigateTree(entryId, { summarize, focus, label })`, `session.fork(entryId, { position, sessionId })`, `session.clone()`, `session.setLabel()`, `session.getTree()`, `session.getBranch()` and `session.getLeafId()`. Unlike pi, whose fork replaces its one session, `fork()` and `clone()` open the copy as another session in the same Vela and leave the original open. See [SDK](sdk.md#session-tree). All of them refuse while the session is running.

## Export

`/export [path]` (`session.exportHtml(path)`, the `export_html` RPC command, `vela --export <id> [output]`) writes the current branch as a self-contained HTML page: user and assistant messages, thinking, tool calls and results (collapsed), summaries. It has no scripts and loads nothing; all session content is escaped. A path ending in `.jsonl` (`session.exportJsonl(path)`, or `vela --export <id> branch.jsonl`) writes the branch in the [session file format](session-format.md#forks-and-clones) instead. Relative paths resolve against the working directory; the default name is `vela-session-<id>-<time>`.

Review an export before you share it: it can contain your prompts, the model's answers, tool arguments, command output and file contents. Vela has no `/share` upload (pi's `/share` uploads to a gist).

## Multiple sessions

One Vela can run many sessions at once. They share tool definitions, extensions, skills, memory, the knowledge base and channels; each keeps its own history, queues, compaction, usage, tool results and run lock. This is a difference from pi, where one process holds one active session. A channel like Lark needs it: every chat gets its own shared session, and one slow conversation doesn't block the others. Messages in one chat are handled in order.

The CLI shows one session at a time; `vela serve` runs the channel sessions in its process instead. In the SDK, open as many as you need with `vela.session(id)`; see [03-multi-session.ts](../examples/sdk/03-multi-session.ts).

## Queueing: steer

A session runs one agent loop at a time. Input that arrives while it runs can be queued as a steering message:

| Mode | When it is sent | Interactive | SDK |
|---|---|---|---|
| steer | After the current tool call finishes, skipping remaining queued calls in the step before the next model request | Enter | `session.steer(text)` |

By default one queued message is taken at a time (`steeringMode` can be set to `all`). If the loop ends early (an error or loop detection), the remaining messages run in a new loop. After an abort the loop stops and the queue is kept.

In interactive mode the queue is shown above the editor. Alt+Up (macOS: Option+Up) moves queued messages back into the editor; Esc aborts the run and moves them back too.

`prompt()` in the SDK resolves only after the queue is drained and emits `agent_settled` last.

## Compaction

Before every model request, including requests that continue after tool calls, Vela measures the context and compacts when it gets too large. The size is the prompt + completion tokens the provider reported for the latest response plus a calibrated delta for active tool definitions, context-hook modifications, and messages added since (like pi). Until a provider reports usage, Vela estimates the whole request from the system prompt, tool definitions and messages (ASCII `0.25` tokens/char, CJK `1.2` tokens/char, other non-ASCII `0.5` tokens/char, excluding opaque `providerOptions` / encrypted reasoning).

### Summary

When the size reaches `summaryThreshold` and there is an earlier turn to summarize, Vela asks the model to summarize the earlier history:

1. It picks a split point at a user message, at least six messages from the end, where every tool call before it has its result.
2. It sends only the dropped messages, serialized as text in a `<conversation>` block, plus a `context_compaction` instruction. The instruction asks for a free-text checkpoint with Goal, Constraints & Preferences, Progress (Done / In Progress / Blocked), Key Decisions, Next Steps and Critical Context. The model synthesizes facts rather than selecting verbatim quotes.
3. In the context, the removed messages are replaced by one user message, `[Summary of the earlier conversation]`, followed by the summary. Code appends sorted, deduplicated `<read-files>` and `<modified-files>` lists from `read`, `write` and `edit` calls. A modified file appears only in the modified list; empty lists are omitted. Prior compacted calls and calls behind branch summaries are read from SQLite (`vela_tool_calls`) so the lists survive tree navigation, repeated compaction and resume.
4. Like pi, a `compaction` entry is appended to the session (summary and the first kept message); the summarized entries stay in `vela_messages`. `compaction_start` and `compaction_end` events (`reason: 'threshold'`) are emitted around it.

If there is no earlier turn to summarize, the request is still sent to the provider (if it exceeds the provider's window, the provider reports overflow).

If the summary fails (a provider error, empty or incomplete output, or tool calls), the turn stops with an error and the original history is kept. Nothing is lost; fix the cause (for example switch to a model with a larger window) and try again.

The summary request uses the same model and system prompt as the main request. It leaves out the retained messages. It sends no tool definitions. It does not add `cache_control` breakpoints. It does not reuse the main request's prompt cache. It uses the model's `maxTokens` output limit when known; otherwise the provider chooses its output limit. Compaction thresholds only decide when to summarize. Its token usage is recorded with `kind: 'summary'`.

### Manual compaction

`/compact [focus]` in interactive mode, `session.compact(focus)` in the SDK and the `compact` RPC command summarize now, whatever the thresholds. `focus` tells the summary what to preserve. It emits `compaction_start` / `compaction_end` with `reason: 'manual'`. It can't run while the session is running. When there is no earlier turn to summarize (an empty or short session: the split must be at a user message that is not the first message, with at least six messages from it to the end and every earlier tool call answered), it fails with `Nothing to compact (session too small)`, as in pi.

### Turning automatic compaction off

Like pi's `compaction.enabled`, automatic compaction can be turned off: set `"autoCompaction": false` in [settings](settings.md), pass `autoCompaction: false` to `createVela()` or `vela.session()`, set `session.autoCompaction = false`, or send the `set_auto_compaction` RPC command. Then nothing changes the context on its own: no threshold summary and no compact-and-retry when the provider reports a context overflow (the provider's error is reported as is). `/compact` still works.

### Thresholds and context window

The token thresholds are `summaryThreshold` and `maxInputTokens`. Their defaults match a 200k window; when the model entry has a `contextWindow`, they are derived from it and recomputed when you switch models. Values set in the `limits` setting or the `limits` option of `createVela()` always win. See [Settings](settings.md#limits) for the defaults and formulas.

## Long tool output

A tool result longer than the tool's line limit (200 lines for `grep` and `find`, 500 lines by default and for web tools; `read` pages and `bash` previews have their own limits; see [Tools](tools.md#result-size-and-truncation)) is saved in full to `<dataDir>/sessions/<id>/tool-results/<callId>.txt`. The model gets the head up to the limit, followed by one line with the file path and a hint to page through the rest with `read` and `offset`. Bash keeps its existing tail preview, with the file path only when truncated.

Every tool call and its result is also recorded in SQLite (`vela_tool_calls` in `<dataDir>/vela.db`), which survives compaction. See [Session format](session-format.md#tool-call-history).

Vela doesn't expire tool results by age: content changes only through compaction summaries when reached.

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

With Anthropic models, Vela marks the system prompt, the last tool definition and the last message as cache breakpoints (`cache_control: ephemeral`, the default 5-minute cache), like pi. Each model request in the agent loop then reads the prefix the previous one wrote. The summary request does not add these breakpoints. `/usage` shows the cache hit rate. Other providers ignore the markers (OpenAI caches automatically).

The memory index and the RAG source list are sent as messages after the user message, so changing them appends to the prefix instead of rewriting the system prompt. The system prompt names no git branch. A checkout in the session's working tree would rewrite the whole prefix, so the model reads the branch with `git branch --show-current` when it needs it, as pi does. The system prompt also names no date, time of day or timezone. Those facts used to sit in `<env>`. The first request after midnight rewrote the cached prefix. `<env>` names the operating system and the shell, which stay put for the session. Pi's prompt has no `<env>` section. Vela keeps this one because those two facts do not change during a session. The model reads the clock with `date` when it needs it. Loading a deferred tool with `tool_search` adds a tool definition and a `<tools>` line at the top of the request, which invalidates the cached prefix once. This is accepted rather than engineered away. A channel's system prompt is fixed per session kind, and each input carries its own kind: an untagged group message starts with a short marker in the text the model receives instead of changing the section.

## Usage

Every model request records input, output, cache-read and cache-write tokens and, when the price is known, a cost. The price comes from the model entry's `cost` under `providers` in `config.json`, otherwise from a small built-in table of common models; a model in neither has no cost, so Vela shows its tokens without a dollar amount. Set `cost` for such a model to see its cost (see [Models](models.md#model-fields)).

- `/status` shows a short overview: the CLI version, session id and file (not written yet until the first save; in-memory when the session is not saved; custom storage when the location is not reported), working directory, model, thinking level, message count, the context estimate and this session's token usage. The dollar amount matches the footer. A channel session also shows its channel, and a fork shows the session it was copied from. Paths under your home directory are shown with `~`, and paths under the configured agent directory (`VELA_DIR`, or `~/.vela`) with `$VELA_DIR`. The Path line is fitted to the terminal's display columns, so a session id is not broken across lines. An unsaved session keeps `not written yet` even when the destination is too long to show.
- `/usage` shows the session's totals, cache hit rate, the cost and what it would have cost without caching. The cost lines only appear when at least one request had a known price.
- `/context` shows how the context window is filled: system prompt, tool definitions, memory, the skills index and messages, plus the autocompact buffer, the part of the window above `summaryThreshold`.
- The footer in interactive mode shows the current context estimate as a percentage of the window.
- `session.usage` in the SDK returns `{ tokens, percent, needsAction, totals }`.
- Each request records input, output, cache-read, cache-write tokens and cost in `usage_records` in `<dataDir>/vela.db`. `--no-session` keeps the same totals in memory without persisting to disk.

`usage` events carry the same numbers per request. See [SDK](sdk.md#events).
