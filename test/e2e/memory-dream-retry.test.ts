import { afterEach, expect, spyOn, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { openDatabase } from '../../packages/vela/src/db/sqlite.ts'
import { MemoryDream } from '../../packages/vela/src/driver/memory/dream.ts'
import { MemoryStore } from '../../packages/vela/src/runtime/memory/store.ts'
import {
  fauxError,
  fauxText,
  fauxToolCall,
} from '../../packages/vela/src/testing/core/index.ts'
import {
  cleanupTestVelas,
  createTestVela,
  type TestVela,
} from '../support/vela.ts'

afterEach(cleanupTestVelas)

const read = (t: TestVela, path: string) =>
  readFileSync(t.dataPath(path), 'utf8')
const generations = (t: TestVela) =>
  t.model.calls.filter((call) => call.kind === 'generate').length
const result = (ops: unknown[] = []) =>
  fauxText(JSON.stringify({ ops, report: 'Consolidated recent evidence' }))

function dreamAudit(t: TestVela) {
  const db = openDatabase({ path: join(t.dataDir, 'vela.db'), readonly: true })
  try {
    const memoryDir = t.dataPath('memory')
    return new MemoryDream(new MemoryStore(memoryDir), db, {
      kind: 'tagged',
      key: `dir:${resolve(memoryDir)}`,
    }).auditState()
  } finally {
    db.close()
  }
}

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
  t.model.pushGenerate(fauxError('429 Too Many Requests'))
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
    failedStatus: /Last dream .*failed:.*429/i.test(failedStatus),
    running: unexpectedRetry,
  }).toEqual({ generations: 1, failedStatus: true, running: false })

  t.model.pushGenerate(fauxError('429 Too Many Requests'))
  const manual = holdNextDream(t)
  const manuallyRetrying = t.session.prompt('/dream')
  await manual.entered
  // Count this newly collected turn from the attempt snapshot, not completion.
  await turn(t, 'during-manual-attempt', true)
  await manual.finish(manuallyRetrying)
  expect(generations(t)).toBe(2)

  for (let i = 2; i <= 19; i++) await turn(t, `after-manual1-${i}`, true)
  expect(generations(t)).toBe(2)
  t.model.pushGenerate(fauxError('429 Too Many Requests'))
  const retry2 = holdNextDream(t)
  await turn(t, 'after-manual1-20', true)
  await retry2.entered
  await retry2.finish()
  expect(generations(t)).toBe(3)

  for (let i = 1; i <= 19; i++) await turn(t, `new-${i}`, true)
  expect(generations(t)).toBe(3)
  expect(existsSync(t.dataPath('memory/.dream'))).toBe(false)
  const preSuccessAudit = dreamAudit(t)
  expect(preSuccessAudit.dropped).toBeGreaterThan(0)
  expect(preSuccessAudit.pendingTurns.length).toBeLessThan(64)

  t.model.pushGenerate(result())
  const retry = holdNextDream(t)
  await turn(t, 'new-20', true)
  await retry.entered
  await retry.finish()
  expect(generations(t)).toBe(4)
  expect(dreamAudit(t).pendingTurns).toEqual([])
  expect(await status(t)).not.toMatch(/failed|skipped/i)

  for (let i = 1; i < 20; i++) await turn(t, `after-success-${i}`)
  expect(generations(t)).toBe(4)
  t.model.pushGenerate(result())
  const successful = holdNextDream(t)
  await turn(t, 'after-success-20')
  await successful.entered
  await successful.finish()
  expect(generations(t)).toBe(5)
  expect(dreamAudit(t).pendingTurns).toEqual([])
})

test('a conflict-skipped dream reports its outcome and waits 24 hours from the attempt rather than the retained inbox age', async () => {
  let now = Date.now()
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
    expect(dreamAudit(t).pendingTurns).toHaveLength(3)

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
    expect(dreamAudit(t).pendingTurns).toEqual([])
    expect(await status(t)).not.toMatch(/failed|skipped/i)
  } finally {
    clock.mockRestore()
  }
})

test('manual dream accepts one surrounding fence, a stray closing fence or trailing prose, and still rejects a second payload', async () => {
  const t = createTestVela({
    generate: [],
    extensionConfig: { memory: { dream: false } },
  })
  const op = (index: number) => ({
    action: 'create',
    filename: `project_release-${index}.md`,
    name: `release-${index}`,
    description: 'Release day',
    type: 'project',
    content: 'Release on Tuesday',
    reason: 'Keep the user-provided schedule',
    source: 'default',
  })
  const body = (index: number) =>
    JSON.stringify({ ops: [op(index)], report: 'Saved release schedule' })
  const fenced = (text: string) => `\n\`\`\`json\n${text}\n\`\`\`\n`
  const accepted = [
    fenced(body(0)),
    `${body(1)}\n\`\`\``,
    `${body(2)}\nThese notes record the schedule.`,
    `${body(3)}\nSaved \`project_release-3.md\`.`,
  ]
  for (const [index, reply] of accepted.entries()) {
    t.model.push(fauxText('Noted'))
    await t.session.prompt(`Remember that releases happen on Tuesday ${index}`)
    t.model.pushGenerate(fauxText(reply))
    await t.session.prompt('/dream')
    expect(await status(t)).not.toMatch(/failed|skipped/i)
    expect(existsSync(t.dataPath(`memory/project_release-${index}.md`))).toBe(
      true,
    )
    expect(dreamAudit(t).pendingTurns).toEqual([])
  }

  t.model.push(fauxText('Noted'))
  await t.session.prompt('Keep this evidence until a valid consolidation')
  const retained = dreamAudit(t).pendingTurns
  const noteBefore = read(t, 'memory/project_release-0.md')
  for (const invalid of [
    `Here is the JSON:\n${fenced(JSON.stringify({ ops: [], report: 'Leading text' }))}`,
    `${body(0)}\n${body(0)}`,
    `${body(0)}\n["project_release-1.md"]`,
    fenced(
      JSON.stringify({
        ops: [{ ...op(0), filename: '../escape.md' }],
        report: 'Unsafe filename',
      }),
    ),
    `${fenced(JSON.stringify({ ops: [], report: 'First' }))}${fenced(
      JSON.stringify({ ops: [], report: 'Second' }),
    )}`,
  ]) {
    const before = generations(t)
    t.model.pushGenerate(fauxText(invalid))
    // The correction round repeats the same rejected reply; no third call follows.
    t.model.pushGenerate(fauxText(invalid))
    await t.session.prompt('/dream')
    expect(await status(t)).toMatch(/failed/i)
    expect(generations(t) - before).toBe(2)
    expect(dreamAudit(t).pendingTurns).toEqual(retained)
    expect(read(t, 'memory/project_release-0.md')).toBe(noteBefore)
    expect(existsSync(t.dataPath('escape.md'))).toBe(false)
  }
  // The failure log keeps what the model actually sent; the status line stays short.
  const long = `not JSON ${'p'.repeat(2000)}-TAIL-END`
  t.model.pushGenerate(fauxText(long))
  t.model.pushGenerate(fauxText(long))
  await t.session.prompt('/dream')
  const audit = dreamAudit(t)
  const entry = audit.logs.at(-1)!.report
  const tail = entry.slice(entry.indexOf('Response tail:'))
  expect(tail.trimEnd()).toBe(`Response tail:\n${long.slice(-500)}`)
  expect(entry).toContain('Inbox retained')
  expect(audit.lastRun?.failed).not.toContain('Response tail')
  expect(existsSync(t.dataPath('memory/.dream'))).toBe(false)
})
