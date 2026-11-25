import { describe, expect, test } from 'bun:test'
import { currentStage } from '../src/renderer/session/progress.ts'

describe('what a running session is doing right now', () => {
  test('a tool shows its name only while it runs', () => {
    expect(
      currentStage({ stage: 'tool', tool: 'bash', state: 'started' }),
    ).toBe('bash')
    // The run went on: the name of a finished call is history, not the current stage
    expect(
      currentStage({ stage: 'tool', tool: 'bash', state: 'finished' }),
    ).toBeUndefined()
    expect(
      currentStage({ stage: 'tool', tool: 'bash', state: 'failed' }),
    ).toBeUndefined()
  })

  test('a retry ends with its own event', () => {
    expect(currentStage({ stage: 'retry', state: 'started' })).toBe('Retrying')
    expect(currentStage({ stage: 'retry', state: 'finished' })).toBeUndefined()
  })

  test('compaction and the stages nobody reported show nothing', () => {
    expect(
      currentStage({ stage: 'compaction', state: 'started' }),
    ).toBeUndefined()
    expect(currentStage(undefined)).toBeUndefined()
  })
})
