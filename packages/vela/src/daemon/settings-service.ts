import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadOwnerRuntimeConfig, type VelaSettings } from '../config/index.ts'
import {
  type Credential,
  type CredentialStore,
  fileCredentialStore,
  memoryCredentialStore,
  type ProviderDefinition,
  type ThinkingLevel,
  verifyProviderModel,
} from '../driver/index.ts'
import { ModelRegistry } from '../providers/models/index.ts'
import { loadModels } from '../providers/models-config.ts'
import type { VelaRuntime } from '../runtime-sdk-types.ts'
import { saveLarkSection, saveModelSetup, usableModel } from '../settings.ts'
import {
  PROVIDER_APIS,
  type ProviderApi,
  THINKING_LEVELS,
} from '../shared/provider-types.ts'
import type {
  RuntimeLarkSetupInput,
  RuntimeModelSetupInput,
  RuntimeSettingsProvider,
  RuntimeSettingsState,
} from '../shared/settings-types.ts'

const VERIFY_TIMEOUT_MS = 60_000

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function readRawSettingsMetadata(agentDir: string): {
  custom: Set<string>
  rawLark: Record<string, unknown>
} {
  const file = join(agentDir, 'config.json')
  if (!existsSync(file)) return { custom: new Set(), rawLark: {} }
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
    providers?: unknown
    lark?: unknown
  }
  const custom = new Set(
    isPlainObject(parsed?.providers) ? Object.keys(parsed.providers) : [],
  )
  const rawLark = isPlainObject(parsed?.lark) ? parsed.lark : {}
  return { custom, rawLark }
}

export function readEffectiveOwnerConfig(
  agentDir: string,
  hostEnv: Record<string, string | undefined>,
): { settings: VelaSettings; larkParseError?: string } {
  const { settings, larkError } = loadOwnerRuntimeConfig(agentDir, hostEnv)
  return {
    settings,
    ...(larkError ? { larkParseError: larkError } : {}),
  }
}

export function isLarkDisabledByExtension(
  extensions: readonly string[] | undefined,
): boolean {
  let disabled = false
  for (const entry of extensions ?? []) {
    if (entry === '-builtin:lark') disabled = true
    else if (entry === '+builtin:lark' || entry === 'builtin:lark')
      disabled = false
  }
  return disabled
}

/** SDK errors may contain configuration values. Only fixed diagnostic text crosses IPC. */
export function larkStartupDiagnostic(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause ?? '')
  if (message === 'Duplicate Lark chat id') {
    return 'Lark could not start. Remove duplicate chat IDs from lark.chats in config.json.'
  }
  if (message.startsWith('Unknown Lark tool ')) {
    return 'Lark could not start. Check the tools for enabled chats in config.json.'
  }
  if (message.startsWith('Unknown Lark thinking level ')) {
    return 'Lark could not start. Check the thinking levels for enabled chats in config.json.'
  }
  return 'Lark could not start. Check lark in config.json, then try again.'
}

export function resolveLarkSection(
  settings: VelaSettings,
  hostEnv: Record<string, string | undefined>,
): Record<string, unknown> {
  const rawSection = isPlainObject(settings.lark) ? settings.lark : {}
  return {
    ...(hostEnv.LARK_APP_ID ? { appId: hostEnv.LARK_APP_ID } : {}),
    ...(hostEnv.LARK_APP_SECRET ? { appSecret: hostEnv.LARK_APP_SECRET } : {}),
    ...(hostEnv.LARK_OWNERS ? { owners: hostEnv.LARK_OWNERS } : {}),
    ...rawSection,
  }
}

export function parseLarkChatIds(section: Record<string, unknown>): string[] {
  const entries =
    typeof section.chats === 'string' ? section.chats.split(',') : section.chats
  const chats = Array.isArray(entries)
    ? entries
        .map((entry) =>
          typeof entry === 'string'
            ? entry
            : isPlainObject(entry)
              ? entry.id
              : undefined,
        )
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter(Boolean)
    : []
  return [...new Set(chats)]
}

