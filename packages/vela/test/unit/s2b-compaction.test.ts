import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findCompactionCut,
  KEEP_RECENT_TOKENS,
  summarize,
} from '../../src/driver/context/compressor.ts'
import { ContextManager } from '../../src/driver/context/manager.ts'
import { createRequestSnapshot } from '../../src/driver/context/request.ts'
import { createVela } from '../../src/driver/index.ts'
import type { ModelMessage } from '../../src/driver/messages.ts'
import { SessionStore } from '../../src/driver/session/index.ts'
import { TokenTracker } from '../../src/driver/usage/tracker.ts'
import { createFauxModel, fauxText } from '../../src/testing/core/faux.ts'

const EMPTY_TOOLS = { sdkTools: {}, toolDefinitions: [], hasHostedTools: false }
const dir = mkdtempSync(join(tmpdir(), 'vela-s2b-compaction-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('KEEP_RECENT_TOKENS is 20_000 (#536 #1) and findCompactionCut supports multi-turn and split-turn cuts', () => {
  expect(KEEP_RECENT_TOKENS).toBe(20_000)

  const multiTurn: ModelMessage[] = [
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: `recent turn ${'r'.repeat(85_000)}` },
    { role: 'assistant', content: 'recent answer' },
  ]
  const multiCut = findCompactionCut(multiTurn)
  expect(multiCut).toEqual({
    cutIndex: 2,
    turnStartIndex: 2,
    isSplitTurn: false,
  })

  // Single oversized turn: splits at an assistant boundary with isSplitTurn = true (#536 #5)
  const bigTurn: ModelMessage[] = [
    { role: 'user', content: 'huge single task' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_call',
          toolCallId: 'tc1',
          toolName: 'bash',
          input: { command: 'ls' },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          toolCallId: 'tc1',
          toolName: 'bash',
          output: { type: 'text', value: 'ok' },
        },
      ],
    },
    { role: 'assistant', content: `later step ${'x'.repeat(85_000)}` },
    { role: 'assistant', content: 'final tail' },
  ]
  const splitCut = findCompactionCut(bigTurn)
  expect(splitCut.isSplitTurn).toBe(true)
  expect(splitCut.turnStartIndex).toBe(0)
  expect(splitCut.cutIndex).toBe(3)
})

test('split-turn compaction formats <current-turn-prefix> and incremental compaction uses <previous-summary> with capped output tokens and no snapshot footer (#536 #2-#7)', async () => {
  const model = createFauxModel({
    responses: [
      fauxText(
        '## Goal\nFinish task.\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- [x] Step 1\n### In Progress\n- [ ] Step 2\n### Blocked\n- (none)\n\n## Key Decisions\n- Split turn cleanly.\n\n## Next Steps\n1. Finish step 2.\n\n## Critical Context\n- none',
      ),
      fauxText(
        '## Goal\nFinish task.\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- [x] Step 1\n- [x] Step 2\n### In Progress\n- [ ] (none)\n### Blocked\n- (none)\n\n## Key Decisions\n- Merged incrementally.\n\n## Next Steps\n1. Done.\n\n## Critical Context\n- none',
      ),
    ],
  })

  const store = new SessionStore('s2b-split', dir)
  const tracker = new TokenTracker()
  let seenMaxOutputTokens: number | undefined
  const origGenerate = model.doGenerate.bind(model)
  model.doGenerate = (opts) => {
    seenMaxOutputTokens = opts.maxOutputTokens
    return origGenerate(opts)
  }

  const firstHistory: ModelMessage[] = [
    { role: 'user', content: 'Single oversized turn root' },
    { role: 'assistant', content: 'Prefix assistant analysis' },
    { role: 'assistant', content: `Tail chunk ${'t'.repeat(85_000)}` },
  ]
  const firstRequest = createRequestSnapshot(
    model,
    'Regular execution agent',
    EMPTY_TOOLS,
    firstHistory,
  )
  firstRequest.maxOutputTokens = 32_000
  const first = await summarize(firstRequest, store, tracker)
  const gen1 = model.calls[0]!
  expect(gen1.tools).toEqual([])
  expect(seenMaxOutputTokens).toBe(8_192)
  expect(JSON.stringify(gen1.prompt[0])).toContain(
    'context summarization assistant',
  )
  const user1 = JSON.stringify(gen1.prompt[1])
  expect(user1).toContain('<current-turn-prefix>')
  expect(user1).toContain('Prefix assistant analysis')
  expect(first.summary).not.toContain('Earlier tool output:')
  expect(first.summary).not.toContain('/snapshots/through-')

  // Second compaction: incremental merge into <previous-summary>
  const secondHistory: ModelMessage[] = [
    ...first.messages,
    { role: 'user', content: `Follow-up ${'f'.repeat(85_000)}` },
    { role: 'assistant', content: 'Done now.' },
  ]
  await summarize(
    await createRequestSnapshot(
      model,
      'Regular execution agent',
      EMPTY_TOOLS,
      secondHistory,
    ),
    store,
    tracker,
  )
  const gen2 = model.calls[1]!
  const user2 = JSON.stringify(gen2.prompt[1])
  expect(user2).toContain('<previous-summary>')
  expect(user2).toContain(
    'Merge the new conversation messages above into the <previous-summary>',
  )
})

