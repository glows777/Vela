import { afterEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
} from '@ai-sdk/provider'
import { responsesReply } from '../../../../../test/support/responses.ts'
import { tempDir } from '../../../../../test/support/vela.ts'
import { loadModels, memoryCredentialStore } from '../../../src/index.ts'
import { ModelRegistry } from '../../../src/models/index.ts'

const realFetch = globalThis.fetch
const dirs: { cleanup(): void }[] = []
afterEach(() => {
  globalThis.fetch = realFetch
  for (const dir of dirs.splice(0)) dir.cleanup()
})

/**
 * Records propertyNames is what an MCP server built with Zod publishes: Zod 3 emits
 * `{ minLength: 1 }` or `{ enum: [...] }` without `type: "string"`, Zod 4 emits `{ type: "string" }`.
 * OpenAI-compatible endpoints reject the keyword, so the SDK strips it and warns; a schema it can't
 * normalize (an omitted type, before @ai-sdk/openai 4.0.104) must not fail the whole request.
 */
test.each([
  ['Zod 3 constrained key', { minLength: 1 }],
  ['Zod 3 enum key', { enum: ['a', 'b'] }],
  ['Zod 4 string key', { type: 'string' }],
] as const)(
  'a record tool schema with %s reaches the provider without propertyNames',
  async (_label, propertyNames) => {
    const dir = tempDir('vela-openai-json-schema-')
    dirs.push(dir)
    writeFileSync(
      join(dir.path, 'models.json'),
      JSON.stringify({
        providers: {
          compat: {
            api: 'openai-responses',
            baseUrl: 'https://example.test/v1',
            apiKey: 'test',
            models: [{ id: 'deepseek-flash' }],
          },
        },
      }),
    )
    const requests: Record<string, unknown>[] = []
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body))
      requests.push(body)
      return responsesReply(body)
    }) as typeof fetch
    const registry = new ModelRegistry(
      loadModels({ agentDir: dir.path }),
      memoryCredentialStore(),
    )
    const model = registry.resolve('compat/deepseek-flash')
      .model as LanguageModelV4
    const options: LanguageModelV4CallOptions = {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [
        {
          type: 'function',
          name: 'mcp__demo__lookup',
          description: 'lookup',
          inputSchema: {
            type: 'object',
            properties: {
              notes: {
                type: 'object',
                propertyNames,
                additionalProperties: { type: 'string' },
              },
            },
            required: ['notes'],
            additionalProperties: false,
          },
        },
      ],
    }
    const result = await model.doGenerate(options)
    const [tool] = (requests[0]?.tools ?? []) as { parameters: unknown }[]
    expect(JSON.stringify(tool?.parameters)).not.toContain('propertyNames')
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        type: 'compatibility',
        feature: 'JSON Schema propertyNames',
      }),
    )
  },
)
