import { createServer } from 'node:http'
import { connect, isIP, type Socket } from 'node:net'

const loopback = '127.0.0.1'
const established = 'HTTP/1.1 200 Connection Established\r\n\r\n'
const denied = 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'
const unavailable = 'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'

// The broad route runs inside the container, with exactly its normal networking.
// The owner proxy remains a credential endpoint, never a general tunnel.
export async function openGuestHttpsRouter(
  proxyUrl: string,
  origins: readonly string[],
) {
  const owner = new URL(proxyUrl)
  const authorized = new Set(origins.map((origin) => new URL(origin).hostname))
  const sockets = new Set<Socket>()
  const own = (socket: Socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
  }
  const server = createServer((_req, res) => {
    res.writeHead(403, { connection: 'close' }).end()
  })
  server.on('connection', own)
  server.on('connect', (request, socket, head) => {
    const parsed = /^(\[[a-f0-9:.]+\]|[a-z0-9._-]+):(\d{1,5})$/iu.exec(
      request.url ?? '',
    )
    const authority = parsed?.[1]?.toLowerCase()
    const port = Number(parsed?.[2])
    const host = authority?.replace(/^\[|\]$/g, '')
    if (
      !host ||
      (authority?.startsWith('[') && isIP(host) !== 6) ||
      !(port > 0 && port <= 65535)
    ) {
      socket.end(denied)
      return
    }
    const mediated = port === 443 && authorized.has(host)
    const remote = mediated
      ? connect(Number(owner.port), owner.hostname)
      : connect(port, host)
    own(remote)
    socket.pause()
    socket.once('close', () => remote.destroy())
    let connected = false
    remote.once('close', () => {
      if (connected) {
        if (!remote.readableEnded) socket.destroy()
      } else if (!socket.destroyed) socket.end(unavailable)
    })
    remote.setTimeout(10_000, () => remote.destroy())
    remote.once('connect', () => {
      connected = true
      remote.setTimeout(0)
      if (mediated) {
        // Relay the owner endpoint's CONNECT status as-is. Never retry direct.
        const target = `${host}:443`
        remote.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
      } else {
        socket.write(established)
      }
      if (head.length) remote.write(head)
      socket.pipe(remote).pipe(socket)
    })
  })
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, loopback, () => {
      server.off('error', reject)
      const address = server.address()
      if (address && typeof address === 'object') resolve(address.port)
      else reject(Error('Docker guest HTTPS router did not bind TCP'))
    })
  })
  const close = () => {
    for (const socket of sockets) socket.destroy()
    return new Promise<void>((done) => server.close(() => done()))
  }
  return { url: `http://${loopback}:${port}`, close }
}
