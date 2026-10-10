# Vela

Vela is an AI agent you can run in your terminal or embed in a TypeScript app.

Give it a task and a working folder, and it reads files, runs commands, edits code and fetches web pages until the task is done. The same agent is a small SDK: open as many sessions as you need in one process, subscribe to their events, and connect them to chat apps through channels. Extend it with plain TypeScript [extensions](docs/extensions.md) that add tools, slash commands, model providers and channels, or connect [MCP servers](docs/mcp.md).

Vela's design follows [pi](https://github.com/earendil-works/pi): the same agent loop with no turn limit, and pi's CLI modes, keybindings and RPC command names, with some differences (see [RPC mode](docs/rpc.md#differences-from-pi)). It adds concurrent sessions, session roles for untrusted senders, and built-in memory and knowledge base extensions.

## Getting started

Vela needs Node.js 22.18 or newer, or Bun 1.4 or newer.

```bash
npm install -g @glows777/vela
```

Set an API key for an OpenAI-compatible or Anthropic model, then start Vela in the folder you want it to work in:

```bash
export ANTHROPIC_API_KEY=...
cd /path/to/project
vela --model anthropic/<model-id>
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

// Built-in openai / anthropic providers plus ~/.vela/models.json, keys from the environment
const { providers } = loadConfig({ env: process.env })

const vela = createVela({ model: 'anthropic/<model-id>', providers, cwd: process.cwd() })
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

## Development

```bash
git clone https://github.com/glows777/Vela
cd Vela
bun install
VELA_MODEL=mock bun run start
bun run test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the checks to run before a pull request.

## License

[MIT](LICENSE)
