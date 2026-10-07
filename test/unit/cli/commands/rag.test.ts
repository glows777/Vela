import { afterEach, expect, test } from 'bun:test'
import z from 'zod'
import {
  captureConsole,
  cleanupTestVelas,
  createTestVela,
} from '../../../support/vela'

afterEach(cleanupTestVelas)

test('/rag 显示知识库规模（空库为 0）', async () => {
  const t = createTestVela()
  const { result, output } = await captureConsole(() => t.dispatch('/rag'))
  expect(result).toBe(true)
  expect(output).toContain('0 个片段')
})

test('ingest 没有 RAG 工具时提示不可用', async () => {
  const t = createTestVela()
  const { result, output } = await captureConsole(() =>
    t.dispatch('ingest docs/a.md'),
  )
  expect(result).toBe(true)
  expect(output).toContain('rag_ingest 工具不可用')
})

test('ingest <path> 走工具执行，结束后再次 ask', async () => {
  const t = createTestVela()
  t.vela.registry.register({
    name: 'rag_ingest',
    description: '导入文档',
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path }: { path: string }) => `已导入 ${path}`,
  })
  const { result, output } = await captureConsole(() =>
    t.command('ingest docs/a.md'),
  )
  expect(result).toBe('async')
  expect(output).toContain('正在处理 docs/a.md')
  expect(output).toContain('已导入 docs/a.md')
  expect(t.askCount()).toBe(1)
})

test('manual ingest exposes a cancellation controller and releases the busy state after abort', async () => {
  const t = createTestVela()
  let signal: AbortSignal | undefined
  t.vela.registry.register({
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
  await captureConsole(async () => {
    const done = t.command('ingest fixture.txt')
    expect(t.session.busy.locked).toBe(true)
    t.session.busy.controller?.abort(new Error('cancel import'))
    expect(await done).toBe('async')
  })
  expect(signal?.aborted).toBe(true)
  expect(t.session.busy.locked).toBe(false)
  expect(t.session.busy.controller).toBeUndefined()
  expect(t.askCount()).toBe(1)
})
