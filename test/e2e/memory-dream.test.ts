import { afterEach, expect, spyOn, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { fauxText, fauxToolCall } from '@glows777/vela-core/testing'
import { MemoryStore } from '../../packages/core/src/extensions/memory/store.ts'
import {
  captureConsole,
  cleanupTestVelas,
  createTestVela,
} from '../support/vela.ts'

afterEach(cleanupTestVelas)
const deploy = {
  name: 'deploy-day',
  description: 'Deployment day',
  type: 'project' as const,
  content: 'Deploys happen on Friday',
}
const update = (source: string) => ({
  action: 'update',
  filename: 'project_deploy-day.md',
  ...deploy,
  content: 'Deploys happen on Monday',
  reason: 'The user corrected the schedule',
  source,
})
const result = (
  ops: unknown[] = [],
  report = 'Consolidated recent conversations',
) => fauxText(JSON.stringify({ ops, report }))
const text = (file: string) => readFileSync(file, 'utf8')
const records = (file: string) =>
  text(file)
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
const notices = (t: ReturnType<typeof createTestVela>) =>
  t
    .eventsOf('notify')
    .map((e) => e.message)
    .join('\n')
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for background dream')
    await Bun.sleep(1)
  }
}

test('a real memory save and later correction consolidate offline with provenance, audit and usage', async () => {
  const t = createTestVela({
    sessionId: 'first',
    responses: [
      fauxToolCall('memory', { action: 'save', ...deploy }),
      fauxText('Saved'),
      fauxText('Monday it is'),
    ],
    generate: [
      (req) => {
        expect(req.kind).toBe('generate')
        expect(req.tools).toEqual([])
        expect(JSON.stringify(req.prompt)).toContain('Deploys happen on Friday')
        expect(JSON.stringify(req.prompt)).toContain('Deploys moved to Monday')
        return {
          ...result([update('second')], 'Corrected deployment day'),
          usage: { input: 123, output: 45 },
        }
      },
    ],
  })
  await t.run('Remember deploys happen on Friday')
  const second = t.vela.session('second')
  await second.prompt('Deploys moved to Monday')
  const before = JSON.stringify(second.messages)
  await second.prompt('/dream')
  expect(JSON.stringify(second.messages)).toBe(before)
  const note = await t.readData('memory/project_deploy-day.md')
  expect(note).toContain('Deploys happen on Monday')
  expect(note).toMatch(/sources:.*second/)
  expect(await t.readData('memory/.dream/log.md')).toContain(
    'Corrected deployment day',
  )
  expect(records(t.dataPath('memory/.dream/inbox.jsonl'))).toEqual([])
  const ledger = records(t.dataPath('usage/requests.jsonl'))
  expect(ledger.filter((row) => row.kind === 'dream')).toHaveLength(1)
  expect(ledger.at(-1).inputTokens).toBe(123)
  const { output } = await captureConsole(() => {
    t.ctx.session = second
    return t.command('/usage')
  })
  expect(output).toContain('2 steps total')
  await second.prompt('/memory')
  expect(notices(t)).toMatch(/dream/i)
  expect(notices(t)).toMatch(/inbox/i)
})

test('dream instructs the model that only user messages are evidence', async () => {
  const invented = 'Changes must be reviewed and ready by end of day Friday.'
  const t = createTestVela({
    responses: [fauxText(invented)],
    generate: [
      (req) => {
        const input = JSON.parse(req.lastUserText) as {
          inbox: { sessionId: string }[]
        }
        return result([
          {
            action: 'create',
            filename: 'project_review-deadline.md',
            name: 'review-deadline',
            description: 'Review deadline',
            type: 'project',
            content: invented,
            reason: 'The assistant stated the deadline',
            source: input.inbox[0]!.sessionId,
          },
        ])
      },
    ],
  })
  await t.run('Prepare the release notes')
  await t.run('/dream')
  const call = t.model.calls.find((item) => item.kind === 'generate')!
  expect(call.system).toContain('User messages are the evidence')
  expect(call.system).toContain(
    'a claim that appears only in assistant text is never saved as a fact',
  )
  const input = JSON.parse(call.lastUserText) as {
    inbox: { assistant: string }[]
  }
  expect(input.inbox[0]?.assistant).toBe(invented)
})