function isLocalOnlyOAuthBlocked(
  ref: string,
  providers: Record<string, ProviderDefinition>,
  credentials: CredentialStore,
  blockLocalOnlyOAuth?: boolean,
): { blocked: boolean; provider?: string } {
  if (!blockLocalOnlyOAuth) return { blocked: false }
  const slash = ref.indexOf('/')
  if (slash <= 0) return { blocked: false }
  const provider = ref.slice(0, slash)
  const cred = credentials.get(provider)
  const def = providers[provider]
  const registry = new ModelRegistry(providers, credentials, undefined, {
    blockLocalOnlyOAuth: true,
  })
  const blocked =
    cred?.type === 'oauth' &&
    Boolean(cred.localOnly || def?.oauth?.localOnly) &&
    !registry.authSource(provider)
  return blocked ? { blocked: true, provider } : { blocked: false }
}

function resolvesModel(
  ref: string,
  providers: Record<string, ProviderDefinition>,
  credentials: CredentialStore,
  blockLocalOnlyOAuth?: boolean,
): boolean {
  try {
    new ModelRegistry(providers, credentials, undefined, {
      blockLocalOnlyOAuth,
    }).resolve(ref)
    return true
  } catch {
    return false
  }
}

function usableSetup(check: {
  usable: boolean
  reason?: 'no-model' | 'missing-credential'
  provider?: string
}): RuntimeSettingsState['setup'] {
  if (check.usable) return { required: false }
  return {
    required: true,
    ...(check.reason ? { reason: check.reason } : {}),
    ...(check.provider ? { provider: check.provider } : {}),
  }
}

