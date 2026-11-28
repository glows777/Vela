import { createConnection, type Socket } from 'node:net'
import { defaultAgentDir } from '../driver/config/paths.ts'
import type { AuthInteraction, LoginOptions } from '../providers/auth/types.ts'
import type {
  ChannelRuntimeEventListener,
  RuntimeEventListener,
  StreamDeltaListener,
} from '../runtime/index.ts'
import type { VelaRuntime } from '../runtime-sdk-types.ts'
import {
  type DaemonCommandOverride,
  ensureDaemonRunning,
  stripTransientDaemonEnv,
} from './launcher.ts'
import { assertSocketOwnership, resolveDaemonPaths } from './paths.ts'
import {
  createNdjsonParser,
  DAEMON_PROTOCOL_VERSION,
  type DaemonHello,
  type DaemonWireMessage,
  deserializeError,
  encodeWireLine,
} from './protocol.ts'

export interface ConnectRuntimeOptions {
  /** Root agent directory (`~/.vela`). Defaults to `VELA_DIR` / `~/.vela`. */
  agentDir?: string
  /** Explicit UNIX socket path or Windows named pipe override. */
  socketPath?: string
  /** Auto-start the daemon if not already running (default `true`). */
  autoStart?: boolean
  /** Environment variables forwarded when spawning the daemon on cold start. */
  hostEnv?: Record<string, string | undefined>
  /** Custom executable/script command used by packaged Electron (`ELECTRON_RUN_AS_NODE=1`) to spawn the daemon. */
  daemonCommand?: DaemonCommandOverride
  /** @internal Override expected appVersion for version-mismatch tests. */
  appVersion?: string
  /** @internal Override expected protocolVersion for handshake tests. */
  protocolVersion?: number
  /** @internal Hook invoked when the daemon IPC socket closes unexpectedly. */
  onDisconnect?: (error: Error) => void
  /** Timeout (ms) for auto-starting and handshaking with the daemon. */
  timeoutMs?: number
}

interface PendingRpc {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface ActiveClientLogin {
  interaction: AuthInteraction
  signal?: AbortSignal
  abortListener?: () => void
  prompts: Map<number, AbortController>
}

/**
 * Connects to the resident single-writer Vela daemon (`vela.sock` / named pipe),
 * starting or restarting it on demand, and returns a full `VelaRuntime` proxy.
 */
export async function connectRuntime(
  options: ConnectRuntimeOptions = {},
): Promise<VelaRuntime> {
  const hostEnv = options.hostEnv ?? process.env
  const agentDir = options.agentDir ?? defaultAgentDir(hostEnv)
  const paths = resolveDaemonPaths(agentDir, options.socketPath, hostEnv)
  const timeoutMs = options.timeoutMs ?? 15_000

  if (options.autoStart !== false) {
    await ensureDaemonRunning({
      agentDir: paths.agentDir,
      socketPath: paths.socketPath,
      hostEnv: stripTransientDaemonEnv(hostEnv),
      ...(options.daemonCommand
        ? { daemonCommand: options.daemonCommand }
        : {}),
      appVersion: options.appVersion,
      protocolVersion: options.protocolVersion,
      timeoutMs,
    })
  }

  const expectedProto = options.protocolVersion ?? DAEMON_PROTOCOL_VERSION
  const socket = await openSocket(paths.socketPath, timeoutMs)
  const { runtime, verifyHello } = createSocketRuntimeClient(
    paths.agentDir,
    socket,
    options.onDisconnect,
  )
  let helloTimer: ReturnType<typeof setTimeout> | undefined
  try {
    const hello = await Promise.race([
      verifyHello(),
      new Promise<never>((_resolve, reject) => {
        helloTimer = setTimeout(() => {
          reject(
            new Error(
              `Timed out waiting for Vela daemon handshake at ${paths.socketPath}`,
            ),
          )
        }, timeoutMs)
      }),
    ])
    if (hello.agentDir !== paths.agentDir) {
      throw new Error(
        `Socket ${paths.socketPath} belongs to ${hello.agentDir}, expected ${paths.agentDir}`,
      )
    }
    if (hello.protocolVersion !== expectedProto) {
      throw new Error(
        `Daemon protocol version mismatch at ${paths.socketPath}: expected ${expectedProto}, got ${hello.protocolVersion}`,
      )
    }
    if (
      options.appVersion !== undefined &&
      hello.appVersion !== options.appVersion
    ) {
      throw new Error(
        `Daemon app version mismatch at ${paths.socketPath}: expected ${options.appVersion}, got ${hello.appVersion}`,
      )
    }
    return runtime
  } catch (error) {
    await runtime.dispose().catch(() => {})
    throw error
  } finally {
    clearTimeout(helloTimer)
  }
}

async function openSocket(
  socketPath: string,
  timeoutMs: number,
): Promise<Socket> {
  assertSocketOwnership(socketPath)
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection(socketPath)
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error(`Timed out connecting to Vela daemon at ${socketPath}`))
    }, timeoutMs)
    const onErr = (err: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      reject(err)
    }
    socket.once('error', onErr)
    socket.once('connect', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.off('error', onErr)
      resolve(socket)
    })
  })
}

