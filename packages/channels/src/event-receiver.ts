import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { VelaLogger } from '@glows777/vela-core/extension-api'
import { z } from 'zod'
import { githubEvents, githubOptions } from './github-events.ts'
import { errorMessage } from './log.ts'
import type { ChannelEvent } from './types.ts'

const optionsSchema = z
  .object({
    port: z.number().int().min(0).max(65535).default(8787),
    github: githubOptions,
  })
  .strict()
const MAX_BODY = 1024 * 1024
const MAX_SEEN = 1000

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  if (Number(req.headers['content-length']) > MAX_BODY)
    return Promise.reject(new HttpError(413, 'Payload too large'))
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const cleanup = () => {
      req.off('data', data)
      req.off('end', end)
      req.off('error', error)
      req.off('aborted', aborted)
    }
    const error = (err: Error) => {
      cleanup()
      reject(err)
    }
    const aborted = () => error(new HttpError(400, 'Request aborted'))
    const end = () => {
      cleanup()
      resolve(Buffer.concat(chunks, size))
    }
    const data = (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        req.pause()
        error(new HttpError(413, 'Payload too large'))
      } else chunks.push(chunk)
    }
    req.on('data', data)
    req.once('end', end)
    req.once('error', error)
    req.once('aborted', aborted)
  })
}

/** Optional ingress owned by the channel assembly; no daemon, persisted cache or provider access. */
export class EventReceiver {
  private readonly options: z.infer<typeof optionsSchema>
  private server?: ReturnType<typeof createServer>
  private starting?: Promise<void>
  private readonly active = new Set<Promise<void>>()
  private readonly seen = new Set<string>()
  private accepting = false

  constructor(
    config: unknown,
    private publish: (event: ChannelEvent) => Promise<void>,
    private logger: VelaLogger,
  ) {
    const parsed = optionsSchema.safeParse(config)
    if (!parsed.success)
      throw new Error(
        `Invalid extensionConfig.channel.eventReceiver: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      )
    this.options = parsed.data
  }

  start(): Promise<void> {
    this.starting ??= this.listen()
    return this.starting
  }

  private async listen(): Promise<void> {
    const server = createServer((req, res) => {
      const task = this.handle(req, res)
      this.active.add(task)
      void task.finally(() => this.active.delete(task))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.options.port, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
    this.accepting = true
    const address = server.address()
    if (address && typeof address !== 'string')
      this.logger.info(
        `[events] Listening on http://127.0.0.1:${address.port}/events/github`,
      )
  }

  async stop(): Promise<void> {
    this.accepting = false
    await this.starting?.catch(() => {})
    this.accepting = false
    const server = this.server
    this.server = undefined
    if (!server) return
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    // Disconnect unfinished senders too; admitted publications settle before the gateway drains.
    server.closeAllConnections()
    await Promise.all([closed, ...this.active])
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
        if (!req.complete) req.destroy()
      })
    }
    try {
      if (!this.accepting) throw new HttpError(503, 'Receiver stopping')
      if (req.url !== '/events/github') throw new HttpError(404, 'Not found')
      if (req.method !== 'POST') throw new HttpError(405, 'POST required')
      const raw = await readBody(req)
      const header = req.headers['x-hub-signature-256']
      const expected = createHmac('sha256', this.options.github.secret)
        .update(raw)
        .digest()
      if (
        typeof header !== 'string' ||
        !/^sha256=[a-f0-9]{64}$/i.test(header) ||
        !timingSafeEqual(expected, Buffer.from(header.slice(7), 'hex'))
      )
        throw new HttpError(403, 'Invalid signature')
      const id = req.headers['x-github-delivery']
      const type = req.headers['x-github-event']
      if (
        typeof id !== 'string' ||
        !id.trim() ||
        id.length > 512 ||
        typeof type !== 'string'
      )
        throw new HttpError(400, 'Missing or invalid GitHub delivery headers')
      // Synchronous, per original delivery, before mapping/fanout; failures do not undo seen IDs.
      if (this.seen.has(id)) {
        respond(202, 'Duplicate delivery ignored')
        return
      }
      this.seen.add(id)
      if (this.seen.size > MAX_SEEN)
        this.seen.delete(this.seen.values().next().value!)
      let events: ChannelEvent[]
      try {
        events = githubEvents(
          type,
          JSON.parse(raw.toString('utf8')),
          id,
          this.options.github,
          this.logger,
        )
      } catch {
        throw new HttpError(400, 'Invalid GitHub payload')
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