test('shared groups consolidate only their own inbox and never modify global or another group', async () => {
  const t = createTestVela({
    responses: [
      fauxText('A noted'),
      fauxText('B noted'),
      fauxText('Global noted'),
    ],
    generate: [
      (req) => {
        const prompt = JSON.stringify(req.prompt)
        expect(prompt).toContain('A-private-correction')
        expect(prompt).not.toContain('B-private-correction')
        expect(prompt).not.toContain('Global-private-correction')
        expect(prompt).not.toContain('Global-secret-note')
        return result([update('group-a')])
      },
    ],
  })
  const aDir = t.dataPath('groups/a')
  const bDir = t.dataPath('groups/b')
  const a = t.vela.session('group-a', {
    scope: { id: 'a', kind: 'shared', dataDir: aDir },
  })
  const b = t.vela.session('group-b', {
    scope: { id: 'b', kind: 'shared', dataDir: bDir },
  })
  new MemoryStore(join(aDir, 'memory')).save(deploy)
  new MemoryStore(join(bDir, 'memory')).save(deploy)
  new MemoryStore(t.dataPath('memory')).save({
    ...deploy,
    content: 'Global-secret-note',
  })
  await a.prompt('A-private-correction: Monday')
  await b.prompt('B-private-correction: Tuesday')
  await t.run('Global-private-correction')
  const otherBefore = text(join(bDir, 'memory/project_deploy-day.md'))
  const globalBefore = await t.readData('memory/project_deploy-day.md')
  await a.prompt('/dream')
  expect(text(join(aDir, 'memory/project_deploy-day.md'))).toContain('Monday')
  expect(text(join(bDir, 'memory/project_deploy-day.md'))).toBe(otherBefore)
  expect(await t.readData('memory/project_deploy-day.md')).toBe(globalBefore)
})

test('a live save during an isolated dream is preserved and the skipped overwrite is reported', async () => {
  const t = createTestVela({
    responses: [
      fauxText('Monday'),
      fauxToolCall('memory', {
        action: 'save',
        ...deploy,
        content: 'Deploys happen on Tuesday',
      }),
      fauxText('Saved Tuesday'),
    ],
    generate: [result([update('default')])],
  })
  new MemoryStore(t.dataPath('memory')).save(deploy)
  await t.run('Deploys moved to Monday')
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const generate = t.model.doGenerate.bind(t.model)
  let started = false
  spyOn(t.model, 'doGenerate').mockImplementation(async (opts) => {
    started = true
    await gate
    return generate(opts)
  })
  const dreaming = t.run('/dream')
  try {
    await until(() => started)
    await t.vela.session('live').prompt('Actually save Tuesday now')
  } finally {
    release()
  }
  await dreaming
  expect(await t.readData('memory/project_deploy-day.md')).toContain('Tuesday')
  expect(notices(t)).toMatch(/skip/i)
  expect(await t.readData('memory/.dream/log.md')).toMatch(/skip/i)
})

test('over 200 index entries remain discoverable and dream condenses the injected index', async () => {
  const t = createTestVela({
    responses: [fauxText('OK')],
    generate: [
      result(
        Array.from({ length: 204 }, (_, i) => ({
          action: 'delete',
          filename: `project_entry-${i}.md`,
          reason: 'Duplicate deployment advice',
          source: 'default',
        })),
      ),
    ],
  })
  const store = new MemoryStore(t.dataPath('memory'))
  for (let i = 0; i < 205; i++)
    store.save({
      ...deploy,
      name: `entry-${i}`,
      description: `Deployment advice duplicate ${i}`,
    })
  expect(
    (await t.readData('memory/MEMORY.md'))
      .split('\n')
      .filter((line) => line.startsWith('- ')),
  ).toHaveLength(205)
  await t.run('Consolidate these duplicate deployment notes')
  expect(t.model.calls[0]!.lastUserText).toMatch(
    /\d+ more entries not shown; use memory search/,
  )
  await t.run('/memory')
  expect(notices(t)).toMatch(/not shown|truncat|limit/i)
  await t.run('/dream')
  expect(store.list()).toHaveLength(1)
  expect(store.loadIndex().length).toBeLessThan(4000)
  expect(store.loadIndex()).toContain('entry-204')
})

