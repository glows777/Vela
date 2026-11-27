import { statSync } from 'node:fs'
import { join } from 'node:path'
import {
  normalizeWebhookConfigKey,
  type RuntimeWebhookEvent,
  RuntimeWebhookReceiver,
  type RuntimeWebhookStatus,
} from '../runtime/index.ts'
import { errorMessage, type VelaLogger } from '../shared/logger.ts'

function ownerStatSig(file: string): string {
  try {
    const st = statSync(file)
    return `${st.ino}:${st.mtimeMs}:${st.size}`
  } catch {
    return 'missing'
  }
}

/** Polls owner `config.json` / `auth.json` stat signatures so an idle daemon reloads automatically. */
export function startDaemonConfigWatcher(
  agentDir: string,
  reload: () => Promise<void>,
  intervalMs = 1000,
  onError?: (error: unknown) => void,
): { checkNow: () => Promise<void>; stop: () => void } {
  const sig = () =>
    `${ownerStatSig(join(agentDir, 'config.json'))}|${ownerStatSig(join(agentDir, 'auth.json'))}`
  let lastSig = sig()
  let inflight: Promise<void> | undefined
  let stopped = false
  const checkNow = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (inflight) return inflight
    const next = sig()
    if (next === lastSig) return Promise.resolve()
    lastSig = next
    inflight = reload()
      .catch((error) => {
        onError?.(error)
      })
      .finally(() => {
        inflight = undefined
      })
    return inflight
  }
  const timer = setInterval(() => {
    void checkNow()
  }, intervalMs)
  timer.unref?.()
  return {
    checkNow,
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}

export interface DaemonWebhookConfig {
  webhooks?: unknown
  eventDefaultTarget?: { channel: string; chatId: string }
}

/**
 * Manages the daemon-hosted `RuntimeWebhookReceiver` lifecycle across cold starts
 * and `reloadConfig()` / `SIGHUP` updates, degrading gracefully on invalid config or bind failure.
 */
export class DaemonWebhooksHost {
  private receiver?: RuntimeWebhookReceiver
  private setGenerationDefaultTarget?: (
    target: { channel: string; chatId: string } | undefined,
  ) => void
  private lastConfigJson = 'undefined'
  private lastError?: string
  private syncQueue: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(
    private readonly publishEvent: (
      event: RuntimeWebhookEvent,
      defaultTarget?: { channel: string; chatId: string },
    ) => Promise<unknown> | unknown,
    private readonly logger: VelaLogger,
  ) {}

  sync(config: DaemonWebhookConfig, force = false): Promise<void> {
    if (this.stopped) return Promise.resolve()
    const next = this.syncQueue
      .catch(() => {})
      .then(() => {
        if (this.stopped) return
        return this.applySync(config, force)
      })
    this.syncQueue = next
    return next
  }

  private async applySync(
    config: DaemonWebhookConfig,
    force: boolean,
  ): Promise<void> {
    if (this.stopped) return
    const nextTarget = config.eventDefaultTarget
      ? { ...config.eventDefaultTarget }
      : undefined
    const nextJson = normalizeWebhookConfigKey(config.webhooks)
    const shouldRetryErrored =
      force && config.webhooks !== undefined && !this.receiver
    if (nextJson === this.lastConfigJson && !shouldRetryErrored) {
      this.setGenerationDefaultTarget?.(nextTarget)
      return
    }
    this.lastConfigJson = nextJson
    this.lastError = undefined
    if (this.receiver) {
      this.setGenerationDefaultTarget = undefined
      await this.receiver.stop().catch(() => {})
      this.receiver = undefined
    }
    if (this.stopped || config.webhooks === undefined) {
      return
    }
    try {
      let activeDefaultTarget = nextTarget
      const receiver = new RuntimeWebhookReceiver(
        config.webhooks,
        async (event) => {
          await this.publishEvent(event, activeDefaultTarget)
        },
        this.logger,
      )
      await receiver.start()
      if (this.stopped) {
        await receiver.stop().catch(() => {})
        return
      }
      this.receiver = receiver
      this.setGenerationDefaultTarget = (target) => {
        activeDefaultTarget = target ? { ...target } : undefined
      }
    } catch (error) {
      this.lastError = errorMessage(error)
      this.logger.warn(
        `[daemon] Webhook receiver could not start: ${this.lastError}`,
      )
    }
  }

  status(): RuntimeWebhookStatus {
    if (this.receiver) return this.receiver.status()
    if (this.lastConfigJson === 'undefined') {
      return { enabled: false, listening: false }
    }
    return {
      enabled: true,
      listening: false,
      ...(this.lastError ? { error: this.lastError } : {}),
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.syncQueue.catch(() => {})
    this.setGenerationDefaultTarget = undefined
    if (this.receiver) {
      await this.receiver.stop().catch(() => {})
      this.receiver = undefined
    }
  }
}
