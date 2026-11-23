/**
 * Provider-agnostic tool input schemas (Zod or JSON Schema) and validation.
 *
 * Replaces direct `ai` (`FlexibleSchema`, `Schema`, `asSchema`, `jsonSchema`) imports
 * across `driver/` and `mcp/`. AI SDK `jsonSchema()` wrapping happens only at the
 * `src/providers/` request edge.
 */

import { Validator } from '@cfworker/json-schema'
import z from 'zod'

export type JsonSchemaObject = Record<string, unknown>

export interface VelaJsonSchema<T = unknown> {
  readonly __velaJsonSchema: true
  readonly jsonSchema: JsonSchemaObject | PromiseLike<JsonSchemaObject>
  readonly validate?: (
    value: unknown,
  ) =>
    | { success: true; value: T }
    | { success: false; error: Error }
    | Promise<{ success: true; value: T } | { success: false; error: Error }>
}

/** Either a Zod schema (v3/v4/mini) or a Vela JSON Schema descriptor (e.g. from MCP). */
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool inputs
export type ToolInputSchema<T = any> =
  | z.ZodType<T>
  | z.core.$ZodType<T>
  | {
      readonly _def: unknown
      safeParseAsync(
        data: unknown,
      ): Promise<{ success: true; data: T } | { success: false; error: Error }>
    }
  | VelaJsonSchema<T>

/** Check whether `value` is a Vela JSON Schema wrapper created by `createJsonSchema()`. */
export function isVelaJsonSchema(value: unknown): value is VelaJsonSchema {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__velaJsonSchema' in value &&
    (value as { __velaJsonSchema?: unknown }).__velaJsonSchema === true &&
    'jsonSchema' in value
  )
}

/** Check whether `value` is a Zod v4 / zod/mini schema. */
function isZodV4Schema(value: unknown): value is z.ZodType {
  return typeof value === 'object' && value !== null && '_zod' in value
}

/** Check whether `value` is a Zod schema (v3, v4, or zod/mini). */
function isZodSchema(value: unknown): value is z.ZodType {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('_zod' in value || '_def' in value)
  )
}

/** Construct a Vela JSON Schema with built-in `@cfworker/json-schema` validation. */
export function createJsonSchema<T = unknown>(
  schema:
    | JsonSchemaObject
    | (() => JsonSchemaObject | PromiseLike<JsonSchemaObject>),
  options?: {
    validate?: VelaJsonSchema<T>['validate']
  },
): VelaJsonSchema<T> {
  let resolved: JsonSchemaObject | PromiseLike<JsonSchemaObject> | undefined
  let compiled: Promise<Validator> | undefined
  const getSchema = () => {
    resolved ??= typeof schema === 'function' ? schema() : schema
    return resolved
  }
  const validate: NonNullable<VelaJsonSchema<T>['validate']> =
    options?.validate ??
    (async (value) => {
      compiled ??= Promise.resolve(getSchema()).then(
        (json) =>
          new Validator(json as ConstructorParameters<typeof Validator>[0]),
      )
      const result = (await compiled).validate(value)
      return result.valid
        ? { success: true, value: value as T }
        : { success: false, error: new Error(JSON.stringify(result.errors)) }
    })

  return {
    __velaJsonSchema: true,
    get jsonSchema() {
      return getSchema()
    },
    validate,
  }
}

/** Best-effort JSON Schema extraction for Zod v3 schemas (preserves property names & descriptions for BM25). */
function zodV3ToJsonSchema(schema: unknown): JsonSchemaObject {
  let current = schema as { _def?: Record<string, unknown> } | undefined
  let description: string | undefined
  while (current && typeof current === 'object' && current._def) {
    const def = current._def
    if (typeof def.description === 'string' && !description) {
      description = def.description
    }
    if (def.innerType && typeof def.innerType === 'object') {
      current = def.innerType as { _def?: Record<string, unknown> }
      continue
    }
    if (def.schema && typeof def.schema === 'object') {
      current = def.schema as { _def?: Record<string, unknown> }
      continue
    }
    break
  }
  const def = current?._def
  const rawShape =
    typeof def?.shape === 'function'
      ? (def.shape as () => Record<string, unknown>)()
      : def?.shape && typeof def.shape === 'object'
        ? (def.shape as Record<string, unknown>)
        : undefined
  if (rawShape) {
    const properties: Record<string, JsonSchemaObject> = {}
    for (const [key, field] of Object.entries(rawShape)) {
      properties[key] = zodV3ToJsonSchema(field)
    }
    return {
      type: 'object',
      properties,
      ...(description ? { description } : {}),
    }
  }
  return description ? { description } : {}
}

/** Convert a `ToolInputSchema` (Zod or `VelaJsonSchema`) to a plain JSON Schema object. */
export async function toJsonSchema(
  inputSchema: ToolInputSchema,
): Promise<JsonSchemaObject> {
  if (isVelaJsonSchema(inputSchema)) {
    return (await inputSchema.jsonSchema) as JsonSchemaObject
  }
  if (isZodV4Schema(inputSchema)) {
    return z.toJSONSchema(inputSchema, {
      target: 'draft-7',
      io: 'input',
      unrepresentable: 'any',
    }) as JsonSchemaObject
  }
  if (isZodSchema(inputSchema)) {
    return zodV3ToJsonSchema(inputSchema)
  }
  // Support any foreign schema carrying a `jsonSchema` property (e.g. legacy test fixtures).
  if (
    typeof inputSchema === 'object' &&
    inputSchema !== null &&
    'jsonSchema' in inputSchema
  ) {
    return (await (inputSchema as { jsonSchema: JsonSchemaObject })
      .jsonSchema) as JsonSchemaObject
  }
  throw new Error('Tool inputSchema must be a Zod schema or createJsonSchema()')
}

/** Synchronous best-effort JSON Schema conversion for token estimation. */
export function toJsonSchemaSync(
  inputSchema: ToolInputSchema,
): JsonSchemaObject | undefined {
  if (isVelaJsonSchema(inputSchema)) {
    const raw = inputSchema.jsonSchema
    if (raw && typeof raw === 'object' && !('then' in raw)) {
      return raw as JsonSchemaObject
    }
    return undefined
  }
  if (isZodV4Schema(inputSchema)) {
    return z.toJSONSchema(inputSchema, {
      target: 'draft-7',
      io: 'input',
      unrepresentable: 'any',
    }) as JsonSchemaObject
  }
  if (isZodSchema(inputSchema)) {
    return zodV3ToJsonSchema(inputSchema)
  }
  return undefined
}

/** Validate (and parse) raw tool input against a Zod or JSON Schema; throws on mismatch. */
export async function validateToolInput(
  inputSchema: ToolInputSchema,
  input: unknown,
): Promise<unknown> {
  if (isZodSchema(inputSchema)) {
    const parsed =
      typeof inputSchema.safeParseAsync === 'function'
        ? await inputSchema.safeParseAsync(input)
        : await z.safeParseAsync(
            inputSchema as unknown as z.core.$ZodType,
            input,
          )
    if (!parsed.success) throw parsed.error
    return parsed.data
  }
  if (isVelaJsonSchema(inputSchema)) {
    if (inputSchema.validate) {
      const validated = await inputSchema.validate(input)
      if (!validated.success) throw validated.error
      return validated.value
    }
    const json = await inputSchema.jsonSchema
    const validated = new Validator(
      json as ConstructorParameters<typeof Validator>[0],
    ).validate(input)
    if (!validated.valid) throw new Error(JSON.stringify(validated.errors))
    return input
  }
  throw new Error('Tool inputSchema must be a Zod schema or createJsonSchema()')
}
