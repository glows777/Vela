import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { VelaLogger } from '@glows777/vela-core/extension-api'
import { z } from 'zod'
import { HttpError, HttpListener, readBody } from './http.ts'
import type { LocalEvents } from './local-events.ts'
import type {
  LocalOptions,
  LocalProject,
  LocalSession,
} from './local-protocol.ts'
import type { LocalStore } from './local-store.ts'
import type { ChannelRuntime } from './types.ts'

const projectSchema = z
  .object({
    cwd: z.string().min(1),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
const messageSchema = z
  .object({
    text: z.string().trim().min(1).max(100000),
    clientMessageId: z.string().min(1).max(200).optional(),
  })
  .strict()
const stopSchema = z.object({ runId: z.string().min(1).max(200) }).strict()
interface LocalService {
  store: LocalStore
  events: LocalEvents
  runtime: ChannelRuntime
  sessions(project: LocalProject): LocalSession[]
  submit(
    project: LocalProject,
    session: LocalSession,
    text: string,
    clientMessageId?: string,
  ): Promise<{ sessionId: string; messageId: string }>
}

/** The Local listener is never shared with the tunnel-facing webhook receiver. */
export class LocalHttp {
  private readonly listener = new HttpListener()

  constructor(
    private options: LocalOptions,
    private service: LocalService,
    private logger: VelaLogger,
  ) {}

  start(): Promise<void> {
    return this.listener.start(
      this.options.port ?? 8788,
      (req, res) => this.handle(req, res),
      (port) =>
        this.logger.info(`[local] Listening on http://127.0.0.1:${port}`),
    )
  }

  async stop(): Promise<void> {
    await this.listener.stop(() => this.service.events.stop())
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
      const { store, events, runtime } = this.service
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
          deploymentId: store.deploymentId,
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
        if (projectId !== undefined && !store.project(projectId))
          throw new HttpError(404, 'Project not found')
        events.connect(res, projectId)
        return
      }
      query(
        ...(method === 'GET' && segments.at(-1) === 'messages'
          ? ['after', 'limit']
          : []),
      )
      if (url.pathname === '/v1/projects') {
        if (method === 'GET') respond(200, { projects: store.projects() })
        else if (method === 'POST') {
          const body = await this.body(req, projectSchema)
          try {
            respond(201, await store.openProject(body.cwd, body.name))
          } catch (error) {
            if (
              ['ENOENT', 'ENOTDIR'].includes(
                (error as NodeJS.ErrnoException).code ?? '',
              ) ||
              (error instanceof Error && error.message.includes('directory'))
            )
              throw new HttpError(400, 'Project must be an existing directory')
            throw error
          }
        } else throw new HttpError(405, 'Use GET or POST')
        return
      }
      if (
        segments[0] !== 'v1' ||
        segments[1] !== 'projects' ||
        segments[3] !== 'sessions'
      )
        throw new HttpError(404, 'Route not found')
      const project = store.project(segments[2]!)
      if (!project) throw new HttpError(404, 'Project not found')
      const sessions = this.service.sessions(project)
      if (segments.length === 4 && method === 'GET') {
        respond(200, { sessions })
        return
      }
      const session = sessions.find((item) => item.sessionId === segments[4])
      if (!session || segments.length !== 6)
        throw new HttpError(404, 'Session not found')
      if (segments[5] === 'messages') {
        if (method === 'GET') {
          const limitText = url.searchParams.get('limit') ?? '50'
          if (!/^\d+$/.test(limitText) || +limitText < 1 || +limitText > 100)
            throw new HttpError(400, 'Limit must be 1 to 100')
          const all = store.messages(project.id, session.sessionId)
          const after = url.searchParams.get('after')
          const index =
            after === null
              ? -1
              : all.findIndex((message) => message.id === after)
          if (after !== null && index === -1)
            throw new HttpError(400, 'Unknown history cursor')
          const messages = all.slice(index + 1, index + 1 + Number(limitText))
          respond(200, {
            messages,
            ...(index + 1 + messages.length < all.length
              ? { nextCursor: messages.at(-1)!.id }
              : {}),
          })
        } else if (method === 'POST') {
          const body = await this.body(req, messageSchema)
          respond(
            202,
            await this.service.submit(
              project,
              session,
              body.text,
              body.clientMessageId,
            ),
          )
        } else throw new HttpError(405, 'Use GET or POST')
        return
      }
      if (segments[5] === 'stop' && method === 'POST') {
        const body = await this.body(req, stopSchema)
        if (
          !(await runtime.stop(
            { chatId: project.id, rootId: session.topic?.rootId },
            body.runId,
          ))
        )
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
      if (error instanceof HttpError) {
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
        respond(error.status, {
          error: {
            code: codes[error.status] ?? 'request_failed',
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

  private async body<T>(
    req: IncomingMessage,
    schema: z.ZodType<T>,
  ): Promise<T> {
    if (
      req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !==
      'application/json'
    )
      throw new HttpError(415, 'Use application/json')
    const raw = await readBody(req)
    try {
      return schema.parse(JSON.parse(raw.toString('utf8')))
    } catch {
      throw new HttpError(400, 'Invalid JSON request body')
    }
  }
}
