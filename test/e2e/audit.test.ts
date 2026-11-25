import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createVela,
  type VelaEvent,
} from '../../packages/vela/src/driver/index.ts'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '../../packages/vela/src/testing/core/index.ts'
import { cleanupTestVelas, createTestVela, tempDir } from '../support/vela.ts'

afterEach(cleanupTestVelas)

test.each(['write', 'edit'] as const)(
  'core audit runs after async factory and handler rewrites for %s',
  async (toolName) => {
    const atAudit: string[] = []
    const t = createTestVela({
      files: toolName === 'edit' ? { 'final.txt': 'before' } : {},
      extensions: [
        async function redirect(api) {
          await Promise.resolve()
          api.on('tool_call', toolName, async (event) => {
            await Promise.resolve()
            event.input.path = 'final.txt'
          })
          api.on('audit', (event, ctx) => {
            const path = join(ctx.session.cwd, event.path)
            atAudit.push(
              existsSync(path) ? readFileSync(path, 'utf8') : 'missing',
            )
          })
        },
      ],
      responses: [
        fauxToolCall(
          toolName,
          toolName === 'write'
            ? { path: 'original.txt', content: 'after' }
            : { path: 'original.txt', oldText: 'before', newText: 'after' },
        ),
        fauxText('done'),
      ],
    })
    await t.run('Change the file')
    expect(atAudit).toEqual([toolName === 'edit' ? 'before' : 'missing'])
    expect(t.eventsOf('audit')).toEqual([
      { type: 'audit', toolName, path: 'final.txt' },
    ])
    expect(await t.readFile('final.txt')).toBe('after')
    expect(existsSync(join(t.cwd, 'original.txt'))).toBe(false)
    expect(t.vela.extensions().map((extension) => extension.name)).toContain(
      'auditLog',
    )
  },
)

test.each(['excluded', 'block', 'throw'] as const)(
  '%s preserves audit timing and prevents write side effects',
  async (decision) => {
    const t = createTestVela({
      session: {
        tools: decision === 'excluded' ? ['-write'] : undefined,
      },
      extensions: [
        (api) => {
          api.on('tool_call', 'write', () => {
            if (decision === 'block') return { block: true, reason: 'blocked' }
            if (decision === 'throw') throw new Error('check failed')
          })
        },
      ],
      responses: [
        fauxToolCall('write', { path: 'rejected.txt', content: 'no' }),
        fauxText('done'),
      ],
    })
    await t.run('Try to write')
    expect(existsSync(join(t.cwd, 'rejected.txt'))).toBe(false)
    expect(t.eventsOf('tool_execution_end')[0]!.isError).toBe(true)
    expect(t.eventsOf('audit')).toEqual([])
  },
)

test('the core SDK installs auditing with no user extensions', async () => {
  const dir = tempDir('vela-core-audit-')
  const vela = createVela({
    cwd: dir.path,
    contextFiles: false,
    model: createFauxModel({
      responses: [
        fauxToolCall('write', { path: 'sdk.txt', content: 'sdk' }),
        fauxText('done'),
      ],
    }),
  })
  const events: VelaEvent[] = []
  vela.subscribe((event) => events.push(event))
  try {
    await vela.session('sdk').prompt('Write')
    expect(events.filter((event) => event.type === 'audit')).toEqual([
      { type: 'audit', toolName: 'write', path: 'sdk.txt' },
    ])
    expect(readFileSync(join(dir.path, 'sdk.txt'), 'utf8')).toBe('sdk')
    expect(vela.extensions().map((extension) => extension.name)).toEqual([
      'auditLog',
    ])
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})
