# SDK

`@glows777/vela` embeds Vela in a Node.js (>= 22.18) or Bun (>= 1.4) process. It gives TypeScript code the same agent the `vela` command runs: models, tools, system prompt, SQLite sessions, compaction, background jobs, approvals, channels, and extensions.

Use `createRuntime()` for in-process integration or `connectRuntime()` to talk to the local daemon (`vela daemon`) over IPC. For one-shot scripting from another language or process, run `vela --mode json` (see [JSON mode](json.md)).

```typescript
import { createRuntime } from '@glows777/vela'

const runtime = createRuntime({
  defaultModel: 'openai/<model-id>',
  hostEnv: process.env,
})

try {
  await runtime.ready()
  const project = await runtime.projects.create({
    name: 'main',
    cwd: process.cwd(),
    hubSessionId: true,
  })
  const sessionId = project.hubSessionId!
  const off = runtime.events.subscribeDeltas((delta) => {
    if (delta.sessionId === sessionId && delta.type === 'text_delta') {
      process.stdout.write(delta.delta)
    }
  })
  try {
    await runtime.prompt(sessionId, {
      text: 'What files are in the current directory?',
    })
    await runtime.waitForIdle(sessionId)
  } finally {
    off()
  }
} finally {
  await runtime.dispose()
}
```

`createRuntime()` assembles a single SQLite-backed Runtime (`<agentDir>/vela.db`, or `:memory:` when `ephemeral: true`). One Runtime manages projects, concurrent sessions, extensions, models, timers, subscriptions, and channel adapters through the same asynchronous `VelaRuntime` contract that `connectRuntime()` exposes over `<agentDir>/vela.sock` (or Windows named pipe).

When `ephemeral` is `false` or omitted, `createRuntime()` loads `<agentDir>/config.json` and `<agentDir>/auth.json`, with `hostEnv` defaulting to `{}` (pass `hostEnv: process.env` explicitly if you want ambient API-key env vars or `VELA_DIR`). When `ephemeral: true`, it isolates completely from on-disk `config.json`, `auth.json`, and user MCP configuration unless explicitly passed.

All [SDK examples](../examples/sdk/) run offline with the faux model from `@glows777/vela/testing` and are typechecked with the repository.

## Packages

Vela publishes a single npm package, `@glows777/vela`, with explicit export-map entries:

| Entry | Public contract |
|---|---|
| `@glows777/vela` | Root Runtime & Daemon SDK (`createRuntime`, `connectRuntime`, `getDaemonStatus`, `startDaemon`, `stopDaemon`, `startDaemonServer`, `DaemonAlreadyRunningError`, `EnvironmentRegistry`, `RuntimeWebhookReceiver`, `createLarkChannelAdapter`, `LarkChannelAdapter`, `larkConfig`, `loadConfig`, `loadModels`, `fileCredentialStore`, `memoryCredentialStore`, `createLocalExecutionEnv`, `silentLogger`) and the `vela` CLI/TUI |
| `@glows777/vela/extension-api` | Extension authoring types (`ExtensionAPI`, `VelaExtension`, hook event/result types) and helpers (`createJsonSchema`, `defineJsonSchemaTool`, `ToolExecutionResult`, `SpilledToolOutput`, `configString`, `configStrings`, `customMessageIfChanged`, `customMessageMissing`, `lastCustomMessage`, `messageText`, `silentLogger`) |
| `@glows777/vela/testing` | Offline faux model, test harness (`createTestVela`), and scenario recording/replay |

Only listed export-map entries are supported. Private `src/` or `dist/` paths and retired entry points (`@glows777/vela/legacy-desktop`, removed in v0.9) are not package APIs. Heavy optional integrations (`@larksuiteoapi/node-sdk`, `@modelcontextprotocol/sdk`, `@earendil-works/pi-tui`, `@silvia-odwyer/photon-node`) are loaded lazily on demand and stay off the cold-start import graph. For production artifacts run `bun run build`; development maps the declared export entries to source, while package builds clear the mapping so packed consumers resolve the real artifacts.

