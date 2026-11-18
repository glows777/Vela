import { expect, test } from 'bun:test'
import { z } from 'zod'
import type { VelaEvent } from '../../../src/agent/events.ts'
import { agentLoop } from '../../../src/agent/index.ts'
import type { ModelMessage } from '../../../src/messages.ts'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '../../../src/testing/faux.ts'
import { ToolRegistry } from '../../../src/tools/registry.ts'
import { TokenTracker } from '../../../src/usage/tracker.ts'

test('drain lets an active tool finish, keeps its real output, and starts no next request or queued input', async () => {
  let draining = false
  let queued = 0
  const events: VelaEvent[] = []
  const messages: ModelMessage[] = [{ role: 'user', content: 'work' }]
  const registry = new ToolRegistry()
  registry.register({
    name: 'work',
    description: 'work',
    inputSchema: z.object({}),
    execute: async (_, context) => {
      draining = true
      await Bun.sleep(10)
      expect(context?.signal?.aborted).not.toBe(true)
      return 'actual completed output'
    },
  })
  const model = createFauxModel({
    responses: [fauxToolCall('work', {}), fauxText('must not run')],
  })
  await expect(
    agentLoop({
      model,
      systemPrompt: '',
      toolRegistry: registry,
      messages,
      tokenTracker: new TokenTracker(),
      isDraining: () => draining,
      onEvent: (event) => events.push(event),
      takeSteering: () => {
        queued++
        return []
      },
    }),
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(model.calls).toHaveLength(1)
  expect(queued).toBe(0)
  expect(JSON.stringify(messages.at(-1))).toContain('actual completed output')
  expect(events.findLast((event) => event.type === 'agent_end')).toMatchObject({
    reason: 'aborted',
  })
})

test('a drain begun during the model response prevents unstarted tools and reports they did not execute', async () => {
  let draining = false
  let executed = false
  const messages: ModelMessage[] = [{ role: 'user', content: 'work' }]
  const registry = new ToolRegistry()
  registry.register({
    name: 'work',
    description: 'work',
    inputSchema: z.object({}),
    execute: async () => {
      executed = true
      return 'wrong'
    },
  })
  await expect(
    agentLoop({
      model: createFauxModel({
        responses: [
          () => {
            draining = true
            return fauxToolCall('work', {})
          },
        ],
      }),
      systemPrompt: '',
      toolRegistry: registry,
      messages,
      tokenTracker: new TokenTracker(),
      isDraining: () => draining,
    }),
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(executed).toBe(false)
  expect(JSON.stringify(messages.at(-1))).toContain(
    'Tool was not executed because the session is shutting down.',
  )
})

test('a completed final answer can finish during drain', async () => {
  let draining = false
  const events: VelaEvent[] = []
  await agentLoop({
    model: createFauxModel({
      responses: [
        () => {
          draining = true
          return fauxText('final answer')
        },
      ],
    }),
    systemPrompt: '',
    toolRegistry: new ToolRegistry(),
    messages: [{ role: 'user', content: 'work' }],
    tokenTracker: new TokenTracker(),
    isDraining: () => draining,
    onEvent: (event) => events.push(event),
  })
  expect(events.findLast((event) => event.type === 'agent_end')).toMatchObject({
    reason: 'done',
  })
})

test('an already draining run does not start a model request', async () => {
  const model = createFauxModel({ responses: [] })
  await expect(
    agentLoop({
      model,
      systemPrompt: '',
      toolRegistry: new ToolRegistry(),
      messages: [],
      tokenTracker: new TokenTracker(),
      isDraining: () => true,
    }),
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(model.calls).toHaveLength(0)
})