export async function getRuntimeSettingsState(params: {
  agentDir: string
  hostEnv: Record<string, string | undefined>
  runtime: VelaRuntime
  ephemeral?: boolean
  credentials?: CredentialStore
  hasCustomCredentials?: boolean
  extraProviders?: Record<string, ProviderDefinition>
  blockLocalOnlyOAuth?: boolean
  directModel?: boolean
  isLarkLoaded?: () => boolean
  isLarkEnabledInDb?: () => boolean
  getLarkConfigError?: () => string | undefined
}): Promise<RuntimeSettingsState> {
  const { agentDir, hostEnv, runtime } = params
  try {
    const [{ settings, larkParseError }, { custom, rawLark }, statuses] =
      params.ephemeral
        ? [
            { settings: {} as VelaSettings, larkParseError: undefined },
            {
              custom: new Set<string>(),
              rawLark: {} as Record<string, unknown>,
            },
            await runtime.channels.list(),
          ]
        : await Promise.all([
            Promise.resolve(readEffectiveOwnerConfig(agentDir, hostEnv)),
            Promise.resolve(readRawSettingsMetadata(agentDir)),
            runtime.channels.list(),
          ])
    const available = await runtime.models({ env: hostEnv })
    const loadedProviders = params.ephemeral
      ? {}
      : loadModels({
          agentDir,
          env: hostEnv,
          providers: settings.providers ?? {},
        })
    const providersMap: Record<string, ProviderDefinition> = {
      ...loadedProviders,
      ...(params.extraProviders ?? {}),
    }
    const credentials =
      params.credentials ??
      (params.ephemeral
        ? memoryCredentialStore()
        : fileCredentialStore(join(agentDir, 'auth.json')))
    const modelRegistry = new ModelRegistry(
      providersMap,
      credentials,
      undefined,
      { blockLocalOnlyOAuth: params.blockLocalOnlyOAuth },
    )
    const providers: RuntimeSettingsProvider[] = Object.entries(
      providersMap,
    ).map(([name, definition]: [string, ProviderDefinition]) => {
      const source = modelRegistry.authSource(name)
      return {
        name,
        ...(source ? { credential: source } : {}),
        custom: custom.has(name),
        models: (definition.models ?? []).map(
          ({ id, contextWindow, reasoning }) => ({
            id,
            ...(contextWindow === undefined ? {} : { contextWindow }),
            ...(reasoning === undefined ? {} : { reasoning }),
          }),
        ),
      }
    })

    const larkSection = resolveLarkSection(settings, hostEnv)
    const disabledByExtension = isLarkDisabledByExtension(settings.extensions)
    const larkStatus = statuses.find((s) => s.name === 'lark')
    const enabled =
      !disabledByExtension &&
      (larkStatus
        ? larkStatus.enabled !== false
        : (params.isLarkEnabledInDb?.() ?? true))
    const rawStartupError = larkParseError ?? params.getLarkConfigError?.()
    const startupError =
      enabled && rawStartupError
        ? larkStartupDiagnostic(rawStartupError)
        : undefined
    const loaded = Boolean(
      enabled &&
        !startupError &&
        (params.isLarkLoaded?.() || larkStatus?.connected),
    )

    const model = settings.model
    const hasAvailableModel = available.length > 0
    const blockedOAuth =
      model !== undefined
        ? isLocalOnlyOAuthBlocked(
            model,
            providersMap,
            credentials,
            params.blockLocalOnlyOAuth,
          )
        : { blocked: false }
    return {
      folder: agentDir,
      files: {
        config: join(agentDir, 'config.json'),
        auth: join(agentDir, 'auth.json'),
      },
      setup: params.directModel
        ? { required: false }
        : model === undefined
          ? hasAvailableModel
            ? { required: false }
            : { required: true, reason: 'no-model' }
          : blockedOAuth.blocked
            ? {
                required: true,
                reason: 'missing-credential',
                ...(blockedOAuth.provider
                  ? { provider: blockedOAuth.provider }
                  : {}),
              }
            : resolvesModel(
                  model,
                  providersMap,
                  credentials,
                  params.blockLocalOnlyOAuth,
                )
              ? usableSetup(
                  usableModel({
                    providers: providersMap,
                    credentials,
                    model,
                  }),
                )
              : { required: true, reason: 'unknown-model' },
      ...(model === undefined ? {} : { model }),
      ...(settings.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: settings.thinkingLevel }),
      lark: {
        appId: typeof larkSection.appId === 'string' ? larkSection.appId : '',
        appSecretSaved:
          typeof larkSection.appSecret === 'string' && !!larkSection.appSecret,
        chats: parseLarkChatIds(larkSection),
        envExpression:
          typeof rawLark.chats === 'string' && rawLark.chats.includes('$'),
        enabled,
        loaded,
        ...(startupError ? { startupError } : {}),
      },
      providers,
    }
  } catch {
    throw new Error(
      'Could not read desktop settings. Check the data directory, config.json and auth.json, then try again.',
    )
  }
}

