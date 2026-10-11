// A tiny stdio MCP server for test/e2e/mcp.test.ts: one `echo` tool that prefixes $ECHO_PREFIX.
import { writeFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import z from 'zod'

const server = new McpServer({ name: 'echo', version: '1.0.0' })
server.registerTool(
  'echo',
  { description: 'Echo the text back', inputSchema: { text: z.string() } },
  async ({ text }) => ({
    content: [
      { type: 'text', text: `${process.env.ECHO_PREFIX ?? ''}${text}` },
    ],
  }),
)
if (process.env.PID_FILE)
  writeFileSync(process.env.PID_FILE, String(process.pid))
await server.connect(new StdioServerTransport())
