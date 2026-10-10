import { afterEach, expect, test } from 'bun:test'
import type { VelaExtension } from '../../src/extensions/types.ts'
import type {
  SessionEntry,
  SessionMessageEntry,
  SessionTreeNode,
} from '../../src/session/entries.ts'
import {
  fauxError,
  fauxSummary,
  fauxText,
  fauxToolCall,
} from '../../src/testing/faux.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

/** The message entry whose content is `text`. */
const entryOf = (entries: SessionEntry[], text: string) => {
  const found = entries.find(
    (entry): entry is SessionMessageEntry =>
      entry.type === 'message' &&
      JSON.stringify(entry.message.content).includes(text),
  )
  if (!found) throw new Error(`no entry with ${text}`)
  return found
}

/** The tree node of an entry. */
const nodeOf = (
  roots: SessionTreeNode[],
  id: string,
): SessionTreeNode | undefined => {
  const stack = [...roots]
  while (stack.length) {
    const node = stack.pop()!
    if (node.entry.id === id) return node
    stack.push(...node.children)
  }
}

const texts = (messages: { content: unknown }[]) =>
  messages.map((m) =>
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  )

const lastStream = (t: ReturnType<typeof createTestVela>) =>
  JSON.stringify(
    t.model.calls.filter((c) => c.kind === 'stream').at(-1)!.prompt,
  )

/** Two rounds: q1 → a1, q2 → a2. */
async function twoRounds(
  extra: Parameters<typeof createTestVela>[0] = {},
): Promise<ReturnType<typeof createTestVela>> {
  const t = createTestVela({
    ...extra,
    responses: [fauxText('a1'), fauxText('a2'), ...(extra.responses ?? [])],
  })
  await t.run('q1')
  await t.run('q2')
  return t
}

test('moving to a user message puts its text back; sending it again starts a new branch the model sees alone (like pi)', async () => {
  const t = await twoRounds({ responses: [fauxText('a2b')] })
  const q2 = entryOf(t.session.getEntries(), 'q2')

  const result = await t.session.navigateTree(q2.id)

  expect(result).toEqual({ editorText: 'q2', cancelled: false })
  expect(t.session.getLeafId()).toBe(q2.parentId)
  expect(texts(t.session.messages)).toEqual([
    'q1',
    '[{"type":"text","text":"a1"}]',
  ])

  await t.run('q2b')
  expect(lastStream(t)).toContain('q2b')
  expect(lastStream(t)).not.toContain('"q2"')
  expect(lastStream(t)).not.toContain('a2"')
  // Both branches stay in the file; q2 and q2b share a parent
  const entries = t.session.getEntries()
  expect(entryOf(entries, 'q2b').parentId).toBe(q2.parentId)
  const file = await t.readData('sessions/default.jsonl')
  expect(file).toContain('"q2"')
  expect(file).toContain('q2b')
  // The tree has one root and branches below a1
  const tree = t.session.getTree()
  expect(tree).toHaveLength(1)
  let node: SessionTreeNode = tree[0]!
  while (node.children.length === 1) node = node.children[0]!
  expect(node.entry.id).toBe(q2.parentId as string)
  expect(node.children).toHaveLength(2)
})

test('moving to an assistant message continues after it, and resume() comes back to the branch written last', async () => {
  const t = await twoRounds({ responses: [fauxText('a3')] })
  const a1 = entryOf(t.session.getEntries(), 'a1')

  const result = await t.session.navigateTree(a1.id)
  expect(result).toEqual({ cancelled: false })
  expect(t.session.getLeafId()).toBe(a1.id)
  await t.run('q3')
  expect(lastStream(t)).not.toContain('q2')

  await t.session.close()
  const reopened = t.vela.session('default')
  expect(await reopened.resume()).toBe(true)
  expect(texts(reopened.messages)).toEqual([
    'q1',
    '[{"type":"text","text":"a1"}]',
    'q3',
    '[{"type":"text","text":"a3"}]',
  ])
  // The other branch is still in the session
  expect(JSON.stringify(reopened.getEntries())).toContain('"q2"')
})

test('summarizing the branch left attaches a branch_summary the next request sees', async () => {
  const t = await twoRounds({
    responses: [fauxText('a2b')],
    generate: [fauxSummary()],
  })
  const q2 = entryOf(t.session.getEntries(), 'q2')

  await t.session.navigateTree(q2.id, { summarize: true, focus: 'keep q2' })

  const summary = t.session
    .getEntries()
    .find((e) => e.type === 'branch_summary')
  expect(summary).toMatchObject({ parentId: q2.parentId })
  expect(t.session.getLeafId()).toBe(summary!.id)
  // Like pi, the summary covers the old branch below the target: a2 (q2 itself goes back to the editor)
  const generate = t.model.calls.find((c) => c.kind === 'generate')!
  expect(generate.lastUserText).toContain('"sourceMessageCount":1')
  expect(generate.lastUserText).toContain('"anchor":"a2"')
  expect(generate.lastUserText).toContain('keep q2')
  await t.run('q2b')
  expect(lastStream(t)).toContain('Summary of the conversation branch you left')
})

