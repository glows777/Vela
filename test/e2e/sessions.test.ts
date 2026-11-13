import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  memorySessionStorage,
  type SessionStorage,
  type VelaEvent,
} from '@glows777/vela-core'
import {
  createFauxModel,
  fauxHang,
  fauxText,
  fauxToolCall,
} from '@glows777/vela-core/testing'
import { z } from 'zod'
import { createVela } from '../../packages/vela/src/index.ts'
import { cleanupTestVelas, createTestVela, tempDir } from '../support/vela.ts'

afterEach(cleanupTestVelas)

const waitFor = async (check: () => boolean) => {
  while (!check()) await Bun.sleep(1)
}

test('two sessions run at the same time with separate history, files, locks and usage', async () => {
  const t = createTestVela({
    responses: [fauxHang('a is thinking'), fauxText('answer for b')],
    allowPendingResponses: true,
  })
  const a = t.vela.session('a')
  const b = t.vela.session('b')

  const running = a.prompt('ask a')
  await waitFor(() => t.model.calls.length === 1)
  expect(a.busy.locked).toBe(true)
  expect(b.busy.locked).toBe(false)

  await b.prompt('ask b')
  expect(b.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  expect(t.model.calls[1]!.lastUserText).toBe('ask b')
  expect(JSON.stringify(t.model.calls[1]!.prompt)).not.toContain('ask a')

  a.abort()
  await expect(running).rejects.toThrow()
  expect(a.busy.locked).toBe(false)
  // The partial answer streamed before the abort stays in a's session, not in its context (like pi)
  expect(a.messages.map((m) => m.role)).toEqual(['user'])
  expect(a.getEntries().at(-1)).toMatchObject({ stopReason: 'aborted' })

  expect(await t.readData('sessions/b/transcript.jsonl')).toContain(
    'answer for b',
  )
  expect(await t.readData('sessions/a/transcript.jsonl')).not.toContain(
    'answer for b',
  )
  expect(b.usage.totals.steps).toBe(1)
  expect(a.usage.totals.steps).toBe(0)
  expect(t.session.messages).toEqual([])
})

test('vela.session(id) returns the open session and rejects ids that are not safe file names', () => {
  const t = createTestVela()
  expect(t.vela.session('default')).toBe(t.session)
  expect(t.vela.session()).toBe(t.session)
  expect(t.vela.session('x')).toBe(t.vela.session('x'))
  expect(t.vela.sessions().map((s) => s.id)).toEqual(['default', 'x'])
  for (const bad of ['../evil', 'a/b', '.hidden', '', 'lark:ou_1'])
    expect(() => t.vela.session(bad)).toThrow('Invalid session id')
})

test('session.subscribe only sees its own events; vela.subscribe sees all with the session id', async () => {
  const t = createTestVela({
    responses: [fauxText('one'), fauxText('two'), fauxText('three')],
  })
  const other = t.vela.session('other')
  const mine: VelaEvent['type'][] = []
  const all: string[] = []
  const off = t.session.subscribe((event) => mine.push(event.type))
  const offAll = t.vela.subscribe((event, id) => {
    if (event.type === 'agent_end') all.push(id)
  })

  await t.run('1')
  await other.prompt('2')
  off()
  await t.run('3')
  offAll()

  expect(mine.filter((type) => type === 'agent_end')).toHaveLength(1)
  expect(all).toEqual(['default', 'other', 'default'])
  expect(t.eventsIn('other').at(-2)).toMatchObject({
    type: 'agent_end',
    reason: 'done',
  })
})

test('a resumed session declares the deferred tools it loaded before', async () => {
  const lookup = {
    name: 'deferred_lookup',
    description: 'look something up',
    inputSchema: z.object({ id: z.string() }),
    exposure: 'deferred' as const,
    execute: async ({ id }: { id: string }) => `record ${id}`,
  }
  const first = createTestVela({
    responses: [
      fauxToolCall('tool_search', { query: 'deferred_lookup' }),
      fauxText('Loaded it'),
    ],
  })
  first.internals.registry.register(lookup)
  await first.run('Load the lookup tool')

  // A new process on the same data directory: rules load again, the session resumes
  const second = createTestVela({
    cwd: first.cwd,
    responses: [
      (req) => {
        expect(req.tools).toContain('deferred_lookup')
        return fauxText('Still there')
      },
    ],
  })
  second.internals.registry.register(lookup)
  expect(await second.session.resume()).toBe(true)

  await second.run('Use the lookup tool')

  expect(second.lastAssistantText()).toBe('Still there')
})

test('a resumed session declares deferred tools whose tool_search result was offloaded', async () => {
  // The loaded-tool list crosses the 51,200-character cap before its last name.
  const lookups = Array.from({ length: 8 }, (_, index) => ({
    name: `deferred_lookup_${index}`,
    description: `[MCP:fake] look something up ${'x'.repeat(8000)}`,
    inputSchema: z.object({ id: z.string() }),
    exposure: 'deferred' as const,
    execute: async ({ id }: { id: string }) => `record ${id}`,
  }))
  const names = lookups.map((tool) => tool.name)
  const first = createTestVela({
    responses: [
      fauxToolCall('tool_search', { query: names.join(','), limit: 8 }),
      fauxText('Loaded them'),
    ],
  })
  for (const tool of lookups) first.internals.registry.register(tool)
  await first.run('Load the lookup tools')
  expect(first.model.calls[1]!.tools).toEqual(expect.arrayContaining(names))
  const preview = first.model.calls[1]!.toolResults[0]!
  expect(preview.raw).toMatchObject({ type: 'text' })
  expect(preview.output).toContain('Full output: ')
  expect(preview.output).not.toContain(`- ${names.at(-1)}:`)

  const second = createTestVela({
    cwd: first.cwd,
    responses: [
      (req) => {
        expect(req.tools).toEqual(expect.arrayContaining(names))
        return fauxToolCall(names.at(-1)!, { id: 'resumed' })
      },
      fauxText('Still there'),
    ],
  })
  for (const tool of lookups) second.internals.registry.register(tool)
  expect(await second.session.resume()).toBe(true)

  await second.run('Use the lookup tools')

  expect(second.lastAssistantText()).toBe('Still there')

  // A new faux provider restarts its call IDs; a later lookup can share the search's SDK ID.
  const third = createTestVela({
    cwd: first.cwd,
    responses: [
      (req) => {
        expect(req.tools).toEqual(expect.arrayContaining(names))
        return fauxText('Still loaded after another restart')
      },
    ],
  })
  for (const tool of lookups) third.internals.registry.register(tool)
  expect(await third.session.resume()).toBe(true)
  await third.run('Keep using the loaded tools')
})

test('tools discovered with tool_search are only active in the session that searched', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('tool_search', { query: 'deferred_echo' }),
      fauxText('Found it'),
      fauxText('Another session'),
    ],
  })
  t.internals.registry.register({
    name: 'deferred_echo',
    description: 'echo',
    inputSchema: z.object({ text: z.string() }),
    exposure: 'deferred',
    execute: async ({ text }: { text: string }) => text,
  })

  await t.run('Find deferred_echo')
  expect(t.model.calls[1]!.tools).toContain('deferred_echo')

  await t.vela.session('other').prompt('What tools do you have')
  expect(t.model.calls[2]!.tools).not.toContain('deferred_echo')
  expect(t.model.calls[2]!.system).toContain('deferred_echo')
})

