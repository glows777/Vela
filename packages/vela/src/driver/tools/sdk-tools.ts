import type { ProviderToolSpec } from '../../providers/index.ts'
import {
  type ToolInputSchema,
  toJsonSchemaSync,
} from '../../shared/tool-schema.ts'
import { estimateTextTokens } from '../messages.ts'
import { ToolRejection } from './recovery.ts'

interface RegistryTool {
  name: string
  description: string
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool inputs
  inputSchema: ToolInputSchema<any>
  hostedOnly?: true
  exposure?: string
}

export function toProviderTools<T extends RegistryTool>(
  tools: T[],
  execute: (
    tool: T,
    input: unknown,
    options: { toolCallId?: string; abortSignal?: AbortSignal },
  ) => Promise<unknown>,
): ProviderToolSpec[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    hostedOnly: tool.hostedOnly,
    execute: async (input, options) => {
      const output = await execute(tool, input, options)
      // Preserve the same error text for model-issued and nested calls.
      if (output instanceof ToolRejection) throw output.reason
      return output
    },
  }))
}

export function countToolTokens(tools: RegistryTool[], declared: Set<string>) {
  let active = 0,
    deferred = 0
  for (const tool of tools) {
    if (tool.exposure === 'hidden') continue
    const tokens = estimateTextTokens(
      JSON.stringify({
        name: tool.name,
        description: tool.description,
        inputSchema: toJsonSchemaSync(tool.inputSchema) ?? {},
      }),
    )
    if (declared.has(tool.name)) active += tokens
    else deferred += tokens
  }
  return { active, deferred, total: active + deferred }
}
