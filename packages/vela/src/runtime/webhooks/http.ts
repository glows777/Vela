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

  /** Start once; `onListening` runs after the port is bound. */
  start(
    port: number,
    handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
    onListening?: (port: number) => void,
  ): Promise<void> {
    this.starting ??= this.listen(port, handle, onListening)
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

  /** Stop accepting, run `beforeClose`, disconnect idle keep-alives and wait for admitted requests. */
  async stop(beforeClose?: () => void): Promise<void> {
    this.accepting = false
    await this.starting?.catch(() => {})
    this.accepting = false
    beforeClose?.()
    const server = this.server
    this.server = undefined
    this.boundPort = undefined
    if (!server) return
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    server.closeAllConnections()
    await Promise.all([closed, ...this.active])
  }
}
