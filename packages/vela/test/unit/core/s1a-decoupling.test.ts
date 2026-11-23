import { expect, test } from 'bun:test'
import z from 'zod'
import {
  fromAiResponseMessage,
  toAiModelMessages,
} from '../../../src/providers/messages.ts'
import type { ChannelAdapter } from '../../../src/runtime/channels.ts'
import type {
  RuntimeEvent,
  StreamDeltaEvent,
} from '../../../src/runtime/events.ts'
import {
  normalizeVelaMessage,
  type VelaMessage,
} from '../../../src/shared/messages.ts'
import {
  createJsonSchema,
  toJsonSchema,
  validateToolInput,
} from '../../../src/shared/tool-schema.ts'

test('VelaMessage converts to AI SDK wire format and back cleanly', () => {
  const history: VelaMessage[] = [
    { role: 'user', content: 'Check a.ts' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', text: 'Inspecting file' },
        { type: 'text', text: 'Reading now.' },
        {
          type: 'tool_call',
          toolCallId: 'c1',
          toolName: 'read_file',
          input: { path: 'a.ts' },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          toolCallId: 'c1',
          toolName: 'read_file',
          output: { type: 'text', value: 'const x = 1' },
        },
      ],
    },
  ]

  const aiMessages = toAiModelMessages(history)
  expect(aiMessages[1]).toEqual({
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'Inspecting file' },
      { type: 'text', text: 'Reading now.' },
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'read_file',
        input: { path: 'a.ts' },
      },
    ],
  })
  expect(aiMessages[2]).toEqual({
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'read_file',
        output: { type: 'text', value: 'const x = 1' },
      },
    ],
  })

  expect<VelaMessage>(fromAiResponseMessage(aiMessages[1]!)).toEqual(
    history[1]!,
  )
  expect<VelaMessage>(fromAiResponseMessage(aiMessages[2]!)).toEqual(
    history[2]!,
  )
})

test('normalizeVelaMessage migrates legacy AI SDK JSONL part names to canonical VelaPart names', () => {
  const legacyAssistant = {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'thought' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'bash', input: {} },
    ],
  }
  const legacyTool = {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'bash',
        output: { type: 'text', value: 'ok' },
      },
    ],
  }
  expect(normalizeVelaMessage(legacyAssistant)).toEqual({
    role: 'assistant',
    content: [
      { type: 'thinking', text: 'thought' },
      { type: 'tool_call', toolCallId: 'c1', toolName: 'bash', input: {} },
    ],
  })
  expect(normalizeVelaMessage(legacyTool)).toEqual({
    role: 'tool',
    content: [
      {
        type: 'tool_result',
        toolCallId: 'c1',
        toolName: 'bash',
        output: { type: 'text', value: 'ok' },
      },
    ],
  })
})

test('ToolInputSchema converts and validates Zod and JSON Schema without AI SDK', async () => {
  const zodSchema = z.object({ path: z.string().min(1) })
  const zodJson = await toJsonSchema(zodSchema)
  expect(zodJson.type).toBe('object')
  expect(await validateToolInput(zodSchema, { path: 'a.ts' })).toEqual({
    path: 'a.ts',
  })
  await expect(validateToolInput(zodSchema, { path: '' })).rejects.toThrow()

  const mcpSchema = createJsonSchema({
    type: 'object',
    properties: {
      notes: {
        type: 'object',
        propertyNames: { type: 'string', minLength: 1 },
        additionalProperties: { type: 'string' },
      },
    },
    required: ['notes'],
    additionalProperties: false,
  })
  expect((await toJsonSchema(mcpSchema)).type).toBe('object')
  expect(await validateToolInput(mcpSchema, { notes: { ok: 'yes' } })).toEqual({
    notes: { ok: 'yes' },
  })
  await expect(
    validateToolInput(mcpSchema, { notes: { '': 'bad' } }),
  ).rejects.toThrow()
})

test('RuntimeEvent(seq), StreamDeltaEvent, and ChannelAdapter contracts are structurally sound', () => {
  const persisted: RuntimeEvent = {
    seq: 1,
    sessionId: 's1',
    projectId: 'p1',
    timestamp: '2026-11-23T00:00:00.000Z',
    type: 'run_started',
    runId: 'r1',
    trigger: 'user',
  }
  const delta: StreamDeltaEvent = {
    type: 'thinking_delta',
    sessionId: 's1',
    runId: 'r1',
    contentIndex: 0,
    delta: 'step 1',
  }
  const adapter: ChannelAdapter = {
    name: 'test-channel',
    async start() {},
    async stop() {},
    async deliver() {
      return { externalMessageId: 'm1' }
    },
  }
  expect(persisted.seq).toBe(1)
  expect(delta.type).toBe('thinking_delta')
  expect(adapter.name).toBe('test-channel')
})
