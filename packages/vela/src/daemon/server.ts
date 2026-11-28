import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { defaultAgentDir } from '../driver/config/paths.ts'
import type { LarkTransport } from '../lark/transport.ts'
import { createRuntime, type LocalVelaRuntime } from '../runtime-sdk.ts'
import type { DocsPaths } from '../shared/docs-paths.ts'
import { silentLogger, type VelaLogger } from '../shared/logger.ts'
import type { ModelInput } from '../shared/provider-types.ts'
import { registerBuiltinExtensionHostModules } from './extension-host.ts'
import { DaemonLarkHost } from './lark-host.ts'
import {
  acquireOwnerLock,
  DaemonAlreadyRunningError,
  readOwnerRecord,
} from './owner-lock.ts'
import {
  assertSocketOrMissing,
  daemonOwnerLockPath,
  ensurePrivateSocketDir,
  removeStaleSocketFile,
  resolveDaemonPaths,
} from './paths.ts'
import {
  createNdjsonParser,
  DAEMON_PROTOCOL_VERSION,
  type DaemonHello,
  getAppVersion,
  probeSocketAlive,
  safeWriteWire,
  serializeError,
} from './protocol.ts'
import {
  type ConnectedClient,
  createDaemonHandlers,
} from './server-handlers.ts'
import { resolveSettingsOwnerHooks } from './settings-discovery.ts'
import {
  DaemonWebhooksHost,
  startDaemonConfigWatcher,
} from './webhooks-host.ts'

export { DaemonAlreadyRunningError }

