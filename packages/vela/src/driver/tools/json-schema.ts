import {
  createJsonSchema,
  isVelaJsonSchema,
  type VelaJsonSchema,
} from '../../shared/tool-schema.ts'
import type { ToolDefinition } from './registry.ts'

const jsonTools = new WeakSet<ToolDefinition>()

/**
 * Constructs a JSON Schema tool and ensures a `@cfworker/json-schema` validator is attached.
 *
 * MCP servers publish JSON Schema only. `createJsonSchema` attaches a `@cfworker/json-schema`
 * validator so constraints dropped by providers — such as `propertyNames` — stay enforced on
 * every model call without depending on AI SDK schema wrappers.
 */
export function defineJsonSchemaTool(
  tool: ToolDefinition & { inputSchema: VelaJsonSchema<unknown> },
): ToolDefinition {
  const schema = tool.inputSchema
  if (!isVelaJsonSchema(schema))
    throw new Error(
      'defineJsonSchemaTool requires a Vela createJsonSchema() wrapper',
    )
  const definition = schema.validate
    ? tool
    : { ...tool, inputSchema: createJsonSchema(() => schema.jsonSchema) }
  jsonTools.add(definition)
  return definition
}

export const isJsonSchemaTool = (tool: ToolDefinition): boolean =>
  jsonTools.has(tool)
