import {
  type ClientRequest,
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from 'node:http'
import {
  createServer as createTlsServer,
  type RequestOptions,
  request,
} from 'node:https'
import { connect, isIP, type Socket } from 'node:net'
import type { TLSSocket } from 'node:tls'

type Credential = {
  placeholder: string
  value: string
  origins: readonly string[]
}

type Options = {
  listenHost: string
  identity: { key: string | Buffer; cert: string | Buffer }
  credentials: readonly Credential[]
  upstreamRequest?: (
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => ClientRequest
}

const loopback = '127.0.0.1'
const hopHeaders = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]

function endToEndHeaders(headers: IncomingHttpHeaders) {
  const clean = { ...headers }
  for (const name of [
    ...hopHeaders,
    ...(headers.connection?.split(',') ?? []),
  ]) {
    delete clean[name.trim().toLowerCase()]
  }
  return clean
}

function authorizationFor(header: string, credentials: readonly Credential[]) {
  const parts = /^(Bearer|token|Basic) ([^\s]+)$/iu.exec(header)
  if (!parts) return header
  const [, scheme, input] = parts
  if (scheme!.toLowerCase() === 'basic') {
    const bytes = Buffer.from(input!, 'base64')
    if (bytes.toString('base64') !== input) return header
    const text = bytes.toString()
    const colon = text.indexOf(':')
    if (colon < 0) return header
    const found = credentials.find(
      (c) => text.slice(colon + 1) === c.placeholder,
    )
    return found
      ? `Basic ${Buffer.from(text.slice(0, colon + 1) + found.value).toString('base64')}`
      : header
  }
  const found = credentials.find((c) => c.placeholder === input)
  return found ? `${scheme} ${found.value}` : header
}

async function listen(server: HttpServer, host: string) {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      server.off('error', reject)
      const address = server.address()
      if (address && typeof address === 'object') resolve(address.port)
      else reject(Error('Docker credential proxy did not bind a TCP address'))
    })
  })
}

export function credentialOriginHost(origin: string) {
  const url = URL.parse(origin)
  if (
    url?.protocol !== 'https:' ||
    origin !== url.origin ||
    url.port ||
    isIP(url.hostname.replace(/^\[|\]$/g, ''))
  )
    throw Error('Invalid Docker credential proxy origin')
  return url.hostname
}

/** A CONNECT endpoint only for owner-approved credential origins, not a general forward proxy. */
export async function openCredentialProxy(options: Options) {
  const byHost = new Map<string, Credential[]>()
  for (const entry of options.credentials) {
    for (const origin of entry.origins) {
      const host = credentialOriginHost(origin)
      const list = byHost.get(host) ?? []
      byHost.set(host, list)
      list.push(entry)
    }
  }
  const owned = new Set<Socket>()
  function own(socket: Socket) {
    owned.add(socket)
    socket.once('close', () => owned.delete(socket))
    socket.on('error', () => socket.destroy())
  }

  // The raw inbound socket survives CONNECT. A private loopback relay lets the
  // runtime serve normal HTTPS without handing an already-used socket to its TLS
  // parser (unsupported by Bun). Only proxy-owned relay sockets can send requests.
  const routes = new Map<number, { host: string; relay: Socket }>()
  const tls = createTlsServer(options.identity, (incoming, outgoing) => {
    const { remoteAddress, remotePort, servername } =
      incoming.socket as TLSSocket
    const route =
      remoteAddress === loopback && remotePort
        ? routes.get(remotePort)
        : undefined
    const target = route && !route.relay.destroyed ? route.host : undefined
    const authorized = target ? byHost.get(target) : undefined
    const host = incoming.headers.host?.toLowerCase()
    const path = incoming.url
    if (
      !target ||
      !authorized ||
      typeof servername !== 'string' ||
      servername.toLowerCase() !== target ||
      (host !== target && host !== `${target}:443`) ||
      !path?.startsWith('/') ||
      path.startsWith('//')
    ) {
      outgoing.writeHead(403, { connection: 'close' }).end()
      return
    }
    const headers = endToEndHeaders(incoming.headers)
    if (headers.authorization)
      headers.authorization = authorizationFor(
        headers.authorization,
        authorized,
      )
    const failed = () => {
      if (outgoing.headersSent) outgoing.destroy()
      else outgoing.writeHead(502, { connection: 'close' }).end()
    }
    try {
      const channel = (options.upstreamRequest ?? request)(
        {
          hostname: target,
          port: 443,
          servername: target,
          rejectUnauthorized: true,
          method: incoming.method,
          headers,
          path,
        },
        (response) => {
          outgoing.writeHead(
            response.statusCode ?? 502,
            endToEndHeaders(response.headers),
          )
          response.once('error', failed)
          response.pipe(outgoing)
        },
      )
      channel.once('error', failed)
      channel.setTimeout(30_000, () => channel.destroy())
      incoming.on('error', () => channel.destroy())
      outgoing.once('close', () => channel.destroy())
      incoming.pipe(channel)
    } catch {
      failed()
    }
  })
  tls.on('connection', own)
  const innerPort = await listen(tls, loopback)
  const proxy = createHttpServer((_incoming, outgoing) => {
    outgoing.writeHead(403, { connection: 'close' }).end()
  })
  proxy.on('connection', own)
  proxy.on('connect', (incoming, socket, head) => {
    const host = /^([a-z0-9.-]+):443$/iu
      .exec(incoming.url ?? '')?.[1]
      ?.toLowerCase()
    if (!host || !byHost.has(host)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    socket.pause()
    const relay = connect(innerPort, loopback)
    own(relay)
    socket.once('close', () => relay.destroy())
    relay.once('close', () => socket.destroy())
    relay.once('connect', () => {
      const port = relay.localPort
      if (!port) {
        relay.destroy()
        return
      }
      const route = { host, relay }
      routes.set(port, route)
      relay.once('close', () => {
        if (routes.get(port) === route) routes.delete(port)
      })
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) relay.write(head)
      socket.pipe(relay).pipe(socket)
    })
  })
  let closing: Promise<void> | undefined
  const close = () => {
    closing ??= Promise.all([
      new Promise<void>((done) => proxy.close(() => done())),
      new Promise<void>((done) => tls.close(() => done())),
    ]).then(() => undefined)
    for (const socket of owned) socket.destroy()
    return closing
  }
  try {
    return { port: await listen(proxy, options.listenHost), close }
  } catch (cause) {
    await close()
    throw cause
  }
}
