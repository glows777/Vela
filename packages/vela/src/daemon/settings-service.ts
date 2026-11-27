import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadOwnerRuntimeConfig, type VelaSettings } from '../config/index.ts'
import { resolveModel } from '../driver/diagnostics.ts'
import {
  type Credential,
  type CredentialStore,
  fileCredentialStore,
  memoryCredentialStore,
  type ProviderDefinition,
  type ThinkingLevel,
  verifyProviderModel,
} from '../driver/index.ts'
import type { LarkTransport } from '../lark/transport.ts'
import { loadModels } from '../providers/models-config.ts'
import type { VelaRuntime } from '../runtime-sdk-types.ts'
import { saveLarkSection, saveModelSetup, usableModel } from '../settings.ts'
import {
  PROVIDER_APIS,
  type ProviderApi,
  THINKING_LEVELS,
} from '../shared/provider-types.ts'
import type {
  RuntimeLarkDiscoveryGroup,
  RuntimeLarkSetupInput,
  RuntimeModelSetupInput,
  RuntimeSettingsProvider,
  RuntimeSettingsState,
} from '../shared/settings-types.ts'

const VERIFY_TIMEOUT_MS = 60_000
const DISCOVERY_TIMEOUT_MS = 120_000

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

function readEffectiveOwnerConfig(
  agentDir: string,
  hostEnv: Record<string, string | undefined>,
): { settings: VelaSettings; larkParseError?: string } {
  const { settings, larkError } = loadOwnerRuntimeConfig(agentDir, hostEnv)
  return {
    settings,
    ...(larkError ? { larkParseError: larkError } : {}),
  }
}

