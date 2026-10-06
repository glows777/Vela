import { expect, test } from 'bun:test'
import {
  recordToolCall,
  recordToolCallResult,
  resetHistory,
} from '../../../src/agent/loop-detection'

test('matches parallel tool results by toolCallId', () => {
  resetHistory()

  const input = { path: 'same' }
  recordToolCall('call-a', 'read_file', input)
  recordToolCall('call-b', 'read_file', input)

  expect(recordToolCallResult('call-b', 'read_file', input, 'result-b')).toBe(
    true,
  )
  expect(recordToolCallResult('call-a', 'read_file', input, 'result-a')).toBe(
    true,
  )
  expect(recordToolCallResult('call-b', 'read_file', input, 'duplicate')).toBe(
    false,
  )

  resetHistory()
})
