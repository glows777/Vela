import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { agentLoop } from '../../../../src/driver/agent/index.ts'
import type { ModelMessage } from '../../../../src/driver/messages.ts'
import { ToolResultStore } from '../../../../src/driver/session/tool-results.ts'
import { ToolRegistry } from '../../../../src/driver/tools/registry.ts'
import { TokenTracker } from '../../../../src/driver/usage/tracker.ts'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '../../../../src/testing/core/faux.ts'

const dir = mkdtempSync(join(tmpdir(), 'vela-agent-checkpoint-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// These tests do not assert on persistence, so their tool history goes to a temp directory.
function makeRegistry() {
  return new ToolRegistry(
    new ToolResultStore(join(dir, crypto.randomUUID(), 'tool-results')),
  )
}

test('the complete assistant checkpoint is awaited before any tool side effect, and added only once', async () => {
  let flushed = false
  let executions = 0
  const messages: ModelMessage[] = [{ role: 'user', content: 'work' }]
  const registry = makeRegistry()
  registry.register({
    name: 'write',
    description: 'write marker',
    inputSchema: z.object({}),
    execute: async () => {
      expect(flushed).toBe(true)
      expect(messages.at(-1)?.role).toBe('assistant')
      executions++
      return 'saved'
    },
  })
  await agentLoop({
    model: createFauxModel({
      responses: [fauxToolCall('write', {}), fauxText('done')],
    }),
    systemPrompt: '',
    toolRegistry: registry,
    messages,
    tokenTracker: new TokenTracker(),
    onCheckpoint: async () => {
      expect(JSON.stringify(messages.at(-1))).toContain('write')
      await Bun.sleep(10)
      expect(executions).toBe(0)
      flushed = true
    },
  })
  expect(executions).toBe(1)
  expect(messages.map((message) => message.role)).toEqual([
    'user',
    'assistant',
    'tool',
    'assistant',
  ])
})

test('a rejected checkpoint never executes a tool or resends the model request', async () => {
  let executions = 0
  const registry = makeRegistry()
  registry.register({
    name: 'write',
    description: 'write marker',
    inputSchema: z.object({}),
    execute: async () => {
      executions++
      return 'saved'
    },
  })
  const model = createFauxModel({ responses: [fauxToolCall('write', {})] })
  await expect(
    agentLoop({
      model,
      systemPrompt: '',
      toolRegistry: registry,
      messages: [{ role: 'user', content: 'work' }],
      tokenTracker: new TokenTracker(),
      onCheckpoint: async () => {
        throw new Error('checkpoint disk unavailable')
      },
    }),
  ).rejects.toThrow('checkpoint disk unavailable')
  expect(executions).toBe(0)
  expect(model.calls).toHaveLength(1)
})

test('cancellation after a checkpoint answers its calls without duplicating the assistant', async () => {
  const controller = new AbortController()
  const registry = makeRegistry()
  registry.register({
    name: 'wait',
    description: 'wait',
    inputSchema: z.object({}),
    execute: async () => {
      controller.abort(new Error('stop after checkpoint'))
      return 'stopped'
    },
  })
  const messages: ModelMessage[] = [{ role: 'user', content: 'work' }]
  await expect(
    agentLoop({
      model: createFauxModel({ responses: [fauxToolCall('wait', {})] }),
      systemPrompt: '',
      toolRegistry: registry,
      messages,
      tokenTracker: new TokenTracker(),
      abortSignal: controller.signal,
      onCheckpoint: async () => {},
    }),
  ).rejects.toThrow('stop after checkpoint')
  expect(messages.map((message) => message.role)).toEqual([
    'user',
    'assistant',
    'tool',
  ])
  expect(JSON.stringify(messages.at(-1))).toContain('Operation aborted')
})
