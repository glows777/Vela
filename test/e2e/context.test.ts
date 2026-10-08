import { afterEach, expect, test } from 'bun:test'
import {
  createRequestSnapshot,
  estimateRequestTokens,
} from '../../src/context/request.ts'
import {
  fauxHang,
  fauxSummary,
  fauxText,
  fauxToolCall,
} from '../../src/testing/faux.ts'
import {
  captureConsole,
  cleanupTestVelas,
  createTestVela,
  type TestVela,
} from '../support/vela.ts'

afterEach(cleanupTestVelas)

/** Estimate how many tokens the request t sends to the model in its current state (the same estimate ContextManager uses) */
async function requestTokens(t: TestVela): Promise<number> {
  return estimateRequestTokens(
    await createRequestSnapshot(
      t.vela.model,
      t.session.buildSystem(),
      t.internals.registry.toAISDKFormat(),
      t.messages,
    ),
  )
}

const bigFile = (i: number) =>
  `// file ${i}\n${'export const value = 42 // padding\n'.repeat(120)}`

test('microcompact folds old tool results once more than five calls have completed', async () => {
  const files = Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [`f${i}.ts`, bigFile(i)]),
  )
  const t = createTestVela({
    files,
    // Try microcompact before every request; summary never triggers
    limits: {
      microcompactThreshold: 1,
      minMicroSavings: 1,
      summaryThreshold: 1e9,
    },
    responses: [
      ...Array.from({ length: 8 }, (_, i) =>
        fauxToolCall('read_file', { path: `f${i}.ts` }),
      ),
      fauxText('Read them all'),
    ],
  })

  await t.run('Read f0 through f7')

  const micro = t.eventsOf('context').filter((e) => e.action === 'micro')
  expect(micro.length).toBeGreaterThan(0)
  expect(micro[0]!.after).toBeLessThan(micro[0]!.before)

  // In the last request the earliest tool results are folded into references; the latest 5 stay as is
  const last = JSON.stringify(t.model.calls.at(-1)!.prompt)
  expect(last).toContain('tool result preview omitted')
  expect(last).toContain('// file 7')
  // Folded results can be recovered from their path
  const saved = await t.readData('sessions/default.jsonl')
  expect(saved).toContain('tool result preview omitted')
  expect(t.lastAssistantText()).toBe('Read them all')
})

test('summary compaction replaces old history with a grounded summary and keeps recent messages', async () => {
  const filler = (i: number) =>
    `Question ${i}: ${'Background. '.repeat(100)}`
  const probe = createTestVela()
  const base = await requestTokens(probe)
  await probe.cleanup()

  const t = createTestVela({
    // Summary triggers on the 5th question, after 4 rounds (8 messages)
    limits: { microcompactThreshold: 1e9, summaryThreshold: base + 4 * 400 },
    responses: [...Array.from({ length: 5 }, (_, i) => fauxText(`Answer ${i}`))],
    generate: [fauxSummary()],
  })
  for (let i = 0; i < 5; i++) await t.run(filler(i))

  const summary = t.eventsOf('context').find((e) => e.action === 'summary')
  expect(summary).toBeDefined()
  // Keeps at least the latest 6 and cuts at a full round: the first round (2 messages) is replaced by the summary
  expect(summary!.messages).toBe(2)

  // The summary request goes through generateText and sees the compaction control instruction
  const generate = t.model.calls.find((c) => c.kind === 'generate')!
  expect(generate.lastUserText).toContain('context_compaction')
  expect(generate.responseFormat?.type).toBe('json')

  // The main request after the summary: the first message is the summary, recent messages are kept as is
  const after = t.model.calls.at(-1)!
  expect(after.kind).toBe('stream')
  const firstUser = after.prompt.find((m) => m.role === 'user')!
  expect(JSON.stringify(firstUser.content)).toContain('[Summary of the earlier conversation]')
  expect(JSON.stringify(firstUser.content)).toContain('Question 0')
  expect(after.lastUserText).toContain('Question 4')
  expect(t.session.contextManager.state.summary).toContain('## User goal')
  expect(
    t
      .tracker()
      .recent(10)
      .some((r) => r.kind === 'summary'),
  ).toBe(true)

  // The summary is saved; a new Vela restores it on resume
  const resumed = createTestVela({ cwd: t.cwd, responses: [fauxText('ok')] })
  expect(await resumed.session.resume()).toBe(true)
  expect(resumed.session.contextManager.state.summary).toBe(
    t.session.contextManager.state.summary,
  )
  await resumed.run('continue')
  expect(JSON.stringify(resumed.model.calls[0]!.prompt)).toContain(
    '[Summary of the earlier conversation]',
  )
})

test('a summary that fails validation stops the turn and leaves history untouched', async () => {
  const probe = createTestVela()
  const base = await requestTokens(probe)
  await probe.cleanup()
  const t = createTestVela({
    limits: { microcompactThreshold: 1e9, summaryThreshold: base + 4 * 400 },
    responses: Array.from({ length: 4 }, (_, i) => fauxText(`Answer ${i}`)),
    generate: [fauxText('OK, the summary is ready.')],
  })
  for (let i = 0; i < 4; i++)
    await t.run(`Question ${i}: ${'Background. '.repeat(100)}`)
  const before = JSON.stringify(t.messages)

  await expect(
    t.run(`Question 4: ${'Background. '.repeat(100)}`),
  ).rejects.toThrow('original history kept')

  expect(JSON.stringify(t.messages.slice(0, 8))).toBe(before)
  expect(t.session.contextManager.state.summary).toBe('')
})

test('/defend applies microcompact only and never pays for a summary', async () => {
  const t = createTestVela({
    limits: {
      microcompactThreshold: 1,
      minMicroSavings: 1,
      summaryThreshold: 1,
    },
  })
  const { output } = await captureConsole(async () => {
    t.dispatch('sim')
    await t.command('defend')
  })
  expect(output).toContain('[sim done]')
  // Over the summary threshold, but /defend does not allow a summary: it only reports that one is needed and sends no request
  expect(t.eventsOf('context').map((e) => e.action)).toContain(
    'summary-required',
  )
  expect(t.model.calls).toHaveLength(0)
})

test('session.compact() summarizes old history on demand, with an optional focus', async () => {
  const t = createTestVela({
    responses: Array.from({ length: 4 }, (_, i) => fauxText(`Answer ${i}`)),
    generate: [fauxSummary()],
  })
  for (let i = 0; i < 4; i++) await t.run(`Question ${i}`)

  await t.session.compact('Keep question 0')

  const compact = t.eventsOf('context').find((e) => e.action === 'compact')
  expect(compact?.messages).toBe(2)
  const generate = t.model.calls.find((c) => c.kind === 'generate')!
  expect(generate.lastUserText).toContain('Keep question 0')
  expect(t.session.contextManager.state.summary).toContain('## User goal')
  expect(await t.readData('sessions/default.jsonl')).toContain('Question 0')
  expect(t.session.isRunning).toBe(false)
})

test('session.compact() refuses while a task is running', async () => {
  const t = createTestVela({ responses: [fauxHang('thinking')] })
  const running = t.run('Think it over slowly')
  while (!t.streamedText()) await Bun.sleep(1)

  await expect(t.session.compact()).rejects.toThrow('A task is already running')
  await t.session.abort()
  await expect(running).rejects.toThrow()
})
