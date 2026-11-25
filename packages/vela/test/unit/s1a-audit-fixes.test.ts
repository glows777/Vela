import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateText } from 'ai'
import { z as z3 } from 'zod/v3'
import { ExtensionRunner } from '../../src/driver/extensions/runner.ts'
import {
  estimateMessagesTokens,
  normalizeUserMessage,
} from '../../src/driver/messages.ts'
import {
  buildSessionContext,
  messageText,
  type SessionEntry,
} from '../../src/driver/session/entries.ts'
import { renderSessionHtml } from '../../src/driver/session/export-html.ts'
import { SessionStore } from '../../src/driver/session/index.ts'
import { ToolRegistry } from '../../src/driver/tools/registry.ts'
import {
  fromAiResponseMessage,
  fromAiToolOutput,
  toAiModelMessages,
  toAiToolOutput,
} from '../../src/providers/messages.ts'
import { ModelRegistry } from '../../src/providers/models/index.ts'
import { resolveProviderTools } from '../../src/providers/runtime.ts'
import { silentLogger } from '../../src/shared/logger.ts'
import { createJsonSchema } from '../../src/shared/tool-schema.ts'
import { createMockModel } from '../../src/testing/core/demo-model.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

test('providers/messages preserves providerOptions (incl normalizeUserMessage & tool lifting), lifts assistant error images, handles IMAGE_MEDIA_TYPE', async () => {
  const wireUser = toAiModelMessages([
    {
      role: 'user',
      content: [
        {
          type: 'image',
          data: 'aGVsbG8=',
          mimeType: 'IMAGE/PNG',
          providerOptions: {
            anthropic: { cacheControl: { type: 'ephemeral' } },
          },
        },
      ],
    },
  ])
  expect(
    (wireUser[0]!.content[0] as Record<string, unknown>).providerOptions,
  ).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } })

  // normalizeUserMessage + tool-image lifting preserve providerOptions (#11)
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const normUser = await normalizeUserMessage({
    role: 'user',
    content: [
      {
        type: 'image',
        data: pngBase64,
        mimeType: 'image/png',
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      },
    ],
  })
  const normWire = toAiModelMessages([normUser])
  expect(
    (normWire[0]!.content[0] as Record<string, unknown>).providerOptions,
  ).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } })

  const liftedTool = toAiModelMessages(
    [
      {
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            toolCallId: 'c-lift',
            toolName: 'img',
            output: {
              type: 'content',
              value: [
                {
                  type: 'image',
                  data: 'AQID',
                  mimeType: 'image/png',
                  providerOptions: { openai: { detail: 'high' } },
                },
              ],
            },
          },
        ],
      },
    ],
    true,
    true,
  )
  expect(
    (liftedTool[1]!.content[0] as Record<string, unknown>).providerOptions,
  ).toEqual({
    openai: { detail: 'high' },
  })

  const rawBytes = new Uint8Array([1, 2, 3, 4])
  const buf = rawBytes.buffer
  const fromOut = fromAiToolOutput({
    type: 'content',
    value: [
      {
        type: 'text',
        text: 'ok',
        providerOptions: { openai: { p: 1 } },
      } as never,
      {
        type: 'file',
        data: { type: 'data', data: rawBytes },
        mediaType: 'image/png',
      } as never,
      {
        type: 'file',
        data: { type: 'data', data: Buffer.from(buf).toString('base64') },
        mediaType: 'image/webp',
      } as never,
      {
        type: 'file',
        data: { type: 'data', data: buf },
        mediaType: 'image/jpeg',
        providerOptions: { openai: { tag: 'img' } },
      } as never,
    ],
  })
  expect(fromOut.type).toBe('content')
  if (fromOut.type === 'content') {
    expect(fromOut.value[0]).toEqual({
      type: 'text',
      text: 'ok',
      providerOptions: { openai: { p: 1 } },
    })
    expect((fromOut.value[1] as { data: string }).data).toBe('AQIDBA==')
    expect(
      (fromOut.value[2] as { type: string; mimeType?: string }).mimeType,
    ).toBe('image/webp')
    expect(
      (fromOut.value[3] as { providerOptions?: unknown }).providerOptions,
    ).toEqual({
      openai: { tag: 'img' },
    })
  }

  const aiOut = toAiToolOutput({
    type: 'content',
    value: [
      {
        type: 'image',
        data: 'AQID',
        mimeType: 'image/png',
        providerOptions: { test: { keep: true } },
      },
    ],
  })
  expect(
    (aiOut as { value: Record<string, unknown>[] }).value[0]!.providerOptions,
  ).toEqual({
    test: { keep: true },
  })

  // Assistant error tool-result with supportsImages=false omits image; supportsImages=true lifts image (#12)
  const assistantErrInput = [
    {
      role: 'assistant' as const,
      content: [
        {
          type: 'tool_result' as const,
          toolCallId: 'c1',
          toolName: 'search',
          output: {
            type: 'content' as const,
            isError: true,
            value: [
              { type: 'image' as const, data: 'AQID', mimeType: 'image/png' },
            ],
          } as never,
        },
      ],
    },
  ]
  const adapted = toAiModelMessages(assistantErrInput, false)
  const assistantPart = adapted[0]!.content[0] as Record<string, unknown>
  expect(assistantPart.type).toBe('tool-result')
  expect((assistantPart.output as { type: string }).type).toBe('error-text')
  const adaptedVision = toAiModelMessages(assistantErrInput, true)
  expect(adaptedVision).toHaveLength(2)
  expect(adaptedVision[1]!.role).toBe('user')

  // Assistant edge normalization + tool-approval-request metadata round-trip
  const normalizedEdge = toAiModelMessages([
    {
      role: 'assistant',
      content: [
        { type: 'thinking', text: 'think' },
        {
          type: 'tool-approval-request',
          approvalId: 'ap1',
          toolCallId: 'tc1',
          reason: 'needs ok',
          isAutomatic: false,
          signature: 'sig-1',
          inputSchemaInput: { x: 1 },
        },
      ],
    },
  ])
  expect((normalizedEdge[0]!.content[0] as { type: string }).type).toBe(
    'reasoning',
  )
  expect(normalizedEdge[0]!.content[1]).toMatchObject({
    type: 'tool-approval-request',
    approvalId: 'ap1',
    toolCallId: 'tc1',
    reason: 'needs ok',
    isAutomatic: false,
    signature: 'sig-1',
    inputSchemaInput: { x: 1 },
  })

  const parsedResp = fromAiResponseMessage({
    role: 'assistant',
    content: [
      {
        type: 'tool-approval-request',
        approvalId: 'ap2',
        toolCallId: 'tc2',
        reason: 'check',
        isAutomatic: true,
      } as never,
    ],
  })
  expect(parsedResp.content[0]).toMatchObject({
    type: 'tool-approval-request',
    reason: 'check',
    isAutomatic: true,
  })
})

