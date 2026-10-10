import z from 'zod'
import type { ToolDefinition, ToolRegistry } from './registry.ts'

export const DEFAULT_TOOL_SEARCH_LIMIT = 8

const toolSearchToolSchema = z.object({
  query: z
    .string()
    .describe(
      'Keywords describing the tools you need (e.g. "github issues"), or exact tool names separated by commas',
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Maximum number of tools to load. Defaults to ${DEFAULT_TOOL_SEARCH_LIMIT}.`,
    ),
})

/** The first line of a description, for the list of loaded tools. */
const firstLine = (text: string) => text.trim().split(/\r?\n/)[0] ?? ''

export const registerToolSearchTool = (registry: ToolRegistry) => {
  const toolSearchTool: ToolDefinition = {
    name: 'tool_search',
    // Like pi, the description does not list the tools, so it stays the same when tools register
    description:
      'Searches tools that are not loaded yet (such as MCP server tools) by keyword and loads the best matches; they are available from your next call. Exact tool names separated by commas load exactly those tools.',
    inputSchema: toolSearchToolSchema,
    annotations: { readOnlyHint: true },
    // Searching changes what the model sees; other tools have no use for it (same as pi)
    exposure: 'model-only',
    // Use the calling session's registry: loaded tools apply only to that session
    execute: async (
      { query, limit }: { query: string; limit?: number },
      context,
    ) => {
      if (query.trim() === '') throw new Error('query must not be empty')
      const tools = await (context?.registry ?? registry).searchTools(
        query,
        limit ?? DEFAULT_TOOL_SEARCH_LIMIT,
      )
      if (tools.length === 0) return 'No matching tools found.'
      const lines = [
        `Loaded ${tools.length} tool${tools.length === 1 ? '' : 's'}. They are available from your next call:`,
        ...tools.map((t) => `- ${t.name}: ${firstLine(t.description)}`),
      ]
      // Vela has no codemode describeNamespace() yet, so the namespace instructions (e.g. MCP server
      // instructions) come with the loaded tools, once per namespace
      const described = new Set<string>()
      for (const { namespace } of tools) {
        if (!namespace?.instructions || described.has(namespace.name)) continue
        described.add(namespace.name)
        lines.push(
          '',
          `<instructions namespace="${namespace.name}">`,
          namespace.instructions.trim(),
          '</instructions>',
        )
      }
      return lines.join('\n')
    },
  }

  registry.register(toolSearchTool)
}
