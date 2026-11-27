import { createHash } from 'node:crypto'
import { lstatSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalLocalPath } from '../db/trust.ts'

export interface DaemonPaths {
  agentDir: string
  socketPath: string
  lockPath: string
  pidPath: string
  logPath: string
}

const POSIX_SOCKET_MAX_BYTES = 96

function shortDirHash(canonicalDir: string): string {
  return createHash('sha256').update(canonicalDir).digest('hex').slice(0, 12)
}

function assertSocketByteLimit(socketPath: string): void {
  if (
    process.platform !== 'win32' &&
    Buffer.byteLength(socketPath) > POSIX_SOCKET_MAX_BYTES
  ) {
    throw new Error(
      `Daemon socket path exceeds ${POSIX_SOCKET_MAX_BYTES}-byte POSIX limit: ${socketPath}`,
    )
  }
}

export function daemonOwnerLockPath(agentDir: string): string {
  return join(canonicalLocalPath(agentDir), 'daemon.owner')
}

export function assertSocketOrMissing(socketPath: string): void {
  if (process.platform === 'win32') return
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(socketPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!st.isSocket()) {
    throw new Error(
      `Refusing to use or remove non-socket path at ${socketPath}`,
    )
  }
}

export function removeStaleSocketFile(socketPath: string): void {
  if (process.platform === 'win32') return
  assertSocketOrMissing(socketPath)
  rmSync(socketPath, { force: true })
}

/**
 * Resolves the IPC endpoint (`vela.sock` or Windows named pipe) and control files
 * (`daemon.lock`, `daemon.pid`, `daemon.log`) for an owner `agentDir`.
 */
export function resolveDaemonPaths(
  agentDir: string,
  socketPathOverride?: string,
  hostEnv?: Record<string, string | undefined>,
): DaemonPaths {
  const dir = canonicalLocalPath(agentDir)
  const rawOverride = socketPathOverride ?? hostEnv?.VELA_DAEMON_SOCKET
  let socketPath: string
  if (rawOverride) {
    socketPath = rawOverride
    assertSocketByteLimit(socketPath)
  } else if (process.platform === 'win32') {
    socketPath = `\\\\.\\pipe\\vela-${shortDirHash(dir)}`
  } else {
    const preferred = join(dir, 'vela.sock')
    if (Buffer.byteLength(preferred) <= POSIX_SOCKET_MAX_BYTES) {
      socketPath = preferred
    } else {
      const hashName = `vela-${shortDirHash(dir)}.sock`
      socketPath = join('/tmp', hashName)
      assertSocketByteLimit(socketPath)
    }
  }
  return {
    agentDir: dir,
    socketPath,
    lockPath: join(dir, 'daemon.lock'),
    pidPath: join(dir, 'daemon.pid'),
    logPath: join(dir, 'daemon.log'),
  }
}
