import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  createLarkChannelAdapter,
  type LarkChat,
  type LarkTransport,
  larkChatBindingConfig,
  parseChats,
} from '../lark/index.ts'
import type { LocalVelaRuntime } from '../runtime-sdk-types.ts'
import { errorMessage, type VelaLogger } from '../shared/logger.ts'

export interface DaemonLarkConfig {
  lark?: Record<string, unknown>
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
  private lastError?: string
  private configured = false
  private stopped = false

  constructor(
    private readonly runtime: LocalVelaRuntime,
    private readonly options: {
      agentDir: string
      hostEnv: Record<string, string | undefined>
      logger: VelaLogger
      transport?: LarkTransport
    },
  ) {}

  knownChannelInfo(): {
    names: string[]
    errors: Map<string, string>
  } {
    return {
      names: this.configured ? ['lark'] : [],
      errors: this.lastError ? new Map([['lark', this.lastError]]) : new Map(),
    }
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

  private async syncProjectAndBindings(
    chats: readonly LarkChat[],
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
        chat.topicModel || chat.topicThinkingLevel
          ? {
              ...(chat.topicModel ? { topicModel: chat.topicModel } : {}),
              ...(chat.topicThinkingLevel
                ? { topicThinkingLevel: chat.topicThinkingLevel }
                : {}),
            }
          : null
      const desiredConfig = larkChatBindingConfig(chat)
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
          const toolsChanged =
            stableJson(existingProject.defaultTools ?? null) !==
            stableJson(desiredTools)
          const configChanged =
            stableJson(existingProject.config ?? null) !==
            stableJson(desiredProjectConfig)
          if (
            locationChanged ||
            modelChanged ||
            thinkingChanged ||
            toolsChanged ||
            configChanged
          ) {
            await this.runtime.projects.update(projectId, {
              cwd,
              defaultLocation: desiredLocation,
              defaultModel: chat.model ?? null,
              defaultThinkingLevel: chat.thinkingLevel ?? null,
              defaultTools: desiredTools,
              config: desiredProjectConfig,
            })
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

      if (
        !existing?.enabled ||
        existing.projectId !== projectId ||
        stableJson(existing.config) !== stableJson(desiredConfig)
      ) {
        await this.runtime.bindings.upsert({
          channel: 'lark',
          externalId: chat.id,
          threadId: null,
          kind: 'group',
          projectId,
          enabled: true,
          config: desiredConfig,
        })
      }
    }

    for (const [chatId, binding] of rootBindingsByChat) {
      if (!activeChatIds.has(chatId) && binding.enabled) {
        await this.runtime.bindings.setEnabled(binding.id, false)
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
      config.lark !== undefined ||
      hasAnyLarkEnv(hostEnv) ||
      transport !== undefined

    if (!hasLarkConfig) {
      this.configured = false
      this.lastError = undefined
      if (this.lastFingerprint) {
        this.lastFingerprint = ''
        await this.runtime.unregisterChannel('lark').catch(() => {})
      }
      return
    }

    this.configured = true
    let chats: LarkChat[]
    try {
      chats = parseChats(config.lark?.chats)
    } catch (error) {
      this.lastError = errorMessage(error)
      logger.warn(`[daemon] Invalid Lark configuration: ${this.lastError}`)
      if (this.lastFingerprint) {
        this.lastFingerprint = ''
        await this.runtime.unregisterChannel('lark').catch(() => {})
      }
      return
    }

    try {
      await this.syncProjectAndBindings(chats)
    } catch (error) {
      this.lastError = errorMessage(error)
      logger.warn(
        `[daemon] Lark project/binding sync failed: ${this.lastError}`,
      )
      return
    }

    const statuses = await this.runtime.channels.list()
    const enabledInDb =
      statuses.find((s) => s.name === 'lark')?.enabled !== false

    if (config.disabledByExtension || !enabledInDb) {
      this.lastError = undefined
      if (this.lastFingerprint) {
        this.lastFingerprint = ''
        await this.runtime.unregisterChannel('lark').catch(() => {})
      }
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
      timezone: config.lark?.timezone ?? null,
      hasCustomTransport: Boolean(transport),
    })

    if (!force && nextFingerprint === this.lastFingerprint) {
      return
    }

    this.lastError = undefined
    const adapter = createLarkChannelAdapter({
      appId,
      appSecret,
      owners,
      chats,
      logger,
      transport,
      timezone: config.lark?.timezone,
      hostEnv,
    })
    try {
      await this.runtime.registerChannel(adapter)
      if (this.stopped) {
        await this.runtime.unregisterChannel('lark').catch(() => {})
        return
      }
      this.lastFingerprint = nextFingerprint
    } catch (error) {
      this.lastError = errorMessage(error)
      this.lastFingerprint = ''
      logger.warn(`[daemon] Lark channel could not start: ${this.lastError}`)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.syncQueue.catch(() => {})
    if (this.lastFingerprint) {
      this.lastFingerprint = ''
      await this.runtime.unregisterChannel('lark').catch(() => {})
    }
  }
}
