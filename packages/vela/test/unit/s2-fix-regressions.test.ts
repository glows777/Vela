import { afterAll, expect, test } from 'bun:test'
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APICallError, type LanguageModelV4 } from '@ai-sdk/provider'
import { z } from 'zod'
import { SCHEMA_VERSION } from '../../src/db/schema.ts'
import { openDatabase } from '../../src/db/sqlite.ts'
import { isRetryable } from '../../src/driver/agent/retry.ts'
import {
  findCompactionCut,
  summarize,
} from '../../src/driver/context/compressor.ts'
import { createRequestSnapshot } from '../../src/driver/context/request.ts'
import {
  isToolResultError,
  toolResultOutputToText,
} from '../../src/driver/context/tool-result-output.ts'
import { inspectSession } from '../../src/driver/diagnostics.ts'
import { persistAssistantStepTx } from '../../src/driver/driver-step.ts'
import { createLocalExecutionEnv } from '../../src/driver/execution/local.ts'
import { memoryCredentialStore } from '../../src/driver/index.ts'
import type { ModelMessage } from '../../src/driver/messages.ts'
import { queryBranchRows } from '../../src/driver/session/db-store.ts'
import {
  resolveRunProducer,
  SessionDefaultState,
} from '../../src/driver/session/defaults.ts'
import { entriesToMessages } from '../../src/driver/session/entries.ts'
import { exportSavedSession } from '../../src/driver/session/export.ts'
import { SessionStore } from '../../src/driver/session/index.ts'
import { loadStepToolCallRows } from '../../src/driver/step-recovery.ts'
import { executeStepCalls } from '../../src/driver/tool-executor.ts'
import { prepareCallResult } from '../../src/driver/tools/call-result.ts'
import { ToolRegistry } from '../../src/driver/tools/registry.ts'
import { createGrepTool } from '../../src/driver/tools/search.ts'
import { createBashTool } from '../../src/driver/tools/shell.ts'
import { ToolExecutionResult } from '../../src/driver/tools/types.ts'
import { TokenTracker } from '../../src/driver/usage/tracker.ts'
import { createVela } from '../../src/driver/vela.ts'
import { VelaDriver } from '../../src/driver/vela-driver.ts'
import { createMcpTool } from '../../src/mcp/tools.ts'
import { toAiModelMessages } from '../../src/providers/messages.ts'
import { ModelRegistry } from '../../src/providers/models/index.ts'
import { loadModels } from '../../src/providers/models-config.ts'
import { deepMergeProviderOptions } from '../../src/providers/stream-metadata.ts'
import { createFauxModel, fauxText } from '../../src/testing/core/faux.ts'

const workDir = mkdtempSync(join(tmpdir(), 'vela-s2-fix-unit-'))
afterAll(() => rmSync(workDir, { recursive: true, force: true }))

test('clean v1 schema includes S2b columns and only 001_initial migration', () => {
  expect(SCHEMA_VERSION).toBe(1)
  const db = openDatabase({ path: ':memory:' })
  try {
    const migrations = db.all<{ version: number; name: string }>(
      'SELECT version, name FROM schema_migrations ORDER BY version ASC',
    )
    expect(migrations).toEqual([{ version: 1, name: '001_initial' }])
    const runsCols = db
      .all<{ name: string }>('PRAGMA table_info(runs)')
      .map((c) => c.name)
    const approvalCols = db
      .all<{ name: string }>('PRAGMA table_info(approvals)')
      .map((c) => c.name)
    const messageCols = db
      .all<{ name: string }>('PRAGMA table_info(vela_messages)')
      .map((c) => c.name)
    expect(runsCols).toContain('owner_token')
    expect(approvalCols).toContain('tool_call_row_id')
    expect(messageCols).toContain('choice_json')
    expect(messageCols).toContain('location_json')
  } finally {
    db.close()
  }
})

test('executionMode defaults: bash and readOnly MCP are parallel; non-readOnly MCP is sequential', () => {
  expect(createBashTool(workDir).executionMode).toBe('parallel')

  const dummyCaller = {
    callTool: async () => ({ content: [] }),
  }
  const mcpDefault = createMcpTool({
    server: 'srv',
    tool: {
      name: 'mutate',
      inputSchema: { type: 'object', properties: {} },
    },
    name: 'srv_mutate',
    exposure: 'direct',
    namespace: { name: 'mcp__srv' },
    caller: dummyCaller,
  })
  const mcpReadOnly = createMcpTool({
    server: 'srv',
    tool: {
      name: 'inspect',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
    name: 'srv_inspect',
    exposure: 'direct',
    namespace: { name: 'mcp__srv' },
    caller: dummyCaller,
  })
  expect(mcpDefault.executionMode).toBe('sequential')
  expect(mcpReadOnly.executionMode).toBe('parallel')
})

test('grep with context > 0 and limit does not leak lines from subsequent matches', async () => {
  const dir = mkdtempSync(join(workDir, 'grep-limit-'))
  const lines = [
    'NEEDLE_ONE',
    'ctx-1a',
    'ctx-1b',
    'gap-1',
    'gap-2',
    'ctx-2-before',
    'NEEDLE_TWO',
    'ctx-2-after',
  ]
  writeFileSync(join(dir, 'sample.txt'), `${lines.join('\n')}\n`)
  const grep = createGrepTool(dir)
  const localEnv = createLocalExecutionEnv({ cwd: dir })
  const out = await grep.execute(
    { pattern: 'NEEDLE_', path: 'sample.txt', context: 1, limit: 1 },
    {
      execution: localEnv,
      requireEnv: async () => localEnv,
    },
  )
  const text = out instanceof ToolExecutionResult ? out.text : String(out)
  expect(text).toContain('NEEDLE_ONE')
  expect(text).toContain('ctx-1a')
  expect(text).not.toContain('ctx-2-before')
  expect(text).not.toContain('NEEDLE_TWO')
  expect(text).not.toContain('ctx-2-after')
})

test('prepareCallResult includes multimodal truncation note when oversized content spills', async () => {
  const spillDir = join(workDir, 'spill')
  const bigText = `${Array.from({ length: 40 }, (_, i) => `line-${i}`).join('\n')}\n${'x'.repeat(300)}`
  const raw = new ToolExecutionResult({}, [
    { type: 'text', text: bigText },
    { type: 'image', data: 'QUJD', mimeType: 'image/png' },
  ])
  const prepared = await prepareCallResult({
    raw,
    spillDir,
    environment: createLocalExecutionEnv({ cwd: workDir }),
    maxResultChars: 120,
  })
  expect(prepared.stored).toBeDefined()
  expect(Array.isArray(prepared.output)).toBe(true)
  const serialized = JSON.stringify(prepared.output)
  expect(serialized).toContain('Full output:')
})

test('providers: openai-completions forceReasoning, null encrypted rs_ strip, metadata merge, and retryable errors', async () => {
  // 1) deepMergeProviderOptions ignores null/undefined overwrites
  const merged = deepMergeProviderOptions(
    { openai: { encrypted_content: 'keep-me', flag: true } },
    {
      openai: {
        encrypted_content: null as unknown as string,
        flag: undefined as unknown as boolean,
        extra: 1,
      },
    },
  )
  expect(merged).toEqual({
    openai: { encrypted_content: 'keep-me', flag: true, extra: 1 },
  })

  // 2) mergeConsecutiveAssistants preserves nested providerOptions without clobbering
  const msgs: ModelMessage[] = [
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'a' }],
      providerOptions: { openai: { itemId: 'i1' } },
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'b' }],
      providerOptions: { openai: { extra: 2 } },
    },
  ]
  const aiMsgs = toAiModelMessages(msgs)
  expect(aiMsgs).toHaveLength(1)
  expect(aiMsgs[0]?.providerOptions?.openai).toEqual({ itemId: 'i1', extra: 2 })

  // 3) rs_ reasoning part with null encrypted reasoning is stripped on stateless responses,
  // and openai-completions applies forceReasoning + thinkingLevelMap via ModelRegistry + loadModels
  const capturedBodies: Array<Record<string, unknown>> = []
  const origFetch = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {}
    capturedBodies.push(body)
    const isResponses = Array.isArray(body.input)
    const payload = isResponses
      ? {
          id: 'resp_1',
          object: 'response',
          model: 'resp',
          output: [
            {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'ok', annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }
      : {
          id: 'cmpl_1',
          object: 'chat.completion',
          model: 'reasoner',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const providers = loadModels({
      agentDir: workDir,
      providers: {
        custom: {
          baseUrl: 'https://example.invalid/v1',
          api: 'openai-responses',
          apiKey: 'test-key',
          models: [
            {
              id: 'resp',
              reasoning: true,
              compat: { store: false },
            },
          ],
        },
      },
    })
    const reg = new ModelRegistry(providers, memoryCredentialStore())
    const respModel = reg.resolve('custom/resp').model as LanguageModelV4
    await respModel.doGenerate({
      prompt: [
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'secret',
              providerOptions: {
                openai: { itemId: 'rs_123', reasoningEncryptedContent: null },
              },
            },
            { type: 'text', text: 'visible' },
          ],
        },
      ],
    } as never)
    expect(JSON.stringify(capturedBodies[0])).not.toContain('rs_123')
    expect(JSON.stringify(capturedBodies[0])).toContain('visible')
  } finally {
    globalThis.fetch = origFetch
  }

  // 5) retryable network errors & authMode
  expect(isRetryable(new Error('UND_ERR_SOCKET: closed'))).toBe(true)
  expect(isRetryable(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe(
    true,
  )
  expect(isRetryable(new Error('getaddrinfo EAI_AGAIN api.openai.com'))).toBe(
    true,
  )

  const creds = memoryCredentialStore({
    openai: {
      type: 'oauth',
      access: 'tok',
      refresh: 'ref',
      expires: Date.now() + 60_000,
    },
  })
  const mr = new ModelRegistry({}, creds)
  expect(mr.authMode('openai')).toBe('oauth')
  expect(
    resolveRunProducer(
      'openai/gpt-5',
      'openai/gpt-5',
      'openai',
      undefined,
      (p, ch) => mr.authMode(p, ch),
    ),
  ).toBe('openai/gpt-5:oauth')
  expect(
    resolveRunProducer(
      'openai/gpt-5',
      'openai/gpt-5',
      'anthropic',
      undefined,
      (p, ch) => mr.authMode(p, ch),
    ),
  ).toBe('openai/gpt-5')
})

