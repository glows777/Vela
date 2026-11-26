import type { SelectItem } from '@earendil-works/pi-tui'
import type { ImageContent, ThinkingLevel } from '../../driver/index.ts'
import type { VelaRuntime } from '../../runtime-sdk-types.ts'
import type { createCliDispatcher } from '../dispatcher.ts'
import type { CliSessionClient } from '../runtime-client.ts'
import { loginCommand, logoutCommand } from './auth-dialogs.ts'
import { errorMessage } from './components.ts'
import { forkCommand, treeCommand } from './session-tree.ts'
import type { LogLevel } from './types.ts'

export interface InteractiveSubmitHost {
  readonly runtime: VelaRuntime
  readonly session: CliSessionClient | undefined
  readonly cwd: string
  readonly agentDir?: string
  readonly newSessionId: () => string
  readonly shownError?: string
  readonly dispatch: ReturnType<typeof createCliDispatcher>
  addNotice(text: string, level?: LogLevel | 'dim', raw?: boolean): void
  busyNotice(): boolean
  describeError(error: unknown): string
  commandOutput(): (text: string) => void
  editorAddHistory(text: string): void
  editorSetText(text: string): void
  requestRender(): void
  runBash(command: string, excludeFromContext: boolean): Promise<void>
  shutdown(): Promise<void>
  copyLastAnswer(): Promise<void>
  pickSession(): Promise<string | undefined>
  switchSession(id: string, resume: boolean): Promise<void>
  selectModel(): Promise<void>
  setThinking(level: ThinkingLevel): Promise<void>
  updateBorder(): void
  updatePending(): void
  startLoader(text: string): void
  stopLoader(): void
  select(
    title: string,
    items: SelectItem[],
    selected?: string,
  ): Promise<string | undefined>
  authHost(): Parameters<typeof loginCommand>[0]
  treeHost(): Parameters<typeof treeCommand>[0]
  hotkeys(): readonly string[]
}

/** Handles interactive TUI submission: `!`/`!!` bash, built-in/CLI slash commands, steer queue, and prompts. */
export async function submitInteractiveInput(
  host: InteractiveSubmitHost,
  raw: string,
  images?: ImageContent[],
): Promise<void> {
  const text = raw.trim()
  if (!text && !images?.length) return
  const session = host.session
  if (!session) return
  host.editorAddHistory(text)
  host.editorSetText('')

  if (text.startsWith('!')) {
    const excluded = text.startsWith('!!')
    const command = text.slice(excluded ? 2 : 1).trim()
    if (command) {
      if (session.isBashRunning) {
        host.addNotice(
          'A shell command is already running; press Esc to cancel it first',
          'warning',
        )
        host.editorSetText(text)
        return
      }
      await host.runBash(command, excluded)
      return
    }
  }

  const name = text.split(/\s+/, 1)[0] ?? ''
  const args = text.slice(name.length).trim()
  switch (name) {
    case '/exit':
    case '/quit':
      await host.shutdown()
      return
    case '/hotkeys':
      host.addNotice(host.hotkeys().join('\n'))
      return
    case '/copy':
      await host.copyLastAnswer()
      return
    case '/new':
      await host
        .switchSession(host.newSessionId(), false)
        .catch((error) => host.addNotice(errorMessage(error), 'error'))
      return
    case '/resume': {
      if (host.busyNotice()) return
      const id = await host.pickSession()
      if (id)
        await host
          .switchSession(id, true)
          .catch((error) => host.addNotice(errorMessage(error), 'error'))
      return
    }
    case '/name':
      if (!args) {
        host.addNotice(`Session name: ${session.name ?? '(unnamed)'}`)
        return
      }
      await session.rename(args)
      host.addNotice(`Session name: ${args}`, 'dim')
      host.requestRender()
      return
    case '/model':
      if (!args) {
        await host.selectModel()
        return
      }
      break
    case '/login':
      await loginCommand(host.authHost(), args)
      return
    case '/logout':
      await logoutCommand(host.authHost(), args)
      return
    case '/thinking':
      if (!args) {
        const level = await host.select(
          'Thinking level',
          session.availableThinkingLevels.map((l) => ({
            value: l,
            label: l === session.thinkingLevel ? `${l} ✓` : l,
          })),
          session.thinkingLevel,
        )
        if (level) await host.setThinking(level as ThinkingLevel)
        return
      }
      break
    case '/tree':
      await treeCommand(host.treeHost())
      return
    case '/fork':
      await forkCommand(host.treeHost())
      return
    case '/clone':
      await forkCommand(host.treeHost(), true)
      return
    case '/export':
      try {
        const path = await host.runtime.sessions.export(
          session.id,
          args.endsWith('.jsonl') ? 'jsonl' : 'html',
          args || undefined,
          host.cwd,
        )
        host.addNotice(`Exported to ${path}`, 'dim')
      } catch (error) {
        host.addNotice(`Export failed: ${errorMessage(error)}`, 'error')
      }
      return
    case '/compact':
      if (host.busyNotice()) return
      host.startLoader('Compacting context…')
      try {
        await host.runtime.sessions.compact(session.id, args || undefined)
        await session.refresh()
      } catch (error) {
        host.addNotice(`Compaction failed: ${errorMessage(error)}`, 'error')
      } finally {
        host.stopLoader()
        host.requestRender()
      }
      return
  }

  const running = session.isRunning
  if (!running || text.startsWith('/')) {
    const handled = host.dispatch(text, {
      runtime: host.runtime,
      session,
      print: host.commandOutput(),
      agentDir: host.agentDir,
    })
    if (handled instanceof Promise)
      await handled.catch((error) =>
        host.addNotice(errorMessage(error), 'error'),
      )
    if (handled) {
      host.updateBorder()
      return
    }
  }

  const cmdName = text.startsWith('/')
    ? (text.slice(1).split(/\s/, 1)[0] ?? '')
    : ''
  const isExtOrNative =
    cmdName.length > 0 &&
    (session.snapshot?.commands ?? []).some((c) => c.name === cmdName)

  if (running && !isExtOrNative) {
    try {
      await session.prompt(text, { steer: true })
      await session.refresh().catch(() => {})
    } catch (error) {
      host.addNotice(host.describeError(error), 'error')
    }
    host.updatePending()
    host.requestRender()
    return
  }

  try {
    const res = await session.prompt(text, { images })
    if (!res.handledCommand) {
      await session.waitForSettled()
    }
  } catch (error) {
    if (errorMessage(error) !== host.shownError)
      host.addNotice(`Error: ${host.describeError(error)}`, 'error')
  }
  host.requestRender()
}