for (const trigger of ['20 turns', 'older than 24 hours']) {
  test(`automatic dream after ${trigger} does not delay a reply`, async () => {
    const turns = trigger === '20 turns' ? 20 : 1
    const t = createTestVela({
      responses: Array.from({ length: turns }, () =>
        fauxText('Immediate answer'),
      ),
      generate: [result()],
    })
    if (trigger !== '20 turns') {
      const dir = t.dataPath('memory/.dream')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'inbox.jsonl'),
        `${JSON.stringify({ id: 'old', time: Date.now() - 25 * 3600_000, sessionId: 'old-session', user: 'Old durable fact', assistant: 'Noted', tools: [] })}\n`,
      )
    }
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started = false
    const generate = t.model.doGenerate.bind(t.model)
    spyOn(t.model, 'doGenerate').mockImplementation(async (opts) => {
      started = true
      await gate
      return generate(opts)
    })
    try {
      for (let i = 0; i < turns; i++) await t.run(`Turn ${i}`)
      expect(t.lastAssistantText()).toBe('Immediate answer')
      await until(() => started)
      expect(t.session.busy.locked).toBe(false)
    } finally {
      release()
    }
    await until(() => existsSync(t.dataPath('memory/.dream/log.md')))
    expect(
      t.model.calls.filter((call) => call.kind === 'generate'),
    ).toHaveLength(1)
  })
}

test('automatic dream can be disabled while the manual command remains available', async () => {
  const t = createTestVela({
    extensionConfig: { memory: { dream: false } },
    responses: Array.from({ length: 21 }, () => fauxText('OK')),
    generate: [result()],
  })
  for (let i = 0; i < 21; i++) await t.run(`Turn ${i}`)
  expect(t.model.calls.filter((call) => call.kind === 'generate')).toHaveLength(
    0,
  )
  expect(records(t.dataPath('memory/.dream/inbox.jsonl'))).toHaveLength(21)
  await t.run('/dream')
  expect(t.model.calls.filter((call) => call.kind === 'generate')).toHaveLength(
    1,
  )
})

test('memory-denied sessions neither collect inbox records nor run a dream', async () => {
  const t = createTestVela({
    session: { permissions: { memory: 'deny' } },
    responses: [fauxText('Private answer')],
  })
  await t.run('Do not store this')
  await t.run('/dream')
  expect(existsSync(t.dataPath('memory/.dream/inbox.jsonl'))).toBe(false)
  expect(t.model.calls).toHaveLength(1)
  expect(notices(t)).toContain('Memory is not enabled')
})

for (const invalid of [
  'not JSON',
  JSON.stringify({
    ops: [{ ...update('default'), filename: '../escape.md' }],
    report: 'Unsafe filename',
  }),
  JSON.stringify({
    ops: [{ ...update('default'), type: 'unknown' }],
    report: 'Invalid type',
  }),
]) {
  test(`invalid dream response retains inbox and notes: ${invalid.slice(0, 32)}`, async () => {
    const t = createTestVela({
      responses: [fauxText('Noted')],
      generate: [fauxText(invalid)],
    })
    new MemoryStore(t.dataPath('memory')).save(deploy)
    await t.run('Deploys moved to Monday')
    const inbox = await t.readData('memory/.dream/inbox.jsonl')
    const note = await t.readData('memory/project_deploy-day.md')
    await t.run('/dream')
    expect(await t.readData('memory/.dream/inbox.jsonl')).toBe(inbox)
    expect(await t.readData('memory/project_deploy-day.md')).toBe(note)
    expect(notices(t)).toMatch(/fail|invalid|error/i)
  })
}

