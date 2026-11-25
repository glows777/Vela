import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { openDatabase } from '../../packages/vela/src/db/sqlite.ts'
import { createVela } from '../../packages/vela/src/driver/index.ts'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '../../packages/vela/src/testing/core/index.ts'

test('a TX1 SQLite checkpoint failure aborts before tool execution and rolls back cleanly before follow-up and disk resume', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'vela-checkpoint-failure-'))
  const dataDir = join(cwd, 'data')
  const db = openDatabase({ path: join(dataDir, 'vela.db') })
  const failure = 'checkpoint disk unavailable'
  let executions = 0
  const model = createFauxModel({
    responses: [
      [
        fauxToolCall('probe_write', { value: 1 }),
        fauxToolCall('probe_write', { value: 2 }),
      ],
      fauxText('follow-up accepted'),
      fauxText('resumed'),
    ],
  })
  const vela = createVela({
    cwd,
    dataDir,
    db,
    model,
    extensions: [
      function probe(api) {
        api.registerTool({
          name: 'write',
          description: 'side effect',
          inputSchema: z.object({ value: z.number() }),
          execute: async () => {
            executions++
            return 'written'
          },
        })
      },
    ],
  })
  const session = vela.session('failure')
  try {
    db.exec(`
      CREATE TRIGGER fail_tx1_checkpoint BEFORE INSERT ON vela_tool_calls
      BEGIN
        SELECT RAISE(ABORT, '${failure}');
      END;
    `)
    await expect(session.prompt('write twice')).rejects.toThrow(failure)
    expect(executions).toBe(0)
    expect(model.calls).toHaveLength(1)
    expect(
      db.get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM vela_tool_calls WHERE session_id = ?',
        'failure',
      )!.c,
    ).toBe(0)
    db.exec('DROP TRIGGER fail_tx1_checkpoint;')
    await session.prompt('continue normally')
    expect(model.calls).toHaveLength(2)
    expect(executions).toBe(0)
    await session.save()
    await vela.dispose()
    db.close()

    const restored = createVela({
      cwd,
      dataDir,
      model: createFauxModel({ responses: [fauxText('resumed')] }),
    })
    try {
      const again = restored.session('failure')
      expect(await again.resume()).toBe(true)
      await again.prompt('another ordinary prompt')
      expect(executions).toBe(0)
    } finally {
      await restored.dispose()
    }
  } finally {
    await vela.dispose().catch(() => {})
    db.close()
    await rm(cwd, { recursive: true, force: true })
  }
})
