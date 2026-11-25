# SDK

`@glows777/vela` embeds Vela in a Node.js (>= 22.18) or Bun (>= 1.4) process. It gives TypeScript code the same agent the `vela` command runs: models, tools, system prompt, sessions, compaction and extensions.

Use the SDK for in-process integration. For another language or a separate process, drive the CLI with [JSON mode](json.md) or [RPC mode](rpc.md).

```typescript
import { createVela } from '@glows777/vela'

const vela = createVela({ model: 'openai/<model-id>', providers: myProviders })

try {
  const session = vela.session()
  session.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta')
      process.stdout.write(event.assistantMessageEvent.delta)
  })
  await session.prompt('What files are in the current directory?')
} finally {
  await vela.dispose()
}
```

`createVela()` assembles one Vela: core tools (files, search, bash), hooks, the system prompt, skills, extensions and channels. Conversations are sessions, opened with `vela.session(id)`. One Vela can have many sessions open at once; they share tools and extensions, and each has its own history, compaction state, usage and run lock.

Unlike the CLI, the SDK reads no config files and no environment variables by itself: no `config.json`, no API keys, no built-in extensions. The only files it reads on its own are skills, prompt templates and context files: without `skillDirs` it loads `<cwd>/.vela/skills` and `<cwd>/.skills`, without `promptTemplateDirs` `<cwd>/.vela/prompts`, and without `contextFiles` the `AGENTS.md` / `CLAUDE.md` files from `cwd` up to the filesystem root (there is no project trust check in the SDK; pass these options to choose). You pass what you need, or call [`loadConfig()`](#sharing-the-cli-config) to get the CLI's configuration.

All [SDK examples](../examples/sdk/) run offline with the faux model from `@glows777/vela/testing` and are typechecked with the repository.

## Packages

Vela publishes a single npm package, `@glows777/vela`, with explicit export-map entries:

| Entry | Public contract |
|---|---|
| `@glows777/vela` | Root SDK (`createVela`, built-in extensions, Lark and Local channel adapters) and CLI/TUI (`vela`) |
| `@glows777/vela/extension-api` | Extension authoring types and hook helpers |
| `@glows777/vela/testing` | Offline faux model, test harness (`createTestVela`), and scenario recording/replay |

Only listed export-map entries are supported. Private `src/` or `dist/` paths are not package APIs. Heavy optional integrations (`@larksuiteoapi/node-sdk`, `@modelcontextprotocol/sdk`, `@earendil-works/pi-tui`, `@silvia-odwyer/photon-node`) are loaded lazily on demand and stay off the cold-start import graph. For production artifacts use `bun run build`; development maps the declared export entries to source, while package builds clear the mapping so packed consumers resolve the real artifacts.

## createVela options

`createVela(options?: VelaOptions): Vela`. Every option is optional.

| Option | Default | Description |
|---|---|---|
| `model` | none | Default model: `provider/id` (looked up in `providers` and providers registered by extensions) or an AI SDK `LanguageModel`. Without it, the default model of the first built-in provider with a credential is used (see [Models](models.md#selecting-a-model)); with none, a session must call `setModel()`, or resume a session with a saved model, before it can prompt. |
| `providers` | `{}` | Model providers by name, `Record<string, ProviderDefinition>`. Build them with `loadModels({ env })` or load `config.json` with `loadConfig()`. See [Models](models.md). |
| `credentials` | `memoryCredentialStore()` | `CredentialStore` with the keys and OAuth tokens that `/login` and `vela.login()` store and providers read per request. `loadConfig().credentials` is the CLI's `~/.vela/auth.json` (`fileCredentialStore(path)`). |
| `thinkingLevel` | `medium` | Thinking level for new sessions: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `autoCompaction` | `true` | Automatic compaction for new sessions (pi's `compaction.enabled`). `false`: no threshold summary or compact-and-retry on overflow; `compact()` still works. See [Sessions](sessions.md#turning-automatic-compaction-off). |
| `cwd` | `process.cwd()` | Working directory for file, search and bash tools and for skills. |
| `dataDir` | temp dir | Project data directory: `sessions/`, `usage/` and extension data such as `memory/`. Relative paths resolve against `cwd`. Without it nothing persists: sessions stay in memory and long tool output goes to a temp dir that `dispose()` deletes. The CLI uses the [project data directory](settings.md#data-directory) under `~/.vela/projects/`. |
| `env` | local environment | Optional per-tool resolver `({ sessionId, location }) => ExecutionEnv \| undefined` (also async). File tools, search, bash (including user commands), and background jobs use the returned adapter. Resource preparation also resolves the session environment. A local location requires `node:local`. For a non-local location the trusted resolver supplies a distinct, stable adapter identity and the requested environment cwd. An adapter that implements `exec` keeps its existing contract: a background command passes `spill` like a foreground one, so the complete output lands in the adapter's own spill file, whose `spillPath` the exit delivery names. The first turn, fork or compaction that needs to prepare workspace instructions fails before contacting the model if the resolver is unavailable, even for plain text. Retry after the environment returns. Later tool calls still resolve independently. The default session shell is a login shell; a custom adapter made with `createLocalExecutionEnv` runs commands with `bash -c`. Local commands have the host user's authority. |
| `sessionStorage` | see [Session storage](#session-storage) | Where session history is stored. |
| `skillDirs` | `<cwd>/.vela/skills`, `<cwd>/.skills` | Skill directories or files in the [Agent Skills format](settings.md#skills). The first skill with a name wins. |
| `promptTemplateDirs` | `<cwd>/.vela/prompts` | Prompt template directories or files; `/<name> args` expands one. See [Prompt templates](settings.md#prompt-templates). |
| `contextFiles` | `loadContextFiles({ cwd })` | `AGENTS.md` / `CLAUDE.md` files (`{ path, content }[]`) put into the system prompt; `false` for none. `loadContextFiles({ cwd, agentDir })` finds them like the CLI. See [Context files](settings.md#context-files). |
| `systemPrompt` | none | Replaces the default system prompt (pi's `customPrompt`): the text becomes the intro paragraph and `<tools>`, `<rules>` and `<docs>` are left out; the other sections stay. See [The system prompt](settings.md#the-system-prompt). |
| `appendSystemPrompt` | none | Text appended to the system prompt in an `<addendum>` section. |
| `docs` | none | `{ readme?, docs?, examples? }` for the `<docs>` section, or `false` for none. Folders that do not exist are left out, and without a `docs` folder the section stays off. `createVela()` from `@glows777/vela` points at its own package, so the installed README, `docs/` and `examples/` are found without configuration; a core-only SDK user names them here. |
| `channelIdleMs` | `600000` | A channel session with no new message for this long is closed and resumed on the next message; `0` closes it after each reply; at most `2147483647` (other values throw). See [Channels](channels-reference.md#gateway-lifecycle). |
| `extensionConfig` | `{}` | Config section per extension, keyed by extension name. An extension reads its own section as `vela.config`. |
| `limits` | see below | Overrides for retry, compaction and timeout limits (`Partial<VelaLimits>`). Unknown keys throw. |
| `logger` | silent | A `VelaLogger` for diagnostics that are not events. See [Logger](#logger). |
| `extensions` | `[]` | Extensions to load, run in order. See [Extensions](extensions.md) and [Built-in extensions](#built-in-extensions). |
| `binDir` | none | Directory searched before `PATH` for `rg` and `fd` (used by the `grep` and `find` tools). Without it only `PATH` is searched. The CLI passes `~/.vela/bin`. |
| `offline` | `false` | Never download `rg` or `fd` into `binDir`. The CLI sets it from `VELA_OFFLINE=1`. |

`limits` takes the same keys as the `limits` setting (`VelaLimits`: retries, compaction thresholds, input cap and bash timeout). The four context limits are derived from the model's `contextWindow` when it is known; explicit `limits` win. See [Settings](settings.md#limits) for the keys, defaults and formulas.

## Vela

| Member | Description |
|---|---|
| `cwd`, `dataDir` | Resolved working and data directories |
| `model` | Default `LanguageModel`; a name is resolved on first access. Throws if none was given or it cannot be resolved. |
| `limits` | Limits in effect (defaults plus overrides) |
| `models(options?)` | Available models: those of providers that have a credential, like pi (`ModelInfo`: `provider`, `id`, `ref`, `name`, `contextWindow`, `maxTokens`, `reasoning`, `thinkingLevelMap`, `input`, `cost`). `{ all: true }` returns every listed model. |
| `configureProvider(name, definition)` | Replace or add a provider for subsequent model selections, for example after saving setup. Existing sessions switch with `setModel()`. |
| `setDefaults(model, thinkingLevel)` | Set defaults for subsequently created sessions without changing open sessions. |
| `loginProviders()`, `login(provider, method, interaction, options?)`, `logout(provider)` | What `/login` and `/logout` do: list the providers that take a sign-in, run one (`method` `oauth` or `api_key`; `interaction` shows links and asks for input) and store the credential, or remove it. See [Models](models.md#credentials-and-login). |
| `session(id?, options?)` | Opens a session, or returns it if it is already open. `id` defaults to `default`. |
| `sessions()` | Open sessions |
| `listSessions(options?)` | Saved sessions, newest first, from `vela.db`. Leaves out sessions without messages. Sessions archived with `setSessionArchived()` are left out unless `options.includeArchived` is true. A summary has `id`, `name?`, `updatedAt`, `messageCount` and `firstMessage`, plus `cwd` and `channel` when the session has them, and `archived: true` when archived. |
| `setSessionArchived(id, archived)` | Archives or unarchives a saved session in `vela.db` without opening it: updates `sessions.archived` so no message is deleted. Rejects when nothing is saved under `id`. |
| `searchSessions(query, options?)` | Searches the user and assistant message text of saved sessions (tool output, `!` commands, summaries and extension messages are not searched), newest first. Returns `{ id, match }[]`: one hit per session, with the first matching text shortened around the query. `options.includeArchived` as in `listSessions()`. |
| `subscribe(listener)` | Events from all sessions: `(event, sessionId) => void`. Returns an unsubscribe function. |
| `ready()` | Resolves when host extensions (including async factories) have loaded; rejects if one failed. Session project preparation is awaited separately |
| `extensions(sessionId?)` | Loaded extensions for the prepared open session: host plus its project, including registered tools, commands, providers and channels |
| `commands(sessionId?)` | Slash commands from the host and the prepared open session's project |
| `channels()` | Channels registered by extensions |
| `channel(name)` | On the channel-aware SDK, looks up one registered channel after `ready()`. An unknown name throws. On the Local host, `readAttachment({ projectId, sessionId, messageId })` retrieves the bytes of a visible file message. See [SDK host access](channels-reference.md#sdk-host-access). |
| `startChannels()` | Starts all channels. See [Channels](channels.md). |
| `publishEvent(event)` | Channel-aware SDK only: enqueue untrusted external data to subscribed conversations. Requires started channels; resolves before model completion. See [subscriptions](channels-reference.md#external-event-subscriptions). |
| `dispose(options?)` | Stops channels, closes all sessions and deletes any temporary data directory. Default cancels running work; channel-aware Vela accepts `{ graceful: true }` to drain in-flight channel tools first. The embedding host must enforce its own deadline. |

The optional selectors above inspect existing sessions; they do not open or prepare one. Await `session.resources()` before inspecting a newly opened/resumed project's extensions or commands. An unknown explicit session id throws. No-argument calls retain the default-session view (host-only before that session is prepared), not a union of all projects. `ready()` still waits for host initialization, with no new session selector.

The CLI uses these selectors for active-session `/extensions`, TUI command completion and command detection, and RPC `get_commands`/command dispatch; the channel-aware wrapper preserves host channel metadata. SDK `extensions: [...]` factories remain host-owned. See [extension instance scope](extensions.md#where-extensions-load-from) for project snapshots, lifecycle and the `api.cwd`/`ctx.cwd` distinction.

## Sessions

```typescript
const session = vela.session('support-42', {
  tools: ['-write', '-edit', '-bash'],
  model: 'anthropic/<model-id>',
})
await session.resume() // restore saved history, if any
await session.prompt('Summarize the open issues')
```

A session id becomes a file name: letters, digits, `.`, `_` and `-`, not starting with `.`, at most 128 characters. Other ids throw.

After a mid-tool crash, `resume()` followed by an ordinary `prompt()` repairs unresolved client-tool calls before appending the new user message. It reuses the same durable result/replay policy as `continueInterrupted()`: completed output is retained; interrupted unsafe effects are reported as unknown, not repeated. `continueInterrupted()` remains the API for continuing the old turn without a new user message. No frontend-specific recovery call is required for a normal follow-up.

An older failed follow-up may already have saved a user message between an unanswered tool call and its result. This invalid ordering cannot be fixed by appending another result. Vela stops before executing tools or adding another message and asks you to open a new session or inspect the saved branch; it does not automatically rewrite historical branches or discard the saved question.

`SessionOptions` apply when the session is first opened; a second `vela.session(id, options)` returns the open session unchanged. A `model` or `thinkingLevel` given then also wins over the choice saved in a resumed transcript, so a host's current configuration is not replaced by an older one. `fork()` and `clone()` restore the copied branch's own model and thinking level instead.

| Option | Default | Description |
|---|---|---|
| `cwd` | Vela's cwd | Base for file/search/bash tools (also `executeBash`), the cwd prompt and automatic AGENTS/CLAUDE discovery; relative values resolve against Vela's cwd. `session.cwd` exposes the resolved path. A different cwd reloads its own instruction chain instead of a supplied `contextFiles` array; `contextFiles: false` still disables loading. Workspace skills and templates follow the session cwd. Explicit SDK skill or template directories supply host resources and override automatic discovery at Vela’s default cwd. At a different session cwd, workspace resources take priority over those explicit directories. Extensions, configuration, storage and relative export destinations stay Vela-wide. Fork/clone preserves the location. New session records persist it, so resume restores it even if the new caller supplied a different cwd; legacy records with no location retain the previous caller/default cwd behavior. This is a default path, not a security sandbox. |
| `location` | local session cwd | `{ environment, cwd }` selects the initial target and takes precedence over `cwd`. Local paths resolve against Vela’s cwd. A non-local target requires an absolute environment path and an explicit `env` resolver. |
| `tools` | default set | Exact tool names enable only those tools; a list of only `+name` / `-name` entries adjusts the default set instead, like pi. `*` patterns are a CLI option (`--tools`, `--exclude-tools`), not part of this option |
| `model` | Vela's model | `provider/id` or `ModelHandle` for this session |
| `thinkingLevel` | Vela's level | Thinking level for this session |
| `autoCompaction` | Vela's setting | Automatic compaction for this session |

### Image input

```typescript
import { readFile } from 'node:fs/promises'
import type { ImageContent } from '@glows777/vela'

const image: ImageContent = {
  type: 'image',
  data: (await readFile('screenshot.png')).toString('base64'),
  mimeType: 'image/png',
}
await session.prompt('What is in this picture?', { images: [image] })
// While a prompt is running:
await session.steer('Focus on this area', { images: [image] })
```

Images keep the same `{ type: 'image', data, mimeType }` shape in input hooks, events and saved history. Vela detects PNG, JPEG, GIF, WebP and BMP by their bytes, applies EXIF orientation and uses Photon WASM to reduce images to a longest side of 2000 pixels and at most 4.5 MiB of base64. When an image needs conversion, Vela encodes it as PNG if any pixel is not fully opaque before orientation. Vela does not encode that PNG as JPEG. Vela encodes it as JPEG at quality 80 if every pixel is fully opaque. If either encoding exceeds 4.5 MiB of base64, Vela shrinks the bitmap further and repeats that encoding until the base64 is at most 4.5 MiB. Small supported images stay unchanged. Invalid images or images beyond the safe decoding limits (128 MiB encoded input or 67,108,864 decoded pixels) are omitted with a text reason, so the rest of the prompt can continue.

Images are normalized once, when they enter: `prompt`, `steer`, `sendUserMessage` and tool results. Saved history, and messages an extension adds with `append()`, a `sendMessage()` that does not trigger a turn, or a `context` hook, are sent as given and never decoded again (like pi), so an extension that supplies images is responsible for their format and size. Normalized images are saved inline in SQLite (`vela.db`) and survive resume, clone and forks that include the image message. If the selected model's `input` metadata excludes `image`, its request gets `(image omitted: model does not support images)` instead. Saved history keeps the image for a later vision model. When input metadata is unknown (including a directly supplied `LanguageModel`), images are forwarded; set provider model metadata when you know it is text-only. Context estimates count each image as 4800 characters. Summary requests omit image payloads instead of treating base64 as prose.

`ModelMessage`, `UserContent` and `ToolModelMessage` exported by Vela extend the existing AI SDK message types with inline image content. Use these types for session history and extension context; existing text-only messages remain valid. The provider edge converts inline images to AI SDK image files.

### Session members

| Member | Description |
|---|---|
| `id` | Session id |
| `messages` | History (Vela `ModelMessage[]`, exported by this package). Treat it as read-only. |
| `append(message)` | Appends a message without calling the model |
| `prompt(input, options?)` | Appends a user message and runs the agent loop until it settles, then saves. See [Prompting](#prompting). |
| `steer(input, options?)` | Queue input while running; same as `prompt()` when idle. `options.source` as in `PromptOptions` |
| `sendMessage(message, options?)`, `sendUserMessage(text, options?)` | Add an extension's custom message, or input as if typed (like pi). See [Extensions](extensions.md#messages) |
| `appendEntry(customType, data?)` | Save extension state in the session (a `custom` entry, never sent to the model) |
| `customMessageOf(message)` | `{ customType, display, details }` for a custom message in `messages`; `undefined` for other messages |
| `getEntries()` | The session's entries in append order (see [Session format](session-format.md)) |
| `queue`, `clearQueue()` | Copy of the queued steering inputs (`{ steering: string[] }`); remove all queued messages and return the user inputs |
| `steeringMode` | `one-at-a-time` (default) or `all`: how many queued messages are taken at once |
| `abort(reason?)` | Aborts the running loop and extension commands, and waits until the loop has stopped. Queued messages stay queued. |
| `drain()` | Permanently stops admitting new work, lets already-running tools finish and save, and interrupts before the next model/tool iteration. Does not close the session or impose a timeout; the host must enforce its deadline and then abort/close. |
| `waitForIdle()` | Waits for the running loop (including queued messages and manual compaction) without aborting it |
| `isRunning` | Whether an agent loop or compaction holds the run lock |
| `hasWork` | Whether work outside a turn (a background command) is still running; channel idle cleanup keeps such a session open |
| `executeBash(command, options?)` | Runs a shell command for the user, like the TUI's `!cmd` (pi's `executeBash`): in the working directory with the `shellPath` shell, without tool selection checks or hooks, one at a time. Resolves to `{ output, exitCode, cancelled, truncated, fullOutputPath?, backgroundTaskId? }` (`output` is the last 2,000 lines or 50 KB; `exitCode` is undefined when cancelled, and when `backgroundTaskId` is set, which means the user moved it to the background and its exit will be delivered like any job's) and rejects if the command can't start. The result is saved as a `bash_execution` entry and reaches the model as a user message with the next prompt; `excludeFromContext: true` (`!!cmd`) saves it without sending it. While the agent runs, it is recorded when the run ends. `onUpdate(output)` gets the output's tail while it runs, and `bash_execution_update` events carry each new piece of output with the `id` option. |
| `isBashRunning`, `abortBash()` | Whether an `executeBash()` command is running; cancel it (it is still recorded, as cancelled) |
| `backgroundTasks(toolCallId?)` | Moves running shell commands to the background: with an id, that model-issued `bash` call; without one, every call the session runs in the foreground, including your own `!` command. The waiting call returns a synthetic result naming the job (`backgroundTaskId`, `backgroundedByUser: true`), and the exit arrives as the job's result. Resolves to the new ids (`bg-1`, …); an unknown id rejects and names what is running. A command started with `excludeFromContext` (`!!`) is never moved: its exit is delivered to the model, which that flag promises not to do, so it is left out of the ids (and still cancelled by `abortBash()`). Needs the `background` extension |
| `compact(focus?)` | Summarizes earlier history now and saves. `focus` says what the summary should prefer to keep. Throws while running. |
| `continueInterrupted()` | After `resume()`, reconciles missing tool results on the current branch and continues without a new user message. Holds the normal run lock; rejects busy/closed sessions, empty history, or a completed assistant tail. Completed tool responses are restored exactly when journaled; unsafe or uncertain calls become explicit unknown-result errors, not automatic repeats. |
| `resume()` | Replaces the in-memory history with the saved one; returns `false` if nothing was saved. Restores the name, a saved channel, the thinking level and (if resolvable) the model. Throws while running. Throws `SessionRoutingConflictError` when the session was opened with a different channel than the saved one. |
| `model`, `modelInfo` | Current `LanguageModel` and its `ModelInfo` |
| `location` | Read-only current `{ environment, cwd }`. A resumed session uses the latest saved location. |
| `setLocation(location)` | A trusted host can move an idle session. Vela prepares the new workspace and saves the target before switching tools and project resources. Active turns, commands and background work refuse a move. A failed prepare or rejected write keeps the original location. If storage loses both the write acknowledgement and the readback, execution waits for a successful `resume()`. Repeated wakes at the same location reuse the prepared resources. |
| `setModel(model)` | Switches the model from the next prompt. Compaction limits are recomputed from the new context window. Throws, keeping the current model, if the name cannot be resolved. A model chosen by name is saved with the session. |
| `thinkingLevel`, `setThinkingLevel(level)` | Current level; set it from the next request. A level the model doesn't support is clamped to the nearest supported one (like pi); the getter returns the level in effect. `availableThinkingLevels()` lists the supported levels. See [Thinking levels](models.md#thinking-levels). |
| `getActiveTools()` | Tool names the model can currently see (after selection and deferred loading) |
| `setActiveTools(names)` | Enable only these tools; `undefined` restores all |
| `name`, `setName(name)` | Display name, saved with the next save and shown in session lists |
| `persistence` | Where history is kept: `{ type: 'file', path }` (the `vela.db` SQLite path; the file may not exist until the first message), or `{ type: 'memory' }` when running with `ephemeralSessions` or an in-memory `db` |
| `autoCompaction` | Get or set automatic compaction (pi's `autoCompactionEnabled` / `setAutoCompactionEnabled`) |
| `getEntries()` | Copies of all the session's entries in append order, every branch included |
| `getTree()`, `getBranch(fromId?)`, `getLeafId()`, `parentSession` | The session tree; see [Session tree](#session-tree) |
| `navigateTree(entryId, options?)`, `setLabel(entryId, label)` | Move in the session tree; bookmark an entry |
| `fork(entryId, options?)`, `clone(options?)` | Copy a branch into a new session |
| `exportHtml(path?)`, `exportJsonl(path?)` | Write the current branch as HTML or JSONL; return the path written |
| `limits` | Limits in effect for this session's model |
| `usage` | `{ tokens, percent, needsAction, totals }`: context estimate and this session's token and cost totals; `totals.cost`, `baselineCost` and `savedCost` are undefined while no request had a known price |
| `subscribe(listener)` | This session's events: `(event) => void`. Returns an unsubscribe function. |
| `close()` | Aborts, waits for the run to finish and save, fires `session_shutdown` (if the session had started) and removes the session from the Vela |

Members marked `@internal` in the type declarations (`store`, `tracker`, `registry`, `save()`, `emit`, ...) are used by the CLI and may change without notice.

### Session tree

Like pi, a session's entries form a tree (see [Sessions](sessions.md#session-tree) and [Session format](session-format.md)). New entries are appended under the current leaf; the model sees the branch from the root to the leaf.

```typescript
const entries = session.getEntries()
const question = entries.find((e) => e.type === 'message' && e.message.role === 'user')!

// Move to just before that message; its text comes back for editing
const { editorText } = await session.navigateTree(question.id, { summarize: true })
await session.prompt(`${editorText} (but in TypeScript)`) // a new branch

// Or copy the branch up to it into a new session; the original stays open
const { session: copy, selectedText } = await session.fork(question.id, { sessionId: 'try-2' })
```

| Member | Description |
|---|---|
| `getTree()` | `SessionTreeNode[]` (`{ entry, children, label? }`), roots first, children oldest first. Normally one root; an entry whose parent is missing is also a root. |
| `getBranch(fromId?)` | Entries from the root to `fromId` (default: the leaf) |
| `getLeafId()` | The current leaf; `null` when there are no entries |
| `navigateTree(entryId, { summarize?, focus?, label? })` | Like pi's: a user message moves the leaf to its parent and returns `{ editorText }`; any other entry becomes the leaf. `summarize` first summarizes the old branch below the entry it shares with the target (`focus` steers the summary) and appends a `branch_summary` where the session moves. `label` labels the target (or the summary). Rebuilds `messages`, the model and thinking level from the new branch. Returns `{ cancelled: true }` when an extension or `abort()` stopped it. |
| `setLabel(entryId, label)` | Sets a label; `undefined` or `''` clears it |
| `fork(entryId, { position?, sessionId? })` | Copies the branch into a new session: `position: 'before'` (default) needs a user message and ends just before it (returns its text as `selectedText`); `'at'` includes the entry. Returns `{ cancelled, session?, selectedText? }`. The new session opens in the same Vela with this session's options, model, thinking level and automatic compaction setting; this session stays open (pi replaces its one session instead). `sessionId` defaults to a new time-based id; one already open or already saved throws. |
| `clone({ sessionId? })` | `fork(getLeafId(), { position: 'at' })`; throws when the session has no entries |
| `parentSession` | Id of the session this one was forked from |

`navigateTree()`, `fork()` and `clone()` throw while the session is running. Extensions can cancel or adjust them with the [`session_before_tree`, `session_tree` and `session_before_fork` events](extensions.md#intercepting-events).

### Prompting

`prompt()` resolves when the run is done, including tool calls, retries and every `steer` message queued during the run (or when `waiting_human` suspends for tool approval). If the loop fails, queued messages still run, then the promise rejects.

A session runs one loop at a time. Calling `prompt()` while it is running throws unless you specify `streamingBehavior`:

```typescript
await session.prompt('Refactor the parser')               // idle: runs
session.prompt('Also update the tests', { streamingBehavior: 'steer' })    // running: queued
```

- `steer` joins the current task: remaining queued tool calls in the current step are skipped, and the message is sent as a user message before the next model request.

`steer(input)` is a shortcut that resolves as soon as the input is queued. `PromptOptions.signal` aborts the run like `abort()`. `PromptOptions.source` tells extensions' `input` handlers where the input came from (`interactive`, `rpc`, `extension`, `channel`; default `sdk`).

Input starting with `/` that names an extension command runs the command instead of going to the model, even while a loop is running. See [Extensions](extensions.md).

## Events

`session.subscribe()` receives that session's events; `vela.subscribe()` receives events from every session with the session id. Core never writes to the terminal: everything the CLI shows comes from these events.

Message and tool events have pi's shape (`message_start / message_update / message_end`, `tool_execution_start / update / end`, `auto_retry_start / end`). The messages in them are Vela `ModelMessage`s. A user image part is `{ type: 'image', data, mimeType }`. See [Image input](#image-input). One prompt produces:

```
agent_start
message_start, message_end            the user input
turn_start
  message_start                        the assistant message starts
  message_update ...                   text / thinking / tool call streaming in
  message_end                          the assistant message, with stopReason
  tool_execution_start ...             its tool calls run
  tool_execution_end ...
  usage
  message_start, message_end           the tool results message
turn_end
turn_start ...                         another turn if the model called tools
agent_end
agent_settled
```

Steered messages arrive as another `message_start` / `message_end` followed by another turn. `agent_end` closes one agent loop; if messages are still queued after an error or a loop-detection stop, a new loop starts; after an abort they stay queued for the next prompt. `agent_settled` comes last and means the session is idle and nothing else will run on its own.

| Type | Fields | When |
|---|---|---|
| `agent_start` | `input` | A loop starts handling user input (queued inputs taken together are joined with a blank line) |
| `turn_start` | `turn` | Before each model request (1-based within the loop) |
| `message_start` | `message` (`ModelMessage`), `custom?` | A message starts: user input, the assistant reply, tool results (`tool-result` parts), or a custom message (an extension's `sendMessage()`). `custom` is `{ customType, display, details? }`. The message itself is a user message. Every message except the streaming assistant one gets `message_start` and `message_end` back to back. |
| `message_update` | `message` (the assistant message so far), `assistantMessageEvent` | The assistant message is streaming. `assistantMessageEvent` says what changed, with pi's names: `text_start` / `text_delta` / `text_end`, `thinking_start` / `thinking_delta` / `thinking_end`, `toolcall_start` / `toolcall_delta` / `toolcall_end`; each has `contentIndex` (the part in `message.content`), deltas have `delta`, `toolcall_end` has `toolCall`. |
| `message_end` | `message`, `stopReason?`, `errorMessage?`, `custom?` | A message is complete. Assistant messages carry `stopReason`: `stop`, `toolUse`, `length` (cut off by the output limit), `aborted` or `error` (with `errorMessage`). The assistant `message_end` is the authoritative final text. |
| `tool_execution_start` | `toolCallId`, `toolName`, `args` | A tool call is about to run (after the assistant `message_end`). |
| `tool_execution_update` | `toolCallId`, `toolName`, `args`, `partialResult` | Partial output of a running tool, for tools that stream it (`bash` sends the tail of its output as `{ content: [{ type: 'text', text }] }`) |
| `tool_execution_end` | `toolCallId`, `toolName`, `result`, `isError`, `details?`, `durationMs?` | A tool call finished. `result` is the output, or the error when `isError`. A call blocked by an extension or refused by the session's tool selection ends here with `isError: true` and the reason as `result`. The model still receives that reason, and the loop continues. `details` is display data the model does not get (pi's `result.details`): set by built-in tools on success, for `edit` `{ diff, patch, firstChangedLine }`. Extension tools set it by returning a `ToolExecutionResult` ([extensions](extensions.md#registertool)). |
| `auto_retry_start` | `attempt`, `maxAttempts`, `delayMs`, `errorMessage` | A retryable model error; the request runs again after `delayMs`. The failed attempt's assistant message ended with `stopReason: 'error'` and is not in the history; the retry streams a new assistant message. See [Sessions](sessions.md#retries). |
| `auto_retry_end` | `success`, `attempt`, `finalError?` | Retrying ended: the request succeeded, or failed for good |
| `usage` | `modelId`, `usage` (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`), `record?` (adds `cost` in USD, absent when the model has no known price, `ts`, `model`, `kind` (`main` or `summary`), `durationMs` and the provider's raw `usage`) | After each model request |
| `turn_end` | `turn`, `message` (the assistant message), `toolResults` (`tool-result` parts) | After each model request and its tools, including one that was aborted or failed |
| `agent_end` | `messages` (the messages this loop added), `reason` (`done`, `aborted`, `error`, `waiting_human`), `error?`, `errorKind?` | The loop ended. Failed runs include a category (below); `waiting_human` suspends until `resolveApproval()` + `continueInterrupted()`. Queued messages may still start another loop. |
| `queue_update` | `steering` | The queue changed; holds the full current steering queue as strings |
| `agent_settled` | | All work from `prompt()` is done and the session is idle |
| `bash_execution_update` | `id?`, `delta` | New output of a running `executeBash()` command (like pi); the `delta`s add up to all of its output. `id` is the one passed to `executeBash()` |
| `context_prepare` | `action`, `before`, `after?`, `saved?`, `calls?` | Vela-specific context management (`summary-required`: the summary threshold was reached but this run may not summarize). Token counts are estimates. See [Sessions](sessions.md#compaction). |
| `compaction_start` | `reason` (`threshold`, `manual`, `overflow`) | Summarizing earlier history starts (like pi): before a request that is too large, from `session.compact()`, or after the provider said the context is too long |
| `compaction_end` | `reason`, `result?` (`summary`, `firstKeptEntryId`, `tokensBefore`, `tokensAfter`, `messages`), `aborted`, `willRetry`, `errorMessage?` | Summarizing ended (like pi). `result` is set when it succeeded, `aborted` when it was interrupted, otherwise `errorMessage` says why it failed. `willRetry`: the request that overflowed is sent again |
| `audit` | `toolName`, `path` | Before `write` or `edit` writes `path` |
| `notify` | `message`, `level` (`info`, `warning`, `error`) | An extension called `ctx.notify()`. See [Extension Notifications](rpc.md#extension-notifications). |
| `channel_message` | `channel`, `senderId`, `senderName`, `text` | A channel received a message for this session |
| `channel_reply` | `channel`, `recipientId`, `text` | A channel sent a reply |
| `channel_error` | `channel`, `senderId`, `error`, `aborted`, `source?` | A channel turn failed or was aborted. `source: 'feedback'` means only the progress presentation failed (the run still finishes); admission, preparation and command failures are not tagged |

The types are `VelaEvent`, `AssistantMessageEvent`, `StopReason`, `VelaEventListener` and `VelaSessionEventListener`. Extension lifecycle events (`session_start`, `before_agent_start`, `tool_call` interception, ...) are a separate API, see [Extensions](extensions.md). The CLI's `--mode json` and `--mode rpc` write these same events as JSON lines, see [JSON mode](json.md).

See [02-events.ts](../examples/sdk/02-events.ts).

### Failed agent runs

When `agent_end.reason === 'error'`, `errorKind` is one of these `AgentErrorKind` values:

- `auth`: HTTP 401 or 403. Check the API key and its access.
- `billing`: HTTP 402 or a provider body reporting insufficient balance, credits or quota. A quota-related 429 is billing, not rate limiting.
- `rate_limit`: HTTP 429 without billing evidence.
- `network`: a transport error, including connection reset, broken pipe, timeout or failed fetch; SDK causes are inspected too.
- `context_overflow`: the existing provider context-overflow detector matches the error.
- `provider`: another provider API failure, including other 4xx and 5xx responses.
- `unknown`: no supported classification matched.

The original `error` and the rejection from `session.prompt()` stay unchanged. Successful, loop-stopped and aborted runs have no `errorKind`. Classification happens only on the terminal failure: retry policy and context recovery do not change. A recovered request still ends successfully. Errors before the agent loop (such as invalid session setup) do not produce this event.

`agentErrorHint(errorKind)` returns one plain, shared next-step hint, or `undefined` when no kind is present. TUI, print mode and channel replies show it beside the original error; SDK hosts can use the same helper or map the closed kinds to their own UI. The type and helper are exported by both `@glows777/vela-core` and `@glows777/vela` (also the core extension API).

## Multiple sessions

```typescript
const alice = vela.session('alice')
const bob = vela.session('bob', { tools: ['-bash'] })
await Promise.all([alice.prompt('Hi'), bob.prompt('Hello')])
```

Sessions in one Vela run concurrently. Tool definitions, extensions, skills, memory and channels are shared; history, queues, compaction, usage, tool results and the run lock are per session. Channels rely on this: the gateway opens one shared session per conversation (`<channel>-<channelId>`). See [03-multi-session.ts](../examples/sdk/03-multi-session.ts) and [Sessions](sessions.md#multiple-sessions).

## Session storage

| Setup | Storage |
|---|---|
| `db` given | Uses that caller-owned SQLite `VelaDatabase` (not closed by `dispose()`) |
| `ephemeralSessions: true` (or no `dataDir`) | In-memory SQLite (`:memory:`), gone when the process exits |
| `dataDir` given (default) | Persistent SQLite WAL DB at `<dataDir>/vela.db` |

```typescript
import { createVela } from '@glows777/vela'

createVela({ dataDir: '.vela-data' })                     // persistent SQLite at .vela-data/vela.db
createVela({ dataDir: '.vela-data', ephemeralSessions: true }) // keep memory data, not sessions
```

`session.persistence` returns `{ type: 'file', path }` (the path to `vela.db`) or `{ type: 'memory' }`. A file path may not exist until the first message is persisted.

`session.getEntries()` returns a session's entries (from SQLite `vela_messages`), including messages that were summarized or are no longer sent to the model. See [04-custom-storage.ts](../examples/sdk/04-custom-storage.ts).

Long tool outputs are spilled to files under `<dataDir>/sessions/<id>/` (or a private temp directory when running in memory), with paths and previews recorded durably in SQLite `vela_tool_calls`.

## Sharing the CLI config

`loadConfig()` reads `~/.vela/config.json`, `AGENTS.md` / `CLAUDE.md`, and with `trusted: true` the project's `.vela/config.json`, extensions, skill and prompt directories, `SYSTEM.md` and `APPEND_SYSTEM.md`, and returns values ready for `createVela()`. It only reads files; it never loads extension code.

```typescript
import {
  createVela, lark, importExtension, loadConfig, mcp, memory, web,
  type VelaExtension,
} from '@glows777/vela'

const builtins: Record<string, () => VelaExtension> = {
  memory: () => memory(), web: () => web(),
  lark: () => lark(), mcp: () => mcp({ servers: config.mcp.servers }),
}
const config = loadConfig({ cwd: process.cwd(), env: process.env, builtins: Object.keys(builtins) })

const extensions: VelaExtension[] = []
for (const entry of config.extensions)
  extensions.push('builtin' in entry ? builtins[entry.name]!() : await importExtension(entry.path, entry.name))

const vela = createVela({
  model: config.settings.model,
  providers: config.providers,
  credentials: config.credentials,
  thinkingLevel: config.settings.thinkingLevel,
  cwd: config.cwd,
  dataDir: config.dataDir,
  skillDirs: config.skillDirs,
  promptTemplateDirs: config.promptDirs,
  contextFiles: config.contextFiles,
  systemPrompt: config.systemPrompt,
  appendSystemPrompt: config.appendSystemPrompt,
  limits: config.settings.limits,
  extensionConfig: config.extensionConfig,
  extensions,
})
```

`LoadConfigOptions`:

| Option | Default | Description |
|---|---|---|
| `cwd` | `process.cwd()` | Project directory |
| `agentDir` | `env.VELA_DIR` or `~/.vela` | User-level directory |
| `env` | `{}` | Environment for `$VAR` / `${VAR}` interpolation, `VELA_DIR` and provider API keys. Core never reads `process.env` itself: pass it explicitly. |
| `trusted` | `false` | Also load the project's `.vela/config.json`, `.vela/extensions/`, skills (`.vela/skills/`, `.agents/skills/`, `.skills/`, returned in `skillDirs`), `.vela/prompts/`, `.vela/SYSTEM.md` and `.vela/APPEND_SYSTEM.md` |
| `homeDir` | `os.homedir()` | Home directory for `~/.agents/skills` |
| `builtins` | `[]` | Names of built-in extensions to list in `extensions`; `-builtin:<name>` in settings removes one |
| `defaultOffBuiltins` | `[]` | Names in `builtins` that stay off until settings enable them with `+builtin:<name>` |

The local `skillDirs` and `contextFiles` views are materialized on first access. The CLI and desktop prepare workspace instructions, skills and templates in the session environment. They combine those with the host’s user instructions. Local sessions also include host skills from configured directories. When the CLI resumes a session in another working directory, that project's saved trust decision controls its skills and templates. Ordinary wakes reuse the prepared resources so the system prompt prefix stays stable. `inspectVela()` describes the host resources. Use `await inspectSession(vela, session)` to inspect the complete system prompt for one session.

The CLI also fills built-in extension config from environment variables such as `TAVILY_API_KEY`; with the SDK, put those values in `extensionConfig` or pass them to the extension factories.

## Logger

Diagnostics that are not events (extension loading, hook errors, unreadable session file lines) go to a `VelaLogger`. The default, `silentLogger`, drops everything.

```typescript
const vela = createVela({
  logger: {
    debug: () => {},
    info: (m) => console.error(m),
    warn: (m) => console.error(m),
    error: (m) => console.error(m),
  },
})
```

Extensions get the same logger as `vela.logger`.

## Built-in extensions

The SDK loads no extensions by default. The CLI's built-in extensions are exported as factories:

```typescript
import { background, createVela, memory, todo, web, lark, mcp } from '@glows777/vela'

const vela = createVela({
  dataDir: '.vela-data',
  extensions: [
    background(),
    memory(),
    todo(),
    web({ tavilyKey: process.env.TAVILY_API_KEY }),
    mcp({ servers: { docs: { url: 'https://example.com/mcp' } } }),
  ],
})
```

Options not passed to a factory are read from its `extensionConfig` section. See [Built-in extensions](built-in-extensions.md) and [Channels](channels.md) for `lark()`.

## Disposal

Call `await vela.dispose()` when you are done. It stops channels, aborts running sessions, waits for them to save, fires `session_shutdown` for extensions, runs extensions' `onShutdown` handlers (the mcp extension closes its server connections there) and, when there is no `dataDir`, deletes the temp data dir. A disposed Vela throws on `session()`.

Disposal waits for extension factories to settle, then attempts channel shutdown, all session closes, extension shutdown handlers, listener cleanup and temporary-directory removal in that order. Independent cleanup still runs after a failure; all session-close attempts settle before shared extension resources are closed. Failures reject with an `AggregateError` after cleanup attempts finish; its `errors` can contain nested lifecycle aggregates. Concurrent and repeated calls return the same promise/result, including the same rejection; they do not retry failed cleanup or rerun completed hooks. Cleanup waits for existing work and handlers to settle, so an uncooperative factory, tool or shutdown handler can still prevent completion; no timeout or forced termination is implied.

`await session.close()` closes one session the same way and removes it from the Vela; a later `vela.session(id)` opens a fresh object for that id (call `resume()` to reload its history).

## Testing

`@glows777/vela/testing` provides `createFauxModel()` (scripted responses), `createTestVela()` (a real Vela in a temp dir), a faux embedder, and recording and replay of real runs. See [Testing](testing.md).

## Examples

| Example | Purpose |
|---|---|
| [01-minimal.ts](../examples/sdk/01-minimal.ts) | One session, one prompt, print the answer |
| [02-events.ts](../examples/sdk/02-events.ts) | Subscribe to events, including a tool call |
| [03-multi-session.ts](../examples/sdk/03-multi-session.ts) | Two sessions running concurrently in one Vela |
| [04-custom-storage.ts](../examples/sdk/04-custom-storage.ts) | Sharing a caller-owned SQLite `VelaDatabase` across instances |

## API stability

The public surface is:

- the exports of `@glows777/vela` and `@glows777/vela/testing` (snapshots in `packages/*/api/public-api.txt`; regenerate it with `bun run api:update`, and a unit test fails when the exports change without it),
- CLI flags,
- `config.json` keys,
- the `--mode json` event stream and the RPC protocol,
- event types,
- the session file format.

Anything marked `@internal` in the type declarations is not covered.

During 0.x, a breaking change bumps the minor version (0.1 to 0.2); patch releases don't break anything. Every breaking change is listed under "Breaking Changes" in [CHANGELOG.md](../CHANGELOG.md) with migration notes.

### Tool images

`read` detects JPEG/PNG/GIF/WebP/BMP from the header, regardless of extension; text still uses the same pager. Extension tools return `new ToolExecutionResult(details, content)` with a `ToolContent` array. MCP images use that same pipeline. Tool images are normalized after `tool_result` hooks and saved inline. Text-only model requests get `(tool image omitted: model does not support images)` without changing history.

Anthropic and OpenAI Responses accept native tool images. OpenAI Chat-compatible adapters serialize tool content as JSON, so Vela lifts images into one request-only user message after the complete consecutive tool-result group. Adapter detection uses the provider's `.chat` suffix, including configured aliases. Custom provider implementations must report that protocol suffix if they share this limitation.

See [the offline tool-image example](../examples/sdk/06-tool-images.ts) and [tool hooks](extensions.md#tool-image-results).

## Routing and host lifecycle

`vela.session(id, { scope, channel })` supplies a host's routing identity before session hooks and tool calls. A scope is `{ id, kind: 'private' | 'shared', dataDir }`; it selects shared storage and grants no permissions. `session.scope` and each tool call's `context.scope` are read-only snapshots; `context.sessionId` identifies the invoking session. Supply routing again on resume. `resume()` restores a channel saved in the session file, and supplying that same channel again writes nothing. Fork and clone omit routing.

An existing unbound session accepts its first scope/channel binding while preserving object identity and its original cwd, tools and model. The binding is synchronous, and its `session_channel` entry is written like other session metadata: `listSessions()` shows the channel once that queued write completes (on `session.save()`, the next prompt, or `close()`). Repeating the same route is allowed. A channel already saved for the session is that binding after `resume()`, including when the new session was opened with a channel before `resume()`. A different channel throws an error named `SessionRoutingConflictError`, containing the session ID and both routes, without retry or rebinding. Other session options remain first-open-only.

`session.getActiveTools()` returns the tools currently exposed to the model; use `tools` or `setActiveTools()` to control the selection. `session.save()` flushes pending session updates to `vela.db` and rejects on error. It does not close the session.

`createVela({ onSessionSaved(id), beforeDispose() })` supports host composition. A successful nonempty storage append calls `onSessionSaved`; no-op or failed saves do not. Observer errors are logged and cannot retry committed history. Disposal waits for extension factories, runs `beforeDispose` to stop ingress, attempts every session close, then shared extension shutdown and cleanup, aggregating errors.

`publishChannelEvent(session, event)` accepts only `channel_message`, `channel_reply` and `channel_error`. `resolveBinary(vela, 'rg' | 'fd')` and `setDefaultToolModifiers(session, entries)` are plain frontend utilities. `inspectVela` and `inspectSession` return diagnostic snapshots and are **experimental**. Ordinary inspection never runs extension prompt hooks; `inspectSession(vela, session, { previewExtensions: true })` explicitly requests that preview. `session.usage` includes totals, context-window size and a copy of the last usage record.

The umbrella `@glows777/vela` preserves its root and `./testing` entries and the `vela` executable. Channel-aware `createVela`, `channels()`, `channel(name)`, `startChannels()` and `channelIdleMs` retain their existing shapes; `runningChannels()` supplies the connected-name snapshot used by serve.

The experimental `@glows777/vela-core/diagnostics` entry also provides the canonical frontend helpers for HTML/session views, session IDs, thinking choices, tool validation, and config trust/path decisions. `resolveModel(ref, { providers, credentials })` resolves a supplied object, provider reference or configured default without assembling a Vela or reading project resources. With no configured default it throws the CLI’s existing no-model guidance. These helpers are experimental; the exact surface is recorded in the core API snapshot.

`vela serve` uses graceful disposal on its first shutdown signal, with a 30-second total cap. Bare SDK `dispose()` and explicit Stop retain immediate cancellation. A second signal exits immediately. See [channel shutdown](channels.md#shutdown-and-recovery).
