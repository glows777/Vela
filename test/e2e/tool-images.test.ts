import { afterEach, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LanguageModelV4Prompt } from '@ai-sdk/provider'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import z from 'zod'
import { mcp } from '../../src/extensions/mcp/index.ts'
import type { ImageContent } from '../../src/messages.ts'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '../../src/testing/faux.ts'
import { ToolExecutionResult } from '../../src/tools/registry.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)
const bytes = (name = 'blue.png') =>
  readFileSync(new URL(`../fixtures/images/${name}`, import.meta.url))
const image = (name = 'blue.png'): ImageContent => ({
  type: 'image',
  data: bytes(name).toString('base64'),
  mimeType: 'image/png',
})
const toolImages = (prompt: LanguageModelV4Prompt) =>
  prompt.flatMap((message) =>
    message.role === 'tool'
      ? message.content.flatMap((part) =>
          part.type === 'tool-result' && part.output.type === 'content'
            ? part.output.value.filter(
                (item) =>
                  item.type === 'file' && item.mediaType.startsWith('image/'),
              )
            : [],
        )
      : [],
  )
const pictureTool = (name = 'picture') => ({
  name,
  description: 'Return a picture',
  inputSchema: z.object({}),
  execute: async () =>
    new ToolExecutionResult({ source: name }, [
      { type: 'text', text: 'A blue picture' },
      image(),
    ]),
})

test('a tool returns text and a canonical image, saved inline and restored on resume', async () => {
  const t = createTestVela({
    extensions: [
      function pictures(v) {
        v.registerTool(pictureTool())
      },
    ],
    responses: [fauxToolCall('pictures_picture', {}), fauxText('blue')],
  })
  await t.run('Describe the picture')
  expect(toolImages(t.model.calls[1]!.prompt)).toHaveLength(1)
  const result = t.messages
    .flatMap((message) => (message.role === 'tool' ? message.content : []))
    .find((part) => part.type === 'tool-result')!
  expect(result.output).toEqual({
    type: 'content',
    value: [{ type: 'text', text: 'A blue picture' }, image()],
  })
  const again = createTestVela({
    cwd: t.cwd,
    responses: [fauxText('remembered')],
  })
  expect(await again.session.resume()).toBe(true)
  await again.run('Remember the picture?')
  expect(toolImages(again.model.calls[0]!.prompt)).toHaveLength(1)
})

test('tool_result can replace image content and normalization runs after the hook', async () => {
  const seen: unknown[] = []
  const t = createTestVela({
    extensions: [
      function pictures(v) {
        v.registerTool(pictureTool())
        v.on('tool_result', (event) => {
          if (event.toolName !== 'pictures_picture') return
          seen.push(event.content)
          return {
            content: [{ type: 'text', text: 'Replacement' }, image('wide.png')],
          }
        })
      },
    ],
    responses: [fauxToolCall('pictures_picture', {}), fauxText('wide')],
  })
  await t.run('Describe the picture')
  expect(seen[0]).toEqual([{ type: 'text', text: 'A blue picture' }, image()])
  const parts = toolImages(t.model.calls[1]!.prompt)
  expect(parts).toHaveLength(1)
  expect(parts[0]).toMatchObject({ type: 'file', mediaType: 'image/jpeg' })
  expect(JSON.stringify(parts)).not.toContain(image('wide.png').data)
  expect(JSON.stringify(parts).length).toBeLessThan(4.5 * 1024 * 1024)
})

test.each([
  'blue.png',
  'quadrants.jpg',
  'quadrants.gif',
  'quadrants.webp',
  'quadrants.bmp',
])(
  'read_file detects %s by its header even with a misleading extension',
  async (name) => {
    const t = createTestVela({
      responses: [
        fauxToolCall('read_file', { path: 'picture.txt' }),
        fauxText('seen'),
      ],
    })
    writeFileSync(join(t.cwd, 'picture.txt'), bytes(name))
    await t.run('Read picture.txt')
    expect(toolImages(t.model.calls[1]!.prompt)).toHaveLength(1)
    expect(JSON.stringify(t.model.calls[1]!.prompt)).not.toContain('�PNG')
  },
)

test('text-only read_file gives the model a note while saved images survive a model switch', async () => {
  const model = createFauxModel({
    responses: [
      fauxToolCall('read_file', { path: 'photo.png' }),
      fauxText('text'),
      fauxText('vision'),
    ],
  })
  const t = createTestVela({
    model: 'faux/text',
    providers: {
      faux: {
        models: [
          { id: 'text', input: ['text'] },
          { id: 'vision', input: ['text', 'image'] },
        ],
        createModel: () => model,
      },
    },
  })
  writeFileSync(join(t.cwd, 'photo.png'), bytes())
  await t.run('Read photo.png')
  expect(toolImages(model.calls[1]!.prompt)).toHaveLength(0)
  expect(JSON.stringify(model.calls[1]!.prompt)).toContain(
    '(tool image omitted: model does not support images)',
  )
  expect(JSON.stringify(t.messages)).toContain(image().data)
  t.session.setModel('faux/vision')
  await t.run('Now view the photo')
  expect(toolImages(model.calls[2]!.prompt)).toHaveLength(1)
})

