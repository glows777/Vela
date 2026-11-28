import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  connectRuntime,
  getDaemonStatus,
  stopDaemon,
  type VelaRuntime,
} from '@glows777/vela'
import { app, BrowserWindow, dialog } from 'electron'
import type { Event, Request } from '../shared/bridge.ts'

export { isDisconnectError } from './disconnect-error.ts'

export const MUTATING_REQUEST_METHODS = new Set<Request['method']>([
  'submit',
  'createSession',
  'renameSession',
  'deleteSession',
  'openProject',
  'removeProject',
  'saveModel',
  'saveLark',
  'confirmLarkGroup',
  'createRoutine',
  'editRoutine',
  'cancelRoutine',
])

function resolveDaemonEntry(): string {
  const mainDir = dirname(fileURLToPath(import.meta.url))
  const unpackedDir = mainDir.replace(
    /app\.asar(?=[\\/]|$)/,
    'app.asar.unpacked',
  )
  const unpackedCandidate = join(unpackedDir, 'daemon.mjs')
  if (existsSync(unpackedCandidate)) return unpackedCandidate
  return join(mainDir, 'daemon.mjs')
}

function buildDaemonEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ELECTRON_RUN_AS_NODE: '1',
  }
  const modelEnv = process.env.VELA_MODEL?.trim()
  if (modelEnv === 'mock' || modelEnv?.startsWith('faux:')) {
    env.VELA_MODEL = modelEnv
  }
  if (process.env.VELA_DESKTOP_LARK) {
    env.VELA_DESKTOP_LARK = process.env.VELA_DESKTOP_LARK
  }
  if (process.env.VELA_DESKTOP_LARK_DIR) {
    env.VELA_DESKTOP_LARK_DIR = process.env.VELA_DESKTOP_LARK_DIR
  }
  if (process.env.VELA_DESKTOP_VERIFY_DISCOVERY_TIMEOUT) {
    env.VELA_DESKTOP_VERIFY_DISCOVERY_TIMEOUT =
      process.env.VELA_DESKTOP_VERIFY_DISCOVERY_TIMEOUT
  }
  if (process.env.VELA_DIR) {
    env.VELA_DIR = process.env.VELA_DIR
  }
  return env
}

export function safeUserDataDir(agentDir: string): string {
  try {
    return app.getPath('userData')
  } catch {
    return agentDir
  }
}

export interface ManagedDaemonClient {
  runtime(): VelaRuntime
  readonly agentDir: string
  readonly disconnected: boolean
  reconnect(options?: { force?: boolean }): Promise<VelaRuntime>
  setSubscriptionBinder(binder: (rt: VelaRuntime) => () => void): void
  dispose(): Promise<void>
  confirmAndStopBeforeQuit(stopDaemonOnQuit: boolean): Promise<boolean>
}

