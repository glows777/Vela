# Vela

Vela is an AI coworker for your team's group chats, built on a terminal agent and TypeScript SDK.

Add Vela to a Lark (Feishu) group and it works like a teammate: it answers short questions in the group, opens a topic for each larger task, keeps the topic's progress card up to date, remembers what the group told it and can wake itself on a schedule. Run `vela serve` on a machine you trust and enable the chats you want it in. See [channels](docs/channels.md) for the setup.

Underneath is a general agent you can also use on its own. Give it a task and a working folder, and it reads files, runs commands, edits code and fetches web pages until the task is done. Use it in your terminal, script it with JSON or RPC mode, or embed it as an SDK that runs many sessions in one process. Extend it with plain TypeScript [extensions](docs/extensions.md) that add tools, slash commands, model providers and channels, or connect [MCP servers](docs/mcp.md).

The CLI and SDK follow [pi](https://github.com/earendil-works/pi): the same agent loop with no turn limit, and pi's CLI modes, keybindings and RPC command names, with some differences (see [RPC mode](docs/rpc.md#differences-from-pi)). Vela adds concurrent sessions, a standard channel interface with enabled-chat lists, per-chat `tools`, per-session `permissions`, and built-in memory and knowledge base extensions.

## Getting started

Vela needs Node.js 22.18 or newer, or Bun 1.4 or newer.

```bash
npm install -g @glows777/vela
```

Set an API key for Anthropic, OpenAI or OpenRouter (or run `/login` inside Vela), then start Vela in the folder you want it to work in:

```bash
export ANTHROPIC_API_KEY=...
cd /path/to/project
vela
```

No API key yet? `VELA_MODEL=mock vela` runs a built-in offline demo model. See the [quickstart](docs/quickstart.md) for the full setup.

Run it non-interactively with `-p`, or pipe input in:

```bash
vela -p "List the TODOs in src/"
git diff | vela -p "Review this change"
```

## Use the SDK

```bash
npm install @glows777/vela
```

```ts
import { createVela, loadConfig } from '@glows777/vela'

// Built-in anthropic / openai / openrouter providers plus ~/.vela/models.json, keys from ~/.vela/auth.json and the environment
const { providers, credentials } = loadConfig({ env: process.env })

const vela = createVela({ model: 'anthropic/claude-opus-4-8', providers, credentials, cwd: process.cwd() })
const session = vela.session('main')

session.subscribe((event) => {
  if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta')
    process.stdout.write(event.assistantMessageEvent.delta)
})
await session.prompt('Summarize the README in this folder')
await vela.dispose()
```

The SDK reads no environment variables and persists nothing unless you pass `dataDir`; temporary files are deleted by `dispose()`. See the [SDK docs](docs/sdk.md) and the runnable [examples](examples/).

## Documentation

- [Quickstart](docs/quickstart.md)
- Using the CLI: [CLI](docs/cli.md), [settings](docs/settings.md), [models](docs/models.md), [tools](docs/tools.md), [sessions](docs/sessions.md)
- Automating: [JSON mode](docs/json.md), [RPC mode](docs/rpc.md)
- Building on Vela: [SDK](docs/sdk.md), [extensions](docs/extensions.md), [built-in extensions](docs/built-in-extensions.md), [MCP servers](docs/mcp.md), [channels](docs/channels.md), [testing](docs/testing.md), [session format](docs/session-format.md)
- [Security](docs/security.md): Vela runs tools with your permissions and has no sandbox. Read this before running it on untrusted input.

## Packages

Vela is a Bun workspace of six npm packages under [`packages/`](packages/). Most people only need `@glows777/vela`, which ships the CLI and re-exports the SDK.

| Package | What it contains |
| --- | --- |
| [`@glows777/vela`](packages/vela) | The `vela` CLI, TUI and `vela serve`, plus SDK and testing re-exports |
| [`@glows777/vela-core`](packages/core) | The SDK (`createVela`), the extension API, offline testing helpers and the light built-in extensions (memory, web, permission-gate) |
| [`@glows777/vela-channels`](packages/channels) | The standard channel interface and the channel runtime (group triage, topics, routines) |
| [`@glows777/vela-lark`](packages/lark) | The Lark (Feishu) channel adapter |
| [`@glows777/vela-mcp`](packages/mcp) | The MCP extension |
| [`@glows777/vela-rag`](packages/rag) | The knowledge base (RAG) extension with SQLite vector storage |

Upgrading a Feishu deployment from 0.4 or earlier? Follow the [Lark migration guide](docs/lark-migration.md) first.

## Development

```bash
git clone https://github.com/glows777/Vela
cd Vela
bun install
bun run build
VELA_MODEL=mock bun run start
bun run test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the checks to run before a pull request.

## License

[MIT](LICENSE)