test('close() stops a running prompt, saves it and removes the session', async () => {
  const t = createTestVela({
    responses: [fauxHang()],
  })
  const s = t.vela.session('closing')
  const running = s.prompt('keep thinking')
  await waitFor(() => t.model.calls.length === 1)

  await s.close()
  await expect(running).rejects.toThrow()
  expect(t.vela.sessions().map((x) => x.id)).toEqual(['default'])
  expect(await t.readData('sessions/closing/transcript.jsonl')).toContain(
    'keep thinking',
  )
  await expect(s.prompt('again')).rejects.toThrow('is closed')
  // Reopening the same id gives a new session that can resume from disk
  const reopened = t.vela.session('closing')
  expect(reopened).not.toBe(s)
  expect(await reopened.resume()).toBe(true)
})

test('vela.dispose() aborts running sessions and refuses new ones', async () => {
  const t = createTestVela({ responses: [fauxHang()] })
  const running = t.run('keep thinking')
  await waitFor(() => t.model.calls.length === 1)

  await t.vela.dispose()
  await expect(running).rejects.toThrow()
  expect(t.session.busy.locked).toBe(false)
  expect(() => t.vela.session('late')).toThrow('dispose')
})

test('resume() refuses to replace the history of a running session', async () => {
  const t = createTestVela({ responses: [fauxHang()] })
  const running = t.session.prompt('keep thinking')
  while (t.model.calls.length === 0) await Bun.sleep(1)
  await expect(t.session.resume()).rejects.toThrow()
  t.session.abort()
  await running.catch(() => {})
  expect(t.session.messages[0]).toMatchObject({
    role: 'user',
    content: 'keep thinking',
  })
})

