import { expect, test } from 'bun:test'
import {
  createRequestSnapshot,
  estimateRequestTokens,
} from '../../../../src/driver/context/request.ts'
import type { ModelMessage } from '../../../../src/driver/index.ts'
import { estimateMessageTokens } from '../../../../src/driver/usage/tracker.ts'
import { toAiModelMessages } from '../../../../src/providers/index.ts'
import { createFauxModel } from '../../../../src/testing/core/faux.ts'

const EMPTY_TOOLS = { sdkTools: {}, toolDefinitions: [], hasHostedTools: false }

test('each image counts as 1200 tokens, independent of base64 length', async () => {
  const messages = (data: string): ModelMessage[] => [
    { role: 'user', content: [{ type: 'image', data, mimeType: 'image/png' }] },
  ]
  const small = messages('AAAA')
  const large = messages('A'.repeat(2_000_000))
  expect(estimateMessageTokens(small)).toBeGreaterThanOrEqual(1200)
  expect(estimateMessageTokens(small)).toBeLessThan(1260)
  expect(estimateMessageTokens(large)).toBe(estimateMessageTokens(small))
  const request = createRequestSnapshot(
    createFauxModel(),
    '',
    EMPTY_TOOLS,
    small,
  )
  expect(estimateRequestTokens(request, small)).toBe(
    estimateRequestTokens(request, large),
  )
  expect(estimateRequestTokens(request)).toBeGreaterThanOrEqual(1200)
  expect(estimateRequestTokens(request)).toBeLessThan(1260)
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
        { type: 'tool_call', toolName: 'picture', toolCallId: '1', input: {} },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          toolName: 'picture',
          toolCallId: '1',
          output: {
            type: 'content',
            value: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
          },
        },
      ],
    },
  ]
  const before = JSON.stringify(messages)
  const wire = toAiModelMessages(messages, false)
  expect(JSON.stringify(wire)).toContain(
    '(image omitted: model does not support images)',
  )
  expect(JSON.stringify(wire)).toContain(
    '(tool image omitted: model does not support images)',
  )
  expect(JSON.stringify(wire)).not.toContain('AAAA')
  expect(JSON.stringify(messages)).toBe(before)
})