function validateModelSetupInput(raw: unknown): RuntimeModelSetupInput {
  const value = isPlainObject(raw) ? raw : {}
  const text = (field: unknown, name: string): string => {
    if (typeof field !== 'string' || field.trim() === '') {
      throw new Error(`Enter a ${name}`)
    }
    return field.trim()
  }
  const provider = text(value.provider, 'provider')
  const model = text(value.model, 'model')
  if (value.key !== undefined && typeof value.key !== 'string') {
    throw new Error('The API key must be text')
  }
  const thinkingLevel = value.thinkingLevel as ThinkingLevel | undefined
  if (thinkingLevel !== undefined && !THINKING_LEVELS.includes(thinkingLevel)) {
    throw new Error('Choose a supported thinking level')
  }
  let custom: RuntimeModelSetupInput['custom']
  if (value.custom !== undefined) {
    const entry = isPlainObject(value.custom) ? value.custom : {}
    if (!PROVIDER_APIS.includes(entry.api as ProviderApi)) {
      throw new Error(`Choose one of ${PROVIDER_APIS.join(', ')}`)
    }
    let url: URL
    try {
      url = new URL(text(entry.baseUrl, 'base URL'))
    } catch {
      throw new Error('Enter the base URL, such as https://example.com/v1')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('The base URL must start with http:// or https://')
    }
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

function rotatedOAuth(
  stored: Credential | undefined,
  checked: Credential | undefined,
): Credential | undefined {
  if (stored?.type !== 'oauth' || checked?.type !== 'oauth') return undefined
  return checked.access === stored.access && checked.refresh === stored.refresh
    ? undefined
    : checked
}

export async function saveRuntimeModelSetup(params: {
  agentDir: string
  hostEnv: Record<string, string | undefined>
  runtime: VelaRuntime
  input: unknown
  ephemeral?: boolean
  credentials?: CredentialStore
  hasCustomCredentials?: boolean
  extraProviders?: Record<string, ProviderDefinition>
  blockLocalOnlyOAuth?: boolean
  directModel?: boolean
  isLarkLoaded?: () => boolean
  isLarkEnabledInDb?: () => boolean
  getLarkConfigError?: () => string | undefined
}): Promise<RuntimeSettingsState> {
  if (params.ephemeral) {
    throw new Error('Settings cannot be modified on an ephemeral runtime')
  }
  const { agentDir, hostEnv, runtime } = params
  const input = validateModelSetupInput(params.input)
  const { provider, model, key } = input
  const existingConfig = readEffectiveOwnerConfig(agentDir, hostEnv).settings
  const loadedBefore = loadModels({
    agentDir,
    env: hostEnv,
    providers: existingConfig.providers ?? {},
  })
  const mergedBefore: Record<string, ProviderDefinition> = {
    ...loadedBefore,
    ...(params.extraProviders ?? {}),
  }
  if (input.custom && mergedBefore[provider]) {
    throw new Error(
      `A provider named ${provider} already exists. Pick it above to change its model or key.`,
    )
  }
  const preset = input.custom
    ? {
        api: input.custom.api,
        baseUrl: input.custom.baseUrl,
        models: [{ id: model }],
      }
    : undefined
  const providers: Record<string, ProviderDefinition> = {
    ...loadModels({
      agentDir,
      env: hostEnv,
      providers: existingConfig.providers ?? {},
      ...(preset ? { overrides: { [provider]: preset } } : {}),
    }),
    ...(preset ? {} : (params.extraProviders ?? {})),
  }
  const definition = providers[provider]
  if (!definition) throw new Error(`No provider named ${provider}`)
  const authPath = join(agentDir, 'auth.json')
  const activeCredStore = params.credentials ?? fileCredentialStore(authPath)
  const stored = activeCredStore.get(provider)
  const storedOrNew = key ? { type: 'api_key' as const, key } : stored
  const memory = memoryCredentialStore(
    storedOrNew ? { [provider]: storedOrNew } : {},
  )
  const memoryRegistry = new ModelRegistry(providers, memory, undefined, {
    blockLocalOnlyOAuth: params.blockLocalOnlyOAuth,
  })
  const source = memoryRegistry.authSource(provider)
  if (!source) {
    throw new Error(
      params.blockLocalOnlyOAuth && storedOrNew?.type === 'oauth'
        ? `Local-only sign-in for ${provider} cannot be used on this host. Enter an API key.`
        : `No API key for ${provider}. Enter one; it is saved in ${authPath}.`,
    )
  }
  const ref = `${provider}/${model}`
  try {
    memoryRegistry.resolve(ref)
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error))
  }
  try {
    await verifyProviderModel(
      ref,
      providers,
      memory,
      AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      { blockLocalOnlyOAuth: params.blockLocalOnlyOAuth },
    )
  } catch (error) {
    const kept =
      key === undefined ? rotatedOAuth(stored, memory.get(provider)) : undefined
    if (kept) {
      await activeCredStore.modify(provider, async () => kept)
    }
    if (
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError')
    ) {
      throw new Error(
        kept
          ? 'The provider did not answer within a minute. The renewed sign-in was saved.'
          : 'The provider did not answer within a minute',
      )
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      kept ? `${message}. The renewed sign-in was saved.` : message,
    )
  }
  const toSave = key
    ? { type: 'api_key' as const, key }
    : rotatedOAuth(stored, memory.get(provider))
  if (toSave && params.hasCustomCredentials && params.credentials) {
    await params.credentials.modify(provider, async () => toSave)
  }
  await saveModelSetup({
    agentDir,
    ref,
    providers,
    ...(toSave && !params.hasCustomCredentials ? { credential: toSave } : {}),
    ...(preset ? { preset } : {}),
    ...(input.thinkingLevel === undefined
      ? {}
      : { thinkingLevel: input.thinkingLevel }),
  })
  await runtime.reloadConfig()
  return getRuntimeSettingsState({
    agentDir,
    hostEnv,
    runtime,
    ephemeral: params.ephemeral,
    credentials: params.credentials,
    hasCustomCredentials: params.hasCustomCredentials,
    extraProviders: params.extraProviders,
    blockLocalOnlyOAuth: params.blockLocalOnlyOAuth,
    directModel: params.directModel,
    isLarkLoaded: params.isLarkLoaded,
    isLarkEnabledInDb: params.isLarkEnabledInDb,
    getLarkConfigError: params.getLarkConfigError,
  })
}

