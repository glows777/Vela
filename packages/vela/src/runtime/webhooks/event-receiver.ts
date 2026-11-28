import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import {
  errorMessage,
  silentLogger,
  type VelaLogger,
} from '../../shared/logger.ts'
import {
  genericWebhookOptions,
  parseGenericWebhookEvent,
} from './generic-events.ts'
import {
  githubWebhookOptions,
  parseGithubWebhookEvents,
  type RuntimeWebhookEvent,
} from './github-events.ts'
import {
  closeIncompleteRequest,
  HttpError,
  HttpListener,
  readBody,
} from './http.ts'

const webhookReceiverConfigSchema = z
  .object({
    port: z.number().int().min(0).max(65535).default(8787),
    github: githubWebhookOptions.optional(),
    generic: genericWebhookOptions.optional(),
  })
  .strict()
  .refine(
    (options) => options.github || options.generic,
    'Configure at least one adapter',
  )
  .refine(
    (options) =>
      !options.github ||
      !options.generic ||
      options.github.secret !== options.generic.secret,
    'GitHub and generic adapters require separate secrets',
  )

export type WebhookReceiverConfig = z.infer<typeof webhookReceiverConfigSchema>

export interface RuntimeWebhookStatus {
  enabled: boolean
  listening: boolean
  port?: number
  endpoints?: ('github' | 'generic')[]
  error?: string
}

const MAX_SEEN = 1000
const REPLAY_WINDOW_MS = 5 * 60 * 1000

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** Extracts normalized `webhooks.github.repositories` list for prompt guidance without throwing on unrelated configs. */
export function extractGithubRepositories(
  webhooksConfig: unknown,
): string[] | undefined {
  if (!webhooksConfig || typeof webhooksConfig !== 'object') return undefined
  const parsed = webhookReceiverConfigSchema.safeParse(webhooksConfig)
  if (!parsed.success || !parsed.data.github) return undefined
  return uniqueSorted(parsed.data.github.repositories)
}

/** Normalizes webhook receiver configuration so order-insensitive sets produce a stable fingerprint. */
export function normalizeWebhookConfigKey(config: unknown): string {
  if (config === undefined) return 'undefined'
  const parsed = webhookReceiverConfigSchema.safeParse(config)
  if (!parsed.success) return JSON.stringify(config) ?? String(config)
  const data = parsed.data
  const normalizedGithub = data.github
    ? {
        secret: data.github.secret,
        repositories: uniqueSorted(data.github.repositories),
        apps: uniqueSorted(data.github.apps),
        issueLabels: Array.isArray(data.github.issueLabels)
          ? uniqueSorted(data.github.issueLabels)
          : {
              ...(data.github.issueLabels.all
                ? { all: uniqueSorted(data.github.issueLabels.all) }
                : {}),
              ...(data.github.issueLabels.any
                ? { any: uniqueSorted(data.github.issueLabels.any) }
                : {}),
            },
      }
    : undefined
  const normalizedGeneric = data.generic
    ? { secret: data.generic.secret, source: data.generic.source }
    : undefined
  return JSON.stringify({
    port: data.port,
    ...(normalizedGithub ? { github: normalizedGithub } : {}),
    ...(normalizedGeneric ? { generic: normalizedGeneric } : {}),
  })
}

/** Daemon-hosted HTTP webhook receiver verifying HMAC signatures and writing durable `inbox_events`. */
export class RuntimeWebhookReceiver {
  private readonly options: WebhookReceiverConfig
  private readonly listener = new HttpListener()
  private readonly seen = new Set<string>()
  private readonly inFlightDeliveries = new Map<string, Promise<boolean>>()
  private readonly inFlightFingerprints = new Map<string, Promise<boolean>>()
  private readonly replayFingerprints = new Map<string, number>()
  private readonly logger: VelaLogger

