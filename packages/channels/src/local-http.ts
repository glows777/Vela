import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { VelaLogger } from '@glows777/vela-core/extension-api'
import { z } from 'zod'
import { HttpError, HttpListener, readBody } from './http.ts'
import type { LocalEvents } from './local-events.ts'
import type {
  LocalHost,
  LocalOptions,
  LocalProject,
  LocalSession,
} from './local-protocol.ts'
import { LocalError } from './local-protocol.ts'
import { LocalSse } from './local-sse.ts'

const stopSchema = z.object({ runId: z.string().min(1).max(200) }).strict()
interface LocalService extends Pick<LocalHost, 'projects' | 'messages'> {
  openProject(input: unknown): Promise<LocalProject>
  deploymentId: string
  events: LocalEvents
  sessions(projectId: string): LocalSession[]
  session(projectId: string, sessionId: string): LocalSession
  submit(
    projectId: string,
    sessionId: string,
    input: unknown,
  ): Promise<{ sessionId: string; messageId: string }>
  stop(projectId: string, sessionId: string, runId: string): Promise<boolean>
}

/** The Local listener is never shared with the tunnel-facing webhook receiver. */
export class LocalHttp {
  private readonly listener = new HttpListener()
  private readonly sse: LocalSse

  constructor(
    private options: LocalOptions & { token: string },
    private service: LocalService,
    private logger: VelaLogger,
  ) {
    this.sse = new LocalSse(service.events)
  }

  start(): Promise<void> {
    return this.listener.start(
      this.options.port ?? 8788,
      (req, res) => this.handle(req, res),
      (port) =>
        this.logger.info(`[local] Listening on http://127.0.0.1:${port}`),
    )
  }

  async stop(): Promise<void> {
    await this.listener.stop(() => this.sse.stop())
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const respond = (status: number, value: unknown) => {
      if (res.destroyed) return
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'close',
      })
      res.end(JSON.stringify(value), () => {
        if (!req.complete) req.destroy()
      })
    }
    try {
      if (!this.listener.isAccepting)
        throw new HttpError(503, 'Local service is stopping')
      const authorization = req.headers.authorization
      const expected = Buffer.from(`Bearer ${this.options.token}`)
      const supplied = Buffer.from(authorization ?? '')
      if (
        expected.length !== supplied.length ||
        !timingSafeEqual(expected, supplied)
      )
        throw new HttpError(401, 'Bearer token required')
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const segments = url.pathname
        .split('/')
        .filter(Boolean)
        .map((part) => decodeURIComponent(part))
      const service = this.service
      const method = req.method
      const query = (...allowed: string[]) => {
        if (
          [...url.searchParams.keys()].some(
            (key) =>
              !allowed.includes(key) || url.searchParams.getAll(key).length > 1,
          )
        )
          throw new HttpError(400, 'Unknown or repeated query parameter')
      }
      if (url.pathname === '/v1/info' && method === 'GET') {
        query()
        respond(200, {
          version: 1,
          channel: 'local',
          deploymentId: service.deploymentId,
          capabilities: [
            'projects',
            'sessions',
            'messages',
            'stop',
            'sse-reset',
          ],
        })
        return
      }
      if (url.pathname === '/v1/events' && method === 'GET') {
        query('projectId')
        const projectId = url.searchParams.get('projectId') ?? undefined
        if (projectId !== undefined) service.sessions(projectId)
        this.sse.connect(res, projectId)
        return
      }
      query(
        ...(method === 'GET' && segments.at(-1) === 'messages'
          ? ['after', 'limit']
          : []),
      )
      if (url.pathname === '/v1/projects') {
        if (method === 'GET') respond(200, { projects: service.projects() })
        else if (method === 'POST') {
          respond(201, await service.openProject(await this.body(req)))
        } else throw new HttpError(405, 'Use GET or POST')
        return
      }
      if (
        segments[0] !== 'v1' ||
        segments[1] !== 'projects' ||
        segments[3] !== 'sessions'
      )
        throw new HttpError(404, 'Route not found')
      const projectId = segments[2]!
      const sessions = service.sessions(projectId)
      if (segments.length === 4 && method === 'GET') {
        respond(200, { sessions })
        return
      }
      if (segments.length !== 6) throw new HttpError(404, 'Session not found')
      const session = service.session(projectId, segments[4]!)
      if (segments[5] === 'messages') {
        if (method === 'GET') {
          const limitText = url.searchParams.get('limit') ?? '50'
          if (!/^\d+$/.test(limitText) || +limitText < 1 || +limitText > 100)
            throw new HttpError(400, 'Limit must be 1 to 100')
          respond(
            200,
            service.messages({
              projectId,
              sessionId: session.sessionId,
              after: url.searchParams.get('after') ?? undefined,
              limit: Number(limitText),
            }),
          )
        } else if (method === 'POST') {
          respond(
            202,
            await service.submit(
              projectId,
              session.sessionId,
              await this.body(req),
            ),
          )
        } else throw new HttpError(405, 'Use GET or POST')
        return
      }
      if (segments[5] === 'stop' && method === 'POST') {
        const body = await this.body(req, stopSchema)
        if (!(await service.stop(projectId, session.sessionId, body.runId)))
          throw new HttpError(409, 'Run is no longer stoppable')
        respond(200, { stopped: true })
        return
      }
      throw new HttpError(404, 'Route not found')
    } catch (cause) {
      const error =
        cause instanceof URIError
          ? new HttpError(400, 'Invalid route encoding')
          : cause
      if (error instanceof HttpError || error instanceof LocalError) {
        const codes: Record<number, string> = {
          400: 'invalid_request',
          401: 'unauthorized',
          404: 'not_found',
          405: 'method_not_allowed',
          409: 'conflict',
          413: 'payload_too_large',
          415: 'unsupported_media_type',
          503: 'unavailable',
        }
        const status =
          error instanceof HttpError
            ? error.status
            : { invalid_request: 400, not_found: 404, unavailable: 503 }[
                error.code
              ]
        respond(status, {
          error: {
            code: codes[status] ?? 'request_failed',
            message: error.message,
          },
        })
      } else {
        this.logger.error(
          `[local] Storage or admission failed: ${error instanceof Error ? error.message.replaceAll(this.options.token, '[redacted]') : 'unknown failure'}`,
        )
        respond(503, {
          error: {
            code: 'unavailable',
            message:
              'Local storage or admission failed. Inspect daemon diagnostics and reconcile history before retrying.',
          },
        })
      }
    }
  }

  private async body<T = unknown>(
    req: IncomingMessage,
    schema?: z.ZodType<T>,
  ): Promise<T> {
    if (
      req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !==
      'application/json'
    )
      throw new HttpError(415, 'Use application/json')
    const raw = await readBody(req)
    try {
      const value = JSON.parse(raw.toString('utf8'))
      return schema ? schema.parse(value) : value
    } catch {
      throw new HttpError(400, 'Invalid JSON request body')
    }
  }
}