test('tool calls from sessions running at the same time are recorded in their own session', async () => {
  const big = (tag: string) => `${tag}\n${'x'.repeat(5000)}`
  // Two sessions run concurrently in no fixed order: the user message in each request picks the file to read
  const readOwn = (req: { lastUserText: string }) =>
    fauxToolCall('read_file', { path: `${req.lastUserText}.txt` })
  const t = createTestVela({
    files: { 'a.txt': big('AAA'), 'b.txt': big('BBB') },
    responses: [
      readOwn,
      readOwn,
      fauxText('Done reading'),
      fauxText('Done reading'),
    ],
  })
  const a = t.vela.session('a')
  const b = t.vela.session('b')

  await Promise.all([a.prompt('a'), b.prompt('b')])

  const recorded = async (id: string) => {
    let text = ''
    for await (const file of new Bun.Glob(`sessions/${id}/**/*`).scan({
      cwd: t.vela.dataDir,
    }))
      text += await t.readData(file)
    return text
  }
  const inA = await recorded('a')
  const inB = await recorded('b')
  expect(inA).toContain('AAA')
  expect(inA).not.toContain('BBB')
  expect(inB).toContain('BBB')
  expect(inB).not.toContain('AAA')
})

test('saved sessions are listed newest first with name, size and first message', async () => {
  const t = createTestVela({ responses: [fauxText('one'), fauxText('two')] })
  await t.vela.session('older').prompt('Question from the first session')
  const newer = t.vela.session('newer')
  newer.setName('Refactor discussion')
  await newer.prompt('Question from the second session')

  const list = await t.vela.listSessions()

  expect(list.map((s) => s.id)).toEqual(['newer', 'older'])
  expect(list[0]).toMatchObject({
    id: 'newer',
    name: 'Refactor discussion',
    messageCount: 2,
    firstMessage: 'Question from the second session',
  })

  // The name is saved with the session and restored on resume
  const resumed = createTestVela({ cwd: t.cwd })
  const again = resumed.vela.session('newer')
  expect(await again.resume()).toBe(true)
  expect(again.name).toBe('Refactor discussion')
})

