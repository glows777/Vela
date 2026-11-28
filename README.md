# Vela

Vela is a self-hosted AI coworker for your team's group chats. You run it on your own machine with the model you choose; Lark ships built in. It is built on a terminal agent and TypeScript SDK.

Add Vela to a group chat and it works like a teammate: it answers short questions in the group, opens a topic for each larger task, keeps the topic's progress card up to date, remembers what the group told it and can wake itself on a schedule. Chat platforms plug in through a standard [channel](docs/channels-reference.md) interface; Lark (Feishu) ships built in. Configure your model and channels on a machine you trust and enable the chats you want it in.

Underneath is a general agent you can also use on its own. Give it a task and a working folder, and it reads files, runs commands, edits code and fetches web pages until the task is done. Use it in your terminal, script it with JSON mode, connect over the local daemon socket with `connectRuntime()`, or embed it as an SDK that runs many sessions in one process. Extend it with plain TypeScript [extensions](docs/extensions.md) that add tools, slash commands, model providers and channels, or connect [MCP servers](docs/mcp.md).

The CLI and SDK follow [pi](https://github.com/earendil-works/pi): the same agent loop with no turn limit, and pi's CLI modes and keybindings. Vela adds concurrent sessions, a resident single-writer daemon (`vela daemon`), a standard channel interface with enabled-chat lists, per-chat and per-session `tools`, and built-in memory and knowledge base extensions.

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

Start the background daemon:

```bash
vela daemon start
```

It runs as the single-writer local daemon on `<VELA_DIR>/vela.sock`. To run it under a service manager such as systemd, follow [Deploy `vela daemon`](docs/deploy.md).

No API key yet? `VELA_MODEL=mock vela` runs a built-in offline demo model. See the [quickstart](docs/quickstart.md) for every setup screen and for manual provider configuration.

## Use the SDK

```bash
npm install @glows777/vela
```

```ts
import { createRuntime, loadConfig } from '@glows777/vela'

// Built-in anthropic / openai / openrouter / deepseek providers plus ~/.vela/config.json
const { providers, credentials } = loadConfig({ env: process.env })

const runtime = createRuntime({
  defaultModel: 'anthropic/claude-opus-4-8',
  providers,
  credentials,
  hostEnv: process.env,
})
await runtime.ready()
const project = await runtime.projects.create({ name: 'main', cwd: process.cwd(), hubSessionId: true })
const sessionId = project.hubSessionId!

const off = runtime.events.subscribeDeltas((delta) => {
  if (delta.sessionId === sessionId && delta.type === 'text_delta')
    process.stdout.write(delta.delta)
})
await runtime.prompt(sessionId, { text: 'Summarize the README in this folder' })
await runtime.waitForIdle(sessionId)
off()
await runtime.dispose()
```

The SDK reads no environment variables by default (`hostEnv` defaults to `{}`). Pass `ephemeral: true` for an in-memory SQLite runtime whose temporary directory is deleted by `dispose()`. See the [SDK docs](docs/sdk.md) and the runnable [examples](examples/).

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
- Automating: [JSON mode](docs/json.md), [SDK](docs/sdk.md) (`connectRuntime()`, `createRuntime()`)
- Serving chats & background service: [channels](docs/channels.md), [deploy `vela daemon`](docs/deploy.md) under a dedicated user with systemd
- Building on Vela: [SDK](docs/sdk.md), [extensions](docs/extensions.md), [built-in extensions](docs/built-in-extensions.md), [MCP servers](docs/mcp.md), [channel reference](docs/channels-reference.md), [testing](docs/testing.md), [session format](docs/session-format.md)
- [Security](docs/security.md): Vela runs tools with your permissions and has no sandbox. Read this before running it on untrusted input.

## Packages

Vela publishes a single npm package, [`@glows777/vela`](packages/vela) (alongside the private Electron desktop workspace under [`apps/desktop`](apps/desktop)).

| Package | What it contains |
| --- | --- |
| [`@glows777/vela`](packages/vela) | The `vela` CLI, TUI, `vela daemon`, Runtime SDK (`createRuntime`, `connectRuntime`, daemon lifecycle, `createLarkChannelAdapter`, config & auth helpers), `@glows777/vela/extension-api`, `@glows777/vela/testing`, and built-in daemon/runtime capabilities |

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
