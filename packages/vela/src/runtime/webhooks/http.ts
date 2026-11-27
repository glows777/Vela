import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function closeIncompleteRequest(req: IncomingMessage): void {
  if (req.complete) return
  const socket = req.socket
  if (!socket || socket.destroyed) return
  socket.end()
  setTimeout(() => {
    if (!socket.destroyed) socket.destroy()
  }, 50).unref?.()
}

export function readBody(
  req: IncomingMessage,
  maxBody = 1024 * 1024,
): Promise<Buffer> {
  if (Number(req.headers['content-length']) > maxBody)
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
      if (size > maxBody) {
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

/** Loopback HTTP listener shared by Runtime webhook receivers. */
export class HttpListener {
  private server?: Server
  private starting?: Promise<void>
  private readonly active = new Set<Promise<void>>()
  private accepting = false
  private boundPort?: number

  /** Whether the listener has started and has not begun stopping. */
  get isAccepting(): boolean {
    return this.accepting
  }

  /** Actual bound port once listening; undefined before start or after stop. */
  get port(): number | undefined {
    return this.boundPort
  }

  /** Start listening (safe to call again after `stop()` or failed startup); `onListening` runs after the port is bound. */
  start(
    port: number,
    handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
    onListening?: (port: number) => void,
  ): Promise<void> {
    if (!this.starting) {
      this.starting = this.listen(port, handle, onListening).catch((error) => {
        this.starting = undefined
        throw error
      })
    }
    return this.starting
  }

  private async listen(
    port: number,
    handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
    onListening?: (port: number) => void,
  ): Promise<void> {
    const server = createServer((req, res) => {
      const task = handle(req, res)
      this.active.add(task)
      void task.finally(() => this.active.delete(task))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
    this.accepting = true
    const address = server.address()
    if (address && typeof address !== 'string') {
      this.boundPort = address.port
      onListening?.(address.port)
    }
  }

  /** Stop accepting, run `beforeClose`, close idle sockets, drain admitted requests within a bounded window, then close remaining connections. */
  async stop(beforeClose?: () => void): Promise<void> {
    this.accepting = false
    await this.starting?.catch(() => {})
    this.accepting = false
    beforeClose?.()
    const server = this.server
    this.server = undefined
    this.boundPort = undefined
    this.starting = undefined
    if (!server) return
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (
          error &&
          (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
        ) {
          reject(error)
        } else {
          resolve()
        }
      }),
    )
    const stopDeadline = Date.now() + 2500
    server.closeIdleConnections?.()
    if (this.active.size > 0) {
      await Promise.race([
        Promise.all([...this.active]),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2000)
          timer.unref?.()
        }),
      ])
    }
    server.closeAllConnections()
    const remainingMs = Math.max(50, stopDeadline - Date.now())
    await Promise.race([
      Promise.all([closed, ...this.active]),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remainingMs)
        timer.unref?.()
      }),
    ])
  }
}