test('tool-executor: single-flight resolveEnv, steer skip without approval row, and after-hook row transitions to failed before rejecting', async () => {
  const db = openDatabase({ path: ':memory:' })
  try {
    const store = new SessionStore('exec-step', db)
    store.appendMessage({ role: 'user', content: 'run' })
    const now = new Date().toISOString()
    db.run(
      "INSERT INTO runs (id, session_id, driver, trigger, status, started_at, updated_at) VALUES ('r-1', 'exec-step', 'vela', 'user', 'running', ?, ?)",
      now,
      now,
    )

    let resolveCalls = 0
    let steerActive = false
    let approvalsCreated = 0
    const registry = new ToolRegistry(join(workDir, 'exec-spill'))
    registry.register(
      {
        name: 'par_a',
        description: 'parallel tool A',
        executionMode: 'parallel',
        inputSchema: z.object({}),
        execute: async (_i, ctx) => {
          await ctx?.requireEnv?.()
          steerActive = true
          return 'a'
        },
      },
      {
        name: 'par_b',
        description: 'parallel tool B',
        executionMode: 'parallel',
        inputSchema: z.object({}),
        execute: async (_i, ctx) => {
          await ctx?.requireEnv?.()
          return 'b'
        },
      },
      {
        name: 'seq_after',
        description: 'sequential tool',
        // omitted executionMode -> defaults to sequential
        inputSchema: z.object({}),
        execute: async () => 'seq',
      },
    )

    const { entry: step1 } = persistAssistantStepTx({
      db,
      store,
      registry,
      sessionId: 'exec-step',
      runId: 'r-1',
      producer: 'mock/m',
      assistant: {
        role: 'assistant',
        content: [
          { type: 'tool_call', toolCallId: 'c1', toolName: 'par_a', input: {} },
          { type: 'tool_call', toolCallId: 'c2', toolName: 'par_b', input: {} },
          {
            type: 'tool_call',
            toolCallId: 'c3',
            toolName: 'seq_after',
            input: {},
          },
        ],
      },
      responseMessages: [],
      clientCalls: [
        { type: 'tool_call', toolCallId: 'c1', toolName: 'par_a', input: {} },
        { type: 'tool_call', toolCallId: 'c2', toolName: 'par_b', input: {} },
        {
          type: 'tool_call',
          toolCallId: 'c3',
          toolName: 'seq_after',
          input: {},
        },
      ],
      stepRecord: {
        ts: Date.now(),
        model: 'mock/m',
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      rawUsage: { inputTokens: 1, outputTokens: 1 },
    })

    registry.setInterception({
      resolveEnv: async () => {
        resolveCalls++
        await new Promise((r) => setTimeout(r, 15))
        return createLocalExecutionEnv({ cwd: workDir })
      },
      before: async (toolName, input) => {
        if (toolName === 'seq_after') {
          approvalsCreated++
          return {
            block: true,
            input,
            approval: { summary: 'should not happen' },
          }
        }
        return { block: false, input }
      },
    })
    const rows = loadStepToolCallRows(db, 'exec-step', step1.id)
    expect(rows[2]?.execution_mode).toBe('sequential')

    const res = await executeStepCalls({
      db,
      store,
      registry,
      sessionId: 'exec-step',
      rows,
      emit: () => {},
      shouldSkipForSteer: () => steerActive,
    })
    expect(resolveCalls).toBe(1)
    expect(approvalsCreated).toBe(0)
    expect(res.waitingHuman).toBe(false)
    expect(
      db.get<{ status: string }>(
        "SELECT status FROM vela_tool_calls WHERE tool_call_id = 'c3'",
      )?.status,
    ).toBe('skipped')

    // after-hook failure updates DB row to failed AND rejects
    const { entry: step2 } = persistAssistantStepTx({
      db,
      store,
      registry,
      sessionId: 'exec-step',
      runId: 'r-1',
      producer: 'mock/m',
      assistant: {
        role: 'assistant',
        content: [
          { type: 'tool_call', toolCallId: 'c4', toolName: 'par_a', input: {} },
        ],
      },
      responseMessages: [],
      clientCalls: [
        { type: 'tool_call', toolCallId: 'c4', toolName: 'par_a', input: {} },
      ],
      stepRecord: {
        ts: Date.now(),
        model: 'mock/m',
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      rawUsage: { inputTokens: 1, outputTokens: 1 },
    })
    const emitted: string[] = []
    registry.setInterception({
      after: async () => {
        throw new Error('after-boom')
      },
    })
    await expect(
      executeStepCalls({
        db,
        store,
        registry,
        sessionId: 'exec-step',
        rows: loadStepToolCallRows(db, 'exec-step', step2.id),
        emit: (e) => {
          if (e.type === 'tool_execution_end')
            emitted.push(`${e.toolCallId}:${e.isError}`)
        },
      }),
    ).rejects.toThrow('after-boom')
    expect(emitted).toEqual(['c4:true'])
    expect(
      db.get<{ status: string }>(
        "SELECT status FROM vela_tool_calls WHERE tool_call_id = 'c4'",
      )?.status,
    ).toBe('failed')
  } finally {
    db.close()
  }
})

test('VelaDriver: hosted store.idOf preserved, waiting_human guard throws loudly, draining ends interrupted, and dead-owner reclaims interrupted', async () => {
  const db = openDatabase({ path: ':memory:' })
  try {
    const store = new SessionStore('drv-1', db)
    const registry = new ToolRegistry(join(workDir, 'drv-spill'))
    store.appendMessage({ role: 'user', content: 'start' })
    const now = new Date().toISOString()
    db.run(
      "INSERT INTO runs (id, session_id, driver, trigger, status, started_at, updated_at) VALUES ('r-h', 'drv-1', 'vela', 'user', 'running', ?, ?)",
      now,
      now,
    )
    const { hostedMessages } = persistAssistantStepTx({
      db,
      store,
      registry,
      sessionId: 'drv-1',
      runId: 'r-h',
      producer: 'mock/m',
      assistant: {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            toolCallId: 'w1',
            toolName: 'web_search',
            input: { q: 'vela' },
            providerExecuted: true,
          },
        ],
      },
      responseMessages: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              toolCallId: 'w1',
              toolName: 'web_search',
              providerExecuted: true,
              output: { type: 'text', value: 'result' },
            },
          ],
        },
      ],
      clientCalls: [],
      stepRecord: {
        ts: Date.now(),
        model: 'mock/m',
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      rawUsage: { inputTokens: 1, outputTokens: 1 },
    })
    expect(hostedMessages).toHaveLength(1)
    expect(store.idOf(hostedMessages[0]!)).toBeDefined()

    // !allowWaitingHuman refuses waiting_human
    const sWait = new SessionStore('drv-wait', db)
    sWait.ensureSessionRow()
    db.run("UPDATE sessions SET state = 'waiting_human' WHERE id = 'drv-wait'")
    const drvWait = new VelaDriver({
      sessionId: 'drv-wait',
      db,
      store: sWait,
      registry,
      tracker: new TokenTracker(),
    })
    await expect(
      drvWait.run({
        model: createFauxModel({ responses: [fauxText('hi')] }),
        systemPrompt: '',
        messages: [],
        allowWaitingHuman: false,
      }),
    ).rejects.toThrow("state is 'waiting_human'")

    // Dead owner reclaim marks old run as interrupted
    const sDead = new SessionStore('drv-dead', db)
    sDead.appendMessage({ role: 'user', content: 'old' })
    db.run(
      "INSERT INTO runs (id, session_id, owner_token, driver, trigger, status, started_at, updated_at) VALUES ('r-dead', 'drv-dead', 'dead:99999999:uuid', 'vela', 'user', 'running', ?, ?)",
      now,
      now,
    )
    const drvDead = new VelaDriver({
      sessionId: 'drv-dead',
      db,
      store: sDead,
      registry,
      tracker: new TokenTracker(),
    })
    await drvDead.run({
      model: createFauxModel({ responses: [fauxText('recovered')] }),
      systemPrompt: '',
      messages: [{ role: 'user', content: 'old' }],
    })
    expect(
      db.get<{ status: string }>("SELECT status FROM runs WHERE id = 'r-dead'")
        ?.status,
    ).toBe('interrupted')
  } finally {
    db.close()
  }
})

