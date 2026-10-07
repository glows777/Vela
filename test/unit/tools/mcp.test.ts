import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Client,
  type JSONRPCMessage,
  type Transport,
} from '@modelcontextprotocol/client'
import { ToolResultStore } from '../../../src/session/tool-results'
import { ToolRegistry } from '../../../src/tools/registry'

const root = mkdtempSync(join(tmpdir(), 'vela-mcp-test-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

// 进程内的假 MCP server：按 JSON-RPC 回 initialize / tools/list / tools/call，
// 用真实的 @modelcontextprotocol/client 连上去，确认依赖升级后 registerMCPServer 仍可用
function fakeServer(): Transport {
  const transport: Transport = {
    async start() {},
    async close() {
      transport.onclose?.()
    },
    async send(message: JSONRPCMessage) {
      if (!('method' in message) || !('id' in message)) return
      const reply = (result: Record<string, unknown>) =>
        queueMicrotask(() =>
          transport.onmessage?.({ jsonrpc: '2.0', id: message.id, result }),
        )
      const params = message.params as Record<string, unknown> | undefined
      switch (message.method) {
        case 'initialize':
          return reply({
            protocolVersion: params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'fake', version: '1.0.0' },
          })
        case 'tools/list':
          return reply(
            params?.cursor
              ? {
                  tools: [
                    {
                      name: 'echo',
                      inputSchema: {
                        type: 'object',
                        properties: { text: { type: 'string' } },
                      },
                    },
                  ],
                }
              : {
                  tools: [
                    {
                      name: 'lookup',
                      description: 'look up an id',
                      inputSchema: {
                        type: 'object',
                        properties: { id: { type: 'string' } },
                      },
                      annotations: { readOnlyHint: true },
                    },
                  ],
                  nextCursor: 'page2',
                },
          )
        case 'tools/call': {
          const args = params?.arguments as Record<string, string>
          return reply({
            content: [{ type: 'text', text: `${params?.name}:${args.id}` }],
            isError: params?.name !== 'lookup',
          })
        }
      }
    },
  }
  return transport
}

test('registerMCPServer 用真实 MCP Client 分页注册并调用工具', async () => {
  const registry = new ToolRegistry(new ToolResultStore(join(root, 'outputs')))
  const names = await registry.registerMCPServer(
    'fake',
    new Client({ name: 'vela-test', version: '1.0.0' }),
    fakeServer(),
  )
  expect(names).toEqual(['mcp__fake__lookup', 'mcp__fake__echo'])

  const lookup = registry.get('mcp__fake__lookup')
  expect(lookup?.isReadOnly).toBe(true)
  expect(registry.get('mcp__fake__echo')?.isReadOnly).toBe(false)

  const result = await lookup?.execute({ id: '42' })
  expect(JSON.stringify(result)).toContain('lookup:42')

  await registry.closeAllMCP()
})
