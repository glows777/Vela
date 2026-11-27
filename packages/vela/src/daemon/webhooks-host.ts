import {
  type RuntimeWebhookEvent,
  RuntimeWebhookReceiver,
  type RuntimeWebhookStatus,
} from '../runtime/index.ts'
import { errorMessage, type VelaLogger } from '../shared/logger.ts'

export interface DaemonWebhookConfig {
  webhooks?: Record<string, unknown>
  eventDefaultTarget?: { channel: string; chatId: string }
}

/**
 * Manages the daemon-hosted `RuntimeWebhookReceiver` lifecycle across cold starts
 * and `reloadConfig()` / `SIGHUP` updates, degrading gracefully on invalid config or bind failure.
 */
export class DaemonWebhooksHost {
  private receiver?: RuntimeWebhookReceiver
  private defaultTarget?: { channel: string; chatId: string }
  private lastConfigJson = 'undefined'
  private lastError?: string
  private syncQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly publishEvent: (
      event: RuntimeWebhookEvent,
      defaultTarget?: { channel: string; chatId: string },
    ) => Promise<unknown> | unknown,
    private readonly logger: VelaLogger,
  ) {}

  sync(config: DaemonWebhookConfig, force = false): Promise<void> {
    const next = this.syncQueue
      .catch(() => {})
      .then(() => this.applySync(config, force))
    this.syncQueue = next
    return next
  }

  private async applySync(
    config: DaemonWebhookConfig,
    force: boolean,
  ): Promise<void> {
    this.defaultTarget = config.eventDefaultTarget
    const nextJson =
      config.webhooks !== undefined
        ? JSON.stringify(config.webhooks)
        : 'undefined'
    const shouldRetryErrored =
      force && config.webhooks !== undefined && !this.receiver
    if (nextJson === this.lastConfigJson && !shouldRetryErrored) {
      return
    }
    this.lastConfigJson = nextJson
    this.lastError = undefined
    if (this.receiver) {
      await this.receiver.stop().catch(() => {})
      this.receiver = undefined
    }
    if (config.webhooks === undefined) {
      return
    }
    try {
      const receiver = new RuntimeWebhookReceiver(
        config.webhooks,
        async (event) => {
          await this.publishEvent(event, this.defaultTarget)
        },
        this.logger,
      )
      await receiver.start()
      this.receiver = receiver
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
    await this.syncQueue.catch(() => {})
    if (this.receiver) {
      await this.receiver.stop().catch(() => {})
      this.receiver = undefined
    }
  }
}
