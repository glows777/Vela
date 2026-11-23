import {
  tool as AITool,
  type FlexibleSchema,
  type Tool,
  type ToolSet,
} from 'ai'
import { isToolContent, toAIToolOutput } from '../messages.ts'
import { ToolRejection } from './recovery.ts'

interface SDKTool {
  name: string
  description: string
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool inputs
  inputSchema: FlexibleSchema<any>
  hostedOnly?: true
  exposure?: string
}

export function toAISDKTools<T extends SDKTool>(
  tools: T[],
  hostedTools: ToolSet,
  execute: (
    tool: T,
    input: unknown,
    options: { toolCallId?: string; abortSignal?: AbortSignal },
  ) => Promise<unknown>,
): ToolSet {
  const result: Record<string, Tool> = {}
  for (const tool of tools) {
    const hosted = hostedTools[tool.name]
    if (hosted) {
      result[tool.name] = hosted
      continue
    }
    if (tool.hostedOnly) continue
    result[tool.name] = AITool({
      description: tool.description,
      inputSchema: tool.inputSchema,
      toModelOutput: ({ output }) =>
        isToolContent(output)
          ? toAIToolOutput({ type: 'content', value: output })
          : typeof output === 'string'
            ? { type: 'text', value: output }
            : {
                type: 'json',
                value: JSON.parse(JSON.stringify(output ?? null)),
              },
      execute: async (input, options) => {
        const output = await execute(tool, input, {
          toolCallId: options?.toolCallId,
          abortSignal: options?.abortSignal,
        })
        // Preserve the same error text for model-issued and nested calls.
        if (output instanceof ToolRejection) throw output.reason
        return output
      },
    })
  }
  return result
}

export function countToolTokens(tools: SDKTool[], declared: Set<string>) {
  let active = 0,
    deferred = 0
  for (const tool of tools) {
    if (tool.exposure === 'hidden') continue
    const tokens = Math.ceil(
      JSON.stringify({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }).length / 4,
    )
    if (declared.has(tool.name)) active += tokens
    else deferred += tokens
  }
  return { active, deferred, total: active + deferred }
}
