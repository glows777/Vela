import { afterEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import z from 'zod'
import { background } from '../../packages/vela/src/driver/extensions/background/index.ts'
import {
  createLocalExecutionEnv,
  createVela,
  loadModels,
  type VelaExtension,
  web,
} from '../../packages/vela/src/driver/index.ts'
import {
  createFauxModel,
  fauxSummary,
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

test('SDK rejects retired core tool names in session tools and setActiveTools', async () => {
  const t = createTestVela({ responses: [fauxText('ok')] })
  expect(() => t.vela.session('bad', { tools: ['-write_file'] })).toThrow(
    'docs/upgrading.md',
  )
  expect(() => t.vela.session('bad2', { tools: ['read_file'] })).toThrow(
    'renamed to "read"',
  )
  expect(() => t.session.setActiveTools(['edit_file'])).toThrow(
    'renamed to "edit"',
  )
  await t.run('unused check')
})

test('HTTP 200 model_context_window_exceeded compacts once within the same turn and stops on repeat overflow', async () => {
  const wrapOverflow200 = (
    faux: ReturnType<typeof createFauxModel>,
    count: number,
  ) => {
    const original = faux.doStream.bind(faux)
    let seen = 0
    faux.doStream = async (options) => {
      const result = await original(options)
      const isOverflow = ++seen <= count
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream<
            LanguageModelV4StreamPart,
            LanguageModelV4StreamPart
          >({
            transform(part, controller) {
              if (isOverflow && part.type === 'finish') {
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
  }

  // Case A: one HTTP-200 overflow compacts and recovers in the SAME turn (1 turn_start, 2 usages)
  const fauxOk = createFauxModel({
    responses: [
      ...Array.from({ length: 5 }, (_, i) => fauxText(`seed ${i}`)),
      fauxText('first overflowing attempt'),
      fauxText('recovered inside same turn'),
    ],
    generate: [fauxSummary()],
  })
  const tOk = createTestVela({ model: fauxOk })
  for (let i = 0; i < 5; i++) await tOk.run(`seed ${i}`)
  const startsBefore = tOk.eventsOf('turn_start').length
  const usagesBefore = tOk.eventsOf('usage').length
  wrapOverflow200(fauxOk, 1)
  await tOk.run('trigger overflow recovery')
  expect(tOk.lastAssistantText()).toBe('recovered inside same turn')
  expect(tOk.eventsOf('turn_start').length - startsBefore).toBe(1)
  expect(tOk.eventsOf('compaction_start')).toEqual([
    { type: 'compaction_start', reason: 'overflow' },
  ])
  expect(tOk.eventsOf('usage').length - usagesBefore).toBe(2)

  // Case B: two consecutive HTTP-200 overflows compact once and fail cleanly
  const fauxRepeat = createFauxModel({
    responses: [
      ...Array.from({ length: 5 }, (_, i) => fauxText(`seed ${i}`)),
      fauxText('overflow 1'),
      fauxText('overflow 2'),
    ],
    generate: [fauxSummary()],
  })
  const tRepeat = createTestVela({ model: fauxRepeat })
  for (let i = 0; i < 5; i++) await tRepeat.run(`seed ${i}`)
  wrapOverflow200(fauxRepeat, 2)
  await expect(tRepeat.run('trigger double overflow')).rejects.toThrow(
    'Context overflow: model_context_window_exceeded',
  )
  expect(tRepeat.eventsOf('compaction_start')).toHaveLength(1)
})

test('tool_search succeeds while container is offline and offline spill failure does not poison future tools', async () => {
  const dir = tempDir('vela-s2a-offline-spill-')
  let offline = false
  const ext: VelaExtension = function ext(vela) {
    vela.registerTool({
      name: 'deferred_calc',
      description: 'deferred helper',
      exposure: 'deferred',
      inputSchema: z.object({}),
      execute: async () => 'calc-ok',
    })
    vela.registerTool({
      name: 'big_pure',
      description: 'oversized output without env',
      maxResultChars: 50,
      inputSchema: z.object({}),
      execute: async () => 'L'.repeat(500),
    })
    vela.registerTool({
      name: 'tiny_pure',
      description: 'small output after failed spill',
      inputSchema: z.object({}),
      execute: async () => 'still-healthy',
    })
  }
  const model = createFauxModel({
    responses: [
      fauxText('prepared'),
      () => {
        offline = true
        return fauxToolCall('tool_search', { query: 'deferred_calc' })
      },
      fauxToolCall('ext_big_pure', {}),
      fauxToolCall('ext_tiny_pure', {}),
      fauxText('all-done'),
    ],
  })
  const vela = createVela({
    cwd: dir.path,
    model,
    extensions: [ext],
    env: ({ location }) => {
      if (offline) throw new Error('adapter offline')
      return createLocalExecutionEnv({ cwd: location.cwd })
    },
  })
  try {
    const session = vela.session('offline-control')
    await session.prompt('warm up')
    await session.prompt('use control tools')
    expect(String(model.calls[2]!.toolResults[0]!.output)).toContain(
      'deferred_calc',
    )
    expect(String(model.calls[3]!.toolResults[0]!.output)).toContain(
      'could not be saved',
    )
    expect(String(model.calls[4]!.toolResults[0]!.output)).toBe('still-healthy')
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('scoped hooks match extension-local tool names and structured error hook results persist identically', async () => {
  const seenCalls: string[] = []
  const mailer: VelaExtension = function mailer(vela) {
    vela.registerTool({
      name: 'send',
      description: 'send or throw',
      inputSchema: z.object({ fail: z.boolean().optional() }),
      execute: async ({ fail }) => {
        if (fail) throw new Error('raw-fail')
        return 'sent'
      },
    })
    // Register scoped hooks with unprefixed local name 'send'
    vela.on('tool_call', 'send', (event) => {
      seenCalls.push(`call:${event.toolName}`)
    })
    vela.on('tool_result', (event) => {
      seenCalls.push(`result:${event.toolName}`)
      if (event.isError)
        return { content: [{ type: 'text', text: 'structured-hook-error' }] }
    })
  }
  const t = createTestVela({
    extensions: [mailer],
    responses: [
      fauxToolCall('mailer_send', { fail: false }),
      fauxToolCall('mailer_send', { fail: true }),
      fauxText('finished'),
    ],
  })
  await t.run('test scoped hooks')
  expect(seenCalls).toEqual([
    'call:mailer_send',
    'result:mailer_send',
    'call:mailer_send',
    'result:mailer_send',
  ])
  const { openDatabase } = await import('../../packages/vela/src/db/index.ts')
  const db = openDatabase({ path: `${t.dataDir}/vela.db`, readonly: true })
  try {
    const row = db.get<{
      status: string
      is_error: number
      result_json: string | null
    }>(
      'SELECT status, is_error, result_json FROM vela_tool_calls WHERE tool_name = ? AND is_error = 1 LIMIT 1',
      'mailer_send',
    )
    expect(row?.status).toBe('failed')
    expect(JSON.parse(String(row?.result_json))).toEqual({
      type: 'content',
      value: [{ type: 'text', text: 'structured-hook-error' }],
      isError: true,
    })
  } finally {
    db.close()
  }
})

test('context hook growth is included in compaction threshold and mid-run setModel preserves serving maxOutputTokens', async () => {
  const dir = tempDir('vela-s2a-context-and-max-')
  const originalFetch = globalThis.fetch
  const maxOutputSent: Array<number | undefined> = []
  try {
    writeFileSync(
      join(dir.path, 'config.json'),
      JSON.stringify({
        providers: {
          openai: {
            api: 'openai-responses',
            baseUrl: 'https://example.test/v1',
            apiKey: 'test',
            models: [
              { id: 'small-out', maxTokens: 512 },
              { id: 'big-out', maxTokens: 4096 },
            ],
          },
        },
      }),
    )
    let calls = 0
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      maxOutputSent.push(body.max_output_tokens)
      calls++
      if (calls === 1) {
        return new Response(
          responsesReply(body, undefined, {
            name: 'switcher_switch_model',
            arguments: '{}',
          }).body,
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }
      return responsesReply(body)
    }) as typeof fetch

    let sessionRef!: ReturnType<ReturnType<typeof createVela>['session']>
    const switcher: VelaExtension = function switcher(vela) {
      vela.registerTool({
        name: 'switch_model',
        description: 'switches session model mid-run',
        inputSchema: z.object({}),
        execute: async () => {
          sessionRef.setModel('openai/big-out')
          return 'switched'
        },
      })
    }
    const vela = createVela({
      cwd: dir.path,
      model: 'openai/small-out',
      providers: loadModels({ agentDir: dir.path }),
      extensions: [switcher],
    })
    sessionRef = vela.session('midrun-switch')
    await sessionRef.prompt('run')
    await vela.dispose()
    expect(maxOutputSent).toEqual([512, 512])
  } finally {
    globalThis.fetch = originalFetch
    dir.cleanup()
  }

  // Context hook injection triggers threshold compaction before request
  const tCompact = createTestVela({
    limits: { summaryThreshold: 15_000, maxInputTokens: 200_000 },
    generate: [fauxSummary()],
    responses: [
      ...Array.from({ length: 5 }, (_, i) => fauxText(`seed ${i}`)),
      fauxText('compacted after hook'),
    ],
    extensions: [
      (vela) => {
        vela.on('context', ({ messages }) => {
          if (messages.at(-1)?.content === 'trigger-hook-compact')
            messages.push({ role: 'user', content: 'H'.repeat(80_000) })
        })
      },
    ],
  })
  for (let i = 0; i < 5; i++) await tCompact.run(`seed ${i}`)
  await tCompact.run('trigger-hook-compact')
  expect(tCompact.eventsOf('compaction_start')).toEqual([
    { type: 'compaction_start', reason: 'threshold' },
  ])
})

test('moving foreground bash to background cancels the foreground timeout deadline', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', {
        command: 'echo FG_START; sleep 0.7; echo FG_DETACHED_FINISHED',
        timeout: 0.4,
      }),
      fauxText('moved'),
      (req) => fauxText(`done:${req.lastUserText}`),
    ],
    extensions: [background()],
  })
  const running = t.run('start bash then detach')
  const deadline = Date.now() + 5000
  while (t.eventsOf('tool_execution_update').length === 0) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for update')
    await Bun.sleep(5)
  }
  expect(await t.session.backgroundTasks('faux-call-1-1')).toEqual(['bg-1'])
  await running
  while (t.model.calls.length < 3) {
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for detached background exit')
    await Bun.sleep(10)
  }
  expect(t.lastAssistantText()).toContain('FG_DETACHED_FINISHED')
  expect(t.lastAssistantText()).not.toContain('Command timed out')
})

test('double HTTP 200 model_context_window_exceeded rejects without leaving truncated output in context history', async () => {
  const dir = tempDir('vela-s2a-double-overflow-')
  const originalFetch = globalThis.fetch
  try {
    writeFileSync(
      join(dir.path, 'config.json'),
      JSON.stringify({
        providers: {
          anthropic: {
            api: 'anthropic-messages',
            baseUrl: 'https://example.test/v1',
            apiKey: 'test',
            models: [{ id: 'claude-test' }],
          },
        },
      }),
    )
    let call = 0
    const anthSse = (events: Array<{ type: string; [k: string]: unknown }>) =>
      new Response(
        events
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (!body.stream) {
        return Response.json({
          id: 'msg_sum',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: 'summary' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 10 },
        })
      }
      call++
      if (call <= 5) {
        return anthSse([
          {
            type: 'message_start',
            message: {
              id: `msg_seed_${call}`,
              type: 'message',
              role: 'assistant',
              content: [],
              model: 'claude-test',
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 100, output_tokens: 1 },
            },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: `seed ${call}` },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 5 },
          },
          { type: 'message_stop' },
        ])
      }
      const text = call === 6 ? 'truncated first' : 'truncated second'
      return anthSse([
        {
          type: 'message_start',
          message: {
            id: `msg_ov_${call}`,
            type: 'message',
            role: 'assistant',
            content: [],
            model: 'claude-test',
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 500, output_tokens: 1 },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: {
            stop_reason: 'model_context_window_exceeded',
            stop_sequence: null,
          },
          usage: { output_tokens: 10 },
        },
        { type: 'message_stop' },
      ])
    }) as unknown as typeof fetch
    const messageEnds: string[] = []
    const vela = createVela({
      cwd: dir.path,
      dataDir: dir.path,
      model: 'anthropic/claude-test',
      providers: loadModels({ agentDir: dir.path }),
    })
    const session = vela.session('double-overflow')
    for (let i = 1; i <= 5; i++) await session.prompt(`seed ${i}`)
    session.subscribe((e) => {
      if (e.type === 'message_end') messageEnds.push(e.stopReason ?? 'none')
    })
    await expect(session.prompt('overflow twice')).rejects.toThrow(
      'Context overflow: model_context_window_exceeded',
    )
    await vela.dispose()
    expect(messageEnds).toContain('error')
    expect(messageEnds).not.toContain('length')
    expect(
      session.messages.some(
        (m) =>
          m.role === 'assistant' &&
          JSON.stringify(m.content).includes('truncated second'),
      ),
    ).toBe(false)
  } finally {
    globalThis.fetch = originalFetch
    dir.cleanup()
  }
})

