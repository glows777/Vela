import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { openDatabase } from '../../packages/vela/src/db/sqlite.ts'
import { fauxText } from '../../packages/vela/src/testing/core/index.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

const roots: string[] = []
afterEach(async () => {
  await cleanupTestVelas()
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})
async function root() {
  const cwd = await mkdtemp(join(tmpdir(), 'vela-reconcile-'))
  roots.push(cwd)
  return cwd
}
async function killAtCheckpoint(cwd: string, phase: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      new URL('../fixtures/recovery/reconcile.ts', import.meta.url).pathname,
      cwd,
      phase,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
  try {
    let output = ''
    for await (const chunk of child.stdout) {
      output += new TextDecoder().decode(chunk)
      if (output.includes('CRASH_READY')) return
    }
    throw new Error(
      `Recovery fixture exited before checkpoint: ${await new Response(child.stderr).text()}`,
    )
  } finally {
    clearTimeout(timer)
    child.kill('SIGKILL')
    await child.exited
  }
}
function records(cwd: string) {
  const db = openDatabase({
    path: join(cwd, '.vela-data/vela.db'),
    readonly: true,
  })
  try {
    return db
      .all<{ content_json: string }>(
        "SELECT content_json FROM vela_messages WHERE kind = 'message' ORDER BY seq",
      )
      .map((row) => ({
        type: 'message' as const,
        message: JSON.parse(row.content_json) as {
          role: string
          content: {
            toolCallId?: string
            toolName?: string
            output?: unknown
          }[]
        },
      }))
  } finally {
    db.close()
  }
}
function results(entries: ReturnType<typeof records>) {
  return entries.flatMap((entry) =>
    entry.type === 'message' && entry.message.role === 'tool'
      ? entry.message.content
      : [],
  )
}

test('SIGKILL restores exact journal output and interrupted sibling once, including another crash during repair', async () => {
  const cwd = await root()
  await killAtCheckpoint(cwd, 'start')
  expect(results(records(cwd))).toHaveLength(0)
  await killAtCheckpoint(cwd, 'repair')
  const firstRepair = results(records(cwd))
  expect(firstRepair).toHaveLength(2)
  await killAtCheckpoint(cwd, 'repair')
  const repaired = results(records(cwd))
  expect(repaired).toEqual(firstRepair)
  expect(repaired[0]).toMatchObject({
    toolName: 'probe_finish',
    output: { type: 'text', value: 'EXACT POST-HOOK RESPONSE' },
  })
  expect(repaired[1]).toMatchObject({
    toolName: 'probe_wait',
    output: {
      type: 'error-text',
      value: expect.stringContaining('may have partially run'),
    },
  })
  const t = createTestVela({
    cwd,
    responses: [
      (req) => {
        expect(req.toolResults).toHaveLength(2)
        expect(
          req.toolResults.find((part) => part.toolName === 'probe_finish')
            ?.output,
        ).toBe('EXACT POST-HOOK RESPONSE')
        expect(
          req.toolResults.find((part) => part.toolName === 'probe_wait')
            ?.output,
        ).toContain('may have partially run')
        return fauxText('reconciliation complete')
      },
    ],
  })
  await t.session.resume()
  await t.session.continueInterrupted()
  expect(results(records(cwd))).toEqual(repaired)
  expect(await readFile(join(cwd, 'effects.txt'), 'utf8')).toBe('finished\n')
  expect(await readFile(join(cwd, 'started.txt'), 'utf8')).toBe('started\n')
  expect(
    t.session.messages.filter((message) => message.role === 'user'),
  ).toHaveLength(1)
}, 20_000)

test('a non-safe persisted tool call never replays even when its current declaration is safe', async () => {
  const cwd = await root()
  await killAtCheckpoint(cwd, 'legacy')
  const db = openDatabase({ path: join(cwd, '.vela-data/vela.db') })
  db.run("UPDATE vela_tool_calls SET replay = 'none'")
  db.close()
  let executions = 0
  const t = createTestVela({
    cwd,
    responses: [fauxText('legacy call remains unknown')],
    extensions: [
      function probe(api) {
        api.registerTool({
          name: 'wait',
          description: 'Current safe declaration',
          replay: 'safe',
          inputSchema: z.object({}),
          execute: async () => {
            executions++
            return 'should not run'
          },
        })
      },
    ],
  })
  await t.session.resume()
  await t.session.continueInterrupted()
  expect(executions).toBe(0)
  expect(
    t.model.calls[0]!.toolResults.find((part) => part.toolName === 'probe_wait')
      ?.output,
  ).toContain('may have partially run')
  expect(await readFile(join(cwd, 'started.txt'), 'utf8')).toBe('started\n')
})

test('restarting after a hosted search does not invent a local interrupted result for its provider-owned call', async () => {
  const cwd = await root()
  await killAtCheckpoint(cwd, 'hosted')
  const t = createTestVela({
    cwd,
    responses: [
      (req) => {
        expect(JSON.stringify(req.prompt)).not.toContain(
          'was interrupted by a restart',
        )
        return fauxText('Continued after hosted search')
      },
    ],
  })
  await t.session.resume()
  expect(JSON.stringify(t.session.messages)).toContain('hosted-search-1')
  await t.session.continueInterrupted()
  expect(
    results(records(cwd)).some((part) => part.toolCallId === 'hosted-search-1'),
  ).toBe(false)
  expect(t.model.calls).toHaveLength(1)
})