test('MCP image blocks reach the model through the real MCP transport', async () => {
  const server = new McpServer({ name: 'pictures', version: '1' })
  server.registerTool(
    'picture',
    { description: 'Return a PNG', inputSchema: {} },
    async () => ({ content: [{ type: 'text', text: 'MCP picture' }, image()] }),
  )
  const [client, side] = InMemoryTransport.createLinkedPair()
  await server.connect(side)
  const t = createTestVela({
    extensions: [
      mcp({
        servers: { pictures: { command: 'unused', exposure: 'direct' } },
        createTransport: async () => client,
      }),
    ],
    responses: [fauxToolCall('mcp__pictures__picture', {}), fauxText('seen')],
  })
  await t.run('Get a picture from MCP')
  expect(toolImages(t.model.calls[1]!.prompt)).toHaveLength(1)
  expect(JSON.stringify(t.model.calls[1]!.prompt)).not.toContain(
    'Vela tool results are text only',
  )
})

test('microcompaction keeps image results inline while folding old text results', async () => {
  const t = createTestVela({
    files: { 'long.txt': 'The long text. '.repeat(1000) },
    limits: {
      microcompactThreshold: 1,
      minMicroSavings: 1,
      summaryThreshold: 1e9,
    },
    responses: [
      fauxToolCall('read_file', { path: 'photo.png' }),
      ...Array.from({ length: 7 }, () =>
        fauxToolCall('read_file', { path: 'long.txt' }),
      ),
      fauxText('done'),
    ],
  })
  writeFileSync(join(t.cwd, 'photo.png'), bytes())
  await t.run('Read the image and the text')
  expect(toolImages(t.model.calls.at(-1)!.prompt)).toHaveLength(1)
  expect(
    t.eventsOf('context_prepare').some((event) => event.action === 'micro'),
  ).toBe(true)
  expect(JSON.stringify(t.model.calls.at(-1)!.prompt)).toContain(
    'tool result preview omitted',
  )
})

test('invalid tool images become a reason without losing text or stopping the agent', async () => {
  const t = createTestVela({
    extensions: [
      function pictures(v) {
        v.registerTool({
          ...pictureTool(),
          execute: async () =>
            new ToolExecutionResult({}, [
              { type: 'text', text: 'Keep the answer' },
              { type: 'image', data: 'invalid', mimeType: 'image/png' },
            ]),
        })
      },
    ],
    responses: [fauxToolCall('pictures_picture', {}), fauxText('done')],
  })
  await t.run('Get picture')
  expect(toolImages(t.model.calls[1]!.prompt)).toHaveLength(0)
  const output = JSON.stringify(t.model.calls[1]!.toolResults)
  expect(output).toContain('Keep the answer')
  expect(output).toMatch(/image omitted.*invalid/i)
})

test('text-only tool_result transforms keep images unless content explicitly replaces them', async () => {
  const t = createTestVela({
    extensions: [
      function pictures(v) {
        v.registerTool(pictureTool())
        v.on('tool_result', (event) =>
          event.toolName === 'pictures_picture'
            ? { output: 'A redacted caption' }
            : undefined,
        )
      },
    ],
    responses: [fauxToolCall('pictures_picture', {}), fauxText('done')],
  })
  await t.run('Get picture')
  expect(toolImages(t.model.calls[1]!.prompt)).toHaveLength(1)
  expect(JSON.stringify(t.model.calls[1]!.toolResults)).toContain(
    'A redacted caption',
  )
  expect(JSON.stringify(t.model.calls[1]!.toolResults)).not.toContain(
    'A blue picture',
  )
})

test('oversized tool text is previewed while its image stays in the request', async () => {
  const t = createTestVela({
    extensions: [
      function pictures(v) {
        v.registerTool({
          ...pictureTool(),
          maxResultChars: 100,
          execute: async () =>
            new ToolExecutionResult({ data: image().data }, [
              { type: 'text', text: 'Caption '.repeat(500) },
              image(),
            ]),
        })
      },
    ],
    responses: [fauxToolCall('pictures_picture', {}), fauxText('done')],
  })
  await t.run('Get picture')
  expect(toolImages(t.model.calls[1]!.prompt)).toHaveLength(1)
  expect(JSON.stringify(t.model.calls[1]!.toolResults)).not.toContain(
    'Caption '.repeat(500),
  )
})

