import { saveLarkSection } from '@glows777/vela'
import { ipcMain, type WebContents } from 'electron'
import { REQUEST, type Request } from '../shared/bridge.ts'
import { createHost } from './host.ts'

type Group = { chatId: string }

/** Own one host and one request handler across the temporary discovery connection. */
export async function startHost() {
  let host: Awaited<ReturnType<typeof createHost>> | undefined =
    await createHost()
  let closing = false
  const requests = new Set<Promise<unknown>>()
  let setup:
    | {
        owner: WebContents
        cancel(): void
        confirm(): void
        finished: Promise<void>
      }
    | undefined

  async function restartHost(whileStopped: () => Promise<void>) {
    const previous = host
    host = undefined
    await previous?.dispose()
    try {
      await whileStopped()
    } finally {
      if (!closing) host = await createHost()
    }
  }

  function discover(owner: WebContents) {
    if (setup) throw new Error('Group discovery is already open.')
    const controller = new AbortController()
    const found = Promise.withResolvers<Group | undefined>()
    const decision = Promise.withResolvers<boolean>()
    let group: Group | undefined
    const cancel = () => {
      controller.abort()
      decision.resolve(false)
    }
    const confirm = () => {
      if (!group) throw new Error('Mention the bot in the group first.')
      decision.resolve(true)
    }
    const finished = (async () => {
      // Finish calls already admitted (including submit) before checking run IDs.
      // Subsequent bridge calls wait until the host is ready again.
      await Promise.allSettled(requests)
      if (controller.signal.aborted) return
      if (!host)
        throw new Error('The desktop host is unavailable. Reopen the app.')
      const source = host.groupSetup()
      await restartHost(async () => {
        const timeout = AbortSignal.timeout(120_000)
        try {
          group = await source.discover(
            AbortSignal.any([controller.signal, timeout]),
          )
        } catch (error) {
          if (controller.signal.aborted) return
          if (timeout.aborted)
            throw new Error(
              'No group mention received in two minutes. Try again.',
            )
          throw error
        }
        if (controller.signal.aborted) return
        found.resolve(group)
        if (await decision.promise) {
          await saveLarkSection({
            agentDir: source.agentDir,
            addChat: group.chatId,
            env: process.env,
          })
        }
      })
    })().finally(() => {
      owner.removeListener('did-start-loading', cancel)
      owner.removeListener('destroyed', cancel)
      owner.removeListener('render-process-gone', cancel)
      setup = undefined
    })
    setup = { owner, confirm, cancel, finished }
    owner.once('did-start-loading', cancel)
    owner.once('destroyed', cancel)
    owner.once('render-process-gone', cancel)
    void finished.then(() => found.resolve(undefined), found.reject)
    return found.promise
  }

  ipcMain.handle(REQUEST, async ({ sender }, request: Request) => {
    if (request.method === 'discoverLarkGroup') return discover(sender)
    if (
      request.method === 'confirmLarkGroup' ||
      request.method === 'cancelLarkSetup'
    ) {
      if (!setup && request.method === 'cancelLarkSetup') return
      if (!setup || setup.owner !== sender)
        throw new Error('No group discovery in this window.')
      if (request.method === 'confirmLarkGroup') setup.confirm()
      else setup.cancel()
      return setup.finished
    }
    while (setup) await setup.finished.catch(() => {})
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
    setup?.cancel()
    await setup?.finished.catch(() => {})
    await host?.dispose()
  }
}
