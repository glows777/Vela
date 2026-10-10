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

`createVela()` assembles one Vela: core tools (files, search, bash), hooks, the system prompt, skills, extensions and channels. Conversations are sessions, opened with `vela.session(id)`. One Vela can have many sessions open at once; they share tools and extensions, and each has its own history, compaction state, usage, role and run lock.

Unlike the CLI, the SDK reads no config files and no environment variables by itself: no `settings.json`, no `models.json`, no API keys, no built-in extensions. The only files it reads on its own are skills, prompt templates and context files: without `skillDirs` it loads `<cwd>/.vela/skills` and `<cwd>/.skills`, without `promptTemplateDirs` `<cwd>/.vela/prompts`, and without `contextFiles` the `AGENTS.md` / `CLAUDE.md` files from `cwd` up to the filesystem root (there is no project trust check in the SDK; pass these options to choose). You pass what you need, or call [`loadConfig()`](#sharing-the-cli-config) to get the CLI's configuration.

All [SDK examples](../examples/sdk/) run offline with the faux model from `@glows777/vela/testing` and are typechecked with the repository.

## createVela options

`createVela(options?: VelaOptions): Vela`. Every option is optional.

| Option | Default | Description |
|---|---|---|
| `model` | none | Default model: `provider/id` (looked up in `providers` and providers registered by extensions) or an AI SDK `LanguageModel`. Without it, a session must call `setModel()`, or resume a session with a saved model, before it can prompt. |
| `providers` | `{}` | Model providers by name, `Record<string, ProviderDefinition>`. `loadConfig().providers` gives the built-in `openai` and `anthropic` providers plus those in `models.json`. See [Models](models.md). |
| `thinkingLevel` | `medium` | Thinking level for new sessions: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `autoCompaction` | `true` | Automatic compaction for new sessions (pi's `compaction.enabled`). `false`: no microcompaction, threshold summary or compact-and-retry on overflow; `compact()` still works. See [Sessions](sessions.md#turning-automatic-compaction-off). |
| `cwd` | `process.cwd()` | Working directory for file, search and bash tools and for skills. |
| `dataDir` | temp dir | Project data directory: `sessions/`, `usage/` and extension data such as `memory/` and `rag/`. Relative paths resolve against `cwd`. Without it nothing persists: sessions stay in memory and long tool output goes to a temp dir that `dispose()` deletes. The CLI uses the [project data directory](settings.md#data-directory) under `~/.vela/projects/`. |
| `sessionStorage` | see [Session storage](#session-storage) | Where session history is stored. |
| `skillDirs` | `<cwd>/.vela/skills`, `<cwd>/.skills` | Skill directories or files in the [Agent Skills format](settings.md#skills). The first skill with a name wins. |
| `promptTemplateDirs` | `<cwd>/.vela/prompts` | Prompt template directories or files; `/<name> args` expands one. See [Prompt templates](settings.md#prompt-templates). |
| `contextFiles` | `loadContextFiles({ cwd })` | `AGENTS.md` / `CLAUDE.md` files (`{ path, content }[]`) put into the system prompt of owner and collaborator sessions; `false` for none. `loadContextFiles({ cwd, agentDir })` finds them like the CLI. See [Context files](settings.md#context-files). |
| `appendSystemPrompt` | none | Text appended to the system prompt in an `<addendum>` section. |
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
| `models()` | Models listed by all providers (`ModelInfo`: `provider`, `id`, `ref`, `name`, `contextWindow`, `reasoning`, `cost`) |
| `session(id?, options?)` | Opens a session, or returns it if it is already open. `id` defaults to `default`. |
| `sessions()` | Open sessions |
| `listSessions()` | Saved sessions, newest first, from `SessionStorage.list()` (empty if the storage has no `list`). The built-in storages leave out sessions without messages; a custom storage's `list()` is passed through as is. |
| `subscribe(listener)` | Events from all sessions: `(event, sessionId) => void`. Returns an unsubscribe function. |
| `ready()` | Resolves when all extensions (including async factories) have loaded; rejects if one failed |
| `extensions()` | Loaded extensions and the tools, commands, providers and channels each registered |
| `commands()` | Slash commands registered by extensions |
| `channels()` | Channels registered by extensions |
| `startChannels()` | Starts all channels. See [Channels](channels.md). |
| `dispose()` | Stops channels, closes all sessions (aborting running work and saving) and deletes the temp data dir if there is one |

## Sessions

```typescript
const session = vela.session('support-42', {
  role: 'collaborator',
  permissions: { write_file: 'ask' },
  model: 'anthropic/<model-id>',
})
await session.resume() // restore saved history, if any
await session.prompt('Summarize the open issues')
```

A session id becomes a file name: letters, digits, `.`, `_` and `-`, not starting with `.`, at most 128 characters. Other ids throw.

`SessionOptions` apply only when the session is first opened; a second `vela.session(id, options)` returns the open session unchanged.

| Option | Default | Description |
|---|---|---|
| `role` | `owner` | `owner`, `collaborator` or `guest`. Decides which tools are available and whether extension commands run. See [Security](security.md). |
| `permissions` | none | Per-tool rules that tighten the role: tool name (or `*`) to `allow`, `deny` or `ask`, e.g. `{ bash: 'ask' }`. An exact name beats `*`. They cannot grant a tool the role denies (`allow` on it stays denied). `ask` calls `ui.confirm`; without a UI it refuses. |
| `tools` | all | Enable only these tools (still limited by the role) |
| `ui` | none | A `SessionUI` extensions use to talk to the user (`notify`, `confirm`, `select`, `input`, optional `setStatus`, `setWidget`). Without it `confirm` answers no, `select`/`input` answer nothing, and `notify` becomes a `notify` event. |
| `model` | Vela's model | `provider/id` or `LanguageModel` for this session |
| `thinkingLevel` | Vela's level | Thinking level for this session |
| `autoCompaction` | Vela's setting | Automatic compaction for this session |

### Session members

| Member | Description |
|---|---|
| `id` | Session id |
| `messages` | History (AI SDK `ModelMessage[]`). Treat it as read-only. |
| `append(message)` | Appends a message without calling the model |
| `prompt(input, options?)` | Appends a user message and runs the agent loop until it settles, then saves. See [Prompting](#prompting). |
| `steer(input)`, `followUp(input)` | Queue input while running; same as `prompt()` when idle |
| `queue`, `clearQueue()` | Copy of the queued messages; remove and return them |
| `steeringMode`, `followUpMode` | `one-at-a-time` (default) or `all`: how many queued messages are taken at once |
| `abort(reason?)` | Aborts the running loop and extension commands, and waits until the loop has stopped. Queued messages stay queued. |
| `waitForIdle()` | Waits for the running loop (including queued messages and manual compaction) without aborting it |
| `isRunning` | Whether an agent loop or compaction holds the run lock |
| `compact(focus?)` | Summarizes earlier history now and saves. `focus` says what the summary should prefer to keep. Throws while running. |
| `resume()` | Replaces the in-memory history with the saved one; returns `false` if nothing was saved. Restores the name, thinking level and (if resolvable) model. Throws while running. |
| `model`, `modelInfo` | Current `LanguageModel` and its `ModelInfo` |
| `setModel(model)` | Switches the model from the next prompt. Compaction limits are recomputed from the new context window. Throws, keeping the current model, if the name cannot be resolved. A model chosen by name is saved with the session. |
| `thinkingLevel`, `setThinkingLevel(level)` | Current level; set it from the next request. `prompt()` throws if the model entry has `reasoning: false` and the level is not `off`. |
| `role` | Get or set the role |
| `getActiveTools()` | Tool names the model can currently see (after role, selection and deferred loading) |
| `setActiveTools(names)` | Enable only these tools; `undefined` restores all |
| `name`, `setName(name)` | Display name, saved with the next save and shown in session lists |
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

`prompt()` resolves when the run is done, including tool calls, retries and every `steer` or `followUp` message queued during the run. If the loop fails, queued messages still run, then the promise rejects.

A session runs one loop at a time. Calling `prompt()` while it is running throws unless you say how to queue the input:

```typescript
await session.prompt('Refactor the parser')               // idle: runs
session.prompt('Also update the tests', { streamingBehavior: 'steer' })    // running: queued
session.prompt('Then write a changelog entry', { streamingBehavior: 'followUp' })
```

- `steer` joins the current task: it is sent as a user message after the current step's tools finish, before the next model request.
- `followUp` runs when the model would otherwise stop (no tool calls, no steer).

`steer(input)` and `followUp(input)` are shortcuts. While running they resolve as soon as the input is queued. `PromptOptions.signal` aborts the run like `abort()`.

Input starting with `/` that names an extension command runs the command instead of going to the model, in owner sessions, even while a loop is running. See [Extensions](extensions.md).

## Events

`session.subscribe()` receives that session's events; `vela.subscribe()` receives events from every session with the session id. Core never writes to the terminal: everything the CLI shows comes from these events.

Message and tool events have pi's shape (`message_start / message_update / message_end`, `tool_execution_start / update / end`, `auto_retry_start / end`); the messages in them are AI SDK `ModelMessage`s. One prompt produces:

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

Steered messages arrive as another `message_start` / `message_end` followed by another turn. Follow-ups are taken when the model would otherwise stop and continue in the same loop. `agent_end` closes one agent loop; if messages are still queued after an error or a loop-detection stop, a new loop starts; after an abort they stay queued for the next prompt. `agent_settled` comes last and means the session is idle and nothing else will run on its own.

| Type | Fields | When |
|---|---|---|
| `agent_start` | `input` | A loop starts handling user input (queued inputs taken together are joined with a blank line) |
| `turn_start` | `turn` | Before each model request (1-based within the loop) |
| `message_start` | `message` (`ModelMessage`) | A message starts: user input, the assistant reply, tool results (`tool-result` parts), loop-detection reminder. Every message except the streaming assistant one gets `message_start` and `message_end` back to back. |
| `message_update` | `message` (the assistant message so far), `assistantMessageEvent` | The assistant message is streaming. `assistantMessageEvent` says what changed, with pi's names: `text_start` / `text_delta` / `text_end`, `thinking_start` / `thinking_delta` / `thinking_end`, `toolcall_start` / `toolcall_delta` / `toolcall_end`; each has `contentIndex` (the part in `message.content`), deltas have `delta`, `toolcall_end` has `toolCall`. |
| `message_end` | `message`, `stopReason?`, `errorMessage?` | A message is complete. Assistant messages carry `stopReason`: `stop`, `toolUse`, `length` (cut off by the output limit), `aborted` or `error` (with `errorMessage`). The assistant `message_end` is the authoritative final text. |
| `tool_execution_start` | `toolCallId`, `toolName`, `args`, `parentToolCallId?` | A tool call is about to run (after the assistant `message_end`). `parentToolCallId` is set on a call a tool made with `ctx.executeTool()` (see [Extensions](extensions.md#registertool)); its id is `<parentToolCallId>/<n>` |
| `tool_execution_update` | `toolCallId`, `toolName`, `args`, `partialResult`, `parentToolCallId?` | Partial output of a running tool, for tools that stream it (`bash` sends the tail of its output as `{ content: [{ type: 'text', text }] }`) |
| `tool_execution_end` | `toolCallId`, `toolName`, `result`, `isError`, `durationMs?`, `parentToolCallId?` | A tool call finished. `result` is the output, or the error when `isError`. A call blocked by an extension or refused by a role or permission rule ends here with the reason as `result`. The result goes back to the model. |
| `loop_detected` | `level` (`warning` or `critical`), `detector`, `message` | Repeated tool calls were detected. `warning` adds a reminder to the history; `critical` stops the loop with `agent_end` reason `loop`. |
| `auto_retry_start` | `attempt`, `maxAttempts`, `delayMs`, `errorMessage` | A retryable model error; the request runs again after `delayMs`. The failed attempt's assistant message ended with `stopReason: 'error'` and is not in the history; the retry streams a new assistant message. See [Sessions](sessions.md#retries). |
| `auto_retry_end` | `success`, `attempt`, `finalError?` | Retrying ended: the request succeeded, or failed for good |
| `usage` | `modelId`, `usage` (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`), `record?` (adds `cost` in USD, absent when the model has no known price, `ts`, `model`, `kind` (`main` or `summary`), `durationMs` and the provider's raw `usage`) | After each model request |
| `turn_end` | `turn`, `message` (the assistant message), `toolResults` (`tool-result` parts) | After each model request and its tools, including one that was aborted or failed |
| `agent_end` | `messages` (the messages this loop added), `reason` (`done`, `loop`, `aborted`, `error`), `error?` | The loop ended. Queued messages may still start another loop. |
| `queue_update` | `steering`, `followUp` | The queues changed; both fields hold the full current queue as strings |
| `agent_settled` | | All work from `prompt()` is done and the session is idle |
| `context` | `action`, `before`, `after?`, `saved?`, `calls?` | Vela-specific context management: `micro` (old tool results folded) or `summary-required` (the summary threshold was reached but this run may not summarize). Token counts are estimates. See [Sessions](sessions.md#compaction). |
| `compaction_start` | `reason` (`threshold`, `manual`, `overflow`) | Summarizing earlier history starts (like pi): before a request that is too large, from `session.compact()`, or after the provider said the context is too long |
| `compaction_end` | `reason`, `result?` (`summary`, `firstKeptEntryId`, `tokensBefore`, `tokensAfter`, `messages`), `aborted`, `willRetry`, `errorMessage?` | Summarizing ended (like pi). `result` is set when it succeeded, `aborted` when it was interrupted, otherwise `errorMessage` says why it failed. `willRetry`: the request that overflowed is sent again |
| `session_save_failed` | `error` | Writing the session's entries failed (the run itself continued). The entries are kept and written again with the next entry or at the end of the run |
| `audit` | `toolName`, `path` | Before `write_file` or `edit_file` writes `path` |
| `security_warning` | `toolName`, `reason`, `command` | A bash command was rated medium risk; it still runs |
| `notify` | `message`, `level` (`info`, `warning`, `error`) | An extension called `ui.notify()` in a session without a UI. In RPC mode this is an [extension UI request](rpc.md#extension-ui) instead. |
| `channel_message` | `channel`, `senderId`, `senderName`, `text` | A channel received a message for this session |
| `channel_reply` | `channel`, `recipientId`, `text` | A channel sent a reply |
| `channel_error` | `channel`, `senderId`, `error`, `aborted` | A channel turn failed or was aborted |

The types are `VelaEvent`, `AssistantMessageEvent`, `StopReason`, `VelaEventListener` and `VelaSessionEventListener`. Extension lifecycle events (`session_start`, `before_agent_start`, `tool_call` interception, ...) are a separate API, see [Extensions](extensions.md). The CLI's `--mode json` and `--mode rpc` write these same events as JSON lines, see [JSON mode](json.md).

See [02-events.ts](../examples/sdk/02-events.ts).

## Multiple sessions

```typescript
const alice = vela.session('alice')
const bob = vela.session('bob', { role: 'guest' })
await Promise.all([alice.prompt('Hi'), bob.prompt('Hello')])
```

Sessions in one Vela run concurrently. Tool definitions, extensions, skills, memory and channels are shared; history, queues, compaction, usage, tool results, role and the run lock are per session. Channels rely on this: the gateway opens one session per conversation and sender (`<channel>-<channelId>-<senderId>`). See [03-multi-session.ts](../examples/sdk/03-multi-session.ts) and [Sessions](sessions.md#multiple-sessions).

## Session storage

| Setup | Storage |
|---|---|
| `sessionStorage` given | That storage |
| `dataDir` given | `fileSessionStorage('<dataDir>/sessions')`: one `<id>.jsonl` per session |
| neither | `memorySessionStorage()`: gone when the process exits |

```typescript
import { createVela, fileSessionStorage, memorySessionStorage } from '@glows777/vela'

createVela({ dataDir: '.vela-data' })                          // files under .vela-data/sessions
createVela({ dataDir: '.vela-data', sessionStorage: memorySessionStorage() }) // keep memory/rag data, not sessions
createVela({ sessionStorage: fileSessionStorage('/var/lib/app/sessions') })
```

A custom storage implements `SessionStorage`:

```typescript
interface SessionStorage {
  load(id: string): Promise<SessionFileEntry[] | undefined> // header first, then entries, in append order
  append(id: string, entries: SessionFileEntry[]): Promise<void>
  list?(): Promise<SessionSummary[]> // optional, newest first
}
```

A session is an append-only list of entries in pi's format: a header, then one entry per message, compaction, context edit or setting change (see [Session format](session-format.md)). Vela calls `append` as entries happen (the first call of a new session starts with the header) and never rewrites them; `load` returns everything appended, in order. Store entries as given. `summarizeSession(id, entries)` builds a `list()` row, and `migrateSessionV1(id, lines)` converts data saved by Vela 0.1's checkpoint storage. See [04-custom-storage.ts](../examples/sdk/04-custom-storage.ts).

`session.getEntries()` returns a session's entries, including messages that were summarized or are no longer sent to the model.

Long tool output and the tool call history are always written to files under `<dataDir>/sessions/<id>/`, whatever the storage. The session header refers to that history; resuming with a persistent `dataDir` where the history is missing throws instead of continuing with a broken reference. Without `dataDir` (temp dir), resume logs a warning and starts the tool history over.

## Sharing the CLI config

`loadConfig()` reads the same files the CLI reads (`~/.vela/settings.json`, `~/.vela/models.json`, `AGENTS.md` / `CLAUDE.md`, and with `trusted: true` the project's `.vela/settings.json`, extensions, skill and prompt directories and `APPEND_SYSTEM.md`) and returns values ready for `createVela()`. It only reads files; it never loads extension code.

```typescript
import {
  createVela, feishu, importExtension, loadConfig, memory, rag, web,
  type VelaExtension,
} from '@glows777/vela'

const builtins: Record<string, () => VelaExtension> = {
  memory: () => memory(), rag: () => rag(), web: () => web(),
  feishu: () => feishu(),
}
const config = loadConfig({ cwd: process.cwd(), env: process.env, builtins: Object.keys(builtins) })

const extensions: VelaExtension[] = []
for (const entry of config.extensions)
  extensions.push('builtin' in entry ? builtins[entry.name]!() : await importExtension(entry.path, entry.name))

const vela = createVela({
  model: config.settings.defaultModel,
  providers: config.providers,
  thinkingLevel: config.settings.defaultThinkingLevel,
  cwd: config.cwd,
  dataDir: config.dataDir,
  skillDirs: config.skillDirs,
  promptTemplateDirs: config.promptDirs,
  contextFiles: config.contextFiles,
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
| `trusted` | `false` | Also load the project's `.vela/settings.json`, `.vela/extensions/`, skills (`.vela/skills/`, `.agents/skills/`, `.skills/`, returned in `skillDirs`), `.vela/prompts/` and `.vela/APPEND_SYSTEM.md` |
| `homeDir` | `os.homedir()` | Home directory for `~/.agents/skills` |
| `builtins` | `[]` | Names of built-in extensions to list in `extensions`; `-builtin:<name>` in settings removes one |

The result (`VelaConfig`) has `cwd`, `agentDir`, `dataDir`, `settings` (merged `VelaSettings`), `files` (settings files read), `extensions` (`ExtensionEntry[]`), `skillDirs`, `promptDirs`, `contextFiles`, `appendSystemPrompt` (when an `APPEND_SYSTEM.md` exists), `providers` and `extensionConfig`. `loadModels({ agentDir, env })` returns only the providers. See [Settings](settings.md) and [Models](models.md).

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
import { createVela, memory, rag, createEmbedder, web, feishu } from '@glows777/vela'

const vela = createVela({
  dataDir: '.vela-data',
  extensions: [
    memory(),
    rag({ embedder: createEmbedder({ modelId, apiKey, url }) }),
    web({ tavilyKey: process.env.TAVILY_API_KEY }),
  ],
})
```

Options not passed to a factory are read from its `extensionConfig` section. See [Built-in extensions](built-in-extensions.md) and [Channels](channels.md) for `feishu()`.

## Disposal

Call `await vela.dispose()` when you are done. It stops channels, aborts running sessions, waits for them to save, fires `session_shutdown` for extensions and, when there is no `dataDir`, deletes the temp data dir. A disposed Vela throws on `session()`.

`await session.close()` closes one session the same way and removes it from the Vela; a later `vela.session(id)` opens a fresh object for that id (call `resume()` to reload its history).

## Testing

`@glows777/vela/testing` provides `createFauxModel()` (scripted responses), `createTestVela()` (a real Vela in a temp dir), a faux embedder, and recording and replay of real runs. See [Testing](testing.md).

## Examples

| Example | Purpose |
|---|---|
| [01-minimal.ts](../examples/sdk/01-minimal.ts) | One session, one prompt, print the answer |
| [02-events.ts](../examples/sdk/02-events.ts) | Subscribe to events, including a tool call |
| [03-multi-session.ts](../examples/sdk/03-multi-session.ts) | Two sessions running concurrently in one Vela |
| [04-custom-storage.ts](../examples/sdk/04-custom-storage.ts) | A custom `SessionStorage` and resuming from it |

## API stability

The public surface is:

- the exports of `@glows777/vela` and `@glows777/vela/testing` (snapshot in `api/public-api.txt`; regenerate it with `bun run api:update`, and a unit test fails when the exports change without it),
- CLI flags,
- `settings.json` and `models.json` keys,
- the `--mode json` event stream and the RPC protocol,
- event types,
- the session file format.

Anything marked `@internal` in the type declarations is not covered.

During 0.x, a breaking change bumps the minor version (0.1 to 0.2); patch releases don't break anything. Every breaking change is listed under "Breaking Changes" in [CHANGELOG.md](../CHANGELOG.md) with migration notes.
