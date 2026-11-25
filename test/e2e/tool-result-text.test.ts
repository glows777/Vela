import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import z from 'zod'
import { openDatabase } from '../../packages/vela/src/db/sqlite.ts'
import { web } from '../../packages/vela/src/driver/index.ts'
import {
  fauxSummary,
  fauxText,
  fauxToolCall,
} from '../../packages/vela/src/testing/core/index.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

test('echo hi reaches the model as exact output and is recorded inline in history', async () => {
  const t = createTestVela({
    responses: [fauxToolCall('bash', { command: 'echo hi' }), fauxText('done')],
  })
  await t.run('Run echo hi')
  expect(t.model.calls[1]!.toolResults[0]!.raw).toEqual({
    type: 'text',
    value: 'hi\n',
  })
  expect(t.model.calls[0]!.system).not.toContain('[Tool call history]')
  const db = openDatabase({ path: join(t.dataDir, 'vela.db'), readonly: true })
  try {
    const rows = db.all<{ status: string; result_json: string | null }>(
      'SELECT status, result_json FROM vela_tool_calls ORDER BY created_at',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('completed')
    expect(rows[0]!.result_json).toContain('hi\\n')
  } finally {
    db.close()
  }
})

test('bash over 2000 lines keeps its tail and a single readable full-output footer', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', { command: 'seq 1 2100' }),
      (req) => {
        const output = req.toolResults[0]!.output
        expect(output).toStartWith('101\n102\n')
        expect(output).toContain('2100\n')
        expect(output.match(/Full output:/g)).toHaveLength(1)
        const path = output.match(/Full output: (.+)\]/)![1]!
        return fauxToolCall('read', { path, offset: 1, limit: 2 })
      },
      fauxText('recovered'),
    ],
  })
  await t.run('Read the full command output')
  expect(t.model.calls[2]!.toolResults.at(-1)!.output).toStartWith('1\n2\n')
})

test.each([
  ['exit', "printf 'partial\\n'; exit 7", 'Command exited with code 7'],
  [
    'timeout',
    "printf 'partial\\n'; sleep 20",
    'Command timed out after 2 seconds. Pass a larger timeout (up to 1800s) or run_in_background: true for long-running commands.',
  ],
])(
  'bash %s remains plain error text with its execution note',
  async (kind, command, note) => {
    const t = createTestVela({
      responses: [
        fauxToolCall('bash', {
          command,
          // Bash startup stays well inside 2 s; sleep 20 still outlives it.
          ...(kind === 'timeout' ? { timeout: 2 } : {}),
        }),
        fauxText('done'),
      ],
    })
    await t.run('Run command')
    expect(t.model.calls[1]!.toolResults[0]!.raw).toEqual({
      type: 'error-text',
      value: `partial\n\n\n${note}`,
    })
  },
)

test('generic default results keep 20KB whole and truncate to the head with a readable rest', async () => {
  const body = `${'head\n'.repeat(12_000)}END_EVIDENCE`
  const t = createTestVela({
    extensions: [
      function report(v) {
        v.registerTool({
          name: 'large',
          description: 'Report text',
          inputSchema: z.object({ large: z.boolean() }),
          execute: async ({ large }) => (large ? body : 'x'.repeat(20_000)),
        })
      },
    ],
    responses: [
      fauxToolCall('report_large', { large: false }),
      fauxToolCall('report_large', { large: true }),
      (req) => {
        expect(req.toolResults.at(-1)!.raw).toMatchObject({ type: 'text' })
        const output = req.toolResults.at(-1)!.output
        expect(output).toStartWith(body.slice(0, 50 * 1024))
        expect(output).not.toContain('END_EVIDENCE')
        expect(output.match(/Full output:/g)).toHaveLength(1)
        expect(output).toContain('read with offset')
        return fauxToolCall('read', {
          path: output.match(/Full output: (.+?);/)![1]!,
          offset: 12_001,
        })
      },
      fauxText('done'),
    ],
  })
  await t.run('Read the report')
  expect(t.model.calls[1]!.toolResults[0]!.output).toBe('x'.repeat(20_000))
  expect(t.model.calls[3]!.toolResults.at(-1)!.output).toBe('END_EVIDENCE')
})

