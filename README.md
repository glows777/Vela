# Vela

Vela is an AI coworker for your team's group chats, built on a terminal agent and TypeScript SDK.

Add Vela to a group chat and it works like a teammate: it answers short questions in the group, opens a topic for each larger task, keeps the topic's progress card up to date, remembers what the group told it and can wake itself on a schedule. Chat platforms plug in through a standard [channel](docs/channels.md) interface; Lark (Feishu) ships built in. Run `vela serve` on a machine you trust and enable the chats you want it in.

Underneath is a general agent you can also use on its own. Give it a task and a working folder, and it reads files, runs commands, edits code and fetches web pages until the task is done. Use it in your terminal, script it with JSON or RPC mode, or embed it as an SDK that runs many sessions in one process. Extend it with plain TypeScript [extensions](docs/extensions.md) that add tools, slash commands, model providers and channels, or connect [MCP servers](docs/mcp.md).

The CLI and SDK follow [pi](https://github.com/earendil-works/pi): the same agent loop with no turn limit, and pi's CLI modes, keybindings and RPC command names, with some differences (see [RPC mode](docs/rpc.md#differences-from-pi)). Vela adds concurrent sessions, a standard channel interface with enabled-chat lists, per-chat `tools`, per-session `permissions`, and built-in memory and knowledge base extensions.

## Getting started

Vela needs Node.js 22.18 or newer, or Bun 1.4 or newer.

```bash
npm install -g @glows777/vela
```

Run Vela in the folder it should work in:

```bash
cd /path/to/project
vela
```

On first run the setup wizard asks for a provider and how to sign in, lets you select a model, sends one small verification request (it may incur a charge) and asks for a thinking level. It then offers **Connect Lark**; choose **Not now** here and connect the bot in the next step. When the wizard finishes, Vela opens the terminal UI; leave it with Ctrl+D on an empty editor before running the next command. Run `vela setup` to change the model or sign-in later.

Connect a Lark group. Create a custom app first as described in [Channels](docs/channels.md#lark), then run:

```bash
vela setup lark
```

The wizard asks for the App ID and App Secret, checks them against Lark, then waits while you mention the bot in the group. Confirm the group to enable it. **Every member of an enabled group has full access to Vela's tools.**

Run the bot:

```bash
vela serve
```

It keeps the configured channels running without a terminal until Ctrl+C, and writes one line per message, reply and error to stderr. To keep it running after the shell closes, follow [Deploy `vela serve`](docs/deploy.md).

No API key yet? `VELA_MODEL=mock vela` runs a built-in offline demo model. See the [quickstart](docs/quickstart.md) for every setup screen and for manual provider configuration.

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

## Use it from the terminal

Vela is also an agent in the folder you start it in: ask for a task and it reads files, runs commands and edits code until it is done, showing each tool call. Run it non-interactively with `-p`, or pipe input in:

```bash
vela -p "List the TODOs in src/"
git diff | vela -p "Review this change"
```

See [CLI](docs/cli.md) for flags, run modes and keys.

## Documentation

- [Quickstart](docs/quickstart.md)
- Using the CLI: [CLI](docs/cli.md), [settings](docs/settings.md), [models](docs/models.md), [tools](docs/tools.md), [sessions](docs/sessions.md)
- Automating: [JSON mode](docs/json.md), [RPC mode](docs/rpc.md)
- Serving chats: [channels](docs/channels.md), [deploy `vela serve`](docs/deploy.md) under a dedicated user with systemd
- Building on Vela: [SDK](docs/sdk.md), [extensions](docs/extensions.md), [built-in extensions](docs/built-in-extensions.md), [MCP servers](docs/mcp.md), [channel reference](docs/channels-reference.md), [testing](docs/testing.md), [session format](docs/session-format.md)
- [Security](docs/security.md): Vela runs tools with your permissions and has no sandbox. Read this before running it on untrusted input.

## Packages

Vela is a Bun workspace of six npm packages under [`packages/`](packages/). Most people only need `@glows777/vela`, which ships the CLI and re-exports the SDK.

| Package | What it contains |
| --- | --- |
| [`@glows777/vela`](packages/vela) | The `vela` CLI, TUI and `vela serve`, plus SDK and testing re-exports |
| [`@glows777/vela-core`](packages/core) | The SDK (`createVela`), the extension API, offline testing helpers and the light built-in extensions (memory, todo, web, permission-gate) |
| [`@glows777/vela-channels`](packages/channels) | The standard channel interface and the channel runtime (group triage, topics, routines) |
| [`@glows777/vela-lark`](packages/lark) | The Lark (Feishu) channel adapter |
| [`@glows777/vela-mcp`](packages/mcp) | The MCP extension |
| [`@glows777/vela-rag`](packages/rag) | The knowledge base (RAG) extension with SQLite vector storage |

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
