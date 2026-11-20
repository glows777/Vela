import { saveLarkSection } from '@glows777/vela'
import { ipcMain, type WebContents } from 'electron'
import { REQUEST, type Request } from '../shared/bridge.ts'
import { createHost } from './host.ts'

type Host = Awaited<ReturnType<typeof createHost>>
type Setup = {
  owner: WebContents
  controller: AbortController
  chatId?: string
  clear(): void
}

/** Own one host and one request handler across the temporary discovery connection. */
export async function startHost() {
  let host: Host | undefined = await createHost()
  let closing = false
  const requests = new Set<Promise<unknown>>()
  let restarting: Promise<void> | undefined
  let setup: Setup | undefined

  async function restartHost<T>(
    signal: AbortSignal,
    whileStopped: (source: ReturnType<Host['groupSetup']>) => Promise<T>,
  ) {
    if (restarting) throw new Error('The desktop host is restarting.')
    const work = (async () => {
      // Wait for admitted calls (including submit), then check run IDs before disposing.
      await Promise.allSettled(requests)
      signal.throwIfAborted()
      if (!host)
        throw new Error('The desktop host is unavailable. Reopen the app.')
      const source = host.groupSetup()
      const previous = host
      host = undefined
      await previous.dispose()
      try {
        signal.throwIfAborted()
        return await whileStopped(source)
      } finally {
        if (!closing) host = await createHost()
      }
    })()
    restarting = work
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        restarting = undefined
      })
    return work
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
        await restarting
        if (!host && !closing)
          throw new Error('The desktop host is unavailable. Reopen the app.')
        return
      }
      const chatId = attempt.chatId
      if (!chatId) throw new Error('Mention the bot in the group first.')
      // A session may have started while confirmation was open. Check again before saving.
      attempt.chatId = undefined
      try {
        await restartHost(attempt.controller.signal, ({ agentDir }) =>
          saveLarkSection({ agentDir, addChat: chatId, env: process.env }),
        )
      } finally {
        attempt.clear()
      }
      return
    }
    while (restarting) await restarting
    if (!host || closing)
      throw new Error('The desktop host is unavailable. Reopen the app.')
    const pending = host.handle(request)
    requests.add(pending)
    try {
      return await pending
    } finally {
      requests.delete(pending)
    }
  })
  return async () => {
    closing = true
    ipcMain.removeHandler(REQUEST)
    setup?.clear()
    await restarting
    await host?.dispose()
  }
}
