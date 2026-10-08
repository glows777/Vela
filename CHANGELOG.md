# Changelog

All notable changes to `@glows777/vela` are listed here. While Vela is on 0.x, a release that breaks the public API bumps the minor version and lists the break under **Breaking Changes** with how to migrate; patch releases don't break anything. See [API stability](docs/sdk.md#api-stability) for what counts as public.

## [0.1.0] - Unreleased

First public release.

### New Features

- **Embeddable agent SDK**: `createVela()` assembles the model, tools, system prompt and extensions; `vela.session(id)` opens independent sessions that can run at the same time in one process. Sessions stream typed events, accept `steer` and `followUp` messages while running, and can switch model and thinking level between prompts. See [SDK](docs/sdk.md).
- **Terminal agent**: the `vela` command runs an interactive TUI built on pi-tui, a print mode (`-p`, piped stdin), a JSON event stream (`--mode json`) and a JSONL RPC mode (`--mode rpc`). See [CLI](docs/cli.md), [JSON mode](docs/json.md) and [RPC mode](docs/rpc.md).
- **pi-style extensions**: an extension is a function that registers tools, slash commands, model providers and channels and handles agent events. The CLI loads `.ts` extensions on Bun and on Node 22.18+ through Node's type stripping. See [Extensions](docs/extensions.md).
- **Built-in extensions**: cross-session memory, a RAG knowledge base (sqlite-vec + FTS5 hybrid search), web fetch and search, Supabase and a Feishu channel. See [Built-in extensions](docs/built-in-extensions.md) and [Channels](docs/channels.md).
- **Models and settings**: built-in `openai` and `anthropic` providers, more providers through `~/.vela/models.json`, thinking levels, and user and project `settings.json` with project trust. See [Models](docs/models.md) and [Settings](docs/settings.md).
- **Long sessions**: tool result truncation, microcompaction and LLM summary compaction, loop detection, retries with backoff, and token and cost tracking. Sessions are saved as versioned checkpoints. See [Sessions](docs/sessions.md) and [Session format](docs/session-format.md).
- **Offline testing**: `@glows777/vela/testing` provides a scripted faux model, a demo model, and recording and replay of real runs. See [Testing](docs/testing.md).
- **Session roles**: `owner`, `collaborator` and `guest` limit which tools a session can use, so channel senders don't get access to the machine. See [Security](docs/security.md).
