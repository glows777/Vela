import { spawn } from 'node:child_process'
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultAgentDir } from '../driver/config/paths.ts'
import {
  assertSocketOrMissing,
  daemonOwnerLockPath,
  removeStaleSocketFile,
  resolveDaemonPaths,
} from './paths.ts'
import {
  createNdjsonParser,
  DAEMON_PROTOCOL_VERSION,
  type DaemonHello,
  type DaemonStatus,
  deserializeError,
  encodeWireLine,
  getAppVersion,
} from './protocol.ts'

const STALE_LOCK_MS = 30_000
const DEFAULT_START_TIMEOUT_MS = 15_000

const TRANSIENT_CALLER_ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_API_BASE_URL',
  'OPENAI_API_MODEL_NAME',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'VELA_MODEL',
  'VELA_OFFLINE',
  'VELA_RECORD',
] as const

export function stripTransientDaemonEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out = { ...env }
  for (const key of TRANSIENT_CALLER_ENV_KEYS) {
    delete out[key]
  }
  return out
}

interface DaemonLifecycleOptions {
  agentDir?: string
  socketPath?: string
  hostEnv?: Record<string, string | undefined>
  appVersion?: string
  protocolVersion?: number
  timeoutMs?: number
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractPreloadArgs(execArgv: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i]!
    if (arg.startsWith('--preload=') || arg.startsWith('-r=')) {
      out.push(arg)
    } else if (arg === '--preload' || arg === '-r') {
      const next = execArgv[i + 1]
      if (next !== undefined) {
        out.push(arg, next)
        i += 1
      }
    }
  }
  return out
}

/**
 * Resolves the child command `[bin, ...args]` to launch `vela daemon run`.
 * Supports source (`cli/main.ts`), built `dist/cli/main.js`, and single-file test bundles.
 */
function resolveDaemonSpawnCommand(agentDir: string): {
  command: string
  args: string[]
} {
  const preloads = extractPreloadArgs(process.execArgv)
  const here = dirname(fileURLToPath(import.meta.url))
  const siblingExt = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
  const candidate = join(here, '..', 'cli', `main${siblingExt}`)
  if (existsSync(candidate)) {
    return {
      command: process.execPath,
      args: [...preloads, candidate, '--agent-dir', agentDir, 'daemon', 'run'],
    }
  }
  const argvEntry = process.argv[1]
  if (argvEntry && existsSync(argvEntry)) {
    return {
      command: process.execPath,
      args: [...preloads, argvEntry, '--agent-dir', agentDir, 'daemon', 'run'],
    }
  }
  throw new Error('Unable to locate Vela CLI entry to start daemon')
}

async function rpcOnce<T>(
  socketPath: string,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<T> {
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
    const parse = createNdjsonParser((msg) => {
      if (msg.type === 'res' && msg.id === 1) {
        if (msg.ok) finish(undefined, msg.result as T)
        else finish(deserializeError(msg.error))
      }
    })
    socket.on('error', (err) => finish(err))
    socket.on('data', parse)
    socket.on('connect', () => {
      socket.write(encodeWireLine({ type: 'req', id: 1, method, params }))
    })
  })
}