test('PR #569 P2 #5: pre-API setEstimatedTokens preserves contextHookDeltaTokens; post-turn compactIfNeeded triggers (#536 #8)', async () => {
  const store = new SessionStore('s2b-p2-5', dir)
  const tracker = new TokenTracker()
  const model = createFauxModel({
    responses: [
      fauxText(
        '## Goal\nCompacted\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- [x] Yes\n### In Progress\n- [ ] (none)\n### Blocked\n- (none)\n\n## Key Decisions\n- (none)\n\n## Next Steps\n1. Continue\n\n## Critical Context\n- (none)',
      ),
    ],
  })
  const events: string[] = []
  const manager = new ContextManager(
    store,
    tracker,
    undefined,
    (event) => events.push(event.type),
    { summaryThreshold: 12_000, maxInputTokens: 25_000 },
  )

  const messages: ModelMessage[] = [
    { role: 'user', content: `old ${'o'.repeat(40_000)}` },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: `recent ${'n'.repeat(20_000)}` },
  ]
  for (const m of messages) store.appendMessage(m)
  manager.restore({
    messages,
    timestamps: new Map(),
    summary: '',
  })
  const snapshot = createRequestSnapshot(model, 'sys', EMPTY_TOOLS, messages)
  snapshot.maxOutputTokens = 4_096
  tracker.setContextDelta(400)
  await manager.prepare(snapshot)
  // +400 delta tokens from context hook preserved (not reset by setEstimatedTokens(tokens, true))
  expect(tracker.contextDelta).toBe(400)

  // Post-turn threshold compaction triggers compactIfNeeded()
  const ran = await manager.compactIfNeeded(snapshot)
  expect(ran).toBe(true)
  expect(events).toContain('compaction_end')
})

test('R1 #9/#16/#17: non-initial oversized turn splits at assistant boundary, compaction halts loadSaved calibration scan, and post-turn compact error warns without rejecting prompt', async () => {
  // R1 #9: oversized turn 2 must split inside turn 2 instead of rewinding to turn 2's user message
  const multiOversized: ModelMessage[] = [
    { role: 'user', content: 'turn 1 question' },
    { role: 'assistant', content: 'turn 1 answer' },
    { role: 'user', content: 'turn 2 oversized start' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_call',
          toolCallId: 'tc2',
          toolName: 'bash',
          input: { command: 'pwd' },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          toolCallId: 'tc2',
          toolName: 'bash',
          output: { type: 'text', value: 'z'.repeat(85_000) },
        },
      ],
    },
    { role: 'assistant', content: `big assistant step ${'y'.repeat(85_000)}` },
    { role: 'assistant', content: 'final tail' },
  ]
  const cut = findCompactionCut(multiOversized)
  expect(cut.isSplitTurn).toBe(true)
  expect(cut.turnStartIndex).toBe(2)
  expect(cut.cutIndex).toBe(5)

  // R1 #16: computeLatestAssistantUsage stops at compaction boundary so pre-compaction tokens don't miscalibrate
  const store = new SessionStore('comp-scan', dir)
  store.appendMessage({ role: 'user', content: 'pre' })
  const asst = store.appendMessage(
    { role: 'assistant', content: 'pre answer' },
    { inputTokens: 190_000, outputTokens: 500 },
  )
  const keptMsg: ModelMessage = { role: 'user', content: 'kept follow up' }
  store.appendMessage(keptMsg)
  store.appendCompaction(
    { role: 'user', content: 'summary msg' },
    'Compacted',
    keptMsg,
    190_500,
  )
  const loaded = await store.loadSaved()
  expect(loaded?.latestAssistantUsage).toBeUndefined()
  expect(asst.type).toBe('message')

  // R1 #17: post-turn compactIfNeeded failure warns instead of rejecting already-completed prompt()
  const warnings: string[] = []
  const cdir = mkdtempSync(join(tmpdir(), 'vela-s2b-postcomp-'))
  try {
    const vela = createVela({
      cwd: cdir,
      dataDir: cdir,
      limits: { summaryThreshold: 500 },
      model: createFauxModel({
        responses: [
          fauxText('first turn done', { usage: { input: 100, output: 20 } }),
          fauxText(`done ${'w'.repeat(4_000)}`, {
            usage: { input: 600, output: 1000 },
          }),
        ],
        generate: [{ error: 'transient summary 503' }],
      }),
      logger: {
        debug: () => {},
        info: () => {},
        warn: (msg) => warnings.push(msg),
        error: () => {},
      },
    })
    const sess = vela.session('post-comp')
    await sess.prompt('turn 1')
    await expect(
      sess.prompt('trigger post-turn compact'),
    ).resolves.toBeUndefined()
    expect(
      warnings.some((w) => w.includes('Post-turn compaction failed')),
    ).toBe(true)
    await vela.dispose()
  } finally {
    rmSync(cdir, { recursive: true, force: true })
  }
})
