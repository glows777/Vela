import type { Schema } from 'ai'
import type { ToolDefinition } from './registry.ts'

const jsonTools = new WeakSet<ToolDefinition>()

/** Explicitly constructs a JSON Schema tool; ordinary registerTool still requires Zod. */
export function defineJsonSchemaTool(
  tool: ToolDefinition & { inputSchema: Schema<unknown> },
): ToolDefinition {
  const schema = tool.inputSchema
  if (
    typeof schema !== 'object' ||
    schema === null ||
    Reflect.get(schema, Symbol.for('vercel.ai.schema')) !== true ||
    !('jsonSchema' in schema) ||
    !('validate' in schema)
  )
    throw new Error(
      'defineJsonSchemaTool requires an AI SDK jsonSchema() wrapper',
    )
  jsonTools.add(tool)
  return tool
}

export const isJsonSchemaTool = (tool: ToolDefinition): boolean =>
  jsonTools.has(tool)
