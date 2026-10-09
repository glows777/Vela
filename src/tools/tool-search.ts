import type { Tool } from 'ai'
import z from 'zod'
import type { ToolDefinition, ToolRegistry } from './registry.ts'

const toolSearchToolSchema = z.object({
  query: z
    .string()
    .describe(
      'Tool name, e.g. "mcp__github__list_issues". Separate multiple names with commas',
    ),
})

export const registerToolSearchTool = (registry: ToolRegistry) => {
  const toolSearchTool: ToolDefinition = {
    name: 'tool_search',
    description:
      "Fetches the full definition of a deferred tool. Pass a tool name from the deferred tool list in the system prompt; returns that tool's full parameter schema.",
    inputSchema: toolSearchToolSchema,
    isConcurrencySafe: true,
    isReadOnly: true,
    // Use the calling session's registry: discovered deferred tools apply only to that session
    execute: async ({ query }: { query: string }, context) => {
      const results = (context?.registry ?? registry).searchTools(query)
      if (results.length === 0) return `No tools match "${query}"`
      return results.map<Tool>((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }))
    },
  }

  registry.register(toolSearchTool)
}
