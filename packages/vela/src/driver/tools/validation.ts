import { Validator } from '@cfworker/json-schema'
import { asSchema, type FlexibleSchema } from 'ai'

/** Validates (and parses) input against the tool's schema; throws when it does not match. */
export async function validateInput(
  inputSchema: FlexibleSchema<unknown>,
  input: unknown,
): Promise<unknown> {
  const schema = asSchema(inputSchema)
  if (schema.validate) {
    const validated = await schema.validate(input)
    if (!validated.success) throw validated.error
    return validated.value
  }
  const validated = new Validator(await schema.jsonSchema).validate(input)
  if (!validated.valid) throw new Error(JSON.stringify(validated.errors))
  return input
}