test('driver-step: aborted partial stream excluded, overflow/retry work with attached hosted tool, and failed overflow compaction emits single turn_end', async () => {
  // 1) Aborted mid-stream partial text is excluded from active context while started hosted search converts to portable text
  const abortStreamModel: LanguageModelV4 = {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'm',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('unused')
    },
    doStream: async () =>
      ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'text-start', id: 't-partial' })
            controller.enqueue({
              type: 'text-delta',
              id: 't-partial',
              delta: 'halfway text',
            })
            controller.enqueue({
              type: 'error',
              error: new Error('stream cut mid-flight'),
            })
            controller.close()
          },
        }),
      }) as never,
  }
  const hostedAbortStreamModel: LanguageModelV4 = {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'm',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('unused')
    },
    doStream: async () =>
      ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({
              type: 'tool-call',
              toolCallId: 'ws-abort',
              toolName: 'web_search',
              input: '{}',
              providerExecuted: true,
            })
            controller.enqueue({
              type: 'error',
              error: new Error('hosted cut mid-flight'),
            })
            controller.close()
          },
        }),
      }) as never,
  }
  // 2) Failed overflow compaction emits a single turn_end and does not retry
  let calls = 0
  let compactCalls = 0
  const overflowFailModel: LanguageModelV4 = {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'm',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('unused')
    },
    doStream: async () => {
      calls++
      throw Object.assign(new Error('model_context_window_exceeded'), {
        responseBody: JSON.stringify({
          error: { code: 'context_length_exceeded' },
        }),
      })
    },
  }
  const db = openDatabase({ path: ':memory:' })
  try {
    const abortStore = new SessionStore('drv-abort-hosted', db)
    const abortMsgs: ModelMessage[] = [{ role: 'user', content: 'hi' }]
    abortStore.appendMessage(abortMsgs[0]!)
    const abortDriver = new VelaDriver({
      sessionId: 'drv-abort-hosted',
      db,
      store: abortStore,
      registry: new ToolRegistry(join(workDir, 'abort-spill')),
      tracker: new TokenTracker(),
    })
    await expect(
      abortDriver.run({
        model: abortStreamModel,
        systemPrompt: '',
        messages: abortMsgs,
        limits: { maxRetries: 0, retryBaseMs: 0 },
      }),
    ).rejects.toThrow('stream cut mid-flight')
    expect(abortStore.buildContext().messages).toHaveLength(1)

    const hostedAbortStore = new SessionStore('drv-abort-hosted-search', db)
    const hostedAbortMsgs: ModelMessage[] = [{ role: 'user', content: 'hi' }]
    hostedAbortStore.appendMessage(hostedAbortMsgs[0]!)
    await expect(
      new VelaDriver({
        sessionId: 'drv-abort-hosted-search',
        db,
        store: hostedAbortStore,
        registry: new ToolRegistry(join(workDir, 'abort-hosted-spill')),
        tracker: new TokenTracker(),
      }).run({
        model: hostedAbortStreamModel,
        systemPrompt: '',
        messages: hostedAbortMsgs,
        limits: { maxRetries: 0, retryBaseMs: 0 },
      }),
    ).rejects.toThrow('hosted cut mid-flight')
    const hostedCtx = hostedAbortStore.buildContext().messages
    expect(hostedCtx).toHaveLength(2)
    expect(JSON.stringify(hostedCtx[1])).toContain('Provider search:')
    expect(JSON.stringify(hostedCtx[1])).not.toContain('tool_call')

    const store = new SessionStore('drv-ovf', db)
    const tracker = new TokenTracker()
    const turnEnds: unknown[] = []
    const driver = new VelaDriver({
      sessionId: 'drv-ovf',
      db,
      store,
      registry: new ToolRegistry(join(workDir, 'ovf-spill')),
      tracker,
      onEvent: (e) => {
        if (e.type === 'turn_end') turnEnds.push(e)
      },
    })
    const initialMessages: ModelMessage[] = [{ role: 'user', content: 'hello' }]
    store.appendMessage(initialMessages[0]!)
    await expect(
      driver.run({
        model: overflowFailModel,
        systemPrompt: '',
        messages: initialMessages,
        limits: { retryBaseMs: 0 },
        compactOnOverflow: async () => {
          compactCalls++
          throw new Error('compact exploded')
        },
      }),
    ).rejects.toThrow('compact exploded')
    expect(compactCalls).toBe(1)
    expect(calls).toBe(1)
    expect(turnEnds).toHaveLength(1)

    // Overflow with idle hosted tool recovers when compactOnOverflow succeeds
    let callsOk = 0
    const modelOk = {
      specificationVersion: 'v4',
      provider: 'mock',
      modelId: 'm',
      supportedUrls: {},
      hostedTools: async () => ({
        web_search: {
          type: 'provider',
          id: 'openai.web_search',
          name: 'web_search',
          args: {},
        },
      }),
      doGenerate: async () => {
        throw new Error('unused')
      },
      doStream: async () => {
        callsOk++
        if (callsOk === 1) {
          throw new APICallError({
            message: 'model_context_window_exceeded',
            url: 'https://example.invalid/v1/responses',
            requestBodyValues: {},
            statusCode: 400,
            responseBody: JSON.stringify({
              error: { code: 'context_length_exceeded' },
            }),
          })
        }
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'text-start', id: 't1' })
              controller.enqueue({
                type: 'text-delta',
                id: 't1',
                delta: 'recovered-after-compact',
              })
              controller.enqueue({ type: 'text-end', id: 't1' })
              controller.enqueue({
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: { inputTokens: 5, outputTokens: 2 },
              })
              controller.close()
            },
          }),
        } as never
      },
    } as unknown as LanguageModelV4
    const storeOk = new SessionStore('drv-ovf-ok', db)
    const ovfMsgs: ModelMessage[] = [{ role: 'user', content: 'retry me' }]
    storeOk.appendMessage(ovfMsgs[0]!)
    let compacted = 0
    const hostedReg = new ToolRegistry(join(workDir, 'ovf-ok-spill'))
    hostedReg.register({
      name: 'web_search',
      description: 'hosted search',
      hostedOnly: true,
      inputSchema: z.object({ query: z.string() }),
      execute: async () => 'unused',
    })
    const driverOk = new VelaDriver({
      sessionId: 'drv-ovf-ok',
      db,
      store: storeOk,
      registry: hostedReg,
      tracker: new TokenTracker(),
    })
    const okRes = await driverOk.run({
      model: modelOk,
      systemPrompt: '',
      messages: ovfMsgs,
      limits: { maxRetries: 1, retryBaseMs: 0 },
      compactOnOverflow: async () => {
        compacted++
      },
    })
    expect(okRes.reason).toBe('done')
    expect(compacted).toBe(1)
    expect(callsOk).toBe(2)
  } finally {
    db.close()
  }
})

