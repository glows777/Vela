import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from '../../packages/vela/src/db/sqlite.ts'
import {
  fauxHang,
  fauxText,
} from '../../packages/vela/src/testing/core/index.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

test('SQLite /tree labels update in place, /fork preserves ancestry, and listSessions/searchSessions/setSessionArchived work end to end', async () => {
  const t = createTestVela({
    responses: [
      fauxText('a1', { usage: { input: 50, output: 10 } }),
      fauxText('a2', { usage: { input: 60, output: 12 } }),
      fauxText('forked-reply'),
    ],
    generate: [
      fauxText(
        '## Goal\nSummary\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- [x] Done\n### In Progress\n- [ ] (none)\n### Blocked\n- (none)\n\n## Key Decisions\n- (none)\n\n## Next Steps\n1. None\n\n## Critical Context\n- none',
      ),
    ],
  })
  await t.run('first question')
  await t.run('second question')

  const entries = t.session.getEntries()
  const target = entries.find(
    (e) => e.type === 'message' && JSON.stringify(e).includes('first question'),
  )!
  const beforeCount = entries.length
  t.session.setLabel(target.id, 'milestone-1')
  expect(t.session.getEntries()).toHaveLength(beforeCount)

  const db = openDatabase({ path: join(t.dataDir, 'vela.db'), readonly: true })
  try {
    expect(
      db.get<{ label: string | null }>(
        'SELECT label FROM vela_messages WHERE id = ?',
        target.id,
      )?.label,
    ).toBe('milestone-1')

    // Fork into new session
    const secondUser = entries.find(
      (e) =>
        e.type === 'message' && JSON.stringify(e).includes('second question'),
    )!
    const { session: forked } = await t.session.fork(secondUser.id, {
      sessionId: 'branched',
    })
    expect(forked).toBeDefined()
    await forked!.prompt('in fork')

    expect(
      db.get<{ parent_session_id: string | null }>(
        'SELECT parent_session_id FROM sessions WHERE id = ?',
        'branched',
      )?.parent_session_id,
    ).toBe('default')

    // list / search / archive
    expect((await t.vela.listSessions()).map((s) => s.id).sort()).toEqual([
      'branched',
      'default',
    ])
    expect(
      (await t.vela.searchSessions('second question')).map((s) => s.id),
    ).toEqual(['default'])
    await t.vela.setSessionArchived('branched', true)
    expect((await t.vela.listSessions()).map((s) => s.id)).toEqual(['default'])
    expect(
      (await t.vela.listSessions({ includeArchived: true }))
        .map((s) => s.id)
        .sort(),
    ).toEqual(['branched', 'default'])

    // usage_records kinds: main + summary
    await t.session.compact()
    const kinds = db
      .all<{ kind: string }>('SELECT DISTINCT kind FROM usage_records')
      .map((r) => r.kind)
      .sort()
    expect(kinds).toEqual(['main', 'summary'])

    // --export / exportHtml from SQLite
    const htmlPath = join(t.cwd, 'export.html')
    await t.session.exportHtml(htmlPath)
    expect(readFileSync(htmlPath, 'utf8')).toContain('first question')

    expect(t.session.getTree()[0]!.entry.label).toBe('milestone-1')
    const reopened = createTestVela({ cwd: t.cwd })
    expect(await reopened.session.resume()).toBe(true)
    expect(reopened.session.getTree()[0]!.entry.label).toBe('milestone-1')
  } finally {
    db.close()
  }
})

test('!cmd sanitizes ANSI sequences and carriage returns, and mid-stream abort marks include_in_context=0', async () => {
  const t = createTestVela({
    responses: [
      fauxText('ok'),
      fauxHang('partial answer before abort'),
      fauxText('after abort'),
    ],
  })
  const bash = await t.session.executeBash(
    "printf 'line1\\x1b[31mred\\x1b[0m\\rline2\\n'",
  )
  expect(bash.output).not.toContain('\x1b')
  expect(bash.output).not.toContain('\r')
  await t.run('describe bash')
  expect(t.model.calls[0]!.lastUserText).not.toContain('\x1b')

  const aborted = t.run('hang now')
  while (!t.streamedText().includes('partial answer')) await Bun.sleep(1)
  t.session.abort()
  await expect(aborted).rejects.toThrow()

  const db = openDatabase({ path: join(t.dataDir, 'vela.db'), readonly: true })
  try {
    const row = db.get<{
      include_in_context: number
      stop_reason: string | null
    }>(
      "SELECT include_in_context, stop_reason FROM vela_messages WHERE session_id = 'default' ORDER BY seq DESC LIMIT 1",
    )
    expect(row?.stop_reason).toBe('aborted')
    expect(row?.include_in_context).toBe(0)
  } finally {
    db.close()
  }

  await t.run('next question')
  expect(JSON.stringify(t.model.calls.at(-1)!.prompt)).not.toContain(
    'partial answer before abort',
  )
})
