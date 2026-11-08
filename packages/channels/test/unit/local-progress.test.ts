import { describe, expect, test } from 'bun:test'
import { localProgress } from '../../src/local-events.ts'

describe('Local progress privacy', () => {
  test('projects tool lifecycle without arguments, output, or arbitrary event fields', () => {
    expect(
      localProgress({
        type: 'tool_execution_start',
        toolCallId: 'secret-id',
        toolName: 'read_file',
        args: { path: 'SECRET' },
      }),
    ).toEqual({ stage: 'tool', tool: 'read_file', state: 'started' })
    expect(
      localProgress({
        type: 'tool_execution_end',
        toolCallId: 'secret-id',
        toolName: 'read_file',
        result: 'SECRET',
        details: { secret: true },
        isError: false,
      }),
    ).toEqual({ stage: 'tool', tool: 'read_file', state: 'finished' })
  })
  test('omits raw model messages, thinking, tool updates and error strings', () => {
    expect(
      localProgress({ type: 'agent_start', input: 'SECRET' }),
    ).toBeUndefined()
    expect(
      localProgress({
        type: 'message_end',
        message: { role: 'assistant', content: 'SECRET' },
        errorMessage: 'SECRET',
      }),
    ).toBeUndefined()
    expect(
      localProgress({
        type: 'tool_execution_update',
        toolCallId: 'x',
        toolName: 'bash',
        args: {},
        partialResult: 'SECRET',
      }),
    ).toBeUndefined()
    expect(
      localProgress({
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 10,
        errorMessage: 'SECRET',
      }),
    ).toEqual({ stage: 'retry' })
  })
  test('bounds custom tool names and removes control characters', () => {
    const progress = localProgress({
      type: 'tool_execution_start',
      toolCallId: 'x',
      toolName: '\n'.repeat(90) + 'x'.repeat(90),
      args: {},
    })
    expect(progress?.tool).toBe('x'.repeat(80))
  })
})
