import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { createConnection, createServer, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { defaultAgentDir } from '../driver/config/paths.ts'
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  LoginOptions,
} from '../providers/auth/types.ts'
import { createRuntime, type LocalVelaRuntime } from '../runtime-sdk.ts'
import { silentLogger, type VelaLogger } from '../shared/logger.ts'
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
  type DaemonWireMessage,
  encodeWireLine,
  getAppVersion,
  serializeError,
} from './protocol.ts'

const MAX_CLIENT_BUFFER_BYTES = 64 * 1024 * 1024
const ACTIVE_OWNER_IDS = new Set<string>()

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readOwnerRecord(
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

function acquireOwnerLock(
  lockPath: string,
  instanceId: string,
  socketPath: string,
): () => void {
  mkdirSync(dirname(lockPath), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      )
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, instanceId }))
      } finally {
        closeSync(fd)
      }
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
    }
  }
  throw new DaemonAlreadyRunningError(socketPath)
}

export class DaemonAlreadyRunningError extends Error {
  constructor(socketPath: string) {
    super(`Vela daemon is already running at ${socketPath}`)
    this.name = 'DaemonAlreadyRunningError'
  }
}

export interface StartDaemonServerOptions {
  agentDir?: string
  socketPath?: string
  hostEnv?: Record<string, string | undefined>
  logger?: VelaLogger
  appVersion?: string
  protocolVersion?: number
  registerSignalHandlers?: boolean
  onClosed?: (reason: string) => void
}

export interface DaemonServerHandle {
  readonly agentDir: string
  readonly socketPath: string
  readonly pidPath: string
  readonly startedAt: string
  readonly hello: DaemonHello
  readonly runtime: LocalVelaRuntime
  close(reason?: string): Promise<void>
}

interface PendingLoginClient {
  controller: AbortController
  prompts: Map<
    number,
    {
      resolve: (value: string) => void
      reject: (err: Error) => void
      cleanup?: () => void
    }
  >
}

interface ConnectedClient {
  socket: Socket
  subEvents: boolean
  subDeltas: boolean
  activeLogins: Map<number, PendingLoginClient>
  activeLogouts: Map<number, AbortController>
}

async function probeSocketAlive(socketPath: string): Promise<boolean> {
  if (process.platform !== 'win32' && !existsSync(socketPath)) return false
  return new Promise<boolean>((resolve) => {
    const probe = createConnection(socketPath)
    let done = false
    const finish = (alive: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      probe.destroy()
      resolve(alive)
    }
    const timer = setTimeout(() => finish(false), 400)
    probe.on('connect', () => finish(true))
    probe.on('error', () => finish(false))
  })
}

function safeWrite(socket: Socket, msg: DaemonWireMessage): void {
  if (socket.destroyed || !socket.writable) return
  if (socket.writableLength > MAX_CLIENT_BUFFER_BYTES) {
    socket.destroy()
    return
  }
  try {
    socket.write(encodeWireLine(msg))
  } catch {
    socket.destroy()
  }
}

/**
 * Starts the single-writer local daemon holding `createRuntime()` and listening
 * on `<agentDir>/vela.sock` (or fallback socket / Windows named pipe).
 */
