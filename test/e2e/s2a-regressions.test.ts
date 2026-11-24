import { afterEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import z from 'zod'
import {
  createLocalExecutionEnv,
  createVela,
  loadModels,
  type VelaExtension,
  web,
} from '../../packages/vela/src/driver/index.ts'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '../../packages/vela/src/testing/core/index.ts'
import { responsesReply } from '../support/responses.ts'
import { cleanupTestVelas, createTestVela, tempDir } from '../support/vela.ts'

afterEach(cleanupTestVelas)

test('explicit maxOutputTokens and OpenAI promptCacheKey reach provider requests', async () => {
  const dir = tempDir('vela-s2a-provider-opts-')
  const originalFetch = globalThis.fetch
  const requests: Record<string, unknown>[] = []
  try {
    writeFileSync(
      join(dir.path, 'config.json'),
      JSON.stringify({
        providers: {
          openai: {
            api: 'openai-responses',
            baseUrl: 'https://example.test/v1',
            apiKey: 'test',
            models: [{ id: 'gpt-test', maxTokens: 2048 }],
          },
        },
      }),
    )
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      requests.push(body)
      return responsesReply(body)
    }) as typeof fetch

    const providers = loadModels({ agentDir: dir.path })
    const t = createTestVela({
      model: 'openai/gpt-test',
      providers,
    })
    await t.vela.session('cache-session-123').prompt('hello')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.max_output_tokens).toBe(2048)
    expect(requests[0]?.prompt_cache_key).toBe('cache-session-123')
  } finally {
    globalThis.fetch = originalFetch
    dir.cleanup()
  }
})

test('Anthropic HTTP 200 model_context_window_exceeded triggers overflow recovery', async () => {
  const faux = createFauxModel({ responses: [fauxText('ignored')] })
  const original = faux.doStream.bind(faux)
  faux.doStream = async (options) => {
    const result = await original(options)
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream<
          LanguageModelV4StreamPart,
          LanguageModelV4StreamPart
        >({
          transform(part, controller) {
            if (part.type === 'finish') {
              controller.enqueue({
                ...part,
                finishReason: {
                  unified: 'length',
                  raw: 'model_context_window_exceeded',
                },
              })
              return
            }
            controller.enqueue(part)
          },
        }),
      ),
    }
  }
  const t = createTestVela({ model: faux })
  await expect(t.run('hi')).rejects.toThrow('model_context_window_exceeded')
})

test('tool_result hooks run on tool throws with isError:true and transform error text', async () => {
  const hookEvents: Array<{ toolName: string; isError: boolean }> = []
  const boom: VelaExtension = function boom(vela) {
    vela.registerTool({
      name: 'boom',
      description: 'always throws',
      inputSchema: z.object({}),
      execute: async () => {
        throw new Error('raw failure')
      },
    })
    vela.on('tool_result', (event) => {
      hookEvents.push({
        toolName: event.toolName,
        isError: Boolean(event.isError),
      })
      return { output: `intercepted: ${event.output}` }
    })
  }
  const t = createTestVela({
    extensions: [boom],
    responses: [fauxToolCall('boom', {}), fauxText('handled')],
  })
  await t.run('trigger boom')
  expect(hookEvents).toEqual([{ toolName: 'boom', isError: true }])
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain(
    'intercepted: raw failure',
  )
})

test('unscoped tool_call hook still preserves hosted web_search tool in requests', async () => {
  const dir = tempDir('vela-s2a-unscoped-hook-')
  const originalFetch = globalThis.fetch
  const requests: Record<string, unknown>[] = []
  try {
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      requests.push(body)
      return responsesReply(body)
    }) as typeof fetch

    const providers = loadModels({
      agentDir: dir.path,
      env: { OPENAI_API_KEY: 'test' },
    })
    const observe: VelaExtension = function observe(vela) {
      // Global unscoped tool_call observer must not hide provider-hosted web_search
      vela.on('tool_call', () => {})
    }
    const t = createTestVela({
      model: 'openai/gpt-5.5',
      providers,
      extensions: [web(), observe],
    })
    await t.run('search something')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.tools).toContainEqual(
      expect.objectContaining({ type: 'web_search' }),
    )
  } finally {
    globalThis.fetch = originalFetch
    dir.cleanup()
  }
})

test('ctx.requireEnv() resolves ExecutionEnv lazily once and only when requested', async () => {
  const dir = tempDir('vela-s2a-lazy-env-')
  let resolveCount = 0
  let resolvesBeforePureTool = -1
  let resolvesAfterPureTool = -1
  let noEnvResult = ''
  let withEnvSame = false
  const envExt: VelaExtension = function envExt(vela) {
    vela.registerTool({
      name: 'pure_calc',
      description: 'no env needed',
      inputSchema: z.object({}),
      execute: async () => {
        noEnvResult = 'computed'
        return noEnvResult
      },
    })
    vela.registerTool({
      name: 'needs_env',
      description: 'calls requireEnv twice',
      inputSchema: z.object({}),
      execute: async (_input, ctx) => {
        const e1 = await ctx?.requireEnv?.()
        const e2 = await ctx?.requireEnv?.()
        withEnvSame = Boolean(e1 && e1 === e2)
        return 'env-ok'
      },
    })
  }
  const model = createFauxModel({
    responses: [
      () => {
        resolvesBeforePureTool = resolveCount
        return fauxToolCall('envExt_pure_calc', {})
      },
      () => {
        resolvesAfterPureTool = resolveCount
        return fauxToolCall('envExt_needs_env', {})
      },
      fauxText('done'),
    ],
  })
  const vela = createVela({
    cwd: dir.path,
    model,
    extensions: [envExt],
    env: ({ location }) => {
      resolveCount++
      return createLocalExecutionEnv({ cwd: location.cwd })
    },
  })
  try {
    await vela.session('lazy-env').prompt('run pure tool then env tool')
    expect(noEnvResult).toBe('computed')
    expect(resolvesBeforePureTool).toBeGreaterThanOrEqual(1)
    expect(resolvesAfterPureTool).toBe(resolvesBeforePureTool)
    expect(withEnvSame).toBe(true)
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})
