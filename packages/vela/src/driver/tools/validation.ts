import {
  type ToolInputSchema,
  validateToolInput,
} from '../../shared/tool-schema.ts'

/** Validates (and parses) input against the tool's schema; throws when it does not match. */
export async function validateInput(
  inputSchema: ToolInputSchema<unknown>,
  input: unknown,
): Promise<unknown> {
  return validateToolInput(inputSchema, input)
}