test('a session in the 0.5.0 flat layout lists, resumes and is converted on open', async () => {
  const first = createTestVela({
    responses: [
      fauxToolCall('bash', { command: 'echo legacy' }),
      fauxText('saved'),
    ],
  })
  await first.run('Run the legacy command')
  const history = readFileSync(first.session.registry.results.indexPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  // A pre-change session stored the whole reference instead of a preview plus a full-output path
  const legacy = {
    kind: 'vela-tool-result',
    path: history[1].outputPath,
    indexPath: first.session.registry.results.indexPath,
    bytes: 7,
    preview: 'legacy\n',
    read: 'Only a preview is shown. Use read_file to read more.',
  }
  await first.cleanup({ keepDir: true })

  // Rewrite the tool result and put the session back in the 0.5.0 flat layout
  const flat = first.dataPath('sessions/default.jsonl')
  const transcript = first.dataPath('sessions/default/transcript.jsonl')
  const entries = readFileSync(
    existsSync(transcript) ? transcript : flat,
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  entries.find(
    (entry) => entry.type === 'message' && entry.message.role === 'tool',
  ).message.content[0].output = { type: 'json', value: legacy }
  writeFileSync(
    flat,
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  )
  rmSync(transcript, { force: true })

  const second = createTestVela({
    cwd: first.cwd,
    responses: [
      (req) => {
        const output = req.prompt
          .flatMap((message) =>
            message.role === 'tool' ? message.content : [],
          )
          .find((part) => part.type === 'tool-result')!.output
        expect(output).toEqual({ type: 'text', value: 'legacy\n' })
        return fauxText('continued')
      },
    ],
  })
  expect((await second.vela.listSessions()).map((s) => s.id)).toContain(
    'default',
  )
  expect(await second.session.resume()).toBe(true)
  expect(readFileSync(legacy.path, 'utf8')).toBe('legacy\n')
  await second.run('Continue the legacy session')
  expect(second.lastAssistantText()).toBe('continued')

  const converted = readFileSync(transcript, 'utf8')
  expect(converted).toContain('Run the legacy command')
  expect(converted).toContain('Continue the legacy session')
  expect(existsSync(flat)).toBe(false)
  await second.cleanup({ keepDir: true })

  // Resuming again reads the converted file and leaves it alone
  const third = createTestVela({
    cwd: first.cwd,
    responses: [fauxText('again')],
  })
  expect(await third.session.resume()).toBe(true)
  expect(readFileSync(transcript, 'utf8')).toBe(converted)
  await third.run('Ask once more')
  expect(third.lastAssistantText()).toBe('again')
  expect(readFileSync(transcript, 'utf8')).toContain('Ask once more')
})

test('session summaries carry the working directory and channel', async () => {
  const t = createTestVela({
    responses: [fauxText('one'), fauxText('two'), fauxText('three')],
  })
  mkdirSync(join(t.cwd, 'first'))
  mkdirSync(join(t.cwd, 'second'))
  await t.vela
    .session('first-folder', { cwd: 'first' })
    .prompt('from the first folder')
  await t.vela
    .session('second-folder', { cwd: 'second' })
    .prompt('from the second folder')
  await t.vela
    .session('channel-chat', { channel: 'fake' })
    .prompt('from a chat')

  const list = await t.vela.listSessions()
  const byId = (id: string) => list.find((summary) => summary.id === id)
  expect(byId('first-folder')).toMatchObject({ cwd: join(t.cwd, 'first') })
  expect(byId('second-folder')).toMatchObject({ cwd: join(t.cwd, 'second') })
  // A session a host opened for a channel records it; cwd stays the host's when none was given
  expect(byId('channel-chat')).toMatchObject({
    channel: 'fake',
    cwd: t.cwd,
  })
  expect(byId('first-folder')!.channel).toBeUndefined()
})

test('archived sessions leave the list, survive a restart and keep their history', async () => {
  const t = createTestVela({ responses: [fauxText('one'), fauxText('two')] })
  await t.vela.session('keep').prompt('keep this one')
  await t.vela.session('archived').prompt('hide this one')

  await t.vela.setSessionArchived('archived', true)

  expect((await t.vela.listSessions()).map((s) => s.id)).toEqual(['keep'])
  const withArchived = await t.vela.listSessions({ includeArchived: true })
  expect(withArchived.map((s) => s.id)).toEqual(['archived', 'keep'])
  expect(withArchived[0]).toMatchObject({ archived: true, messageCount: 2 })

  // A new Vela on the same data directory still sees the flag; the messages are all there
  const restarted = createTestVela({ cwd: t.cwd })
  expect((await restarted.vela.listSessions()).map((s) => s.id)).toEqual([
    'keep',
  ])
  const resumed = restarted.vela.session('archived')
  expect(await resumed.resume()).toBe(true)
  expect(resumed.messages.map((m) => m.role)).toEqual(['user', 'assistant'])

  // Unarchiving brings it back, also from a host that never opened the session
  const third = createTestVela({ cwd: t.cwd })
  await third.vela.setSessionArchived('archived', false)
  expect((await third.vela.listSessions()).map((s) => s.id)).toEqual([
    'archived',
    'keep',
  ])
})

test('searching saved sessions returns an id and a short user or assistant match', async () => {
  const t = createTestVela({
    responses: [
      fauxText(
        'The release script lives in scripts/release.ts; run it after the tests pass.',
      ),
      fauxToolCall('bash', { command: 'echo tool-output-marker' }),
      fauxText('done'),
    ],
  })
  await t.vela.session('release').prompt('Investigate the flaky release script')
  await t.vela.session('tools').prompt('Print the marker')

  const hits = await t.vela.searchSessions('release')
  expect(hits.map((hit) => hit.id)).toEqual(['release'])
  expect(hits[0]!.match.toLowerCase()).toContain('release')
  expect(hits[0]!.match.length).toBeLessThanOrEqual(120)
  expect((await t.vela.searchSessions('RELEASE')).map((h) => h.id)).toEqual([
    'release',
  ])

  // User and assistant text both match; a phrase only the assistant wrote finds the session
  expect((await t.vela.searchSessions('investigate')).map((h) => h.id)).toEqual(
    ['release'],
  )
  expect(
    (await t.vela.searchSessions('scripts/release.ts')).map((h) => h.id),
  ).toEqual(['release'])
  // Tool output and tool calls are not session text
  expect(await t.vela.searchSessions('tool-output-marker')).toEqual([])

  // Archived sessions stay out unless asked for, like listSessions
  await t.vela.setSessionArchived('release', true)
  expect(await t.vela.searchSessions('release')).toEqual([])
  expect(
    (await t.vela.searchSessions('release', { includeArchived: true })).map(
      (hit) => hit.id,
    ),
  ).toEqual(['release'])
})

test('archiving retries a write that failed before it resolves', async () => {
  const memory = memorySessionStorage()
  let failing = false
  const storage: SessionStorage = {
    ...memory,
    append: async (id, entries) => {
      if (failing) throw new Error('disk full')
      await memory.append(id, entries)
    },
  }
  const t = createTestVela({
    responses: [fauxText('one')],
    sessionStorage: storage,
  })
  await t.vela.session('s').prompt('one')

  failing = true
  await expect(t.vela.setSessionArchived('s', true)).rejects.toThrow(
    'disk full',
  )
  failing = false
  // The retry flushes the entry the failed write left behind instead of resolving early
  await t.vela.setSessionArchived('s', true)
  expect(
    (await t.vela.listSessions({ includeArchived: true })).find(
      (summary) => summary.id === 's',
    )?.archived,
  ).toBe(true)
})

test('a first channel binding after the session was written reaches the summary', async () => {
  const t = createTestVela({ responses: [fauxText('one')] })
  const late = t.vela.session('late')
  await late.prompt('local history before the binding')

  // The public routing API accepts a first binding on an already-open, already-saved session
  t.vela.session('late', { channel: 'fake' })
  expect(late.channel).toBe('fake')
  await late.close()

  const listed = async (vela: typeof t.vela) =>
    (await vela.listSessions()).find((summary) => summary.id === 'late')
      ?.channel
  expect(await listed(t.vela)).toBe('fake')
  // The header is never rewritten, so a restart reads the appended entry
  const restarted = createTestVela({ cwd: t.cwd })
  expect(await listed(restarted.vela)).toBe('fake')
})

test('archiving a session that is not open still reports the save to the host', async () => {
  const dir = tempDir()
  const saves: string[] = []
  const open = () =>
    createVela({
      cwd: dir.path,
      dataDir: '.data',
      model: createFauxModel({ responses: [fauxText('one')] }),
      onSessionSaved: (id) => saves.push(id),
    })
  const first = open()
  try {
    await first.session('archived').prompt('one')
  } finally {
    await first.dispose()
  }

  // Nothing is open in the new Vela: the entry goes straight to storage, and the host still hears about it
  const restarted = open()
  try {
    saves.length = 0
    await restarted.setSessionArchived('archived', true)
    expect(saves).toEqual(['archived'])
    // A repeated call writes nothing, so the observer stays quiet
    await restarted.setSessionArchived('archived', true)
    expect(saves).toEqual(['archived'])
  } finally {
    await restarted.dispose()
    dir.cleanup()
  }
})

const channelRecords = (text: string) =>
  text
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const entry = JSON.parse(line) as { type?: string; channel?: string }
      if (entry.type !== 'session' && entry.type !== 'session_channel')
        return []
      return [`${entry.type}:${entry.channel ?? ''}`]
    })