test('labels can be set on entries, shown in the tree and cleared', async () => {
  const t = await twoRounds()
  const q1 = entryOf(t.session.getEntries(), 'q1')

  t.session.setLabel(q1.id, 'start')
  expect(nodeOf(t.session.getTree(), q1.id)).toMatchObject({ label: 'start' })
  t.session.setLabel(q1.id, '')
  expect(nodeOf(t.session.getTree(), q1.id)!.label).toBeUndefined()
  expect(() => t.session.setLabel('nope', 'x')).toThrow('not in the session')
  // Labels are not sent to the model
  expect(t.session.messages).toHaveLength(4)
})

test('a compaction on one branch does not apply on a branch that leaves before it', async () => {
  const t = createTestVela({
    responses: [
      ...Array.from({ length: 4 }, (_, i) => fauxText(`Answer ${i}`)),
      fauxText('other'),
    ],
    generate: [fauxSummary()],
  })
  for (let i = 0; i < 4; i++) await t.run(`Question ${i}`)
  await t.session.compact()
  expect(t.session.contextManager.state.summary).not.toBe('')

  const answer0 = entryOf(t.session.getEntries(), 'Answer 0')
  await t.session.navigateTree(answer0.id)

  expect(t.session.contextManager.state.summary).toBe('')
  expect(texts(t.session.messages)).toEqual([
    'Question 0',
    '[{"type":"text","text":"Answer 0"}]',
  ])
  await t.run('Question 1b')
  expect(lastStream(t)).not.toContain('Summary of the earlier conversation')
})

test('fork copies the branch before a user message into a new open session; the original stays as it was', async () => {
  const t = createTestVela({
    files: { 'a.txt': 'hello' },
    responses: [
      fauxToolCall('read_file', { path: 'a.txt' }),
      fauxText('a1'),
      fauxText('a2'),
      fauxText('forked answer'),
    ],
  })
  await t.run('q1')
  await t.run('q2')
  const q2 = entryOf(t.session.getEntries(), 'q2')

  const result = await t.session.fork(q2.id, { sessionId: 'forked' })

  expect(result.cancelled).toBe(false)
  expect(result.selectedText).toBe('q2')
  const forked = result.session!
  expect(forked.id).toBe('forked')
  expect(forked.parentSession).toBe('default')
  expect(t.vela.session('forked')).toBe(forked)
  expect(forked.messages.map((m) => m.role)).toEqual([
    'user',
    'assistant',
    'tool',
    'assistant',
  ])
  const header = JSON.parse(
    (await t.readData('sessions/forked.jsonl')).split('\n')[0]!,
  )
  expect(header).toMatchObject({
    type: 'session',
    id: 'forked',
    parentSession: 'default',
  })
  // The tool call history came along, under the fork's own history id
  expect(header.toolHistoryId).not.toBe(
    JSON.parse((await t.readData('sessions/default.jsonl')).split('\n')[0]!)
      .toolHistoryId,
  )
  expect(await Bun.file(forked.store.results.history.path).text()).toContain(
    'a.txt',
  )
  // The original is untouched and both keep working
  expect(t.session.messages).toHaveLength(6)
  await forked.prompt('q2 again')
  expect(lastStream(t)).not.toContain('"q2"')
  expect(t.session.messages).toHaveLength(6)
})

test('forking from the first message starts an empty session that records its parent', async () => {
  const t = await twoRounds({ responses: [fauxText('fresh')] })
  const q1 = entryOf(t.session.getEntries(), 'q1')

  const { session, selectedText } = await t.session.fork(q1.id, {
    sessionId: 'fresh',
  })
  expect(selectedText).toBe('q1')
  expect(session!.messages).toEqual([])
  await session!.prompt('new start')
  const header = JSON.parse(
    (await t.readData('sessions/fresh.jsonl')).split('\n')[0]!,
  )
  expect(header.parentSession).toBe('default')
})

test('clone copies the current branch; fork rejects ids in use and non-user entries for `before`', async () => {
  const t = await twoRounds()
  const a1 = entryOf(t.session.getEntries(), 'a1')
  await t.session.navigateTree(a1.id)

  const { session } = await t.session.clone({ sessionId: 'copy' })
  expect(texts(session!.messages)).toEqual(texts(t.session.messages))
  expect(JSON.stringify(session!.getEntries())).not.toContain('"q2"')

  await expect(t.session.fork(a1.id)).rejects.toThrow('not a user message')
  await expect(t.session.clone({ sessionId: 'copy' })).rejects.toThrow(
    'already open',
  )
  await session!.close()
  await expect(t.session.clone({ sessionId: 'copy' })).rejects.toThrow(
    'already has saved history',
  )
})

