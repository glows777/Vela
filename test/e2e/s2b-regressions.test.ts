import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { openDatabase } from '../../packages/vela/src/db/sqlite.ts'
import type { ExtensionAPI } from '../../packages/vela/src/driver/extensions/types.ts'
import { SessionStore } from '../../packages/vela/src/driver/session/index.ts'
import { prepareSeedBranch } from '../../packages/vela/src/driver/session/seed-clone.ts'
import type { ExecutionEnv } from '../../packages/vela/src/index.ts'
import {
  createFauxModel,
  fauxHang,
  fauxText,
  fauxToolCall,
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

test('R1 #10/#12/#14/#15: spill confinement + remote copy, fork/clone rejects waiting_human, root leaf_message_id NULL persists, per-entry choice & details round-trip', async () => {
  // R1 #14: navigateTree to first user message persists leaf_message_id = NULL across resume
  const tLeaf = createTestVela({
    responses: [fauxText('first reply')],
  })
  await tLeaf.run('first prompt')
  const firstUser = tLeaf.session.getEntries()[0]!
  const nav = await tLeaf.session.navigateTree(firstUser.id)
  expect(nav.editorText).toBe('first prompt')
  expect(tLeaf.session.getLeafId()).toBeNull()
  const reopenedLeaf = createTestVela({ cwd: tLeaf.cwd })
  expect(await reopenedLeaf.session.resume()).toBe(true)
  expect(reopenedLeaf.session.getLeafId()).toBeNull()
  expect(reopenedLeaf.session.messages).toHaveLength(0)

  // R1 #15: per-entry model & thinkingLevel persist across resume for fork, without leaking _choice, plus primitive details round-trip
  const m1 = createFauxModel({
    modelId: 'm1',
    responses: [fauxText('m1 reply')],
  })
  const m2 = createFauxModel({
    modelId: 'm2',
    responses: [fauxText('m2 reply')],
  })
  const switchProviders = {
    switch: {
      models: [{ id: 'm1' }, { id: 'm2' }],
      createModel: (id: string) => (id === 'm1' ? m1 : m2),
    },
  }
  const tChoice = createTestVela({
    model: 'switch/m1',
    providers: switchProviders,
    thinkingLevel: 'low',
  })
  tChoice.session.setThinkingLevel('high')
  await tChoice.run('turn 1 high')
  tChoice.session.setModel('switch/m2')
  tChoice.session.setThinkingLevel('off')
  await tChoice.run('turn 2 off')
  await tChoice.session.sendMessage({
    customType: 'note',
    content: 'custom note',
    display: true,
    details: ['tag-1', 'tag-2'],
  })

  const resumedChoice = createTestVela({
    cwd: tChoice.cwd,
    model: 'switch/m1',
    providers: switchProviders,
  })
  expect(await resumedChoice.session.resume()).toBe(true)
  const resumedEntries = resumedChoice.session.getEntries()
  // _choice must never leak onto visible entry details
  for (const e of resumedEntries) {
    if (e.type === 'message') {
      expect(
        (e.details as Record<string, unknown> | undefined)?._choice,
      ).toBeUndefined()
    }
  }
  const customLoaded = resumedEntries.find((e) => e.type === 'custom_message')!
  expect(customLoaded.type).toBe('custom_message')
  if (customLoaded.type === 'custom_message') {
    expect(customLoaded.details).toEqual(['tag-1', 'tag-2'])
  }
  const turn2User = resumedEntries.find(
    (e) => e.type === 'message' && JSON.stringify(e).includes('turn 2 off'),
  )!
  const forkedChoice = await resumedChoice.session.fork(turn2User.id, {
    sessionId: 'fork-branch1-choice',
  })
  expect(forkedChoice.session!.modelInfo.ref).toBe('switch/m1')
  expect(forkedChoice.session!.thinkingLevel).toBe('high')

  // R1 #12: fork/clone rejects unresolved/awaiting_approval branch, allows before suspended turn
  const tApp = createTestVela({
    extensions: [
      function appExt(api: ExtensionAPI) {
        api.registerTool({
          name: 'danger',
          description: 'danger',
          inputSchema: z.object({}),
          execute: async () => 'done',
        })
        api.on('tool_call', (ev) => {
          if (ev.toolName === 'appExt_danger')
            return { approval: { summary: 'Confirm danger' } }
        })
      },
    ],
    responses: [fauxText('safe reply'), fauxToolCall('appExt_danger', {})],
  })
  await tApp.run('safe turn')
  await tApp.run('unsafe turn')
  const unsafeUser = tApp.session
    .getEntries()
    .find(
      (e) => e.type === 'message' && JSON.stringify(e).includes('unsafe turn'),
    )!
  await expect(tApp.session.clone({ sessionId: 'bad-clone' })).rejects.toThrow(
    /unresolved|awaiting-approval/i,
  )
  await expect(
    tApp.session.fork(tApp.session.getLeafId()!, {
      position: 'at',
      sessionId: 'bad-fork',
    }),
  ).rejects.toThrow(/unresolved|awaiting-approval/i)
  const cleanFork = await tApp.session.fork(unsafeUser.id, {
    position: 'before',
    sessionId: 'clean-before-wait',
  })
  expect(cleanFork.cancelled).toBe(false)

  // R1 #10: local spill confinement ignores outside files/symlinks; remote copy uses ExecutionEnv
  const tmp = mkdtempSync(join(tmpdir(), 'vela-spill-sec-'))
  try {
    const parentSpillDir = join(tmp, 'parent-spill')
    const targetSpillDir = join(tmp, 'target-spill')
    const secretFile = join(tmp, 'host-secret.txt')
    const escapedLink = join(parentSpillDir, 'escape-link.txt')
    const validFile = join(parentSpillDir, 'valid-out.txt')
    mkdirSync(parentSpillDir, { recursive: true })
    writeFileSync(secretFile, 'TOP_SECRET_KEY')
    writeFileSync(validFile, 'VALID_SPILL')
    symlinkSync(secretFile, escapedLink)

    const db = openDatabase({ path: join(tmp, 'spill.db') })
    const pStore = new SessionStore('parent', db)
    const cStore = new SessionStore('child', db)
    const branch = [
      pStore.appendBashExecution({
        type: 'bash_execution',
        command: 'cat',
        output: 'prev',
        cancelled: false,
        truncated: true,
        fullOutputPath: validFile,
      }),
      pStore.appendBashExecution({
        type: 'bash_execution',
        command: 'sec',
        output: 'sec',
        cancelled: false,
        truncated: true,
        fullOutputPath: secretFile,
      }),
      pStore.appendBashExecution({
        type: 'bash_execution',
        command: 'lnk',
        output: 'lnk',
        cancelled: false,
        truncated: true,
        fullOutputPath: escapedLink,
      }),
    ]
    const preparedLocal = await prepareSeedBranch({
      db,
      branch,
      parentId: 'parent',
      parentUploads: pStore.uploads,
      targetUploads: cStore.uploads,
      resolveEnv: async () => {
        throw new Error('local fork must not resolve remote env')
      },
      parentSpillDir,
      spillDir: targetSpillDir,
    })
    expect(existsSync(join(targetSpillDir, 'valid-out.txt'))).toBe(true)
    expect(existsSync(join(targetSpillDir, 'host-secret.txt'))).toBe(false)
    expect(existsSync(join(targetSpillDir, 'escape-link.txt'))).toBe(false)
    expect(preparedLocal.spillRewrites.size).toBe(1)

    // Remote ExecutionEnv copy
    let wroteRemote = false
    const fakeRemoteEnv = {
      id: 'remote:ssh',
      cwd: '/remote',
      openBinaryReader: async (p: string) => ({
        ok: p === '/remote/spill.txt',
        value: {
          info: async () => ({ ok: true, value: { kind: 'file', size: 6 } }),
          read: async () => ({
            ok: true,
            value: new TextEncoder().encode('REMOTE'),
          }),
          close: async () => {},
        },
        error: { code: 'not_found' },
      }),
      createTempFile: async () => ({
        ok: true,
        value: '/remote/new-spill.txt',
      }),
      writeFile: async () => {
        wroteRemote = true
        return { ok: true, value: undefined }
      },
    } as unknown as ExecutionEnv
    const preparedRemote = await prepareSeedBranch({
      db,
      branch: [
        {
          ...branch[0]!,
          id: 'r1',
          fullOutputPath: '/remote/spill.txt',
        },
      ],
      parentId: 'parent',
      parentUploads: pStore.uploads,
      targetUploads: cStore.uploads,
      resolveEnv: async () => fakeRemoteEnv,
      isRemote: true,
    })
    expect(wroteRemote).toBe(true)
    expect(preparedRemote.spillRewrites.get('/remote/spill.txt')).toBe(
      '/remote/new-spill.txt',
    )
    db.close()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