test('driver messages helpers ignore thinking text, ignore image base64 size, and convert custom_message cleanly', async () => {
  // messageText strictly ignores thinking / non-text parts carrying .text
  expect(
    messageText([
      { type: 'thinking', text: 'secret-thought' },
      { type: 'text', text: 'visible' },
    ]),
  ).toBe('visible')

  // estimateMessagesTokens treats inline image as fixed token budget instead of raw base64 length
  expect(
    estimateMessagesTokens([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            data: 'x'.repeat(20_000),
            mimeType: 'image/png',
          },
        ],
      },
    ]),
  ).toBeLessThan(1500)

  const dir = tempDir('vela-s1-sess-')
  const dbPath = join(dir, 'vela.db')
  const store = new SessionStore('cm', dbPath)
  store.appendCustomMessage(
    { role: 'user', content: [{ type: 'text', text: 'cm-note' }] },
    { customType: 'note', display: true },
  )
  const saved = await new SessionStore('cm', dbPath).loadSaved()
  expect(saved).toBeDefined()
  expect(
    (saved!.messages[0] as { content: { type: string; text?: string }[] })
      .content[0],
  ).toEqual({ type: 'text', text: 'cm-note' })
  const ctx = buildSessionContext(store.getEntries())
  expect(
    (ctx.messages[0] as { content: { type: string }[] }).content[0]!.type,
  ).toBe('text')
  const aiMessages = toAiModelMessages(ctx.messages)
  const gen = await generateText({
    model: createMockModel(),
    messages: aiMessages,
  })
  expect(gen.text).toBeDefined()

  const html = renderSessionHtml({
    id: 'cm-html',
    entries: [
      {
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: '2026-11-24T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'thought' },
            { type: 'text', text: 'visible-html' },
          ],
        },
      },
      {
        type: 'custom_message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-11-24T00:00:01.000Z',
        customType: 'note',
        display: true,
        content: [{ type: 'text', text: 'cm-note' }],
      } as SessionEntry,
    ],
  })
  expect(html).toContain('thought')
  expect(html).toContain('visible-html')
  expect(html).toContain('cm-note')
})