function createSocketRuntimeClient(
  agentDir: string,
  socket: Socket,
  onDisconnect?: (error: Error) => void,
): { runtime: VelaRuntime; verifyHello: () => Promise<DaemonHello> } {
  let nextReqId = 1
  let nextLoginId = 1
  let nextLogoutId = 1
  let nextSetupId = 1
  let closed = false
  const pending = new Map<number, PendingRpc>()
  const eventListeners = new Set<RuntimeEventListener>()
  const deltaListeners = new Set<StreamDeltaListener>()
  const channelListeners = new Set<ChannelRuntimeEventListener>()
  const activeLogins = new Map<number, ActiveClientLogin>()

  const writeMsg = (msg: DaemonWireMessage) => {
    if (closed || socket.destroyed || !socket.writable) {
      throw new Error('Daemon client connection is closed')
    }
    socket.write(encodeWireLine(msg))
  }

  const rpc = <T>(method: string, params?: unknown): Promise<T> => {
    if (closed) {
      return Promise.reject(
        new Error('Daemon runtime client has been disposed'),
      )
    }
    const id = nextReqId++
    return new Promise<T>((resolve, reject) => {
      pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      })
      try {
        writeMsg({ type: 'req', id, method, params })
      } catch (error) {
        pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  const failAll = (err: Error, unexpected = true) => {
    if (closed) return
    closed = true
    for (const p of pending.values()) p.reject(err)
    pending.clear()
    for (const login of activeLogins.values()) {
      if (login.abortListener && login.signal) {
        login.signal.removeEventListener('abort', login.abortListener)
      }
      for (const ctrl of login.prompts.values()) {
        ctrl.abort(err)
      }
      login.prompts.clear()
    }
    activeLogins.clear()
    eventListeners.clear()
    deltaListeners.clear()
    channelListeners.clear()
    if (unexpected) {
      try {
        onDisconnect?.(err)
      } catch {}
    }
  }

  const parse = createNdjsonParser(
    (msg) => {
      if (msg.type === 'res') {
        const entry = pending.get(msg.id)
        if (!entry) return
        pending.delete(msg.id)
        if (msg.ok) entry.resolve(msg.result)
        else entry.reject(deserializeError(msg.error))
        return
      }
      if (msg.type === 'event') {
        for (const listener of [...eventListeners]) {
          try {
            listener(msg.event)
          } catch {}
        }
        return
      }
      if (msg.type === 'delta') {
        for (const listener of [...deltaListeners]) {
          try {
            listener(msg.delta)
          } catch {}
        }
        return
      }
      if (msg.type === 'channel_event') {
        for (const listener of [...channelListeners]) {
          try {
            listener(msg.event)
          } catch {}
        }
        return
      }
      if (msg.type === 'auth_event') {
        const login = activeLogins.get(msg.loginId)
        try {
          login?.interaction.notify(msg.event)
        } catch {}
        return
      }
      if (msg.type === 'auth_prompt_cancel') {
        const login = activeLogins.get(msg.loginId)
        const promptCtrl = login?.prompts.get(msg.promptId)
        if (promptCtrl) {
          login?.prompts.delete(msg.promptId)
          promptCtrl.abort(new DOMException('Prompt cancelled', 'AbortError'))
        }
        return
      }
      if (msg.type === 'auth_prompt') {
        const login = activeLogins.get(msg.loginId)
        if (!login) return
        const promptCtrl = new AbortController()
        const onLoginAbort = () =>
          promptCtrl.abort(new DOMException('Login cancelled', 'AbortError'))
        if (login.signal?.aborted) onLoginAbort()
        else
          login.signal?.addEventListener('abort', onLoginAbort, { once: true })
        login.prompts.set(msg.promptId, promptCtrl)
        Promise.resolve()
          .then(() =>
            login.interaction.prompt({
              ...msg.prompt,
              signal: promptCtrl.signal,
            }),
          )
          .then(
            (value) => {
              try {
                writeMsg({
                  type: 'auth_prompt_reply',
                  loginId: msg.loginId,
                  promptId: msg.promptId,
                  value,
                })
              } catch {}
            },
            (err) => {
              try {
                writeMsg({
                  type: 'auth_prompt_reply',
                  loginId: msg.loginId,
                  promptId: msg.promptId,
                  error: err instanceof Error ? err.message : String(err),
                })
              } catch {}
            },
          )
          .finally(() => {
            login.prompts.delete(msg.promptId)
            login.signal?.removeEventListener('abort', onLoginAbort)
          })
      }
    },
    (err) => {
      failAll(
        err instanceof Error
          ? err
          : new Error(`Daemon IPC parse error: ${err}`),
      )
      socket.destroy()
    },
  )

  socket.on('data', parse)
  socket.on('error', (err) => failAll(err))
  socket.on('close', () =>
    failAll(new Error('Disconnected from Vela daemon socket')),
  )

  const runtime: VelaRuntime = {
    agentDir,
    ready: () => rpc('runtime.ready'),
    extensionErrors: () => rpc('runtime.extensionErrors'),
    reloadConfig: () => rpc('runtime.reloadConfig'),
    projects: {
      list: (opts) => rpc('projects.list', opts),
      get: (id) => rpc('projects.get', { id }),
      getByCwd: (cwd) => rpc('projects.getByCwd', { cwd }),
      create: (input) => rpc('projects.create', input),
      update: (id, patch) => rpc('projects.update', { id, patch }),
      remove: (id, opts) => rpc('projects.remove', { id, options: opts }),
    },
    trust: {
      check: (location) => rpc('trust.check', { location }),
      approve: (location, trusted) =>
        rpc('trust.approve', { location, trusted }),
    },
    oauthRegistrations: {
      get: (provider) => rpc('oauthRegistrations.get', { provider }),
      set: (provider, registration) =>
        rpc('oauthRegistrations.set', { provider, registration }),
      delete: (provider) => rpc('oauthRegistrations.delete', { provider }),
    },
    sessions: {
      list: (opts) => rpc('sessions.list', opts),
      listSummaries: (opts) => rpc('sessions.listSummaries', opts),
      get: (id) => rpc('sessions.get', { id }),
      create: (input) => rpc('sessions.create', input),
      rename: (id, name) => rpc('sessions.rename', { id, name }),
      delete: (id) => rpc('sessions.delete', { id }),
      reset: (id) => rpc('sessions.reset', { id }),
      status: (id) => rpc('sessions.status', { id }),
      messages: (input) => rpc('sessions.messages', input),
      configure: (sessionId, override) =>
        rpc('sessions.configure', { sessionId, override }),
      setModel: (sessionId, modelRef) =>
        rpc('sessions.setModel', { sessionId, modelRef }),
      setThinkingLevel: (sessionId, level) =>
        rpc('sessions.setThinkingLevel', { sessionId, level }),
      compact: (sessionId, instructions) =>
        rpc('sessions.compact', { sessionId, instructions }),
      tree: (sessionId) => rpc('sessions.tree', { sessionId }),
      navigateTree: (sessionId, targetId, opts) =>
        rpc('sessions.navigateTree', { sessionId, targetId, options: opts }),
      setLabel: (sessionId, entryId, label) =>
        rpc('sessions.setLabel', { sessionId, entryId, label }),
      fork: (sessionId, entryId, opts) =>
        rpc('sessions.fork', { sessionId, entryId, options: opts }),
      clone: (sessionId, opts) =>
        rpc('sessions.clone', { sessionId, options: opts }),
      inspect: (sessionId, opts) =>
        rpc('sessions.inspect', { sessionId, options: opts }),
      execBash: (sessionId, command, opts) =>
        rpc('sessions.execBash', { sessionId, command, options: opts }),
      abortBash: (sessionId) => rpc('sessions.abortBash', { sessionId }),
      runCommand: (sessionId, input) =>
        rpc('sessions.runCommand', { sessionId, input }),
      clearQueue: (sessionId) => rpc('sessions.clearQueue', { sessionId }),
      export: (sessionId, format, outputPath, baseCwd) =>
        rpc('sessions.export', { sessionId, format, outputPath, baseCwd }),
    },
    prompt: (sessionId, input) => rpc('runtime.prompt', { sessionId, input }),
    steer: (sessionId, text, images) =>
      rpc('runtime.steer', { sessionId, text, images }),
    stop: (sessionId, reason, options) =>
      rpc('runtime.stop', { sessionId, reason, options }),
    waitForIdle: (sessionId) =>
      rpc('runtime.waitForIdle', sessionId ? { sessionId } : undefined),
    jobs: {
      list: (sessionId) =>
        rpc('jobs.list', sessionId ? { sessionId } : undefined),
      stop: (sessionId, jobId) => rpc('jobs.stop', { sessionId, jobId }),
      promoteForeground: (sessionId, toolCallId) =>
        rpc('jobs.promoteForeground', { sessionId, toolCallId }),
    },
    approvals: {
      list: (sessionId) =>
        rpc('approvals.list', sessionId ? { sessionId } : undefined),
      resolve: (input) => rpc('approvals.resolve', input),
    },
    timers: {
      list: (filter) => rpc('timers.list', filter),
      createRoutine: (input) => rpc('timers.createRoutine', input),
      createFollowup: (input) => rpc('timers.createFollowup', input),
      update: (id, patch) => rpc('timers.update', { id, patch }),
      delete: (id, filter) => rpc('timers.delete', { id, filter }),
    },
    subscriptions: {
      list: (filter) => rpc('subscriptions.list', filter),
      create: (input) => rpc('subscriptions.create', input),
      remove: (id) => rpc('subscriptions.remove', { id }),
    },
    bindings: {
      list: (filter) => rpc('bindings.list', filter),
      get: (id) => rpc('bindings.get', { id }),
      upsert: (input) => rpc('bindings.upsert', input),
      setEnabled: (id, enabled) => rpc('bindings.setEnabled', { id, enabled }),
      remove: (id) => rpc('bindings.remove', { id }),
    },
    channels: {
      list: () => rpc('channels.list'),
      setEnabled: (name, enabled) =>
        rpc('channels.setEnabled', { name, enabled }),
      chats: (channel) => rpc('channels.chats', { channel }),
      submit: (channel, input) => rpc('channels.submit', { channel, input }),
      subscribe: (listener) => {
        const wasEmpty = channelListeners.size === 0
        channelListeners.add(listener)
        if (wasEmpty && !closed) {
          void rpc('channels.subscribe').catch(() => {})
        }
        return () => {
          channelListeners.delete(listener)
          if (channelListeners.size === 0 && !closed) {
            void rpc('channels.unsubscribe').catch(() => {})
          }
        }
      },
    },
    settings: {
      get: () => rpc('settings.get'),
      saveModel: (input) => rpc('settings.saveModel', { input }),
      saveLark: (input) => rpc('settings.saveLark', { input }),
      discoverLarkGroup: async (opts) => {
        const signal = opts?.signal
        if (signal?.aborted) return undefined
        const setupId = nextSetupId++
        let abortListener: (() => void) | undefined
        const rpcPromise = rpc<
          Awaited<ReturnType<VelaRuntime['settings']['discoverLarkGroup']>>
        >('settings.discoverLarkGroup', { setupId })
        if (!signal) return rpcPromise
        return new Promise<
          Awaited<ReturnType<VelaRuntime['settings']['discoverLarkGroup']>>
        >((resolve, reject) => {
          let settled = false
          abortListener = () => {
            try {
              writeMsg({ type: 'discovery_cancel', setupId })
            } catch {}
          }
          signal.addEventListener('abort', abortListener, { once: true })
          rpcPromise.then(
            (res) => {
              if (settled) return
              settled = true
              resolve(signal.aborted ? undefined : res)
            },
            (err) => {
              if (settled) return
              settled = true
              if (signal.aborted) {
                resolve(undefined)
                return
              }
              reject(err)
            },
          )
        }).finally(() => {
          if (abortListener) {
            signal.removeEventListener('abort', abortListener)
          }
        })
      },
      confirmLarkGroup: (chatId) =>
        rpc('settings.confirmLarkGroup', { chatId }),
      cancelLarkSetup: () => rpc('settings.cancelLarkSetup'),
    },
    blobs: {
      get: (id) => rpc('blobs.get', { id }),
      list: (sessionId, direction) =>
        rpc('blobs.list', { sessionId, direction }),
      read: (id) => rpc('blobs.read', { id }),
      storeInbound: (input) => rpc('blobs.storeInbound', input),
    },
    events: {
      list: (opts) => rpc('events.list', opts),
      bufferedDeltas: (sessionId) =>
        rpc('events.bufferedDeltas', { sessionId }),
      subscribe: (listener) => {
        const wasEmpty = eventListeners.size === 0
        eventListeners.add(listener)
        if (wasEmpty && !closed) {
          void rpc('events.subscribe').catch(() => {})
        }
        return () => {
          eventListeners.delete(listener)
          if (eventListeners.size === 0 && !closed) {
            void rpc('events.unsubscribe').catch(() => {})
          }
        }
      },
      subscribeDeltas: (listener) => {
        const wasEmpty = deltaListeners.size === 0
        deltaListeners.add(listener)
        if (wasEmpty && !closed) {
          void rpc('events.subscribeDeltas').catch(() => {})
        }
        return () => {
          deltaListeners.delete(listener)
          if (deltaListeners.size === 0 && !closed) {
            void rpc('events.unsubscribeDeltas').catch(() => {})
          }
        }
      },
    },
    models: (opts) => rpc('runtime.models', opts),
    loginProviders: () => rpc('runtime.loginProviders'),
    login: async (
      provider,
      method,
      interaction,
      loginOptions?: LoginOptions,
    ) => {
      const signal = interaction.signal
      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException('Login cancelled', 'AbortError')
      }
      const loginId = nextLoginId++
      const abortListener = () => {
        try {
          writeMsg({ type: 'auth_cancel', loginId })
        } catch {}
      }
      activeLogins.set(loginId, {
        interaction,
        signal,
        abortListener,
        prompts: new Map(),
      })
      signal.addEventListener('abort', abortListener, { once: true })
      const { getDeviceId, ...restLoginOptions } = loginOptions ?? {}
      const deviceId = getDeviceId?.()
      try {
        await rpc('auth.login', {
          loginId,
          provider,
          method,
          options: {
            ...restLoginOptions,
            ...(deviceId ? { deviceId } : {}),
          },
        })
      } finally {
        signal.removeEventListener('abort', abortListener)
        for (const ctrl of activeLogins.get(loginId)?.prompts.values() ?? []) {
          ctrl.abort(new DOMException('Login finished', 'AbortError'))
        }
        activeLogins.delete(loginId)
      }
    },
    logout: async (provider, logoutOptions) => {
      const { signal, ...restOpts } = logoutOptions ?? {}
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException('Logout cancelled', 'AbortError')
      }
      const logoutId = nextLogoutId++
      let abortListener: (() => void) | undefined
      const rpcPromise = rpc<Awaited<ReturnType<VelaRuntime['logout']>>>(
        'runtime.logout',
        { provider, logoutId, options: restOpts },
      )
      if (!signal) return rpcPromise
      return new Promise<Awaited<ReturnType<VelaRuntime['logout']>>>(
        (resolve, reject) => {
          let settled = false
          abortListener = () => {
            try {
              writeMsg({ type: 'logout_cancel', logoutId })
            } catch {}
            if (settled) return
            settled = true
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new DOMException('Logout cancelled', 'AbortError'),
            )
          }
          signal.addEventListener('abort', abortListener, { once: true })
          rpcPromise.then(
            (res) => {
              if (settled) return
              settled = true
              resolve(res)
            },
            (err) => {
              if (settled) return
              settled = true
              reject(err)
            },
          )
        },
      ).finally(() => {
        if (abortListener) {
          signal.removeEventListener('abort', abortListener)
        }
      })
    },
    recover: () => rpc('runtime.recover'),
    dispose: async () => {
      failAll(new Error('Daemon client disposed'), false)
      socket.end()
      socket.destroy()
    },
  }
  return {
    runtime,
    verifyHello: () => rpc<DaemonHello>('daemon.hello'),
  }
}
