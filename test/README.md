# Vela test reference

How Vela is tested, how to verify a change and how to add tests. All tests and test helpers live under `test/`; anyone (or any agent) picking up the code starts here.

## Layout

```
test/
  README.md              this file
  support/vela.ts        createTestVela() from @glows777/vela/testing plus the CLI slash-command dispatcher and captureConsole (tests only)
  fixtures/scenarios/    faux scenario JSON files for CLI replay
  unit/<mirrors src>/    unit tests, e.g. src/agent/retry.ts → test/unit/agent/retry.test.ts
  e2e/                   end-to-end flows: real assembly + faux model
  live/                  real-model smoke tests, skipped by default
src/testing/             published as `@glows777/vela/testing` (package.json exports)
  index.ts               public exports
  faux.ts                scripted faux model (LanguageModelV4); the CLI's VELA_MODEL=faux: uses it too
  faux-embedder.ts       deterministic offline embedder
  test-vela.ts           createTestVela(): a real Vela assembled in a temp dir with a faux model
  record.ts              recordModel(): records a real model's responses as a faux scenario (the CLI's VELA_RECORD)
  replay.ts              replayScenario(): reruns a scenario from its recorded inputs
  demo-model.ts          keyword-driven demo model (VELA_MODEL=mock, for trying the CLI by hand; tests don't use it)
```

The faux model, the demo model and createTestVela live in `src/testing/` rather than `test/` because the CLI loads faux at runtime, and extension authors need `import { createTestVela } from '@glows777/vela/testing'` to test their extensions offline. Tests import from `src/` by relative path; importing by package name is covered by `bun run smoke:consumer`.

## Running