test('export writes the current branch as JSONL and as HTML with session content escaped', async () => {
  const t = createTestVela({
    responses: [fauxText('<script>alert(1)</script>'), fauxText('a2')],
  })
  await t.run('q1')
  await t.run('q2')
  const q2 = entryOf(t.session.getEntries(), 'q2')
  await t.session.navigateTree(q2.id)

  const jsonl = await t.session.exportJsonl('out/branch.jsonl')
  const lines = (await Bun.file(jsonl).text())
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  expect(lines[0]).toMatchObject({ type: 'session', id: 'default' })
  expect(JSON.stringify(lines)).not.toContain('"q2"')
  expect(lines[1].parentId).toBeNull()

  const html = await Bun.file(
    await t.session.exportHtml('out/branch.html'),
  ).text()
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(html).not.toContain('<script>')
  expect(html).toContain('q1')
})

test('with automatic compaction off nothing compacts on its own and an overflow is reported as is; /compact still works', async () => {
  const overflow = '400 prompt is too long: 213462 tokens > 200000 maximum'
  const t = createTestVela({
    limits: { microcompactThreshold: 1, summaryThreshold: 1 },
    responses: [
      ...Array.from({ length: 4 }, (_, i) => fauxText(`Answer ${i}`)),
      fauxError(overflow),
    ],
    generate: [fauxSummary()],
  })
  t.session.autoCompaction = false
  for (let i = 0; i < 4; i++) await t.run(`Question ${i}`)
  expect(t.eventsOf('compaction_start')).toEqual([])
  expect(t.eventsOf('context')).toEqual([])

  await expect(t.run('Question 4')).rejects.toThrow('prompt is too long')
  expect(t.eventsOf('compaction_start')).toEqual([])

  await t.session.compact()
  expect(t.eventsOf('compaction_end')).toEqual([
    expect.objectContaining({ reason: 'manual', aborted: false }),
  ])
})

test('autoCompaction comes from createVela and session options', () => {
  const t = createTestVela()
  expect(t.session.autoCompaction).toBe(true)
  expect(t.vela.session('off', { autoCompaction: false }).autoCompaction).toBe(
    false,
  )
})

test('extensions can cancel tree moves and forks, supply the branch summary, and hear session_tree', async () => {
  const seen: unknown[] = []
  let cancelTree = true
  const watcher: VelaExtension = (vela) => {
    vela.on('session_before_tree', (event) => {
      seen.push(event.preparation)
      if (cancelTree) return { cancel: true }
      return { summary: { summary: 'from the extension' }, label: 'tried' }
    })
    vela.on('session_tree', (event) => {
      seen.push(event)
    })
    vela.on('session_before_fork', () => ({ cancel: true }))
  }
  const t = await twoRounds({ extensions: [watcher] })
  const q2 = entryOf(t.session.getEntries(), 'q2')
  const leaf = t.session.getLeafId()

  expect(await t.session.navigateTree(q2.id, { summarize: true })).toEqual({
    cancelled: true,
  })
  expect(t.session.getLeafId()).toBe(leaf)
  expect(seen[0]).toMatchObject({
    targetId: q2.id,
    oldLeafId: leaf,
    // Like pi: the deepest entry on both the old branch and the target's
    commonAncestorId: q2.id,
    userWantsSummary: true,
  })

  cancelTree = false
  await t.session.navigateTree(q2.id, { summarize: true })
  const summary = t.session
    .getEntries()
    .find((e) => e.type === 'branch_summary')
  expect(summary).toMatchObject({ summary: 'from the extension' })
  // The extension's label went on the summary entry
  expect(nodeOf(t.session.getTree(), summary!.id)).toMatchObject({
    label: 'tried',
  })
  expect(seen.at(-1)).toMatchObject({
    type: 'session_tree',
    oldLeafId: leaf,
    fromExtension: true,
    summaryEntry: { id: summary!.id },
  })
  // No summary request went to the model
  expect(t.model.calls.some((c) => c.kind === 'generate')).toBe(false)

  expect(await t.session.fork(q2.id)).toEqual({ cancelled: true })
})

test('navigateTree and fork refuse while a task runs', async () => {
  const t = await twoRounds()
  t.session.busy.locked = true
  const q1 = entryOf(t.session.getEntries(), 'q1')
  await expect(t.session.navigateTree(q1.id)).rejects.toThrow(
    'A task is already running',
  )
  await expect(t.session.fork(q1.id)).rejects.toThrow(
    'A task is already running',
  )
  t.session.busy.locked = false
  await expect(t.session.navigateTree('missing')).rejects.toThrow(
    'not in the session',
  )
})
