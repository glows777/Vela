import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { SessionStore } from '../session'
import { TokenTracker } from '../usage/tracker'
import { createRequestSnapshot } from './request'
import { summarize } from './compressor'

const dir = mkdtempSync(join(tmpdir(), 'vela-summary-integrity-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const history = (): ModelMessage[] => [
  { role: 'user', content: '检查 alpha 与 beta，保留 beta 失败原因。' },
  {
    role: 'assistant',
    content: 'alpha exit 0; beta exit 7: validation failed.',
  },
  ...Array.from(
    { length: 6 },
    (_, i): ModelMessage => ({
      role: 'user',
      content:
        i === 5 ? 'LIVE_ONLY_MARKER：请仅回复摘要准备完成。' : `recent-${i}`,
    }),
  ),
]

test('literal acknowledgement cannot replace historical context', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: '摘要准备完成。' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  })
  const messages = history()
  const before = JSON.stringify(messages)
  await expect(
    summarize(
      await createRequestSnapshot(model, '普通执行 Agent', {}, messages),
      new SessionStore('ack', dir).results,
      new TokenTracker(),
    ),
  ).rejects.toThrow()
  expect(JSON.stringify(messages)).toBe(before)
})

test('summarizer sees only the removed prefix under dedicated instructions, never the pending task', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            sourceMessageCount: 2,
            goal: '检查 alpha/beta',
            completed: ['alpha exit 0', 'beta exit 7'],
            pending: ['解释 beta 失败'],
            constraints: [],
            details: ['validation failed'],
          }),
        },
      ],
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  })
  const messages = history()
  const result = await summarize(
    await createRequestSnapshot(model, '普通执行 Agent', {}, messages),
    new SessionStore('isolated', dir).results,
    new TokenTracker(),
  )
  const request = model.doGenerateCalls[0]!
  expect(JSON.stringify(request.prompt)).not.toContain('LIVE_ONLY_MARKER')
  expect(JSON.stringify(request.prompt)).toContain('validation failed')
  expect(request.tools?.length ?? 0).toBe(0)
  expect(result.messages.slice(1)).toEqual(messages.slice(2))
  expect(result.summary).toContain('beta exit 7')
})
