import { createHmac, timingSafeEqual } from 'node:crypto'
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

export const webhookReceiverConfigSchema = z
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

/** Extracts validated `webhooks.github.repositories` list for prompt guidance without throwing on unrelated configs. */
export function extractGithubRepositories(
  webhooksConfig: unknown,
): string[] | undefined {
  if (!webhooksConfig || typeof webhooksConfig !== 'object') return undefined
  const parsed = webhookReceiverConfigSchema.safeParse(webhooksConfig)
  if (!parsed.success || !parsed.data.github) return undefined
  return [...parsed.data.github.repositories]
}

/** Daemon-hosted HTTP webhook receiver verifying HMAC signatures and writing durable `inbox_events`. */
export class RuntimeWebhookReceiver {
  private readonly options: WebhookReceiverConfig
  private readonly listener = new HttpListener()
  private readonly seen = new Set<string>()
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
      const header =
        req.headers[github ? 'x-hub-signature-256' : 'x-vela-signature-256']
      const expected = createHmac('sha256', (github ?? generic!).secret)
        .update(raw)
        .digest()
      if (
        typeof header !== 'string' ||
        !/^sha256=[a-f0-9]{64}$/i.test(header) ||
        !timingSafeEqual(expected, Buffer.from(header.slice(7), 'hex'))
      )
        throw new HttpError(403, 'Invalid signature')
      const id = req.headers[github ? 'x-github-delivery' : 'x-vela-delivery']
      const type = req.headers['x-github-event']
      if (
        typeof id !== 'string' ||
        !id.trim() ||
        id.length > 512 ||
        (github && typeof type !== 'string')
      )
        throw new HttpError(
          400,
          `Missing or invalid ${github ? 'GitHub' : 'generic'} delivery headers`,
        )
      const cacheKey = JSON.stringify([adapter, id])
      if (this.seen.has(cacheKey)) {
        respond(202, 'Duplicate delivery ignored')
        return
      }
      this.seen.add(cacheKey)
      if (this.seen.size > MAX_SEEN)
        this.seen.delete(this.seen.values().next().value!)
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
      for (const event of events) await this.publish(event)
      respond(202, 'Accepted; execution is not guaranteed')
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