test('the private inbox caps each side, excludes tool output and counts dropped old records', async () => {
  const t = createTestVela({
    extensionConfig: { memory: { dream: false } },
    responses: [
      fauxToolCall('memory', { action: 'list' }),
      fauxText('A'.repeat(5000)),
      ...Array.from({ length: 40 }, () => fauxText('A'.repeat(5000))),
    ],
  })
  new MemoryStore(t.dataPath('memory')).save({
    ...deploy,
    description: 'TOOL_OUTPUT_SECRET',
  })
  for (let i = 0; i < 41; i++) await t.run(`Turn ${i}: ${'U'.repeat(5000)}`)
  const file = t.dataPath('memory/.dream/inbox.jsonl')
  expect(statSync(file).size).toBeLessThanOrEqual(102400)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  const inbox = records(file)
  expect(inbox.length).toBeLessThan(41)
  expect(inbox.at(-1).user).toContain('Turn 40:')
  for (const row of inbox) {
    expect(row.user.length).toBeLessThanOrEqual(2100)
    expect(row.assistant.length).toBeLessThanOrEqual(2100)
    expect(row.sessionId).toBe('default')
    expect(typeof row.time).toBe('number')
    expect(Array.isArray(row.tools)).toBe(true)
  }
  expect(text(file)).not.toContain('TOOL_OUTPUT_SECRET')
  expect(JSON.parse(await t.readData('memory/.dream/state.json')).dropped).toBe(
    41 - inbox.length,
  )
})

test('an unknown provenance session rejects the pass and retains its evidence', async () => {
  const t = createTestVela({
    responses: [fauxText('Noted')],
    generate: [result([update('another-groups-session')])],
  })
  new MemoryStore(t.dataPath('memory')).save(deploy)
  await t.run('Deploys moved to Monday')
  const inbox = await t.readData('memory/.dream/inbox.jsonl')
  await t.run('/dream')
  expect(await t.readData('memory/.dream/inbox.jsonl')).toBe(inbox)
  expect(await t.readData('memory/project_deploy-day.md')).toContain('Friday')
})

test('a failed isolated model call keeps inbox evidence for a later successful retry', async () => {
  const t = createTestVela({
    responses: [fauxText('Noted')],
    generate: [{ error: 'Dream unavailable' }, result([update('default')])],
  })
  new MemoryStore(t.dataPath('memory')).save(deploy)
  await t.run('Deploys moved to Monday')
  const inbox = await t.readData('memory/.dream/inbox.jsonl')
  await t.run('/dream')
  expect(await t.readData('memory/.dream/inbox.jsonl')).toBe(inbox)
  expect(notices(t)).toMatch(/fail|unavailable|error/i)
  await t.run('/dream')
  expect(await t.readData('memory/project_deploy-day.md')).toContain('Monday')
  expect(records(t.dataPath('memory/.dream/inbox.jsonl'))).toEqual([])
})

test('inbox captures tool names but never tool output, even before any record is dropped', async () => {
  const t = createTestVela({
    responses: [fauxToolCall('memory', { action: 'list' }), fauxText('Noted')],
  })
  new MemoryStore(t.dataPath('memory')).save({
    ...deploy,
    description: 'ONLY_TOOL_OUTPUT',
  })
  await t.run('List memories')
  const inbox = records(t.dataPath('memory/.dream/inbox.jsonl'))
  expect(inbox).toHaveLength(1)
  expect(inbox[0].tools).toEqual(['memory'])
  expect(inbox[0].user).toBe('List memories')
  expect(inbox[0].assistant).toBe('Noted')
  expect(JSON.stringify(inbox)).not.toContain('ONLY_TOOL_OUTPUT')
})

