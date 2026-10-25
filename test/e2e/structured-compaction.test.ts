import { afterEach, expect, test } from 'bun:test'
import {
  createFauxModel,
  fauxError,
  fauxText,
  fauxToolCall,
} from '../../src/testing/faux.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

const checkpoint = `## Goal
Finish the alpha and beta checks.

## Constraints & Preferences
Keep the failure reason.

## Progress
### Done
- [x] Alpha passed; report.txt was written.
### In Progress
- [ ] Repair beta.
### Blocked
- Beta validation exits with code 7.

## Key Decisions
- Repair beta before running the final check.

## Next Steps
1. Fix beta validation, then run the final check.

## Critical Context
- beta exit 7: validation failed.`

const replies = () => Array.from({ length: 4 }, () => fauxText('noted'))

test('free-text checkpoint appends tool-derived file lists and reaches a resumed where-were-we turn', async () => {
  const t = createTestVela({
    files: { 'alpha.txt': 'alpha', 'beta.txt': 'beta' },
    responses: [
      [
        fauxToolCall('read_file', { path: 'beta.txt' }),
        fauxToolCall('read_file', { path: 'alpha.txt' }),
        fauxToolCall('read_file', { path: 'alpha.txt' }),
      ],
      fauxToolCall('edit_file', {
        path: 'beta.txt',
        edits: [{ oldText: 'beta', newText: 'fixed beta' }],
      }),
      fauxToolCall('write_file', {
        path: 'report.txt',
        content: 'alpha passed',
      }),
      fauxText('Alpha passed; report.txt written. Beta still exits 7.'),
      ...replies(),
    ],
    generate: [fauxText(checkpoint)],
  })
  await t.run('Check alpha and beta, keep the reason beta failed.')
  for (let i = 0; i < 3; i++) await t.run(`Recent question ${i}`)
  await t.session.compact('Keep the beta failure and what to do next')
  const summary = t.session.contextManager.state.summary
  expect(summary).toContain(checkpoint)
  expect(summary).toContain('<read-files>\nalpha.txt\n</read-files>')
  expect(summary).toContain(
    '<modified-files>\nbeta.txt\nreport.txt\n</modified-files>',
  )
  expect(summary.match(/Earlier tool output:/g)).toHaveLength(1)
  expect(summary).toContain('/snapshots/through-')
  expect(await t.readFile('report.txt')).toBe('alpha passed')
  const generated = t.model.calls.find((call) => call.kind === 'generate')!
  expect(generated.responseFormat?.type).not.toBe('json')
  expect(generated.lastUserText).toContain(
    'Keep the beta failure and what to do next',
  )
  expect(generated.lastUserText).toContain('## Next Steps')
  expect(generated.tools).toEqual([])
  // Recompact after another turn: prior files are still computed from recorded calls.
  await t.run('Keep going')
  t.model.pushGenerate(fauxText(checkpoint))
  await t.session.compact()
  const again = t.session.contextManager.state.summary
  expect(again).toContain('<read-files>\nalpha.txt\n</read-files>')
  expect(again).toContain(
    '<modified-files>\nbeta.txt\nreport.txt\n</modified-files>',
  )
  expect(again.match(/Earlier tool output:/g)).toHaveLength(1)
  const resumed = createTestVela({
    cwd: t.cwd,
    responses: [fauxText('Repair beta next.')],
  })
  expect(await resumed.session.resume()).toBe(true)
  await resumed.run('where were we?')
  const request = resumed.model.calls[0]!
  expect(request.lastUserText).toBe('where were we?')
  const context = JSON.stringify(request.prompt)
  expect(context).toContain('## Progress')
  expect(context).toContain('Alpha passed; report.txt was written.')
  expect(context).toContain('## Next Steps')
  expect(context).toContain('Fix beta validation, then run the final check.')
  expect(context).toContain('<modified-files>')
})

