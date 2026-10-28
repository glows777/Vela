import { expect, test } from 'bun:test'
import { StepMessage } from '../../../src/agent/step.ts'

test('an interrupted message is kept as plain text and whole tool calls, without provider metadata', () => {
  const step = new StepMessage(() => {})
  const itemId = { openai: { itemId: 'rs_1' } }
  step.thinkingStart('r', itemId)
  step.thinkingDelta('r', 'plan')
  step.thinkingEnd('r', itemId)
  step.textStart('t', { openai: { itemId: 'msg_1' } })
  step.textDelta('t', 'Let me check')
  step.toolCallEnd({
    toolCallId: 'c1',
    toolName: 'read_file',
    input: { path: 'a' },
    providerMetadata: { openai: { itemId: 'fc_1' } },
  })
  step.toolCallStart('c2', 'bash')
  step.endInterrupted('aborted', 'Operation aborted')

  // Half-written reasoning and calls are dropped; what is kept carries no item ids of the interrupted response
  expect(step.snapshot({ complete: false }).content).toEqual([
    { type: 'text', text: 'Let me check' },
    {
      type: 'tool-call',
      toolCallId: 'c1',
      toolName: 'read_file',
      input: { path: 'a' },
    },
  ])
  // A complete message keeps its metadata (reasoning signatures, item ids)
  expect(step.snapshot().content[1]).toEqual({
    type: 'text',
    text: 'Let me check',
    providerOptions: { openai: { itemId: 'msg_1' } },
  })
})