export async function startDaemonServer(
  options: StartDaemonServerOptions = {},
): Promise<DaemonServerHandle> {
  const hostEnv = options.hostEnv ?? {}
  const logger = options.logger ?? silentLogger
  const rawAgentDir = options.agentDir ?? defaultAgentDir(hostEnv)
  const paths = resolveDaemonPaths(rawAgentDir, options.socketPath, hostEnv)

  mkdirSync(paths.agentDir, { recursive: true })
  assertSocketOrMissing(paths.socketPath)
  const instanceId = randomUUID()
  const ownerLockPath = daemonOwnerLockPath(paths.agentDir)
  const releaseOwner = acquireOwnerLock(
    ownerLockPath,
    instanceId,
    paths.socketPath,
  )

  let runtime: LocalVelaRuntime
  try {
    if (process.platform !== 'win32') {
      mkdirSync(dirname(paths.socketPath), { recursive: true })
      if (await probeSocketAlive(paths.socketPath)) {
        throw new DaemonAlreadyRunningError(paths.socketPath)
      }
      removeStaleSocketFile(paths.socketPath)
    }

    runtime = createRuntime({
      agentDir: paths.agentDir,
      hostEnv,
      logger,
    })
    await runtime.recover()
  } catch (error) {
    releaseOwner()
    throw error
  }

  const startedAt = new Date().toISOString()
  const startedAtMs = Date.now()
  const protocolVersion = options.protocolVersion ?? DAEMON_PROTOCOL_VERSION
  const appVersion = options.appVersion ?? getAppVersion()
  const hello: DaemonHello = {
    protocolVersion,
    appVersion,
    pid: process.pid,
    instanceId,
    agentDir: paths.agentDir,
    startedAt,
    socketPath: paths.socketPath,
  }

  const clients = new Set<ConnectedClient>()
  let nextPromptId = 1
  let closing: Promise<void> | undefined

  const unsubEvents = runtime.events.subscribe((event) => {
    for (const c of clients) {
      if (c.subEvents) safeWrite(c.socket, { type: 'event', event })
    }
  })
  const unsubDeltas = runtime.events.subscribeDeltas((delta) => {
    for (const c of clients) {
      if (c.subDeltas) safeWrite(c.socket, { type: 'delta', delta })
    }
  })

  // biome-ignore lint/suspicious/noExplicitAny: RPC params decoded dynamically from NDJSON
  type Handler = (p: any, client: ConnectedClient) => Promise<unknown> | unknown
  const handlers: Record<string, Handler> = {
    'daemon.hello': () => hello,
    'daemon.status': (): DaemonStatus => ({
      running: true,
      agentDir: paths.agentDir,
      socketPath: paths.socketPath,
      pid: process.pid,
      protocolVersion,
      appVersion,
      startedAt,
      uptimeMs: Math.max(0, Date.now() - startedAtMs),
    }),
    'daemon.stop': () => {
      setImmediate(() => {
        void close('rpc')
      })
      return { stopping: true }
    },
    'runtime.ready': () => runtime.ready(),
    'runtime.extensionErrors': () => runtime.extensionErrors(),
    'runtime.reloadConfig': () => runtime.reloadConfig(),
    'projects.list': (p) => runtime.projects.list(p),
    'projects.get': (p) => runtime.projects.get(p.id),
    'projects.getByCwd': (p) => runtime.projects.getByCwd(p.cwd),
    'projects.create': (p) => runtime.projects.create(p),
    'projects.update': (p) => runtime.projects.update(p.id, p.patch),
    'projects.remove': (p) => runtime.projects.remove(p.id, p.options),
    'trust.check': (p) => runtime.trust.check(p.location),
    'trust.approve': (p) => runtime.trust.approve(p.location, p.trusted),
    'oauthRegistrations.get': (p) => runtime.oauthRegistrations.get(p.provider),
    'oauthRegistrations.set': (p) =>
      runtime.oauthRegistrations.set(p.provider, p.registration),
    'oauthRegistrations.delete': (p) =>
      runtime.oauthRegistrations.delete(p.provider),
    'sessions.list': (p) => runtime.sessions.list(p),
    'sessions.listSummaries': (p) => runtime.sessions.listSummaries(p),
    'sessions.get': (p) => runtime.sessions.get(p.id),
    'sessions.create': (p) => runtime.sessions.create(p),
    'sessions.rename': (p) => runtime.sessions.rename(p.id, p.name),
    'sessions.delete': (p) => runtime.sessions.delete(p.id),
    'sessions.reset': (p) => runtime.sessions.reset(p.id),
    'sessions.status': (p) => runtime.sessions.status(p.id),
    'sessions.messages': (p) => runtime.sessions.messages(p),
    'sessions.configure': (p) =>
      runtime.sessions.configure(p.sessionId, p.override),
    'sessions.setModel': (p) =>
      runtime.sessions.setModel(p.sessionId, p.modelRef),
    'sessions.setThinkingLevel': (p) =>
      runtime.sessions.setThinkingLevel(p.sessionId, p.level),
    'sessions.compact': (p) =>
      runtime.sessions.compact(p.sessionId, p.instructions),
    'sessions.tree': (p) => runtime.sessions.tree(p.sessionId),
    'sessions.navigateTree': (p) =>
      runtime.sessions.navigateTree(p.sessionId, p.targetId, p.options),
    'sessions.setLabel': (p) =>
      runtime.sessions.setLabel(p.sessionId, p.entryId, p.label),
    'sessions.fork': (p) =>
      runtime.sessions.fork(p.sessionId, p.entryId, p.options),
    'sessions.clone': (p) => runtime.sessions.clone(p.sessionId, p.options),
    'sessions.inspect': (p) => runtime.sessions.inspect(p.sessionId, p.options),
    'sessions.execBash': (p) =>
      runtime.sessions.execBash(p.sessionId, p.command, p.options),
    'sessions.abortBash': (p) => runtime.sessions.abortBash(p.sessionId),
    'sessions.runCommand': (p) =>
      runtime.sessions.runCommand(p.sessionId, p.input),
    'sessions.clearQueue': (p) => runtime.sessions.clearQueue(p.sessionId),
    'sessions.export': (p) =>
      runtime.sessions.export(p.sessionId, p.format, p.outputPath, p.baseCwd),
    'runtime.prompt': (p) => runtime.prompt(p.sessionId, p.input),
    'runtime.steer': (p) => runtime.steer(p.sessionId, p.text),
    'runtime.stop': (p) => runtime.stop(p.sessionId, p.reason),
    'runtime.waitForIdle': (p) => runtime.waitForIdle(p?.sessionId),
    'jobs.list': (p) => runtime.jobs.list(p?.sessionId),
    'jobs.stop': (p) => runtime.jobs.stop(p.sessionId, p.jobId),
    'jobs.promoteForeground': (p) =>
      runtime.jobs.promoteForeground(p.sessionId, p.toolCallId),
    'approvals.list': (p) => runtime.approvals.list(p?.sessionId),
    'approvals.resolve': (p) => runtime.approvals.resolve(p),
    'timers.list': (p) => runtime.timers.list(p),
    'timers.createRoutine': (p) => runtime.timers.createRoutine(p),
    'timers.createFollowup': (p) => runtime.timers.createFollowup(p),
    'timers.update': (p) => runtime.timers.update(p.id, p.patch),
    'timers.delete': (p) => runtime.timers.delete(p.id),
    'subscriptions.list': (p) => runtime.subscriptions.list(p),
    'subscriptions.create': (p) => runtime.subscriptions.create(p),
    'subscriptions.remove': (p) => runtime.subscriptions.remove(p.id),
    'bindings.list': (p) => runtime.bindings.list(p),
    'bindings.get': (p) => runtime.bindings.get(p.id),
    'bindings.upsert': (p) => runtime.bindings.upsert(p),
    'bindings.setEnabled': (p) => runtime.bindings.setEnabled(p.id, p.enabled),
    'bindings.remove': (p) => runtime.bindings.remove(p.id),
    'blobs.get': (p) => runtime.blobs.get(p.id),
    'blobs.list': (p) => runtime.blobs.list(p.sessionId, p.direction),
    'blobs.read': (p) => runtime.blobs.read(p.id),
    'blobs.storeInbound': (p) => runtime.blobs.storeInbound(p),
    'events.list': (p) => runtime.events.list(p),
    'events.bufferedDeltas': (p) => runtime.events.bufferedDeltas(p.sessionId),
    'events.subscribe': (_p, c) => {
      c.subEvents = true
      return true
    },
    'events.unsubscribe': (_p, c) => {
      c.subEvents = false
      return true
    },
    'events.subscribeDeltas': (_p, c) => {
      c.subDeltas = true
      return true
    },
    'events.unsubscribeDeltas': (_p, c) => {
      c.subDeltas = false
      return true
    },
    'runtime.models': (p) => runtime.models(p),
    'runtime.loginProviders': () => runtime.loginProviders(),
    'runtime.logout': async (
      p: {
        provider: string
        logoutId?: number
        options?: { forget?: boolean }
      },
      client: ConnectedClient,
    ) => {
      const controller = new AbortController()
      if (typeof p.logoutId === 'number') {
        client.activeLogouts.set(p.logoutId, controller)
      }
      try {
        return await runtime.logout(p.provider, {
          ...p.options,
          signal: controller.signal,
        })
      } finally {
        if (typeof p.logoutId === 'number') {
          client.activeLogouts.delete(p.logoutId)
        }
      }
    },
    'runtime.recover': () => runtime.recover(),
    'auth.login': async (
      p: {
        loginId: number
        provider: string
        method: 'oauth' | 'api_key'
        options?: Omit<LoginOptions, 'getDeviceId'> & { deviceId?: string }
      },
      client: ConnectedClient,
    ) => {
      const controller = new AbortController()
      const prompts = new Map<
        number,
        {
          resolve: (value: string) => void
          reject: (err: Error) => void
          cleanup?: () => void
        }
      >()
      client.activeLogins.set(p.loginId, { controller, prompts })
      const interaction: AuthInteraction = {
        signal: controller.signal,
        notify: (event: AuthEvent) => {
          safeWrite(client.socket, {
            type: 'auth_event',
            loginId: p.loginId,
            event,
          })
        },
        prompt: (prompt: AuthPrompt) => {
          const promptId = nextPromptId++
          return new Promise<string>((resolve, reject) => {
            const { signal: promptSignal, ...wirePrompt } = prompt
            let settled = false
            const cleanup = () => {
              controller.signal.removeEventListener('abort', onLoginAbort)
              promptSignal?.removeEventListener('abort', onPromptAbort)
            }
            const settle = (err: Error | undefined, value?: string) => {
              if (settled) return
              settled = true
              prompts.delete(promptId)
              cleanup()
              if (err !== undefined) reject(err)
              else resolve(value ?? '')
            }
            const onLoginAbort = () => {
              settle(new DOMException('Login cancelled', 'AbortError'))
            }
            const onPromptAbort = () => {
              safeWrite(client.socket, {
                type: 'auth_prompt_cancel',
                loginId: p.loginId,
                promptId,
              })
              settle(new DOMException('Prompt cancelled', 'AbortError'))
            }
            if (controller.signal.aborted) {
              onLoginAbort()
              return
            }
            if (promptSignal?.aborted) {
              onPromptAbort()
              return
            }
            prompts.set(promptId, {
              resolve: (value) => settle(undefined, value),
              reject: (err) => settle(err),
              cleanup,
            })
            controller.signal.addEventListener('abort', onLoginAbort, {
              once: true,
            })
            promptSignal?.addEventListener('abort', onPromptAbort, {
              once: true,
            })
            safeWrite(client.socket, {
              type: 'auth_prompt',
              loginId: p.loginId,
              promptId,
              prompt: wirePrompt,
            })
          })
        },
      }
      const { deviceId, ...restOptions } = p.options ?? {}
      const resolvedLoginOptions: LoginOptions = {
        ...restOptions,
        ...(typeof deviceId === 'string' && deviceId.length > 0
          ? { getDeviceId: () => deviceId }
          : {}),
      }
      try {
        await runtime.login(
          p.provider,
          p.method,
          interaction,
          resolvedLoginOptions,
        )
        return { ok: true }
      } finally {
        for (const pending of [...prompts.values()]) {
          pending.reject(new DOMException('Login finished', 'AbortError'))
        }
        prompts.clear()
        client.activeLogins.delete(p.loginId)
      }
    },
  }

  const server = createServer((socket) => {
    const client: ConnectedClient = {
      socket,
      subEvents: false,
      subDeltas: false,
      activeLogins: new Map(),
      activeLogouts: new Map(),
    }
    clients.add(client)

    const parse = createNdjsonParser(
      (msg) => {
        if (msg.type === 'auth_prompt_reply') {
          const active = client.activeLogins.get(msg.loginId)
          const pending = active?.prompts.get(msg.promptId)
          if (!pending) return
          if (msg.error) pending.reject(new Error(msg.error))
          else pending.resolve(msg.value ?? '')
          return
        }
        if (msg.type === 'auth_cancel') {
          const active = client.activeLogins.get(msg.loginId)
          active?.controller.abort(new DOMException('Cancelled', 'AbortError'))
          return
        }
        if (msg.type === 'logout_cancel') {
          const ctrl = client.activeLogouts.get(msg.logoutId)
          ctrl?.abort(new DOMException('Logout cancelled', 'AbortError'))
          return
        }
        if (msg.type !== 'req') return
        const handler = handlers[msg.method]
        if (!handler) {
          safeWrite(socket, {
            type: 'res',
            id: msg.id,
            ok: false,
            error: { message: `Unknown daemon RPC method: ${msg.method}` },
          })
          return
        }
        Promise.resolve()
          .then(() => handler(msg.params, client))
          .then(
            (result) => {
              safeWrite(socket, { type: 'res', id: msg.id, ok: true, result })
            },
            (error) => {
              safeWrite(socket, {
                type: 'res',
                id: msg.id,
                ok: false,
                error: serializeError(error),
              })
            },
          )
      },
      (error, rawLine) => {
        if (rawLine) {
          try {
            const partial = JSON.parse(rawLine) as { id?: unknown }
            if (typeof partial.id === 'number') {
              safeWrite(socket, {
                type: 'res',
                id: partial.id,
                ok: false,
                error: serializeError(error),
              })
              return
            }
          } catch {}
        }
        logger.warn(
          `[daemon] Closing IPC client after frame error: ${error instanceof Error ? error.message : String(error)}`,
        )
        socket.destroy()
      },
    )

    socket.on('data', parse)
    socket.on('error', () => {})
    socket.on('close', () => {
      clients.delete(client)
      for (const active of client.activeLogins.values()) {
        active.controller.abort(
          new DOMException('Client disconnected', 'AbortError'),
        )
        for (const pending of [...active.prompts.values()]) {
          pending.reject(new Error('Client disconnected'))
        }
        active.prompts.clear()
      }
      client.activeLogins.clear()
      for (const ctrl of client.activeLogouts.values()) {
        ctrl.abort(new DOMException('Client disconnected', 'AbortError'))
      }
      client.activeLogouts.clear()
    })
  })

  try {
    await new Promise<void>((resolve, reject) => {
      const onErr = (err: Error) => reject(err)
      server.once('error', onErr)
      server.listen(paths.socketPath, () => {
        server.off('error', onErr)
        resolve()
      })
    })
  } catch (error) {
    unsubEvents()
    unsubDeltas()
    await runtime.dispose().catch(() => {})
    releaseOwner()
    throw error
  }

  if (process.platform !== 'win32') {
    chmodSync(paths.socketPath, 0o600)
  }

  const tmpPidPath = `${paths.pidPath}.${process.pid}.tmp`
  writeFileSync(tmpPidPath, `${JSON.stringify(hello, null, 2)}\n`, {
    mode: 0o600,
  })
  renameSync(tmpPidPath, paths.pidPath)

  const onSigHup = () => {
    void runtime.reloadConfig().catch((err) => {
      logger.warn(
        `[daemon] SIGHUP config reload failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
  }
  const onSigInt = () => {
    void close('SIGINT')
  }
  const onSigTerm = () => {
    void close('SIGTERM')
  }
  if (options.registerSignalHandlers !== false) {
    process.on('SIGHUP', onSigHup)
    process.on('SIGINT', onSigInt)
    process.on('SIGTERM', onSigTerm)
  }

  const close = (reason = 'dispose'): Promise<void> => {
    closing ??= (async () => {
      if (options.registerSignalHandlers !== false) {
        process.off('SIGHUP', onSigHup)
        process.off('SIGINT', onSigInt)
        process.off('SIGTERM', onSigTerm)
      }
      unsubEvents()
      unsubDeltas()
      for (const client of clients) {
        for (const active of client.activeLogins.values()) {
          active.controller.abort(
            new DOMException('Daemon closing', 'AbortError'),
          )
        }
        for (const ctrl of client.activeLogouts.values()) {
          ctrl.abort(new DOMException('Daemon closing', 'AbortError'))
        }
        client.socket.end()
        client.socket.destroy()
      }
      clients.clear()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      }).catch(() => {})
      try {
        const sessions = await runtime.sessions
          .list({ includeArchived: true })
          .catch(() => [])
        await Promise.all(
          sessions.map(async (session) => {
            const jobs = await runtime.jobs.list(session.id).catch(() => [])
            await Promise.all(
              jobs
                .filter((job) => job.snapshot.state === 'running')
                .map((job) =>
                  runtime.jobs
                    .stop(session.id, job.snapshot.id)
                    .catch(() => {}),
                ),
            )
          }),
        )
        await runtime.dispose()
      } finally {
        const pidInfo = readOwnerRecord(paths.pidPath)
        const stillOwnsFiles =
          !pidInfo?.instanceId || pidInfo.instanceId === instanceId
        if (stillOwnsFiles) {
          removeStaleSocketFile(paths.socketPath)
          rmSync(paths.pidPath, { force: true })
        }
        releaseOwner()
        options.onClosed?.(reason)
      }
    })()
    return closing
  }

  return {
    agentDir: paths.agentDir,
    socketPath: paths.socketPath,
    pidPath: paths.pidPath,
    startedAt,
    hello,
    runtime,
    close,
  }
}