test('compaction & TokenTracker: cut avoids prior summary loop and mid-turn splits, isBranchSummary skips previous-summary, failed tool paths excluded, and model switch resets hook delta', async () => {
  // 1) findCompactionCut skips short user[0] and avoids prior [summary]
  const withPriorSummary: ModelMessage[] = [
    { role: 'user', content: '[summary]\nprior' },
    { role: 'user', content: 'turn 1 question' },
    { role: 'assistant', content: 'turn 1 answer' },
    { role: 'user', content: `turn 2 ${'z'.repeat(85_000)}` },
    { role: 'assistant', content: 'turn 2 answer' },
  ]
  const cut = findCompactionCut(withPriorSummary)
  expect(cut?.turnStartIndex).toBe(3)
  expect(cut?.isSplitTurn).toBe(false)

  // 2) summarize with isBranchSummary: true ignores removed[0] as <previous-summary>, and excludes failed/truncated file calls
  const db = openDatabase({ path: ':memory:' })
  try {
    const store = new SessionStore('comp-excl', db)
    store.appendMessage({ role: 'user', content: 'hi' })
    const now = new Date().toISOString()
    db.run(
      "INSERT INTO runs (id, session_id, driver, trigger, status, started_at, updated_at) VALUES ('r-c', 'comp-excl', 'vela', 'user', 'completed', ?, ?)",
      now,
      now,
    )
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'Old summary text that is NOT a compaction' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            toolCallId: 'ok-read',
            toolName: 'read',
            input: { path: 'good.ts' },
          },
          {
            type: 'tool_call',
            toolCallId: 'fail-write',
            toolName: 'write',
            input: { path: 'failed.ts', content: 'x' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            toolCallId: 'ok-read',
            toolName: 'read',
            output: { type: 'text', value: 'good content' },
          },
          {
            type: 'tool_result',
            toolCallId: 'fail-write',
            toolName: 'write',
            output: { type: 'execution-denied', reason: 'nope' },
          },
        ],
      },
    ]
    let capturedPrompt = ''
    const capModel: LanguageModelV4 = {
      specificationVersion: 'v4',
      provider: 'mock',
      modelId: 'm',
      supportedUrls: {},
      doGenerate: async (params) => {
        capturedPrompt = JSON.stringify(params.prompt)
        return {
          content: [{ type: 'text', text: 'branch summary' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          warnings: [],
        } as never
      },
      doStream: async () => {
        throw new Error('unused')
      },
    }
    const req = createRequestSnapshot(
      capModel,
      '',
      { sdkTools: {}, toolDefinitions: [], hasHostedTools: false },
      msgs,
    )
    const summaryRes = await summarize(
      req,
      store,
      new TokenTracker(),
      100_000,
      undefined,
      0,
    )
    expect(capturedPrompt).not.toContain('<previous-summary>')
    expect(summaryRes.summary).toContain('<read-files>')
    expect(summaryRes.summary).toContain('good.ts')
    expect(summaryRes.summary).not.toContain('failed.ts')
    expect(summaryRes.summary).not.toContain('<modified-files>')
  } finally {
    db.close()
  }

  // 3) entriesToMessages respects internal compaction entry
  const contextMsgs = entriesToMessages([
    {
      type: 'message',
      id: 'u1',
      parentId: null,
      timestamp: '2026-01-01T00:00:00Z',
      message: { role: 'user', content: 'dropped' },
    },
    {
      type: 'message',
      id: 'u2',
      parentId: 'u1',
      timestamp: '2026-01-01T00:00:01Z',
      message: { role: 'user', content: 'kept before' },
    },
    {
      type: 'compaction',
      id: 'c1',
      parentId: 'u2',
      timestamp: '2026-01-01T00:00:02Z',
      summary: 'kept summary',
      firstKeptEntryId: 'u2',
      tokensBefore: 100,
    },
    {
      type: 'message',
      id: 'u3',
      parentId: 'c1',
      timestamp: '2026-01-01T00:00:03Z',
      message: { role: 'user', content: 'kept follow' },
    },
  ])
  expect(JSON.stringify(contextMsgs)).not.toContain('dropped')
  expect(JSON.stringify(contextMsgs)).toContain('kept summary')
  expect(JSON.stringify(contextMsgs)).toContain('kept before')
  expect(JSON.stringify(contextMsgs)).toContain('kept follow')

  // 4) TokenTracker setModel resets contextHookDeltaTokens on switch, keeps on same model
  const tracker = new TokenTracker()
  tracker.setEstimatedTokens(500)
  tracker.setContextDelta(120)
  expect(tracker.estimatedTokens).toBe(620)
  tracker.restoreCalibration(400, 100, [])
  expect(tracker.reportedContextTokens).toBe(500)
  tracker.setContextDelta(180)
  expect(tracker.reportedContextTokens).toBe(560)
  tracker.setModel(100_000, undefined, { keepCalibration: true })
  expect(tracker.reportedContextTokens).toBe(560)
  expect(tracker.estimatedTokens).toBe(560)
  tracker.setModel(200_000, undefined, { keepCalibration: false })
  expect(tracker.reportedContextTokens).toBeUndefined()
  expect(tracker.estimatedTokens).toBe(500)

  // 5) toolResultOutputToText strips opaque fields and detects errors
  const opaqueOut = {
    type: 'error-json' as const,
    value: {
      err: 'bad',
      encrypted_content: 'xx',
      nested: { encryptedContent: 'yy' },
    },
  }
  expect(isToolResultError(opaqueOut)).toBe(true)
  expect(isToolResultError({ type: 'execution-denied', reason: 'no' })).toBe(
    true,
  )
  expect(isToolResultError({ type: 'content', isError: true, value: [] })).toBe(
    true,
  )
  expect(toolResultOutputToText(opaqueOut)).toBe('{"err":"bad","nested":{}}')
})

test('SessionStore, seedFrom, cycle CTE guard, and createVela cleanup on init failure', async () => {
  const db = openDatabase({ path: ':memory:' })
  try {
    // 1) flush() persists buffered custom entries on unstarted session
    const s = new SessionStore('buf-1', db)
    s.appendCustom('pending-note', { k: 1 })
    expect(
      db.get('SELECT id FROM sessions WHERE id = ?', 'buf-1'),
    ).toBeUndefined()
    await s.flush()
    expect(
      db.get('SELECT id FROM sessions WHERE id = ?', 'buf-1'),
    ).toBeDefined()
    expect(
      db.all('SELECT kind FROM vela_messages WHERE session_id = ?', 'buf-1'),
    ).toEqual([{ kind: 'custom' }])

    // 2) syncDiscoveredToolsInTx does not mutate memory when DB throws
    s.syncDiscoveredToolsInTx(['tool_ok'])
    expect(s.loadedTools()).toEqual(['tool_ok'])
    expect(() =>
      s.runInTransaction(() => {
        s.syncDiscoveredToolsInTx(['tool_rolled_back'])
        throw new Error('tx-abort')
      }),
    ).toThrow('tx-abort')
    expect(s.loadedTools()).toEqual(['tool_ok'])

    // 3) queryBranchRows handles cyclic parent_id without infinite recursion
    const cyc = new SessionStore('cyc-1', db)
    cyc.ensureSessionRow()
    const now = new Date().toISOString()
    db.run('PRAGMA foreign_keys = OFF')
    db.run(
      `INSERT INTO vela_messages (session_id, id, parent_id, seq, kind, role, content_json, include_in_context, created_at)
       VALUES ('cyc-1', 'm1', 'm2', 1, 'message', 'user', '"a"', 1, ?),
              ('cyc-1', 'm2', 'm1', 2, 'message', 'assistant', '"b"', 1, ?)`,
      now,
      now,
    )
    db.run('PRAGMA foreign_keys = ON')
    const branchRows = queryBranchRows(db, 'cyc-1', 'm2')
    expect(branchRows.map((r) => r.id)).toEqual(['m1', 'm2'])

    // 4) buildContext() returns latestAssistantUsage and seedFrom preserves usage & rewrites JSON paths
    const parentUploadDir = join(workDir, 'parent-uploads')
    const childUploadDir = join(workDir, 'child-uploads')
    const envDir = join(workDir, 'seed-env')
    mkdirSync(parentUploadDir, { recursive: true })
    mkdirSync(envDir, { recursive: true })
    const parentFile = join(envDir, 'upload.txt')
    writeFileSync(parentFile, 'uploaded content')

    const parentStore = new SessionStore('seed-parent', db, {
      uploadsDir: parentUploadDir,
    })
    const wrapEnv = (id: string, sub: string) => {
      const base = createLocalExecutionEnv({ cwd: envDir })
      return new Proxy(base, {
        get(target, prop) {
          if (prop === 'id') return id
          if (prop === 'absolutePath') {
            return (p: string, sig?: AbortSignal) =>
              p.startsWith('~/')
                ? base.absolutePath(join(envDir, sub, p.slice(2)), sig)
                : base.absolutePath(p, sig)
          }
          const val = Reflect.get(target, prop, target)
          return typeof val === 'function' ? val.bind(target) : val
        },
      })
    }
    const remoteLikeEnv = wrapEnv('docker:test', 'home-parent')
    const materializedPath = await parentStore.uploads.materialize(
      remoteLikeEnv,
      { name: 'upload.txt', hostPath: parentFile },
    )
    parentStore.appendMessage({
      role: 'user',
      content: `check [file: upload.txt, saved at ${materializedPath}]`,
    })
    parentStore.appendMessage(
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            toolCallId: 'tc-u',
            toolName: 'read',
            input: { path: materializedPath },
          },
        ],
      },
      { inputTokens: 120, outputTokens: 30 },
    )
    parentStore.appendMessage({
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          toolCallId: 'tc-u',
          toolName: 'read',
          output: { type: 'json', value: { resolved: materializedPath } },
        },
      ],
    })
    expect(parentStore.buildContext().latestAssistantUsage?.inputTokens).toBe(
      120,
    )

    const childStore = new SessionStore('seed-child', db, {
      uploadsDir: childUploadDir,
    })
    const childEnv = wrapEnv('docker:child', 'home-child')
    await childStore.seedFrom(
      parentStore.getBranch(),
      { id: parentStore.id, store: parentStore },
      async () => childEnv,
    )
    const childContext = childStore.buildContext()
    expect(childContext.latestAssistantUsage?.inputTokens).toBe(120)
    const serializedChild = JSON.stringify(childContext.messages)
    expect(serializedChild).not.toContain(materializedPath)
  } finally {
    db.close()
  }

  // 5) createVela cleans up temp dir when extension loading / init throws
  const beforeTmp = new Set(
    readdirSync(tmpdir()).filter((n) => n.startsWith('vela-')),
  )
  expect(() =>
    createVela({
      extensions: [
        () => {
          throw new Error('ext-boom')
        },
      ],
    }),
  ).toThrow('ext-boom')
  const afterTmp = readdirSync(tmpdir()).filter(
    (n) => n.startsWith('vela-') && !beforeTmp.has(n),
  )
  expect(afterTmp).toEqual([])
})