const expectRoutingConflict = (run: () => void) => {
  let error: unknown
  try {
    run()
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).name).toBe('SessionRoutingConflictError')
}

test('a header channel rejects a different bind after resume', async () => {
  const first = createTestVela({ responses: [fauxText('one')] })
  await first.vela
    .session('chat', { channel: 'lark' })
    .prompt('opened for lark')

  const second = createTestVela({
    cwd: first.cwd,
    responses: [fauxText('two')],
  })
  const session = second.vela.session('chat')
  expect(await session.resume()).toBe(true)
  expect(session.channel).toBe('lark')
  expectRoutingConflict(() =>
    second.vela.session('chat', { channel: 'telegram' }),
  )
  expect(session.channel).toBe('lark')
  await session.prompt('new turn')
  expect(
    (await second.vela.listSessions()).find((row) => row.id === 'chat')
      ?.channel,
  ).toBe('lark')
  expect(
    channelRecords(await second.readData('sessions/chat/transcript.jsonl')),
  ).toEqual(['session:lark'])
})

test('a late channel binding rejects a different bind after resume', async () => {
  const first = createTestVela({ responses: [fauxText('one')] })
  const late = first.vela.session('late')
  await late.prompt('local history before the binding')
  first.vela.session('late', { channel: 'lark' })
  await late.close()

  const second = createTestVela({
    cwd: first.cwd,
    responses: [fauxText('two')],
  })
  const session = second.vela.session('late')
  expect(await session.resume()).toBe(true)
  expect(session.channel).toBe('lark')
  expectRoutingConflict(() =>
    second.vela.session('late', { channel: 'telegram' }),
  )
  expect(session.channel).toBe('lark')
  await session.prompt('new turn')
  expect(
    (await second.vela.listSessions()).find((row) => row.id === 'late')
      ?.channel,
  ).toBe('lark')
  expect(
    channelRecords(await second.readData('sessions/late/transcript.jsonl')),
  ).toEqual(['session:', 'session_channel:lark'])
})

