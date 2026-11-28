import { existsSync, readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import {
  assertSocketOrMissing,
  assertSocketOwnership,
  type DaemonPaths,
  legacyFallbackSocketPath,
} from './paths.ts'
import {
  createNdjsonParser,
  type DaemonHello,
  deserializeError,
  encodeWireLine,
} from './protocol.ts'

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function rpcOnce<T>(
  socketPath: string,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<T> {
  assertSocketOwnership(socketPath)
  return new Promise<T>((resolve, reject) => {
    const socket = createConnection(socketPath)
    let settled = false
    const timer = setTimeout(() => {
      finish(new Error(`Timed out calling ${method} on ${socketPath}`))
    }, timeoutMs)
    const finish = (err: unknown, result?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (err !== undefined) reject(err)
      else resolve(result as T)
    }
    const parse = createNdjsonParser(
      (msg) => {
        if (msg.type === 'res' && msg.id === 1) {
          if (msg.ok) finish(undefined, msg.result as T)
          else finish(deserializeError(msg.error))
        }
      },
      (err) => {
        finish(
          err instanceof Error
            ? err
            : new Error(`Daemon IPC parse error: ${String(err)}`),
        )
        return false
      },
    )
    socket.on('error', (err) => finish(err))
    socket.on('close', () =>
      finish(
        new Error(`Socket closed while calling ${method} on ${socketPath}`),
      ),
    )
    socket.on('data', parse)
    socket.on('connect', () => {
      socket.write(encodeWireLine({ type: 'req', id: 1, method, params }))
    })
  })
}

/** Probes a running daemon endpoint for handshake metadata; returns `undefined` if unreachable. */
export async function probeDaemonHello(
  socketPath: string,
  timeoutMs = 500,
): Promise<DaemonHello | undefined> {
  try {
    return await rpcOnce<DaemonHello>(
      socketPath,
      'daemon.hello',
      undefined,
      timeoutMs,
    )
  } catch {
    return undefined
  }
}

export function readLogTail(logPath: string, maxLines = 20): string {
  if (!existsSync(logPath)) return ''
  try {
    const lines = readFileSync(logPath, 'utf8').trim().split('\n')
    return lines.slice(-maxLines).join('\n')
  } catch {
    return ''
  }
}

export function readPidRecord(
  pidPath: string,
): { pid?: number; instanceId?: string; socketPath?: string } | undefined {
  if (!existsSync(pidPath)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(pidPath, 'utf8')) as {
      pid?: unknown
      instanceId?: unknown
      socketPath?: unknown
    }
    return {
      ...(typeof parsed.pid === 'number' ? { pid: parsed.pid } : {}),
      ...(typeof parsed.instanceId === 'string'
        ? { instanceId: parsed.instanceId }
        : {}),
      ...(typeof parsed.socketPath === 'string'
        ? { socketPath: parsed.socketPath }
        : {}),
    }
  } catch {
    return undefined
  }
}

export async function probeReachableDaemon(
  paths: DaemonPaths,
  hasExplicitSocket: boolean,
  timeoutMs = 500,
): Promise<{ socketPath: string; hello: DaemonHello } | undefined> {
  assertSocketOrMissing(paths.socketPath)
  const primary = await probeDaemonHello(paths.socketPath, timeoutMs)
  if (primary) {
    if (primary.agentDir !== paths.agentDir) {
      throw new Error(
        `Socket ${paths.socketPath} belongs to ${primary.agentDir}, expected ${paths.agentDir}`,
      )
    }
    return { socketPath: paths.socketPath, hello: primary }
  }
  if (hasExplicitSocket) return undefined
  const legacyPath = legacyFallbackSocketPath(paths.agentDir)
  if (!legacyPath || legacyPath === paths.socketPath) return undefined
  const pidRecord = readPidRecord(paths.pidPath)
  if (
    !pidRecord?.pid ||
    !isPidAlive(pidRecord.pid) ||
    (pidRecord.socketPath && pidRecord.socketPath !== legacyPath)
  ) {
    return undefined
  }
  assertSocketOrMissing(legacyPath)
  const legacyHello = await probeDaemonHello(legacyPath, timeoutMs)
  if (!legacyHello) return undefined
  if (legacyHello.agentDir !== paths.agentDir) {
    throw new Error(
      `Socket ${legacyPath} belongs to ${legacyHello.agentDir}, expected ${paths.agentDir}`,
    )
  }
  return { socketPath: legacyPath, hello: legacyHello }
}

export function readOwnerRecord(
  ownerPath: string,
): { pid?: number; instanceId?: string } | undefined {
  if (!existsSync(ownerPath)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(ownerPath, 'utf8')) as {
      pid?: unknown
      instanceId?: unknown
    }
    return {
      ...(typeof parsed.pid === 'number' ? { pid: parsed.pid } : {}),
      ...(typeof parsed.instanceId === 'string'
        ? { instanceId: parsed.instanceId }
        : {}),
    }
  } catch {
    return undefined
  }
}
