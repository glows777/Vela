import { afterEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadModels } from '@glows777/vela-core'
import { mcp } from '@glows777/vela-mcp'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { McpServerEntry } from '../../packages/mcp/src/config.ts'
import { cleanupTestVelas, createTestVela, tempDir } from '../support/vela.ts'

/**
 * An MCP server built with Zod 3 publishes record keys as `propertyNames` without `type: "string"`.
 * OpenAI-compatible endpoints do not accept the keyword, so the AI SDK strips it from the outgoing
 * schema; the local copy must still reject invalid keys before the server sees the call.
 */
const RECORD_TOOL = 'mcp__demo__lookup'

const dirs: { cleanup(): void }[] = []
const realFetch = globalThis.fetch
afterEach(async () => {
  await cleanupTestVelas()
  globalThis.fetch = realFetch
  for (const dir of dirs.splice(0)) dir.cleanup()
})

interface Reply {
  tool?: { id: string; arguments: string }
  text?: string
}

function responsesReply(body: { model?: unknown }, reply: Reply): Response {
  const item = reply.tool
    ? {
        type: 'function_call',
        id: `fc_${reply.tool.id}`,
        call_id: reply.tool.id,
        status: 'completed',
        name: RECORD_TOOL,
        arguments: reply.tool.arguments,
      }
    : {
        type: 'message',
        id: `msg_${reply.text}`,
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: reply.text, annotations: [] }],
      }
  const response = {
    id: 'resp_test',
    created_at: 1,
    model: body.model,
    status: 'completed',
    output: [item],
    usage: { input_tokens: 10, output_tokens: 1 },
  }
  const events: Record<string, unknown>[] = [
    { type: 'response.created', response },
    { type: 'response.output_item.added', output_index: 0, item },
    {
      type: reply.tool
        ? 'response.function_call_arguments.delta'
        : 'response.output_text.delta',
      item_id: item.id,
      output_index: 0,
      ...(reply.tool ? {} : { content_index: 0 }),
      delta: reply.tool ? reply.tool.arguments : reply.text,
    },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ]
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

function chatReply(body: { model?: unknown }, reply: Reply): Response {
  const delta = reply.tool
    ? {
        tool_calls: [
          {
            index: 0,
            id: reply.tool.id,
            type: 'function',
            function: { name: RECORD_TOOL, arguments: reply.tool.arguments },
          },
        ],
      }
    : { content: reply.text }
  const chunk = {
    id: 'chat_test',
    object: 'chat.completion.chunk',
    created: 1,
    model: body.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: reply.tool ? 'tool_calls' : 'stop',
      },
    ],
  }
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  })
}

/**
 * An in-memory MCP server whose only tool publishes the Zod 3 record schema. The low-level handler
 * takes any arguments, so a call that reaches the server runs `calls.push`; a Zod-backed server
 * would reject invalid keys on its own side and hide whether Vela checked them.
 */
function recordServer() {
  const calls: Record<string, unknown>[] = []
  return {
    calls,
    createTransport: async (entry: McpServerEntry): Promise<Transport> => {
      const server = new Server(
        { name: entry.name, version: '1.0.0' },
        { capabilities: { tools: {} } },
      )
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: 'lookup',
            description: 'Look up notes by key',
            inputSchema: {
              type: 'object',
              properties: {
                notes: {
                  type: 'object',
                  propertyNames: { minLength: 1 },
                  additionalProperties: { type: 'string' },
                },
                labels: {
                  type: 'object',
                  propertyNames: { enum: ['a', 'b'] },
                  additionalProperties: { type: 'string' },
                },
              },
              required: ['notes', 'labels'],
              additionalProperties: false,
            },
          },
        ],
      }))
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        calls.push(request.params.arguments ?? {})
        return { content: [{ type: 'text', text: 'looked up' }] }
      })
      const [client, side] = InMemoryTransport.createLinkedPair()
      await server.connect(side)
      return client
    },
  }
}

test.each(['openai-responses', 'openai-completions'] as const)(
  '%s: invalid record keys are rejected locally and never reach the MCP server',
  async (api) => {
    const dir = tempDir(`vela-mcp-validation-${api}-`)
    dirs.push(dir)
    writeFileSync(
      join(dir.path, 'models.json'),
      JSON.stringify({
        providers: {
          probe: {
            api,
            baseUrl: 'https://example.test/v1',
            apiKey: 'test',
            models: [{ id: 'probe-model' }],
          },
        },
      }),
    )
    const server = recordServer()
    const requests: Record<string, unknown>[] = []
    const replies: Reply[] = [
      // Turn 1: a key shorter than minLength(1)
      {
        tool: {
          id: 'call_empty',
          arguments: JSON.stringify({
            notes: { '': 'bad' },
            labels: { a: 'ok' },
          }),
        },
      },
      { text: 'noted' },
      // Turn 2: a key outside the enum
      {
        tool: {
          id: 'call_enum',
          arguments: JSON.stringify({
            notes: { a: 'ok' },
            labels: { c: 'bad' },
          }),
        },
      },
      { text: 'noted' },
      // Turn 3: a valid call reaches the server
      {
        tool: {
          id: 'call_valid',
          arguments: JSON.stringify({
            notes: { a: 'ok' },
            labels: { b: 'ok' },
          }),
        },
      },
      { text: 'done' },
    ]
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body))
      requests.push(body)
      const reply = replies.shift()
      if (!reply) throw new Error('unexpected request')
      return api === 'openai-responses'
        ? responsesReply(body, reply)
        : chatReply(body, reply)
    }) as typeof fetch
    const t = createTestVela({
      cwd: dir.path,
      providers: loadModels({ agentDir: dir.path }),
      model: 'probe/probe-model',
      extensions: [
        mcp({
          servers: { demo: { command: 'unused', exposure: 'direct' } },
          createTransport: server.createTransport,
        }),
      ],
    })

    await t.run('create an empty-key note')
    await t.run('create an enum-key note')
    await t.run('create a valid note')

    const ends = t.eventsOf('tool_execution_end')
    expect(ends.map((event) => event.toolName)).toEqual([
      RECORD_TOOL,
      RECORD_TOOL,
      RECORD_TOOL,
    ])
    // The two invalid calls end as tool-input errors…
    expect(ends.slice(0, 2).map((event) => event.isError)).toEqual([true, true])
    expect(String(ends[0]?.result)).toContain('notes')
    expect(String(ends[1]?.result)).toContain('labels')
    // …the model receives that error as the call's result…
    expect(JSON.stringify(requests[1])).toContain('Type validation failed')
    expect(JSON.stringify(requests[3])).toContain('Type validation failed')
    // …and neither call runs: only the valid call reached the MCP server.
    expect(server.calls).toEqual([{ notes: { a: 'ok' }, labels: { b: 'ok' } }])
    expect(ends[2]?.isError).toBe(false)
    expect(t.lastAssistantText()).toBe('done')
    expect(requests).toHaveLength(6)
  },
)
