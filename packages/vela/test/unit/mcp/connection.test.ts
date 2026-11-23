import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { McpConnection } from '../../../src/mcp/connection.ts'

test('McpConnection initializes with the real @glows777/vela package version', async () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  const server = new Server(
    { name: 'version-probe', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
  await server.connect(serverTransport)

  const connection = new McpConnection({
    entry: {
      name: 'probe',
      config: { command: 'probe' },
      source: 'test',
    },
    cwd: process.cwd(),
    onTools: () => {},
    createTransport: async () => clientTransport,
  })
  try {
    await connection.connect()
    expect(server.getClientVersion()?.version).toBe(pkg.version)
    expect(server.getClientVersion()?.version).not.toBe('0.0.0')
  } finally {
    await connection.close()
    await server.close()
  }
})