function readLarkSectionSafe(
  agentDir: string,
  hostEnv: Record<string, string | undefined>,
): Record<string, unknown> {
  try {
    const { settings } = readEffectiveOwnerConfig(agentDir, hostEnv)
    return resolveLarkSection(settings, hostEnv)
  } catch {
    throw new Error(
      'Could not read Lark settings. Check config.json and try again.',
    )
  }
}

export async function saveRuntimeLarkSetup(params: {
  agentDir: string
  hostEnv: Record<string, string | undefined>
  runtime: VelaRuntime
  input: RuntimeLarkSetupInput
  ephemeral?: boolean
  credentials?: CredentialStore
  hasCustomCredentials?: boolean
  extraProviders?: Record<string, ProviderDefinition>
  blockLocalOnlyOAuth?: boolean
  directModel?: boolean
  isLarkLoaded?: () => boolean
  isLarkEnabledInDb?: () => boolean
  getLarkConfigError?: () => string | undefined
  verifyCredentials?: (appId: string, appSecret: string) => Promise<void>
  hasPendingOutboxDeliveries?: (chatId?: string) => boolean
  serializeWrite?: <T>(fn: () => Promise<T>) => Promise<T>
  onBeforeCredentialWrite?: () => void
}): Promise<RuntimeSettingsState> {
  if (params.ephemeral) {
    throw new Error('Settings cannot be modified on an ephemeral runtime')
  }
  const { agentDir, hostEnv, runtime, input } = params
  const runSerialized =
    params.serializeWrite ?? ((fn: () => Promise<RuntimeSettingsState>) => fn())
  const stateParams = {
    agentDir,
    hostEnv,
    runtime,
    ephemeral: params.ephemeral,
    credentials: params.credentials,
    hasCustomCredentials: params.hasCustomCredentials,
    extraProviders: params.extraProviders,
    blockLocalOnlyOAuth: params.blockLocalOnlyOAuth,
    directModel: params.directModel,
    isLarkLoaded: params.isLarkLoaded,
    isLarkEnabledInDb: params.isLarkEnabledInDb,
    getLarkConfigError: params.getLarkConfigError,
  }
  if ('enabled' in input && typeof input.enabled === 'boolean') {
    return runSerialized(async () => {
      if (!input.enabled) {
        await assertLarkScopeIdle(runtime, {
          message:
            'A Lark session is still running or queued. Wait for it to finish before changing Lark settings.',
          hasPendingOutboxDeliveries: params.hasPendingOutboxDeliveries,
        })
      }
      await runtime.channels.setEnabled('lark', input.enabled)
      if (input.enabled) {
        await runtime.reloadConfig()
      }
      return getRuntimeSettingsState(stateParams)
    })
  }
  if ('removeChat' in input && typeof input.removeChat === 'string') {
    const chatId = input.removeChat.trim()
    return runSerialized(async () => {
      if (chatId) {
        await assertLarkScopeIdle(runtime, {
          chatId,
          message:
            'This Lark group still has a reply running or waiting to send. Wait for it to finish before removing it.',
          hasPendingOutboxDeliveries: params.hasPendingOutboxDeliveries,
        })
      }
      await saveLarkSection({
        agentDir,
        removeChat: input.removeChat,
        env: hostEnv,
      })
      await runtime.reloadConfig()
      return getRuntimeSettingsState(stateParams)
    })
  }
  if (
    !('appId' in input) ||
    typeof input.appId !== 'string' ||
    (input.appSecret !== undefined && typeof input.appSecret !== 'string')
  ) {
    throw new Error('Invalid Lark settings')
  }
  const before = readLarkSectionSafe(agentDir, hostEnv)
  const appId = input.appId.trim()
  const secret = input.appSecret ?? before.appSecret
  if (!appId || typeof secret !== 'string' || !secret) {
    throw new Error('Enter the Lark app ID and secret.')
  }
  const verify =
    params.verifyCredentials ??
    (async (id: string, sec: string) => {
      const { connectLarkSetup } = await import('../lark/index.ts')
      const connection = await connectLarkSetup(
        id,
        sec,
        AbortSignal.timeout(30_000),
      )
      connection.stop()
    })
  try {
    await verify(appId, secret)
  } catch {
    throw new Error(
      'Could not verify Lark credentials. Check the app ID and secret and try again.',
    )
  }
  return runSerialized(async () => {
    const current = readLarkSectionSafe(agentDir, hostEnv)
    if (
      current.appId !== before.appId ||
      current.appSecret !== before.appSecret
    ) {
      throw new Error(
        'Lark credentials changed during verification. Check the current settings and try again.',
      )
    }
    await assertLarkScopeIdle(runtime, {
      message:
        'A Lark session is still running or queued. Wait for it to finish before changing Lark settings.',
      hasPendingOutboxDeliveries: params.hasPendingOutboxDeliveries,
    })
    params.onBeforeCredentialWrite?.()
    await saveLarkSection({
      agentDir,
      ...(appId === current.appId ? {} : { appId }),
      appSecret: input.appSecret,
      env: hostEnv,
    })
    await runtime.reloadConfig()
    return getRuntimeSettingsState(stateParams)
  })
}