test('failed image-only tools keep error status and move the retained image into a following request message', async () => {
  const t = createTestVela({
    extensions: [
      function pictures(v) {
        v.registerTool({
          ...pictureTool(),
          execute: async () =>
            new ToolExecutionResult({}, [image()], { isError: true }),
        })
      },
    ],
    responses: [
      fauxToolCall('pictures_picture', {}),
      fauxText('saw the failure screenshot'),
    ],
  })
  await t.run('Get a failure screenshot')
  expect(t.eventsOf('tool_execution_end')[0]?.isError).toBe(true)
  const errorResult = t.model.calls[1]!.prompt.flatMap((message) =>
    message.role === 'tool' ? message.content : [],
  ).find((part) => part.type === 'tool-result')
  expect(errorResult?.output).toMatchObject({
    type: 'error-text',
    value: 'Tool reported an error',
  })
  const attached = t.model.calls[1]!.prompt.flatMap((message) =>
    message.role === 'user'
      ? message.content.filter((part) => part.type === 'file')
      : [],
  )
  expect(attached).toHaveLength(1)
  expect(JSON.stringify(t.messages)).toContain(image().data)
  expect(JSON.stringify(t.messages)).toContain('"isError":true')
})

test('oversized image captions retain native tool details separately from the full caption file', async () => {
  const native = { importantNativeValue: 42, screenshot: image().data }
  const caption = 'A long caption. '.repeat(500)
  const t = createTestVela({
    extensions: [
      function pictures(v) {
        v.registerTool({
          ...pictureTool(),
          maxResultChars: 100,
          execute: async () =>
            new ToolExecutionResult(native, [
              { type: 'text', text: caption },
              image(),
            ]),
        })
      },
    ],
    responses: [fauxToolCall('pictures_picture', {}), fauxText('done')],
  })
  await t.run('Get the picture')
  const records = readFileSync(t.session.store.results.history.path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const result = records.find((record) => record.type === 'tool_result')
  expect(result.output).toEqual(native)
  expect(typeof result.modelTextPath).toBe('string')
  expect(readFileSync(result.modelTextPath, 'utf8')).toBe(caption)
  expect(readFileSync(result.modelTextPath, 'utf8')).not.toContain(image().data)
})

test('nested failed image results can be relayed without losing their screenshot', async () => {
  let nestedResult: unknown
  const t = createTestVela({
    extensions: [
      function pictures(v) {
        const child = v.registerTool({
          ...pictureTool('child'),
          execute: async () =>
            new ToolExecutionResult({}, [image()], { isError: true }),
        })
        v.registerTool({
          ...pictureTool('relay'),
          execute: async (_input, ctx) => {
            const outcome = await ctx!.executeTool!(child, {})
            nestedResult = outcome.result
            return new ToolExecutionResult(
              {},
              Array.isArray(outcome.result)
                ? outcome.result
                : String(outcome.result),
              { isError: outcome.isError },
            )
          },
        })
      },
    ],
    responses: [
      fauxToolCall('pictures_relay', {}),
      fauxText('received screenshot'),
    ],
  })
  await t.run('Relay the child failure screenshot')
  expect(nestedResult).toEqual([image()])
  expect(
    t.model.calls[1]!.prompt.flatMap((message) =>
      message.role === 'user'
        ? message.content.filter((part) => part.type === 'file')
        : [],
    ),
  ).toHaveLength(1)
})

test('failed native-result persistence labels a saved caption as model text, not the full native output', async () => {
  const t = createTestVela({
    extensions: [
      function pictures(v) {
        v.registerTool({
          ...pictureTool(),
          maxResultChars: 100,
          execute: async () =>
            new ToolExecutionResult({ importantNativeValue: 42 }, [
              { type: 'text', text: 'Caption '.repeat(500) },
              image(),
            ]),
        })
      },
    ],
    responses: [fauxToolCall('pictures_picture', {})],
  })
  const history = t.session.store.results.history
  const original = history.append.bind(history)
  Object.defineProperty(history, 'append', {
    value: (record: { type: string }) =>
      record.type === 'tool_result'
        ? Promise.reject(new Error('Simulated disk full'))
        : original(record as never),
  })
  await expect(t.run('Get picture')).rejects.toThrow('full model text saved at')
})

test('Chat redaction after an image tool does not promise a second attachment', async () => {
  const model = Object.assign(
    createFauxModel({
      responses: [
        [
          fauxToolCall('pictures_picture', {}),
          fauxToolCall('pictures_private', {}),
        ],
        fauxText('Only the public image remains.'),
      ],
    }),
    { provider: 'redaction-fixture.chat' },
  )
  const t = createTestVela({
    model,
    extensions: [
      function pictures(v) {
        v.registerTool(pictureTool())
        v.registerTool(pictureTool('private'))
        v.on('tool_result', (event) =>
          event.toolName === 'pictures_private' ? { content: [] } : undefined,
        )
      },
    ],
  })
  await t.run('Read both tool results after redaction')
  const results = model.calls[1]!.prompt.flatMap((message) =>
    message.role === 'tool' ? message.content : [],
  ).filter((part) => part.type === 'tool-result')
  expect(results.at(-1)?.output).toEqual({ type: 'content', value: [] })
  expect(JSON.stringify(results.at(-1))).not.toContain('tool image follows')
  const users = model.calls[1]!.prompt.filter(
    (message) => message.role === 'user',
  )
  expect(
    users.at(-1)?.content.filter((part) => part.type === 'file'),
  ).toHaveLength(1)
})
