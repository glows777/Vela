import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
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
async function records(cwd: string) {
  return (
    await readFile(
      join(cwd, '.vela-data/sessions/default/transcript.jsonl'),
      'utf8',
    )
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}
function results(entries: Awaited<ReturnType<typeof records>>) {
  return entries.flatMap((entry) =>
    entry.type === 'message' && entry.message.role === 'tool'
      ? entry.message.content
      : [],
  )
}

test('SIGKILL restores exact journal output and interrupted sibling once, including another crash during repair', async () => {
  const cwd = await root()
  await killAtCheckpoint(cwd, 'start')
  expect(results(await records(cwd))).toHaveLength(0)
  await killAtCheckpoint(cwd, 'repair-first')
  expect(results(await records(cwd))).toHaveLength(1)
  await killAtCheckpoint(cwd, 'repair')
  const repaired = results(await records(cwd))
  expect(repaired).toHaveLength(2)
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
  expect(results(await records(cwd))).toEqual(repaired)
  expect(await readFile(join(cwd, 'effects.txt'), 'utf8')).toBe('finished\n')
  expect(await readFile(join(cwd, 'started.txt'), 'utf8')).toBe('started\n')
  expect(
    t.session.messages.filter((message) => message.role === 'user'),
  ).toHaveLength(1)
}, 20_000)

test('a pre-policy journal never replays a tool even when its current declaration is safe', async () => {
  const cwd = await root()
  await killAtCheckpoint(cwd, 'legacy')
  const data = join(cwd, '.vela-data')
  for (const file of await readdir(data, { recursive: true })) {
    if (!file.endsWith('tool-history.jsonl')) continue
    const path = join(data, file)
    const entries = (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    for (const entry of entries)
      if (entry.type === 'tool_call') delete entry.replay
    await writeFile(
      path,
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    )
  }
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

test('an old-version crash without a saved assistant anchor stops before replay or another model request', async () => {
  const cwd = await root()
  await killAtCheckpoint(cwd, 'legacy')
  const data = join(cwd, '.vela-data')
  const transcript = join(data, 'sessions/default/transcript.jsonl')
  const entries = await records(cwd)
  const assistant = entries.find(
    (entry) => entry.type === 'message' && entry.message.role === 'assistant',
  )
  expect(assistant).toBeDefined()
  // Before checkpointing was added, SIGKILL inside a tool left the call journal but
  // not this step's assistant in the transcript. Reproduce precisely that old disk shape.
  const oldEntries = entries.filter((entry) => entry.id !== assistant.id)
  for (const entry of oldEntries)
    if (entry.parentId === assistant.id) entry.parentId = assistant.parentId
  await writeFile(
    transcript,
    `${oldEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  )
  const evidence = new Map<string, string>()
  for (const file of await readdir(data, { recursive: true })) {
    if (!file.endsWith('tool-history.jsonl')) continue
    const path = join(data, file)
    const history = (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    for (const entry of history)
      if (entry.type === 'tool_call') delete entry.replay
    const content = `${history.map((entry) => JSON.stringify(entry)).join('\n')}\n`
    await writeFile(path, content)
    evidence.set(path, content)
  }
  evidence.set(transcript, await readFile(transcript, 'utf8'))
  const t = createTestVela({ cwd, responses: [] })
  await t.session.resume()
  await expect(t.session.continueInterrupted()).rejects.toThrow(
    'without a saved assistant step',
  )
  expect(t.model.calls).toHaveLength(0)
  expect(t.session.isRunning).toBe(false)
  for (const [path, content] of evidence)
    expect(await readFile(path, 'utf8')).toBe(content)
  expect(await readFile(join(cwd, 'effects.txt'), 'utf8')).toBe('finished\n')
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
    results(await records(cwd)).some(
      (part) => part.toolCallId === 'hosted-search-1',
    ),
  ).toBe(false)
  expect(t.model.calls).toHaveLength(1)
})
