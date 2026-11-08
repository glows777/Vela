import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createVela, type VelaEvent } from '@glows777/vela-core'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '@glows777/vela-core/testing'
import { z } from 'zod'
import { cleanupTestVelas, createTestVela, tempDir } from '../support/vela.ts'

afterEach(cleanupTestVelas)

test.each(['write_file', 'edit_file'] as const)(
  'core audit runs after async factory and handler rewrites for %s',
  async (toolName) => {
    const atAudit: string[] = []
    const t = createTestVela({
      files: toolName === 'edit_file' ? { 'final.txt': 'before' } : {},
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
          toolName === 'write_file'
            ? { path: 'original.txt', content: 'after' }
            : { path: 'original.txt', oldText: 'before', newText: 'after' },
        ),
        fauxText('done'),
      ],
    })
    await t.run('Change the file')
    expect(atAudit).toEqual([toolName === 'edit_file' ? 'before' : 'missing'])
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

test.each(['deny', 'block', 'throw', 'ask'] as const)(
  '%s preserves audit timing and prevents write side effects',
  async (decision) => {
    const t = createTestVela({
      session: {
        permissions: { write_file: decision === 'deny' ? 'deny' : 'ask' },
      },
      extensions: [
        (api) => {
          api.on('tool_call', 'write_file', () => {
            if (decision === 'block') return { block: true, reason: 'blocked' }
            if (decision === 'throw') throw new Error('check failed')
          })
        },
      ],
      responses: [
        fauxToolCall('write_file', { path: 'rejected.txt', content: 'no' }),
        fauxText('done'),
      ],
    })
    await t.run('Try to write')
    expect(existsSync(join(t.cwd, 'rejected.txt'))).toBe(false)
    expect(t.eventsOf('tool_execution_end')[0]!.isError).toBe(true)
    expect(t.eventsOf('audit')).toEqual(
      decision === 'ask'
        ? [{ type: 'audit', toolName: 'write_file', path: 'rejected.txt' }]
        : [],
    )
  },
)

test('nested writes preserve session and call identity with core auditing', async () => {
  const calls: unknown[] = []
  const audits: unknown[] = []
  const t = createTestVela({
    sessionId: 'nested-audit',
    extensions: [
      function nested(api) {
        api.registerTool({
          name: 'write',
          description: 'Write through the executor',
          inputSchema: z.object({}),
          execute: async (_, ctx) =>
            (
              await ctx!.executeTool!('write_file', {
                path: 'nested.txt',
                content: 'nested',
              })
            ).result,
        })
        api.on('tool_call', 'write_file', (event, ctx) => {
          calls.push([ctx.session.id, event.toolCallId, event.parentToolCallId])
        })
        api.on('audit', (event, ctx) => {
          audits.push([ctx.session.id, event.path])
        })
      },
    ],
    responses: [fauxToolCall('nested_write', {}), fauxText('done')],
  })
  await t.run('Nested write')
  const parentId = t.eventsOf('tool_execution_start')[0]!.toolCallId
  expect(calls).toEqual([['nested-audit', `${parentId}/1`, parentId]])
  expect(audits).toEqual([['nested-audit', 'nested.txt']])
  expect(await t.readFile('nested.txt')).toBe('nested')
  expect(
    t.eventsOf('tool_execution_end').find((e) => e.parentToolCallId),
  ).toMatchObject({
    toolCallId: `${parentId}/1`,
    parentToolCallId: parentId,
    isError: false,
  })
})

test('the core SDK installs auditing with no user extensions', async () => {
  const dir = tempDir('vela-core-audit-')
  const vela = createVela({
    cwd: dir.path,
    contextFiles: false,
    model: createFauxModel({
      responses: [
        fauxToolCall('write_file', { path: 'sdk.txt', content: 'sdk' }),
        fauxText('done'),
      ],
    }),
  })
  const events: VelaEvent[] = []
  vela.subscribe((event) => events.push(event))
  try {
    await vela.session('sdk').prompt('Write')
    expect(events.filter((event) => event.type === 'audit')).toEqual([
      { type: 'audit', toolName: 'write_file', path: 'sdk.txt' },
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