for (const inbox of ['empty', 'no matching conversations'] as const) {
  test(`manual dream cleans a legacy store over the note budget with ${inbox} inbox`, async () => {
    const content =
      `Legacy deployment checklist: ${'Keep the verified release checklist. '.repeat(60)}`.trim()
    let sentNotes: { filename: string; content: string }[] = []
    const t = createTestVela({
      responses: inbox === 'empty' ? [] : [fauxText('Zyxwvutsrq')],
      generate: [
        (req) => {
          expect(req.kind).toBe('generate')
          expect(req.tools).toEqual([])
          sentNotes = JSON.parse(req.lastUserText).notes
          return result(
            [
              {
                action: 'delete',
                filename: 'project_legacy-000.md',
                reason: 'Merge duplicate legacy deployment checklists',
                source: 'default',
              },
            ],
            'Removed a duplicate legacy checklist',
          )
        },
      ],
    })
    const store = new MemoryStore(t.dataPath('memory'))
    for (let i = 0; i < 40; i++) {
      store.save({
        name: `legacy-${String(i).padStart(3, '0')}`,
        description: 'Duplicate deployment checklist',
        type: 'project',
        content,
      })
    }
    expect(JSON.stringify(store.list()).length).toBeGreaterThan(60_000)
    if (inbox !== 'empty') await t.run('Qwertyuiopasdfghjkl')
    else expect(existsSync(t.dataPath('memory/.dream/inbox.jsonl'))).toBe(false)
    const before = JSON.stringify(t.session.messages)
    await t.run('/dream')
    expect(
      sentNotes.find((note) => note.filename === 'project_legacy-000.md')
        ?.content,
    ).toBe(content)
    expect(store.list()).toHaveLength(39)
    expect(existsSync(t.dataPath('memory/project_legacy-000.md'))).toBe(false)
    expect(await t.readData('memory/.dream/log.md')).toContain(
      'Removed a duplicate legacy checklist',
    )
    expect(JSON.stringify(t.session.messages)).toBe(before)
  })
}

for (const action of ['update', 'delete'] as const) {
  test(`dream skips ${action} when a direct edit changes the note without its timestamp`, async () => {
    const op =
      action === 'update'
        ? update('default')
        : {
            action,
            filename: 'project_deploy-day.md',
            reason: 'Remove the obsolete schedule',
            source: 'default',
          }
    const t = createTestVela({
      responses: [fauxText('Monday noted')],
      generate: [result([op])],
    })
    new MemoryStore(t.dataPath('memory')).save(deploy)
    await t.run('Deploys moved to Monday')
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const generate = t.model.doGenerate.bind(t.model)
    let started = false
    spyOn(t.model, 'doGenerate').mockImplementation(async (opts) => {
      started = true
      await gate
      return generate(opts)
    })
    const dreaming = t.run('/dream')
    const path = t.dataPath('memory/project_deploy-day.md')
    let edited = ''
    try {
      await until(() => started)
      const original = text(path)
      edited = original.replace(
        'Deploys happen on Friday',
        'Deploys happen on Tuesday',
      )
      expect(edited).not.toBe(original)
      expect(edited.match(/^lastWriteAt:.*$/m)?.[0]).toBe(
        original.match(/^lastWriteAt:.*$/m)?.[0],
      )
      writeFileSync(path, edited)
    } finally {
      release()
    }
    await dreaming
    expect(existsSync(path)).toBe(true)
    expect(text(path)).toBe(edited)
    expect(notices(t)).toMatch(/skip/i)
    expect(await t.readData('memory/.dream/log.md')).toMatch(/skip/i)
  })
}

test('dream provenance keeps the last five distinct source sessions in most-recent order', async () => {
  const t = createTestVela({
    sessionId: 'a',
    responses: [fauxText('Monday noted'), fauxText('Tuesday noted')],
    generate: [
      result([update('a')]),
      result([{ ...update('f'), content: 'Deploys happen on Tuesday' }]),
    ],
  })
  const store = new MemoryStore(t.dataPath('memory'))
  store.save({ ...deploy, sources: ['a', 'b', 'c', 'd', 'e'] })
  await t.run('Deploys moved to Monday')
  await t.run('/dream')
  const latest = t.vela.session('f')
  await latest.prompt('Deploys moved again to Tuesday')
  await latest.prompt('/dream')
  expect(store.list()[0]?.content).toBe('Deploys happen on Tuesday')
  expect(store.list()[0]?.sources).toEqual(['c', 'd', 'e', 'a', 'f'])
  const frontmatter = await t.readData('memory/project_deploy-day.md')
  expect(JSON.parse(frontmatter.match(/^sources: (.+)$/m)![1]!)).toEqual([
    'c',
    'd',
    'e',
    'a',
    'f',
  ])
})
