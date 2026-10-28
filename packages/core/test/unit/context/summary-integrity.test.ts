import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelMessage } from 'ai'
import { summarize } from '../../../src/context/compressor.ts'
import { createRequestSnapshot } from '../../../src/context/request.ts'
import { SessionStore } from '../../../src/session/index.ts'
import { createFauxModel, fauxText } from '../../../src/testing/faux.ts'
import { TokenTracker } from '../../../src/usage/tracker.ts'

const dir = mkdtempSync(join(tmpdir(), 'vela-summary-integrity-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const history = (): ModelMessage[] => [
  {
    role: 'user',
    content: 'Check alpha and beta, keep the reason beta failed.',
  },
  {
    role: 'assistant',
    content: 'alpha exit 0; beta exit 7: validation failed.',
  },
  ...Array.from(
    { length: 6 },
    (_, i): ModelMessage => ({
      role: 'user',
      content:
        i === 5
          ? 'LIVE_ONLY_MARKER: reply only that the summary is ready.'
          : `recent-${i}`,
    }),
  ),
]

test('summary sends only the dropped messages, under an explicit compaction scope', async () => {
  const model = createFauxModel({
    responses: [
      fauxText(
        '## Goal\nCheck alpha and beta.\n\n## Progress\n### Blocked\n- beta exit 7\n\n## Next Steps\n1. Repair validation.',
      ),
    ],
  })
  const messages = history()
  const result = await summarize(
    await createRequestSnapshot(model, 'Regular execution agent', {}, messages),
    new SessionStore('isolated', dir),
    new TokenTracker(),
  )
  const request = model.calls[0]!
  // System prompt, the dropped messages as text, and the control message; the retained messages stay out
  expect(request.prompt).toHaveLength(3)
  expect(JSON.stringify(request.prompt)).not.toContain('LIVE_ONLY_MARKER')
  const last = request.prompt.at(-1)
  const part =
    last?.role === 'user'
      ? last.content.find((part) => part.type === 'text')
      : undefined
  const control = JSON.parse(part?.type === 'text' ? part.text : '{}')
  expect(control.type).toBe('context_compaction')
  expect(control.sourceMessageCount).toBe(2)
  expect(control.retainedMessageCount).toBe(6)
  expect(control.instruction).toContain('Do not run tools')
  expect(control.instruction).toContain('## Progress')
  expect(control.instruction).toContain('## Next Steps')
  expect(control.outputSchema).toBeUndefined()
  expect(request.responseFormat?.type).not.toBe('json')
  // The old messages are numbered in place, so their text is sent once
  const conversation = JSON.stringify(request.prompt[1])
  expect(conversation).toContain('[0] user\\nCheck alpha and beta')
  expect(conversation).toContain('[1] assistant\\nalpha exit 0')
  expect(conversation).not.toContain('[2]')
  expect(conversation.match(/Check alpha and beta/g)).toHaveLength(1)
  expect(JSON.stringify(request.prompt)).toContain('validation failed')
  expect(request.tools).toEqual([])
  expect(result.messages.slice(1)).toEqual(messages.slice(2))
  expect(result.summary).toContain('beta exit 7')
})

test('an incomplete text summary fails closed and records usage', async () => {
  const model = createFauxModel({
    responses: [
      fauxText('## Goal\nCheck alpha', {
        finishReason: 'length',
        usage: { input: 10, cacheRead: 8, cacheWrite: 0, output: 5 },
      }),
    ],
  })
  const tracker = new TokenTracker()
  const messages = history()
  const before = JSON.stringify(messages)
  await expect(
    summarize(
      await createRequestSnapshot(model, 'stable', {}, messages),
      new SessionStore('partial', dir),
      tracker,
    ),
  ).rejects.toThrow('not fully generated')
  expect(tracker.recent(1)[0]).toMatchObject({
    kind: 'summary',
    cacheReadTokens: 8,
    outputTokens: 5,
  })
  expect(JSON.stringify(messages)).toBe(before)
})
