import { afterEach, expect, spyOn, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { fauxText, fauxToolCall } from '@glows777/vela-core/testing'
import {
  cleanupTestVelas,
  createTestVela,
  type TestVela,
} from '../support/vela.ts'

afterEach(cleanupTestVelas)

const inboxFile = 'memory/.dream/inbox.jsonl'
const read = (t: TestVela, path: string) =>
  readFileSync(t.dataPath(path), 'utf8')
const inbox = (t: TestVela) => read(t, inboxFile).split('\n').filter(Boolean)
const generations = (t: TestVela) =>
  t.model.calls.filter((call) => call.kind === 'generate').length
const result = (ops: unknown[] = []) =>
  fauxText(JSON.stringify({ ops, report: 'Consolidated recent evidence' }))

async function status(t: TestVela) {
  await t.session.prompt('/memory')
  return t.eventsOf('notify').at(-1)!.message
}

async function turn(t: TestVela, label: string, large = false) {
  t.model.push(fauxText(large ? 'Answer '.repeat(300) : 'Noted'))
  await t.vela
    .session(label.replaceAll(' ', '-'))
    .prompt(large ? `${label}: ${'Durable fact '.repeat(180)}` : label)
}

function holdNextDream(t: TestVela) {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const generate = t.model.doGenerate.bind(t.model)
  const spy = spyOn(t.model, 'doGenerate').mockImplementationOnce(
    async (options) => {
      entered.resolve()
      await release.promise
      return generate(options)
    },
  )
  return {
    entered: entered.promise,
    async finish(joined = t.session.prompt('/dream')) {
      // Joining an already-entered run gives a public completion barrier
      // without sleeps or observing a private MemoryDream instance.
      release.resolve()
      try {
        await joined
      } finally {
        spy.mockRestore()
      }
    },
  }
}

test('failed automatic dreams wait for 20 new turns despite inbox eviction, while manual retry and successful resets still work', async () => {
  const t = createTestVela({ generate: [], faux: { chunkSize: 4096 } })
  t.model.pushGenerate(fauxText('not JSON'))
  const first = holdNextDream(t)
  for (let i = 0; i < 20; i++) await turn(t, `initial-${i}`, true)
  await first.entered
  await first.finish()
  const failedStatus = await status(t)

  for (let i = 1; i <= 5; i++) await turn(t, `after-failure-${i}`, true)
  const unexpectedRetry = (await status(t)).includes('; running')
  if (unexpectedRetry) await t.session.prompt('/dream')
  expect({
    generations: generations(t),
    failedStatus: /Last dream .*failed:.*(?:JSON|parse|unexpected)/i.test(
      failedStatus,
    ),
    running: unexpectedRetry,
  }).toEqual({ generations: 1, failedStatus: true, running: false })

  t.model.pushGenerate(fauxText('still not JSON'))
  const manual = holdNextDream(t)
  const manuallyRetrying = t.session.prompt('/dream')
  await manual.entered
  // Count this newly collected turn from the attempt snapshot, not completion.
  await turn(t, 'during-manual-attempt', true)
  await manual.finish(manuallyRetrying)
  expect(generations(t)).toBe(2)
  for (let i = 2; i <= 19; i++) await turn(t, `new-${i}`, true)
  expect(generations(t)).toBe(2)
  expect(
    JSON.parse(read(t, 'memory/.dream/state.json')).dropped,
  ).toBeGreaterThan(0)
  expect(inbox(t).length).toBeLessThan(44)

  t.model.pushGenerate(result())
  const retry = holdNextDream(t)
  await turn(t, 'new-20', true)
  await retry.entered
  await retry.finish()
  expect(generations(t)).toBe(3)
  expect(inbox(t)).toEqual([])
  expect(await status(t)).not.toMatch(/failed|skipped/i)

  for (let i = 1; i < 20; i++) await turn(t, `after-success-${i}`)
  expect(generations(t)).toBe(3)
  t.model.pushGenerate(result())
  const successful = holdNextDream(t)
  await turn(t, 'after-success-20')
  await successful.entered
  await successful.finish()
  expect(generations(t)).toBe(4)
  expect(inbox(t)).toEqual([])
})

test('a conflict-skipped dream reports its outcome and waits 24 hours from the attempt rather than the retained inbox age', async () => {
  let now = Date.UTC(2026, 10, 8)
  const clock = spyOn(Date, 'now').mockImplementation(() => now)
  const note = {
    name: 'release-day',
    description: 'Release schedule',
    type: 'project' as const,
    content: 'Release on Monday',
  }
  const t = createTestVela({ generate: [] })
  try {
    t.model.push(
      fauxToolCall('memory', { action: 'save', ...note }),
      fauxText('Saved'),
    )
    await t.session.prompt('Remember the release schedule')
    now += 25 * 3600_000
    t.model.pushGenerate(
      result([
        {
          action: 'update',
          filename: 'project_release-day.md',
          ...note,
          content: 'Release on Tuesday',
          reason: 'The user updated the schedule',
          source: 'default',
        },
      ]),
    )
    const conflict = holdNextDream(t)
    await turn(t, 'Release now happens on Tuesday')
    await conflict.entered
    t.model.push(
      fauxToolCall('memory', {
        action: 'save',
        ...note,
        content: 'Release on Wednesday',
      }),
      fauxText('Saved latest schedule'),
    )
    await t.vela.session('live').prompt('Actually save Wednesday')
    await conflict.finish()
    const skippedStatus = await status(t)
    expect(read(t, 'memory/project_release-day.md')).toContain('Wednesday')
    expect(inbox(t)).toHaveLength(3)

    now += 3600_000
    await turn(t, 'One hour after the skipped attempt')
    const unexpectedRetry = (await status(t)).includes('; running')
    if (unexpectedRetry) await t.session.prompt('/dream')
    expect({
      generations: generations(t),
      skippedStatus: /Last dream .*skipped:.*notes changed/i.test(
        skippedStatus,
      ),
      running: unexpectedRetry,
    }).toEqual({ generations: 1, skippedStatus: true, running: false })
    now += 23 * 3600_000 - 1
    await turn(t, 'Just before the retry becomes due')
    expect(generations(t)).toBe(1)

    now += 2
    t.model.pushGenerate(result())
    const retry = holdNextDream(t)
    await turn(t, 'More than 24 hours after the skipped attempt')
    await retry.entered
    await retry.finish()
    expect(generations(t)).toBe(2)
    expect(inbox(t)).toEqual([])
    expect(await status(t)).not.toMatch(/failed|skipped/i)
  } finally {
    clock.mockRestore()
  }
})

test('manual dream accepts one surrounding JSON fence but still rejects unsafe operations and multiple fences', async () => {
  const t = createTestVela({
    generate: [],
    extensionConfig: { memory: { dream: false } },
  })
  const op = {
    action: 'create',
    filename: 'project_release.md',
    name: 'release',
    description: 'Release day',
    type: 'project',
    content: 'Release on Tuesday',
    reason: 'Keep the user-provided schedule',
    source: 'default',
  }
  const fenced = (ops: unknown[]) =>
    `\n\`\`\`json\n${JSON.stringify({ ops, report: 'Saved release schedule' })}\n\`\`\`\n`
  t.model.push(fauxText('Noted'))
  await t.session.prompt('Remember that releases happen on Tuesday')
  t.model.pushGenerate(fauxText(fenced([op])))
  await t.session.prompt('/dream')
  expect(existsSync(t.dataPath('memory/project_release.md'))).toBe(true)
  expect(read(t, 'memory/project_release.md')).toContain('Release on Tuesday')
  expect(inbox(t)).toEqual([])

  t.model.push(fauxText('Noted'))
  await t.session.prompt('Keep this evidence until a valid consolidation')
  const retained = read(t, inboxFile)
  const noteBefore = read(t, 'memory/project_release.md')
  for (const invalid of [
    fenced([{ ...op, filename: '../escape.md' }]),
    `${fenced([])}${fenced([])}`,
  ]) {
    t.model.pushGenerate(fauxText(invalid))
    await t.session.prompt('/dream')
    expect(await status(t)).toMatch(/failed/i)
    expect(read(t, inboxFile)).toBe(retained)
    expect(read(t, 'memory/project_release.md')).toBe(noteBefore)
    expect(existsSync(t.dataPath('escape.md'))).toBe(false)
  }
})
