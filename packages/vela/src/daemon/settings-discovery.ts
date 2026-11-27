import { createHash } from 'node:crypto'
import type { CredentialStore, ProviderDefinition } from '../driver/index.ts'
import type { LarkTransport } from '../lark/transport.ts'
import type { VelaRuntime } from '../runtime-sdk-types.ts'
import { saveLarkSection } from '../settings.ts'
import type { RuntimeLarkDiscoveryGroup } from '../shared/settings-types.ts'
import {
  assertLarkScopeIdle,
  getRuntimeSettingsState,
  isLarkDisabledByExtension,
  parseLarkChatIds,
  readEffectiveOwnerConfig,
  resolveLarkSection,
  saveRuntimeLarkSetup,
  saveRuntimeModelSetup,
} from './settings-service.ts'

const DISCOVERY_TIMEOUT_MS = 120_000

const LARK_BUSY_MESSAGE =
  'A Lark session is still running or queued. Wait for it to finish before changing Lark settings.'

export interface SettingsOwnerHooks {
  discoverLarkGroup(
    owner: object,
    signal?: AbortSignal,
  ): Promise<RuntimeLarkDiscoveryGroup | undefined>
  confirmLarkGroup(owner: object, chatId: string): Promise<void>
  cancelLarkSetup(owner: object): Promise<void>
  clearOwner(owner: object): void
}

const ownerHooksByApi = new WeakMap<
  VelaRuntime['settings'],
  SettingsOwnerHooks
>()

const ownerHooksResolversByRuntime = new WeakMap<
  VelaRuntime,
  () => Promise<SettingsOwnerHooks>
>()

export function registerRuntimeSettingsHooksResolver(
  runtime: VelaRuntime,
  resolver: () => Promise<SettingsOwnerHooks>,
): void {
  ownerHooksResolversByRuntime.set(runtime, resolver)
}

export async function resolveSettingsOwnerHooks(
  runtime: VelaRuntime,
): Promise<SettingsOwnerHooks | undefined> {
  const resolver = ownerHooksResolversByRuntime.get(runtime)
  return resolver ? resolver() : undefined
}

export function getSettingsOwnerHooks(
  api: VelaRuntime['settings'],
): SettingsOwnerHooks | undefined {
  return ownerHooksByApi.get(api)
}

const DEFAULT_SETTINGS_OWNER = {}