test('scoped hook targets only extension canonical tool, before_agent_start setModel updates maxOutputTokens, and Ctrl+B suspends deadline during host ack', async () => {
  const hookHits: string[] = []
  const docs: VelaExtension = function docs(vela) {
    vela.registerTool({
      name: 'read',
      description: 'docs read',
      inputSchema: z.object({ topic: z.string() }),
      execute: async ({ topic }) => `doc:${topic}`,
    })
    vela.on('tool_call', 'read', (event) => {
      hookHits.push(event.toolName)
    })
  }
  const tScoped = createTestVela({
    extensions: [docs],
    responses: [
      fauxToolCall('read', { path: 'sample.txt' }),
      fauxToolCall('docs_read', { topic: 'v0.9' }),
      fauxText('ok'),
    ],
  })
  writeFileSync(join(tScoped.cwd, 'sample.txt'), 'hello\n')
  await tScoped.run('read both')
  expect(hookHits).toEqual(['docs_read'])

  const dir = tempDir('vela-s2a-before-start-max-')
  const originalFetch = globalThis.fetch
  const maxOutputSent: Array<number | undefined> = []
  try {
    writeFileSync(
      join(dir.path, 'config.json'),
      JSON.stringify({
        providers: {
          openai: {
            api: 'openai-responses',
            baseUrl: 'https://example.test/v1',
            apiKey: 'test',
            models: [
              { id: 'small-out', maxTokens: 512 },
              { id: 'big-out', maxTokens: 4096 },
            ],
          },
        },
      }),
    )
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      maxOutputSent.push(body.max_output_tokens)
      return responsesReply(body)
    }) as typeof fetch
    const switchAtStart: VelaExtension = (vela) => {
      vela.on('before_agent_start', async (_event, ctx) => {
        ctx.session.setModel('openai/big-out')
      })
    }
    const vela = createVela({
      cwd: dir.path,
      dataDir: dir.path,
      model: 'openai/small-out',
      providers: loadModels({ agentDir: dir.path }),
      extensions: [switchAtStart],
    })
    await vela.session('switch-at-start').prompt('hello')
    await vela.dispose()
    expect(maxOutputSent).toEqual([4096])
  } finally {
    globalThis.fetch = originalFetch
    dir.cleanup()
  }

  // Ctrl+B suspends short 150ms foreground deadline while host acknowledgment takes 120ms after update (~100ms)
  let ackEvents = 0
  const bgResults: string[] = []
  const tRace = createTestVela({
    responses: [
      fauxToolCall('bash', {
        command: 'echo RACE_START; sleep 0.3; echo RACE_DONE',
        timeout: 0.15,
      }),
      fauxText('detached cleanly'),
    ],
    extensions: [background()],
    session: {
      host: {
        deliver: () => {},
        background: async (event) => {
          if (event.type === 'started') {
            ackEvents++
            await Bun.sleep(120)
          } else if (event.type === 'result') {
            bgResults.push(event.text)
          }
        },
      },
    },
  })
  const running = tRace.run('race')
  const raceDeadline = Date.now() + 5000
  while (tRace.eventsOf('tool_execution_update').length === 0) {
    if (Date.now() > raceDeadline)
      throw new Error('Timed out waiting for bash output')
    await Bun.sleep(5)
  }
  expect(await tRace.session.backgroundTasks('faux-call-1-1')).toEqual(['bg-1'])
  await running
  expect(ackEvents).toBe(1)
  while (bgResults.length === 0) {
    if (Date.now() > raceDeadline)
      throw new Error('Timed out waiting for background job completion')
    await Bun.sleep(10)
  }
  expect(bgResults[0]).toContain(
    'Background command bg-1 finished with exit code 0',
  )
})