function isLarkDisabledByExtension(
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

function resolveLarkSection(
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

function parseLarkChatIds(section: Record<string, unknown>): string[] {
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

function resolvesModel(
  ref: string,
  providers: Record<string, ProviderDefinition>,
  credentials: CredentialStore,
): boolean {
  try {
    resolveModel(ref, { providers, credentials })
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
  directModel?: boolean
  isLarkLoaded?: () => boolean
  getLarkConfigError?: () => string | undefined
}): Promise<RuntimeSettingsState> {
  const { agentDir, hostEnv, runtime } = params
  try {
    const [{ settings, larkParseError }, { custom, rawLark }, statuses] =
      await Promise.all([
        Promise.resolve(readEffectiveOwnerConfig(agentDir, hostEnv)),
        Promise.resolve(readRawSettingsMetadata(agentDir)),
        runtime.channels.list(),
      ])
    const available = await runtime.models({ env: hostEnv })
    const providersMap = loadModels({
      agentDir,
      env: hostEnv,
      providers: settings.providers ?? {},
    })
    const credentials = fileCredentialStore(join(agentDir, 'auth.json'))
    const providers: RuntimeSettingsProvider[] = Object.entries(
      providersMap,
    ).map(([name, definition]: [string, ProviderDefinition]) => ({
      name,
      ...(definition.authSource
        ? { credential: definition.authSource(credentials.get(name)) }
        : {}),
      custom: custom.has(name),
      models: (definition.models ?? []).map(
        ({ id, contextWindow, reasoning }) => ({
          id,
          ...(contextWindow === undefined ? {} : { contextWindow }),
          ...(reasoning === undefined ? {} : { reasoning }),
        }),
      ),
    }))

    const larkSection = resolveLarkSection(settings, hostEnv)
    const disabledByExtension = isLarkDisabledByExtension(settings.extensions)
    const larkStatus = statuses.find((s) => s.name === 'lark')
    const enabled = !disabledByExtension && larkStatus?.enabled !== false
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
          : resolvesModel(model, providersMap, credentials)
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
  directModel?: boolean
  isLarkLoaded?: () => boolean
  getLarkConfigError?: () => string | undefined
}): Promise<RuntimeSettingsState> {
  const { agentDir, hostEnv, runtime } = params
  const input = validateModelSetupInput(params.input)
  const { provider, model, key } = input
  const existingConfig = readEffectiveOwnerConfig(agentDir, hostEnv).settings
  if (
    input.custom &&
    loadModels({
      agentDir,
      env: hostEnv,
      providers: existingConfig.providers ?? {},
    })[provider]
  ) {
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
  const providers = loadModels({
    agentDir,
    env: hostEnv,
    providers: existingConfig.providers ?? {},
    ...(preset ? { overrides: { [provider]: preset } } : {}),
  })
  const definition = providers[provider]
  if (!definition) throw new Error(`No provider named ${provider}`)
  const authPath = join(agentDir, 'auth.json')
  const stored = fileCredentialStore(authPath).get(provider)
  const storedOrNew = key ? { type: 'api_key' as const, key } : stored
  const memory = memoryCredentialStore(
    storedOrNew ? { [provider]: storedOrNew } : {},
  )
  const source = definition.authSource
    ? definition.authSource(memory.get(provider))
    : 'configured'
  if (!source) {
    throw new Error(
      `No API key for ${provider}. Enter one; it is saved in ${authPath}.`,
    )
  }
  const ref = `${provider}/${model}`
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
    const kept =
      key === undefined ? rotatedOAuth(stored, memory.get(provider)) : undefined
    if (kept) {
      await fileCredentialStore(authPath).modify(provider, async () => kept)
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
  await saveModelSetup({
    agentDir,
    ref,
    providers,
    ...(toSave ? { credential: toSave } : {}),
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
    directModel: params.directModel,
    isLarkLoaded: params.isLarkLoaded,
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
  directModel?: boolean
  isLarkLoaded?: () => boolean
  getLarkConfigError?: () => string | undefined
  verifyCredentials?: (appId: string, appSecret: string) => Promise<void>
}): Promise<RuntimeSettingsState> {
  const { agentDir, hostEnv, runtime, input } = params
  if ('enabled' in input && typeof input.enabled === 'boolean') {
    if (!input.enabled) {
      await assertLarkIdle(runtime)
    }
    await runtime.channels.setEnabled('lark', input.enabled)
    if (input.enabled) {
      await runtime.reloadConfig()
    }
    return getRuntimeSettingsState({
      agentDir,
      hostEnv,
      runtime,
      directModel: params.directModel,
      isLarkLoaded: params.isLarkLoaded,
      getLarkConfigError: params.getLarkConfigError,
    })
  }
  if ('removeChat' in input && typeof input.removeChat === 'string') {
    await saveLarkSection({
      agentDir,
      removeChat: input.removeChat,
      env: hostEnv,
    })
    await runtime.reloadConfig()
    return getRuntimeSettingsState({
      agentDir,
      hostEnv,
      runtime,
      directModel: params.directModel,
      isLarkLoaded: params.isLarkLoaded,
      getLarkConfigError: params.getLarkConfigError,
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
  const current = readLarkSectionSafe(agentDir, hostEnv)
  if (
    current.appId !== before.appId ||
    current.appSecret !== before.appSecret
  ) {
    throw new Error(
      'Lark credentials changed during verification. Check the current settings and try again.',
    )
  }
  await saveLarkSection({
    agentDir,
    ...(appId === current.appId ? {} : { appId }),
    appSecret: input.appSecret,
  })
  await runtime.reloadConfig()
  return getRuntimeSettingsState({
    agentDir,
    hostEnv,
    runtime,
    directModel: params.directModel,
    isLarkLoaded: params.isLarkLoaded,
    getLarkConfigError: params.getLarkConfigError,
  })
}

async function assertLarkIdle(runtime: VelaRuntime): Promise<void> {
  const bindings = await runtime.bindings.list({ channel: 'lark' })
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
  const sessions = await runtime.sessions.list({ includeArchived: false })
  for (const s of sessions) {
    if (
      !larkSessionIds.has(s.id) &&
      (!s.projectId || !larkProjectIds.has(s.projectId))
    ) {
      continue
    }
    const st = await runtime.sessions.status(s.id)
    if (st.activeRunId || st.runningJobs > 0 || s.state === 'running') {
      throw new Error(
        'A Lark session is still running or queued. Wait for it to finish before changing Lark settings.',
      )
    }
  }
}

export async function discoverRuntimeLarkGroup(params: {
  agentDir: string
  hostEnv: Record<string, string | undefined>
  runtime: VelaRuntime
  signal?: AbortSignal
  pauseLark?: () => Promise<void>
  resumeLark?: () => Promise<void>
  createDiscoveryTransport?: () => Promise<LarkTransport | undefined>
  timeoutMs?: number
}): Promise<RuntimeLarkDiscoveryGroup | undefined> {
  const { agentDir, hostEnv, runtime, signal } = params
  if (signal?.aborted) return undefined
  const [{ settings }, statuses] = await Promise.all([
    Promise.resolve(readEffectiveOwnerConfig(agentDir, hostEnv)),
    runtime.channels.list(),
  ])
  const disabledByExtension = isLarkDisabledByExtension(settings.extensions)
  const larkStatus = statuses.find((s) => s.name === 'lark')
  const enabled = !disabledByExtension && larkStatus?.enabled !== false
  const larkSection = resolveLarkSection(settings, hostEnv)
  const appId =
    typeof larkSection.appId === 'string' ? larkSection.appId.trim() : ''
  const appSecret =
    typeof larkSection.appSecret === 'string'
      ? larkSection.appSecret.trim()
      : ''
  const customTransport = await params.createDiscoveryTransport?.()
  if (!enabled || (!customTransport && (!appId || !appSecret))) {
    customTransport?.stop()
    throw new Error('Configure Lark to run in this app before adding a group.')
  }
  const excludedChatIds = new Set(parseLarkChatIds(larkSection))
  for (const chat of await runtime.channels.chats('lark').catch(() => [])) {
    excludedChatIds.add(chat.chatId)
  }

  const timeoutSignal = AbortSignal.timeout(
    params.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
  )
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal

  await assertLarkIdle(runtime)
  await params.pauseLark?.()
  try {
    const { connectLarkSetup, discoverLarkGroup } = await import(
      '../lark/index.ts'
    )
    if (customTransport) {
      try {
        return await discoverLarkGroup(
          customTransport,
          combinedSignal,
          excludedChatIds,
        )
      } finally {
        customTransport.stop()
      }
    }
    const connection = await connectLarkSetup(appId, appSecret, combinedSignal)
    try {
      return await connection.waitForMention(excludedChatIds)
    } finally {
      connection.stop()
    }
  } catch (error) {
    if (signal?.aborted) return undefined
    if (timeoutSignal.aborted) {
      throw new Error('No group mention received in two minutes. Try again.')
    }
    const msg = error instanceof Error ? error.message : String(error)
    throw new Error(appSecret ? msg.replaceAll(appSecret, '[redacted]') : msg)
  } finally {
    await params.resumeLark?.().catch(() => {})
  }
}

export async function confirmRuntimeLarkGroup(params: {
  agentDir: string
  hostEnv: Record<string, string | undefined>
  runtime: VelaRuntime
  chatId: string
}): Promise<void> {
  if (!params.chatId.trim()) {
    throw new Error('No pending group approval.')
  }
  await assertLarkIdle(params.runtime)
  await saveLarkSection({
    agentDir: params.agentDir,
    addChat: params.chatId.trim(),
    env: params.hostEnv,
  })
  await params.runtime.reloadConfig()
}

export function createRuntimeSettingsApi(params: {
  agentDir: string
  hostEnv: Record<string, string | undefined>
  runtime: VelaRuntime
  directModel?: boolean
  isLarkLoaded?: () => boolean
  getLarkConfigError?: () => string | undefined
  pauseLark?: () => Promise<void>
  resumeLark?: () => Promise<void>
  createDiscoveryTransport?: () => Promise<LarkTransport | undefined>
  verifyCredentials?: (appId: string, appSecret: string) => Promise<void>
}): VelaRuntime['settings'] {
  const discoveryControllers = new Set<AbortController>()
  return {
    get: () => getRuntimeSettingsState(params),
    saveModel: (input) => saveRuntimeModelSetup({ ...params, input }),
    saveLark: (input) => saveRuntimeLarkSetup({ ...params, input }),
    discoverLarkGroup: async (opts) => {
      const controller = new AbortController()
      const onAbort = () =>
        controller.abort(
          opts?.signal?.reason ?? new DOMException('Cancelled', 'AbortError'),
        )
      opts?.signal?.addEventListener('abort', onAbort, { once: true })
      discoveryControllers.add(controller)
      try {
        return await discoverRuntimeLarkGroup({
          ...params,
          signal: controller.signal,
        })
      } finally {
        discoveryControllers.delete(controller)
        opts?.signal?.removeEventListener('abort', onAbort)
      }
    },
    confirmLarkGroup: (chatId) =>
      confirmRuntimeLarkGroup({ ...params, chatId }),
    cancelLarkSetup: async () => {
      for (const ctrl of [...discoveryControllers]) {
        ctrl.abort(new DOMException('Cancelled', 'AbortError'))
      }
    },
  }
}
