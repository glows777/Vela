import { expect, test } from 'bun:test'
import {
  buildSessionContext,
  buildSessionPath,
  buildSessionTree,
  copyBranch,
  type SessionEntry,
} from '../../../src/session/entries.ts'
import { renderSessionHtml } from '../../../src/session/export-html.ts'

const time = '2026-10-10T00:00:00.000Z'
const message = (
  id: string,
  parentId: string | null,
  role: 'user' | 'assistant',
  content: string,
): SessionEntry => ({
  type: 'message',
  id,
  parentId,
  timestamp: time,
  message:
    role === 'user'
      ? { role, content }
      : { role, content: [{ type: 'text', text: content }] },
})

// a ─ b ─┬─ c ─ d
//        └─ e ─ (branch summary) ─ f
const entries: SessionEntry[] = [
  message('a', null, 'user', 'q1'),
  message('b', 'a', 'assistant', 'a1'),
  message('c', 'b', 'user', 'q2'),
  message('d', 'c', 'assistant', 'a2'),
  {
    type: 'label',
    id: 'l1',
    parentId: 'd',
    timestamp: time,
    targetId: 'a',
    label: 'start',
  },
  message('e', 'b', 'user', 'q2b'),
  {
    type: 'branch_summary',
    id: 's',
    parentId: 'e',
    timestamp: time,
    fromId: 'd',
    summary: 'tried q2',
  },
  message('f', 's', 'assistant', 'a2b'),
]

test('buildSessionPath walks from a leaf to the root; null is before the first entry', () => {
  expect(buildSessionPath(entries, 'f').map((e) => e.id)).toEqual([
    'a',
    'b',
    'e',
    's',
    'f',
  ])
  expect(buildSessionPath(entries).map((e) => e.id)).toEqual([
    'a',
    'b',
    'e',
    's',
    'f',
  ])
  expect(buildSessionPath(entries, null)).toEqual([])
  expect(() => buildSessionPath(entries, 'zz')).toThrow('not in the session')
})

test('buildSessionContext follows the leaf; branch summaries become user messages', () => {
  const other = buildSessionContext(entries, 'd')
  expect(other.messages.map((m) => m.content)).toEqual([
    'q1',
    [{ type: 'text', text: 'a1' }],
    'q2',
    [{ type: 'text', text: 'a2' }],
  ])
  const current = buildSessionContext(entries, 'f')
  expect(current.messages[3]).toEqual({
    role: 'user',
    content: '[Summary of the conversation branch you left]\ntried q2',
  })
  expect(current.ids.get(current.messages[3]!)).toBe('s')
})

test('buildSessionTree nests branches, resolves labels and keeps orphans as roots', () => {
  const tree = buildSessionTree([
    ...entries,
    message('o', 'missing', 'user', 'orphan'),
  ])
  expect(tree.map((n) => n.entry.id)).toEqual(['a', 'o'])
  expect(tree[0]!.label).toBe('start')
  const b = tree[0]!.children[0]!
  expect(b.children.map((n) => n.entry.id)).toEqual(['c', 'e'])
})

test('copyBranch re-chains the path without label entries and re-adds labels for entries on it', () => {
  const path = buildSessionPath(entries, 'l1')
  const copied = copyBranch(path)
  expect(copied.map((e) => e.type)).toEqual([
    'message',
    'message',
    'message',
    'message',
    'label',
  ])
  expect(copied.slice(0, 4).map((e) => [e.id, e.parentId])).toEqual([
    ['a', null],
    ['b', 'a'],
    ['c', 'b'],
    ['d', 'c'],
  ])
  expect(copied[4]).toMatchObject({
    type: 'label',
    targetId: 'a',
    label: 'start',
    parentId: 'd',
  })
})

test('the HTML export escapes content and has no scripts or external resources', () => {
  const html = renderSessionHtml({
    id: 'x"><img src=x>',
    entries: [message('a', null, 'user', '</div><script>alert(1)</script>')],
  })
  expect(html).not.toContain('<script>')
  expect(html).not.toContain('<img')
  expect(html).toContain('&lt;script&gt;')
  expect(html).toContain("default-src 'none'")
})
