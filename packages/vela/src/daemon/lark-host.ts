import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  type LarkChat,
  larkChatBindingConfig,
  parseChats,
} from '../lark/chats.ts'
import { createLarkChannelAdapter } from '../lark/runtime-adapter.ts'
import type { LarkTransport } from '../lark/transport.ts'
import type { LocalVelaRuntime } from '../runtime-sdk-types.ts'
import { errorMessage, type VelaLogger } from '../shared/logger.ts'
import { routineTimezone } from '../shared/routine-time.ts'

export interface DaemonLarkConfig {
  lark?: Record<string, unknown>
  larkError?: string
  disabledByExtension?: boolean
}

function resolveChatWorkspace(agentDir: string, chat: LarkChat): string {
  const envName = chat.environment ?? 'local'
  if (envName !== 'local') return '/workspace'
  const safeId = chat.id.replace(/[^A-Za-z0-9._-]/g, '_') || 'chat'
  const dir = join(agentDir, 'channels', 'lark', safeId, 'workspace')
  mkdirSync(dir, { recursive: true })
  return dir
}

function stableJson(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function hasAnyLarkEnv(env: Record<string, string | undefined>): boolean {
  return Boolean(
    env.LARK_APP_ID?.trim() ||
      env.LARK_APP_SECRET?.trim() ||
      env.LARK_OWNERS?.trim(),
  )
}

/**
 * Coordinates the daemon-hosted `LarkChannelAdapter`, syncing `config.json` `lark` chats
 * into `Runtime` `Project` + root `ChannelBinding` records and honoring live enablement
 * toggles stored in `vela.db`.
 */
export class DaemonLarkHost {
  private syncQueue: Promise<void> = Promise.resolve()
  private lastConfig: DaemonLarkConfig = {}
  private lastFingerprint = ''
  private registered = false
  private lastConfigError?: string
  private lastStartError?: string
  private configured = false
  private stopped = false
  private pausedForDiscovery = false
  private currentAdapter?: ReturnType<typeof createLarkChannelAdapter>

  constructor(
    private readonly runtime: LocalVelaRuntime,
    private readonly options: {
      agentDir: string
      hostEnv: Record<string, string | undefined>
      logger: VelaLogger
      transport?: LarkTransport
      createTransport?: (info: {
        appId?: string
        appSecret?: string
      }) => LarkTransport | undefined
    },
  ) {}

  knownChannelInfo(): {
    names: string[]
    errors: Map<string, string>
  } {
    const err = this.lastConfigError ?? this.lastStartError
    return {
      names: this.configured ? ['lark'] : [],
      errors: err ? new Map([['lark', err]]) : new Map(),
    }
  }

  configError(): string | undefined {
    return this.lastConfigError
  }

  isRegistered(): boolean {
    return this.registered
  }

  isConfigured(): boolean {
    return this.configured
  }

  async pauseForDiscovery(): Promise<void> {
    if (this.stopped) return
    this.pausedForDiscovery = true
    await this.syncQueue.catch(() => {})
    await this.unregisterIfRegistered()
  }

  async resumeFromDiscovery(): Promise<void> {
    this.pausedForDiscovery = false
    if (this.stopped) return
    await this.sync(this.lastConfig, true)
  }

  sync(config: DaemonLarkConfig, force = false): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.lastConfig = config
    const next = this.syncQueue
      .catch(() => {})
      .then(() => {
        if (this.stopped) return
        return this.applySync(config, force)
      })
    this.syncQueue = next
    return next
  }

  onEnabledChanged(enabled: boolean): Promise<void> {
    if (this.stopped) return Promise.resolve()
    const next = this.syncQueue
      .catch(() => {})
      .then(() => {
        if (this.stopped) return
        return this.applySync(this.lastConfig, enabled)
      })
    this.syncQueue = next
    return next
  }

  private async unregisterIfRegistered(): Promise<void> {
    this.lastFingerprint = ''
    if (!this.registered) return
    this.registered = false
    await this.runtime.unregisterChannel('lark').catch(() => {})
  }

  private async syncProjectAndBindings(
    chats: readonly LarkChat[],
    timezone?: string,
  ): Promise<void> {
    const existingBindings = await this.runtime.bindings.list({
      channel: 'lark',
    })
    const rootBindingsByChat = new Map(
      existingBindings
        .filter((b) => b.kind === 'group' && !b.threadId)
        .map((b) => [b.externalId, b]),
    )
    const activeChatIds = new Set(chats.map((c) => c.id))

    for (const chat of chats) {
      const cwd = resolveChatWorkspace(this.options.agentDir, chat)
      const environment = chat.environment ?? 'local'
      const desiredLocation = { environment, cwd }
      const desiredTools = chat.tools ? [...chat.tools] : null
      const desiredProjectConfig =
        chat.topicModel || chat.topicThinkingLevel || timezone
          ? {
              ...(chat.topicModel ? { topicModel: chat.topicModel } : {}),
              ...(chat.topicThinkingLevel
                ? { topicThinkingLevel: chat.topicThinkingLevel }
                : {}),
              ...(timezone ? { timezone } : {}),
            }
          : null
      const desiredSemanticConfig = larkChatBindingConfig(chat)
      const desiredConfig: Record<string, unknown> = {
        ...desiredSemanticConfig,
        managed: true,
        synced: desiredSemanticConfig,
      }
      const existing = rootBindingsByChat.get(chat.id)
      let projectId = existing?.projectId ?? null

      if (projectId) {
        const existingProject = await this.runtime.projects.get(projectId)
        if (!existingProject) {
          projectId = null
        } else {
          const locationChanged =
            existingProject.cwd !== cwd ||
            existingProject.defaultLocation?.environment !==
              desiredLocation.environment ||
            existingProject.defaultLocation?.cwd !== desiredLocation.cwd
          const modelChanged =
            (existingProject.defaultModel ?? undefined) !==
            (chat.model ?? undefined)
          const thinkingChanged =
            (existingProject.defaultThinkingLevel ?? undefined) !==
            (chat.thinkingLevel ?? undefined)
          const topicModelChanged =
            (existingProject.config?.topicModel ?? undefined) !==
            (chat.topicModel ?? undefined)
          const topicThinkingChanged =
            (existingProject.config?.topicThinkingLevel ?? undefined) !==
            (chat.topicThinkingLevel ?? undefined)
          const toolsChanged =
            stableJson(existingProject.defaultTools ?? null) !==
            stableJson(desiredTools)
          const configChanged =
            stableJson(existingProject.config ?? null) !==
            stableJson(desiredProjectConfig)
          const reconcileFields = {
            location: locationChanged,
            model: modelChanged,
            thinkingLevel: thinkingChanged,
            topicModel: topicModelChanged || modelChanged,
            topicThinkingLevel: topicThinkingChanged || thinkingChanged,
          }
          const hasSessionDefaultChange =
            Object.values(reconcileFields).some(Boolean)
          if (hasSessionDefaultChange || toolsChanged || configChanged) {
            await this.runtime.projects.update(projectId, {
              cwd,
              defaultLocation: desiredLocation,
              defaultModel: chat.model ?? null,
              defaultThinkingLevel: chat.thinkingLevel ?? null,
              defaultTools: desiredTools,
              config: desiredProjectConfig,
            })
            if (hasSessionDefaultChange) {
              await this.runtime.reconcileProjectSessions?.(
                projectId,
                reconcileFields,
              )
            }
          }
        }
      }

      if (!projectId) {
        const created = await this.runtime.projects.create({
          name: chat.id,
          cwd,
          hubSessionId: true,
          defaultLocation: desiredLocation,
          ...(chat.model ? { defaultModel: chat.model } : {}),
          ...(chat.thinkingLevel
            ? { defaultThinkingLevel: chat.thinkingLevel }
            : {}),
          ...(desiredTools ? { defaultTools: desiredTools } : {}),
          ...(desiredProjectConfig ? { config: desiredProjectConfig } : {}),
        })
        projectId = created.id
      }

      const wasManagedDisabled = existing?.config?.disabledBySync === true
      const explicitDbDisable =
        existing && !existing.enabled && !wasManagedDisabled
      const nextEnabled = !explicitDbDisable
      const hasSyncedSnapshot =
        existing?.config !== undefined && 'synced' in existing.config
      const syncedChanged = hasSyncedSnapshot
        ? stableJson(existing.config?.synced) !==
          stableJson(desiredSemanticConfig)
        : existing?.config?.managed !== true ||
          stableJson({
            ...(existing.config?.readUntagged !== undefined
              ? { readUntagged: existing.config.readUntagged }
              : {}),
          }) !== stableJson(desiredSemanticConfig)
      const needsUpdate =
        !existing ||
        existing.enabled !== nextEnabled ||
        wasManagedDisabled ||
        existing.projectId !== projectId ||
        syncedChanged ||
        !hasSyncedSnapshot
      if (needsUpdate) {
        const mergedConfig: Record<string, unknown> = existing?.config
          ? (() => {
              const {
                disabledBySync: _disabled,
                synced: rawPrevSynced,
                ...rest
              } = existing.config
              const cleanedRest: Record<string, unknown> = { ...rest }
              if (syncedChanged) {
                const prevSynced =
                  rawPrevSynced &&
                  typeof rawPrevSynced === 'object' &&
                  !Array.isArray(rawPrevSynced)
                    ? (rawPrevSynced as Record<string, unknown>)
                    : undefined
                if (prevSynced) {
                  for (const key of Object.keys(prevSynced)) {
                    delete cleanedRest[key]
                  }
                } else {
                  delete cleanedRest.readUntagged
                }
              }
              return {
                ...cleanedRest,
                ...(syncedChanged ? desiredSemanticConfig : {}),
                managed: true,
                synced: desiredSemanticConfig,
              }
            })()
          : desiredConfig
        await this.runtime.bindings.upsert({
          channel: 'lark',
          externalId: chat.id,
          threadId: null,
          kind: 'group',
          projectId,
          enabled: nextEnabled,
          config: mergedConfig,
        })
      }
    }

    for (const [chatId, binding] of rootBindingsByChat) {
      if (
        !activeChatIds.has(chatId) &&
        binding.enabled &&
        binding.config?.managed === true
      ) {
        await this.runtime.bindings.upsert({
          id: binding.id,
          channel: binding.channel,
          externalId: binding.externalId,
          threadId: null,
          kind: 'group',
          projectId: binding.projectId,
          enabled: false,
          config: { ...(binding.config ?? {}), disabledBySync: true },
        })
      }
    }
  }

  private async applySync(
    config: DaemonLarkConfig,
    force: boolean,
  ): Promise<void> {
    if (this.stopped) return
    const { hostEnv, logger, transport } = this.options
    const hasLarkConfig =
      config.larkError !== undefined ||
      config.lark !== undefined ||
      hasAnyLarkEnv(hostEnv) ||
      transport !== undefined

    if (!hasLarkConfig) {
      this.configured = false
      this.lastConfigError = undefined
      this.lastStartError = undefined
      await this.unregisterIfRegistered()
      return
    }

    this.configured = true
    if (config.larkError) {
      this.lastConfigError = config.larkError
      this.lastStartError = undefined
      logger.warn(
        `[daemon] Invalid Lark configuration: ${this.lastConfigError}`,
      )
      await this.unregisterIfRegistered()
      return
    }

    let chats: LarkChat[]
    let validatedTimezone: string | undefined
    try {
      chats = parseChats(config.lark?.chats)
      if (config.lark?.timezone !== undefined) {
        if (
          typeof config.lark.timezone !== 'string' ||
          !config.lark.timezone.trim()
        ) {
          throw new Error(
            'lark.timezone must be a non-empty IANA timezone string',
          )
        }
        validatedTimezone = routineTimezone(config.lark.timezone)
      }
    } catch (error) {
      this.lastConfigError = errorMessage(error)
      this.lastStartError = undefined
      logger.warn(
        `[daemon] Invalid Lark configuration: ${this.lastConfigError}`,
      )
      await this.unregisterIfRegistered()
      return
    }

    const statuses = await this.runtime.channels.list()
    const enabledInDb =
      statuses.find((s) => s.name === 'lark')?.enabled !== false

    if (config.disabledByExtension || !enabledInDb) {
      this.lastConfigError = undefined
      this.lastStartError = undefined
      await this.unregisterIfRegistered()
      return
    }
    if (this.pausedForDiscovery) {
      await this.unregisterIfRegistered()
      return
    }

    try {
      await this.syncProjectAndBindings(chats, validatedTimezone)
    } catch (error) {
      this.lastConfigError = errorMessage(error)
      this.lastStartError = undefined
      logger.warn(
        `[daemon] Lark project/binding sync failed: ${this.lastConfigError}`,
      )
      await this.unregisterIfRegistered()
      return
    }

    const appId =
      typeof config.lark?.appId === 'string' ? config.lark.appId : undefined
    const appSecret =
      typeof config.lark?.appSecret === 'string'
        ? config.lark.appSecret
        : undefined
    const owners =
      Array.isArray(config.lark?.owners) ||
      typeof config.lark?.owners === 'string'
        ? (config.lark.owners as readonly string[] | string)
        : undefined
    const nextFingerprint = JSON.stringify({
      appId: appId ?? hostEnv.LARK_APP_ID ?? '',
      appSecret: appSecret ?? hostEnv.LARK_APP_SECRET ?? '',
      owners: owners ?? hostEnv.LARK_OWNERS ?? '',
      chats,
      timezone: validatedTimezone ?? null,
      hasCustomTransport: Boolean(transport),
    })

    this.lastConfigError = undefined
    if (!force && this.registered && nextFingerprint === this.lastFingerprint) {
      return
    }

    const customTransport =
      transport ??
      this.options.createTransport?.({
        appId: appId ?? hostEnv.LARK_APP_ID,
        appSecret: appSecret ?? hostEnv.LARK_APP_SECRET,
      })

    this.lastStartError = undefined
    const adapter = createLarkChannelAdapter({
      appId,
      appSecret,
      owners,
      chats,
      logger,
      transport: customTransport,
      timezone: validatedTimezone,
      hostEnv,
    })
    this.currentAdapter = adapter
    try {
      await this.runtime.registerChannel(adapter)
      if (this.stopped) {
        this.registered = false
        await this.runtime.unregisterChannel('lark').catch(() => {})
        return
      }
      this.registered = true
      this.lastFingerprint = nextFingerprint
    } catch (error) {
      this.lastStartError = errorMessage(error)
      this.registered = false
      this.lastFingerprint = ''
      logger.warn(
        `[daemon] Lark channel could not start: ${this.lastStartError}`,
      )
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.currentAdapter?.stop().catch(() => {})
    this.currentAdapter = undefined
    await this.syncQueue.catch(() => {})
    await this.unregisterIfRegistered()
  }
}
