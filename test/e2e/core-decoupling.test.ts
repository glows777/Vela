import { afterEach, expect, test } from 'bun:test'
import { tempDir } from '@glows777/vela/testing'
import { openDatabase } from '../../packages/vela/src/db/sqlite.ts'
import {
  createFauxModel,
  fauxText,
} from '../../packages/vela/src/testing/core/index.ts'
import {
  createVela,
  type Vela,
  type VelaOptions,
} from '../support/compat-vela.ts'

const opened: { vela: Vela; cleanup(): void }[] = []
afterEach(async () => {
  for (const { vela, cleanup } of opened.splice(0)) {
    await vela.dispose().catch(() => {})
    cleanup()
  }
})

function setup(options: VelaOptions = {}) {
  const dir = tempDir('vela-decoupling-')
  const vela = createVela({ cwd: dir.path, contextFiles: false, ...options })
  opened.push({ vela, cleanup: dir.cleanup })
  return { vela, cwd: dir.path }
}

test('storage success observers cannot turn committed batches into duplicate history', async () => {
  const db = openDatabase({ path: ':memory:' })
  const errors: string[] = []
  let saved = 0
  const { vela } = setup({
    model: createFauxModel({ responses: [fauxText('saved')] }),
    db,
    onSessionSaved() {
      saved++
      throw new Error('observer failed')
    },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error(message) {
        errors.push(message)
      },
    },
  })
  try {
    const session = vela.session('observer')
    await session.prompt('write once')
    expect(saved).toBeGreaterThan(0)
    const msgCount = () =>
      db.get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM vela_messages WHERE session_id = ?',
        session.id,
      )!.c
    const before = msgCount()
    const count = saved
    await session.save()
    await session.save()
    expect(msgCount()).toBe(before)
    expect(saved).toBe(count)
    expect(
      db.all<{ id: string }>(
        'SELECT id FROM sessions WHERE id = ?',
        session.id,
      ),
    ).toHaveLength(1)
    expect(errors.join('\n')).toContain('observer failed')
  } finally {
    db.close()
  }
})

test('explicit save failure rejects while retaining the live session', async () => {
  const db = openDatabase({ path: ':memory:' })
  const { vela } = setup({
    model: createFauxModel({ responses: [fauxText('saved')] }),
    db,
  })
  try {
    const session = vela.session('save')
    await session.prompt('start')
    db.exec(`
      CREATE TRIGGER block_pending_write BEFORE INSERT ON vela_messages
      WHEN NEW.kind = 'custom' AND NEW.content_json LIKE '%"pending"%'
      BEGIN
        SELECT RAISE(ABORT, 'storage unavailable');
      END;
    `)
    expect(() => session.appendEntry('pending', { retain: true })).toThrow(
      'storage unavailable',
    )
    expect(vela.sessions()).toContain(session)
    db.exec('DROP TRIGGER block_pending_write;')
    session.appendEntry('pending', { retain: true })
    await session.save()
  } finally {
    db.close()
  }
})

test('beforeDispose precedes session/shared shutdown and failure does not skip either', async () => {
  const order: string[] = []
  const { vela } = setup({
    model: createFauxModel({ responses: [fauxText('ok')] }),
    beforeDispose() {
      order.push('before')
      throw new Error('before failed')
    },
    extensions: [
      function lifecycle(api) {
        api.on('session_shutdown', () => {
          order.push('session')
        })
        api.onShutdown(() => {
          order.push('shared')
        })
      },
    ],
  })
  await vela.session('lifecycle').prompt('open')
  const disposing = vela.dispose()
  expect(vela.dispose()).toBe(disposing)
  await expect(disposing).rejects.toThrow('Vela disposal failed')
  expect(order).toEqual(['before', 'session', 'shared'])
  expect(vela.sessions()).toEqual([])
})
