import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
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

/**
 * Resolves the IPC endpoint (`vela.sock` or Windows named pipe) and control files
 * (`daemon.lock`, `daemon.pid`, `daemon.log`) for an owner `agentDir`.
 */
export function resolveDaemonPaths(
  agentDir: string,
  socketPathOverride?: string,
): DaemonPaths {
  const dir = canonicalLocalPath(agentDir)
  let socketPath: string
  if (socketPathOverride) {
    socketPath = socketPathOverride
  } else if (process.platform === 'win32') {
    socketPath = `\\\\.\\pipe\\vela-${shortDirHash(dir)}`
  } else {
    const preferred = join(dir, 'vela.sock')
    socketPath =
      Buffer.byteLength(preferred) > POSIX_SOCKET_MAX_BYTES
        ? join(tmpdir(), `vela-${shortDirHash(dir)}.sock`)
        : preferred
  }
  return {
    agentDir: dir,
    socketPath,
    lockPath: join(dir, 'daemon.lock'),
    pidPath: join(dir, 'daemon.pid'),
    logPath: join(dir, 'daemon.log'),
  }
}
