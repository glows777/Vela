# Changelog

All notable changes to `@glows777/vela` are listed here. While Vela is on 0.x, a release that breaks the public API bumps the minor version and lists the break under **Breaking Changes** with how to migrate; patch releases don't break anything. See [API stability](docs/sdk.md#api-stability) for what counts as public.

## [Unreleased]

### Breaking Changes

- **Events now have pi's shape.** `message` is replaced by `message_start` / `message_end`; `text_delta` and `thinking_delta` by `message_update` (`assistantMessageEvent.type` is `text_delta` / `thinking_delta` and the text is in `delta`, alongside `text_start` / `text_end`, `thinking_start` / `thinking_end` and `toolcall_start` / `toolcall_delta` / `toolcall_end`); `tool_call` by `tool_execution_start` (`input` is now `args`); `tool_result` and `tool_error` by `tool_execution_end` (`output` / `error` is now `result`, with `isError` and `durationMs`); `retry` by `auto_retry_start` (`maxRetries` → `maxAttempts`, `error` → `errorMessage`) and the new `auto_retry_end`. `turn_end` has `message` and `toolResults` instead of `needsToolCall`; `agent_end` adds `messages`. The assistant `message_end` carries `stopReason` (`stop`, `toolUse`, `length`, `aborted`, `error`) and `errorMessage`. `--mode json`, `--mode rpc` and SDK subscribers see the new events. To migrate, print `message_update` events whose `assistantMessageEvent.type` is `text_delta`, and read final messages from `message_end`. See [SDK events](docs/sdk.md#events) and [JSON mode](docs/json.md). The extension `tool_call` / `tool_result` interception events are unchanged.
- **`bash` has no default timeout** (same as pi). The model passes an optional `timeout` in seconds instead. `limits.bashTimeoutMs` is removed; setting it in `settings.json` or `createVela({ limits })` is now an "unknown key" error. Remove the key.
- **`edit_file` takes pi's parameters**: `{ path, edits: [{ oldText, newText }] }` instead of `old_string` / `new_string`. A text that is not found, found more than once or overlapping another edit is now a tool error instead of a successful result describing the problem. Faux scenarios that call `edit_file` need the new arguments.
- **`ToolDefinition.isConcurrencySafe` is replaced by `executionMode`** (`'parallel'`, the default, or `'sequential'`, same as pi). Drop `isConcurrencySafe: true`; replace `isConcurrencySafe: false` with `executionMode: 'sequential'` if the tool must not run alongside the session's other calls.

### Fixed

- A response cut off by the output token limit while calling tools no longer breaks the session (every later prompt failed with `AI_InvalidPromptError`): like pi, each truncated call gets an error result asking the model to re-issue it. See [Sessions](docs/sessions.md#truncated-responses).
- An aborted or failed turn keeps what it produced: the streamed text and finished tool calls stay in the history, each call paired with its result or `Operation aborted`. Before, the whole step was dropped and the model didn't know a tool had already run. See [Sessions](docs/sessions.md#interrupted-and-failed-turns).
- A request that already started running tools is no longer sent again after an error, so tools don't run twice.
- When a request is retried, the interactive mode keeps the failed attempt's text marked `(response failed)` and shows the retry as a new message, instead of appending the retry to the old text.

### New Features

- **Context overflow recovery**: when the provider says the context is too long, Vela summarizes the history once and sends the step again, like pi (`context` event with `action: 'overflow'`). See [Sessions](docs/sessions.md#context-overflow).
- **Anthropic prompt caching**: the system prompt, last tool and last message are sent as cache breakpoints, like pi. See [Sessions](docs/sessions.md#prompt-caching).
- **Automated releases**: `bun run release <patch|minor|x.y.z>` tags a release, and CI publishes it to npm with provenance and creates the GitHub release from this changelog.
- `edit_file` applies several disjoint edits in one call, falls back to fuzzy matching (trailing whitespace, smart quotes, Unicode dashes and spaces), keeps BOM and CRLF line endings, and records a diff and unified patch in the tool history. Ported from pi.
- `shellPath` setting and `createVela({ shellPath })` choose the shell of the `bash` tool.
- `withFileMutationQueue(path, fn)` is exported for extension tools that write files.

### Changed

- Tools no longer share one lock across all sessions: `write_file` / `edit_file` queue per file, `bash` takes no lock, and a `sequential` tool only waits for calls in its own session. A long `bash` in one session no longer holds back other sessions (including channel senders).
- `bash` returns the last 2,000 lines or 50KB of output (was the last 3,000 characters) and ends with `Command exited with code N`, `Command timed out after N seconds` or `Command aborted` instead of `exit=N`.
- `read_file` pages default to 2,000 lines and at most 50KB (was 200 lines and 8,000 characters).

## [0.1.0] - 2026-10-09

First public release.

### New Features

- **Embeddable agent SDK**: `createVela()` assembles the model, tools, system prompt and extensions; `vela.session(id)` opens independent sessions that can run at the same time in one process. Sessions stream typed events, accept `steer` and `followUp` messages while running, and can switch model and thinking level between prompts. See [SDK](docs/sdk.md).
- **Terminal agent**: the `vela` command runs an interactive TUI built on pi-tui, a print mode (`-p`, piped stdin), a JSON event stream (`--mode json`) and a JSONL RPC mode (`--mode rpc`), plus `--help` and `--version`. See [CLI](docs/cli.md), [JSON mode](docs/json.md) and [RPC mode](docs/rpc.md).
- **pi-style extensions**: an extension is a function that registers tools, slash commands, model providers and channels and handles agent events. The CLI loads `.ts` extensions on Bun and on Node 22.18+ through Node's type stripping. See [Extensions](docs/extensions.md).
- **Built-in extensions**: cross-session memory, a RAG knowledge base (sqlite-vec + FTS5 hybrid search), web fetch and search, and a Feishu channel. See [Built-in extensions](docs/built-in-extensions.md) and [Channels](docs/channels.md).
- **Models and settings**: built-in `openai` and `anthropic` providers, more providers through `~/.vela/models.json`, thinking levels, and user and project `settings.json`; project settings, extensions and skills load only after you trust the project. See [Models](docs/models.md) and [Settings](docs/settings.md).
- **Long sessions**: tool result truncation, microcompaction and LLM summary compaction, loop detection, retries with backoff, and token and cost tracking (models with no known price show tokens only). Sessions are saved as versioned checkpoints. See [Sessions](docs/sessions.md) and [Session format](docs/session-format.md).
- **Offline testing**: `@glows777/vela/testing` provides a scripted faux model, a faux embedder, `createTestVela()`, and recording and replay of real runs; the CLI also has an offline demo model (`VELA_MODEL=mock`). See [Testing](docs/testing.md).
- **Session roles**: `owner`, `collaborator` and `guest` limit which tools a session can use, so channel senders don't get access to the machine; per-session `permissions` can only make a role stricter. Channels give each sender one session per conversation. See [Security](docs/security.md).
