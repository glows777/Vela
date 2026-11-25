import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import z from 'zod'
import {
  cleanupTestVelas,
  createTestVela,
  tempDir,
} from '../../../../test/support/vela.ts'
import { parseServers } from '../../src/mcp/config.ts'
import { mcp } from '../../src/mcp/index.ts'
import { McpPool } from '../../src/mcp/pool.ts'
import { fauxText, fauxToolCall } from '../../src/testing/core/index.ts'

const dirs: { cleanup(): void }[] = []
afterEach(async () => {
  await cleanupTestVelas()
  for (const dir of dirs.splice(0)) dir.cleanup()
})

function fakeMcpFactory() {
  const started: string[] = []
  const closed: string[] = []
  return {
    started,
    closed,
    createTransport: async (entry: { name: string }, cwd: string) => {
      const server = new McpServer({ name: entry.name, version: '1.0.0' })
      server.registerTool(
        'ping',
        { description: 'Ping', inputSchema: { msg: z.string() } },
        async ({ msg }) => ({
          content: [{ type: 'text', text: `${cwd}:${msg}` }],
        }),
      )
      const [client, side] = InMemoryTransport.createLinkedPair()
      server.server.onclose = () => {
        closed.push(`${entry.name}@${cwd}`)
      }
      await server.connect(side)
      started.push(`${entry.name}@${cwd}`)
      return client
    },
  }
}

test('McpPool isolates buckets by (cwd, mcpServers) hash and supports refcounted idle TTL eviction', async () => {
  const root = tempDir('vela-mcp-pool-')
  dirs.push(root)
  const dirA = join(root.path, 'proj-a')
  const dirB = join(root.path, 'proj-b')
  const fake = fakeMcpFactory()
  const pool = new McpPool({ idleTtlMs: 40 })

  const { entries: entries1 } = parseServers({
    srv: { command: 'unused', exposure: 'direct' },
  })
  const { entries: entries2 } = parseServers({
    srv: { command: 'unused-other', exposure: 'direct' },
  })

  try {
    const tools1: string[] = []
    const lease1 = pool.acquire({
      cwd: dirA,
      entries: entries1,
      errors: [],
      createTransport: fake.createTransport,
      onTools: (conn) => tools1.push(...conn.tools.map((t) => t.name)),
      onError: () => {},
    })
    lease1.start()
    await lease1.waitForAll()
    expect(fake.started).toEqual([`srv@${dirA}`])
    expect(tools1).toEqual(['ping'])

    // Second lease on same (dirA, entries1) reuses existing connection and immediately gets tools
    const tools2: string[] = []
    const lease2 = pool.acquire({
      cwd: dirA,
      entries: entries1,
      errors: [],
      createTransport: fake.createTransport,
      onTools: (conn) => tools2.push(...conn.tools.map((t) => t.name)),
      onError: () => {},
    })
    expect(lease2.key).toBe(lease1.key)
    expect(tools2).toEqual(['ping'])
    expect(fake.started).toEqual([`srv@${dirA}`])

    // Different cwd gets an isolated bucket
    const leaseB = pool.acquire({
      cwd: dirB,
      entries: entries1,
      errors: [],
      createTransport: fake.createTransport,
      onTools: () => {},
      onError: () => {},
    })
    leaseB.start()
    await leaseB.waitForAll()
    expect(leaseB.key).not.toBe(lease1.key)

    // Same cwd with different config gets a separate bucket
    const leaseDiffConfig = pool.acquire({
      cwd: dirA,
      entries: entries2,
      errors: [],
      createTransport: fake.createTransport,
      onTools: () => {},
      onError: () => {},
    })
    expect(leaseDiffConfig.key).not.toBe(lease1.key)
    expect(pool.size).toBe(3)

    // Releasing one of two leases on dirA keeps bucket alive
    await lease1.release()
    await Bun.sleep(60)
    expect(fake.closed).toEqual([])

    // Releasing second lease starts 40ms idle timer; re-acquiring before expiry cancels eviction
    await lease2.release()
    await Bun.sleep(15)
    const lease3 = pool.acquire({
      cwd: dirA,
      entries: entries1,
      errors: [],
      createTransport: fake.createTransport,
      onTools: () => {},
      onError: () => {},
    })
    await Bun.sleep(45)
    expect(fake.closed).toEqual([])

    // Releasing lease3 and letting TTL expire closes dirA bucket
    await lease3.release()
    for (let i = 0; i < 40 && fake.closed.length === 0; i++) await Bun.sleep(10)
    expect(fake.closed).toEqual([`srv@${dirA}`])
    expect(pool.has(lease1.key)).toBe(false)

    await leaseB.release()
    await leaseDiffConfig.release()
  } finally {
    await pool.dispose()
  }
})

test('mcp() with shared McpPool keeps system prompt free of transient <mcp_servers> across turns', async () => {
  const fake = fakeMcpFactory()
  const pool = new McpPool({ idleTtlMs: 1000 })
  const t = createTestVela({
    extensions: [
      mcp({
        pool,
        servers: { docs: { command: 'unused' } },
        createTransport: fake.createTransport,
      }),
    ],
    responses: [
      (req) => {
        expect(req.system).not.toContain('<mcp_servers>')
        return fauxToolCall('tool_search', { query: 'ping' })
      },
      (req) => {
        expect(req.system).not.toContain('<mcp_servers>')
        return fauxText('ok')
      },
    ],
  })
  await t.run('hi')
  expect(t.lastAssistantText()).toBe('ok')
  await t.vela.dispose()
  await pool.dispose()
})
