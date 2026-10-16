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
| `vela.registerTool(tool)` | Add a tool the model can call. Returns the registered name |
| `vela.unregisterTool(name)` | Remove a tool this extension registered, by its registered name |
| `vela.registerCommand(name, command)` | Add a `/name` command |
| `vela.registerProvider(name, provider)` | Add a model provider |
| `vela.registerChannel(channel)` | Add a message channel |
| `vela.on(event, handler)` | Subscribe to an event. Returns a function that unsubscribes |
| `vela.onShutdown(handler)` | Run once when the Vela is disposed, after all sessions closed: close resources shared by all sessions, such as server connections. Errors are logged and collected by `dispose()` after all handlers run |

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
    execute: async ({ name }: { name: string }) => `Hello, ${name}!`,
  })
}

export default hello
```

The model sees the tool as `<extension name>_<tool name>`: `greet` in `hello.ts` becomes `hello_greet`, and in `hello-tool.ts` it becomes `hello-tool_greet`. Characters other than letters, digits, `_` and `-` in the extension name become `_`. When the tool name equals the extension name, or already starts with `<extension name>_`, the prefix is not repeated (the memory extension's `memory` tool is just `memory`, and the mcp extension's tools are `mcp__<server>__<tool>`). The prefix means an extension cannot replace a built-in tool or another extension's tool; registering a name that already exists throws.

| Field | Description |
|---|---|
| `name` | Tool name before the prefix |
| `description` | What the model reads to decide when to call the tool |
| `inputSchema` | Zod schema, or any schema the AI SDK accepts (for example `jsonSchema(...)` from `ai`). Input is validated before `execute` |
| `execute(input, ctx)` | Runs the tool. `ctx.toolCallId` and `ctx.signal` (aborted when the session is interrupted or closed) are available, and so are `ctx.onUpdate` and `ctx.executeTool` (below). Return a string, or any value that is sent as JSON. Throw to report an error to the model. To keep structured data apart from what the model reads (pi's `{ content, details }`), return `new ToolExecutionResult(details, textOrContent)` (exported from `@glows777/vela`): the model gets the text or canonical `ToolContent` array, `details` is kept in the tool history and is the `details` of `tool_execution_end` for UIs. A third argument `{ isError: true }` makes it an error result |
| `executionMode` | `parallel` (default) runs calls alongside other tool calls; `sequential` runs the call alone within its session (other sessions are not affected). Same as pi's `executionMode`. A tool that writes files can instead wrap the write in `withFileMutationQueue(path, fn)` (exported from `@glows777/vela`, same as pi) so it queues with `write_file` / `edit_file` on the same file |
| `annotations` | Hints about the tool, same as pi and MCP: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. Vela does not decide permissions from them; a permission extension can |
| `maxResultChars` | Results longer than this (default 3000) are saved to a file and the model gets a preview and the path to read the rest |
| `exposure` | `direct` (default) puts the tool in the tool list. `deferred` only names it in the system prompt; the model loads it with `tool_search` first. `model-only` tools are for the model only, `codemode` tools only for other tools, and `hidden` tools for neither. See [Tools](tools.md#deferred-tools-and-tool_search) |
| `namespace` | `{ name, description?, instructions? }`: groups related tools (such as one MCP server's). The deferred tool list shows the namespace once instead of each tool, and `tool_search` returns its `instructions` with the tools it loads |
| `searchHint` | Short hint shown next to a deferred tool's name |

`ctx.onUpdate(partialResult)` reports partial output while the tool runs. Each call becomes a `tool_execution_update` event (pi's event and field names), so print, JSON and RPC modes see it; updates after the tool returned are ignored. `bash` sends `{ content: [{ type: 'text', text }] }` with the tail of its output.

`ctx.executeTool(name, args, { signal?, onUpdate? })` runs another tool from inside a tool, same as pi. The call goes through everything a model call goes through: the session's role and permissions, extensions' `tool_call` hooks, the dangerous-command check for `bash`, confirmation for `ask`, the tool history and `tool_result` hooks. It can run the session's `direct` tools and every `deferred` or `codemode` tool the session may use, never `model-only` or `hidden` ones. The call's id is `<parent id>/<n>`, its `tool_execution_*` events carry `parentToolCallId`, and it is recorded in the tool history but not added to the conversation. It does not throw for tool failures: an unknown tool, invalid arguments, a refusal and an error all return `{ toolCallId, toolName, result, isError: true }`, with the reason/error message as `result`, or canonical content when a failed tool supplied images. `signal` defaults to the calling tool's signal. A nested call does not wait for the calling tool's `executionMode`.

Tools are shared by all sessions, and an extension can register and unregister them at any time (the mcp extension does when a server connects or changes its tool list). The session's role and permissions decide which sessions can call them; a `guest` session cannot call extension tools, except `rag_search` and `web_search` from the built-in extensions (see [Security](security.md#core-sdk-session-roles)). See [Tools](tools.md) for the built-in tools.

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

Commands only run in `owner` sessions. In a `collaborator` or `guest` session, `/todo` is plain text for the model. Open that session with `vela.session(id, { role })`, or return the role from a channel `roleFor`. A channel that omits `roleFor` is `owner`, so a sender in that chat can run the command.

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

After this, `local/qwen3:8b` works with `--model`, `/model`, `defaultModel` in settings, `createVela({ model })` and `session.setModel()`. `createModel(id, ctx)` returns an AI SDK `LanguageModel`; listed models carry metadata such as the context window (an unlisted field falls back to the built-in catalog when it knows the id), and unlisted ids still work. Provider names are not prefixed. Registering a name that already exists (including the built-in `anthropic`, `openai` and `openrouter`, and providers from `models.json`) throws.

A provider can take part in `/login`:

- `apiKeyLogin: true` lets `/login` ask for an API key and store it.
- `oauth` is an `OAuthLogin`: `name` (shown in `/login`), `login(interaction, options)` that returns a credential, and `refresh(credential, signal)` that returns a new one. `interaction.notify({ type: 'auth_url', url })` shows the sign-in link, `interaction.prompt()` asks the user for text, and `interaction.signal` is aborted when the user cancels.
- `authSource(credential)` says where the provider's key comes from (shown in `/login`), or returns undefined when it has none; such a provider's models are left out of `/model`.

`await ctx.credential()` returns the stored credential, refreshing an OAuth token that has less than 5 minutes left first. Call it per request, for example in a custom `fetch`, since tokens change:

```ts
vela.registerProvider('corp', {
  models: [{ id: 'corp-large' }],
  oauth: { name: 'Corp SSO', login: corpLogin, refresh: corpRefresh },
  authSource: (credential) => (credential ? 'auth.json' : undefined),
  createModel: (id, ctx) =>
    createOpenAI({
      baseURL: 'https://llm.corp.example/v1',
      apiKey: 'unused',
      fetch: async (input, init) => {
        const credential = await ctx.credential()
        if (credential?.type !== 'oauth') throw new Error('Run /login corp')
        const headers = new Headers(init?.headers)
        headers.set('authorization', `Bearer ${credential.access}`)
        return fetch(input, { ...init, headers })
      },
    }).chat(id),
})
```

Credentials are stored like the built-in ones, in `~/.vela/auth.json` for the CLI.

`ctx.channel()` names the channel the requesting session answers on (for example `feishu`), or returns undefined for local sessions. Read it per request too; a sign-in meant only for the person at the terminal can refuse channel sessions with it, as Sign in with ChatGPT does.

If you only need a different base URL or key for an OpenAI- or Anthropic-compatible service, edit `~/.vela/models.json` instead. See [Models](models.md).

### registerChannel

Example: [echo-channel.ts](../examples/extensions/echo-channel.ts)

A channel brings messages from outside (a chat app, a webhook) into Vela. Each chat shares one session, and replies go back through the channel's `send()`.

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

`roleFor` is optional. The gateway checks it on every message. When you omit it, every sender in the chat is `owner`. When you return `guest` or `collaborator`, the role changes tools, permissions, and prompt and command behavior. Earlier turns stay in the shared transcript. See [Session roles](security.md#core-sdk-session-roles) and [Channels](channels.md). The interactive CLI starts channels after startup. The SDK starts them with `vela.startChannels()`.

### on

`vela.on(event, handler)` subscribes to an event. Handlers run in registration order, which is extension load order when factories register synchronously (an `async` factory's handlers registered after an `await` can come after later extensions'). The handler gets the event and a context (`ctx`, see [Context](#context)). It returns a function that removes the handler; removing a handler during a dispatch does not affect that dispatch.

Some events let a handler change what happens; the rest are notifications.

#### Intercepting events

| Event | When | What a handler can do |
|---|---|---|
| `session_start` | Before a session's first prompt, command or compaction, after its history is restored | Set up per-session state, for example `ctx.session.setActiveTools(...)`. Handlers are awaited in order |
| `input` | User input arrives (`prompt()`, `steer()`, `followUp()`, `sendUserMessage()`), after extension commands and before `/skill:` and prompt template expansion | Return `{ action: 'transform', text, images? }` to rewrite it or `{ action: 'handled' }` to drop it |
| `before_agent_start` | At the start of each agent loop (normally once per `prompt()`), before the first model request | Write system prompt sections into `event.sections` (keyed by name); return `{ message }` to add a custom message after the user message. `event.prompt` is the user input |
| `context` | Before every model request | Change `event.messages` (a copy) in place or return `{ messages }`: changes what this request sends, not the history |
| `before_provider_request` | Before a request goes to the provider (summaries too) | Change `event.params` (AI SDK call options) in place or return replacement options |
| `after_provider_response` | The provider answered, before the response is read | Read `event.headers`. Handlers are awaited in order |
| `tool_call` | Before a tool runs (any tool, built-in or extension) | Change `event.input` in place, or return `{ block: true, reason }` to block the call |
| `tool_result` | After a tool runs, before the model sees the result | Return `{ output }` to replace the caption, or `{ content }` to replace text/image blocks |
| `session_before_tree` | Before `session.navigateTree()` (`/tree`) moves, and before it summarizes the branch being left | Return `{ cancel: true }` to stop it; `{ summary: { summary } }` to supply the branch summary (used when one was asked for, instead of the model call); `{ focus }` or `{ label }` to override the caller's. `event.preparation` has `targetId`, `oldLeafId`, `commonAncestorId`, `entriesToSummarize`, `userWantsSummary`, `focus`, `label`; `event.signal` aborts with the navigation |
| `session_tree` | After `navigateTree()` moved | `event` has `newLeafId`, `oldLeafId`, `summaryEntry` and `fromExtension`. Handlers are awaited in order |
| `session_before_fork` | Before `session.fork()` / `clone()` (`/fork`, `/clone`, `--fork`) creates a new session | Return `{ cancel: true }` to stop it. `event` has `entryId` and `position` (`before` or `at`) |
| `session_shutdown` | When a session that has started closes (`session.close()`, `vela.dispose()`, CLI exit); a session never used gets no `session_shutdown` | Release per-session resources. Handlers are awaited in order |

Details:

- `before_agent_start`: sections are computed once per agent loop (normally once per `prompt()`) and stay the same for every model request in that turn, which keeps the prompt cache prefix stable. Sections appear in the system prompt in the order they were written. Example: [prompt-section.ts](../examples/extensions/prompt-section.ts).
- `input` (like pi): `event` has `text`, optional `images` (`ImageContent[]`), `source` (`interactive` for the TUI and `-p`, `rpc`, `extension` for `sendUserMessage()`, `channel` for channel senders, `sdk` by default; set it with `prompt(text, { source })`) and `streamingBehavior` (`steer` / `followUp` while the session is running). It fires in sessions of every role, so check `ctx.session.role`. Transforms chain; omitted `images` preserves the current attachments, while `images: []` removes them. Images are normalized after the input hooks. `handled` stops the remaining handlers and `prompt()` resolves without running. Extension commands run before it and never reach it. A throwing handler is logged and skipped.
- `before_agent_start` messages: like pi, a returned `{ message: { customType, content, display, details? } }` is added as a custom message (see [Messages](#messages)) after the user message and any `nextTurn` messages. Unlike a section it is part of the conversation, so it does not change the cached system prompt.
- `context` (like pi): `event.messages` is a copy of the messages the request sends, without the system prompt; handlers chain. The history, the session file and later requests are unchanged. Images a handler adds are sent as given, without normalization (like pi). After an overflow compaction the request is built again and handlers run again. A throwing handler is logged and the previous result is used.
- Provider hooks (like pi's, with one difference): pi's providers are its own, so pi passes the provider's JSON body; Vela uses the AI SDK, which builds the body inside the provider, so `before_provider_request` gets the AI SDK call options (`prompt`, `tools`, `providerOptions`, `headers`, `maxOutputTokens`, ...). Add request headers through `event.params.headers`. `after_provider_response` gets the response headers but no status: the AI SDK reports a failed response as the request's error. Errors in either are logged and the request goes on.
- `tool_call`: `event` has `toolName`, `toolCallId`, `parentToolCallId` and `input`. `parentToolCallId` is set when another tool issued the call through `ctx.executeTool()` (the call's id is then `<parent id>/<n>`, like pi). A changed input is validated against the tool's schema again; invalid input rejects the call. A handler that throws blocks the call (fail-safe). The first handler that blocks wins and later handlers do not run. The model sees `[Blocked by hook] <reason>`, and `tool_execution_end` reports it with `isError: true`. Session permissions set to `ask` are checked after these handlers, on the final input. Example: [confirm-dangerous.ts](../examples/extensions/confirm-dangerous.ts).
- `tool_result`: `event` has `toolName`, `toolCallId`, `parentToolCallId`, `input`, `output` (the caption text; a preview for oversized results), and optional `content` (`ToolContent`, ordered text/image blocks). Returning `{ output }` replaces text while retaining images; `{ content }` replaces all blocks and `content: []` removes them. Images are normalized after the entire hook chain. Handlers chain: each sees the previous handler's output. A throwing handler is logged and skipped. Only the model's view changes; the tool history and saved full output keep the original. Example: [redact-secrets.ts](../examples/extensions/redact-secrets.ts).
- `session_before_tree` / `session_before_fork` (pi's events of the same names): handlers run in order; the first `cancel` wins and stops the rest, other returned fields are merged (later handlers override). `session_tree` handlers are awaited in order. A throwing handler is logged and skipped.
- `session_start`: errors are logged and the next handler runs.
- `session_shutdown`: errors are logged and the next handler runs; `close()` reports an `AggregateError` after saving and detaching the session. Example: [read-only-session.ts](../examples/extensions/read-only-session.ts).

#### Notification events

`provider_stream_event` is a notification with the raw provider stream chunks (`provider`, `model`, `data`) before the AI SDK normalizes them (like pi). Vela asks the provider for raw chunks only while a handler is subscribed.

Every other session event (`agent_start`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_end`, `usage`, `agent_end`, `context_prepare`, `channel_reply`, ...) is delivered to handlers as a notification: return values are ignored, async handlers are not awaited, and errors are logged. The `tool_call` and `tool_result` names refer to the intercepting events above. The event types and their fields are listed in [SDK](sdk.md#events).

## Messages

Like pi's `sendMessage`, `sendUserMessage` and `appendEntry`, but on the session rather than on the API: one Vela serves many sessions at once (a channel opens one per chat), so there is no "current session". Use `ctx.session` in a handler, or keep the session from `session_start` for background work.

```ts
vela.on('session_start', (_event, ctx) => {
  watcher.onDone((job) =>
    ctx.session.sendMessage(
      { customType: 'job', content: `Job ${job.id} finished`, display: true, details: job },
      { triggerTurn: true },
    ),
  )
})
```

- `session.sendMessage({ customType, content, display, details? }, { triggerTurn?, deliverAs? })` adds a custom message. The model sees `content` (a string or parts, including an image part `{ "type": "image", "data", "mimeType" }`) as a user message; `display` says whether the TUI shows it (as a `[customType]` block); `details` is saved but never sent to the model. Its `message_start` / `message_end` events carry `custom: { customType, display, details }`, and `session.customMessageOf(message)` returns the same for a message in `session.messages`. It is saved as a `custom_message` entry ([session format](session-format.md)). Delivery is the same as pi's:
  - `deliverAs: 'nextTurn'`: held until the next prompt and added after its user message.
  - While running, unless `triggerTurn: false`: queued like `steer()` (or `followUp()` with `deliverAs: 'followUp'`). Queued custom messages are not listed in `session.queue`.
  - Idle with `triggerTurn: true`: runs the agent loop with the message as its input; resolves when the run ends.
  - While running with `triggerTurn: false`: appended once the current step's tool results are in, so it never lands between a tool call and its result.
  - Otherwise: appended right away, without calling the model.
- `session.sendUserMessage(text, { deliverAs? })` sends input as if the user typed it: it goes through `input` handlers with source `extension`, but is not run as a command or expanded as a skill or prompt template. While running, pass `deliverAs` (`steer` / `followUp`), as with `prompt()`.
- `session.appendEntry(customType, data?)` saves extension state as a `custom` entry, never sent to the model. Read it back from `session.getEntries()`, for example in `session_start` after a resume. Like pi, entries added before the session has any conversation are written once the first message is (a session that never gets one is not saved).

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

### Tool image results

`ToolContent` is an array of `{ type: 'text', text }` and the same `{ type: 'image', data: base64, mimeType }` used in prompts:

```ts
return new ToolExecutionResult({ source: 'screenshot' }, [
  { type: 'text', text: 'Current screen' },
  { type: 'image', data: pngBase64, mimeType: 'image/png' },
])
```

The `.text` property remains the joined text caption. `.content` is present for an array result. Images are resized after `tool_result` hooks, stored inline in session messages, and replaced only in non-vision requests. Oversized captions have a separate text-only `modelTextPath` in tool history; native details remain in `output`. Failed image results keep their error status and images: the provider gets an error-text tool result followed by a request-only user image message, because the AI SDK has no multimodal error-output variant.

### Sending images

`ctx.session.sendUserMessage()` accepts a string or an array of text and inline image parts:

```typescript
await ctx.session.sendUserMessage([
  { type: 'text', text: 'Inspect this screenshot' },
  { type: 'image', data: pngBase64, mimeType: 'image/png' },
], { deliverAs: 'followUp' })
```

The input hook receives source `extension` and may replace the images. This follows the same resize, persistence and model-capability rules as SDK prompts; it does not interpret the text as a slash command.