test('session loop normalizes toolCallIds on custom anthropic-messages provider through withProviderHooks', async () => {
  const dir = tempDir('vela-s2a-session-custom-anthropic-')
  const originalFetch = globalThis.fetch
  const bodies: Record<string, unknown>[] = []
  try {
    writeFileSync(
      join(dir.path, 'config.json'),
      JSON.stringify({
        providers: {
          company: {
            api: 'anthropic-messages',
            baseUrl: 'https://example.test/v1',
            apiKey: 'test',
            models: [{ id: 'claude-custom' }],
          },
        },
      }),
    )
    let calls = 0
    const toSse = (events: Array<{ type: string; [k: string]: unknown }>) =>
      new Response(
        events
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    globalThis.fetch = (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      calls++
      if (calls === 1) {
        return toSse([
          {
            type: 'message_start',
            message: {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              content: [],
              model: 'claude-custom',
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 1 },
            },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'a:b',
              name: 'ext_ping',
              input: {},
            },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{}' },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use', stop_sequence: null },
            usage: { output_tokens: 5 },
          },
          { type: 'message_stop' },
        ])
      }
      return toSse([
        {
          type: 'message_start',
          message: {
            id: 'msg_2',
            type: 'message',
            role: 'assistant',
            content: [],
            model: 'claude-custom',
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 15, output_tokens: 1 },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'done' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 2 },
        },
        { type: 'message_stop' },
      ])
    }) as typeof fetch
    const ext: VelaExtension = (vela) => {
      vela.registerTool({
        name: 'ext_ping',
        description: 'ping',
        inputSchema: z.object({}),
        execute: async () => 'pong',
      })
    }
    const vela = createVela({
      cwd: dir.path,
      dataDir: dir.path,
      model: 'company/claude-custom',
      providers: loadModels({ agentDir: dir.path }),
      extensions: [ext],
    })
    await vela.session('custom-anth-hooks').prompt('ping')
    await vela.dispose()
    const secondWire = JSON.stringify(bodies[1]?.messages ?? [])
    expect(secondWire).not.toContain('"a:b"')
    expect(secondWire).toContain('"a_b"')
  } finally {
    globalThis.fetch = originalFetch
    dir.cleanup()
  }
})
