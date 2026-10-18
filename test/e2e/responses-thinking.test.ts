import { afterEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadModels } from '../../src/config/models.ts'
import type { ModelSpec, ThinkingLevel } from '../../src/models/index.ts'
import { responsesReply } from '../support/responses.ts'
import { cleanupTestVelas, createTestVela, tempDir } from '../support/vela.ts'

const realFetch = globalThis.fetch
const dirs: { cleanup(): void }[] = []
afterEach(async () => {
  await cleanupTestVelas()
  globalThis.fetch = realFetch
  for (const dir of dirs.splice(0)) dir.cleanup()
})

function fixture(models?: ModelSpec[]) {
  const dir = tempDir('vela-thinking-')
  dirs.push(dir)
  writeFileSync(
    join(dir.path, 'models.json'),
    JSON.stringify({
      providers: {
        compat: {
          api: 'openai-responses',
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'test',
          models,
        },
      },
    }),
  )
  const requests: {
    reasoning?: { effort?: string }
    store?: boolean
    include?: string[]
    input: { role?: string }[]
  }[] = []
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    requests.push(body)
    return responsesReply(body)
  }) as typeof fetch
  return {
    cwd: dir.path,
    providers: loadModels({ agentDir: dir.path }),
    requests,
  }
}

test.each(['high', 'max', 'off'] as ThinkingLevel[])(
  'session thinking %s survives actual SDK serialization for a catalog model',
  async (thinkingLevel) => {
    const f = fixture()
    const t = createTestVela({
      ...f,
      model: 'compat/deepseek-flash',
      thinkingLevel,
    })
    await t.run('Answer OK')
    expect(t.lastAssistantText()).toBe('OK')
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]?.reasoning?.effort).toBe(
      thinkingLevel === 'off' ? 'none' : thinkingLevel,
    )
    expect(f.requests[0]?.input[0]?.role).toBe('system')
    expect(f.requests[0]?.store).toBe(false)
    expect(f.requests[0]?.include).toContain('reasoning.encrypted_content')
  },
)

test('stock medium is clamped to high before serialization', async () => {
  const f = fixture()
  const t = createTestVela({ ...f, model: 'compat/deepseek-flash' })
  expect(t.session.thinkingLevel).toBe('high')
  await t.run('Answer OK')
  expect(f.requests[0]?.reasoning?.effort).toBe('high')
})

test('custom medium mapping and resumed model/level reach the wire', async () => {
  const f = fixture([
    {
      id: 'deepseek-flash',
      thinkingLevelMap: { medium: 'medium', max: 'max' },
    },
  ])
  const first = createTestVela({ ...f, model: 'compat/deepseek-flash' })
  expect(first.session.thinkingLevel).toBe('medium')
  await first.run('Save medium')
  await first.cleanup()
  const again = createTestVela({
    ...f,
    model: 'compat/other',
    thinkingLevel: 'off',
  })
  expect(await again.session.resume()).toBe(true)
  expect(again.session.modelInfo.ref).toBe('compat/deepseek-flash')
  expect(again.session.thinkingLevel).toBe('medium')
  await again.run('Continue')
  expect(f.requests.map((r) => r.reasoning?.effort)).toEqual([
    'medium',
    'medium',
  ])
})
