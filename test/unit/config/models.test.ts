import { afterEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadModels } from '../../../src/config/index.ts'
import { ModelRegistry } from '../../../src/models/index.ts'
import { tempDir } from '../../support/vela.ts'

const dirs: { cleanup(): void }[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})

function agentDir(models?: unknown) {
  const dir = tempDir('vela-models-')
  dirs.push(dir)
  if (models !== undefined)
    writeFileSync(join(dir.path, 'models.json'), JSON.stringify(models))
  return dir.path
}

const modelOf = (providers: ReturnType<typeof loadModels>, ref: string) =>
  new ModelRegistry(providers).resolve(ref)

test('openai and anthropic are built in and read their keys from the environment', () => {
  const providers = loadModels({
    agentDir: agentDir(),
    env: { OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'a' },
  })
  expect(Object.keys(providers)).toEqual(['openai', 'anthropic'])
  const openai = modelOf(providers, 'openai/gpt-x').model
  expect(openai).toMatchObject({ provider: 'openai.chat', modelId: 'gpt-x' })
  const claude = modelOf(providers, 'anthropic/claude-x').model
  expect(claude).toMatchObject({ modelId: 'claude-x' })
})

test('a missing API key fails when the model is created, naming the variable', () => {
  const providers = loadModels({ agentDir: agentDir(), env: {} })
  expect(() => modelOf(providers, 'anthropic/claude-x')).toThrow(
    'ANTHROPIC_API_KEY',
  )
})

test('models.json adds providers and merges into built-in ones', () => {
  const dir = agentDir({
    providers: {
      // Only models given: adds metadata; api / key still come from the built-in provider
      openai: { models: [{ id: 'gpt-x', contextWindow: 400_000 }] },
      local: {
        api: 'openai-responses',
        baseUrl: 'http://localhost:1234/v1',
        apiKey: '${LOCAL_KEY}',
        models: [{ id: 'm', name: 'Local M', reasoning: false }],
      },
    },
  })
  const providers = loadModels({
    agentDir: dir,
    env: { OPENAI_API_KEY: 'k', LOCAL_KEY: 'l' },
  })
  const registry = new ModelRegistry(providers)
  expect(registry.list().map((m) => m.ref)).toEqual(['openai/gpt-x', 'local/m'])
  expect(registry.resolve('openai/gpt-x').info.contextWindow).toBe(400_000)
  const local = registry.resolve('local/m')
  expect(local.model).toMatchObject({ provider: 'local.responses' })
  expect(local.info).toMatchObject({ name: 'Local M', reasoning: false })
})

test('mistakes in models.json are reported with the file name', () => {
  const notJson = agentDir()
  writeFileSync(join(notJson, 'models.json'), '{')
  expect(() => loadModels({ agentDir: notJson })).toThrow('is not valid JSON')
  expect(() =>
    loadModels({ agentDir: agentDir({ providers: { x: { api: 'grpc' } } }) }),
  ).toThrow('providers.x.api must be one of')
  expect(() =>
    loadModels({
      agentDir: agentDir({ providers: { x: { models: [{ name: 'no id' }] } } }),
    }),
  ).toThrow('providers.x.models must be an array of objects with an id')
  // A new provider without api: fails only when used
  const noApi = loadModels({
    agentDir: agentDir({ providers: { x: { apiKey: 'k' } } }),
  })
  expect(() => modelOf(noApi, 'x/m')).toThrow('providers.x is missing api')
})