test('resuming and supplying the saved channel again does not append another entry', async () => {
  const first = createTestVela({
    responses: [fauxText('header'), fauxText('late')],
  })
  await first.vela
    .session('header', { channel: 'lark' })
    .prompt('opened for lark')
  const late = first.vela.session('late')
  await late.prompt('local history before the binding')
  first.vela.session('late', { channel: 'lark' })
  await late.close()

  const second = createTestVela({
    cwd: first.cwd,
    responses: [fauxText('again'), fauxText('again late')],
  })
  const header = second.vela.session('header')
  expect(await header.resume()).toBe(true)
  expect(second.vela.session('header', { channel: 'lark' })).toBe(header)
  expect(header.channel).toBe('lark')
  await header.prompt('same channel')
  expect(
    channelRecords(await second.readData('sessions/header/transcript.jsonl')),
  ).toEqual(['session:lark'])

  const rebound = second.vela.session('late')
  expect(await rebound.resume()).toBe(true)
  expect(second.vela.session('late', { channel: 'lark' })).toBe(rebound)
  expect(rebound.channel).toBe('lark')
  await rebound.prompt('same late channel')
  expect(
    channelRecords(await second.readData('sessions/late/transcript.jsonl')),
  ).toEqual(['session:', 'session_channel:lark'])
})

test('opening with a different channel and then resuming is a routing conflict', async () => {
  const first = createTestVela({
    responses: [fauxText('one'), fauxText('late')],
  })
  await first.vela
    .session('chat', { channel: 'lark' })
    .prompt('opened for lark')
  const late = first.vela.session('late')
  await late.prompt('opened unbound')
  first.vela.session('late', { channel: 'lark' })
  await late.close()

  const second = createTestVela({ cwd: first.cwd, responses: [] })
  const session = second.vela.session('chat', { channel: 'telegram' })
  let error: unknown
  try {
    await session.resume()
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).name).toBe('SessionRoutingConflictError')
  expect(session.channel).toBe('lark')
  expect(session.messages.map((message) => message.role)).toEqual([
    'user',
    'assistant',
  ])
  expect(
    (await second.vela.listSessions()).find((row) => row.id === 'chat')
      ?.channel,
  ).toBe('lark')
  expect(
    channelRecords(await second.readData('sessions/chat/transcript.jsonl')),
  ).toEqual(['session:lark'])

  const rebound = second.vela.session('late', { channel: 'telegram' })
  let lateError: unknown
  try {
    await rebound.resume()
  } catch (caught) {
    lateError = caught
  }
  expect((lateError as Error).name).toBe('SessionRoutingConflictError')
  expect(rebound.channel).toBe('lark')
  expect(
    channelRecords(await second.readData('sessions/late/transcript.jsonl')),
  ).toEqual(['session:', 'session_channel:lark'])
})
