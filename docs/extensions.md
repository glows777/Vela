# Extensions

Extensions are TypeScript or JavaScript modules that add behavior to Vela: tools the model can call, `/` commands, model providers, message channels, and handlers that watch or change what the agent does.

An extension runs inside the Vela process with the same permissions as the user who started it. It can read files, call the network, see every prompt and tool call, and change tool input and output. Vela does not sandbox extensions. Load only extensions you trust; see [Security](security.md).

The built-in memory, knowledge base, web and Feishu features are extensions too; see [Built-in extensions](built-in-extensions.md).

## Create and load an extension

An extension is a module whose default export is a function that receives the extension API. Put it in `~/.vela/extensions/hello.ts`:

```ts
import type { VelaExtension } from '@glows777/vela'

const hello: VelaExtension = (vela) => {
  vela.registerCommand('hello', {
    description: 'Show a greeting',
    handler: (name, ctx) => {
      ctx.ui.notify(`Hello, ${name || 'world'}!`)
    },
  })
}

export default hello
```

Start `vela` and run `/hello`. During development, load a file directly:

```bash
vela -e ./hello.ts
```

There is no build step. Bun imports `.ts` files directly, and Node strips the types (see [TypeScript on Node](#typescript-on-node)).

The factory can be synchronous or `async`. It runs once per Vela instance, not once per session: everything it registers is shared by all sessions, and handlers find out which session fired an event from `ctx.session`. Only register things in the factory. Start long-lived resources (processes, sockets, timers) in a `session_start` handler or a channel's `start()`, and release them in `session_shutdown` or `stop()`.

## Where extensions load from

The CLI loads extensions in this order:

1. Built-in extensions (`memory`, `rag`, `web`, `feishu`). All are on by default.
2. `~/.vela/extensions/` (or `$VELA_DIR/extensions/`).
3. `<cwd>/.vela/extensions/`, only when the project is trusted (see [Project trust](settings.md#project-trust)).
4. Paths listed in the `extensions` array of `settings.json`, user settings before project settings.
5. `-e, --extension <path>` on the command line (repeatable).

In a discovered directory, each `*.ts`, `*.js` or `*.mjs` file is one extension (`*.d.ts` is skipped), and each subdirectory with an `index.ts`, `index.js` or `index.mjs` is one extension. A directory that itself has an index file is a single extension. A file loaded twice (for example discovered and also passed with `-e`) loads once. The auto-discovered directories may be missing.

`settings.json` entries are resolved relative to the settings file, and `~` expands to the home directory. A missing path is a config error. The same array turns built-ins on and off:

```json
{
  "extensions": ["./extensions/deploy.ts", "-builtin:web", "-builtin:feishu"]
}
```

| Entry | Meaning |
|---|---|
| `path/to/file.ts` | Load this `.ts`, `.js` or `.mjs` file |
| `path/to/dir` | Load the directory as one extension if it has an index file, otherwise each extension found in it (as for discovered directories) |
| `-builtin:<name>` | Do not load this built-in |
| `builtin:<name>` or `+builtin:<name>` | Load this built-in again, for example in a project after the user settings disabled it |

The `builtin:` switches apply in order, user settings first, so a project can re-enable what the user disabled and the other way round. An unknown built-in name is a config error.

`--no-extensions` (or `-ne`) skips built-ins, discovered extensions and those listed in settings. Extensions passed with `-e` still load, and `-e builtin:<name>` loads a single built-in:

```bash
vela --no-extensions -e builtin:memory -e ./hello.ts
```

When an extension fails to import or its factory throws, the CLI prints `[extensions] Failed to load <path>: <error>` to stderr and starts without it. Tools and commands it registered before failing stay registered. (The SDK is stricter: a synchronous throw makes `createVela()` throw, and a failed async factory makes `vela.ready()` and `prompt()` reject.)

`/extensions` in interactive mode lists loaded extensions with their tools, commands and channels. See [CLI](cli.md) and [Settings](settings.md) for the full flag and settings reference.

### Extension name

Every extension has a name. It sets the prefix of its tool names and selects its config section.

- CLI: the file name without its extension (`hello-tool.ts` is `hello-tool`), or the directory name for `index.ts` files (`deploy/index.ts` is `deploy`).
- SDK: the function's `name` (`const hello: VelaExtension = ...` is `hello`); an anonymous function becomes `extension-1`, `extension-2`, and so on, by position.

### TypeScript on Node

On Bun any TypeScript works. On Node (>= 22.18) the CLI imports the file and Node strips the types natively, which has limits:

- Only erasable syntax works. `enum`, `namespace` with values, constructor parameter properties (`constructor(private x: T)`) and other syntax that generates code fail with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Use plain objects, union types and explicit fields.
- Node does not strip types in files under `node_modules`. Ship compiled `.js` in a package.
- Imports must resolve from the extension's own location. Import Vela's types with `import type { ... } from '@glows777/vela'`; the import is erased and works anywhere. A value import (`import { createVela } from '@glows777/vela'`) or a third-party import such as `zod` needs that package installed where the extension can resolve it, for example a `package.json` and `node_modules` next to the extension. This applies on Bun too.

## The extension API

The factory's argument (`vela` below) is an `ExtensionAPI`:

| Member | What it is |
|---|---|
| `vela.cwd` | Working directory for tools |
| `vela.dataDir` | Vela's data directory for this project. Keep an extension's own files in `<dataDir>/<extension name>/` |
| `vela.config` | This extension's config section (see [Configuration](#configuration)); `{}` when none |
| `vela.logger` | Logger (`debug`, `info`, `warn`, `error`). In the CLI it goes to stderr, or to the chat log in interactive mode |
| `vela.registerTool(tool)` | Add a tool the model can call |
| `vela.registerCommand(name, command)` | Add a `/name` command |
| `vela.registerProvider(name, provider)` | Add a model provider |
| `vela.registerChannel(channel)` | Add a message channel |
| `vela.on(event, handler)` | Subscribe to an event. Returns a function that unsubscribes |

### registerTool

Example: [hello-tool.ts](../examples/extensions/hello-tool.ts)

```ts
import type { VelaExtension } from '@glows777/vela'
import { z } from 'zod'

const hello: VelaExtension = (vela) => {
  vela.registerTool({
    name: 'greet',
    description: 'Say hello to someone',
    inputSchema: z.object({ name: z.string().describe('Name') }),
    isConcurrencySafe: true,
    execute: async ({ name }: { name: string }) => `Hello, ${name}!`,
  })
}

export default hello
```

The model sees the tool as `<extension name>_<tool name>`: `greet` in `hello.ts` becomes `hello_greet`, and in `hello-tool.ts` it becomes `hello-tool_greet`. Characters other than letters, digits, `_` and `-` in the extension name become `_`. When the tool name equals the extension name, the prefix is not repeated (the memory extension's `memory` tool is just `memory`). The prefix means an extension cannot replace a built-in tool or another extension's tool; registering a name that already exists throws.

| Field | Description |
|---|---|
| `name` | Tool name before the prefix |
| `description` | What the model reads to decide when to call the tool |
| `inputSchema` | Zod schema, or any schema the AI SDK accepts (for example `jsonSchema(...)` from `ai`). Input is validated before `execute` |
| `execute(input, ctx)` | Runs the tool. `ctx.toolCallId` and `ctx.signal` (aborted when the session is interrupted or closed) are available. Return a string, or any value that is sent as JSON. Throw to report an error to the model |
| `isConcurrencySafe` | `true` lets calls run in parallel with other safe tools; otherwise the call takes an exclusive lock |
| `isReadOnly` | Marks a tool that does not change anything |
| `maxResultChars` | Results longer than this (default 3000) are saved to a file and the model gets a preview and the path to read the rest |
| `exposure` | `direct` (default) puts the tool in the tool list. `deferred` only names it in the system prompt; the model loads it with `tool_search` first |
| `searchHint` | Short hint shown next to a deferred tool's name |

Tools are shared by all sessions. The session's role and permissions decide which sessions can call them; a `guest` session cannot call extension tools, except `rag_search` and `web_search` from the built-in extensions (see [Security](security.md#session-roles)). See [Tools](tools.md) for the built-in tools.

### registerCommand

Example: [todo-command.ts](../examples/extensions/todo-command.ts)

```ts
vela.registerCommand('todo', {
  description: 'Add a todo; with no arguments, list todos',
  handler: (args, ctx) => {
    ctx.ui.notify(args ? `Added: ${args}` : 'No todos')
  },
})
```

`session.prompt('/todo buy milk')` runs the handler with `args` set to `buy milk` (the text after the name, trimmed) instead of sending the text to the model. Commands run immediately, even while the session is busy. Names must match `[A-Za-z0-9][\w-]*`; a name already registered by another extension throws.

Commands only run in `owner` sessions. In a `collaborator` or `guest` session (for example a channel sender), `/todo` is plain text for the model.

In interactive mode, Vela's own commands (`/model`, `/extensions`, ...) are checked first, so an extension cannot override them. Extension commands appear in autocomplete. In print mode, `vela -p "/todo buy milk"` runs the command. In RPC mode, send commands with the `prompt` command.

### registerProvider

Example: [local-provider.ts](../examples/extensions/local-provider.ts)

```ts
import { createOpenAI } from '@ai-sdk/openai'

vela.registerProvider('local', {
  models: [{ id: 'qwen3:8b', contextWindow: 40_960 }],
  createModel: (id) => createOpenAI({ baseURL: 'http://localhost:11434/v1', apiKey: 'ollama' }).chat(id),
})
```

After this, `local/qwen3:8b` works with `--model`, `/model`, `defaultModel` in settings, `createVela({ model })` and `session.setModel()`. `createModel(id)` returns an AI SDK `LanguageModel`; listed models carry metadata such as the context window, and unlisted ids still work. Provider names are not prefixed. Registering a name that already exists (including the built-in `openai` and `anthropic`, and providers from `models.json`) throws.

If you only need a different base URL or key for an OpenAI- or Anthropic-compatible service, edit `~/.vela/models.json` instead. See [Models](models.md).

### registerChannel

Example: [echo-channel.ts](../examples/extensions/echo-channel.ts)

A channel brings messages from outside (a chat app, a webhook) into Vela. Each sender gets their own session, and replies go back through the channel's `send()`.

```ts
vela.registerChannel({
  name: 'echo',
  description: 'In-memory demo channel',
  start: () => {},
  stop: () => {},
  send: async (message) => { /* deliver message.text to message.recipientId */ },
  onMessage: (handler) => { /* call handler(msg) for each incoming message */ },
  roleFor: (msg) => (owners.includes(msg.senderId) ? 'owner' : 'guest'),
})
```

`roleFor` decides each sender's role and is checked on every message. Without it every sender is a `guest`. The interactive CLI starts channels after startup; the SDK starts them with `vela.startChannels()`. See [Channels](channels.md).

### on

`vela.on(event, handler)` subscribes to an event. Handlers run in registration order, which is extension load order when factories register synchronously (an `async` factory's handlers registered after an `await` can come after later extensions'). The handler gets the event and a context (`ctx`, see [Context](#context)). It returns a function that removes the handler; removing a handler during a dispatch does not affect that dispatch.

Some events let a handler change what happens; the rest are notifications.

#### Intercepting events

| Event | When | What a handler can do |
|---|---|---|
| `session_start` | Before a session's first prompt, command or compaction, after its history is restored | Set up per-session state, for example `ctx.session.setActiveTools(...)`. Handlers are awaited in order |
| `before_agent_start` | At the start of each agent loop (normally once per `prompt()`), before the first model request | Write system prompt sections into `event.sections` (keyed by name). `event.prompt` is the user input |
| `tool_call` | Before a tool runs (any tool, built-in or extension) | Change `event.input` in place, or return `{ block: true, reason }` to block the call |
| `tool_result` | After a tool runs, before the model sees the result | Return `{ output }` to replace the text the model sees |
| `session_shutdown` | When a session that has started closes (`session.close()`, `vela.dispose()`, CLI exit); a session never used gets no `session_shutdown` | Release per-session resources. Handlers are awaited in order |

Details:

- `before_agent_start`: sections are computed once per agent loop (normally once per `prompt()`) and stay the same for every model request in that turn, which keeps the prompt cache prefix stable. Sections appear in the system prompt in the order they were written. Example: [prompt-section.ts](../examples/extensions/prompt-section.ts).
- `tool_call`: `event` has `toolName`, `toolCallId` and `input`. A changed input is validated against the tool's schema again; invalid input rejects the call. A handler that throws blocks the call (fail-safe). The first handler that blocks wins and later handlers do not run. The model sees `[Blocked by hook] <reason>`. Session permissions set to `ask` are checked after these handlers, on the final input. Example: [confirm-dangerous.ts](../examples/extensions/confirm-dangerous.ts).
- `tool_result`: `event` has `toolName`, `toolCallId`, `input` and `output` (the text the model will see; a preview for oversized results). Handlers chain: each sees the previous handler's output. A throwing handler is logged and skipped. Only the model's view changes; the tool history and saved full output keep the original. Example: [redact-secrets.ts](../examples/extensions/redact-secrets.ts).
- `session_start` / `session_shutdown`: errors are logged and the next handler runs. Example: [read-only-session.ts](../examples/extensions/read-only-session.ts).

#### Notification events

Every other session event (`agent_start`, `message`, `text_delta`, `usage`, `agent_end`, `context`, `channel_reply`, ...) is delivered to handlers as a notification: return values are ignored, async handlers are not awaited, and errors are logged. The `tool_call` and `tool_result` names refer to the intercepting events above. The event types and their fields are listed in [SDK](sdk.md#events).

## Context

Handlers and command handlers receive a context as their second argument:

| Field | Description |
|---|---|
| `ctx.session` | The session that fired the event: `id`, `role`, `name`, `model`, `messages`, `getActiveTools()`, `setActiveTools(names)`, `setModel()`, `prompt()`, ... (see [SDK](sdk.md)) |
| `ctx.ui` | How to talk to the user (below) |
| `ctx.hasUI` | Whether `confirm`, `select` and `input` can actually ask someone |
| `ctx.cwd` | Working directory |
| `ctx.signal` | Abort signal of the running turn; `undefined` when the session is idle. In a command handler it is the command's own signal |

`ctx.session.setActiveTools(names)` limits the tools of that one session (still within its role); `undefined` restores all. Unknown names are ignored. `ctx.session.role` is `owner`, `collaborator` or `guest`; check it before doing something a guest should not trigger.

### ctx.ui

| Method | Interactive | RPC | No UI (SDK without `ui`, `-p`, `--mode json`, channel sessions) |
|---|---|---|---|
| `notify(message, level?)` | Shown in the chat log | `extension_ui_request` | Emitted as a `notify` event; `-p` prints it to stderr |
| `confirm(title, message)` | Yes/no dialog | Request, the client answers | Returns `false` |
| `select(title, options)` | Selection list | Request, the client answers | Returns `undefined` |
| `input(title, placeholder?)` | Text input | Request, the client answers | Returns `undefined` |
| `setStatus(key, text?)` | Footer entry; empty text clears it | Sent to the client | Does nothing |
| `setWidget(key, lines?)` | Lines above the editor; empty clears them | Sent to the client | Does nothing |

`level` is `info` (default), `warning` or `error`. Because `confirm` returns `false` without a UI, a guard written as "block unless confirmed" blocks in print mode and in channel sessions. See [RPC](rpc.md) for the `extension_ui_request` / `extension_ui_response` protocol. SDK users pass a UI with `vela.session(id, { ui })`.

## Configuration

`vela.config` is the extension's section of `extensionConfig` in `settings.json`, keyed by extension name. Strings support `$VAR` and `${VAR}` environment variable references:

```json
{
  "extensionConfig": {
    "local-provider": { "baseUrl": "http://gpu-box:11434/v1" },
    "deploy": { "token": "$DEPLOY_TOKEN" }
  }
}
```

```ts
const baseUrl = typeof vela.config.baseUrl === 'string' ? vela.config.baseUrl : 'http://localhost:11434/v1'
```

The object is frozen and its values are `unknown`; validate them. Project settings deep-merge over user settings. With the SDK, pass `createVela({ extensionConfig: { 'local-provider': { ... } } })`. See [Settings](settings.md).

## Using extensions from the SDK

The SDK loads no extensions by default. Pass factories to `createVela()`:

```ts
import { createVela, memory } from '@glows777/vela'
import hello from './hello.ts'

const vela = createVela({ model, extensions: [memory(), hello] })
await vela.ready()
```

See [SDK](sdk.md) and, for testing extensions with the scripted faux model, [Testing](testing.md).

## Examples

[examples/extensions/](../examples/extensions/README.md) has a small, runnable example for each API above.
