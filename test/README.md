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

| Command | What it runs | Approximate time |
|---|---|---|
| `bun run test` | unit + e2e; run this before committing | 1–2 min |
| `bun run test:unit` | unit tests only | ~5–15 s |
| `bun run test:e2e` | end-to-end flows only (including CLI subprocesses) | ~1 min |
| `bun run test:live` | real model; needs `OPENAI_API_KEY` and `OPENAI_API_MODEL_NAME` | depends on the model |
| `bun test <file or dir>` | a targeted subset | |
| `bun run typecheck` | `tsc --noEmit`; must report 0 errors | |
| `bun run smoke:consumer` | runs `bun run build`, packs a tarball and installs it into an empty Node project (strict NodeNext tsconfig, no @types/bun) and an empty Bun project; in each, type-checks like a consumer, runs a faux session and `vela -p`. Needs network; CI runs it as its own step (on Node 22.18) | ~30 s |
| `bun run lint` | `biome check --error-on-warnings` (formatting, import order, lint); must report 0 errors and 0 warnings (infos don't block); `bun run lint:fix` fixes formatting and imports | |

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
  generate: [fauxSummary()],  // separate queue for generateText (context summaries); fauxSummary produces a structured free-text checkpoint
  chunkSize: 8,               // stream text in 8-character chunks
  cache: true,                // simulate prompt caching: the longest common prefix of tools + system + messages counts as cacheRead
  maxRequestTokens: 100_000,  // larger requests fail like a provider context overflow
})

model.calls      // every request: { index, kind, system, prompt, tools, inputTokens, lastUserText, toolResults, responseFormat, reasoning, headers }
model.pending()  // responses not used yet
model.push(...)  // append responses
model.maxRequestTokens = N  // change the size limit mid-test
```

- Every response has the header `x-faux-request: <index>`; with `includeRawChunks` each stream part is preceded by a `raw` part carrying it (for the extension provider hooks).
- A request after the script runs out throws right away (`faux: no scripted response for request #3 (stream)`) instead of hanging.
- Usage is estimated from character counts by default, so it is deterministic; override `usage` when a test needs exact numbers.
- `inputTokens` is the request's size (prompt and tool definitions, chars / 4). A request over `maxRequestTokens` fails with `400 prompt is too long: <size> tokens > <limit> maximum`, which the agent loop treats as a context overflow; the failed request is recorded but uses no scripted response, so the summary and the retried step take the next ones. Tests that need to know a size first set `model.maxRequestTokens` after measuring an accepted request.
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
  session: { ui, permissions: { bash: 'ask' }, tools: [...] }, // options for the default session
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

A test Vela opens its default session without resuming it, so a second `createTestVela({ cwd: t.cwd })` on the same data dir must call `await again.session.resume()` (or use another `sessionId`) before prompting: prompting a saved session that was not resumed fails.

Cleanup fails if the faux script still has unused responses, so a test can't silently stop short of the step it meant to reach. Pass `allowPendingResponses: true` when leftovers are expected.

Slash commands print to the terminal; collect their output with `captureConsole(() => ...)` before asserting, which also keeps test output clean.

### Events

