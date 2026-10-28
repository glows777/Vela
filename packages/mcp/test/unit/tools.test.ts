import { expect, test } from 'bun:test'
import {
  convertMcpResult,
  createMcpToolName,
  mcpResultText,
} from '../../src/tools.ts'

test('tool names are mcp__<server>__<tool>, sanitized, with a hash when too long or taken (like pi)', () => {
  expect(createMcpToolName('my-server', 'get.file')).toBe(
    'mcp__my_server__get_file',
  )
  const long = createMcpToolName('server', 'x'.repeat(80))
  expect(long).toHaveLength(64)
  expect(long).toMatch(/^mcp__server__x+_[0-9a-f]{8}$/)
  const taken = createMcpToolName('s', 'a-b', (name) => name === 'mcp__s__a_b')
  expect(taken).toMatch(/^mcp__s__a_b_[0-9a-f]{8}$/)
})

test('MCP text projection omits images and keeps audio and binary placeholders', () => {
  const png = Buffer.from('12345678').toString('base64')
  expect(
    mcpResultText('s', 't', {
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: png, mimeType: 'image/png' },
        { type: 'audio', data: png, mimeType: 'audio/wav' },
        {
          type: 'resource',
          resource: { uri: 'file:///a.txt', text: 'embedded text' },
        },
        {
          type: 'resource',
          resource: {
            uri: 'file:///a.json',
            mimeType: 'application/json',
            blob: Buffer.from('{"a":1}').toString('base64'),
          },
        },
        {
          type: 'resource',
          resource: {
            uri: 'file:///a.bin',
            mimeType: 'application/zip',
            blob: png,
          },
        },
        {
          type: 'resource_link',
          uri: 'file:///b.md',
          name: 'b.md',
          mimeType: 'text/markdown',
          size: 2048,
          description: 'Notes',
        },
      ],
    }),
  ).toBe(
    [
      'hello',
      '[Audio: audio/wav, 8 B (not shown: Vela tool results are text only)]',
      'embedded text',
      '{"a":1}',
      '[Binary resource file:///a.bin (application/zip, 8 B) not shown]',
      '[Resource file:///b.md "b.md" (text/markdown, 2.0 KB): Notes]',
    ].join('\n'),
  )
})

test('MCP conversion keeps ordered image blocks and the native result without metadata', () => {
  const image = {
    type: 'image' as const,
    data: Buffer.from('image bytes').toString('base64'),
    mimeType: 'image/png',
  }
  const result = {
    content: [
      { type: 'text' as const, text: 'before' },
      image,
      { type: 'text' as const, text: 'after' },
    ],
    structuredContent: { source: 'picture' },
    isError: true,
    _meta: { private: true },
  }
  const converted = convertMcpResult('s', 't', result)
  expect(converted.content).toEqual(result.content)
  expect(converted.text).toBe('before\nafter')
  expect(converted.value).toEqual({
    content: result.content,
    structuredContent: result.structuredContent,
    isError: true,
  })
  expect(converted.execution).toEqual({ isError: true })
})

test('an image-only MCP error keeps its image without adding an empty-error message', () => {
  const image = { type: 'image' as const, data: 'YQ==', mimeType: 'image/png' }
  const converted = convertMcpResult('s', 't', {
    content: [image],
    isError: true,
  })
  expect(converted.content).toEqual([image])
  expect(converted.text).toBe('')
  expect(converted.execution.isError).toBe(true)
})

test('without content, the structured content is the text; an empty error gets a message', () => {
  expect(
    mcpResultText('s', 't', { content: [], structuredContent: { a: 1 } }),
  ).toBe('{\n  "a": 1\n}')
  expect(mcpResultText('s', 't', { content: [], isError: true })).toBe(
    'MCP tool s/t returned an error',
  )
})