function larkCredentialFingerprint(
  agentDir: string,
  hostEnv: Record<string, string | undefined>,
  statuses: readonly { name: string; enabled: boolean }[],
): string {
  const { settings } = readEffectiveOwnerConfig(agentDir, hostEnv)
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
  return createHash('sha256')
    .update(JSON.stringify({ appId, appSecret, enabled }))
    .digest('hex')
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
  hasPendingOutboxDeliveries?: (chatId?: string) => boolean
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

  await assertLarkScopeIdle(runtime, {
    message: LARK_BUSY_MESSAGE,
    hasPendingOutboxDeliveries: params.hasPendingOutboxDeliveries,
  })
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
  hasPendingOutboxDeliveries?: (chatId?: string) => boolean
  beforeWrite?: () => void | Promise<void>
}): Promise<void> {
  if (!params.chatId.trim()) {
    throw new Error('No pending group approval.')
  }
  await assertLarkScopeIdle(params.runtime, {
    message: LARK_BUSY_MESSAGE,
    hasPendingOutboxDeliveries: params.hasPendingOutboxDeliveries,
  })
  await params.beforeWrite?.()
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
  ephemeral?: boolean
  credentials?: CredentialStore
  hasCustomCredentials?: boolean
  extraProviders?: Record<string, ProviderDefinition>
  blockLocalOnlyOAuth?: boolean
  directModel?: boolean
  isLarkLoaded?: () => boolean
  isLarkEnabledInDb?: () => boolean
  getLarkConfigError?: () => string | undefined
  pauseLark?: () => Promise<void>
  resumeLark?: () => Promise<void>
  createDiscoveryTransport?: () => Promise<LarkTransport | undefined>
  verifyCredentials?: (appId: string, appSecret: string) => Promise<void>
  hasPendingOutboxDeliveries?: (chatId?: string) => boolean
}): VelaRuntime['settings'] {
  let activeDiscovery:
    | {
        owner: object
        controller: AbortController
        done: Promise<void>
      }
    | undefined
  let pendingApproval:
    | {
        chatId: string
        credentialKey: string
        owner: object
      }
    | undefined
  let larkWriteQueue: Promise<void> = Promise.resolve()

  const serializeLarkWrite = async <T>(fn: () => Promise<T>): Promise<T> => {
    const run = larkWriteQueue.then(fn, fn)
    larkWriteQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const currentCredentialKey = async (): Promise<string> => {
    const statuses = await params.runtime.channels.list().catch(() => [])
    return larkCredentialFingerprint(params.agentDir, params.hostEnv, statuses)
  }

  const discoverForOwner = async (
    owner: object,
    signal?: AbortSignal,
  ): Promise<RuntimeLarkDiscoveryGroup | undefined> => {
    if (params.ephemeral) {
      throw new Error('Settings cannot be modified on an ephemeral runtime')
    }
    if (signal?.aborted) return undefined
    if (activeDiscovery) {
      throw new Error('Lark group discovery is already in progress.')
    }
    pendingApproval = undefined
    const controller = new AbortController()
    const onAbort = () =>
      controller.abort(
        signal?.reason ?? new DOMException('Cancelled', 'AbortError'),
      )
    signal?.addEventListener('abort', onAbort, { once: true })

    let markDone!: () => void
    const done = new Promise<void>((resolve) => {
      markDone = resolve
    })
    activeDiscovery = { owner, controller, done }
    try {
      const startingKey = await currentCredentialKey()
      if (controller.signal.aborted) return undefined
      const found = await discoverRuntimeLarkGroup({
        ...params,
        signal: controller.signal,
      })
      if (found?.chatId && !controller.signal.aborted) {
        const endingKey = await currentCredentialKey()
        if (endingKey === startingKey) {
          pendingApproval = {
            chatId: found.chatId,
            credentialKey: endingKey,
            owner,
          }
        }
      }
      return found
    } finally {
      activeDiscovery = undefined
      signal?.removeEventListener('abort', onAbort)
      markDone()
    }
  }

  const confirmForOwner = async (
    owner: object,
    chatId: string,
  ): Promise<void> => {
    if (params.ephemeral) {
      throw new Error('Settings cannot be modified on an ephemeral runtime')
    }
    const normalized = chatId.trim()
    const initialApproval = pendingApproval
    if (
      !normalized ||
      !initialApproval ||
      initialApproval.owner !== owner ||
      initialApproval.chatId !== normalized
    ) {
      throw new Error('No pending group approval.')
    }
    await serializeLarkWrite(async () => {
      if (
        pendingApproval !== initialApproval ||
        initialApproval.owner !== owner ||
        initialApproval.chatId !== normalized
      ) {
        throw new Error('No pending group approval.')
      }
      const keyBeforeIdle = await currentCredentialKey()
      if (keyBeforeIdle !== initialApproval.credentialKey) {
        if (pendingApproval === initialApproval) {
          pendingApproval = undefined
        }
        throw new Error(
          'Lark settings changed after discovery. Discover the group again before enabling it.',
        )
      }
      await confirmRuntimeLarkGroup({
        ...params,
        chatId: normalized,
        beforeWrite: async () => {
          if (pendingApproval !== initialApproval) {
            throw new Error('No pending group approval.')
          }
          const actualKey = await currentCredentialKey()
          if (actualKey !== initialApproval.credentialKey) {
            if (pendingApproval === initialApproval) {
              pendingApproval = undefined
            }
            throw new Error(
              'Lark settings changed after discovery. Discover the group again before enabling it.',
            )
          }
          pendingApproval = undefined
        },
      })
    })
  }

  const cancelForOwner = async (owner: object): Promise<void> => {
    if (pendingApproval?.owner === owner) {
      pendingApproval = undefined
    }
    const current = activeDiscovery
    if (current && current.owner === owner) {
      current.controller.abort(new DOMException('Cancelled', 'AbortError'))
      await current.done
    }
    await larkWriteQueue.catch(() => {})
  }

  const clearOwner = (owner: object): void => {
    if (pendingApproval?.owner === owner) {
      pendingApproval = undefined
    }
  }

  const api: VelaRuntime['settings'] = {
    get: () => getRuntimeSettingsState(params),
    saveModel: (input) => saveRuntimeModelSetup({ ...params, input }),
    saveLark: async (input) => {
      if (params.ephemeral) {
        throw new Error('Settings cannot be modified on an ephemeral runtime')
      }
      if ('enabled' in input && input.enabled === false) {
        pendingApproval = undefined
      } else if (!('enabled' in input) && !('removeChat' in input)) {
        pendingApproval = undefined
      }
      return saveRuntimeLarkSetup({
        ...params,
        input,
        serializeWrite: serializeLarkWrite,
        onBeforeCredentialWrite: () => {
          pendingApproval = undefined
        },
      })
    },
    discoverLarkGroup: (opts) =>
      discoverForOwner(DEFAULT_SETTINGS_OWNER, opts?.signal),
    confirmLarkGroup: (chatId) =>
      confirmForOwner(DEFAULT_SETTINGS_OWNER, chatId),
    cancelLarkSetup: () => cancelForOwner(DEFAULT_SETTINGS_OWNER),
  }

  ownerHooksByApi.set(api, {
    discoverLarkGroup: discoverForOwner,
    confirmLarkGroup: confirmForOwner,
    cancelLarkSetup: cancelForOwner,
    clearOwner,
  })
  return api
}
