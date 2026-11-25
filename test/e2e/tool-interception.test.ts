import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  cleanupTestVelas,
  createTestVela,
  fauxText,
  fauxToolCall,
} from '../../packages/vela/src/testing/core/index.ts'

afterEach(cleanupTestVelas)

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

test.each(['allow', 'block', 'throw', 'cancel'] as const)(
  'async tool_call holds side effects until its %s decision',
  async (decision) => {
    const entered = gate()
    const pending = gate()
    const t = createTestVela({
      extensions: [
        function delayed(vela) {
          vela.on('tool_call', async () => {
            entered.release()
            await pending.promise
            if (decision === 'throw') throw new Error('check failed')
            if (decision === 'block') return { block: true, reason: 'stopped' }
          })
        },
      ],
      responses: [
        fauxToolCall('write', { path: 'effect.txt', content: 'written' }),
        fauxText('done'),
      ],
      allowPendingResponses: decision === 'cancel',
    })
    const run = t.run('Write a file').catch((error: unknown) => error)
    await entered.promise
    expect(existsSync(join(t.cwd, 'effect.txt'))).toBe(false)
    expect(t.model.calls).toHaveLength(1)
    const abort = decision === 'cancel' ? t.session.abort() : undefined
    pending.release()
    await run
    await abort
    expect(existsSync(join(t.cwd, 'effect.txt'))).toBe(decision === 'allow')
    if (decision === 'block' || decision === 'throw') {
      expect(String(t.model.calls[1]!.toolResults[0]!.output)).toContain(
        '[Blocked by hook]',
      )
    }
  },
)

test('ordered async input rewrites reach later handlers, execution and original history', async () => {
  const seen: string[] = []
  const t = createTestVela({
    extensions: [
      function first(vela) {
        vela.on('tool_call', async (event) => {
          await Promise.resolve()
          event.input.path = 'second.txt'
        })
      },
      function second(vela) {
        vela.on('tool_call', (event) => {
          seen.push(String(event.input.path))
          event.input.path = 'final.txt'
        })
      },
    ],
    responses: [
      fauxToolCall('write', { path: 'initial.txt', content: 'written' }),
      fauxText('done'),
    ],
  })
  await t.run('Write')
  expect(seen[0]).toBe('second.txt')
  expect(await Bun.file(join(t.cwd, 'final.txt')).text()).toBe('written')
  expect(existsSync(join(t.cwd, 'initial.txt'))).toBe(false)
  const { openDatabase } = await import('../../packages/vela/src/db/index.ts')
  const db = openDatabase({ path: `${t.dataDir}/vela.db`, readonly: true })
  try {
    const row = db.get<{ input_json: string }>(
      'SELECT input_json FROM vela_tool_calls ORDER BY created_at DESC LIMIT 1',
    )
    expect(row?.input_json).toContain('final.txt')
  } finally {
    db.close()
  }
  expect(t.eventsOf('audit').map((event) => event.path)).toEqual(['final.txt'])
})

test('async tool_result transformations chain before the next model request without rewriting details, preserving final result_json', async () => {
  const entered = gate()
  const pending = gate()
  const t = createTestVela({
    files: { 'a.txt': 'original text' },
    extensions: [
      function first(vela) {
        vela.on('tool_result', async () => {
          entered.release()
          await pending.promise
          return { output: 'first' }
        })
      },
      function second(vela) {
        vela.on('tool_result', (event) => ({
          output: `${event.output}-second`,
        }))
      },
    ],
    responses: [fauxToolCall('read', { path: 'a.txt' }), fauxText('done')],
  })
  const run = t.run('Read')
  await entered.promise
  expect(t.model.calls).toHaveLength(1)
  pending.release()
  await run
  expect(t.model.calls[1]!.toolResults[0]!.output).toBe('first-second')
  const { openDatabase } = await import('../../packages/vela/src/db/index.ts')
  const db = openDatabase({ path: `${t.dataDir}/vela.db`, readonly: true })
  try {
    const row = db.get<{ status: string; result_json: string | null }>(
      'SELECT status, result_json FROM vela_tool_calls ORDER BY created_at DESC LIMIT 1',
    )
    expect(row?.status).toBe('completed')
    expect(JSON.parse(String(row?.result_json))).toEqual({
      type: 'text',
      value: 'first-second',
    })
  } finally {
    db.close()
  }
})

test('a block without a reason retains the extension rejection message', async () => {
  const t = createTestVela({
    extensions: [
      function blocked(vela) {
        vela.on('tool_call', () => ({ block: true }))
      },
    ],
    responses: [
      fauxToolCall('write', { path: 'blocked.txt', content: 'no' }),
      fauxText('done'),
    ],
  })
  await t.run('Write')
  expect(t.model.calls[1]!.toolResults[0]!.output).toBe(
    '[Blocked by hook] Blocked by an extension',
  )
  expect(existsSync(join(t.cwd, 'blocked.txt'))).toBe(false)
})