/** Probes a running daemon endpoint for handshake metadata; returns `undefined` if unreachable. */
async function probeDaemonHello(
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

async function acquireLock(
  lockPath: string,
  timeoutMs: number,
): Promise<() => void> {
  const deadline = Date.now() + timeoutMs
  mkdirSync(dirname(lockPath), { recursive: true })
  for (;;) {
    try {
      const fd = openSync(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      )
      try {
        writeSync(fd, `${process.pid}\n`)
      } finally {
        closeSync(fd)
      }
      return () => {
        rmSync(lockPath, { force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
      let stale = false
      try {
        const st = statSync(lockPath)
        const raw = readFileSync(lockPath, 'utf8').trim()
        const holderPid = Number.parseInt(raw, 10)
        if (!Number.isInteger(holderPid) || !isPidAlive(holderPid)) {
          stale = true
        } else if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          stale = true
        }
      } catch (readErr) {
        if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') continue
      }
      if (stale) {
        rmSync(lockPath, { force: true })
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for daemon launch lock: ${lockPath}`)
      }
      await sleep(50)
    }
  }
}

function readLogTail(logPath: string, maxLines = 20): string {
  if (!existsSync(logPath)) return ''
  try {
    const lines = readFileSync(logPath, 'utf8').trim().split('\n')
    return lines.slice(-maxLines).join('\n')
  } catch {
    return ''
  }
}

function readPidRecord(
  pidPath: string,
): { pid?: number; instanceId?: string } | undefined {
  if (!existsSync(pidPath)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(pidPath, 'utf8')) as {
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

function readOwnerRecord(
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

async function waitForDaemonExit(
  socketPath: string,
  pidPath: string,
  expected:
    | { pid?: number; instanceId?: string; allowSignal?: boolean }
    | undefined,
  timeoutMs: number,
  ownerPath?: string,
): Promise<boolean> {
  const pid = expected?.pid
  const expectedInstanceId = expected?.instanceId
  const sameProcess = pid === process.pid
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const currentHello = await probeDaemonHello(socketPath, 200)
    if (
      currentHello &&
      expectedInstanceId &&
      currentHello.instanceId &&
      currentHello.instanceId !== expectedInstanceId
    ) {
      // A newer daemon instance has already replaced the target.
      return true
    }
    const currentPidRecord = readPidRecord(pidPath)
    if (
      currentPidRecord?.instanceId &&
      expectedInstanceId &&
      currentPidRecord.instanceId !== expectedInstanceId
    ) {
      return true
    }
    const pidMatchesExpected =
      pid !== undefined &&
      isPidAlive(pid) &&
      (!expectedInstanceId ||
        !currentPidRecord?.instanceId ||
        currentPidRecord.instanceId === expectedInstanceId)
    const alive = sameProcess
      ? currentHello !== undefined
      : Boolean(currentHello) || pidMatchesExpected
    if (!alive) return true
    await sleep(50)
  }
  const currentPidRecord = readPidRecord(pidPath)
  const currentOwnerRecord = ownerPath ? readOwnerRecord(ownerPath) : undefined
  const ownerVerified =
    currentOwnerRecord?.pid === pid &&
    (!expectedInstanceId ||
      currentOwnerRecord?.instanceId === expectedInstanceId)
  const safeToSignal =
    !sameProcess &&
    pid !== undefined &&
    isPidAlive(pid) &&
    (expected?.allowSignal === true || ownerVerified) &&
    (!expectedInstanceId ||
      !currentPidRecord?.instanceId ||
      currentPidRecord.instanceId === expectedInstanceId)
  if (safeToSignal) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
    const killDeadline = Date.now() + 2000
    while (Date.now() < killDeadline && isPidAlive(pid)) {
      await sleep(50)
    }
    return !isPidAlive(pid)
  }
  return (await probeDaemonHello(socketPath, 200)) === undefined
}

/**
 * Ensures the resident daemon for `agentDir` is running and matches the current
 * protocol & app version (stopping and respawning mismatched daemons automatically).
 */
export async function ensureDaemonRunning(
  options: DaemonLifecycleOptions = {},
): Promise<DaemonHello> {
  const hostEnv = options.hostEnv ?? {}
  const agentDir = options.agentDir ?? defaultAgentDir(hostEnv)
  const paths = resolveDaemonPaths(agentDir, options.socketPath, hostEnv)
  const ownerPath = daemonOwnerLockPath(paths.agentDir)
  assertSocketOrMissing(paths.socketPath)
  const expectedProto = options.protocolVersion ?? DAEMON_PROTOCOL_VERSION
  const expectedApp = options.appVersion ?? getAppVersion()
  const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS

  const assertMatchingAgentDir = (hello: DaemonHello | undefined): void => {
    if (hello && hello.agentDir !== paths.agentDir) {
      throw new Error(
        `Socket ${paths.socketPath} belongs to ${hello.agentDir}, expected ${paths.agentDir}`,
      )
    }
  }

  const matches = (hello: DaemonHello | undefined): boolean =>
    Boolean(
      hello &&
        hello.agentDir === paths.agentDir &&
        hello.protocolVersion === expectedProto &&
        hello.appVersion === expectedApp,
    )

  const existing = await probeDaemonHello(paths.socketPath, 500)
  assertMatchingAgentDir(existing)
  if (existing && matches(existing)) return existing

  const release = await acquireLock(paths.lockPath, timeoutMs)
  try {
    let secondCheck = await probeDaemonHello(paths.socketPath, 500)
    assertMatchingAgentDir(secondCheck)
    if (secondCheck && matches(secondCheck)) return secondCheck

    if (!secondCheck) {
      const ownerDeadline = Date.now() + timeoutMs
      while (Date.now() < ownerDeadline) {
        const owner = readOwnerRecord(ownerPath)
        if (
          !owner?.pid ||
          owner.pid === process.pid ||
          !isPidAlive(owner.pid)
        ) {
          break
        }
        const candidate = await probeDaemonHello(paths.socketPath, 300)
        assertMatchingAgentDir(candidate)
        if (candidate) {
          secondCheck = candidate
          break
        }
        await sleep(50)
      }
      if (secondCheck && matches(secondCheck)) return secondCheck
      if (!secondCheck) {
        const ownerAfterWait = readOwnerRecord(ownerPath)
        if (
          ownerAfterWait?.pid &&
          ownerAfterWait.pid !== process.pid &&
          isPidAlive(ownerAfterWait.pid)
        ) {
          throw new Error(
            `Vela daemon owner (pid ${ownerAfterWait.pid}) is active, but socket ${paths.socketPath} did not become ready`,
          )
        }
      }
    }

    if (secondCheck) {
      const pidRecord = readPidRecord(paths.pidPath)
      const target = {
        pid: secondCheck.pid ?? pidRecord?.pid,
        instanceId: secondCheck.instanceId ?? pidRecord?.instanceId,
        allowSignal: secondCheck.pid !== undefined,
      }
      try {
        await rpcOnce(paths.socketPath, 'daemon.stop', undefined, 3000)
      } catch {}
      const exited = await waitForDaemonExit(
        paths.socketPath,
        paths.pidPath,
        target,
        30_000,
        ownerPath,
      )
      if (!exited) {
        throw new Error(
          `Timed out stopping mismatched Vela daemon (pid ${target.pid ?? 'unknown'})`,
        )
      }
    }

    removeStaleSocketFile(paths.socketPath)
    mkdirSync(paths.agentDir, { recursive: true })
    const logFd = openSync(paths.logPath, 'a', 0o600)
    const { command, args } = resolveDaemonSpawnCommand(paths.agentDir)
    const childEnv: NodeJS.ProcessEnv = { ...hostEnv }
    if (options.socketPath) {
      childEnv.VELA_DAEMON_SOCKET = options.socketPath
    }
    let childExited:
      | { code: number | null; signal: NodeJS.Signals | null }
      | undefined
    const child = spawn(command, args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: childEnv,
    })
    child.on('exit', (code, signal) => {
      childExited = { code, signal }
    })
    closeSync(logFd)
    child.unref()

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hello = await probeDaemonHello(paths.socketPath, 300)
      if (hello && matches(hello)) return hello
      if (childExited) break
      await sleep(50)
    }
    const tail = readLogTail(paths.logPath)
    const reason = childExited
      ? `exited with code ${childExited.code ?? childExited.signal}`
      : `did not become ready within ${timeoutMs}ms`
    throw new Error(
      `Vela daemon ${reason} (socket: ${paths.socketPath})${tail ? `\n${tail}` : ''}`,
    )
  } finally {
    release()
  }
}

export async function startDaemon(
  options: DaemonLifecycleOptions = {},
): Promise<DaemonHello> {
  return ensureDaemonRunning(options)
}

export async function stopDaemon(
  options: DaemonLifecycleOptions = {},
): Promise<boolean> {
  const hostEnv = options.hostEnv ?? {}
  const agentDir = options.agentDir ?? defaultAgentDir(hostEnv)
  const paths = resolveDaemonPaths(agentDir, options.socketPath, hostEnv)
  const ownerPath = daemonOwnerLockPath(paths.agentDir)
  assertSocketOrMissing(paths.socketPath)
  const hello = await probeDaemonHello(paths.socketPath, 500)
  if (hello && hello.agentDir !== paths.agentDir) {
    throw new Error(
      `Socket ${paths.socketPath} belongs to ${hello.agentDir}, expected ${paths.agentDir}`,
    )
  }
  const ownerRecord = readOwnerRecord(ownerPath)
  const liveOwner =
    ownerRecord?.pid !== undefined && isPidAlive(ownerRecord.pid)
      ? ownerRecord
      : undefined
  const pid = hello?.pid ?? liveOwner?.pid
  const instanceId = hello?.instanceId ?? liveOwner?.instanceId
  if (!hello && !liveOwner) {
    removeStaleSocketFile(paths.socketPath)
    if (existsSync(paths.pidPath)) {
      rmSync(paths.pidPath, { force: true })
    }
    return false
  }
  if (hello) {
    try {
      await rpcOnce(paths.socketPath, 'daemon.stop', undefined, 5000)
    } catch {}
  }
  const exited = await waitForDaemonExit(
    paths.socketPath,
    paths.pidPath,
    { pid, instanceId, allowSignal: Boolean(hello?.pid || liveOwner) },
    options.timeoutMs ?? 30_000,
    ownerPath,
  )
  if (!exited) {
    throw new Error(
      `Failed to stop Vela daemon (pid ${pid ?? 'unknown'}, socket: ${paths.socketPath})`,
    )
  }
  const latestHello = await probeDaemonHello(paths.socketPath, 150)
  if (!latestHello || (instanceId && latestHello.instanceId === instanceId)) {
    removeStaleSocketFile(paths.socketPath)
  }
  const latestPid = readPidRecord(paths.pidPath)
  if (
    existsSync(paths.pidPath) &&
    (!instanceId ||
      !latestPid?.instanceId ||
      latestPid.instanceId === instanceId)
  ) {
    rmSync(paths.pidPath, { force: true })
  }
  return true
}

export async function getDaemonStatus(
  options: DaemonLifecycleOptions = {},
): Promise<DaemonStatus> {
  const hostEnv = options.hostEnv ?? {}
  const agentDir = options.agentDir ?? defaultAgentDir(hostEnv)
  const paths = resolveDaemonPaths(agentDir, options.socketPath, hostEnv)
  const hello = await probeDaemonHello(paths.socketPath, 500)
  if (!hello) {
    return {
      running: false,
      agentDir: paths.agentDir,
      socketPath: paths.socketPath,
    }
  }
  try {
    return await rpcOnce<DaemonStatus>(
      paths.socketPath,
      'daemon.status',
      undefined,
      1000,
    )
  } catch {
    return {
      running: true,
      agentDir: paths.agentDir,
      socketPath: paths.socketPath,
      pid: hello.pid,
      protocolVersion: hello.protocolVersion,
      appVersion: hello.appVersion,
      startedAt: hello.startedAt,
      uptimeMs: Math.max(0, Date.now() - Date.parse(hello.startedAt)),
    }
  }
}
