import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateText } from 'ai'
import { z as z3 } from 'zod/v3'
import {
  messageEnvelopeChars,
  normalizeUserMessage,
} from '../../src/driver/messages.ts'
import {
  buildSessionContext,
  messageText,
  type SessionEntry,
} from '../../src/driver/session/entries.ts'
import { renderSessionHtml } from '../../src/driver/session/export-html.ts'
import { SessionStore } from '../../src/driver/session/index.ts'
import { fileSessionStorage } from '../../src/driver/session/storage.ts'
import {
  fromAiResponseMessage,
  fromAiToolOutput,
  toAiModelMessages,
  toAiToolOutput,
} from '../../src/providers/messages.ts'
import { resolveProviderTools } from '../../src/providers/runtime.ts'
import {
  normalizeUserContent,
  normalizeVelaContent,
  normalizeVelaMessage,
} from '../../src/shared/messages.ts'
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
      { type: 'image-data', data: rawBytes as never, mediaType: 'image/png' },
      {
        type: 'media',
        data: Buffer.from(buf).toString('base64'),
        mediaType: 'image/webp',
      } as never,
      {
        type: 'file-data',
        data: buf as never,
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
    normalizeVelaMessage({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'think' },
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
    }),
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

test('shared/driver messages normalize nested tool images, Buffer payloads, custom_message -> legal user parts + generateText (#13)', async () => {
  const res = normalizeVelaContent([
    {
      type: 'tool-result',
      toolCallId: 'tc',
      toolName: 't',
      output: {
        type: 'content',
        value: [
          {
            type: 'image-data',
            data: { type: 'Buffer', data: [1, 2, 3] },
            mediaType: 'image/png',
          },
          { type: 'media', data: 'AQID', mediaType: 'image/gif' },
          {
            type: 'file',
            mediaType: 'image/jpeg',
            data: { type: 'data', data: 'AQID' },
          },
        ],
      },
    },
  ])
  expect(res.changed).toBe(true)
  const tr = res.content[0] as { output: { value: Record<string, unknown>[] } }
  expect(tr.output.value[0]).toMatchObject({
    type: 'image',
    data: 'AQID',
    mimeType: 'image/png',
  })
  expect(tr.output.value[1]).toMatchObject({
    type: 'image',
    data: 'AQID',
    mimeType: 'image/gif',
  })
  expect(tr.output.value[2]).toMatchObject({
    type: 'image',
    data: 'AQID',
    mimeType: 'image/jpeg',
  })

  // messageText strictly ignores thinking / non-text parts carrying .text
  expect(
    messageText([
      { type: 'thinking', text: 'secret-thought' },
      { type: 'text', text: 'visible' },
    ]),
  ).toBe('visible')

  // messageEnvelopeChars recognizes legacy media image parts
  expect(
    messageEnvelopeChars([
      {
        role: 'user',
        content: [
          {
            type: 'media',
            data: 'x'.repeat(20_000),
            mediaType: 'image/png',
          } as never,
        ],
      },
    ]),
  ).toBeLessThan(6000)

  // SessionStore.loadSaved, buildSessionContext, and renderSessionHtml normalize legacy custom_message arrays
  const dir = tempDir('vela-s1-sess-')
  const storage = fileSessionStorage(dir)
  const file = join(dir, 'legacy-cm.jsonl')
  const header = {
    type: 'session',
    version: 2,
    id: 'legacy-cm',
    timestamp: '2026-11-24T00:00:00.000Z',
  }
  const entry = {
    type: 'custom_message',
    id: 'e1',
    parentId: null,
    timestamp: '2026-11-24T00:00:01.000Z',
    customType: 'note',
    display: true,
    content: [{ type: 'reasoning', text: 'legacy-r' }],
  }
  writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`)
  const store = new SessionStore('legacy-cm', dir, undefined, storage)
  const saved = await store.loadSaved()
  expect(saved).toBeDefined()
  expect(
    (saved!.messages[0] as { content: { type: string; text?: string }[] })
      .content[0],
  ).toEqual({ type: 'text', text: 'legacy-r' })
  const ctx = buildSessionContext([entry as never])
  expect(
    (ctx.messages[0] as { content: { type: string }[] }).content[0]!.type,
  ).toBe('text')
  const aiMessages = toAiModelMessages(ctx.messages)
  const gen = await generateText({
    model: createMockModel(),
    messages: aiMessages,
  })
  expect(gen.text).toBeDefined()
  expect(
    normalizeUserContent([{ type: 'reasoning', text: 'thought' }]).content,
  ).toEqual([{ type: 'text', text: 'thought' }])

  const html = renderSessionHtml({
    id: 'legacy-cm',
    entries: [
      {
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: '2026-11-24T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'legacy-thought' },
            { type: 'text', text: 'legacy-visible' },
          ],
        } as never,
      },
      {
        ...entry,
        content: [{ type: 'text', text: 'cm-text' }],
      } as unknown as SessionEntry,
    ],
  })
  expect(html).toContain('legacy-thought')
  expect(html).toContain('legacy-visible')
  expect(html).toContain('cm-text')
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
      execute: async (input) => input,
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