for (const [label, response, error] of [
  [
    'provider error',
    fauxError('503 summary provider unavailable'),
    'summary provider unavailable',
  ],
  [
    'partial output',
    fauxText(checkpoint, { finishReason: 'length' }),
    'not fully generated',
  ],
  ['empty output', fauxText(''), 'not fully generated'],
  [
    'tool call',
    fauxToolCall('write_file', { path: 'oops.txt', content: 'oops' }),
    'tool calls',
  ],
] as const) {
  test(`a ${label} surfaces the failure and preserves live and saved history`, async () => {
    const t = createTestVela({ responses: replies(), generate: [response] })
    for (let i = 0; i < 4; i++) await t.run(`Question ${i}`)
    const messages = JSON.stringify(t.messages)
    const entries = t.session.getEntries()
    const saved = await t.readData('sessions/default.jsonl')
    await expect(t.session.compact()).rejects.toThrow(error)
    expect(JSON.stringify(t.messages)).toBe(messages)
    expect(t.session.getEntries()).toEqual(entries)
    expect(await t.readData('sessions/default.jsonl')).toBe(saved)
    expect(t.session.contextManager.state.summary).toBe('')
    expect(t.eventsOf('compaction_end').at(-1)).toMatchObject({
      reason: 'manual',
      aborted: false,
      willRetry: false,
      errorMessage: expect.stringContaining(error),
    })
    expect(
      t.model.calls.filter((call) => call.kind === 'generate'),
    ).toHaveLength(1)
  })
}

test('interrupting a summary preserves history and a later prompt still works', async () => {
  let started!: () => void
  let release!: () => void
  const generating = new Promise<void>((resolve) => {
    started = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const model = createFauxModel({
    responses: [...replies(), fauxText('continued')],
    generate: [fauxText(checkpoint)],
  })
  const generate = model.doGenerate.bind(model)
  model.doGenerate = async (options) => {
    started()
    await held
    return generate(options)
  }
  const t = createTestVela({ model })
  for (let i = 0; i < 4; i++) await t.run(`Question ${i}`)
  const messages = JSON.stringify(t.messages)
  const saved = await t.readData('sessions/default.jsonl')
  const compacting = t.session.compact()
  const rejected = compacting.catch((error: unknown) => error)
  await generating
  const aborting = t.session.abort()
  release()
  await aborting
  expect(await rejected).toBeInstanceOf(Error)
  expect(JSON.stringify(t.messages)).toBe(messages)
  expect(await t.readData('sessions/default.jsonl')).toBe(saved)
  expect(t.eventsOf('compaction_end').at(-1)).toMatchObject({
    aborted: true,
    willRetry: false,
  })
  await t.run('continue after interruption')
  expect(t.lastAssistantText()).toBe('continued')
})

for (const mode of ['manual', 'threshold', 'overflow', 'branch'] as const) {
  test(`${mode} summary uses the configured model output limit, independently of thresholds`, async () => {
    const model = createFauxModel({
      responses: [
        ...Array.from({ length: 4 }, (_, i) =>
          fauxText(
            'noted',
            mode === 'threshold' && i === 3 ? { usage: { input: 60000 } } : {},
          ),
        ),
        ...(mode === 'overflow'
          ? [
              fauxError(
                '400 prompt is too long: 250000 tokens > 200000 maximum',
              ),
            ]
          : []),
        fauxText('continued'),
      ],
      generate: [fauxText(checkpoint)],
    })
    let outputLimit: number | undefined
    const generate = model.doGenerate.bind(model)
    model.doGenerate = async (options) => {
      outputLimit = options.maxOutputTokens
      return generate(options)
    }
    const t = createTestVela({
      model: 'local/checkpoint',
      providers: {
        local: {
          models: [{ id: 'checkpoint', maxTokens: 32000 }],
          createModel: () => model,
        },
      },
      limits: {
        microcompactThreshold: 1e9,
        summaryThreshold: mode === 'threshold' ? 50000 : 1e9,
      },
    })
    for (let i = 0; i < 4; i++) await t.run(`Question ${i}`)
    if (mode === 'threshold') {
      // The provider size is what determines when the next turn compacts.
      await t.run('continue')
    } else if (mode === 'overflow') await t.run('continue')
    else if (mode === 'branch') {
      const target = t.session
        .getEntries()
        .find((entry) => entry.type === 'message')!
      await t.session.navigateTree(target.id, { summarize: true })
    } else await t.session.compact()
    expect(outputLimit).toBe(32000)
    expect(model.calls.filter((call) => call.kind === 'generate')).toHaveLength(
      1,
    )
    // Custom model's queue is checked directly because t.model is only the default faux.
    expect(t.eventsOf('compaction_end').at(-1)?.errorMessage).toBeUndefined()
  })
}