`session.subscribe(listener)` receives only that session's events; `vela.subscribe((event, sessionId) => …)` receives every session's. Message and tool events have pi's shape. One `prompt()` emits, in order: `agent_start{input}` → `message_start` / `message_end` (the user input) → per turn `turn_start` → `message_start` (assistant) → `message_update`s (`assistantMessageEvent`: `text_*`, `thinking_*`, `toolcall_*`) → `message_end{stopReason}` → `tool_execution_start` / `tool_execution_end` per tool call → `usage` → `message_start` / `message_end` (the tool results, then a loop-detection notice as a custom message) → `turn_end{message, toolResults}` → (messages steered in while running: `message_start` / `message_end`, then another turn; follow-ups are taken when the model would otherwise stop and continue in the same loop, like pi) → `agent_end{messages, reason}`. A retried attempt ends its assistant message with `stopReason: 'error'` and is followed by `auto_retry_start` (and finally `auto_retry_end`); an aborted or failed turn ends its message with `stopReason: 'aborted'` / `'error'`: if the message was complete (its tools were running) it stays in history with its open tool calls answered with errors, otherwise it is only appended to the session (`session.getEntries()`), not sent to the model again, like pi → (messages still queued after a loop error or abort start a new loop) → finally `agent_settled`. Queue changes emit `queue_update{steering, followUp}`. There are also `compaction_start` / `compaction_end` (summaries, like pi), `context` (microcompaction), `audit`, `security_warning`, `session_save_failed`, `notify` and `bash_execution_update` (output of a running `session.executeBash()`) (an extension's `ui.notify` when there is no UI); channel sessions also emit `channel_message` / `channel_reply` / `channel_error`.

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
| e2e/channel-routines | Fake-clock one-off topic/group/DM delivery and creator mentions; human group announcements distinct from model input; recurrence across process and logical restart with marker alignment; cancellation; latest-only late catch-up; disabled-chat skip; queued routine isolation; original requester retained in topic overview and routine/human recovery; malformed-file rejection and input save failure |
| unit/channels/routine-time | Local weekday recurrence and latest occurrence; DST gap shift and first repeated instant |
| e2e/images | image request payloads, resize and invalid-image hints; model-capability switching; image history resume/fork/clone; input-hook replacement; queued images; summary safety |
| e2e/tool-images, e2e/tool-image-file-limits | canonical tool images, hook replacement, normalization, five read_file formats, native MCP transport, non-vision fallback, resume, error-image retention, native history, microcompaction and safe file limits |
| e2e/tool-image-order | ordered caption previews, bounded many-caption output, full-text recovery, native details and no base64 caption files |
| e2e/tool-image-providers | real Anthropic / OpenAI Responses / aliased Chat serialization through injected offline fetch; native tool images, request-only relocation and intentionally empty hook results |
| e2e/feishu-passive | default-on/off, queued unique intake and restart dedup, skip vs reply without feedback, command-looking discussion, bot/disabled/unclassified-sender drops and required sender type, file preparation and quiet errors, own-card history boundary after restart, custom transport without appId reply-receipt boundary |
| e2e/group-workspaces | two-group same-name file/memory isolation; shared group topics; idle reopen, logical-session restart and fresh assembly; retained attachments; global read/write rules; invalid chat/tool config; required controls and removed-tool denial |
| e2e/feishu-input-timing | Held acknowledgement, history preparation and Stop-card gates produce distinct receipt/admission/dequeue/preparation/prompt diagnostics without message text |
| e2e/feishu-waiting | Reused topic labels retain current waiting reasons with explicit overview interpretation; waiting requires a delivered nonempty answer; empty or failed answers clear the reason, including with no optional tools |
| e2e/feishu-search-history | Bounded keyword/time-range listing from real Feishu entry, page/match/character caps, logical topic group after `!restart`, and visible API errors; ISO timestamps, platform sender types and exact returned match counts |
| e2e/feishu-dispatch | short answers and scoped prompts/tools; asynchronous handoff while a topic tool runs; original-message forwarding with sender attribution; API creation failure; cross-group target rejection; durable list coverage, restart/reobservation and queued/running/waiting/done/stopped states and requester/activity metadata; missing-topic disclosure; Stop during create/forward requests; screenshot handoff without history images; immediate list/forward during the first topic load |
| e2e/channel-recovery | SIGKILL passive active/queued drop with operator diagnostics and replay dedup; subprocess recovery of saved text/images and group classification; unsaved input/queued-steer resend notices without mentioning another requester; graceful shutdown preserves the run and pending steer; terminal execution failures stay quiet while failed delivery retries the saved answer; handled idle/steer preparation rejections clear pending IDs; persistent topics and forwarding; durable Stop; unowned-topic no writes; corrupt-index startup rejection; disabled-group recovery; SDK-found forwarding without a live raw event |
| e2e/channel-commands | real Feishu Stop/Restart with and without mentions; retained Stop history; archived idle/active generations; next unmentioned input reloads history; stale Stop isolation; successor recovery under its logical topic; unowned-command no writes; Restart during history/control preparation prevents a surprise model call; admitted command IDs remain recoverable until completion |
| e2e/channel-status | live Status with/without mentions without steering, stopping or model calls; exact topic/group token and cost sums including compaction; append-only totals across process restarts and session generations; mixed pricing and unpriced-summary disclosure; unowned-topic no writes |
| e2e/feishu-feedback | admitted-input reaction ordering and terminal states; one in-place card for held tools and steers; original requester mention; model/card/send failure visibility; Stop and continuation; task handoff reaction ownership; ignored input has no side effects; visible elapsed-time heartbeat and cleanup; bounded sanitized top-level tool-input summaries; nested-call suppression; Stop during steer preparation; task vs progress failure outcomes; ordered patches drain before final feedback |
| e2e/basic | event sequence and persistence for a plain text reply; the system prompt, tools and user message the model receives; multi-turn history; answering after a tool call |
| e2e/tool-result-text | plain bash output and failure notes; durable files/history; bash tail and generic/web head truncation with read_file recovery; 20KB whole results; legacy StoredToolResult resume; no history guide, including after compaction |
| e2e/tools | several tool calls in one response; write/edit write into cwd and emit audit events; bash runs in cwd with plain output; dangerous bash is refused; tool errors go back to the model; unknown tools and invalid arguments are rejected and recorded; deferred tools become usable only after tool_search; bash failures are error results and its output streams as tool_execution_update; ctx.executeTool goes through permissions, hooks and the bash check |
| e2e/resilience | 429/503 retried until success; provider APICallError retried by statusCode; a stream cut midway is retried without leaving a partial answer; 400 not retried and the real cause reported; retries exhausted; abort during streaming and continuing afterwards; abort during a tool recorded as cancelled; concurrent runs rejected; loop-detection warning on the 10th identical call, stored as a custom notice, then a critical stop; no turn limit (like pi); requests over maxInputTokens are not sent |
| e2e/structured-compaction | free-text Progress/Next Steps reach a resumed follow-up; code-derived read/modified file lists survive repeated compaction and nested branch summaries across resume; failed summaries preserve live and persisted history; model output limits apply to manual/threshold/overflow/branch summaries |
| e2e/context | manual summary with `session.compact(focus)`, refused while running; microcompaction folds old tool results; summarization replaces old history, keeps recent messages, is persisted and applies after resume; an incomplete summary stops and leaves history unchanged; a message above the summary threshold with nothing to summarize is sent |
| e2e/session | `--continue`-style resume; no session in an empty dir; different sessionIds stored separately; dataDir separate from cwd; usage log; prompt-cache simulation |
| e2e/memory | memory extension: a memory saved through the tool shows up in the next prompt and survives a restart; the index arrives as a tail message without rewriting the cached prefix, is not repeated when unchanged, is restored in the request that automatic compaction summarizes away, and is sent again after compaction and a resume; searching memories; saving fails when fields are missing; read/delete need filename; `/memory` (search / lint), `/dream` |
| e2e/rag | rag extension: unconfigured startup is silent, only `/rag` is registered and explains configuration without model/database work; no RAG tools without an embedder; ingest relative to cwd then search (offline); empty-store hint; the knowledge base survives restarts and its summary arrives as a tail message; `/rag`, `/rag ingest` and aborting it |
| e2e/commands | `/status` (session overview, including in the TUI transcript) `/context` `/usage`; text without a leading `/` (`exit`, `status`, ...) is never a command and goes to the model; an extension's tools are usable by the model and listed by `/extensions`; channel messages use the same model and tools and get replies |
| e2e/extensions | every example in `examples/extensions/` (tool, command + notify, registerProvider, before_agent_start section, tool_call + confirm, tool_result redaction, setActiveTools, channel); tool_call edits arguments in place and they are revalidated; a throwing handler blocks the call; session permission ask; async factories and session_start / shutdown; factory failures; duplicate registration |
| e2e/models | choosing models by name (provider, metadata, models.json pricing); `setModel` switches from the next turn and recomputes limits; per-session models; thinking levels map to `reasoning` (default medium, max→xhigh; models with `reasoning: false` send nothing for off and reject other levels before sending); Vela-wide default thinking; resumed sessions restore model and thinking, warning and keeping the current model when the saved one is unavailable; model objects are not persisted; reasoning another model produced is left out, also after a resume; without a default model, setModel is required first; `/model` `/thinking` |
| e2e/responses-thinking | real session → configured Responses adapter → offline HTTP/SSE: plaintext/summary reasoning streaming and persistence, tool execution and answer preservation; high/max/off effort, stock medium clamping, custom medium override and resumed selection; unit/config/responses-thinking covers capability/option precedence, mappings, exact-host system roles, OAuth, immutable inputs, history pairing, SDK filtering, reasoning lifecycle/raw opt-in and other-host stream isolation |
| e2e/queue | steer is inserted after the current step, before the next request; a steer received on the last step keeps the loop going; followUp runs in the same loop when the model would stop; one-at-a-time / all; prompting while running requires streamingBehavior; clearQueue + `await abort()`; the queue survives abort; queued messages still run after a failure and prompt then rejects; steer / followUp while idle equal prompt; thinking_delta; abort inside an extension command doesn't hang; no queueing while compact holds the session |
| e2e/rpc | `--mode rpc` subprocess: prompt dispositions, events carry sessionId, get_state / get_messages / set_session_name / list_sessions, parse errors and unknown commands, new_session / switch_session; prompting while running requires streamingBehavior, steer / follow_up queue, clear_queue, abort replies only after stopping; renaming while running is saved when the run ends; a prompt that fails before the loop starts (no model) gets an extra success:false response; extension UI confirm / select / notify / setStatus go through extension_ui_request / response |
| e2e/sessions | two sessions running at once (history, files, locks and usage stay separate); session id validation; subscribe scope; tools found by tool_search apply only to that session and are declared again in a resumed session; skill activation belongs to the session; close / dispose abort and save; `vela.listSessions()` (newest first, names saved and restored with the session) |
| e2e/channel-routines | fake-clock persisted wake-ups through the real gateway: one-off once, recurrence after restart, cancellation, latest missed occurrence with a late notice, disabled chat isolation, topic/group/DM routing and creator mentions, logical topic after !restart, queue behind active work, requester recovery, malformed-file rejection and failed input save |
| e2e/feishu-routine-schema | real Feishu entry and actual Responses adapter request serialization with scripted HTTP: routine tool object-root schema and successful create; reproduces the live provider rejection of a root union |
| e2e/channel-routine-tools | real Feishu entry and faux create/list/cancel: mandatory group/topic/DM tools, deployment-local one-offs and DST, logical target after !restart, member cancellation, per-chat cap and validation, scoped isolation; exact !routines with/without mentions and passive intake off, no model/user entry, unknown-topic no writes and active-run isolation |
| e2e/feishu-attachments | fake Feishu resource streams through the real gateway: DM/post images, four latest group images, historical file placeholders, saved paths, traversal and symlink protection, 20MB rejection, audio unsupported, image Steer |
| e2e/feishu-topics | real Feishu entry: concurrent isolated topics; untagged top-level admission; automatic topic steer; initial paginated history through the trigger timestamp and visible errors; owned-topic mentions reuse stored context while idle or running; topic replies preserve the top-level history boundary; serialized persisted ownership before preparation with no saves/empty files for unknown topics; restart/idle continuation; Stop isolation, expiry and preserved context; visible Stop-card failures |
| e2e/channels | one persisted shared session per chat (different chats stay apart); conversations continue after a restart; a chat's messages are handled in order; fake Feishu transport verifies allowlisted chats, owner DMs, bot-mention gating, named history since the last reply, name fallback/cache, and replies to each queued trigger; stopping the gateway aborts and reports; save failures log the session id and block new prompts after three failures; failed idle saves retain the live session and pending history; real writes recover channel/SDK use without duplicate headers, then resume ordinary channel idle cleanup; queued input during idle saving and disposal |
| e2e/channel-feedback-lifecycle | single-hook admission/preparation/controls/event/delivery/finish order; handoff without duplicate acknowledgement; optional-hook fallback; Feishu feedback from normalized topic/reply data without a raw receive event |
| e2e/channel-run-controls | real Feishu extension/gateway with fake transport: busy-run Card 2.0 payloads with actual callback behaviors; default/explicit Queue; one combined Steer reply; visible Stop and later recovery; duplicate, expired, malformed, wrong-chat and owner-DM callbacks; completion during preprocessing; failed card delivery; all own-app messages, including control cards, bound group history; Steer excludes the active trigger/older context, retains same-millisecond discussion and delayed questions; Stop preserves gateway messages (including immediate Queue then Stop) and prevents pending or delayed-hook steers leaking to later tasks |
| e2e/sdk | the SDK and testing helpers; core doesn't write to the terminal, diagnostics go to the injected logger; without dataDir sessions stay in memory and the temp dir is removed on dispose; custom SessionStorage |
| e2e/session-cwd | SDK A/B working directories for file/search/bash, per-session project instructions and disabled context; Vela-wide resources/exports; fork/clone and caller-provided resume cwd |
| e2e/examples | the runnable examples the docs point to: each `examples/sdk/` script and `examples/rpc-client.ts` (against `vela --mode rpc` with the demo model) runs offline and exits 0 |
| e2e/tui | submitting a prompt shows the user message, tool blocks (arguments and results) and the streamed answer, with session / model / thinking in the footer; while running, Enter = steer, Alt+Enter = followUp (shown in the queue area), slash commands still run, Esc puts queued messages back in the editor and aborts; a steer typed during streaming is answered in the same run; an extension confirm opens a dialog where the editor is; CLI command output, extension commands and /hotkeys go into the transcript; Ctrl+L picks a model, /thinking picks a level (cursor starts on the current one), Shift+Tab cycles thinking; /name, /new, /resume switch sessions and redraw history; `-r` picks a session before starting; Ctrl+C clears / Ctrl+D quits |
| e2e/cli | the TUI in a real (pseudo) terminal: one turn, then Ctrl+D quits and saves the session; `-r` picks the saved session and draws its history; `-p` writes only the final answer to stdout (diagnostics and session save failures to stderr) and saves a new session; `-c -p /command` doesn't print old answers from the resumed history; tools run in the process cwd; piped stdin is prepended to the prompt; `--mode json` prints a session header plus one line per event, a model error lands in agent_end with exit code 1; every start creates a new session, `-c` continues the latest; `--session <id>`, `-r` interactive only; record with `VELA_RECORD` and replay with `faux:`; model errors exit 1; a provider registered by an extension works with `--model` / `--thinking`, `--continue` restores the saved model; unknown provider / no model chosen / missing key exit 1, invalid `--thinking` exits 2; missing arguments exit 2; `VELA_MODEL=mock`; discovery in `~/.vela/extensions` + `extensionConfig` from settings (`$VAR`); project extensions need trust (`-p` skips them, `--approve`, a saved decision); `-e` / `--no-extensions`; `--no-session`; a broken settings.json or trust.json exits 2; `--help` / `--version` print to stdout and exit 0 before reading config. CLI subprocesses use temp dirs for HOME and VELA_DIR and never touch the real `~/.vela` |
| unit/cli/commands | skill activation, dedup and the concurrency lock (real assembly) |
| unit/cli/setup | command-line arguments, `--help` text and package version; project skills alone trigger the trust check; settings' extension config overrides environment variables; the old-data move hint |
| unit/models | `provider/id` parsing and errors; thinking → reasoning; limits from the context window |
| unit/config | models.json (built-in openai / anthropic, merging, `$VAR`, missing keys, errors name the file); defaultModel / defaultThinkingLevel validation in settings; settings merging (project over user, resource lists concatenated, paths relative to their file); untrusted projects read only user settings and skip project skills (`.skills`, `.vela/skills`); extension directory discovery; ±builtin; errors name the file; `$VAR` interpolation; data dir encoding; skill directory order; trust.json; running in the home directory |
| unit/session/storage | memory storage saves by id and returns copies; file storage reads and writes, and still reads the old one-message-per-line format; list() for both (newest first, skips sessions without messages, names, first message) |
| unit/testing/record | record then replay yields the same events; recording errors, broken streams, retries, aborts (hang) and the generate queue |
| unit/boundary | core modules contain no console, process.stdout/stderr/exit/env or readline |
| unit/public-api | the public API of `@glows777/vela` and `@glows777/vela/testing` matches `api/public-api.txt`; after changing the public surface run `bun run api:update` |
| unit/scripts | CHANGELOG helpers behind `bun run release` and the GitHub release notes: stamping `[Unreleased]`, extracting a version's notes with repo links pointing at the tag, version bumps; the repo changelog has notes for the current version |
| unit/security | session permission rules (default allow, exact names before `*`, deny and ask), ask goes through confirm, the hook chain, bash classification, `/hooks` lists registered hooks |
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
