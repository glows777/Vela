# Testing

Vela ships the tools it uses for its own tests, so extension and SDK authors can test offline, with no API key and no network. They live in the `@glows777/vela/testing` subpath:

```ts
import { createTestVela, fauxText, fauxToolCall } from '@glows777/vela/testing'
```

| Export | What it does |
|---|---|
| [`createFauxModel()`](#faux-model) and the `faux*` helpers | A scripted model that plays back responses you write. |
| [`createTestVela()`](#createtestvela) | A real Vela assembled in a temp directory with the faux model. |
| [`recordModel()`, `replayScenario()`](#record-and-replay) | Record a real model run as a scenario file, then replay it offline. |
| [`createFauxEmbedder()`](#faux-embedder) | Deterministic offline embeddings for the RAG extension. |
| `loadFauxScenario()`, `readFauxScenario()` | Read a scenario JSON file (as a model, or as data). |
| `tempDir()`, `cleanupTestVelas()` | Temp directories and cleanup. |

The CLI has two related switches: `VELA_MODEL=faux:<file.json>` replays a scenario and `VELA_RECORD=<file.json>` records one; see [Record and replay](#record-and-replay). `VELA_MODEL=mock` starts the CLI with a [demo model](#demo-model) for trying it by hand.

## Faux model

The faux model implements the AI SDK's `LanguageModelV4` and plays back a script of responses in order. Everything around it is real: streaming, tool execution, retries, hooks, context compaction and session saving. Every request is recorded, so tests can assert on what the model was sent.

```ts
import {
  createFauxModel,
  fauxError,
  fauxHang,
  fauxStreamError,
  fauxSummary,
  fauxText,
  fauxToolCall,
} from '@glows777/vela/testing'

const model = createFauxModel({
  responses: [
    fauxToolCall('read_file', { path: 'a.txt' }),             // one tool call
    [fauxToolCall('grep', { pattern: 'TODO' }), fauxToolCall('find', { pattern: '*.ts' })], // several in one response
    (req) => fauxText(`Read: ${req.toolResults[0]?.output}`),  // computed from the request
    fauxError('429 Too Many Requests'),                         // the request fails
    fauxStreamError('ECONNRESET', 'partial text'),              // the stream breaks midway
    fauxHang('thinking'),                                       // never finishes until aborted
    fauxText('done', { usage: { input: 900, output: 10 }, finishReason: 'length' }),
  ],
  generate: [fauxSummary()], // separate queue for compaction summaries
  chunkSize: 8,              // characters per text_delta (default 8; 0 or less = one chunk)
  chunkDelayMs: 0,           // delay between chunks
  cache: true,               // simulate prompt caching
})
```

Pass it as the model to [`createVela()`](sdk.md) or to `createTestVela()`, which creates one for you.

### Responses

A script step is a `FauxResponse` object, an array of them (merged into one response, for parallel tool calls), or a function `(req) => FauxResponse | FauxResponse[]`.

| Helper | Response |
|---|---|
| `fauxText(text, options?)` | A text answer. |
| `fauxToolCall(name, input, options?)` | One tool call. `options.id` sets the call id (default `faux-call-<request>-<index>`). Extension tools are named `<extension>_<tool>`. |
| `fauxError(error)` | The request fails with no output. `error` is a message (`'429 ...'`, `'503 ...'` are retried like real provider errors) or an `Error`, such as an AI SDK `APICallError`. |
| `fauxStreamError(message, partialText?)` | Streams `partialText`, then fails. |
| `fauxHang(partialText?)` | Streams `partialText`, then waits until the request is aborted. Use it to test abort, steering and "while running" behavior. |
| `fauxSummary(pick?)` | A valid compaction summary for the request it answers. Put it in `generate`. |

A `FauxResponse` is plain JSON (`text`, `reasoning`, `toolCalls`, `finishReason`, `usage`, `error`, `streamError`, `hang`), so the same script can be saved as a scenario file. Usage is estimated from character counts unless you set `usage`, so it is deterministic.

### Requests

| Member | Meaning |
|---|---|
| `model.calls` | Every request so far, in order. |
| `model.pending()` | Responses not used yet (both queues). |
| `model.push(...steps)`, `model.pushGenerate(...steps)` | Append to the main or generate queue. |

Each request (`FauxRequest`, also passed to function steps) has `index` (1-based), `kind` (`stream` or `generate`), `system`, `prompt` (the raw AI SDK prompt), `tools` (tool names offered), `lastUserText`, `toolResults` (`{ toolCallId, toolName, output, raw }` of the latest tool step), `responseFormat`, `reasoning` (the thinking level as sent) and `abortSignal`.

A request after the script runs out fails at once with `faux: no scripted response for request #N`, instead of hanging.

## createTestVela

`createTestVela()` builds a Vela with the real `createVela()`, a faux model, a fresh temp directory as `cwd` and a data directory inside it. It records every event from every session.

```ts
const t = createTestVela({
  extensions: [myExtension],               // the extensions under test
  responses: [fauxToolCall(...), fauxText(...)],
  files: { 'src/a.ts': 'export const a = 1\n' }, // created in the temp cwd
})
await t.run('read src/a.ts')               // = t.session.prompt()
```

The built-in memory extension is always loaded, like in the CLI; the RAG extension is loaded with `embedder`. Web and Feishu are not loaded.

### Options

| Option | Meaning |
|---|---|
| `responses`, `generate` | Faux script (main queue, compaction-summary queue). |
| `faux` | Other faux options: `chunkSize`, `chunkDelayMs`, `cache`, `modelId`. |
| `model`, `providers` | Use a real model or `provider/id` instead of faux (`t.model` then throws). |
| `extensions` | Extensions to load after the built-ins. |
| `extensionConfig` | Per-extension config sections (`vela.config`), keyed by extension name. |
| `session` | Options for the default session: `role`, `permissions`, `tools`, `ui`. |
| `sessionId` | Id of the default session (default `default`). |
| `files` | Files to create in `cwd`, as relative path to content. |
| `skills` | Skills to write to `cwd/.skills/<name>/SKILL.md` (`name`, `description`, `body`, `disableModelInvocation?`). |
| `embedder` | `true` loads RAG with the faux embedder, or pass your own. |
| `cwd`, `dataDir` | Reuse a directory (for resume tests); `dataDir` is relative to `cwd`, default `.vela-data`. |
| `thinkingLevel`, `limits`, `logger` | Same as `createVela()`. `limits.retryBaseMs` defaults to 0 so retries don't wait. |
| `allowPendingResponses` | Don't fail cleanup when script responses are left over. |

### The test handle

| Member | Meaning |
|---|---|
| `t.vela`, `t.session` | The Vela and its default session. |
| `t.run(input, options?)` | `t.session.prompt()`. Extension commands work too: `t.run('/todo add x')`. |
| `t.model` | The faux model (`calls`, `pending()`, `push()`). |
| `t.events`, `t.eventTypes()` | All events, and their types in order. |
| `t.eventsOf(type)` | Events of one type, typed. |
| `t.eventsIn(sessionId)` | Events of one session. |
| `t.clearEvents()` | Forget recorded events. |
| `t.streamedText()`, `t.lastAssistantText()`, `t.messages` | Streamed text, last answer, session history. |
| `t.cwd`, `t.path(rel)`, `t.readFile(rel)`, `t.writeFile(rel, text)` | Files in the temp cwd. |
| `t.dataDir`, `t.dataPath(rel)`, `t.readData(rel)`, `t.exists(rel)` | Files in the data directory (`sessions/`, `usage/`, `memory/`, `rag/`). |
| `t.tracker()` | The default session's usage tracker. |
| `t.cleanup({ keepDir? })` | Dispose and delete the temp directory. |

Call `cleanupTestVelas()` in `afterEach`. It cleans up every handle not cleaned up yet, and fails the test if a faux script still has unused responses, so a test can't silently stop before the step it meant to reach. Use `tempDir()` for a directory shared by several Velas.

An extension's `ui.notify()` with no UI becomes a `notify` event: `t.eventsOf('notify')`. Without `session.ui`, `confirm` returns `false` and `select` / `input` return `undefined`.

The slash-command dispatcher of the interactive CLI (`/context`, `/model`, ...) is not part of the package. Vela's own repository wraps `createTestVela()` with it in `test/support/vela.ts`.

## Example: testing an extension

An extension with a tool and a `tool_call` hook that asks before running bash:

```ts
// greet.ts
import type { VelaExtension } from '@glows777/vela'
import { z } from 'zod'

export const greet: VelaExtension = (vela) => {
  vela.registerTool({
    name: 'say_hello',
    description: 'Say hello to someone',
    inputSchema: z.object({ name: z.string() }),
    annotations: { readOnlyHint: true },
    execute: async ({ name }: { name: string }) => `Hello, ${name}!`,
  })
  vela.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') return
    if (!(await ctx.ui.confirm('Run bash?', String(event.input.command))))
      return { block: true, reason: 'Not allowed' }
  })
}
```

```ts
// greet.test.ts
import { afterEach, expect, test } from 'bun:test'
import {
  cleanupTestVelas,
  createTestVela,
  fauxText,
  fauxToolCall,
} from '@glows777/vela/testing'
import { greet } from './greet.ts'

afterEach(cleanupTestVelas)

test('the model can call the say_hello tool', async () => {
  const t = createTestVela({
    extensions: [greet],
    responses: [
      // Tools registered by an extension are prefixed with its name
      fauxToolCall('greet_say_hello', { name: 'Ada' }),
      (req) => fauxText(`The tool said: ${req.toolResults[0]?.output}`),
    ],
  })

  await t.run('Say hi to Ada')

  expect(t.eventsOf('tool_execution_end')[0]?.result).toBe('Hello, Ada!')
  expect(t.lastAssistantText()).toBe('The tool said: Hello, Ada!')
  expect(t.model.calls[0]?.tools).toContain('greet_say_hello')
})

test('bash is blocked when the user says no', async () => {
  const asked: string[] = []
  const t = createTestVela({
    extensions: [greet],
    session: {
      ui: {
        notify: () => {},
        confirm: async (_title, message) => {
          asked.push(message)
          return false
        },
        select: async () => undefined,
        input: async () => undefined,
      },
    },
    responses: [fauxToolCall('bash', { command: 'rm build.log' }), fauxText('OK')],
  })

  await t.run('clean up')

  expect(asked).toEqual(['rm build.log'])
  expect(t.model.calls[1]?.toolResults[0]?.output).toContain('Not allowed')
})
```

```bash
bun test greet.test.ts
```

The tool prefix comes from the extension's name, here the function name `greet`; a tool named the same as its extension keeps its plain name. See [Extensions](extensions.md).

## Record and replay

Turn a real run into an offline test: record the model's responses once, then replay them as a faux script.

From the CLI:

```bash
VELA_RECORD=run.json vela -p "summarize README.md"            # real model, recorded
VELA_MODEL=faux:run.json vela -p "summarize README.md"        # offline replay
```

`VELA_RECORD` wraps the default model (`VELA_MODEL`, `--model` or `defaultModel`). A model from a provider registered by an extension can't be recorded. Only the main session's inputs are recorded, not channel sessions. The file is rewritten after each request, so an interrupted run keeps what was recorded.

`VELA_MODEL=faux:<file>` replays the responses in order and ignores the recorded inputs, so pass the same prompts again. It also works with `--mode json` and `--mode rpc`.

From code:

```ts
import { recordModel, replayScenario } from '@glows777/vela/testing'

const recorder = recordModel(realModel, { path: 'run.json' })
const vela = createVela({ model: recorder.model })
vela.subscribe((event) => {
  if (event.type === 'agent_start') recorder.addInput(event.input)
})
// ... use vela as usual ...
await recorder.flush()

// later, offline:
const { t, errors } = await replayScenario('run.json', { extensions: [myExtension] })
expect(errors).toEqual([undefined])     // one entry per input; the error prompt() threw, or undefined
expect(t.lastAssistantText()).toContain('...')
```

`replayScenario()` takes `createTestVela()` options (except `responses`, `generate` and `model`), runs every recorded input in order and returns the same handle. `recorder.scenario()` returns what was recorded so far.

A scenario file is a faux script plus the inputs:

```json
{
  "inputs": ["hello"],
  "responses": [
    { "text": "Hi! ...", "usage": { "input": 1058, "output": 23, "cacheRead": 0, "cacheWrite": 1056 } }
  ]
}
```

Failed requests are recorded as `error`, broken streams as `streamError`, aborted requests as `hang`, and compaction summaries go to `generate`. You can also write scenario files by hand; `chunkSize`, `chunkDelayMs` and `cache` are accepted at the top level.

**A recording contains the conversation verbatim**: your prompts, the model's answers, tool calls with their arguments, and whatever the tools returned (file contents, command output). Vela writes it with mode `0600`. Review and strip anything sensitive before you commit one or share it.

## Faux embedder

```ts
const t = createTestVela({ embedder: true })   // RAG with the faux embedder
const embed = createFauxEmbedder({ dims: 128 }) // or use it directly
```

Text is split into words and hashed into a unit vector (default 128 dimensions). The same text gives the same vector, and more shared words give higher similarity, so RAG ingest and search rank results sensibly without a network. `onCall(texts)` lets a test see what was embedded.

## Demo model

`VELA_MODEL=mock` starts the CLI with a keyword-driven demo model, for trying Vela without an API key:

```bash
VELA_MODEL=mock vela
VELA_MODEL=mock vela -p "list files" < /dev/null
```

It reacts to words in the last user message, for example `hello`, `list files`, `read <file>`, `test bash`, `test grep`, `test parallel` and `test loop`, and calls the matching built-in tools. It streams one character at a time and simulates prompt caching, so `/usage` and `/context` show cache hits. Its model shows up as `mock/mock-model`.

The demo model is not exported and not meant for tests: its answers are fixed English text tied to its keyword list. Use the faux model for tests.

## See also

- [SDK](sdk.md) for `createVela()` and sessions
- [Extensions](extensions.md) for the extension API under test
- [SDK](sdk.md#events) for every event type
- [CLI](cli.md) for `VELA_MODEL`, `VELA_RECORD` and the other environment variables
