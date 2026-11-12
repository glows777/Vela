import { Validator } from '@cfworker/json-schema'
import { jsonSchema, type Schema } from 'ai'
import type { ToolDefinition } from './registry.ts'

const jsonTools = new WeakSet<ToolDefinition>()

/**
 * Explicitly constructs a JSON Schema tool; ordinary registerTool still requires Zod.
 *
 * MCP servers publish JSON Schema only. Without a validator the AI SDK accepts any input before
 * calling the tool (`safeValidateTypes` passes when `validate` is absent), so constraints the
 * outgoing request drops — `propertyNames`, for one — would stop being enforced anywhere on the
 * model path. The schema keeps validating against the original JSON Schema here.
 */
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
  const definition = schema.validate
    ? tool
    : { ...tool, inputSchema: validatingSchema(schema) }
  jsonTools.add(definition)
  return definition
}

export const isJsonSchemaTool = (tool: ToolDefinition): boolean =>
  jsonTools.has(tool)

/** The same schema, with a validator over its original JSON Schema when it has none. */
function validatingSchema(schema: Schema<unknown>): Schema<unknown> {
  let compiled: Promise<Validator> | undefined
  return jsonSchema(() => schema.jsonSchema, {
    validate: async (value) => {
      compiled ??= Promise.resolve(schema.jsonSchema).then(
        (jsonSchema) => new Validator(jsonSchema),
      )
      const result = (await compiled).validate(value)
      return result.valid
        ? { success: true, value }
        : { success: false, error: new Error(JSON.stringify(result.errors)) }
    },
  })
}
