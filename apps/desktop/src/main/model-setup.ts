import { join } from 'node:path'
import { saveModelSetup } from '@glows777/vela'
import {
  fileCredentialStore,
  loadModels,
  memoryCredentialStore,
  type ProviderDefinition,
  verifyProviderModel,
} from '@glows777/vela-core'
import type { ModelSetup } from '../shared/bridge.ts'
import { customProviders } from './settings.ts'

/** Long enough for a slow provider, short enough that a stuck one ends with a reason. */
const VERIFY_TIMEOUT_MS = 60_000

/**
 * Checks a provider and model with one small request, then saves it through the same steps
 * `vela setup` uses: `auth.json`, `models.json` (custom providers) and `settings.json`. Nothing is
 * written before the check passes.
 */
export async function saveModel(options: {
  agentDir: string
  input: ModelSetup
  env: Record<string, string | undefined>
}): Promise<{
  provider: string
  ref: string
  definition: ProviderDefinition
  written: string[]
}> {
  const { agentDir, input } = options
  const provider = input.provider.trim()
  const model = input.model.trim()
  if (!provider || !model) throw new Error('Choose a provider and a model')
  const key = input.key?.trim()
  if (input.custom && customProviders(agentDir).has(provider))
    throw new Error(
      `A provider named ${provider} already exists. Pick it above to change its model or key.`,
    )
  const preset = input.custom
    ? {
        api: input.custom.api,
        baseUrl: input.custom.baseUrl.trim(),
        models: [{ id: model }],
      }
    : undefined
  const authPath = join(agentDir, 'auth.json')
  const stored = fileCredentialStore(authPath).get(provider)
  const credential = key ? { type: 'api_key' as const, key } : stored
  const memory = memoryCredentialStore(
    credential ? { [provider]: credential } : {},
  )
  const providers = loadModels({
    agentDir,
    env: options.env,
    ...(preset ? { overrides: { [provider]: preset } } : {}),
  })
  const definition = providers[provider]
  if (!definition) throw new Error(`No provider named ${provider}`)
  const source = definition.authSource
    ? definition.authSource(memory.get(provider))
    : 'configured'
  if (!source)
    throw new Error(
      `No API key for ${provider}. Enter one; it is saved in ${authPath}.`,
    )
  const ref = `${provider}/${model}`
  try {
    await verifyProviderModel(
      ref,
      providers,
      memory,
      AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    )
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError')
    )
      throw new Error('The provider did not answer within a minute')
    // Electron gives the page a plain Error's message; an AI SDK error class would arrive as
    // "AI_APICallError: <reason>".
    throw new Error(error instanceof Error ? error.message : String(error))
  }
  const saved = await saveModelSetup({
    agentDir,
    ref,
    providers,
    ...(key ? { credential: { type: 'api_key', key } } : {}),
    ...(preset ? { preset } : {}),
  })
  return {
    provider,
    ref,
    definition: saved.definition,
    written: saved.written,
  }
}
