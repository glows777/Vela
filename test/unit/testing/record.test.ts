import { afterEach, expect, test } from 'bun:test'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { generateText } from 'ai'
import type { VelaEvent } from '../../../src/agent/events.ts'
import {
  createFauxModel,
  type FauxScenario,
  fauxError,
  fauxHang,
  fauxStreamError,
  fauxText,
  fauxToolCall,
} from '../../../src/testing/faux.ts'
import { recordModel } from '../../../src/testing/record.ts'
import { replayScenario } from '../../../src/testing/replay.ts'
import {
  cleanupTestVelas,
  createTestVela,
  tempDir,
} from '../../../src/testing/test-vela.ts'

afterEach(cleanupTestVelas)

/** 用 faux 模型扮演“真实模型”，录一段会话 */
async function record(
  responses: Parameters<typeof createFauxModel>[0],
  inputs: string[],
  files: Record<string, string> = {},
) {
  const dir = tempDir('vela-record-')
  const path = join(dir.path, 'scenario.json')
  const recorder = recordModel(createFauxModel(responses), { path })
  const t = createTestVela({ model: recorder.model, files })
  t.vela.subscribe((event) => {
    if (event.type === 'agent_start') recorder.addInput(event.input)
  })
  for (const input of inputs) await t.run(input).catch(() => {})
  await recorder.flush()
  const scenario = (await Bun.file(path).json()) as FauxScenario
  return { t, path, scenario, dir }
}

const shape = (events: VelaEvent[]) =>
  events
    .filter((e) => e.type !== 'usage')
    .map((e) => (e.type === 'tool_call' ? `tool_call:${e.toolName}` : e.type))

test('a recorded session replays offline with the same events and answers', async () => {
  const files = { 'notes.txt': 'remember the milk' }
  const { t, path, scenario, dir } = await record(
    {
      responses: [
        fauxToolCall('read_file', { path: 'notes.txt' }),
        (req) => fauxText(`里面写着：${req.toolResults[0]?.output}`),
        fauxText('第二轮'),
      ],
    },
    ['读 notes.txt', '再说一句'],
    files,
  )
  try {
    expect(scenario.inputs).toEqual(['读 notes.txt', '再说一句'])
    expect(scenario.responses).toHaveLength(3)
    expect(scenario.responses[0]!.toolCalls).toMatchObject([
      { name: 'read_file', input: { path: 'notes.txt' } },
    ])
    expect(scenario.responses[1]!.text).toContain('remember the milk')

    const replay = await replayScenario(path, { files })
    expect(replay.errors).toEqual([undefined, undefined])
    expect(shape(replay.t.events)).toEqual(shape(t.events))
    expect(replay.t.messages.map((m) => m.role)).toEqual(
      t.messages.map((m) => m.role),
    )
    expect(replay.t.lastAssistantText()).toBe('第二轮')
  } finally {
    dir.cleanup()
  }
})

test('request errors, mid-stream errors and retries are recorded as faux errors', async () => {
  const { scenario, path, dir } = await record(
    {
      responses: [
        fauxError('503 Service Unavailable'),
        fauxStreamError('ECONNRESET', '半截'),
        fauxText('终于好了'),
        fauxError('400 Bad Request'),
      ],
    },
    ['第一问', '第二问'],
  )
  try {
    expect(scenario.responses).toEqual([
      { error: '503 Service Unavailable' },
      { text: '半截', streamError: 'ECONNRESET' },
      expect.objectContaining({ text: '终于好了' }),
      { error: '400 Bad Request' },
    ])
    const replay = await replayScenario(path)
    expect(replay.t.eventsOf('retry')).toHaveLength(2)
    expect(replay.errors[0]).toBeUndefined()
    expect((replay.errors[1] as Error).message).toContain('400')
  } finally {
    dir.cleanup()
  }
})

test('an aborted request is recorded as hang', async () => {
  const dir = tempDir('vela-record-')
  const path = join(dir.path, 'scenario.json')
  try {
    const recorder = recordModel(
      createFauxModel({
        responses: [fauxHang('想到一半')],
      }),
      { path },
    )
    const t = createTestVela({ model: recorder.model })
    const running = t.run('等等')
    while (t.eventsOf('text_delta').length === 0) await Bun.sleep(1)
    t.session.abort()
    await running.catch(() => {})
    await recorder.flush()
    expect(recorder.scenario().responses).toEqual([
      { text: '想到一半', hang: true },
    ])
    expect(recorder.scenario().generate).toBeUndefined()
  } finally {
    dir.cleanup()
  }
})

test('generateText requests are recorded in the generate queue', async () => {
  const dir = tempDir('vela-record-')
  const path = join(dir.path, 'scenario.json')
  try {
    const recorder = recordModel(
      createFauxModel({ responses: [], generate: [fauxText('摘要')] }),
      { path },
    )
    const { text } = await generateText({ model: recorder.model, prompt: 'x' })
    expect(text).toBe('摘要')
    await recorder.flush()
    const scenario = (await Bun.file(path).json()) as FauxScenario
    expect(scenario.responses).toEqual([])
    expect(scenario.generate).toEqual([
      expect.objectContaining({ text: '摘要' }),
    ])
  } finally {
    dir.cleanup()
  }
})

test('replayScenario needs recorded inputs', async () => {
  const dir = tempDir('vela-record-')
  try {
    const path = join(dir.path, 'no-inputs.json')
    await Bun.write(path, JSON.stringify({ responses: [{ text: 'x' }] }))
    await expect(replayScenario(path)).rejects.toThrow('inputs')
  } finally {
    dir.cleanup()
  }
})

test('the recording is readable only by the current user', async () => {
  const { path, dir } = await record({ responses: [fauxText('hi')] }, ['hello'])
  try {
    expect(statSync(path).mode & 0o777).toBe(0o600)
  } finally {
    dir.cleanup()
  }
})