export interface StartDaemonServerOptions {
  agentDir?: string
  socketPath?: string
  hostEnv?: Record<string, string | undefined>
  logger?: VelaLogger
  appVersion?: string
  protocolVersion?: number
  registerSignalHandlers?: boolean
  enableWebhooks?: boolean
  enableLark?: boolean
  defaultModel?: ModelInput
  docs?: DocsPaths | false
  larkTransport?: LarkTransport
  onCreateLarkTransport?: (info: {
    appId?: string
    appSecret?: string
  }) => LarkTransport | undefined
  onCreateLarkDiscoveryTransport?: () => Promise<LarkTransport | undefined>
  onVerifyLarkCredentials?: (appId: string, appSecret: string) => Promise<void>
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

const safeWrite = safeWriteWire
const MAX_PRECANCEL_ENTRIES = 256

function addBounded(set: Set<number>, value: number): void {
  if (set.size >= MAX_PRECANCEL_ENTRIES) {
    const oldest = set.values().next().value
    if (oldest !== undefined) set.delete(oldest)
  }
  set.add(value)
}

function readConfigStatSig(agentDir: string): string {
  try {
    const st = statSync(join(agentDir, 'config.json'))
    return `${st.ino}:${st.mtimeMs}:${st.size}`
  } catch {
    return 'missing'
  }
}

/**
 * Starts the single-writer local daemon holding `createRuntime()` and listening
 * on `<agentDir>/vela.sock` (or fallback socket / Windows named pipe).
 */
export async function startDaemonServer(
  options: StartDaemonServerOptions = {},
): Promise<DaemonServerHandle> {
  registerBuiltinExtensionHostModules({ startDaemonServer })
  const hostEnv = options.hostEnv ?? {}
  const logger = options.logger ?? silentLogger
  const rawAgentDir = options.agentDir ?? defaultAgentDir(hostEnv)
  const paths = resolveDaemonPaths(rawAgentDir, options.socketPath, hostEnv)

  mkdirSync(paths.agentDir, { recursive: true, mode: 0o700 })
  assertSocketOrMissing(paths.socketPath)
  const instanceId = randomUUID()
  const ownerLockPath = daemonOwnerLockPath(paths.agentDir)
  const releaseOwner = acquireOwnerLock(
    ownerLockPath,
    instanceId,
    paths.socketPath,
  )

  let runtime: LocalVelaRuntime
  let webhooksHost: DaemonWebhooksHost | undefined
  let larkHost: DaemonLarkHost | undefined
  let initialConfigSig = 'missing'
  try {
    if (process.platform !== 'win32') {
      ensurePrivateSocketDir(paths.socketPath)
      if (await probeSocketAlive(paths.socketPath)) {
        throw new DaemonAlreadyRunningError(paths.socketPath)
      }
      removeStaleSocketFile(paths.socketPath)
    }

    if (options.enableWebhooks !== false) {
      webhooksHost = new DaemonWebhooksHost(
        (event, defaultTarget) =>
          runtime.ingestWebhookEvent(event, defaultTarget),
        logger,
      )
    }

    initialConfigSig = readConfigStatSig(paths.agentDir)
    runtime = createRuntime({
      agentDir: paths.agentDir,
      hostEnv,
      ...(options.defaultModel ? { defaultModel: options.defaultModel } : {}),
      ...(options.docs !== undefined ? { docs: options.docs } : {}),
      logger,
      onConfigReloaded: webhooksHost
        ? (cfg) => webhooksHost!.sync(cfg, true)
        : undefined,
      onLarkConfigReloaded:
        options.enableLark !== false
          ? (cfg) => larkHost?.sync(cfg, false)
          : undefined,
      onChannelEnabledChange:
        options.enableLark !== false
          ? (name, enabled) =>
              name === 'lark' ? larkHost?.onEnabledChanged(enabled) : undefined
          : undefined,
      getKnownChannelInfo: () => larkHost?.knownChannelInfo() ?? {},
      isLarkLoaded: () =>
        Boolean(larkHost?.isConfigured() && !larkHost.configError()),
      getLarkConfigError: () => larkHost?.configError(),
      onPauseLarkForDiscovery: () =>
        larkHost?.pauseForDiscovery() ?? Promise.resolve(),
      onResumeLarkFromDiscovery: () =>
        larkHost?.resumeFromDiscovery() ?? Promise.resolve(),
      onCreateLarkDiscoveryTransport: options.onCreateLarkDiscoveryTransport,
      onVerifyLarkCredentials: options.onVerifyLarkCredentials,
    })
    if (options.enableLark !== false) {
      larkHost = new DaemonLarkHost(runtime, {
        agentDir: paths.agentDir,
        hostEnv,
        logger,
        transport: options.larkTransport,
        createTransport: options.onCreateLarkTransport,
      })
    }
  } catch (error) {
    await larkHost?.stop().catch(() => {})
    await webhooksHost?.stop().catch(() => {})
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
  const sessionOverrideOwners = new Map<string, ConnectedClient>()
  let nextPromptId = 1
  let closing: Promise<void> | undefined
  let signalHandlersAttached = false
  let configWatcher: ReturnType<typeof startDaemonConfigWatcher> | undefined

  const onSigHup = () => {
    if (closing) return
    void runtime.reloadConfig().catch((err) => {
      logger.warn(
        `[daemon] SIGHUP config reload failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
  }
  const onSigInt = () => {
    if (closing) return
    void close('SIGINT')
  }
  const onSigTerm = () => {
    if (closing) return
    void close('SIGTERM')
  }

  const close = (reason = 'dispose'): Promise<void> => {
    closing ??= (async () => {
      configWatcher?.stop()
      unsubEvents()
      unsubDeltas()
      unsubChannels()
      const snapshotClients = [...clients]
      for (const client of snapshotClients) {
        client.disconnected = true
        for (const active of client.activeLogins.values()) {
          active.controller.abort(
            new DOMException('Daemon closing', 'AbortError'),
          )
        }
        for (const ctrl of client.activeLogouts.values()) {
          ctrl.abort(new DOMException('Daemon closing', 'AbortError'))
        }
        for (const ctrl of client.activeDiscoveries.values()) {
          ctrl.abort(new DOMException('Daemon closing', 'AbortError'))
        }
      }
      await Promise.all(
        snapshotClients.map(
          (client) =>
            new Promise<void>((resolve) => {
              if (client.socket.destroyed || !client.socket.writable) {
                client.socket.destroy()
                resolve()
                return
              }
              const timer = setTimeout(() => {
                client.socket.destroy()
                resolve()
              }, 50)
              client.socket.end(() => {
                clearTimeout(timer)
                client.socket.destroy()
                resolve()
              })
            }),
        ),
      )
      clients.clear()
      sessionOverrideOwners.clear()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      }).catch(() => {})
      try {
        await larkHost?.stop().catch(() => {})
        await webhooksHost?.stop().catch(() => {})
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
        if (signalHandlersAttached) {
          signalHandlersAttached = false
          process.off('SIGHUP', onSigHup)
          process.off('SIGINT', onSigInt)
          process.off('SIGTERM', onSigTerm)
        }
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
  const unsubChannels = runtime.channels.subscribe((event) => {
    for (const c of clients) {
      if (c.subChannels) safeWrite(c.socket, { type: 'channel_event', event })
    }
  })

  const handlers = createDaemonHandlers({
    runtime,
    hello,
    startedAtMs,
    webhooksHost,
    getConfigWatcher: () => configWatcher,
    requestClose: (reason) => void close(reason),
    nextPromptId: () => nextPromptId++,
    sessionOverrideOwners,
  })

  const server = createServer((socket) => {
    const client: ConnectedClient = {
      socket,
      disconnected: false,
      subEvents: false,
      subDeltas: false,
      subChannels: false,
      configuredSessions: new Set(),
      activeLogins: new Map(),
      activeLogouts: new Map(),
      activeDiscoveries: new Map(),
      preCancelledLogins: new Set(),
      preCancelledLogouts: new Set(),
      preCancelledDiscoveries: new Set(),
      isDisconnected: () => client.disconnected || socket.destroyed,
    }
    clients.add(client)

    const parse = createNdjsonParser(
      (msg) => {
        if (client.isDisconnected() || !clients.has(client)) return
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
          if (active) {
            active.controller.abort(new DOMException('Cancelled', 'AbortError'))
          } else {
            addBounded(client.preCancelledLogins, msg.loginId)
          }
          return
        }
        if (msg.type === 'logout_cancel') {
          const ctrl = client.activeLogouts.get(msg.logoutId)
          if (ctrl) {
            ctrl.abort(new DOMException('Logout cancelled', 'AbortError'))
          } else {
            addBounded(client.preCancelledLogouts, msg.logoutId)
          }
          return
        }
        if (msg.type === 'discovery_cancel') {
          const ctrl = client.activeDiscoveries.get(msg.setupId)
          if (ctrl) {
            ctrl.abort(new DOMException('Cancelled', 'AbortError'))
          } else {
            addBounded(client.preCancelledDiscoveries, msg.setupId)
          }
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
          .then(() => {
            if (client.isDisconnected() || !clients.has(client)) {
              throw new DOMException('Client disconnected', 'AbortError')
            }
            return handler(msg.params, client)
          })
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
        return false
      },
    )

    socket.on('data', parse)
    socket.on('error', () => {})
    socket.on('close', () => {
      client.disconnected = true
      clients.delete(client)
      for (const sid of [...client.configuredSessions]) {
        if (sessionOverrideOwners.get(sid) === client) {
          sessionOverrideOwners.delete(sid)
          void runtime.sessions.configure(sid, {}).catch(() => {})
        }
      }
      client.configuredSessions.clear()
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
      for (const ctrl of client.activeDiscoveries.values()) {
        ctrl.abort(new DOMException('Client disconnected', 'AbortError'))
      }
      client.activeDiscoveries.clear()
      void resolveSettingsOwnerHooks(runtime).then((hooks) =>
        hooks?.clearOwner(client),
      )
    })
  })

  const tmpPidPath = `${paths.pidPath}.${process.pid}.tmp`
  try {
    await new Promise<void>((resolve, reject) => {
      const onErr = (err: Error) => reject(err)
      server.once('error', onErr)
      const prevUmask =
        process.platform !== 'win32' ? process.umask(0o177) : undefined
      try {
        server.listen(paths.socketPath, () => {
          server.off('error', onErr)
          resolve()
        })
      } finally {
        if (prevUmask !== undefined) process.umask(prevUmask)
      }
    })
    if (process.platform !== 'win32') {
      chmodSync(paths.socketPath, 0o600)
    }
    writeFileSync(tmpPidPath, `${JSON.stringify(hello, null, 2)}\n`, {
      mode: 0o600,
    })
    renameSync(tmpPidPath, paths.pidPath)
  } catch (error) {
    rmSync(tmpPidPath, { force: true })
    unsubEvents()
    unsubDeltas()
    unsubChannels()
    await larkHost?.stop().catch(() => {})
    await webhooksHost?.stop().catch(() => {})
    await runtime.dispose().catch(() => {})
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    }).catch(() => {})
    const pidInfo = readOwnerRecord(paths.pidPath)
    if (!pidInfo?.instanceId || pidInfo.instanceId === instanceId) {
      removeStaleSocketFile(paths.socketPath)
      rmSync(paths.pidPath, { force: true })
    }
    releaseOwner()
    throw error
  }

  // Start Lark synchronization after the IPC socket is already accepting CLI clients,
  // while gating crash recovery & default-target webhooks until Lark readiness settles (up to 5s).
  let larkInitTimer: ReturnType<typeof setTimeout> | undefined
  const larkInitPromise = larkHost
    ? larkHost.sync(runtime.getLarkConfig(), false).catch((error) => {
        logger.warn(
          `[daemon] Initial Lark sync failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    : Promise.resolve()
  try {
    if (larkHost) {
      await Promise.race([
        larkInitPromise,
        new Promise<void>((resolve) => {
          larkInitTimer = setTimeout(resolve, 5_000)
          larkInitTimer.unref()
        }),
      ])
    }
    if (!closing) {
      await runtime.recover()
      if (webhooksHost && !closing) {
        await webhooksHost.sync(runtime.getWebhookConfig(), false)
      }
    }
  } catch (error) {
    clearTimeout(larkInitTimer)
    if (closing) {
      await closing
      throw error
    }
    unsubEvents()
    unsubDeltas()
    unsubChannels()
    await larkHost?.stop().catch(() => {})
    await webhooksHost?.stop().catch(() => {})
    await runtime.dispose().catch(() => {})
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    }).catch(() => {})
    const pidInfo = readOwnerRecord(paths.pidPath)
    if (!pidInfo?.instanceId || pidInfo.instanceId === instanceId) {
      removeStaleSocketFile(paths.socketPath)
      rmSync(paths.pidPath, { force: true })
    }
    releaseOwner()
    throw error
  } finally {
    clearTimeout(larkInitTimer)
  }

  if (!closing) {
    configWatcher = startDaemonConfigWatcher(
      paths.agentDir,
      () => runtime.reloadConfig(),
      undefined,
      (err) => {
        logger.warn(
          `[daemon] Automatic config reload failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      },
      initialConfigSig,
    )

    if (options.registerSignalHandlers !== false) {
      signalHandlersAttached = true
      process.on('SIGHUP', onSigHup)
      process.on('SIGINT', onSigInt)
      process.on('SIGTERM', onSigTerm)
    }
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