test('Round 1 Codex P1/P2 fixes: crash waiting_human preservation, flush rollback, hosted raw overflow, auto_retry_end, export guard', async () => {
  // 1) Crash recovery: ordinary prompt() hitting an unresolved prior-run approval leaves sessions.state = waiting_human
  const db = openDatabase({ path: ':memory:' })
  try {
    const crashStore = new SessionStore('crash-wh', db)
    crashStore.appendMessage({ role: 'user', content: 'run approved tool' })
    const asstMsg: ModelMessage = {
      role: 'assistant',
      content: [
        { type: 'tool_call', toolCallId: 'c1', toolName: 'risky', input: {} },
      ],
    }
    const asstEntry = crashStore.appendMessage(asstMsg)
    const now = new Date().toISOString()
    db.run(
      "INSERT INTO runs (id, session_id, driver, trigger, status, started_at, updated_at) VALUES ('old-run', 'crash-wh', 'vela', 'user', 'running', ?, ?)",
      now,
      now,
    )
    db.run(
      `INSERT INTO vela_tool_calls (id, session_id, run_id, assistant_message_id, tool_call_id, call_index, tool_name, input_json, execution_mode, replay, status, attempt, created_at, updated_at)
       VALUES ('row-wh', 'crash-wh', 'old-run', ?, 'c1', 0, 'risky', '{}', 'sequential', 'none', 'awaiting_approval', 0, ?, ?)`,
      asstEntry.id,
      now,
      now,
    )
    db.run(
      `INSERT INTO approvals (id, session_id, run_id, tool_call_row_id, tool_call_id, tool_name, summary, status, created_at)
       VALUES ('appr-wh', 'crash-wh', 'old-run', 'row-wh', 'c1', 'risky', 'need ok', 'pending', ?)`,
      now,
    )
    const reg = new ToolRegistry(join(workDir, 'crash-wh-spill'))
    reg.register({
      name: 'risky',
      description: 'risky',
      inputSchema: z.object({}),
      execute: async () => 'ok',
    })
    const drv = new VelaDriver({
      sessionId: 'crash-wh',
      db,
      store: crashStore,
      registry: reg,
      tracker: new TokenTracker(),
    })
    await expect(
      drv.run({
        model: createFauxModel({ responses: [fauxText('unused')] }),
        systemPrompt: '',
        messages: crashStore.buildContext().messages,
        recoverPending: true,
        allowWaitingHuman: false,
      }),
    ).rejects.toThrow('awaiting human approval')
    const sess = db.get<{ state: string; waiting_reason: string | null }>(
      'SELECT state, waiting_reason FROM sessions WHERE id = ?',
      'crash-wh',
    )
    expect(sess).toEqual({ state: 'waiting_human', waiting_reason: 'approval' })
    expect(
      db.all<{ status: string }>(
        "SELECT status FROM runs WHERE session_id = 'crash-wh' AND id != 'old-run'",
      ),
    ).toEqual([{ status: 'failed' }])

    // 2) SessionStore.flush() rolls back in-memory started/checked on DB error so retry persists
    const txFail = new SessionStore('flush-rb', db)
    txFail.appendCustom('note', { a: 1 })
    db.exec(`
      CREATE TRIGGER fail_msg_once BEFORE INSERT ON vela_messages
      WHEN NEW.session_id = 'flush-rb'
      BEGIN
        SELECT RAISE(ABORT, 'disk-io-fail');
      END;
    `)
    await expect(txFail.flush()).rejects.toThrow('disk-io-fail')
    expect(
      db.get('SELECT id FROM sessions WHERE id = ?', 'flush-rb'),
    ).toBeUndefined()
    db.exec('DROP TRIGGER fail_msg_once')
    await txFail.flush()
    expect(
      db.all<{ kind: string }>(
        'SELECT kind FROM vela_messages WHERE session_id = ?',
        'flush-rb',
      ),
    ).toEqual([{ kind: 'custom' }])

    // 3) Raw model_context_window_exceeded after hosted tool started does NOT compact/retry;
    //    transient retry ending in raw overflow emits auto_retry_end(false)
    let hostedRawCalls = 0
    const hostedRawModel = {
      specificationVersion: 'v4',
      provider: 'mock',
      modelId: 'm-hosted-raw',
      supportedUrls: {},
      hostedTools: async () => ({
        web_search: {
          type: 'provider',
          id: 'openai.web_search',
          name: 'web_search',
          args: {},
        },
      }),
      doGenerate: async () => {
        throw new Error('unused')
      },
      doStream: async () => {
        hostedRawCalls++
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'ws-1',
                toolName: 'web_search',
                input: '{}',
                providerExecuted: true,
              })
              controller.enqueue({
                type: 'tool-result',
                toolCallId: 'ws-1',
                toolName: 'web_search',
                result: { ok: true },
              })
              controller.enqueue({
                type: 'finish',
                finishReason: {
                  unified: 'other',
                  raw: 'model_context_window_exceeded',
                },
                usage: { inputTokens: 10, outputTokens: 5 },
              })
              controller.close()
            },
          }),
        } as never
      },
    } as unknown as LanguageModelV4
    let hostedCompactCount = 0
    const hostedRawStore = new SessionStore('drv-hosted-raw', db)
    const hostedRawMsgs: ModelMessage[] = [{ role: 'user', content: 'search' }]
    hostedRawStore.appendMessage(hostedRawMsgs[0]!)
    const hostedRawReg = new ToolRegistry(join(workDir, 'hosted-raw-spill'))
    hostedRawReg.register({
      name: 'web_search',
      description: 'hosted search',
      hostedOnly: true,
      inputSchema: z.object({ query: z.string() }),
      execute: async () => 'unused',
    })
    await expect(
      new VelaDriver({
        sessionId: 'drv-hosted-raw',
        db,
        store: hostedRawStore,
        registry: hostedRawReg,
        tracker: new TokenTracker(),
      }).run({
        model: hostedRawModel,
        systemPrompt: '',
        messages: hostedRawMsgs,
        compactOnOverflow: async () => {
          hostedCompactCount++
        },
      }),
    ).rejects.toThrow('model_context_window_exceeded')
    expect(hostedCompactCount).toBe(0)
    expect(hostedRawCalls).toBe(1)

    let retryThenRawCalls = 0
    const retryRawEvents: string[] = []
    const retryRawEnds: Array<{ success: boolean; attempt: number }> = []
    const retryThenRawModel = {
      specificationVersion: 'v4',
      provider: 'mock',
      modelId: 'm-retry-raw',
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error('unused')
      },
      doStream: async () => {
        retryThenRawCalls++
        if (retryThenRawCalls === 1) throw new Error('ECONNRESET')
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: 'finish',
                finishReason: {
                  unified: 'other',
                  raw: 'model_context_window_exceeded',
                },
                usage: { inputTokens: 10, outputTokens: 1 },
              })
              controller.close()
            },
          }),
        } as never
      },
    } as unknown as LanguageModelV4
    const retryRawStore = new SessionStore('drv-retry-raw', db)
    const retryRawMsgs: ModelMessage[] = [{ role: 'user', content: 'hi' }]
    retryRawStore.appendMessage(retryRawMsgs[0]!)
    await expect(
      new VelaDriver({
        sessionId: 'drv-retry-raw',
        db,
        store: retryRawStore,
        registry: new ToolRegistry(join(workDir, 'retry-raw-spill')),
        tracker: new TokenTracker(),
        onEvent: (e) => {
          retryRawEvents.push(e.type)
          if (e.type === 'auto_retry_end') {
            retryRawEnds.push({ success: e.success, attempt: e.attempt })
          }
        },
      }).run({
        model: retryThenRawModel,
        systemPrompt: '',
        messages: retryRawMsgs,
        limits: { maxRetries: 1, retryBaseMs: 0 },
      }),
    ).rejects.toThrow('model_context_window_exceeded')
    expect(retryRawEnds).toEqual([{ success: false, attempt: 1 }])
    expect(retryRawEvents).toContain('auto_retry_start')

    // 4) Waiting human `turn_end` carries completed earlier sequential toolResults
    const stepWhStore = new SessionStore('step-wh-res', db)
    const whMsgs: ModelMessage[] = [{ role: 'user', content: 'two steps' }]
    stepWhStore.appendMessage(whMsgs[0]!)
    const whReg = new ToolRegistry(join(workDir, 'step-wh-spill'))
    whReg.register({
      name: 'fast_ok',
      description: 'succeeds first',
      executionMode: 'sequential',
      inputSchema: z.object({}),
      execute: async () => 'fast-output',
    })
    whReg.register({
      name: 'need_ok',
      description: 'waits approval',
      executionMode: 'sequential',
      inputSchema: z.object({}),
      execute: async () => 'approved-output',
    })
    whReg.setInterception({
      before: async (toolName, input) =>
        toolName === 'need_ok'
          ? { block: false, input, approval: { summary: 'confirm' } }
          : { block: false, input },
    })
    let whTurnEnd: { toolResults: unknown[] } | undefined
    const whRes = await new VelaDriver({
      sessionId: 'step-wh-res',
      db,
      store: stepWhStore,
      registry: whReg,
      tracker: new TokenTracker(),
      onEvent: (e) => {
        if (e.type === 'turn_end') whTurnEnd = { toolResults: e.toolResults }
      },
    }).run({
      model: createFauxModel({
        responses: [
          {
            toolCalls: [
              { name: 'fast_ok', input: {}, id: 'tc-fast' },
              { name: 'need_ok', input: {}, id: 'tc-need' },
            ],
          },
        ],
      }),
      systemPrompt: '',
      messages: whMsgs,
    })
    expect(whRes.reason).toBe('waiting_human')
    expect(whTurnEnd?.toolResults).toHaveLength(1)
  } finally {
    db.close()
  }

  // 5) exportSavedSession refuses overwriting vela.db, -wal, -shm, or a symlink alias
  const exportDir = join(workDir, 'export-guard')
  mkdirSync(exportDir, { recursive: true })
  const guardDbPath = join(exportDir, 'vela.db')
  const guardDb = openDatabase({ path: guardDbPath })
  try {
    const s = new SessionStore('exp-guard', guardDb)
    s.appendMessage({ role: 'user', content: 'hello' })
  } finally {
    guardDb.close()
  }
  const dbAlias = join(exportDir, 'db-alias.html')
  symlinkSync(guardDbPath, dbAlias)
  const dbHardlink = join(exportDir, 'db-hardlink.html')
  linkSync(guardDbPath, dbHardlink)
  for (const dangerous of [
    guardDbPath,
    `${guardDbPath}-wal`,
    `${guardDbPath}-shm`,
    dbAlias,
    dbHardlink,
  ]) {
    await expect(
      exportSavedSession({
        dataDir: exportDir,
        sessionId: 'exp-guard',
        outputPath: dangerous,
        baseCwd: exportDir,
      }),
    ).rejects.toThrow('Refusing to overwrite database file')
  }
})

