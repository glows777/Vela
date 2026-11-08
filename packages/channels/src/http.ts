import type { IncomingMessage } from 'node:http'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
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
