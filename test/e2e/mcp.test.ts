import { afterEach, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import z from 'zod'
import { mcp } from '../../src/extensions/mcp/index.ts'
import type { SessionUI } from '../../src/index.ts'
import { fauxText, fauxToolCall } from '../../src/testing/faux.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

/** In-memory MCP servers by name: each connect starts a fresh server */
function servers(setups: Record<string, (server: McpServer) => void>) {
  const started: Record<string, number> = {}
  const live: Record<string, McpServer> = {}
  return {
    started,
    live,
    createTransport: async (entry: { name: string }) => {
      const setup = setups[entry.name]
      if (!setup) throw new Error(`no fake server ${entry.name}`)
      const server = new McpServer(
        { name: entry.name, version: '1.0.0' },
        {
          instructions: `Use ${entry.name} tools for ${entry.name} things.\nMore detail.`,
          capabilities: { tools: { listChanged: true } },
        },
      )
      setup(server)
      const [client, side] = InMemoryTransport.createLinkedPair()
      await server.connect(side)
      started[entry.name] = (started[entry.name] ?? 0) + 1
      live[entry.name] = server
      return client
    },
  }
}

const docs = (server: McpServer) => {
  server.registerTool(
    'search-pages',
    {
      description: 'Search documentation pages by keyword',
      inputSchema: { query: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => ({
      content: [{ type: 'text', text: `3 pages match ${query}` }],
    }),
  )
  server.registerTool(
    'delete-page',
    {
      description: 'Delete a documentation page',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => ({
      content: [{ type: 'text', text: `page ${id} does not exist` }],
      isError: true,
    }),
  )
}

test('MCP tools are deferred under mcp__<server>__<tool>; tool_search loads them and calls reach the server', async () => {
  const fake = servers({ docs })
  const t = createTestVela({
    extensions: [
      mcp({
        servers: { docs: { command: 'unused' } },
        createTransport: fake.createTransport,
      }),
    ],
    responses: [
      (req) => {
        expect(req.tools).not.toContain('mcp__docs__search_pages')
        // Connected or still connecting, the server is named in the system prompt
        expect(req.system).toContain('mcp__docs')
        return fauxToolCall('tool_search', { query: 'search pages', limit: 1 })
      },
      (req) => {
        // The system prompt lists the server once, with the first line of its instructions
        expect(req.system).toContain(
          '- mcp__docs (1 tool) — Use docs tools for docs things.',
        )
        expect(req.system).not.toContain('mcp__docs__delete_page')
        expect(req.toolResults[0]!.output).toContain(
          'Use docs tools for docs things.\nMore detail.',
        )
        expect(req.tools).toContain('mcp__docs__search_pages')
        return fauxToolCall('mcp__docs__search_pages', { query: 'install' })
      },
      (req) => fauxText(`Result: ${req.toolResults[0]!.output}`),
    ],
  })
  await t.run('How do I install it?')
  expect(t.lastAssistantText()).toBe('Result: 3 pages match install')
  expect(t.internals.registry.get('mcp__docs__search_pages')).toMatchObject({
    annotations: { readOnlyHint: true },
    namespace: { name: 'mcp__docs' },
  })
  expect(t.vela.extensions().find((e) => e.name === 'mcp')?.tools).toEqual([
    'mcp__docs__search_pages',
    'mcp__docs__delete_page',
  ])
})

test('an MCP isError result is an error result for the model', async () => {
  const fake = servers({ docs })
  const t = createTestVela({
    extensions: [
      mcp({
        servers: { docs: { command: 'unused', exposure: 'direct' } },
        createTransport: fake.createTransport,
      }),
    ],
    responses: [
      (req) => {
        // direct: declared on the first prompt (the prompt waits for the server)
        expect(req.tools).toContain('mcp__docs__delete_page')
        return fauxToolCall('mcp__docs__delete_page', { id: 'x' })
      },
      (req) => fauxText(`Got: ${req.toolResults[0]!.output}`),
    ],
  })
  await t.run('Delete page x')
  const end = t
    .eventsOf('tool_execution_end')
    .find((e) => e.toolName === 'mcp__docs__delete_page')
  expect(end?.isError).toBe(true)
  expect(t.lastAssistantText()).toContain('page x does not exist')
})

test('toolExposure picks exposure per tool; hidden tools are unreachable', async () => {
  const fake = servers({ docs })
  const t = createTestVela({
    extensions: [
      mcp({
        servers: {
          docs: {
            command: 'unused',
            exposure: 'hidden',
            toolExposure: { 'search-*': 'direct' },
          },
        },
        createTransport: fake.createTransport,
      }),
    ],
    responses: [
      (req) => {
        expect(req.tools).toContain('mcp__docs__search_pages')
        expect(req.tools).not.toContain('mcp__docs__delete_page')
        expect(req.system).not.toContain('mcp__docs (')
        return fauxText('ok')
      },
    ],
  })
  await t.run('hi')
})

test('progress notifications become tool_execution_update events', async () => {
  const fake = servers({
    slow: (server) =>
      server.registerTool(
        'build',
        { description: 'Build the project', inputSchema: {} },
        async (_args, extra) => {
          const progressToken = extra._meta?.progressToken
          if (progressToken !== undefined)
            await extra.sendNotification({
              method: 'notifications/progress',
              params: {
                progressToken,
                progress: 1,
                total: 2,
                message: 'compiling',
              },
            })
          return { content: [{ type: 'text', text: 'built' }] }
        },
      ),
  })
  const t = createTestVela({
    extensions: [
      mcp({
        servers: { slow: { command: 'unused', exposure: 'direct' } },
        createTransport: fake.createTransport,
      }),
    ],
    responses: [fauxToolCall('mcp__slow__build', {}), fauxText('done')],
  })
  await t.run('build')
  expect(
    t.eventsOf('tool_execution_update').map((e) => e.partialResult),
  ).toEqual(['compiling'])
})

test('guests get no MCP tools', async () => {
  const fake = servers({ docs })
  const t = createTestVela({
    session: { role: 'guest' },
    extensions: [
      mcp({
        servers: { docs: { command: 'unused' } },
        createTransport: fake.createTransport,
      }),
    ],
    responses: [
      fauxToolCall('tool_search', { query: 'mcp__docs__search_pages' }),
      (req) => {
        expect(req.toolResults[0]!.output).toBe('No matching tools found.')
        expect(req.system).not.toContain('mcp__docs (')
        expect(req.tools).not.toContain('mcp__docs__search_pages')
        return fauxText('no access')
      },
    ],
  })
  await t.run('search docs')
  expect(t.session.registry.decide('mcp__docs__search_pages')).toBe('deny')
})

test('tools/list_changed registers new tools; a dropped connection reconnects on the next call', async () => {
  let withNewTool = false
  const newTool = (server: McpServer) =>
    server.registerTool(
      'new-tool',
      { description: 'Added later', inputSchema: {} },
      async () => ({ content: [{ type: 'text', text: 'new' }] }),
    )
  const fake = servers({
    docs: (server) => {
      docs(server)
      if (withNewTool) newTool(server)
    },
  })
  const t = createTestVela({
    extensions: [
      mcp({
        servers: { docs: { command: 'unused', exposure: 'direct' } },
        createTransport: fake.createTransport,
      }),
    ],
    responses: [fauxText('ready')],
  })
  await t.run('hi')
  withNewTool = true
  newTool(fake.live.docs!)
  for (
    let i = 0;
    i < 100 && !t.internals.registry.get('mcp__docs__new_tool');
    i++
  )
    await Bun.sleep(5)
  expect(t.internals.registry.get('mcp__docs__new_tool')).toBeDefined()

  // The server goes away: the next call connects again
  await fake.live.docs!.close()
  t.model.push(fauxToolCall('mcp__docs__new_tool', {}), (req) =>
    fauxText(`Got ${req.toolResults[0]!.output}`),
  )
  await t.run('use the new tool')
  expect(t.lastAssistantText()).toBe('Got new')
  expect(fake.started.docs).toBe(2)
})

test('configuration errors and failed servers are reported once; /mcp shows status; dispose closes connections', async () => {
  const notes: string[] = []
  const ui: SessionUI = {
    notify: (message) => notes.push(message),
    confirm: async () => false,
    select: async () => undefined,
    input: async () => undefined,
  }
  const fake = servers({ docs })
  const t = createTestVela({
    session: { ui },
    extensions: [
      mcp({
        servers: {
          docs: { command: 'unused' },
          broken: { command: 'unused' },
          // Invalid on purpose: checked at runtime, not only by types
          old: { url: 'https://example.com/sse', type: 'sse' } as never,
          lazy: { command: 'unused', exposure: 'codemode' } as never,
          off: { command: 'unused', enabled: false },
        },
        createTransport: fake.createTransport,
      }),
    ],
    responses: [
      fauxToolCall('tool_search', { query: 'pages' }),
      fauxText('ok'),
    ],
  })
  await t.run('hi')
  const reports = notes.filter((note) => note.startsWith('[mcp]'))
  // Configuration errors right away, failed connections once they settle
  expect(reports).toHaveLength(2)
  expect(reports[0]).toContain('legacy SSE transport is not supported')
  expect(reports[0]).toContain('Vela has no codemode yet')
  expect(reports[1]).toBe(
    '[mcp] MCP server "broken" failed to connect: no fake server broken\nRun /mcp for details.',
  )

  notes.length = 0
  await t.run('/mcp')
  expect(notes[0]).toContain(
    '- docs: connected, 2 tools, exposure deferred (options)',
  )
  expect(notes[0]).toContain('- broken: failed, 0 tools')
  expect(notes[0]).toContain('- off: disabled')

  const docsServer = fake.live.docs!
  let closed = false
  docsServer.server.onclose = () => {
    closed = true
  }
  await t.vela.dispose()
  expect(closed).toBe(true)
})

test('only non-guest sessions see servers still connecting; dispose stops a connect in progress', async () => {
  // A server that never answers initialize
  let closed = false
  const hanging = async (): Promise<Transport> => {
    const transport: Transport = {
      start: async () => {},
      send: async () => {},
      close: async () => {
        closed = true
        transport.onclose?.()
      },
    }
    return transport
  }
  const t = createTestVela({
    extensions: [
      mcp({
        servers: { slow: { command: 'unused', description: 'Slow docs' } },
        createTransport: hanging,
      }),
    ],
    responses: [
      (req) => {
        expect(req.system).toContain('- mcp__slow — Slow docs')
        return fauxText('owner')
      },
      (req) => {
        expect(req.system).not.toContain('mcp__slow')
        return fauxText('guest')
      },
    ],
  })
  await t.run('hi')
  await t.vela.session('g', { role: 'guest' }).prompt('Hello')
  expect(closed).toBe(false)
  await t.vela.dispose()
  expect(closed).toBe(true)
})

test('a stdio server: Vela starts the process, calls its tool and stops it on dispose', async () => {
  const pidFile = join(tmpdir(), `vela-mcp-${crypto.randomUUID()}.pid`)
  const t = createTestVela({
    extensions: [
      mcp({
        servers: {
          local: {
            command: process.execPath,
            args: [join(import.meta.dir, '../fixtures/mcp-echo-server.ts')],
            env: { ECHO_PREFIX: 'echo:', PID_FILE: pidFile },
            exposure: 'direct',
          },
        },
      }),
    ],
    responses: [
      fauxToolCall('mcp__local__echo', { text: 'hi' }),
      (req) => fauxText(`Server said ${req.toolResults[0]!.output}`),
    ],
  })
  await t.run('echo hi')
  expect(t.lastAssistantText()).toBe('Server said echo:hi')
  const pid = Number(readFileSync(pidFile, 'utf8'))
  rmSync(pidFile)
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  expect(alive()).toBe(true)
  await t.vela.dispose()
  for (let i = 0; i < 200 && alive(); i++) await Bun.sleep(10)
  expect(alive()).toBe(false)
})