## createRuntime options

`createRuntime(options?: CreateRuntimeOptions): LocalVelaRuntime`. Every option is optional.

| Option | Default | Description |
|---|---|---|
| `agentDir` | `defaultAgentDir(hostEnv)` (`~/.vela`) | Root agent directory owning `<agentDir>/vela.db`, `<agentDir>/blobs/`, `<agentDir>/config.json`, and `<agentDir>/auth.json` (or temp dir when `ephemeral: true` and `agentDir` is omitted). |
| `allowLocalOnlyOAuth` | `true` | Allow `localOnly` OAuth tokens (such as terminal ChatGPT OAuth) when no channel is bound; set `false` for channel-only isolation. |
| `appendSystemPrompt` | none | Extra system prompt text appended inside `<addendum>`. |
| `autoCompaction` | `true` | Default automatic context compaction state (`config.json` `autoCompaction` overrides unless explicitly passed). |
| `contextFiles` | auto-discovered | Preloaded `ContextFile[]` instructions injected into session prompts. |
| `credentials` | `fileCredentialStore` or `memoryCredentialStore` | `CredentialStore` used for API keys and OAuth tokens (`memoryCredentialStore()` when `ephemeral: true`). |
| `defaultModel` | none / `config.json` | Default model ref (`'provider/id'`) or AI SDK `LanguageModel` for sessions without a specific override. |
| `defaultThinkingLevel` | `'medium'` / `config.json` | Default thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `docs` | package docs | `{ readme?, docs?, examples? }` paths rendered into `<docs>`, or `false` to omit `<docs>`. Defaults to `@glows777/vela`'s bundled README, `docs/`, and `examples/`. |
| `dreamEnabled` | `true` / `config.json` | Enable automatic Dream memory consolidation (`memory.dream`). |
| `drivers` | `[VelaDriver]` | Additional custom `AgentDriver` implementations registered alongside the built-in `VelaDriver`. |
| `environments` | `config.json` | Declarative Docker environment definitions or a pre-constructed `EnvironmentRegistry` (ignored when `ephemeral: true` unless passed). |
| `ephemeral` | `false` | Use `:memory:` SQLite DB and isolate completely from on-disk `config.json`, `auth.json`, and user `mcpServers`. |
| `ephemeralSessions` | `false` | Use `:memory:` SQLite DB while still reading owner `config.json`, `auth.json`, and memory from `agentDir`. |
| `extensionConfig` | `config.json` | Per-extension configuration map keyed by extension name (merged on top of `<agentDir>/config.json` `extensionConfig`). |
| `extensions` | `[]` | Additional host extensions (file/directory specs or inline `VelaExtension` factories) merged after `<agentDir>/config.json` `extensions`. |
| `hostEnv` | `{}` | Environment variables used for `$VAR` provider interpolation and default `VELA_DIR`. Core never reads `process.env` implicitly: `hostEnv` defaults to `{}` (pass `hostEnv: process.env` explicitly when ambient env vars are desired). |
| `ignoredChannels` | `[]` | Channel names owned outside this Runtime instance (skipped during `recover()` and scheduled wakes). |
| `limits` | derived from model | Overrides for retry, compaction, input, and bash timeout limits (`Partial<VelaLimits>`). See [Settings](settings.md#limits). |
| `logger` | `silentLogger` | A `VelaLogger` for runtime and extension diagnostics (`info`, `warn`, `error`, `debug`). |
| `mcp` | `true` | Enable per-project MCP connection pooling (`mcpServers` from config); set `false` to disable MCP completely. |
| `offline` | `false` | Disable automatic binary downloads (`rg`, `fd`) and stay offline-only. |
| `promptTemplates` | auto-discovered | Preloaded `PromptTemplate[]` definitions for `/<name>` command expansion. |
| `providers` | `{}` | Custom `ProviderDefinition` entries merged after `loadModels()`. |
| `shellPath` | platform shell / `config.json` | Override shell executable path used for local `bash` execution. |
| `skills` | auto-discovered | Preloaded `SkillDefinition[]` entries included in session system prompts. |
| `systemPrompt` | none | Override system prompt text (replaces default intro paragraph and omits `<tools>`, `<rules>`, and `<docs>`). |
| `toolApprovalCheck` | none | Host callback invoked before tool calls to request human approval (`{ requireApproval, summary }`). |
| `tools` | none | Additional host `ToolDefinition[]` registered alongside built-in tools. |
| `trustOverride` | none | Async/sync predicate `(location) => boolean` overriding `trusted_paths` DB lookups (useful for tests or ephemeral hosts). |

## connectRuntime() and VelaRuntime

`connectRuntime(options?: ConnectRuntimeOptions): Promise<VelaRuntime>` connects over `<agentDir>/vela.sock` (or Windows named pipe) to the resident single-writer daemon (`vela daemon`), auto-starting it unless configured otherwise. Both `createRuntime()` and `connectRuntime()` implement the JSON-serializable `VelaRuntime` contract (with `Uint8Array` blob payloads base64-encoded on IPC, sync unsubscribe functions for `events.subscribe` / `events.subscribeDeltas`, and `AbortSignal` support on `login` / `logout`).

Key `VelaRuntime` namespaces and methods:

| Area | Members |
|---|---|
| Lifecycle | `agentDir`, `ready()`, `extensionErrors()`, `reloadConfig()`, `recover()`, `dispose()` |
| Projects & Trust | `projects.{list,get,getByCwd,create,update,remove}`, `trust.{check,approve}`, `oauthRegistrations.{get,set,delete}` |
| Sessions | `sessions.{list,listSummaries,get,create,rename,delete,reset,status,messages,configure,setModel,setThinkingLevel,compact,tree,navigateTree,setLabel,fork,clone,inspect,execBash,abortBash,runCommand,clearQueue,export}` |
| Turns & Approvals | `prompt(sessionId, input)`, `steer(sessionId, text, images?)`, `stop(sessionId, reason?, options?)`, `waitForIdle(sessionId?)`, `jobs.{list,stop,promoteForeground}`, `approvals.{list,resolve}` |
| Automation & Channels | `timers`, `subscriptions`, `bindings`, `channels.{list,setEnabled,chats,submit,subscribe}` |
| Settings, Blobs & Events | `settings.{get,saveModel,saveLark,discoverLarkGroup,confirmLarkGroup,cancelLarkSetup}`, `blobs.{get,list,read,storeInbound}`, `events.{list,bufferedDeltas,subscribe,subscribeDeltas}` |
| Models & Auth | `models({ all?, channel?, env? })`, `loginProviders()`, `login(provider, method, interaction, options?)`, `logout(provider, { signal?, forget? })` |

`LocalVelaRuntime` (returned by `createRuntime()`) additionally provides host-local methods not sent over daemon IPC: `registerChannel(adapter)`, `unregisterChannel(name)`, `registerDriver(driver)`, `ingestWebhookEvent(event, defaultTarget?)`, `getWebhookConfig()`, and `getLarkConfig()`.

### Daemon helpers

- `getDaemonStatus(options?)`, `startDaemon(options?)`, `stopDaemon(options?)`: inspect, start, and stop the background daemon programmatically.
- `startDaemonServer(options?)` & `DaemonAlreadyRunningError`: host the single-writer daemon server directly inside a host process (used by CLI and Electron Desktop).
- `EnvironmentRegistry` & `RuntimeWebhookReceiver`: manage Docker execution environments and authenticated GitHub/generic webhook ingestion.

### Multiple sessions & prompting

One Runtime can run many sessions concurrently (`projects.create` + `sessions.create`). A session's queue accepts `steer(sessionId, text)` while running, or `prompt(sessionId, input)` to queue into `inbox_events`. Input starting with `/` that matches a built-in command (`/memory`, `/dream`, `/tasks`, `/bashes`, `/cache`) or an extension command executes directly instead of calling the model (`runtime.sessions.runCommand()`).

See [03-multi-session.ts](../examples/sdk/03-multi-session.ts) and [daemon-client.ts](../examples/daemon-client.ts).

## Sessions

Use `runtime.sessions.*` to create, inspect, list, rename, delete, reset, pause/resume (`waitForIdle`), configure (`model`, `thinkingLevel`, `tools`, `cwd`), and export sessions backed by `vela.db`.

### Session tree

Session transcripts form an append-only tree persisted in SQLite (`vela_messages`). Use `runtime.sessions.tree(sessionId)`, `runtime.sessions.navigateTree(sessionId, targetId, options?)`, `runtime.sessions.setLabel(sessionId, entryId, label)`, `runtime.sessions.fork(sessionId, entryId, options?)`, and `runtime.sessions.clone(sessionId, options?)` to branch and summarize without mutating historical entries. See [Sessions](sessions.md#session-tree).

## Events

`runtime.events.subscribe(listener)` receives durable state events persisted in SQLite `events(seq)` (`RuntimeEvent`), and `runtime.events.subscribeDeltas(listener)` receives live high-frequency streaming frames (`StreamDeltaEvent`):

- **`RuntimeEvent` payloads**: `run_started`, `message_committed`, `tool_started`, `tool_finished`, `approval_requested`, `approval_resolved`, `auto_retry_start`, `auto_retry_end`, `compaction_started`, `compaction_finished`, `compaction_failed`, `notify`, `audit`, `run_finished`, `session_reset`.
- **`StreamDeltaEvent` frames**: `text_delta`, `thinking_delta`, `toolcall_end`, `tool_output_delta`, `bash_output_delta`.

See [02-events.ts](../examples/sdk/02-events.ts) and [JSON mode](json.md).

### Failed agent runs

When `run_finished` has `status: 'failed'`, `errorKind` carries a closed classification (`auth`, `billing`, `rate_limit`, `network`, `context_overflow`, `provider`, `unknown`) alongside `error` and an optional human-actionable `errorHint`.

## Image input

Store inbound images via `runtime.blobs.storeInbound(...)` and attach them on `runtime.prompt(sessionId, { text, attachments: [{ blobId, name, mimeType, inlineOnly: true }] })` (or pass base64 `{ data, mimeType }` images to `runtime.steer(...)`).

Vela detects PNG, JPEG, GIF, WebP, and BMP by bytes, applies EXIF orientation, and uses Photon WASM to resize images to a longest side of 2000 px and at most 4.5 MiB base64 (preserving alpha as PNG, encoding opaque images as JPEG quality 80). Normalized images persist in SQLite (`vela.db`) and degrade cleanly to `(image omitted: model does not support images)` on text-only models. See [05-images.ts](../examples/sdk/05-images.ts) and [06-tool-images.ts](../examples/sdk/06-tool-images.ts).

### Tool images

`read` detects JPEG/PNG/GIF/WebP/BMP from file headers regardless of extension. Extension tools from `@glows777/vela/extension-api` return `new ToolExecutionResult(details, content)` with `ToolContent` arrays containing `{ type: 'image', data, mimeType }`, normalized after `tool_result` hooks. See [06-tool-images.ts](../examples/sdk/06-tool-images.ts).

## Session storage

| Setup | Storage |
|---|---|
| CLI (default) / `vela daemon` | Consolidated SQLite WAL DB at `$VELA_DIR/vela.db` (`~/.vela/vela.db`); project files and blobs live under `$VELA_DIR` |
| `createRuntime({ agentDir })` | Persistent SQLite WAL DB at `<agentDir>/vela.db` |
| `createRuntime({ ephemeral: true })` | In-memory SQLite (`:memory:`), isolated from disk config/auth, cleaned up on `dispose()` |
| `createRuntime({ ephemeralSessions: true })` | In-memory SQLite (`:memory:`) while retaining owner `config.json`/`auth.json`/memory at `agentDir` |

Long tool outputs are spilled to files under `<agentDir>/sessions/<id>/tool-results/` (or a temp directory when `ephemeral` / `ephemeralSessions` is set), with previews and paths recorded in SQLite `vela_tool_calls`. See [04-custom-storage.ts](../examples/sdk/04-custom-storage.ts).

## Sharing config and models

`loadConfig({ cwd, agentDir, env, trusted })` resolves `<agentDir>/config.json`, context files, skills, prompt templates, and `mcpServers` without executing extension code; `loadModels({ agentDir, env, providers })` resolves provider definitions; `fileCredentialStore(path)` and `memoryCredentialStore()` manage credentials; `createLocalExecutionEnv({ cwd, shellPath })` constructs a local `ExecutionEnv`; and `silentLogger` supplies a no-op `VelaLogger`.

## Built-in capabilities & extensions

Built-in capabilities (`background`, `memory`, `todo`, `web`, `mcp`) are enabled automatically in `createRuntime()` and configured via top-level keys in `<agentDir>/config.json` (plus `CreateRuntimeOptions` such as `mcp: false`, `dreamEnabled`, `extensionConfig`, or `extensions: ['-builtin:lark']`). Pass inline `VelaExtension` factories or file specs directly to `createRuntime({ extensions: [...] })`, importing extension authoring helpers (`ExtensionAPI`, `VelaExtension`, `createJsonSchema`, `defineJsonSchemaTool`, `ToolExecutionResult`, `SpilledToolOutput`, `configString`, `customMessageIfChanged`) from `@glows777/vela/extension-api`. See [Extensions](extensions.md) and [Built-in extensions](built-in-extensions.md).

## Testing

`@glows777/vela/testing` provides `createFauxModel()` (scripted responses), `createTestVela()` (driver test harness in a temp dir), `loadFauxScenario()`, and `recordModel()` / `replayScenario()`. See [Testing](testing.md).

## Examples

| Example | Purpose |
|---|---|
| [01-minimal.ts](../examples/sdk/01-minimal.ts) | One ephemeral runtime, one session, one prompt |
| [02-events.ts](../examples/sdk/02-events.ts) | Subscribe to `RuntimeEvent` and `StreamDeltaEvent` streams |
| [03-multi-session.ts](../examples/sdk/03-multi-session.ts) | Two sessions running concurrently in one Runtime |
| [04-custom-storage.ts](../examples/sdk/04-custom-storage.ts) | Persistent SQLite sessions across Runtime instances using `agentDir` |
| [05-images.ts](../examples/sdk/05-images.ts) | Inbound blob image attachments, fallback, and resume |
| [06-tool-images.ts](../examples/sdk/06-tool-images.ts) | Inline `VelaExtension` normalizing tool image outputs |
| [daemon-client.ts](../examples/daemon-client.ts) | Connecting to a running `vela daemon` via `connectRuntime()` |

## API stability

The public surface is:

- the exports of `@glows777/vela`, `@glows777/vela/extension-api`, and `@glows777/vela/testing` (snapshots in `packages/vela/api/public-api.txt`; regenerate with `bun run api:update`, verified by `packages/vela/test/public-api.test.ts`),
- CLI flags,
- `config.json` keys,
- the `--mode json` event stream (`RuntimeEvent` + `StreamDeltaEvent`),
- event types,
- the SQLite session model and JSONL export format.

Anything marked `@internal` in the type declarations is not covered.

During 0.x, a breaking change bumps the minor version; patch releases don't break anything. Every breaking change is listed under "Breaking Changes" in [CHANGELOG.md](../CHANGELOG.md) with migration notes.
