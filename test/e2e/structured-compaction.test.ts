import { afterEach, expect, test } from 'bun:test'
import {
  createFauxModel,
  fauxError,
  fauxText,
  fauxToolCall,
} from '@glows777/vela-core/testing'
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

for (const nestedBranch of [false, true]) {
  test(`computed file lists survive ${nestedBranch ? 'nested branch summaries' : 'a branch summary'}, resume and later compaction`, async () => {
    const t = createTestVela({
      files: { 'reference.txt': 'reference' },
      responses: [
        fauxToolCall('write_file', { path: 'x.txt', content: 'finished' }),
        fauxText('x.txt written'),
        ...(nestedBranch
          ? [
              fauxToolCall('read_file', { path: 'reference.txt' }),
              fauxText('reference read'),
            ]
          : []),
      ],
      generate: [
        fauxText(checkpoint),
        ...(nestedBranch ? [fauxText(checkpoint)] : []),
      ],
    })
    await t.run('Write x.txt')
    const rootQuestion = t.session
      .getEntries()
      .find((entry) => entry.type === 'message')!
    await t.session.navigateTree(rootQuestion.id, { summarize: true })
    const branchSummary = t.session
      .getEntries()
      .find((entry) => entry.type === 'branch_summary')!
    expect(
      branchSummary.type === 'branch_summary' && branchSummary.summary,
    ).toContain('<modified-files>\nx.txt\n</modified-files>')
    if (nestedBranch) {
      await t.run('Read reference.txt')
      // Leaving the new branch must carry the file calls behind its earlier summary too.
      await t.session.navigateTree(rootQuestion.id, { summarize: true })
      const latest = t.session
        .getEntries()
        .filter((entry) => entry.type === 'branch_summary')
        .at(-1)!
      expect(latest.type === 'branch_summary' && latest.summary).toContain(
        '<modified-files>\nx.txt\n</modified-files>',
      )
    }
    const resumed = createTestVela({
      cwd: t.cwd,
      responses: [
        ...Array.from({ length: 4 }, () => fauxText('noted')),
        fauxText('Repair beta next.'),
      ],
      generate: [fauxText(checkpoint), fauxText(checkpoint)],
    })
    expect(await resumed.session.resume()).toBe(true)
    for (let i = 0; i < 3; i++) await resumed.run(`Recent question ${i}`)
    await resumed.session.compact()
    const first = resumed.session.contextManager.state.summary
    expect(first).toContain('<modified-files>\nx.txt\n</modified-files>')
    if (nestedBranch)
      expect(first).toContain('<read-files>\nreference.txt\n</read-files>')
    expect(first.match(/Earlier tool output:/g)).toHaveLength(1)
    // A compaction entry must keep the branch-summary provenance on the next compaction.
    await resumed.run('Continue')
    await resumed.session.compact()
    expect(resumed.session.contextManager.state.summary).toContain(
      '<modified-files>\nx.txt\n</modified-files>',
    )
    await resumed.run('where were we?')
    expect(JSON.stringify(resumed.model.calls.at(-1)!.prompt)).toContain(
      '<modified-files>',
    )
  })
}

for (const copy of ['clone', 'fork'] as const) {
  test(`${copy} preserves branch-summary files through resumed compaction`, async () => {
    const t = createTestVela({
      files: { 'reference.txt': 'reference' },
      responses: [
        fauxToolCall('read_file', { path: 'reference.txt' }),
        fauxToolCall('write_file', { path: 'x.txt', content: 'finished' }),
        fauxText('done'),
        fauxText('new branch'),
        fauxText('next turn'),
      ],
      generate: [fauxText(checkpoint)],
    })
    await t.run('Read reference and write x.txt')
    const root = t.session.getEntries().find((e) => e.type === 'message')!
    await t.session.navigateTree(root.id, { summarize: true })
    await t.run('Continue on this branch')
    await t.run('Fork here')
    const question = t.session
      .getEntries()
      .find((e) => e.type === 'message' && e.message.content === 'Fork here')!
    if (copy === 'clone') await t.session.clone({ sessionId: 'copied' })
    else await t.session.fork(question.id, { sessionId: 'copied' })
    const resumed = createTestVela({
      cwd: t.cwd,
      sessionId: 'copied',
      responses: [...replies(), fauxText('continue with x.txt')],
      generate: [fauxText(checkpoint), fauxText(checkpoint)],
    })
    expect(await resumed.session.resume()).toBe(true)
    for (let i = 0; i < 3; i++) await resumed.run(`Recent ${i}`)
    await resumed.session.compact()
    await resumed.run('Continue')
    await resumed.session.compact()
    expect(resumed.session.contextManager.state.summary).toContain(
      '<read-files>\nreference.txt\n</read-files>',
    )
    expect(resumed.session.contextManager.state.summary).toContain(
      '<modified-files>\nx.txt\n</modified-files>',
    )
    await resumed.run('where were we?')
    expect(JSON.stringify(resumed.model.calls.at(-1)!.prompt)).toContain(
      'x.txt',
    )
  })
}

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