export async function createManagedDaemonClient(
  publish: (event: Event) => void,
  onClearCaches: () => void,
): Promise<ManagedDaemonClient> {
  const daemonEntry = resolveDaemonEntry()
  let disconnected = false
  let disposed = false
  let stoppingForQuit = false
  let reconnecting: Promise<VelaRuntime> | undefined
  let unsubBinder: (() => void) | undefined
  let bindSubscriptions: ((rt: VelaRuntime) => () => void) | undefined

  const connectOnce = async (): Promise<VelaRuntime> => {
    const next = await connectRuntime({
      hostEnv: process.env,
      daemonCommand: {
        command: process.execPath,
        args: [daemonEntry],
        env: buildDaemonEnv(),
      },
      onDisconnect: () => {
        if (disposed || disconnected) return
        disconnected = true
        if (stoppingForQuit) return
        publish({
          type: 'channel',
          channel: 'local',
          value: {
            type: 'channel_status',
            connected: false,
            error: 'Background service disconnected. Reconnecting…',
          },
        })
        void reconnect().catch(() => {})
      },
    })
    await next.ready()
    return next
  }

  let current = await connectOnce()
  const resolvedAgentDir =
    current.agentDir ?? (await current.settings.get()).folder

  const attach = (rt: VelaRuntime) => {
    unsubBinder?.()
    unsubBinder = undefined
    if (bindSubscriptions) {
      unsubBinder = bindSubscriptions(rt)
    }
  }

  const reconnect = (options?: { force?: boolean }): Promise<VelaRuntime> => {
    if (disposed || stoppingForQuit) {
      return Promise.reject(new Error('Desktop host is disposed'))
    }
    if (!options?.force && !disconnected) return Promise.resolve(current)
    reconnecting ??= (async () => {
      const delays = [0, 300, 800, 1500]
      let lastError: unknown
      for (const delay of delays) {
        if (disposed || stoppingForQuit) {
          throw new Error('Desktop host is disposed')
        }
        if (delay > 0) await new Promise((r) => setTimeout(r, delay))
        if (disposed || stoppingForQuit) {
          throw new Error('Desktop host is disposed')
        }
        try {
          const next = await connectOnce()
          if (disposed || stoppingForQuit) {
            await next.dispose().catch(() => {})
            throw new Error('Desktop host is disposed')
          }
          const prev = current
          current = next
          disconnected = false
          onClearCaches()
          attach(next)
          await prev.dispose().catch(() => {})
          publish({
            type: 'channel',
            channel: 'local',
            value: { type: 'channel_status', connected: true, reset: true },
          })
          return next
        } catch (error) {
          lastError = error
        }
      }
      if (!disposed && !stoppingForQuit) {
        publish({
          type: 'channel',
          channel: 'local',
          value: {
            type: 'channel_status',
            connected: false,
            error: 'Background service disconnected.',
          },
        })
      }
      throw lastError instanceof Error
        ? lastError
        : new Error(String(lastError))
    })().finally(() => {
      reconnecting = undefined
    })
    return reconnecting
  }

  const dispose = async () => {
    if (disposed) return
    disposed = true
    unsubBinder?.()
    unsubBinder = undefined
    await current.dispose().catch(() => {})
  }

  const confirmAndStopBeforeQuit = async (
    stopDaemonOnQuit: boolean,
  ): Promise<boolean> => {
    if (!stopDaemonOnQuit) {
      await dispose()
      return true
    }
    let stateKnown = false
    let hasActiveWork = false
    if (!disconnected) {
      try {
        const activeSessions = await current.sessions.list({
          includeArchived: false,
        })
        for (const s of activeSessions) {
          const st = await current.sessions.status(s.id)
          if (st.activeRunId || st.runningJobs > 0 || s.state === 'running') {
            hasActiveWork = true
            break
          }
        }
        stateKnown = true
      } catch {
        stateKnown = false
      }
    }

    const owner =
      BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const showBox = (options: Electron.MessageBoxOptions) =>
      owner
        ? dialog.showMessageBox(owner, options)
        : dialog.showMessageBox(options)

    if (!stateKnown) {
      const status = await getDaemonStatus({
        agentDir: resolvedAgentDir,
        hostEnv: process.env,
      }).catch(() => ({ running: true }))
      if (!status.running) {
        await dispose()
        return true
      }
      const choice = await showBox({
        type: 'warning',
        buttons: ['Stop and quit', 'Leave running and quit', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        message: 'Could not check whether background work is running.',
        detail:
          'Stopping the background service could interrupt active sessions or routines.',
      })
      if (choice.response === 2) return false
      if (choice.response === 1) {
        await dispose()
        return true
      }
    } else if (hasActiveWork) {
      const choice = await showBox({
        type: 'question',
        buttons: ['Stop and quit', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: 'A session or routine is still running.',
        detail: 'Stopping the background service will interrupt active work.',
      })
      if (choice.response !== 0) return false
    }

    stoppingForQuit = true
    await reconnecting?.catch(() => {})
    try {
      await stopDaemon({
        agentDir: resolvedAgentDir,
        hostEnv: process.env,
      })
    } catch (error) {
      stoppingForQuit = false
      await showBox({
        type: 'error',
        buttons: ['OK'],
        message: 'Could not stop the background service.',
        detail: error instanceof Error ? error.message : String(error),
      })
      if (disconnected && !disposed) {
        void reconnect().catch(() => {})
      }
      return false
    }
    await dispose()
    return true
  }

  return {
    runtime: () => current,
    agentDir: resolvedAgentDir,
    get disconnected() {
      return disconnected
    },
    reconnect,
    setSubscriptionBinder: (binder) => {
      bindSubscriptions = binder
      attach(current)
    },
    dispose,
    confirmAndStopBeforeQuit,
  }
}
