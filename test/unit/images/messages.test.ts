import { expect, test } from 'bun:test'
import {
  createRequestSnapshot,
  estimateRequestTokens,
} from '../../../src/context/request.ts'
import type { ModelMessage } from '../../../src/messages.ts'
import { toModelMessages } from '../../../src/messages.ts'
import { createFauxModel } from '../../../src/testing/faux.ts'
import { estimateMessageTokens } from '../../../src/usage/tracker.ts'

test('each image counts as 4800 characters, independent of base64 length', async () => {
  const messages = (data: string): ModelMessage[] => [
    { role: 'user', content: [{ type: 'image', data, mimeType: 'image/png' }] },
  ]
  const small = messages('AAAA')
  const large = messages('A'.repeat(2_000_000))
  expect(estimateMessageTokens(small)).toBe(1440)
  expect(estimateMessageTokens(large)).toBe(1440)
  const request = await createRequestSnapshot(createFauxModel(), '', {}, small)
  expect(estimateRequestTokens(request, small)).toBe(
    estimateRequestTokens(request, large),
  )
  expect(estimateRequestTokens(request)).toBeGreaterThanOrEqual(1440)
  expect(estimateRequestTokens(request)).toBeLessThan(1500)
})

test('request-only non-vision fallback covers user and tool images without changing history', async () => {
  const messages: ModelMessage[] = [
    {
      role: 'user',
      content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
    },
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolName: 'picture', toolCallId: '1', input: {} },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolName: 'picture',
          toolCallId: '1',
          output: {
            type: 'content',
            value: [
              { type: 'image-data', data: 'AAAA', mediaType: 'image/png' },
            ],
          },
        },
      ],
    },
  ]
  const before = JSON.stringify(messages)
  const wire = await toModelMessages(messages, false)
  expect(JSON.stringify(wire)).toContain(
    '(image omitted: model does not support images)',
  )
  expect(JSON.stringify(wire)).toContain(
    '(tool image omitted: model does not support images)',
  )
  expect(JSON.stringify(wire)).not.toContain('AAAA')
  expect(JSON.stringify(messages)).toBe(before)
})
