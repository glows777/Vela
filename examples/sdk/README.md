# SDK examples

Programmatic use of Vela through `createVela()`. Each example is a single file that runs offline: it uses the scripted faux model from `@glows777/vela/testing`, so no API key or network is needed.

## Examples

| File | Description |
|---|---|
| `01-minimal.ts` | One session, one prompt, print the answer |
| `02-events.ts` | Subscribe to session events; the model calls `read_file` in a temp directory |
| `03-multi-session.ts` | Two sessions running concurrently in one Vela, with `vela.subscribe()` |
| `04-custom-storage.ts` | A custom `SessionStorage`, and resuming a session from it in a second Vela |

## Running

From the repository root:

```bash
bun examples/sdk/01-minimal.ts
```

Inside the repository, `@glows777/vela` resolves to `src/` through `tsconfig.json` paths, so no build is needed. `bunx tsc --noEmit` typechecks the examples with the rest of the repository.

## Using a real model

The faux model replays the responses each example scripts. A real app passes a real model instead:

```typescript
import { createVela, loadConfig } from '@glows777/vela'

// `provider/id`, with providers from loadConfig() (built-in openai / anthropic + ~/.vela/models.json)
const config = loadConfig({ env: process.env })
const vela = createVela({ model: 'anthropic/<model-id>', providers: config.providers })
```

or any AI SDK `LanguageModel`:

```typescript
import { createOpenAI } from '@ai-sdk/openai'

const vela = createVela({ model: createOpenAI({ apiKey: process.env.OPENAI_API_KEY })('<model-id>') })
```

See [docs/sdk.md](../../docs/sdk.md) for the full API and [docs/models.md](../../docs/models.md) for providers.
