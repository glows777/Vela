import { saveLarkSection } from '@glows777/vela'
import { ipcMain, type WebContents } from 'electron'
import { REQUEST, type Request } from '../shared/bridge.ts'
import { openAvailableHost, openHost } from './host.ts'
import { prepareLarkWrite, verifyCredentials } from './lark-settings.ts'
import { loadDesktopConfig } from './settings.ts'

type Setup = {
  owner: WebContents
  controller: AbortController
  chatId?: string
  confirming?: boolean
  clear(): void
}

const reloadDiagnostic =
  'The app could not reload Lark settings. Check the data directory and config.json, then try again.'

/** Only writing settings and replacing the host require exclusive access. */
export async function startHost() {
  let workingConfig = loadDesktopConfig(process.cwd())
  type Host = Awaited<ReturnType<typeof openHost>>
  let host: Promise<Host> | undefined = Promise.resolve(
    await openAvailableHost(workingConfig),
  )
  let barrier = Promise.resolve()
  const active = new Set<Promise<unknown>>()
  let closing = false
  let setup: Setup | undefined
  const verify =
    process.env.VELA_DESKTOP_LARK === 'fake'
      ? (await import('./settings-transport.ts')).verifySettingsCredentials
      : verifyCredentials

  // All readers share one recovery attempt. A repaired directory can be retried on the next request.
  const restoreLocal = () =>
    openHost(workingConfig, false, reloadDiagnostic).catch(() => {
      host = undefined
      throw new Error(
        'Could not restore Local. Check the data directory and config.json, then try again.',
      )
    })
  const current = () => (host ??= restoreLocal())
  const read = <T>(operation: (live: Host) => T) => {
    const pending = barrier.then(current).then(operation)
    const settled = pending.then(
      () => {},
      () => {},
    )
    active.add(settled)
    void settled.then(() => active.delete(settled))
    return pending
  }
  const section = () => {
    try {
      return (
        loadDesktopConfig(workingConfig.cwd, workingConfig.agentDir)
          .extensionConfig.lark ?? {}
      )
    } catch {
      throw new Error(
        'Could not read Lark settings. Check config.json and try again.',
      )
    }
  }
  function exclusive<T>(operation: (previous: Host) => Promise<T>) {
    const work = Promise.all([barrier, ...active]).then(async () => {
      if (closing) throw new Error('The app is closing.')
      return operation(await current())
    })
    barrier = work.then(
      () => {},
      () => {},
    )
    return work
  }

  async function stop(previous: Host) {
    try {
      await previous.dispose()
      host = undefined
    } catch {
      // Ownership is uncertain. Never open another connection in this process.
      host = Promise.reject(
        new Error(
          'Could not safely stop the desktop host. Quit and reopen Vela before changing Lark settings.',
        ),
      )
      await host
    }
  }

  async function reload() {
    try {
      const config = loadDesktopConfig(
        workingConfig.cwd,
        workingConfig.agentDir,
      )
      const next = await openAvailableHost(config)
      workingConfig = config
      return next
    } catch {
      return restoreLocal()
    }
  }
  const save = async (
    input: Extract<Request, { method: 'saveLark' }>['input'],
  ) => {
    const before = await read((live) => {
      live.checkIdle()
      return section()
    })
    const write = await prepareLarkWrite(
      workingConfig.agentDir,
      before,
      input,
      verify,
    )
    return exclusive(async (previous) => {
      previous.checkIdle()
      await write(section())
      // Approval belongs to the configuration in which the mention was observed.
      if (setup?.chatId) setup.clear()
      await stop(previous)
      host = reload()
      return (await host).settings()
    })
  }

  function restartHost<T>(
    signal: AbortSignal,
    whileStopped: (source: ReturnType<Host['groupSetup']>) => Promise<T>,
  ) {
    return exclusive(async (previous) => {
      signal.throwIfAborted()
      const source = previous.groupSetup()
      previous.checkIdle()
      await stop(previous)
      try {
        signal.throwIfAborted()
        return await whileStopped(source)
      } finally {
        if (!closing) {
          host = reload()
          await host
        }
      }
    })
  }

  async function discover(owner: WebContents) {
    if (setup) throw new Error('Group discovery is already open.')
    const controller = new AbortController()
    const clear = () => {
      controller.abort()
      owner.removeListener('destroyed', clear)
      owner.removeListener('render-process-gone', clear)
      owner.removeListener('did-start-loading', clear)
      if (setup === attempt) setup = undefined
    }
    const attempt: Setup = { owner, controller, clear }
    setup = attempt
    owner.once('destroyed', clear)
    owner.once('render-process-gone', clear)
    owner.once('did-start-loading', clear)
    const timeout = AbortSignal.timeout(120_000)
    try {
      const group = await restartHost(controller.signal, (source) =>
        source.discover(AbortSignal.any([controller.signal, timeout])),
      )
      if (controller.signal.aborted) return
      // Normal channels are back before the person is asked to decide.
      attempt.chatId = group.chatId
      return group
    } catch (error) {
      const cancelled = controller.signal.aborted
      clear()
      if (cancelled && host) return
      if (timeout.aborted && host)
        throw new Error('No group mention received in two minutes. Try again.')
      throw error
    }
  }

  ipcMain.handle(REQUEST, async ({ sender }, request: Request) => {
    if (request.method === 'discoverLarkGroup') return discover(sender)
    if (
      request.method === 'cancelLarkSetup' ||
      request.method === 'confirmLarkGroup'
    ) {
      const attempt = setup
      if (!attempt && request.method === 'cancelLarkSetup') return
      if (!attempt || attempt.owner !== sender)
        throw new Error('No group discovery in this window.')
      if (request.method === 'cancelLarkSetup') {
        attempt.clear()
        await barrier
        if (!host && !closing)
          throw new Error('The desktop host is unavailable. Reopen the app.')
        return
      }
      const chatId = attempt.chatId
      if (!chatId || attempt.confirming)
        throw new Error('No pending group approval in this window.')
      // A session may have started while confirmation was open. Check again before saving.
      attempt.confirming = true
      try {
        await restartHost(attempt.controller.signal, ({ agentDir }) =>
          saveLarkSection({ agentDir, addChat: chatId, env: process.env }),
        )
      } finally {
        attempt.clear()
      }
      return
    }
    if (request.method === 'saveLark') return save(request.input)
    return read((live) => live.handle(request))
  })
  return async () => {
    closing = true
    ipcMain.removeHandler(REQUEST)
    setup?.clear()
    await Promise.all([barrier, ...active])
    await (await host?.catch(() => undefined))?.dispose()
  }
}
