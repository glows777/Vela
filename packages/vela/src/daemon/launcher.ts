import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultAgentDir } from '../driver/config/paths.ts'
import {
  assertSocketOrMissing,
  daemonOwnerLockPath,
  ensurePrivateSocketDir,
  removeStaleSocketFile,
  resolveDaemonPaths,
} from './paths.ts'
import {
  isPidAlive,
  probeDaemonHello,
  probeReachableDaemon,
  readLogTail,
  readOwnerRecord,
  readPidRecord,
  rpcOnce,
  sleep,
} from './probe.ts'
import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonHello,
  type DaemonStatus,
  getAppVersion,
} from './protocol.ts'

const STALE_LOCK_MS = 60_000
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

export interface DaemonCommandOverride {
  command: string
  args?: string[]
  env?: Record<string, string | undefined>
}

export interface DaemonLifecycleOptions {
  agentDir?: string
  socketPath?: string
  hostEnv?: Record<string, string | undefined>
  daemonCommand?: DaemonCommandOverride
  appVersion?: string
  protocolVersion?: number
  timeoutMs?: number
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

function readLaunchLock(
  lockPath: string,
): { pid?: number; instanceId?: string } | undefined {
  try {
    const raw = readFileSync(lockPath, 'utf8').trim()
    if (!raw) return undefined
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw) as { pid?: unknown; instanceId?: unknown }
      return {
        ...(typeof parsed.pid === 'number' ? { pid: parsed.pid } : {}),
        ...(typeof parsed.instanceId === 'string'
          ? { instanceId: parsed.instanceId }
          : {}),
      }
    }
    const holderPid = Number.parseInt(raw, 10)
    return Number.isInteger(holderPid) ? { pid: holderPid } : undefined
  } catch {
    return undefined
  }
}

async function acquireLock(
  lockPath: string,
  timeoutMs: number,
): Promise<() => void> {
  const deadline = Date.now() + timeoutMs
  const lockId = randomUUID()
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
  for (;;) {
    const tmpPath = `${lockPath}.${process.pid}.${lockId}.tmp`
    try {
      const fd = openSync(
        tmpPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      )
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, instanceId: lockId }))
      } finally {
        closeSync(fd)
      }
      linkSync(tmpPath, lockPath)
      return () => {
        const current = readLaunchLock(lockPath)
        if (!current?.instanceId || current.instanceId === lockId) {
          rmSync(lockPath, { force: true })
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
      let stale = false
      try {
        const st = statSync(lockPath)
        const holder = readLaunchLock(lockPath)
        if (
          holder?.pid === undefined ||
          !Number.isInteger(holder.pid) ||
          !isPidAlive(holder.pid)
        ) {
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
    } finally {
      rmSync(tmpPath, { force: true })
    }
  }
}

type DaemonExitOutcome = 'exited' | 'replaced' | 'timeout'

async function waitForDaemonExit(
  socketPath: string,
  pidPath: string,
  expected:
    | { pid?: number; instanceId?: string; allowSignal?: boolean }
    | undefined,
  timeoutMs: number,
  ownerPath?: string,
): Promise<DaemonExitOutcome> {
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
      return 'replaced'
    }
    const currentPidRecord = readPidRecord(pidPath)
    if (
      currentPidRecord?.instanceId &&
      expectedInstanceId &&
      currentPidRecord.instanceId !== expectedInstanceId
    ) {
      return 'replaced'
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
    if (!alive) return 'exited'
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
    return !isPidAlive(pid) ? 'exited' : 'timeout'
  }
  return (await probeDaemonHello(socketPath, 200)) === undefined
    ? 'exited'
    : 'timeout'
}

/**
 * Ensures the resident daemon for `agentDir` is running and matches the current
 * protocol & app version (stopping and respawning mismatched daemons automatically).
 */