test('Round 1 Codex P2 fixes: steer after async before-hook, per-wave resolveEnv, entriesToMessages, branch-scoped compressor failures, default-model calibration reset, inspectSession hooks', async () => {
  const db = openDatabase({ path: ':memory:' })
  try {
    // 1) Steer arriving during async interception.before skips call & avoids approval + resolveEnv runs per wave
    const store = new SessionStore('steer-wave', db)
    const msg: ModelMessage = {
      role: 'assistant',
      content: [
        {
          type: 'tool_call',
          toolCallId: 's1',
          toolName: 'wave_tool',
          input: {},
        },
        {
          type: 'tool_call',
          toolCallId: 's2',
          toolName: 'wave_tool',
          input: {},
        },
      ],
    }
    const asstEntry = store.appendMessage(msg)
    const now = new Date().toISOString()
    db.run(
      "INSERT INTO runs (id, session_id, driver, trigger, status, started_at, updated_at) VALUES ('r-sw', 'steer-wave', 'vela', 'user', 'running', ?, ?)",
      now,
      now,
    )
    const reg = new ToolRegistry(join(workDir, 'sw-spill'))
    let envCalls = 0
    reg.register({
      name: 'wave_tool',
      description: 'runs sequentially across waves',
      executionMode: 'sequential',
      inputSchema: z.object({}),
      execute: async (_i, ctx) => {
        await ctx?.requireEnv?.()
        return 'ran'
      },
    })
    const localEnv = createLocalExecutionEnv({ cwd: workDir })
    reg.setInterception({
      resolveEnv: async () => {
        envCalls++
        return localEnv
      },
    })
    db.run(
      `INSERT INTO vela_tool_calls (id, session_id, run_id, assistant_message_id, tool_call_id, call_index, tool_name, input_json, execution_mode, replay, status, attempt, created_at, updated_at)
       VALUES ('sw-1', 'steer-wave', 'r-sw', ?, 's1', 0, 'wave_tool', '{}', 'sequential', 'none', 'pending', 0, ?, ?),
              ('sw-2', 'steer-wave', 'r-sw', ?, 's2', 1, 'wave_tool', '{}', 'sequential', 'none', 'pending', 0, ?, ?)`,
      asstEntry.id,
      now,
      now,
      asstEntry.id,
      now,
      now,
    )
    await executeStepCalls({
      db,
      store,
      registry: reg,
      sessionId: 'steer-wave',
      rows: loadStepToolCallRows(db, 'steer-wave', asstEntry.id),
      emit: () => {},
    })
    expect(envCalls).toBe(2)

    const steerStore = new SessionStore('steer-async', db)
    const asstSteer = steerStore.appendMessage({
      role: 'assistant',
      content: [
        { type: 'tool_call', toolCallId: 'st1', toolName: 'gated', input: {} },
      ],
    })
    db.run(
      "INSERT INTO runs (id, session_id, driver, trigger, status, started_at, updated_at) VALUES ('r-st', 'steer-async', 'vela', 'user', 'running', ?, ?)",
      now,
      now,
    )
    db.run(
      `INSERT INTO vela_tool_calls (id, session_id, run_id, assistant_message_id, tool_call_id, call_index, tool_name, input_json, execution_mode, replay, status, attempt, created_at, updated_at)
       VALUES ('st-1', 'steer-async', 'r-st', ?, 'st1', 0, 'gated', '{}', 'sequential', 'none', 'pending', 0, ?, ?)`,
      asstSteer.id,
      now,
      now,
    )
    let steered = false
    const stReg = new ToolRegistry(join(workDir, 'st-spill'))
    stReg.register({
      name: 'gated',
      description: 'gated tool',
      inputSchema: z.object({}),
      execute: async () => 'should-not-run',
    })
    stReg.setInterception({
      before: async (_name, input) => {
        steered = true
        return { block: false, input, approval: { summary: 'confirm' } }
      },
    })
    const stRes = await executeStepCalls({
      db,
      store: steerStore,
      registry: stReg,
      sessionId: 'steer-async',
      rows: loadStepToolCallRows(db, 'steer-async', asstSteer.id),
      emit: () => {},
      shouldSkipForSteer: () => steered,
    })
    expect(stRes.waitingHuman).toBe(false)
    expect(
      loadStepToolCallRows(db, 'steer-async', asstSteer.id)[0]?.status,
    ).toBe('skipped')

    // 2) entriesToMessages filters out superseded compaction entries inside kept slices
    const compactedMsgs = entriesToMessages([
      {
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: now,
        message: { role: 'user', content: 'kept before old compaction' },
      },
      {
        type: 'compaction',
        id: 'c-old',
        parentId: 'e1',
        timestamp: now,
        summary: 'OLD SUPERSEDED SUMMARY',
        firstKeptEntryId: 'e1',
        tokensBefore: 100,
      },
      {
        type: 'message',
        id: 'e2',
        parentId: 'c-old',
        timestamp: now,
        message: { role: 'user', content: 'after old compaction' },
      },
      {
        type: 'compaction',
        id: 'c-new',
        parentId: 'e2',
        timestamp: now,
        summary: 'LATEST ACTIVE SUMMARY',
        firstKeptEntryId: 'e1',
        tokensBefore: 200,
      },
    ])
    const serialized = JSON.stringify(compactedMsgs)
    expect(serialized).toContain('LATEST ACTIVE SUMMARY')
    expect(serialized).not.toContain('OLD SUPERSEDED SUMMARY')

    // 3) Failed DB tool call on another branch with same tool_call_id does not suppress summarized branch write
    const compStore = new SessionStore('comp-scoped', db)
    const rootMsg: ModelMessage = { role: 'user', content: 'go' }
    compStore.appendMessage(rootMsg)
    const branchB = compStore.appendMessage({
      role: 'assistant',
      content: [
        {
          type: 'tool_call',
          toolCallId: 'shared-call-id',
          toolName: 'write',
          input: { path: 'failed-other.ts' },
        },
      ],
    })
    db.run(
      "INSERT INTO runs (id, session_id, driver, trigger, status, started_at, updated_at) VALUES ('r-cs', 'comp-scoped', 'vela', 'user', 'completed', ?, ?)",
      now,
      now,
    )
    db.run(
      `INSERT INTO vela_tool_calls (id, session_id, run_id, assistant_message_id, tool_call_id, call_index, tool_name, input_json, execution_mode, replay, status, attempt, is_error, created_at, updated_at)
       VALUES ('cs-fail', 'comp-scoped', 'r-cs', ?, 'shared-call-id', 0, 'write', '{}', 'parallel', 'none', 'failed', 1, 1, ?, ?)`,
      branchB.id,
      now,
      now,
    )
    compStore.branch(compStore.getEntries()[0]!.id)
    const okWriteMsg: ModelMessage = {
      role: 'assistant',
      content: [
        {
          type: 'tool_call',
          toolCallId: 'shared-call-id',
          toolName: 'write',
          input: { path: 'good-branch.ts' },
        },
      ],
    }
    const okToolMsg: ModelMessage = {
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          toolCallId: 'shared-call-id',
          toolName: 'write',
          output: { type: 'text', value: 'ok' },
        },
      ],
    }
    const okEntry = compStore.appendMessage(okWriteMsg)
    compStore.appendMessage(okToolMsg)
    db.run(
      `INSERT INTO vela_tool_calls (id, session_id, run_id, assistant_message_id, tool_call_id, call_index, tool_name, input_json, execution_mode, replay, status, attempt, is_error, created_at, updated_at)
       VALUES ('cs-ok', 'comp-scoped', 'r-cs', ?, 'shared-call-id', 0, 'write', '{}', 'parallel', 'none', 'completed', 1, 0, ?, ?)`,
      okEntry.id,
      now,
      now,
    )
    const summaryReq = await createRequestSnapshot(
      createFauxModel({ generate: [fauxText('Done summary')] }),
      '',
      { sdkTools: {}, toolDefinitions: [], hasHostedTools: false },
      [rootMsg, okWriteMsg, okToolMsg],
    )
    const summaryOut = await summarize(
      summaryReq,
      compStore,
      new TokenTracker(),
      100_000,
      undefined,
      0,
    )
    expect(summaryOut.summary).toContain(
      '<modified-files>\ngood-branch.ts\n</modified-files>',
    )
  } finally {
    db.close()
  }

  // 4) SessionDefaultState remembers lastResolvedRef across defaults.apply() model switches
  //    and inspectSession passes both the hooked model and the current reasoning level.
  const state = new SessionDefaultState(
    { model: 'm/a', thinkingLevel: 'medium', limitOverrides: {} },
    {},
  )
  expect(state.lastResolvedRef).toBeUndefined()
  const seenInspectReasonings: Array<string | undefined> = []
  let hostedToolUnblocked = ''
  let hostedToolBlocked = ''
  const mkMockProviders = (getHostedName: () => string) => ({
    mock: {
      models: [
        { id: 'a', name: 'a', contextWindow: 100_000, reasoning: true },
        { id: 'b', name: 'b', contextWindow: 200_000 },
      ],
      createModel: (id: string) =>
        Object.assign(createFauxModel({ modelId: id }), {
          hostedTools: async (opts?: { reasoning?: string }) => {
            seenInspectReasonings.push(opts?.reasoning)
            const toolName = getHostedName()
            return opts?.reasoning === 'high' && toolName
              ? {
                  [toolName]: {
                    type: 'provider',
                    id: 'p.h',
                    name: toolName,
                    args: {},
                  },
                }
              : {}
          },
        }),
    },
  })
  const v = createVela({
    model: 'mock/a',
    thinkingLevel: 'high',
    providers: mkMockProviders(() => hostedToolUnblocked),
    extensions: [
      (api) => {
        hostedToolUnblocked = api.registerTool({
          name: 'hosted_sample',
          description: 'A hosted tool gated by hook and reasoning',
          hostedOnly: true,
          inputSchema: z.object({}),
          execute: async () => 'x',
        })
      },
    ],
  })
  const vScoped = createVela({
    model: 'mock/a',
    thinkingLevel: 'high',
    providers: mkMockProviders(() => hostedToolBlocked),
    extensions: [
      (api) => {
        hostedToolBlocked = api.registerTool({
          name: 'hosted_sample',
          description: 'A hosted tool gated by scoped hook',
          hostedOnly: true,
          inputSchema: z.object({}),
          execute: async () => 'x',
        })
        api.on('tool_call', hostedToolBlocked, () => ({
          block: true,
          reason: 'no',
        }))
      },
    ],
  })
  try {
    const s = v.session('inspect-s')
    await s.resources()
    s.setActiveTools([hostedToolUnblocked])
    const unblocked = await inspectSession(v, s)
    expect(unblocked.toolDescriptionChars).toBeGreaterThan(2)
    expect(seenInspectReasonings.at(-1)).toBe('high')

    s.setThinkingLevel('low')
    const lowReasoning = await inspectSession(v, s)
    expect(seenInspectReasonings.at(-1)).toBe('low')
    expect(lowReasoning.toolDescriptionChars).toBe(2)

    const sScoped = vScoped.session('inspect-scoped', { model: 'mock/a' })
    await sScoped.resources()
    sScoped.setActiveTools([hostedToolBlocked])
    const blocked = await inspectSession(vScoped, sScoped)
    expect(blocked.toolDescriptionChars).toBe(2) // '[]' (hosted_sample omitted by scoped tool_call hook)

    // Simulate project default model change resetting `defaults.resolved`
    const internal = s as unknown as {
      tracker: TokenTracker
      defaults: SessionDefaultState
    }
    internal.tracker.setContextDelta(2500)
    internal.tracker.updateFromAPI(40_000, 500, 0)
    expect(internal.tracker.reportedContextTokens).toBe(40_500)
    internal.defaults.apply(
      { model: 'mock/b', limits: {} },
      (s as unknown as { store: SessionStore }).store,
      { ...s.contextManager.limits },
      s.contextManager,
    )
    expect(s.modelInfo.ref).toBe('mock/b')
    expect(internal.tracker.reportedContextTokens).toBeUndefined()
    expect(internal.tracker.contextDelta).toBe(0)
  } finally {
    await v.dispose()
    await vScoped.dispose()
  }
})

