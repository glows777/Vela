import type { Tool } from 'ai'
import z from 'zod'
import type { ToolDefinition, ToolNamespace, ToolRegistry } from './registry.ts'

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
    annotations: { readOnlyHint: true },
    // Searching changes what the model sees; other tools have no use for it (same as pi)
    exposure: 'model-only',
    // Use the calling session's registry: discovered deferred tools apply only to that session
    execute: async ({ query }: { query: string }, context) => {
      const results = (context?.registry ?? registry).searchTools(query)
      if (results.length === 0) return `No tools match "${query}"`
      // Vela has no codemode describeNamespace() yet, so the namespace instructions come with the tool
      return results.map<Tool & { namespace?: ToolNamespace }>((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.namespace ? { namespace: t.namespace } : {}),
      }))
    },
  }

  registry.register(toolSearchTool)
}
