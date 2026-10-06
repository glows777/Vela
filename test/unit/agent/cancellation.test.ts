import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'zod'
import { ToolRegistry } from '../../../src/tools/registry'
import { ToolResultStore } from '../../../src/session/tool-results'
import { TokenTracker } from '../../../src/usage/tracker'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '../../../src/testing/faux'
import { agentLoop } from '../../../src/agent/index'

const dir = mkdtempSync(join(tmpdir(), 'vela-agent-cancel-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('agent cancellation reaches the tool, waits for its durable result, and never starts another model step', async () => {
  const registry = new ToolRegistry(new ToolResultStore(join(dir, 'outputs')))
  const controller = new AbortController()
  let receivedSignal = false
  registry.register({
    name: 'wait',
    description: 'wait',
    inputSchema: z.object({}),
    execute: async (_input, context) => {
      receivedSignal = !!context?.signal
      return new Promise<string>((resolve) => {
        const fallback = setTimeout(() => resolve('not cancelled'), 300)
        context?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(fallback)
            resolve('cancelled tool output')
          },
          { once: true },
        )
        controller.abort(new Error('test cancellation'))
      })
    },
  })
  const model = createFauxModel({
    responses: [fauxToolCall('wait', {}), fauxText('done')],
  })
  await expect(
    agentLoop({
      model,
      systemPrompt: '',
      toolRegistry: registry,
      messages: [{ role: 'user', content: 'wait' }],
      tokenTracker: new TokenTracker(),
      abortSignal: controller.signal,
    }),
  ).rejects.toThrow('test cancellation')
  expect(receivedSignal).toBe(true)
  expect(model.calls).toHaveLength(1)
  const rows = (await Bun.file(registry.results.indexPath).text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(rows).toHaveLength(2)
  expect(rows[1]).toMatchObject({
    status: 'cancelled',
    output: 'cancelled tool output',
  })
})


test('the main request refreshes the history guide after context preparation', async () => {
  let instructions = 'OLD_LIVE_PATH'
  const model = createFauxModel({
    responses: [
      (req) => {
        expect(req.system).toContain('NEW_FROZEN_PATH')
        expect(req.system).not.toContain('OLD_LIVE_PATH')
        return fauxText('done')
      },
    ],
  })
  await agentLoop({
    model,
    systemPrompt: () => instructions,
    toolRegistry: new ToolRegistry(),
    messages: [{ role: 'user', content: 'check' }],
    tokenTracker: new TokenTracker(),
    prepareContext: async () => {
      instructions = 'NEW_FROZEN_PATH'
    },
  })
  expect(model.calls).toHaveLength(1)
})
