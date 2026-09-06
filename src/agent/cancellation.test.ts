import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'zod'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { ToolRegistry } from '../tools/registry'
import { ToolResultStore } from '../session/tool-results'
import { TokenTracker } from '../usage/tracker'
import { agentLoop } from './index'
import { sleep } from './retry'

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
  let calls = 0
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls++
      const finish = {
        type: 'finish' as const,
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      }
      const first = [
        { type: 'stream-start' as const, warnings: [] },
        {
          type: 'tool-call' as const,
          toolCallId: 'wait',
          toolName: 'wait',
          input: '{}',
        },
        {
          ...finish,
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
        },
      ]
      const second = [
        { type: 'stream-start' as const, warnings: [] },
        { type: 'text-start' as const, id: 't' },
        { type: 'text-delta' as const, id: 't', delta: 'done' },
        { type: 'text-end' as const, id: 't' },
        finish,
      ]
      return {
        stream: simulateReadableStream<
          (typeof first)[number] | (typeof second)[number]
        >({ chunks: calls === 1 ? first : second }),
      }
    },
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
  expect(calls).toBe(1)
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

test('retry backoff is abortable', async () => {
  const controller = new AbortController()
  const waiting = sleep(30000, controller.signal)
  controller.abort(new Error('cancel retry'))
  await expect(waiting).rejects.toThrow('cancel retry')
})

test('the main request refreshes the history guide after context preparation', async () => {
  let instructions = 'OLD_LIVE_PATH'
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      expect(JSON.stringify(prompt)).toContain('NEW_FROZEN_PATH')
      expect(JSON.stringify(prompt)).not.toContain('OLD_LIVE_PATH')
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start' as const, warnings: [] },
            { type: 'text-start' as const, id: 't' },
            { type: 'text-delta' as const, id: 't', delta: 'done' },
            { type: 'text-end' as const, id: 't' },
            {
              type: 'finish' as const,
              finishReason: { unified: 'stop' as const, raw: undefined },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ],
        }),
      }
    },
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
})