export async function assertLarkScopeIdle(
  runtime: VelaRuntime,
  options: {
    chatId?: string
    message: string
    hasPendingOutboxDeliveries?: (chatId?: string) => boolean
  },
): Promise<void> {
  const allLarkBindings = await runtime.bindings.list({ channel: 'lark' })
  const bindings = options.chatId
    ? allLarkBindings.filter((b) => b.externalId === options.chatId)
    : allLarkBindings
  const larkSessionIds = new Set(
    bindings
      .map((b) => b.sessionId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )
  const larkProjectIds = new Set(
    bindings
      .map((b) => b.projectId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )
  const [sessions, allSessions, approvals] = await Promise.all([
    runtime.sessions.list({ includeArchived: false }),
    runtime.sessions.list({ includeArchived: true }),
    runtime.approvals.list().catch(() => []),
  ])
  const isInLarkScope = (s: { id: string; projectId?: string | null }) =>
    larkSessionIds.has(s.id) ||
    Boolean(s.projectId && larkProjectIds.has(s.projectId))

  for (const s of sessions) {
    if (!isInLarkScope(s)) continue
    const st = await runtime.sessions.status(s.id)
    if (
      st.activeRunId ||
      st.runningJobs > 0 ||
      s.state === 'running' ||
      s.state === 'waiting_human'
    ) {
      throw new Error(options.message)
    }
  }
  const sessionsById = new Map(allSessions.map((s) => [s.id, s]))
  for (const approval of approvals) {
    if (approval.status !== 'pending') continue
    const session = sessionsById.get(approval.sessionId)
    if (
      larkSessionIds.has(approval.sessionId) ||
      (session && isInLarkScope(session))
    ) {
      throw new Error(options.message)
    }
  }
  if (options.hasPendingOutboxDeliveries?.(options.chatId)) {
    throw new Error(options.message)
  }
}