test('Round 2 Codex P2 fixes: chained approvals in continueInterrupted, steer during input validation, hosted turn_end, retry producer refresh, ancestor-trimmed entriesToMessages, same-branch transcript failures', async () => {
  const db = openDatabase({ path: ':memory:' })
  try {
    // 1) Public SDK continueInterrupted() cleanly suspends on a second sequential approval
    let gateTool = ''
    const ranCalls: string[] = []
    const chainedFaux = createFauxModel({
      responses: [
        () => ({
          toolCalls: [
            { name: gateTool, input: { step: 'first' }, id: 'ch-1' },
            { name: gateTool, input: { step: 'second' }, id: 'ch-2' },
          ],
        }),
        fauxText('both done'),
      ],
    })
    const chainedReasons: string[] = []
    const chainedVela = createVela({
      db,
      model: 'mock/chained',
      providers: {
        mock: {
          models: [{ id: 'chained', name: 'chained' }],
          createModel: () => chainedFaux,
        },
      },
      extensions: [
        (api) => {
          gateTool = api.registerTool({
            name: 'chain_gate',
            description: 'sequential gated tool',
            executionMode: 'sequential',
            inputSchema: z.object({ step: z.string() }),
            execute: async ({ step }) => {
              ranCalls.push(step)
              return `ok:${step}`
            },
          })
          api.on('tool_call', gateTool, () => ({
            approval: { summary: 'approve step' },
          }))
        },
      ],
    })
    try {
      const cs = chainedVela.session('chained-wh')
      cs.subscribe((ev) => {
        if (ev.type === 'agent_end') chainedReasons.push(ev.reason)
      })
      await cs.prompt('run two gated calls')
      const p1 = cs.pendingApprovals()
      expect(p1).toHaveLength(1)
      cs.resolveApproval(p1[0]!.id, { approved: true })
      await cs.continueInterrupted()
      expect(ranCalls).toEqual(['first'])
      expect(chainedReasons).toEqual(['waiting_human', 'waiting_human'])
      const p2 = cs.pendingApprovals()
      expect(p2).toHaveLength(1)
      cs.resolveApproval(p2[0]!.id, { approved: true })
      await cs.continueInterrupted()
      expect(ranCalls).toEqual(['first', 'second'])
      expect(chainedReasons).toEqual(['waiting_human', 'waiting_human', 'done'])
    } finally {
      await chainedVela.dispose()
    }

    // 2) Steer queued while async validateInput runs after interception.before mutates input skips call
    const valStore = new SessionStore('steer-val', db)
    const now = new Date().toISOString()
    const asstVal = valStore.appendMessage({
      role: 'assistant',
      content: [
        {
          type: 'tool_call',
          toolCallId: 'sv-1',
          toolName: 'val_gate',
          input: { flag: false },
        },
      ],
    })
    db.run(
      "INSERT INTO runs (id, session_id, driver, trigger, status, started_at, updated_at) VALUES ('r-sv', 'steer-val', 'vela', 'user', 'running', ?, ?)",
      now,
      now,
    )
    db.run(
      `INSERT INTO vela_tool_calls (id, session_id, run_id, assistant_message_id, tool_call_id, call_index, tool_name, input_json, execution_mode, replay, status, attempt, created_at, updated_at)
       VALUES ('sv-row', 'steer-val', 'r-sv', ?, 'sv-1', 0, 'val_gate', '{"flag":false}', 'sequential', 'none', 'pending', 0, ?, ?)`,
      asstVal.id,
      now,
      now,
    )
    let steerArrived = false
    const valReg = new ToolRegistry(join(workDir, 'sv-spill'))
    valReg.register({
      name: 'val_gate',
      description: 'async refine schema',
      inputSchema: z.object({ flag: z.boolean() }).refine(async (val) => {
        if (val.flag) steerArrived = true
        return true
      }),
      execute: async () => 'must-not-run',
    })
    valReg.setInterception({
      before: async () => ({
        block: false,
        input: { flag: true },
        approval: { summary: 'confirm' },
      }),
    })
    const valRes = await executeStepCalls({
      db,
      store: valStore,
      registry: valReg,
      sessionId: 'steer-val',
      rows: loadStepToolCallRows(db, 'steer-val', asstVal.id),
      emit: () => {},
      shouldSkipForSteer: () => steerArrived,
    })
    expect(valRes.waitingHuman).toBe(false)
    expect(loadStepToolCallRows(db, 'steer-val', asstVal.id)[0]?.status).toBe(
      'skipped',
    )

    // 3) Waiting human turn_end preserves completed hosted web_search toolResult alongside pending local call
    const hostedWhStore = new SessionStore('hosted-wh-turnend', db)
    const hMsgs: ModelMessage[] = [
      { role: 'user', content: 'search then edit' },
    ]
    hostedWhStore.appendMessage(hMsgs[0]!)
    const hReg = new ToolRegistry(join(workDir, 'hwh-spill'))
    hReg.register({
      name: 'web_search',
      description: 'hosted search',
      hostedOnly: true,
      inputSchema: z.object({ query: z.string() }),
      execute: async () => 'unused',
    })
    hReg.register({
      name: 'local_gate',
      description: 'local approval tool',
      executionMode: 'sequential',
      inputSchema: z.object({}),
      execute: async () => 'done',
    })
    hReg.setInterception({
      before: async (toolName, input) =>
        toolName === 'local_gate'
          ? { block: false, input, approval: { summary: 'ok?' } }
          : { block: false, input },
    })
    let hostedTurnResults: Array<{ toolCallId: string; toolName: string }> = []
    const hostedWhModel = {
      specificationVersion: 'v4',
      provider: 'mock',
      modelId: 'm-hwh',
      supportedUrls: {},
      hostedTools: async () => ({
        web_search: {
          type: 'provider',
          id: 'openai.web_search',
          name: 'web_search',
          args: {},
        },
      }),
      doGenerate: async () => {
        throw new Error('unused')
      },
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({
              type: 'tool-call',
              toolCallId: 'ws-h1',
              toolName: 'web_search',
              input: '{"query":"vela"}',
              providerExecuted: true,
            })
            controller.enqueue({
              type: 'tool-result',
              toolCallId: 'ws-h1',
              toolName: 'web_search',
              result: { hits: ['v1'] },
            })
            controller.enqueue({
              type: 'tool-call',
              toolCallId: 'loc-1',
              toolName: 'local_gate',
              input: '{}',
            })
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
              usage: { inputTokens: 10, outputTokens: 5 },
            })
            controller.close()
          },
        }),
      }),
    } as unknown as LanguageModelV4
    const hRes = await new VelaDriver({
      sessionId: 'hosted-wh-turnend',
      db,
      store: hostedWhStore,
      registry: hReg,
      tracker: new TokenTracker(),
      onEvent: (ev) => {
        if (ev.type === 'turn_end') {
          hostedTurnResults = ev.toolResults.map((r) => ({
            toolCallId: r.toolCallId,
            toolName: r.toolName,
          }))
        }
      },
    }).run({
      model: hostedWhModel,
      systemPrompt: '',
      messages: hMsgs,
    })
    expect(hRes.reason).toBe('waiting_human')
    expect(hostedTurnResults).toEqual([
      { toolCallId: 'ws-h1', toolName: 'web_search' },
    ])

    // 4) Credential switch during auto_retry_start updates transformContext producer and persisted produced_by
    const retryProdStore = new SessionStore('retry-prod', db)
    const priorMsg: ModelMessage = { role: 'user', content: 'hello' }
    retryProdStore.appendMessage(priorMsg)
    const rpMsgs: ModelMessage[] = [priorMsg]
    let isOAuth = true
    let rpAttempts = 0
    const seenProducers: string[] = []
    const retryProdModel = {
      specificationVersion: 'v4',
      provider: 'mock',
      modelId: 'm-rp',
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error('unused')
      },
      doStream: async () => {
        rpAttempts++
        if (rpAttempts === 1) throw new Error('ECONNRESET')
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'text-start', id: 't1' })
              controller.enqueue({ type: 'text-delta', id: 't1', delta: 'ok' })
              controller.enqueue({ type: 'text-end', id: 't1' })
              controller.enqueue({
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: { inputTokens: 5, outputTokens: 2 },
              })
              controller.close()
            },
          }),
        } as never
      },
    } as unknown as LanguageModelV4
    await new VelaDriver({
      sessionId: 'retry-prod',
      db,
      store: retryProdStore,
      registry: new ToolRegistry(join(workDir, 'rp-spill')),
      tracker: new TokenTracker(),
      onEvent: (ev) => {
        if (ev.type === 'auto_retry_start') isOAuth = false
      },
    }).run({
      model: retryProdModel,
      producer: () => (isOAuth ? 'mock/m-rp:oauth' : 'mock/m-rp'),
      systemPrompt: '',
      messages: rpMsgs,
      limits: { maxRetries: 1, retryBaseMs: 0 },
      transformContext: async (msgs, producer) => {
        seenProducers.push(producer)
        return msgs
      },
    })
    expect(seenProducers).toEqual(['mock/m-rp:oauth', 'mock/m-rp'])
    expect(
      db.get<{ produced_by: string | null }>(
        "SELECT produced_by FROM vela_messages WHERE session_id = 'retry-prod' AND role = 'assistant' ORDER BY seq DESC LIMIT 1",
      )?.produced_by,
    ).toBe('mock/m-rp')

    // 5) entriesToMessages filters superseded compaction even when firstKeptEntryId precedes the slice
    const branchSliceMsgs = entriesToMessages([
      {
        type: 'message',
        id: 'b1',
        parentId: 'common-ancestor',
        timestamp: now,
        message: { role: 'user', content: 'branch turn 1' },
      },
      {
        type: 'compaction',
        id: 'c-superseded',
        parentId: 'b1',
        timestamp: now,
        summary: 'OLD BRANCH CHECKPOINT',
        firstKeptEntryId: 'common-ancestor',
        tokensBefore: 50,
      },
      {
        type: 'message',
        id: 'b2',
        parentId: 'c-superseded',
        timestamp: now,
        message: { role: 'user', content: 'branch turn 2' },
      },
      {
        type: 'compaction',
        id: 'c-latest',
        parentId: 'b2',
        timestamp: now,
        summary: 'LATEST BRANCH CHECKPOINT',
        firstKeptEntryId: 'common-ancestor',
        tokensBefore: 100,
      },
    ])
    const branchText = JSON.stringify(branchSliceMsgs)
    expect(branchText).toContain('LATEST BRANCH CHECKPOINT')
    expect(branchText).toContain('branch turn 1')
    expect(branchText).toContain('branch turn 2')
    expect(branchText).not.toContain('OLD BRANCH CHECKPOINT')

    // 6) In-memory/transcript summarize() scopes failed tool_result by matching call instance
    const sameBranchStore = new SessionStore('same-branch-id', db)
    const sbReq = await createRequestSnapshot(
      createFauxModel({ generate: [fauxText('Same branch summary')] }),
      '',
      { sdkTools: {}, toolDefinitions: [], hasHostedTools: false },
      [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              toolCallId: 'dup-id',
              toolName: 'write',
              input: { path: 'failed.ts' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              toolCallId: 'dup-id',
              toolName: 'write',
              output: { type: 'error-text', value: 'disk full' },
            },
          ],
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              toolCallId: 'dup-id',
              toolName: 'write',
              input: { path: 'success.ts' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              toolCallId: 'dup-id',
              toolName: 'write',
              output: { type: 'text', value: 'wrote success.ts' },
            },
          ],
        },
      ],
    )
    const sbOut = await summarize(
      sbReq,
      sameBranchStore,
      new TokenTracker(),
      100_000,
      undefined,
      0,
    )
    expect(sbOut.summary).toContain(
      '<modified-files>\nsuccess.ts\n</modified-files>',
    )
    expect(sbOut.summary).not.toContain('failed.ts')
  } finally {
    db.close()
  }
})