test('web_fetch keeps a 20KB page whole and an oversized page head with one recovery note', async () => {
  const small = 'x'.repeat(20_000)
  const large = `HEAD ${'x'.repeat(60_000)} FOOTEREVIDENCE`
  const server = Bun.serve({
    port: 0,
    fetch: (req) =>
      new Response(
        new URL(req.url).pathname === '/small'
          ? `<p>${small}</p>`
          : `<p>${large}</p>`,
      ),
  })
  try {
    const t = createTestVela({
      extensions: [web()],
      responses: [
        fauxToolCall('web_fetch', {
          url: `http://localhost:${server.port}/small`,
        }),
        fauxToolCall('web_fetch', {
          url: `http://localhost:${server.port}/large`,
        }),
        (req) => {
          const output = req.toolResults.at(-1)!.output
          expect(output).toStartWith(large.slice(0, 50 * 1024))
          expect(output).not.toContain('FOOTEREVIDENCE')
          expect(output.match(/Full output:/g)).toHaveLength(1)
          expect(output).toContain('read with offset')
          return fauxToolCall('read', {
            path: output.match(/Full output: (.+?);/)![1]!,
            offset: 1,
            column: 60_005,
          })
        },
        fauxText('done'),
      ],
    })
    await t.run('Read these web pages')
    expect(t.model.calls[1]!.toolResults[0]!.output).toBe(small)
    expect(t.model.calls[3]!.toolResults.at(-1)!.output).toContain(
      'FOOTEREVIDENCE',
    )
  } finally {
    server.stop(true)
  }
})

test('a resumed SQLite session preserves original tool result and error text', async () => {
  const first = createTestVela({
    responses: [
      fauxToolCall('bash', { command: 'echo legacy' }),
      fauxToolCall('bash', { command: "printf 'failed\\n'; exit 7" }),
      fauxText('done'),
    ],
  })
  await first.run('Run legacy')
  await first.cleanup({ keepDir: true })
  const second = createTestVela({
    cwd: first.cwd,
    responses: [
      (req) => {
        const outputs = req.prompt
          .flatMap((m) => (m.role === 'tool' ? m.content : []))
          .filter((p) => p.type === 'tool-result')
          .map((p) => p.output)
        expect(outputs[0]).toEqual({ type: 'text', value: 'legacy\n' })
        expect(outputs[1]).toEqual({
          type: 'error-text',
          value: 'failed\n\n\nCommand exited with code 7',
        })
        return fauxText('remembered')
      },
    ],
  })
  expect(await second.session.resume()).toBe(true)
  await second.run('Remember the command output')
  expect(second.lastAssistantText()).toBe('remembered')
})

test('a resumed oversized tool result keeps its spill_path recovery path', async () => {
  const body = `HEAD\n${'body\n'.repeat(800)}MIDDLE_EVIDENCE\n${'tail\n'.repeat(800)}TAIL\n`
  const first = createTestVela({
    extensions: [
      function report(v) {
        v.registerTool({
          name: 'legacy',
          description: 'Return a long report',
          inputSchema: z.object({}),
          maxResultChars: 3000,
          execute: async () => body,
        })
      },
    ],
    responses: [fauxToolCall('report_legacy', {}), fauxText('saved')],
  })
  await first.run('Get the report')
  const db = openDatabase({
    path: join(first.dataDir, 'vela.db'),
    readonly: true,
  })
  const spillRow = db.get<{ spill_path: string | null }>(
    'SELECT spill_path FROM vela_tool_calls LIMIT 1',
  )
  db.close()
  expect(spillRow?.spill_path).toBeTruthy()
  await first.session.close()
  const second = createTestVela({
    cwd: first.cwd,
    responses: [
      (req) => {
        const output = req.prompt
          .flatMap((m) => (m.role === 'tool' ? m.content : []))
          .filter((p) => p.type === 'tool-result')[0]!.output
        expect(output.type).toBe('text')
        const text = (output as { type: 'text'; value: string }).value
        expect(text.match(/Full output:/g)).toHaveLength(1)
        expect(text).not.toContain('MIDDLE_EVIDENCE')
        return fauxToolCall('read', {
          path: text.match(/Full output: (.+?);/)![1]!,
          offset: 802,
          limit: 1,
        })
      },
      (req) => {
        expect(req.toolResults[0]!.output).toContain('MIDDLE_EVIDENCE')
        return fauxText('recovered')
      },
    ],
  })
  expect(await second.session.resume()).toBe(true)
  await second.run('Recover the omitted middle')
  expect(second.lastAssistantText()).toBe('recovered')
})

test('compaction keeps summary without earlier-output snapshot footer or history guide', async () => {
  const t = createTestVela({
    responses: Array.from({ length: 5 }, () => fauxText('answer')),
    generate: [fauxSummary()],
  })
  for (let i = 0; i < 4; i++) await t.run(`Question ${i}`)
  await t.session.compact()
  await t.run('Continue')
  const prompt = JSON.stringify(t.model.calls.at(-1)!.prompt)
  expect(prompt).not.toContain('/snapshots/through-')
  expect(prompt).not.toContain('Earlier tool output:')
  expect(prompt).not.toContain('[Tool call history]')
  expect(t.model.calls.at(-1)!.system).not.toContain('[Tool call history]')
})
