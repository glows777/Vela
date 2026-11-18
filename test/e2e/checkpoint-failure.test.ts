import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createVela,
  fileSessionStorage,
  type ModelMessage,
} from '@glows777/vela-core'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '@glows777/vela-core/testing'
import { z } from 'zod'

function paired(messages: readonly ModelMessage[]) {
  const calls = messages.flatMap((m) =>
    m.role === 'assistant' && Array.isArray(m.content)
      ? m.content.filter((p) => p.type === 'tool-call')
      : [],
  )
  const results = messages.flatMap((m) =>
    m.role === 'tool' ? m.content.filter((p) => p.type === 'tool-result') : [],
  )
  expect(calls).toHaveLength(2)
  for (const call of calls) {
    const matching = results.filter((r) => r.toolCallId === call.toolCallId)
    expect(matching).toHaveLength(1)
    expect(JSON.stringify(matching[0]?.output)).toContain('not executed')
  }
}

test('a failed checkpoint closes calls before an ordinary follow-up and a disk-backed resume', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'vela-checkpoint-failure-'))
  const dataDir = join(cwd, 'data')
  const disk = fileSessionStorage(join(dataDir, 'sessions'))
  const failure = new Error('checkpoint disk unavailable')
  let blocked = true
  let executions = 0
  const model = createFauxModel({
    responses: [
      [
        fauxToolCall('probe_write', { value: 1 }),
        fauxToolCall('probe_write', { value: 2 }),
      ],
      () => {
        paired(session.messages)
        return fauxText('follow-up accepted')
      },
    ],
  })
  const vela = createVela({
    cwd,
    dataDir,
    model,
    sessionStorage: {
      ...disk,
      append: async (id, entries) => {
        if (
          blocked &&
          entries.some(
            (e) => e.type === 'message' && e.message.role === 'assistant',
          )
        )
          throw failure
        await disk.append(id, entries)
      },
    },
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
    await expect(session.prompt('write twice')).rejects.toBe(failure)
    expect(executions).toBe(0)
    expect(model.calls).toHaveLength(1)
    paired(session.messages)
    blocked = false
    await session.prompt('continue normally')
    expect(model.calls).toHaveLength(2)
    expect(executions).toBe(0)
    await session.save()
    const saved = await readFile(
      join(dataDir, 'sessions/failure/transcript.jsonl'),
      'utf8',
    )
    expect(saved).toContain('not executed')
    await vela.dispose()
    const restored = createVela({
      cwd,
      dataDir,
      model: createFauxModel({ responses: [fauxText('resumed')] }),
    })
    try {
      const again = restored.session('failure')
      expect(await again.resume()).toBe(true)
      paired(again.messages)
      await again.prompt('another ordinary prompt')
      expect(executions).toBe(0)
    } finally {
      await restored.dispose()
    }
  } finally {
    blocked = false
    await vela.dispose()
    await rm(cwd, { recursive: true, force: true })
  }
})