test('createJsonSchema detects schema drafts and resolveProviderTools extracts Zod v3 schemas', async () => {
  const draft7 = createJsonSchema({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: { n: { type: 'number', exclusiveMinimum: 0 } },
    required: ['n'],
  })
  expect(await draft7.validate!({ n: 1 })).toEqual({
    success: true,
    value: { n: 1 },
  })
  expect((await draft7.validate!({ n: 0 })).success).toBe(false)

  const zodV3Schema = z3.object({ query: z3.string().min(1) })
  const resolved = await resolveProviderTools(createMockModel(), [
    {
      name: 'v3_tool',
      description: 'zod v3 test',
      inputSchema: zodV3Schema as never,
    },
  ])
  expect(resolved.toolDefinitions).toHaveLength(1)
  expect(
    (resolved.toolDefinitions[0] as { inputSchema: Record<string, unknown> })
      .inputSchema,
  ).toMatchObject({
    type: 'object',
    properties: { query: { type: 'string' } },
  })
})

test('toAiModelMessages lifts URL-backed images from failed assistant tool_result before stripping to error-text', () => {
  const ai = toAiModelMessages(
    [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            toolCallId: 'tc-url',
            toolName: 'snap',
            input: {},
          },
          {
            type: 'tool_result',
            toolCallId: 'tc-url',
            toolName: 'snap',
            output: {
              type: 'content',
              isError: true,
              value: [
                { type: 'text', text: 'boom with screenshot' },
                {
                  type: 'file',
                  mediaType: 'image/png',
                  data: { type: 'url', url: 'https://example.com/fail.png' },
                },
              ],
            } as never,
          },
        ],
      },
    ],
    true,
    false,
  )
  expect(ai).toHaveLength(2)
  const toolPart = (ai[0] as { content: unknown[] }).content[1] as {
    type: string
    output: { type: string; value: string }
  }
  expect(toolPart.output).toEqual({
    type: 'error-text',
    value: 'boom with screenshot',
  })
  const liftedUser = ai[1] as {
    role: string
    content: Array<{ type: string; mediaType?: string; data?: unknown }>
  }
  expect(liftedUser.role).toBe('user')
  expect(liftedUser.content[0]).toMatchObject({
    type: 'file',
    mediaType: 'image/png',
  })
  expect(liftedUser.content[0]?.data).toBeInstanceOf(URL)
  expect((liftedUser.content[0]?.data as URL | undefined)?.href).toBe(
    'https://example.com/fail.png',
  )
})

test('ExtensionRunner.registerTool accepts createJsonSchema directly and rejects plain JSON objects', async () => {
  const registry = new ToolRegistry()
  let registeredName = ''
  const runner = new ExtensionRunner(
    {
      cwd: '/tmp',
      dataDir: '/tmp',
      extensionConfig: {},
      logger: silentLogger,
      registry,
      models: new ModelRegistry(),
    },
    [
      (api) => {
        registeredName = api.registerTool({
          name: 'direct_json',
          description: 'accepts createJsonSchema directly',
          inputSchema: createJsonSchema({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          }),
          execute: async (input) => input,
        })
      },
    ],
  )
  await runner.ready
  expect(registeredName).toBe('extension-1_direct_json')
  expect(registry.get(registeredName)).toBeDefined()

  expect(
    () =>
      new ExtensionRunner(
        {
          cwd: '/tmp',
          dataDir: '/tmp',
          extensionConfig: {},
          logger: silentLogger,
          registry: new ToolRegistry(),
          models: new ModelRegistry(),
        },
        [
          (api) => {
            api.registerTool({
              name: 'plain_obj',
              description: 'plain json object should throw',
              inputSchema: { type: 'object' } as never,
              execute: async (input) => input,
            })
          },
        ],
      ),
  ).toThrow(/inputSchema must be a Zod schema or createJsonSchema\(\)/)
})