| Command | What it runs | Time |
|---|---|---|
| `bun run test` | unit + e2e; run this before committing | a few seconds |
| `bun run test:unit` | unit tests only | ~1.5 s |
| `bun run test:e2e` | end-to-end flows only (including CLI subprocesses) | a few seconds |
| `bun run test:live` | real model; needs `OPENAI_API_KEY` and `OPENAI_API_MODEL_NAME` | depends on the model |
| `bun test <file or dir>` | a targeted subset | |
| `bun run typecheck` | `tsc --noEmit`; must report 0 errors | |
| `bun run smoke:consumer` | runs `bun run build`, packs a tarball and installs it into an empty Node project (strict NodeNext tsconfig, no @types/bun) and an empty Bun project; in each, type-checks like a consumer, runs a faux session and `vela -p`. Needs network; CI runs it as its own step (on Node 22.18) | ~30 s |
| `bun run lint` | `biome check` (formatting, import order, lint); must report 0 errors (warnings don't block); `bun run lint:fix` fixes formatting and imports | |

The suite never touches the network and needs no environment variables, but it needs ripgrep and fd installed: the `grep` / `find` tools run the real `rg` / `fd` (macOS `brew install ripgrep fd`, Ubuntu `apt install ripgrep fd-find`). The test Vela passes no `binDir`, so it only looks on PATH and never downloads. Every test runs in its own temp directory, isolated from the others and removed afterwards.

CI (`.github/workflows/ci.yml`) runs `bun run test`, `bun run typecheck`, `bun run lint` and `bun run smoke:consumer` on every PR and every push to main; any failing step blocks the PR. The Release workflow runs the same job on a release tag before publishing. `test/live/` does not run in CI.

## Layers

- **unit**: rules and edge cases of a single module (retry classification, loop detection, compaction cut points, summary validation, tool history, security rules, …). Construct the object under test directly; use faux for models.
- **e2e**: `createTestVela()` assembles the same Vela the CLI does (`createVela()` + the CLI's slash-command dispatcher), with only the model swapped for faux and the directories for temp dirs. Assert on the event sequence, the requests the model received and the files written.
- **e2e/cli.test.ts**: spawns a real `bun src/cli/main.ts` subprocess replaying `VELA_MODEL=faux:<scenario.json>`, and asserts on stdout, stderr and the exit code.
- **e2e/tui.test.ts**: runs interactive mode (the TUI) in-process. `startTui(vela)` from `test/support/terminal.ts` starts `InteractiveMode` on a fake terminal that implements pi-tui's `Terminal` interface; `terminal.type()` / `press(KEYS.xxx)` send keys, `screen()` returns the whole screen as plain text, and `until('text')` waits for text to appear.
- **live**: a real model; only checks that things connect, no detailed assertions.

Run the layer that matches what you changed; run the full `bun run test` when you touch the agent loop, assembly, events, context management or the CLI entry point.

## Faux model

```ts
import { createFauxModel, fauxText, fauxToolCall, fauxError, fauxStreamError, fauxHang, fauxSummary } from '../../src/testing/faux.ts'

const model = createFauxModel({
  responses: [                                        // main queue, consumed in order by streamText
    fauxToolCall('read_file', { path: 'a.txt' }),     // one tool call
    [fauxToolCall('find', {...}), fauxToolCall('grep', {...})], // an array = several tool calls in one response
    (req) => fauxText(`You said: ${req.lastUserText}`), // generated from the request
    fauxError('429 Too Many Requests'),               // the request fails (an Error works too, e.g. a provider APICallError)
    fauxStreamError('ECONNRESET', 'partial text'),    // the stream breaks midway
    fauxHang('thinking'),                             // never finishes until aborted
    fauxText('x', { usage: { input: 900, output: 10 }, finishReason: 'length' }),
  ],
  generate: [fauxSummary()],  // separate queue for generateText (context summaries); fauxSummary produces a summary that passes validation
  chunkSize: 8,               // stream text in 8-character chunks
  cache: true,                // simulate prompt caching: an unchanged system prompt counts as cacheRead
})

model.calls      // every request: { index, kind, system, prompt, tools, lastUserText, toolResults, responseFormat }
model.pending()  // responses not used yet
model.push(...)  // append responses
```

- A request after the script runs out throws right away (`faux: no scripted response for request #3 (stream)`) instead of hanging.
- Usage is estimated from character counts by default, so it is deterministic; override `usage` when a test needs exact numbers.
- Responses are JSON-serializable `FauxResponse` objects (`text`, `reasoning`, `toolCalls`, `finishReason`, `usage`, `error`, `streamError`, `hang`), so the same script can be saved as a scenario file for CLI replay.

## createTestVela()

```ts
import { cleanupTestVelas, createTestVela, captureConsole } from '../support/vela.ts'

afterEach(cleanupTestVelas)   // every file that uses createTestVela needs this

const t = createTestVela({
  responses: [...], generate: [...], faux: { cache: true },
  files: { 'src/a.ts': '...' },          // pre-seeded into the temp cwd
  skills: [{ name, description, body }], // written to .skills/<name>/SKILL.md
  embedder: true,                        // load the rag extension with the faux embedder (the memory extension always loads, like the CLI)
  limits: { maxRetries: 1 },             // override limits; tests default to retryBaseMs=0
  dataDir: 'data', sessionId: 'a', cwd: existingDir,   // dataDir defaults to '.vela-data' (relative to cwd, persisted)
  extensionConfig: { web: { tavilyKey: 'x' } },        // extension config sections (vela.config)
  logger,                                // inject a logger
  extensions: [myExtension],             // extensions under test
  session: { role: 'guest', ui, permissions: { bash: 'ask' }, tools: [...] }, // options for the default session
})

t.vela                            // what createVela() returned (public API)
t.internals                       // internals: registry, hooks, builder, gateway… (test/support version only)
t.session                         // the default session (id = sessionId, 'default' by default)
await t.run('read a.txt')         // = t.session.prompt()
t.vela.session('other')           // another session on the same Vela
t.eventTypes()                    // events from all sessions: ['agent_start', 'message_start', 'message_end', 'turn_start', ...]
t.eventsOf('tool_execution_start') // events of one type, typed
t.eventsIn('other')               // events of one session
t.streamedText(); t.lastAssistantText(); t.messages
t.model.calls                     // requests the model received
t.dispatch('/context')            // the CLI's own slash commands; returns false / true / a Promise (async commands); output goes to console.log, capture it with captureConsole()
await t.command('/skill x')       // async command, waits for it to finish
await t.run('/memory')            // extension commands go through session.prompt(); their output is notify events: t.eventsOf('notify')
t.readFile('a.txt'); t.readData('sessions/default.jsonl'); t.exists('rag/knowledge.db')  // inside the data dir: sessions/ usage/ memory/ rag/
await t.cleanup({ keepDir: true }) // usually left to cleanupTestVelas()
```

CLI slash commands (`t.dispatch` / `t.command`) act on `t.session`; they come from `test/support/vela.ts`, and the `@glows777/vela/testing` version has no command dispatcher. Commands registered by extensions (`/memory`, `/dream`, `/rag`, …) bypass the dispatcher; use `t.run('/name args')`.

Cleanup fails if the faux script still has unused responses, so a test can't silently stop short of the step it meant to reach. Pass `allowPendingResponses: true` when leftovers are expected.

Slash commands print to the terminal; collect their output with `captureConsole(() => ...)` before asserting, which also keeps test output clean.

### Events

`session.subscribe(listener)` receives only that session's events; `vela.subscribe((event, sessionId) => …)` receives every session's. Message and tool events have pi's shape. One `prompt()` emits, in order: `agent_start{input}` → `message_start` / `message_end` (the user input) → per turn `turn_start` → `message_start` (assistant) → `message_update`s (`assistantMessageEvent`: `text_*`, `thinking_*`, `toolcall_*`) → `message_end{stopReason}` → `tool_execution_start` / `tool_execution_end` per tool call → `usage` → `message_start` / `message_end` (the tool results, then loop-detection reminders) → `turn_end{message, toolResults}` → (messages steered in while running: `message_start` / `message_end`, then another turn; follow-ups are taken when the model would otherwise stop and continue in the same loop, like pi) → `agent_end{messages, reason}`. A retried attempt ends its assistant message with `stopReason: 'error'` and is followed by `auto_retry_start` (and finally `auto_retry_end`); an aborted or failed turn keeps its partial message in history (`stopReason: 'aborted'` / `'error'`), its tool calls answered with errors → (messages still queued after a loop error or abort start a new loop) → finally `agent_settled`. Queue changes emit `queue_update{steering, followUp}`. There are also `context` (compaction), `audit`, `security_warning`, `session_save_failed` and `notify` (an extension's `ui.notify` when there is no UI); channel sessions also emit `channel_message` / `channel_reply` / `channel_error`.

Core never writes to the terminal (`test/unit/boundary.test.ts` guards this): diagnostics that aren't events go to `createVela({ logger })`, which is silent by default.

### Record and replay

```ts
import { recordModel, replayScenario } from '@glows777/vela/testing'

const recorder = recordModel(realModel, { path: 'run.json' })   // CLI: VELA_RECORD=run.json
vela.subscribe((e) => e.type === 'agent_start' && recorder.addInput(e.input))
// …use recorder.model as usual…
await recorder.flush()

const { t, errors } = await replayScenario('run.json', { files })  // rerun the inputs offline
```

A recorded scenario is an ordinary faux scenario (plus `inputs`). A failed request is recorded as `error`, a stream cut midway as `streamError`, an aborted one as `hang`, and `generateText` calls (summaries) go to the `generate` queue. The CLI can replay one directly: `VELA_MODEL=faux:run.json bun src/cli/main.ts -p "<first input>"`. The file contains the conversation verbatim; strip anything sensitive before adding one to `test/fixtures/scenarios/`.

### Tunable limits (`src/limits.ts`)

`createVela({ limits })` can override `maxRetries`, `retryBaseMs`, `retryMaxMs`, `microcompactThreshold`, `summaryThreshold`, `minMicroSavings` and `maxInputTokens`. The defaults are what the CLI has always used; unknown keys (such as the removed `maxTurns`, `tokenBudget` and `bashTimeoutMs`) throw. Tests lower thresholds instead of building huge inputs; for example `test/e2e/context.test.ts` measures an empty session's request size first and sets the summary threshold just above it.

## Coverage

| File | Scenarios |
|---|---|
| e2e/basic | event sequence and persistence for a plain text reply; the system prompt, tools and user message the model receives; multi-turn history; answering after a tool call |
| e2e/tools | several tool calls in one response; write/edit write into cwd and emit audit events; bash runs in cwd with the timestamp hook; dangerous bash is refused; tool errors go back to the model; unknown tools and invalid arguments are rejected and recorded; deferred tools become usable only after tool_search; the guest role can't use bash |
| e2e/resilience | 429/503 retried until success; provider APICallError retried by statusCode; a stream cut midway is retried without leaving a partial answer; 400 not retried and the real cause reported; retries exhausted; abort during streaming and continuing afterwards; abort during a tool recorded as cancelled; concurrent runs rejected; loop-detection warning (after the call that triggered it) → critical; no turn limit (like pi); requests over maxInputTokens are not sent |
| e2e/context | manual summary with `session.compact(focus)`, refused while running; microcompaction folds old tool results; summarization replaces old history, keeps recent messages, is persisted and applies after resume; an invalid summary stops and leaves history unchanged |
| e2e/session | `--continue`-style resume; no session in an empty dir; different sessionIds stored separately; dataDir separate from cwd; usage log; prompt-cache simulation |
| e2e/memory | memory extension: a memory saved through the tool shows up in the next prompt and survives a restart; searching memories; saving fails when fields are missing; read/delete need filename; `/memory` (search / lint), `/dream`; guests can't run the commands |
| e2e/rag | rag extension: no RAG tools without an embedder; ingest relative to cwd then search (offline); empty-store hint; the knowledge base survives restarts; `/rag`, `/rag ingest` and aborting it |
| e2e/commands | `/context` `/usage`; text without a leading `/` (`exit`, `status`, ...) is never a command and goes to the model; an extension's tools are usable by the model and listed by `/extensions`; channel messages use the same model and tools and get replies |
| e2e/extensions | every example in `examples/extensions/` (tool, command + notify, registerProvider, before_agent_start section, tool_call + confirm, tool_result redaction, setActiveTools, channel + roleFor); guests don't see memories; tool_call edits arguments in place and they are revalidated; a throwing handler blocks the call; session permission ask; async factories and session_start / shutdown; factory failures; duplicate registration |
| e2e/models | choosing models by name (provider, metadata, models.json pricing); `setModel` switches from the next turn and recomputes limits; per-session models; thinking levels map to `reasoning` (default medium, max→xhigh; models with `reasoning: false` send nothing for off and reject other levels before sending); Vela-wide default thinking; resumed sessions restore model and thinking, warning and keeping the current model when the saved one is unavailable; model objects are not persisted; without a default model, setModel is required first; `/model` `/thinking` |
| e2e/queue | steer is inserted after the current step, before the next request; a steer received on the last step keeps the loop going; followUp runs in the same loop when the model would stop; one-at-a-time / all; prompting while running requires streamingBehavior; clearQueue + `await abort()`; the queue survives abort; queued messages still run after a failure and prompt then rejects; steer / followUp while idle equal prompt; thinking_delta; abort inside an extension command doesn't hang; no queueing while compact holds the session |
| e2e/rpc | `--mode rpc` subprocess: prompt dispositions, events carry sessionId, get_state / get_messages / set_session_name / list_sessions, parse errors and unknown commands, new_session / switch_session; prompting while running requires streamingBehavior, steer / follow_up queue, clear_queue, abort replies only after stopping; renaming while running is saved when the run ends; a prompt that fails before the loop starts (no model) gets an extra success:false response; extension UI confirm / select / notify / setStatus go through extension_ui_request / response |
| e2e/sessions | two sessions running at once (history, files, locks and usage stay separate); session id validation; subscribe scope; tools found by tool_search apply only to that session; skill activation belongs to the session; close / dispose abort and save; `vela.listSessions()` (newest first, names saved and restored with the session) |
| e2e/channels | one persisted session per conversation and sender (a sender's group chat and direct chat stay apart); conversations continue after a restart; one sender's messages are handled in order; stopping the gateway aborts and reports |
| e2e/sdk | the SDK and testing helpers; core doesn't write to the terminal, diagnostics go to the injected logger; without dataDir sessions stay in memory and the temp dir is removed on dispose; custom SessionStorage |
| e2e/examples | the runnable examples the docs point to: each `examples/sdk/` script and `examples/rpc-client.ts` (against `vela --mode rpc` with the demo model) runs offline and exits 0 |
| e2e/tui | submitting a prompt shows the user message, tool blocks (arguments and results) and the streamed answer, with session / model / thinking in the footer; while running, Enter = steer, Alt+Enter = followUp (shown in the queue area), slash commands still run, Esc puts queued messages back in the editor and aborts; a steer typed during streaming is answered in the same run; an extension confirm opens a dialog where the editor is; CLI command output, extension commands and /hotkeys go into the transcript; Ctrl+L picks a model, /thinking picks a level (cursor starts on the current one), Shift+Tab cycles thinking; /name, /new, /resume switch sessions and redraw history; `-r` picks a session before starting; Ctrl+C clears / Ctrl+D quits |
| e2e/cli | the TUI in a real (pseudo) terminal: one turn, then Ctrl+D quits and saves the session; `-r` picks the saved session and draws its history; `-p` writes only the final answer to stdout (diagnostics to stderr) and saves a new session; `-c -p /command` doesn't print old answers from the resumed history; tools run in the process cwd; piped stdin is prepended to the prompt; `--mode json` prints a session header plus one line per event, a model error lands in agent_end with exit code 1; every start creates a new session, `-c` continues the latest; `--session <id>`, `-r` interactive only; record with `VELA_RECORD` and replay with `faux:`; model errors exit 1; a provider registered by an extension works with `--model` / `--thinking`, `--continue` restores the saved model; unknown provider / no model chosen / missing key exit 1, invalid `--thinking` exits 2; missing arguments exit 2; `VELA_MODEL=mock`; discovery in `~/.vela/extensions` + `extensionConfig` from settings (`$VAR`); project extensions need trust (`-p` skips them, `--approve`, a saved decision); `-e` / `--no-extensions`; `--no-session`; a broken settings.json or trust.json exits 2; `--help` / `--version` print to stdout and exit 0 before reading config. CLI subprocesses use temp dirs for HOME and VELA_DIR and never touch the real `~/.vela` |
| unit/cli/commands | skill activation, dedup and the concurrency lock (real assembly) |
| unit/cli/setup | command-line arguments, `--help` text and package version; project skills alone trigger the trust check; settings' extension config overrides environment variables; the old-data move hint |
| unit/models | `provider/id` parsing and errors; thinking → reasoning; limits from the context window |
| unit/config | models.json (built-in openai / anthropic, merging, `$VAR`, missing keys, errors name the file); defaultModel / defaultThinkingLevel validation in settings; settings merging (project over user, resource lists concatenated, paths relative to their file); untrusted projects read only user settings and skip project skills (`.skills`, `.vela/skills`); extension directory discovery; ±builtin; errors name the file; `$VAR` interpolation; data dir encoding; skill directory order; trust.json; running in the home directory |
| unit/session/storage | memory storage saves by id and returns copies; file storage reads and writes, and still reads the old one-message-per-line format; list() for both (newest first, skips sessions without messages, names, first message) |
| unit/testing/record | record then replay yields the same events; recording errors, broken streams, retries, aborts (hang) and the generate queue |
| unit/boundary | core modules contain no console, process.stdout/stderr/exit/env or readline |
| unit/public-api | the public API of `@glows777/vela` and `@glows777/vela/testing` matches `api/public-api.txt`; after changing the public surface run `bun run api:update` |
| unit/scripts | CHANGELOG helpers behind `bun run release` and the GitHub release notes: stamping `[Unreleased]`, extracting a version's notes with repo links pointing at the tag, version bumps; the repo changelog has notes for the current version |
| unit/security | roles (owner / collaborator / guest), session permission rules, ask goes through confirm, the hook chain, bash classification, `/role` changes only the current session |
| unit/… | other module-level rules; see each file |

## Verifying a change

1. Write or update a test that states the expected behavior first (when fixing a bug, make it fail first).
2. Run the relevant files: `bun test test/unit/<module> test/e2e/<scenario>`.
3. When the change crosses modules (agent loop, `createVela`, events, context, CLI), run `bun run test`.
4. `bun run typecheck` and `bun run lint` must pass (CI runs them too).
5. When real model behavior is involved (providers, usage fields, tool-call format), run `bun run test:live` once if you can.
6. When you change events, the faux interface or test conventions, update this file; when you change the public API, run `bun run api:update` and commit `api/public-api.txt`.

## Adding tests

- **A new module or rule** → `test/unit/<same path as in src>.test.ts`.
- **End-to-end behavior of a new feature** → add a case to the matching file in `test/e2e/`; if no file covers the topic, create one and add it to the coverage table above.
- **A problem seen in real use**: record the run with `VELA_RECORD=<file>`, rerun it with `replayScenario(file)` and assert; or reproduce it with a hand-written faux script. If only the CLI is involved, write `test/fixtures/scenarios/<name>.json`, run it by hand with `VELA_MODEL=faux:test/fixtures/scenarios/<name>.json bun run src/cli/main.ts -p "..."`, then add a case to `e2e/cli.test.ts`.
- **A new event type**: assert in e2e that it appears in the right place (`t.eventTypes()`).
- **Waiting for an async command**: use `t.command()` rather than polling with `while (...) await Bun.sleep()`; when polling is unavoidable, poll every 1 ms with a clear exit condition.

Conventions:

- No network and no environment variables; use `embedder: true` when you need embeddings.
- No `process.chdir`; paths are relative to `t.cwd`.
- Assert on events and data, not terminal output; use `captureConsole` only for the output of the command under test.
- No fixed sleeps; for an "in progress" state use `fauxHang()` or control timing with a Promise inside a tool.
- One test checks one thing, and its name states the expected behavior.

## Known issues

- The TUI in a real terminal has only the two smoke tests in `e2e/cli` (util-linux `script` gives the subprocess a pseudo-terminal; platforms without `script`, such as macOS, skip them). Keys and rendering are tested in detail in `e2e/tui` with the fake terminal.
- When you find a problem, first write a faux scenario that reproduces it; anything that can't be fixed yet goes here, with tests asserting the current behavior.
