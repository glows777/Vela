# SDK examples

Programmatic use of Vela through `createRuntime()` (and `connectRuntime()` via [daemon-client.ts](../daemon-client.ts)). Each SDK example is a single file that runs offline: it uses the scripted faux model from `@glows777/vela/testing`, so no API key or network is needed.

## Examples

| File | Description |
|---|---|
| `01-minimal.ts` | One in-memory runtime (`ephemeral: true`), one session, one prompt |
| `02-events.ts` | Subscribe to Runtime events and deltas; the model calls `read` in a temp project |
| `03-multi-session.ts` | Two sessions running concurrently in one Runtime, with `runtime.events.subscribe()` |
| `04-custom-storage.ts` | Persistent SQLite sessions across Runtime instances with `createRuntime({ agentDir })` |
| `05-images.ts` | Inbound image attachment (`blobs.storeInbound`), text-only fallback, and resume |
| `06-tool-images.ts` | Inline `VelaExtension` tool_result hook normalizing tool images and resuming |

## Running

From the repository root:

```bash
bun examples/sdk/01-minimal.ts
```

Inside the repository, development maps each public entry to its source, so focused tests and the watched CLI see source edits immediately. Builds clear these mappings; packed Node/Bun consumers verify real export maps. `bunx tsc --noEmit` typechecks the examples with the rest of the repository.

## Using a real model

The faux model replays the responses each example scripts. A real app passes a real model instead:

```typescript
import { createRuntime, loadConfig } from '@glows777/vela'

// `provider/id`, with providers from loadConfig() + ~/.vela/config.json
const config = loadConfig({ env: process.env })
const runtime = createRuntime({
  defaultModel: 'anthropic/<model-id>',
  providers: config.providers,
  hostEnv: process.env,
})
```

or any AI SDK `LanguageModel`:

```typescript
import { createOpenAI } from '@ai-sdk/openai'
import { createRuntime } from '@glows777/vela'

const runtime = createRuntime({
  defaultModel: createOpenAI({ apiKey: process.env.OPENAI_API_KEY })('<model-id>'),
})
```

See [docs/sdk.md](../../docs/sdk.md) for the full API and [docs/models.md](../../docs/models.md) for providers.
