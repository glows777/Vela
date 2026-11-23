import { join } from 'node:path'
import {
  type Credential,
  fileCredentialStore,
  memoryCredentialStore,
  type ProviderDefinition,
  saveModelSetup,
  verifyProviderModel,
} from '@glows777/vela'
import { loadModels, resolveModel } from '@glows777/vela/legacy-desktop'
import {
  type ModelSetup,
  type ProviderApi,
  THINKING_LEVELS,
  type ThinkingLevel,
} from '../shared/bridge.ts'

/** Long enough for a slow provider, short enough that a stuck one ends with a reason. */
const VERIFY_TIMEOUT_MS = 60_000
const APIS: readonly ProviderApi[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
]

/**
 * The renderer's payload crosses IPC, so its shape is checked here instead of a `TypeError` surfacing
 * from a field read or an arbitrary string reaching a file write.
 */
function readModelSetup(input: unknown): ModelSetup {
  const value = (input ?? {}) as Record<string, unknown>
  const text = (field: unknown, name: string): string => {
    if (typeof field !== 'string' || field.trim() === '')
      throw new Error(`Enter a ${name}`)
    return field.trim()
  }
  const provider = text(value.provider, 'provider')
  const model = text(value.model, 'model')
  if (value.key !== undefined && typeof value.key !== 'string')
    throw new Error('The API key must be text')
  const thinkingLevel = value.thinkingLevel as ThinkingLevel | undefined
  if (thinkingLevel !== undefined && !THINKING_LEVELS.includes(thinkingLevel))
    throw new Error('Choose a supported thinking level')
  let custom: ModelSetup['custom']
  if (value.custom !== undefined) {
    const entry = (value.custom ?? {}) as Record<string, unknown>
    if (!APIS.includes(entry.api as ProviderApi))
      throw new Error(`Choose one of ${APIS.join(', ')}`)
    let url: URL
    try {
      url = new URL(text(entry.baseUrl, 'base URL'))
    } catch {
      throw new Error('Enter the base URL, such as https://example.com/v1')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new Error('The base URL must start with http:// or https://')
    custom = { api: entry.api as ProviderApi, baseUrl: url.href }
  }
  const key = value.key
  return {
    provider,
    model,
    ...(typeof key === 'string' && key.trim() ? { key: key.trim() } : {}),
    ...(custom ? { custom } : {}),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  }
}

/** A saved sign-in the check refreshed: the provider already rotated it, so it has to be kept. */
function rotated(
  stored: Credential | undefined,
  checked: Credential | undefined,
): Credential | undefined {
  if (stored?.type !== 'oauth' || checked?.type !== 'oauth') return undefined
  const same =
    checked.access === stored.access && checked.refresh === stored.refresh
  return same ? undefined : checked
}

/**
 * Checks a provider and model with one small request, then saves it through the same steps
 * `vela setup` uses: `auth.json`, `models.json` (custom providers) and `settings.json`. Nothing is
 * written before the check passes, except the renewed sign-in the provider itself rotated.
 */
export async function saveModel(options: {
  agentDir: string
  input: unknown
  env: Record<string, string | undefined>
}): Promise<{
  provider: string
  ref: string
  definition: ProviderDefinition
  written: string[]
}> {
  const { agentDir } = options
  const input = readModelSetup(options.input)
  const { provider, model } = input
  const key = input.key
  // `loadModels` starts from the built-ins, so this also refuses a name that would repoint one.
  if (input.custom && loadModels({ agentDir, env: options.env })[provider])
    throw new Error(
      `A provider named ${provider} already exists. Pick it above to change its model or key.`,
    )
  const preset = input.custom
    ? {
        api: input.custom.api,
        baseUrl: input.custom.baseUrl,
        models: [{ id: model }],
      }
    : undefined
  const authPath = join(agentDir, 'auth.json')
  const stored = fileCredentialStore(authPath).get(provider)
  const storedOrNew = key ? { type: 'api_key' as const, key } : stored
  const memory = memoryCredentialStore(
    storedOrNew ? { [provider]: storedOrNew } : {},
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
  // The check a session makes when it opens: a provider name or model id nothing can load is refused
  // here, before auth.json and models.json are written for it.
  try {
    resolveModel(ref, { providers, credentials: memory })
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error))
  }
  try {
    await verifyProviderModel(
      ref,
      providers,
      memory,
      AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    )
  } catch (error) {
    // Using a saved sign-in can refresh it, and the provider has rotated the old refresh token by
    // then. That rotation is written back even though this model was refused, or the next run has
    // nothing to sign in with. A typed key is never saved here: it has not been verified, and the
    // saved model stays as it was.
    const kept =
      key === undefined ? rotated(stored, memory.get(provider)) : undefined
    if (kept)
      await fileCredentialStore(authPath).modify(provider, async () => kept)
    if (
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError')
    )
      throw new Error(
        kept
          ? 'The provider did not answer within a minute. The renewed sign-in was saved.'
          : 'The provider did not answer within a minute',
      )
    // Electron gives the page a plain Error's message; an AI SDK error class would arrive as
    // "AI_APICallError: <reason>".
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      kept ? `${message}. The renewed sign-in was saved.` : message,
    )
  }
  // A saved OAuth credential can be refreshed while it is checked (the provider rotates tokens);
  // write that back too, or auth.json keeps the expired one the next run cannot use.
  const toSave = key
    ? { type: 'api_key' as const, key }
    : rotated(stored, memory.get(provider))
  const saved = await saveModelSetup({
    agentDir,
    ref,
    providers,
    ...(toSave ? { credential: toSave } : {}),
    ...(preset ? { preset } : {}),
    ...(input.thinkingLevel === undefined
      ? {}
      : { thinkingLevel: input.thinkingLevel }),
  })
  return {
    provider,
    ref,
    definition: saved.definition,
    written: saved.written,
  }
}