  constructor(
    config: unknown,
    private readonly publish: (
      event: RuntimeWebhookEvent,
    ) => Promise<void> | void,
    logger: VelaLogger = silentLogger,
  ) {
    const parsed = webhookReceiverConfigSchema.safeParse(config)
    if (!parsed.success)
      throw new Error(
        `Invalid webhooks: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      )
    this.options = parsed.data
    this.logger = logger
  }

  get port(): number | undefined {
    return this.listener.port
  }

  status(): RuntimeWebhookStatus {
    const endpoints: ('github' | 'generic')[] = []
    if (this.options.github) endpoints.push('github')
    if (this.options.generic) endpoints.push('generic')
    return {
      enabled: true,
      listening: this.listener.isAccepting,
      ...(this.listener.port !== undefined ? { port: this.listener.port } : {}),
      endpoints,
    }
  }

  start(): Promise<void> {
    return this.listener.start(
      this.options.port,
      (req, res) => this.handle(req, res),
      (port) => {
        for (const name of ['github', 'generic'] as const)
          if (this.options[name])
            this.logger.info(
              `[events] Listening on http://127.0.0.1:${port}/events/${name}`,
            )
      },
    )
  }

  async stop(): Promise<void> {
    await this.listener.stop()
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const respond = (status: number, text: string) => {
      if (res.destroyed) return
      res.writeHead(status, {
        'content-type': 'text/plain; charset=utf-8',
        ...(status === 405 ? { allow: 'POST' } : {}),
        connection: 'close',
      })
      res.end(text, () => {
        closeIncompleteRequest(req)
      })
    }
    try {
      if (!this.listener.isAccepting)
        throw new HttpError(503, 'Receiver stopping')
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      const github =
        pathname === '/events/github' ? this.options.github : undefined
      const generic =
        pathname === '/events/generic' ? this.options.generic : undefined
      if (!github && !generic) throw new HttpError(404, 'Not found')
      const adapter = github ? 'github' : 'generic'
      if (req.method !== 'POST') throw new HttpError(405, 'POST required')
      const raw = await readBody(req)
      const id = req.headers[github ? 'x-github-delivery' : 'x-vela-delivery']
      const type = req.headers['x-github-event']
      const header =
        req.headers[github ? 'x-hub-signature-256' : 'x-vela-signature-256']
      const tsHeader = generic ? req.headers['x-vela-timestamp'] : undefined
      if (
        typeof id !== 'string' ||
        !id.trim() ||
        id.length > 512 ||
        (github && typeof type !== 'string')
      ) {
        // Still validate signature first when headers are missing? Wait: verify raw signature before header validation so invalid signatures always return 403!
        const expectedRaw = createHmac('sha256', (github ?? generic!).secret)
          .update(raw)
          .digest()
        if (
          typeof header !== 'string' ||
          !/^sha256=[a-f0-9]{64}$/i.test(header) ||
          !timingSafeEqual(expectedRaw, Buffer.from(header.slice(7), 'hex'))
        ) {
          throw new HttpError(403, 'Invalid signature')
        }
        throw new HttpError(
          400,
          `Missing or invalid ${github ? 'GitHub' : 'generic'} delivery headers`,
        )
      }

      let signedPayloadUsed = false
      if (tsHeader !== undefined) {
        if (typeof tsHeader !== 'string' || tsHeader.length > 64) {
          throw new HttpError(400, 'Invalid generic timestamp header')
        }
        const trimmedTs = tsHeader.trim()
        const numericTs = /^\d+$/.test(trimmedTs) ? Number(trimmedTs) : NaN
        const tsMs = Number.isFinite(numericTs)
          ? numericTs < 1e12
            ? numericTs * 1000
            : numericTs
          : Date.parse(trimmedTs)
        if (
          !Number.isFinite(tsMs) ||
          Math.abs(Date.now() - tsMs) > REPLAY_WINDOW_MS
        ) {
          throw new HttpError(403, 'Expired or invalid timestamp')
        }
        const expectedBound = createHmac('sha256', generic!.secret)
          .update(`${tsHeader}.${id}.`)
          .update(raw)
          .digest()
        if (
          typeof header !== 'string' ||
          !/^sha256=[a-f0-9]{64}$/i.test(header) ||
          !timingSafeEqual(expectedBound, Buffer.from(header.slice(7), 'hex'))
        ) {
          throw new HttpError(403, 'Invalid signature')
        }
        signedPayloadUsed = true
      } else {
        const expected = createHmac('sha256', (github ?? generic!).secret)
          .update(raw)
          .digest()
        if (
          typeof header !== 'string' ||
          !/^sha256=[a-f0-9]{64}$/i.test(header) ||
          !timingSafeEqual(expected, Buffer.from(header.slice(7), 'hex'))
        ) {
          throw new HttpError(403, 'Invalid signature')
        }
      }

      const cacheKey = JSON.stringify([adapter, id])
      if (this.seen.has(cacheKey)) {
        respond(202, 'Duplicate delivery ignored')
        return
      }
      const pendingDelivery = this.inFlightDeliveries.get(cacheKey)
      if (pendingDelivery) {
        const ok = await pendingDelivery
        if (ok) {
          respond(202, 'Duplicate delivery ignored')
        } else {
          respond(503, 'Webhook publication failed')
        }
        return
      }
      const replayHash = signedPayloadUsed
        ? undefined
        : createHash('sha256')
            .update(adapter)
            .update('\0')
            .update(raw)
            .digest('hex')
      const nowMs = Date.now()
      if (replayHash) {
        const expiresAt = this.replayFingerprints.get(replayHash)
        if (expiresAt !== undefined && expiresAt > nowMs) {
          respond(202, 'Duplicate replay ignored')
          return
        }
        const pendingReplay = this.inFlightFingerprints.get(replayHash)
        if (pendingReplay) {
          const ok = await pendingReplay
          if (ok) {
            respond(202, 'Duplicate replay ignored')
          } else {
            respond(503, 'Webhook publication failed')
          }
          return
        }
      }

      let events: RuntimeWebhookEvent[]
      try {
        const input = JSON.parse(raw.toString('utf8'))
        events = github
          ? parseGithubWebhookEvents(
              type as string,
              input,
              id,
              github,
              this.logger,
            )
          : [parseGenericWebhookEvent(input, id, generic!)]
      } catch {
        throw new HttpError(
          400,
          `Invalid ${github ? 'GitHub' : 'generic'} payload`,
        )
      }

      const work = (async (): Promise<boolean> => {
        try {
          for (const event of events) await this.publish(event)
          return true
        } catch (error) {
          this.logger.error(
            `[events] Webhook publication failed: ${errorMessage(error)}`,
          )
          return false
        }
      })()
      this.inFlightDeliveries.set(cacheKey, work)
      if (replayHash) this.inFlightFingerprints.set(replayHash, work)
      try {
        const published = await work
        if (!published) {
          respond(503, 'Webhook publication failed')
          return
        }
        this.seen.add(cacheKey)
        if (this.seen.size > MAX_SEEN) {
          this.seen.delete(this.seen.values().next().value!)
        }
        if (replayHash) {
          this.replayFingerprints.delete(replayHash)
          this.replayFingerprints.set(replayHash, nowMs + REPLAY_WINDOW_MS)
          if (this.replayFingerprints.size > MAX_SEEN) {
            this.replayFingerprints.delete(
              this.replayFingerprints.keys().next().value!,
            )
          }
        }
        respond(202, 'Accepted; execution is not guaranteed')
      } finally {
        this.inFlightDeliveries.delete(cacheKey)
        if (replayHash) this.inFlightFingerprints.delete(replayHash)
      }
    } catch (error) {
      if (error instanceof HttpError) respond(error.status, error.message)
      else {
        this.logger.error(
          `[events] Webhook publication failed: ${errorMessage(error)}`,
        )
        respond(503, 'Webhook publication failed')
      }
    }
  }
}