export async function ensureDaemonRunning(
  options: DaemonLifecycleOptions = {},
): Promise<DaemonHello> {
  const rawHostEnv = options.hostEnv ?? process.env
  const hostEnv = stripTransientDaemonEnv(rawHostEnv)
  const agentDir = options.agentDir ?? defaultAgentDir(rawHostEnv)
  const hasExplicitSocket = Boolean(
    options.socketPath ?? rawHostEnv.VELA_DAEMON_SOCKET,
  )
  const paths = resolveDaemonPaths(agentDir, options.socketPath, rawHostEnv)
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

  const existingEndpoint = await probeReachableDaemon(
    paths,
    hasExplicitSocket,
    500,
  )
  if (
    existingEndpoint &&
    existingEndpoint.socketPath === paths.socketPath &&
    matches(existingEndpoint.hello)
  ) {
    return existingEndpoint.hello
  }

  const release = await acquireLock(paths.lockPath, timeoutMs)
  try {
    let secondEndpoint = await probeReachableDaemon(
      paths,
      hasExplicitSocket,
      500,
    )
    if (
      secondEndpoint &&
      secondEndpoint.socketPath === paths.socketPath &&
      matches(secondEndpoint.hello)
    ) {
      return secondEndpoint.hello
    }

    if (!secondEndpoint) {
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
        const candidate = await probeReachableDaemon(
          paths,
          hasExplicitSocket,
          300,
        )
        if (candidate) {
          secondEndpoint = candidate
          break
        }
        await sleep(50)
      }
      if (
        secondEndpoint &&
        secondEndpoint.socketPath === paths.socketPath &&
        matches(secondEndpoint.hello)
      ) {
        return secondEndpoint.hello
      }
      if (!secondEndpoint) {
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

    if (secondEndpoint) {
      const targetSocketPath = secondEndpoint.socketPath
      const secondCheck = secondEndpoint.hello
      const pidRecord = readPidRecord(paths.pidPath)
      const target = {
        pid: secondCheck.pid ?? pidRecord?.pid,
        instanceId: secondCheck.instanceId ?? pidRecord?.instanceId,
        allowSignal: secondCheck.pid !== undefined,
      }
      try {
        await rpcOnce(targetSocketPath, 'daemon.stop', undefined, 3000)
      } catch {}
      const outcome = await waitForDaemonExit(
        targetSocketPath,
        paths.pidPath,
        target,
        30_000,
        ownerPath,
      )
      if (outcome === 'timeout') {
        throw new Error(
          `Timed out stopping mismatched Vela daemon (pid ${target.pid ?? 'unknown'})`,
        )
      }
      if (targetSocketPath !== paths.socketPath) {
        removeStaleSocketFile(targetSocketPath)
      }
      if (outcome === 'replaced') {
        const replacement = await probeDaemonHello(paths.socketPath, 500)
        assertMatchingAgentDir(replacement)
        if (replacement && matches(replacement)) return replacement
        const liveOwner = readOwnerRecord(ownerPath)
        if (
          liveOwner?.pid &&
          liveOwner.pid !== process.pid &&
          isPidAlive(liveOwner.pid)
        ) {
          throw new Error(
            `Vela daemon was replaced concurrently by pid ${liveOwner.pid} with incompatible version/state`,
          )
        }
      }
    }

    const latestOwner = readOwnerRecord(ownerPath)
    if (
      latestOwner?.pid &&
      latestOwner.pid !== process.pid &&
      isPidAlive(latestOwner.pid)
    ) {
      const liveHello = await probeDaemonHello(paths.socketPath, 500)
      assertMatchingAgentDir(liveHello)
      if (liveHello && matches(liveHello)) return liveHello
      throw new Error(
        `Vela daemon owner (pid ${latestOwner.pid}) is already active at ${paths.agentDir}`,
      )
    }

    removeStaleSocketFile(paths.socketPath)
    mkdirSync(paths.agentDir, { recursive: true, mode: 0o700 })
    ensurePrivateSocketDir(paths.socketPath)
    const logFd = openSync(paths.logPath, 'a', 0o600)
    const { command, args } = options.daemonCommand
      ? {
          command: options.daemonCommand.command,
          args: [
            ...(options.daemonCommand.args ?? []),
            '--agent-dir',
            paths.agentDir,
          ],
        }
      : resolveDaemonSpawnCommand(paths.agentDir)
    const childEnv: NodeJS.ProcessEnv = {
      ...hostEnv,
      ...(options.daemonCommand?.env ?? {}),
    }
    if (options.socketPath) {
      childEnv.VELA_DAEMON_SOCKET = options.socketPath
    }
    let childExited:
      | { code: number | null; signal: NodeJS.Signals | null }
      | undefined
    let spawnError: Error | undefined
    const child = spawn(command, args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: childEnv,
    })
    child.on('error', (error) => {
      spawnError = error
    })
    child.on('exit', (code, signal) => {
      childExited = { code, signal }
    })
    closeSync(logFd)
    child.unref()

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (spawnError) break
      const hello = await probeDaemonHello(paths.socketPath, 300)
      if (hello) {
        if (matches(hello)) return hello
        if (child.pid !== undefined && hello.pid === child.pid) {
          try {
            process.kill(child.pid, 'SIGTERM')
          } catch {}
          throw new Error(
            `Spawned Vela daemon mismatch at ${paths.socketPath}: expected protocol ${expectedProto} app ${expectedApp} (${paths.agentDir}), got protocol ${hello.protocolVersion} app ${hello.appVersion} (${hello.agentDir})`,
          )
        }
      }
      if (childExited || spawnError) break
      await sleep(50)
    }
    if (spawnError) {
      throw new Error(
        `Failed to spawn Vela daemon (${command}): ${spawnError.message}`,
      )
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
  const hostEnv = options.hostEnv ?? process.env
  const agentDir = options.agentDir ?? defaultAgentDir(hostEnv)
  const hasExplicitSocket = Boolean(
    options.socketPath ?? hostEnv.VELA_DAEMON_SOCKET,
  )
  const paths = resolveDaemonPaths(agentDir, options.socketPath, hostEnv)
  const ownerPath = daemonOwnerLockPath(paths.agentDir)
  const reachable = await probeReachableDaemon(paths, hasExplicitSocket, 500)
  const hello = reachable?.hello
  const targetSocketPath = reachable?.socketPath ?? paths.socketPath
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
      await rpcOnce(targetSocketPath, 'daemon.stop', undefined, 5000)
    } catch {}
  } else if (liveOwner?.pid && liveOwner.pid !== process.pid) {
    try {
      process.kill(liveOwner.pid, 'SIGTERM')
    } catch {}
  }
  const outcome = await waitForDaemonExit(
    targetSocketPath,
    paths.pidPath,
    { pid, instanceId, allowSignal: Boolean(hello?.pid || liveOwner) },
    options.timeoutMs ?? 30_000,
    ownerPath,
  )
  if (outcome === 'timeout') {
    throw new Error(
      `Failed to stop Vela daemon (pid ${pid ?? 'unknown'}, socket: ${targetSocketPath})`,
    )
  }
  const latestHello = await probeDaemonHello(targetSocketPath, 150)
  const latestOwner = readOwnerRecord(ownerPath)
  const latestOwnerAlive =
    latestOwner?.pid !== undefined && isPidAlive(latestOwner.pid)
  const replacedByNewOwner =
    latestOwnerAlive &&
    (!instanceId ||
      !latestOwner.instanceId ||
      latestOwner.instanceId !== instanceId)
  const latestPid = readPidRecord(paths.pidPath)
  const replacedByNewPid = Boolean(
    latestPid?.instanceId &&
      (!instanceId || latestPid.instanceId !== instanceId),
  )
  if (
    !replacedByNewOwner &&
    !replacedByNewPid &&
    (!latestHello || (instanceId && latestHello.instanceId === instanceId))
  ) {
    removeStaleSocketFile(targetSocketPath)
  }
  if (
    existsSync(paths.pidPath) &&
    !replacedByNewOwner &&
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
  const hostEnv = options.hostEnv ?? process.env
  const agentDir = options.agentDir ?? defaultAgentDir(hostEnv)
  const hasExplicitSocket = Boolean(
    options.socketPath ?? hostEnv.VELA_DAEMON_SOCKET,
  )
  const paths = resolveDaemonPaths(agentDir, options.socketPath, hostEnv)
  const reachable = await probeReachableDaemon(paths, hasExplicitSocket, 500)
  if (!reachable) {
    return {
      running: false,
      agentDir: paths.agentDir,
      socketPath: paths.socketPath,
    }
  }
  const { socketPath: targetSocketPath, hello } = reachable
  try {
    return await rpcOnce<DaemonStatus>(
      targetSocketPath,
      'daemon.status',
      undefined,
      options.timeoutMs ?? 5000,
    )
  } catch {
    return {
      running: true,
      agentDir: paths.agentDir,
      socketPath: targetSocketPath,
      pid: hello.pid,
      protocolVersion: hello.protocolVersion,
      appVersion: hello.appVersion,
      startedAt: hello.startedAt,
      uptimeMs: Math.max(0, Date.now() - Date.parse(hello.startedAt)),
    }
  }
}
