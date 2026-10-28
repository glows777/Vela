# Core: using and verifying the SDK

For agents that build on Vela or change its core (agent loop, sessions, context, extensions API). The first half gets you running; the second half lists the core behaviors, how to see each one through the public SDK, and which e2e test already covers it. Every recipe below was run on 2026-10-15, except the session cwd row (2026-10-19).

## Getting started

Pick the surface first:

| You are | Use | Docs |
|---|---|---|
| TypeScript in the same process | `createVela()` from `@glows777/vela` (or `@glows777/vela-core` for a core-only app, see [packages](../../docs/sdk.md#packages)) | [sdk](../../docs/sdk.md) |
| Another language or process | `vela --mode rpc` (long-lived) or `vela --mode json "<prompt>"` (one run) | [rpc](../../docs/rpc.md), [json](../../docs/json.md) |
| Adding tools, commands, providers, hooks or a chat app | An extension: `(vela) => { vela.registerTool(…); vela.on(…) }` | [extensions](../../docs/extensions.md), [channels](../../docs/channels.md) |
| Testing any of the above offline | `@glows777/vela/testing` | [testing](../../docs/testing.md) |

[docs/index.md](../../docs/index.md) maps every other question to its page; the runnable examples are in [examples/](../../examples/) (`examples/sdk/01-minimal.ts` first).

The smallest real program, offline (swap the faux model for `'openai/<id>'` plus `providers: loadConfig().providers` to use a real one):

```ts
import { createVela } from '@glows777/vela'
import { createFauxModel, fauxText, fauxToolCall } from '@glows777/vela/testing'

const model = createFauxModel({ responses: [fauxToolCall('bash', { command: 'ls' }), fauxText('done')] })
const vela = createVela({ model })               // no dataDir: sessions stay in memory
try {
  const session = vela.session('demo')           // one Vela, many sessions
  session.subscribe((e) => console.log(e.type))  // agent_start … tool_execution_end … agent_settled
  await session.prompt('what is here?')
  console.log(session.messages.at(-1))
} finally {
  await vela.dispose()
}
```

For checks, `createTestVela()` wraps this with a temp cwd, seeded files and helpers (`run`, `eventsOf`, `eventTypes`, `lastAssistantText`, `messages`, `model.calls`, `exists`, `readFile`):

```ts
const t = createTestVela({ files: { 'a.txt': 'A' }, responses: [fauxToolCall('read_file', { path: 'a.txt' }), (req) => fauxText(`saw ${req.toolResults[0].output}`)] })
await t.run('read it')
t.lastAssistantText()      // the model saw the tool result
await cleanupTestVelas()
```

A faux response can be a function of the request (`req.lastUserText`, `req.toolResults`, `req.tools`): that is how a check sees what the model was actually sent.

## Verifying core

Write a script in the run's `work/` that imports `$REPO/packages/vela/src/index.ts` and `$REPO/packages/vela/src/testing/index.ts` (a change inside `packages/core` that should work without channels: import `$REPO/packages/core/src/index.ts` and `$REPO/packages/core/src/testing/index.ts` instead, and check the assembled Vela has no channel methods such as `startChannels`), and run it with `$H exec $RUN core env REPO=$REPO bun core-check.ts` (see [SKILL.md](SKILL.md)). Drive the behavior your change touches plus its neighbors, then read the matching e2e test to see what is already pinned down. `t` is a `createTestVela(…)`; `call(…)` is `fauxToolCall(…)`.

| Behavior | Recipe | Check | Covered in |
|---|---|---|---|
| One turn | `responses: [fauxText('hi')]`, `t.run('x')` | Events start `agent_start`, end `agent_settled`; 2 messages; `sessions/default.jsonl` exists | e2e/basic |
| Parallel tools | `[[call('read_file',{path:'a.txt'}), call('read_file',{path:'b.txt'})], fauxText('ok')]` | `t.model.calls[1].toolResults.length === 2` | e2e/tools |
| Retry | `[fauxError('429 Too Many Requests'), fauxText('ok')]` | One `auto_retry_start`, answer `ok` | e2e/resilience |
| No retry on 4xx | `[fauxError('400 Bad Request: …')]` | `run` rejects with the 400; no `auto_retry_start` | e2e/resilience |
| Broken stream | `[fauxStreamError('ECONNRESET', 'half'), fauxText('whole')]` | Only `whole` is in history | e2e/resilience |
| Abort | `[fauxHang(), fauxText('again')]`; `session.abort()` after 50 ms | `run` rejects, last `agent_end` reason `aborted`; the next `run` works | e2e/resilience |
| Concurrent prompt | Second `prompt()` on a busy session | Rejects (use `steer` / `followUp` or `streamingBehavior`) | e2e/resilience, e2e/queue |
| Steer | `faux: { chunkDelayMs: 20 }`, tool call then `(req) => fauxText(req.lastUserText)`; `steer('S')` during the run | The next request ends with `S` | e2e/queue |
| Follow-up | Same, with `followUp('N')` while the first answer streams | A second answer for `N` in the same run | e2e/queue |
| Truncated tool call | `call('read_file', {…}, { finishReason: 'length' })` | Error `tool_execution_end`; the loop continues | e2e/resilience |
| Long tool output | `call('bash', { command: 'seq 1 20000' })` | The model gets a preview and a `tool-results/<id>.txt` path | e2e/tools |
| Manual compact | 4 turns, `generate: [fauxSummary()]`, `session.compact()` | Message 0 holds `[Summary of the earlier conversation]`; `compaction_end` reason `manual` | e2e/context |
| Threshold compact | `limits: { summaryThreshold: 50000, microcompactThreshold: 1e9 }`, four `fauxText` replies with `usage: { input: 60000 }` on the fourth, then one more `fauxText`, `generate: [fauxSummary()]`, five short prompts | No `compaction_end` before the last prompt. That prompt emits reason `threshold`. Six ~800-character turns at a threshold of 6000 emit none, because faux reports prompt tokens and that count stays under 6000 | e2e/context |
| Overflow | 4 turns, then `fauxError('prompt is too long: 250000 tokens > 200000 maximum')`, `fauxText('after')` | `compaction_end` reason `overflow`, answer `after` | e2e/context |
| Loop detection | 11 identical `read_file` calls, then text | A `loop_detected` event | e2e/resilience |
| Permissions | `session: { permissions: { bash: 'ask', write_file: 'deny' } }` | `ask` with no UI: result `[Rejected] … not approved`; `deny`: the tool is not active | unit/security, e2e/extensions |
| Hooks | `extensions: [(v) => { v.on('tool_call', e => ({ block: true, reason })); v.on('tool_result', () => ({ output: 'X' })) }]` | `[Blocked by hook] …`; the model sees `X`; mutating `e.input` changes the call | e2e/extensions |
| Providers, model, thinking | `v.registerProvider('local', { models: [{ id: 'm1', reasoning: true }], createModel })`; `await vela.ready()`; `setModel('local/m1')`, `setThinkingLevel('high')` | Answer from that model; `availableThinkingLevels()` | e2e/models |
| Session tree | 2 turns; `fork(userEntry.id, { sessionId })`, `navigateTree(id)`, `clone({ sessionId })` | Fork returns `selectedText` and the history before it; navigate returns `editorText`; clone copies the branch | e2e/session-tree |
| Persistence | `createVela({ cwd, dataDir: '.d', model })`, prompt, `dispose()`; a new Vela, `session(id).resume()` | Resumed history; `listSessions()`; with `sessionStorage: memorySessionStorage()`, `session.persistence.type` is `memory` | e2e/session, e2e/sessions, e2e/sdk |
| Image inputs | Load a fixture as `{ type: 'image', data: base64, mimeType }`; `session.prompt('describe', { images })`, then steer/follow-up, resume/clone/fork; switch between text-only and vision model metadata | Provider receives an image file; oversized images become <=2000px / <=4.5 MiB; text-only request has a placeholder but history still has image data; invalid images have a text reason; summaries contain no base64 text | e2e/images, e2e/rpc |
| Tool image results | Run `examples/sdk/06-tool-images.ts`; call read_file on a misleading image extension; replace tool content in a hook; change to a text-only model, dispose and resume | Canonical inline image, post-hook resize, text-only omission, resumed vision image; no base64 in caption files or summary text | e2e/tool-images, e2e/tool-image-file-limits, e2e/tool-image-providers |
| Session cwd | `proj-b/AGENTS.md` exists; `vela.session('b', { cwd: 'proj-b' })`; faux `write_file` `out.txt`, then `(req) => fauxText(req.system.includes('<B rule>') ? 'yes' : 'no')` | `session.cwd` is the absolute `proj-b`; `proj-b/out.txt` exists and the Vela cwd has no `out.txt`; the system prompt carries proj-b's AGENTS.md | e2e/session-cwd |
| Many sessions | `Promise.all([a.prompt('A'), b.prompt('B')])` | Separate histories | e2e/sessions |
| User bash, dispose | `session.executeBash('echo X')`, then `run` | `exitCode` 0; `vela.session()` throws after `dispose()` | e2e/user-bash, e2e/disposal |

Beyond this table: channels and guests are in [journeys.md](journeys.md#sdk); RAG, memory and MCP in their e2e files.

When a recipe shows a bug, the fix starts with a faux scenario in the matching e2e file (see [test/README.md](../../test/README.md)).
