import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Credential,
  type CredentialStore,
  fileCredentialStore,
  type ProviderConfig,
  type ProviderDefinition,
  type ThinkingLevel,
  writeProviderPreset,
} from '@glows777/vela-core'
import { saveUserSettings } from './cli/user-settings.ts'

/**
 * The non-interactive half of setup, shared by `vela setup` and SDK hosts such as the desktop app:
 * what a verified answer writes, in the order it writes it. Asking the questions stays with each
 * frontend, and so does verifying the choice (`verifyProviderModel`), so neither frontend owns a
 * second copy of where the files live or which key goes in which one.
 */

function readObject(path: string): Record<string, unknown> {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** `$` in a saved string would read as an environment reference, so store it doubled. */
function escapeExpression(value: string): string {
  return value.replace(/\$/g, () => '$$')
}

function expandExpression(
  value: string,
  env: Record<string, string | undefined>,
): string {
  return value.replace(
    /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced, bare) =>
      match === '$$' ? '$' : (env[braced ?? bare] ?? ''),
  )
}

/**
 * Writes a provider and model choice the caller has already verified: the credential to `auth.json`,
 * a custom provider preset to `models.json`, then `defaultModel` (and the thinking level when given)
 * to `settings.json`. Paths it wrote are returned in that order; fields it was not given are left as
 * they are on disk.
 */
export async function saveModelSetup(options: {
  agentDir: string
  /** `provider/id` to save as the default model. */
  ref: string
  /** The providers the choice was verified against; its entry becomes the host's provider. */
  providers: Record<string, ProviderDefinition>
  /** Credential to store; omit to keep `auth.json` untouched. */
  credential?: Credential
  /** Custom provider definition for `models.json`; omit for a built-in provider. */
  preset?: ProviderConfig
  /** Thinking level to save with the model; omit to keep the saved one. */
  thinkingLevel?: ThinkingLevel
}): Promise<{ written: string[]; definition: ProviderDefinition }> {
  const { agentDir, ref } = options
  const slash = ref.indexOf('/')
  if (slash <= 0 || slash === ref.length - 1)
    throw new Error(`Model must be provider/id, got "${ref}"`)
  const provider = ref.slice(0, slash)
  const definition = options.providers[provider]
  if (!definition) throw new Error(`No provider named ${provider}`)
  const written: string[] = []
  const authPath = join(agentDir, 'auth.json')
  if (options.credential) {
    await fileCredentialStore(authPath).modify(
      provider,
      async () => options.credential,
    )
    written.push(authPath)
  }
  if (options.preset) {
    writeProviderPreset(agentDir, provider, options.preset)
    written.push(join(agentDir, 'models.json'))
  }
  const settingsPath = join(agentDir, 'settings.json')
  const settings = readObject(settingsPath)
  settings.defaultModel = ref
  if (options.thinkingLevel)
    settings.defaultThinkingLevel = options.thinkingLevel
  saveUserSettings(agentDir, settings)
  written.push(settingsPath)
  return { written, definition }
}

/**
 * Writes the `extensionConfig.lark` section of `settings.json`: the app credentials, one enabled chat
 * and the "Run Lark in this app" switch. Keys it was not given keep their saved value. Chats saved as
 * an environment expression (`"$LARK_CHATS"`) cannot be rewritten without losing that expression, so
 * adding or removing one throws instead.
 */
export async function saveLarkSection(options: {
  agentDir: string
  appId?: string
  appSecret?: string
  /** A chat to enable; an entry for it is kept as it is when already present. */
  addChat?: string
  /** A chat to disable. */
  removeChat?: string
  /** Whether this host runs the Lark channel. */
  runInApp?: boolean
  /** Environment for `$VAR` in saved chat ids; the CLI and the app pass `process.env`. */
  env?: Record<string, string | undefined>
}): Promise<{ written: string[] }> {
  const env = options.env ?? {}
  const path = join(options.agentDir, 'settings.json')
  const settings = readObject(path)
  const extensionConfig = objectOf(settings.extensionConfig)
  const lark = objectOf(extensionConfig.lark)
  const next: Record<string, unknown> = { ...lark }
  if (options.addChat !== undefined || options.removeChat !== undefined) {
    if (typeof lark.chats === 'string' && lark.chats.includes('$'))
      throw new Error(
        'Existing chats use an environment expression. Add the group manually to preserve that setting.',
      )
    const chats: unknown[] = Array.isArray(lark.chats)
      ? [...lark.chats]
      : typeof lark.chats === 'string'
        ? lark.chats
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean)
        : []
    const idOf = (entry: unknown): string | undefined =>
      typeof entry === 'string'
        ? expandExpression(entry, env).trim()
        : typeof objectOf(entry).id === 'string'
          ? expandExpression(objectOf(entry).id as string, env).trim()
          : undefined
    if (options.removeChat !== undefined)
      next.chats = chats.filter((entry) => idOf(entry) !== options.removeChat)
    else if (!chats.some((entry) => idOf(entry) === options.addChat))
      next.chats = [...chats, options.addChat]
    else next.chats = chats
  }
  if (options.appId !== undefined) next.appId = escapeExpression(options.appId)
  if (options.appSecret !== undefined)
    next.appSecret = escapeExpression(options.appSecret)
  if (options.runInApp !== undefined) next.runInApp = options.runInApp
  extensionConfig.lark = next
  settings.extensionConfig = extensionConfig
  saveUserSettings(options.agentDir, settings)
  return { written: [path] }
}

/**
 * Whether a `provider/id` can answer: its provider is known (an unknown one, or a passthrough model,
 * counts as usable) and that provider has a credential — `auth.json`, a key in `models.json` or the
 * provider's environment variable.
 */
export function usableModel(options: {
  providers: Record<string, ProviderDefinition>
  credentials: CredentialStore
  /** The saved or session model; without one there is nothing to answer with. */
  model?: string
}): {
  usable: boolean
  reason?: 'no-model' | 'missing-credential'
  provider?: string
} {
  const model = options.model
  if (!model) return { usable: false, reason: 'no-model' }
  const slash = model.indexOf('/')
  const provider = slash > 0 ? model.slice(0, slash) : model
  const definition = options.providers[provider]
  if (!definition?.authSource) return { usable: true, provider }
  return definition.authSource(options.credentials.get(provider)) !== undefined
    ? { usable: true, provider }
    : { usable: false, reason: 'missing-credential', provider }
}
