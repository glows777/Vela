import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'zod'
import { z as z3 } from 'zod/v3'
import { createVela } from '../../../src/driver/index.ts'
import {
  fromAiResponseMessage,
  toAiModelMessages,
} from '../../../src/providers/messages.ts'
import type { ChannelAdapter } from '../../../src/runtime/channels.ts'
import type {
  RuntimeEvent,
  StreamDeltaEvent,
} from '../../../src/runtime/events.ts'
import type { VelaMessage } from '../../../src/shared/messages.ts'
import {
  createJsonSchema,
  toJsonSchema,
  validateToolInput,
} from '../../../src/shared/tool-schema.ts'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '../../../src/testing/core/index.ts'

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
          toolName: 'read',
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
          toolName: 'read',
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
        toolName: 'read',
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
        toolName: 'read',
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

test('resuming an SQLite session with an interrupted tool-call reconciles and calls the model', async () => {
  const { openDatabase } = await import('../../../src/db/index.ts')
  const { SessionStore } = await import('../../../src/driver/session/index.ts')
  const dir = mkdtempSync(join(tmpdir(), 'vela-s1a-legacy-recover-'))
  try {
    const dataDir = join(dir, 'data')
    mkdirSync(dataDir, { recursive: true })
    const db = openDatabase({ path: join(dataDir, 'vela.db') })
    try {
      const store = new SessionStore('legacy-recover', db, { cwd: dir })
      store.appendMessage({ role: 'user', content: 'run it' })
      const assistant = store.appendMessage({
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            toolCallId: 'call-1',
            toolName: 'bash',
            input: { command: 'echo hi' },
          },
        ],
      })
      const now = new Date().toISOString()
      db.run(
        `INSERT INTO runs (id, session_id, driver, trigger, status, started_at, updated_at)
         VALUES ('run-1', 'legacy-recover', 'vela', 'user', 'running', ?, ?)`,
        now,
        now,
      )
      db.run(
        `INSERT INTO vela_tool_calls (
           id, session_id, run_id, assistant_message_id, tool_call_id, call_index,
           tool_name, input_json, execution_mode, replay, status, attempt, is_error,
           location_json, created_at, updated_at
         ) VALUES ('tc-1', 'legacy-recover', 'run-1', ?, 'call-1', 0, 'bash', '{"command":"echo hi"}', 'sequential', 'none', 'running', 1, 0, ?, ?, ?)`,
        assistant.id,
        JSON.stringify({ environment: 'local', cwd: dir }),
        now,
        now,
      )
    } finally {
      db.close()
    }

    const model = createFauxModel({ responses: [fauxText('recovered ok')] })
    const vela = createVela({ cwd: dir, dataDir, model, contextFiles: false })
    try {
      const session = vela.session('legacy-recover')
      await session.resume()
      await session.continueInterrupted()
      expect(model.calls).toHaveLength(1)
      expect(JSON.stringify(model.calls[0]!.prompt)).toContain('call-1')
    } finally {
      await vela.dispose()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resuming an SQLite session preserves previously discovered deferred tools', async () => {
  const { openDatabase } = await import('../../../src/db/index.ts')
  const { SessionStore } = await import('../../../src/driver/session/index.ts')
  const dir = mkdtempSync(join(tmpdir(), 'vela-s1a-legacy-tools-'))
  try {
    const dataDir = join(dir, 'data')
    mkdirSync(dataDir, { recursive: true })
    const db = openDatabase({ path: join(dataDir, 'vela.db') })
    try {
      const store = new SessionStore('legacy-tools', db, { cwd: dir })
      store.appendMessage({ role: 'user', content: 'find lookup' })
      store.appendMessage({ role: 'assistant', content: 'Loaded ext_lookup.' })
      store.setDiscoveredTools(['ext_lookup'])
    } finally {
      db.close()
    }

    const model = createFauxModel({ responses: [fauxText('ready')] })
    const vela = createVela({
      cwd: dir,
      dataDir,
      model,
      contextFiles: false,
      extensions: [
        function ext(api) {
          api.registerTool({
            name: 'lookup',
            description: 'Lookup by zip',
            exposure: 'deferred',
            inputSchema: z.object({ zipcode: z.string() }),
            execute: async () => 'ok',
          })
        },
      ],
    })
    try {
      const session = vela.session('legacy-tools')
      await session.resume()
      await session.prompt('use it')
      expect(model.calls[0]!.tools).toContain('ext_lookup')
    } finally {
      await vela.dispose()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resuming an SQLite session with {type:"file"} image preserves bytes and mediaType', async () => {
  const { openDatabase } = await import('../../../src/db/index.ts')
  const { SessionStore } = await import('../../../src/driver/session/index.ts')
  const dir = mkdtempSync(join(tmpdir(), 'vela-s1a-legacy-img-'))
  try {
    const dataDir = join(dir, 'data')
    mkdirSync(dataDir, { recursive: true })
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const db = openDatabase({ path: join(dataDir, 'vela.db') })
    try {
      const store = new SessionStore('legacy-img', db, { cwd: dir })
      store.appendMessage({
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this' },
          { type: 'image', data: pngBase64, mimeType: 'image/png' },
        ],
      })
      store.appendMessage({ role: 'assistant', content: 'Saw it.' })
    } finally {
      db.close()
    }

    const model = createFauxModel({ responses: [fauxText('still see it')] })
    const vela = createVela({ cwd: dir, dataDir, model, contextFiles: false })
    try {
      const session = vela.session('legacy-img')
      await session.resume()
      await session.prompt('describe again')
      const userParts = model.calls[0]!.prompt.flatMap((m) =>
        m.role === 'user' ? m.content : [],
      )
      const filePart = userParts.find((p) => p.type === 'file')
      expect(filePart).toBeDefined()
      expect(
        filePart && filePart.type === 'file' ? filePart.mediaType : '',
      ).toBe('image/png')
      expect(
        JSON.stringify(
          filePart && filePart.type === 'file' ? filePart.data : '',
        ),
      ).toContain(pngBase64)
    } finally {
      await vela.dispose()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('deferred Zod v3 tool preserves parameter names for tool_search discovery', async () => {
  const model = createFauxModel({
    responses: [
      fauxToolCall('tool_search', { query: 'zipcode' }),
      fauxText('found'),
    ],
  })
  const vela = createVela({
    model,
    contextFiles: false,
    extensions: [
      function ext(api) {
        api.registerTool({
          name: 'lookup',
          description: 'Generic query tool',
          exposure: 'deferred',
          inputSchema: z3.object({
            zipcode: z3.string().describe('Postal code'),
          }),
          execute: async () => '94107',
        })
      },
    ],
  })
  try {
    const session = vela.session('zod3-discovery')
    await session.prompt('find zipcode tool')
    expect(model.calls[1]!.tools).toContain('ext_lookup')
  } finally {
    await vela.dispose()
  }
})

test('invalid ModelHandle is rejected cleanly at SDK boundary', async () => {
  const fake = {
    specificationVersion: 'v4',
    provider: 'demo',
    modelId: 'review',
  }
  const vela = createVela({ model: fake, contextFiles: false })
  try {
    const session = vela.session('bad-model')
    await expect(session.prompt('hi')).rejects.toThrow('Invalid ModelHandle')
  } finally {
    await vela.dispose()
  }
})

test('hosted tools are preserved in resolveProviderTools without wrapping client execute', async () => {
  const { resolveProviderTools } = await import(
    '../../../src/providers/runtime.ts'
  )
  const { ToolRegistry } = await import('../../../src/driver/tools/registry.ts')
  const { tool } = await import('ai')
  let executions = 0
  const model = Object.assign(
    createFauxModel({
      responses: [fauxToolCall('local_shell', { cmd: 'echo hi' })],
    }),
    {
      hostedTools: async () => ({
        local_shell: tool({
          description: 'Hosted local shell',
          inputSchema: z.object({ cmd: z.string() }),
          execute: async () => {
            executions++
            return { output: 'ran' }
          },
        }),
      }),
    },
  )
  const registry = new ToolRegistry()
  registry.register({
    name: 'local_shell',
    description: 'probe',
    inputSchema: z.object({ cmd: z.string() }),
    execute: async () => 'unused',
  })
  const resolved = await resolveProviderTools(model, registry.toProviderTools())
  expect(resolved.sdkTools.local_shell?.execute).toBeDefined()
  expect(executions).toBe(0)
})

test('resuming a transcript with tool-approval-request preserves approval parts in both directions', async () => {
  const { openDatabase } = await import('../../../src/db/index.ts')
  const { SessionStore } = await import('../../../src/driver/session/index.ts')
  const dir = mkdtempSync(join(tmpdir(), 'vela-s1a-approval-'))
  try {
    const dataDir = join(dir, 'data')
    mkdirSync(dataDir, { recursive: true })
    const seedDb = openDatabase({ path: join(dataDir, 'vela.db') })
    try {
      const store = new SessionStore('approval-session', seedDb)
      store.appendMessage({ role: 'user', content: 'search' })
      store.appendMessage({
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            toolCallId: 'c1',
            toolName: 'mcp.read',
            input: {},
            providerExecuted: true,
          },
          {
            type: 'tool-approval-request',
            approvalId: 'apr-1',
            toolCallId: 'c1',
          },
        ],
      })
      store.appendMessage({
        role: 'tool',
        content: [
          {
            type: 'tool-approval-response',
            approvalId: 'apr-1',
            approved: true,
            reason: 'ok',
            providerExecuted: true,
          },
        ],
      })
    } finally {
      seedDb.close()
    }
    const model = createFauxModel({ responses: [fauxText('ok')] })
    const vela = createVela({ cwd: dir, dataDir, model, contextFiles: false })
    try {
      const session = vela.session('approval-session')
      expect(await session.resume()).toBe(true)
      await session.prompt('follow up')
      expect(model.calls).toHaveLength(1)
      const approvalPart = model.calls[0]!.prompt.flatMap((m) =>
        m.role === 'tool' ? m.content : [],
      ).find((p) => p.type === 'tool-approval-response')
      expect(approvalPart).toMatchObject({
        type: 'tool-approval-response',
        approvalId: 'apr-1',
        approved: true,
        reason: 'ok',
      })
    } finally {
      await vela.dispose()
    }
    const roundTripped = fromAiResponseMessage({
      role: 'assistant',
      content: [
        {
          type: 'tool-approval-request',
          approvalId: 'apr-2',
          toolCallId: 'c2',
        },
      ],
    })
    expect(roundTripped).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'tool-approval-request',
          approvalId: 'apr-2',
          toolCallId: 'c2',
        },
      ],
    })
    const roundTrippedResp = fromAiResponseMessage({
      role: 'tool',
      content: [
        {
          type: 'tool-approval-response',
          approvalId: 'apr-2',
          approved: false,
          reason: 'denied',
        },
      ],
    })
    expect(roundTrippedResp).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-approval-response',
          approvalId: 'apr-2',
          approved: false,
          reason: 'denied',
        },
      ],
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resuming a legacy image with provider file reference object preserves structured data', async () => {
  const { openDatabase } = await import('../../../src/db/index.ts')
  const { SessionStore } = await import('../../../src/driver/session/index.ts')
  const dir = mkdtempSync(join(tmpdir(), 'vela-s1a-file-ref-'))
  try {
    const dataDir = join(dir, 'data')
    mkdirSync(dataDir, { recursive: true })
    const seedDb = openDatabase({ path: join(dataDir, 'vela.db') })
    try {
      const store = new SessionStore('file-ref', seedDb, { cwd: dir })
      store.appendMessage({
        role: 'user',
        content: [
          { type: 'text', text: 'check ref' },
          {
            type: 'file',
            data: {
              type: 'reference',
              reference: { openai: 'file-abc' },
            } as never,
            mediaType: 'image/png',
          },
        ],
      })
      store.appendMessage({ role: 'assistant', content: 'seen' })
    } finally {
      seedDb.close()
    }
    const model = createFauxModel({ responses: [fauxText('still valid')] })
    const vela = createVela({ cwd: dir, dataDir, model, contextFiles: false })
    try {
      const session = vela.session('file-ref')
      await session.resume()
      await session.prompt('describe')
      expect(model.calls).toHaveLength(1)
      const filePart = model.calls[0]!.prompt.flatMap((m) =>
        m.role === 'user' ? m.content : [],
      ).find((p) => p.type === 'file')
      expect(filePart).toBeDefined()
      expect(
        filePart && filePart.type === 'file' ? filePart.data : null,
      ).toEqual({
        type: 'reference',
        reference: { openai: 'file-abc' },
      })
    } finally {
      await vela.dispose()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
