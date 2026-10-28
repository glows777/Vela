import { afterEach, expect, test } from 'bun:test'
import type { VelaEvent } from '@glows777/vela-core'
import { fauxHang, fauxText, fauxToolCall } from '@glows777/vela-core/testing'
import { z } from 'zod'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

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

  expect(await t.readData('sessions/b.jsonl')).toContain('answer for b')
  expect(await t.readData('sessions/a.jsonl')).not.toContain('answer for b')
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
  expect(await t.readData('sessions/closing.jsonl')).toContain('keep thinking')
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
