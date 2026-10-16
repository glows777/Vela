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
    extensions: [(v) => v.registerTool(pictureTool())],
    responses: [fauxToolCall('picture', {}), fauxText('blue')],
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
      (v) => {
        v.registerTool(pictureTool())
        v.on('tool_result', (event) => {
          if (event.toolName !== 'picture') return
          seen.push(event.content)
          return {
            content: [{ type: 'text', text: 'Replacement' }, image('wide.png')],
          }
        })
      },
    ],
    responses: [fauxToolCall('picture', {}), fauxText('wide')],
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
