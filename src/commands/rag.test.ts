import { afterEach, expect, spyOn, test } from 'bun:test'
import { createTestFixture, type TestFixture } from '../testing/harness'
import { ragCommands } from './rag'
import z from 'zod'

let fixtures: TestFixture[] = []
afterEach(() => {
  for (const f of fixtures) f.cleanup()
  fixtures = []
})

function fixture(): TestFixture {
  const f = createTestFixture({ commands: ragCommands })
  fixtures.push(f)
  return f
}

test('/rag 显示知识库规模（空库为 0）', () => {
  const f = fixture()
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    expect(f.dispatch('/rag', f.ctx)).toBe(true)
    expect(log.mock.calls.flat().join('\n')).toContain('0 个片段')
  } finally {
    log.mockRestore()
  }
})

test('ingest <path> 走工具执行并回台结束后再次 ask', async () => {
  const f = fixture()
  f.ctx.registry.register({
    name: 'rag_ingest',
    description: '导入文档',
    inputSchema: {},
    execute: async ({ path: p }: { path: string }) => `已导入 ${p}`,
  })

  const log = spyOn(console, 'log').mockImplementation(() => {})
  let result: boolean | 'async'
  try {
    result = f.dispatch('ingest docs/a.md', f.ctx)
    expect(result).toBe('async')
    expect(log.mock.calls.flat().join('\n')).toContain('正在处理 docs/a.md')

    const start = Date.now()
    while (f.askCount() === 0) {
      if (Date.now() - start > 5000) throw new Error('ingest 未在超时内完成')
      await Bun.sleep(50)
    }
    expect(log.mock.calls.flat().join('\n')).toContain('已导入 docs/a.md')
  } finally {
    log.mockRestore()
  }
})

test('manual ingest exposes a cancellation controller and releases the busy state after abort', async () => {
  const f = fixture()
  let signal: AbortSignal | undefined
  f.ctx.registry.register({
    name: 'rag_ingest',
    description: 'ingest',
    inputSchema: z.object({ path: z.string() }),
    execute: async (_input, context) =>
      new Promise((_resolve, reject) => {
        signal = context?.signal
        signal?.addEventListener('abort', () => reject(signal?.reason), {
          once: true,
        })
      }),
  })
  expect(f.dispatch('ingest fixture.txt', f.ctx)).toBe('async')
  expect(f.ctx.busy.locked).toBe(true)
  f.ctx.busy.controller?.abort(new Error('cancel import'))
  for (let i = 0; i < 20 && !f.askCount(); i++) await Bun.sleep(5)
  expect(signal?.aborted).toBe(true)
  expect(f.ctx.busy.locked).toBe(false)
  expect(f.ctx.busy.controller).toBeUndefined()
  expect(f.askCount()).toBe(1)
})
