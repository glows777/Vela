import {
  closeSync,
  constants,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'

const ACTIVE_OWNER_IDS = new Set<string>()

export class DaemonAlreadyRunningError extends Error {
  constructor(socketPath: string) {
    super(`Vela daemon is already running at ${socketPath}`)
    this.name = 'DaemonAlreadyRunningError'
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function readOwnerRecord(
  lockPath: string,
): { pid?: number; instanceId?: string } | undefined {
  if (!existsSync(lockPath)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as {
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

export function acquireOwnerLock(
  lockPath: string,
  instanceId: string,
  socketPath: string,
): () => void {
  mkdirSync(dirname(lockPath), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    const tmpPath = `${lockPath}.${process.pid}.${instanceId}.tmp`
    try {
      const fd = openSync(
        tmpPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      )
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, instanceId }))
      } finally {
        closeSync(fd)
      }
      linkSync(tmpPath, lockPath)
      ACTIVE_OWNER_IDS.add(instanceId)
      return () => {
        ACTIVE_OWNER_IDS.delete(instanceId)
        const current = readOwnerRecord(lockPath)
        if (!current || current.instanceId === instanceId) {
          rmSync(lockPath, { force: true })
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const owner = readOwnerRecord(lockPath)
      const ownerAlive =
        owner?.pid !== undefined &&
        (owner.pid === process.pid
          ? Boolean(owner.instanceId && ACTIVE_OWNER_IDS.has(owner.instanceId))
          : isPidAlive(owner.pid))
      if (ownerAlive) {
        throw new DaemonAlreadyRunningError(socketPath)
      }
      rmSync(lockPath, { force: true })
    } finally {
      rmSync(tmpPath, { force: true })
    }
  }
  throw new DaemonAlreadyRunningError(socketPath)
}
