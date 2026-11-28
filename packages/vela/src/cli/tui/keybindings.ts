import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ThinkingLevel } from '../../driver/index.ts'
import type { VelaRuntime } from '../../runtime-sdk-types.ts'
import {
  clipboardFilesText,
  clipboardImageText,
  readClipboardFilePaths,
  readClipboardImage,
  readClipboardText,
} from '../clipboard.ts'
import type { CliSessionClient } from '../runtime-client.ts'
import { backgroundRunning } from './background.ts'
import type { ChatLog } from './chat-log.ts'
import { errorMessage } from './components.ts'
import type { VelaEditor } from './editor.ts'
import type { InteractiveOptions, LogLevel } from './types.ts'

export interface InteractiveKeyHost {
  readonly runtime: VelaRuntime
  readonly editor: VelaEditor
  readonly log: ChatLog
  readonly options: InteractiveOptions
  getSession(): CliSessionClient | undefined
  isShuttingDown(): boolean
  getClipboardDir(): string | undefined
  setClipboardDir(dir: string): void
  getLastCtrlC(): number
  setLastCtrlC(ts: number): void
  addNotice(text: string, level?: LogLevel | 'dim', raw?: boolean): void
  updateBorder(): void
  restoreQueue(options?: { abort?: boolean }): Promise<number>
  shutdown(): Promise<void>
  setThinking(level: ThinkingLevel): Promise<void>
  selectModel(): Promise<void>
  cycleModel(direction: 1 | -1): void
  requestRender(): void
}

/** Wires keyboard actions (submit, interrupt, dequeue, paste, model/thinking cycles, background). */
export function wireInteractiveKeys(
  host: InteractiveKeyHost,
  submit: (text: string) => void,
): void {
  const { editor } = host
  editor.onSubmit = submit
  let bashMode = false
  editor.onChange = (text) => {
    const next = text.trimStart().startsWith('!')
    if (next === bashMode) return
    bashMode = next
    host.updateBorder()
  }
  const actions = editor.actions
  actions.set('interrupt', () => {
    const session = host.getSession()
    if (!session) return
    if (session.isBashRunning) {
      void host.runtime.sessions.abortBash(session.id).catch(() => {})
    } else if (session.isRunning) {
      void host
        .restoreQueue({ abort: true })
        .catch((error) => host.addNotice(errorMessage(error), 'error'))
    } else if (editor.getText().trimStart().startsWith('!')) {
      editor.setText('')
    }
  })
  actions.set('dequeue', () => {
    void host
      .restoreQueue()
      .then((moved) => {
        if (!moved) host.addNotice('No queued messages', 'dim')
      })
      .catch((error) => host.addNotice(errorMessage(error), 'error'))
  })
  actions.set('clear', () => {
    const now = Date.now()
    if (now - host.getLastCtrlC() < 500) void host.shutdown()
    else {
      editor.setText('')
      host.setLastCtrlC(now)
    }
  })
  actions.set('exit', () => void host.shutdown())
  actions.set('pasteImage', () => void pasteClipboardIntoEditor(host))
  actions.set('background', () => {
    const session = host.getSession()
    if (session) void backgroundRunning(session, host.addNotice.bind(host))
  })
  actions.set('cycleThinking', () => {
    const session = host.getSession()
    if (!session) return
    const levels = session.availableThinkingLevels
    if (levels.length < 2) {
      host.addNotice(
        'This model has no thinking levels to cycle through',
        'dim',
      )
      return
    }
    const next =
      levels[(levels.indexOf(session.thinkingLevel) + 1) % levels.length]!
    void host
      .setThinking(next)
      .catch((error) => host.addNotice(errorMessage(error), 'error'))
  })
  actions.set('selectModel', () => {
    void host
      .selectModel()
      .catch((error) => host.addNotice(errorMessage(error), 'error'))
  })
  actions.set('cycleModelForward', () => host.cycleModel(1))
  actions.set('cycleModelBackward', () => host.cycleModel(-1))
  actions.set('expandTools', () => host.log.toggleExpanded())
  actions.set('toggleThinking', () => host.log.toggleThinking())
}

async function pasteClipboardIntoEditor(
  host: InteractiveKeyHost,
): Promise<void> {
  if (host.isShuttingDown()) return
  try {
    const files = await (
      host.options.readClipboardFilePaths ?? readClipboardFilePaths
    )()
    const bytes = files?.length
      ? undefined
      : await (host.options.readClipboardImage ?? readClipboardImage)()
    if (host.isShuttingDown()) return
    const { line, col } = host.editor.getCursor()
    const current = host.editor.getLines()[line] ?? ''
    const before = current.slice(0, col)
    let dir = host.getClipboardDir()
    if (!dir && bytes?.length) {
      dir = mkdtempSync(join(tmpdir(), 'vela-clipboard-'))
      host.setClipboardDir(dir)
    }
    const pasted = files?.length
      ? clipboardFilesText(files, {
          bash: host.editor.getText().trimStart().startsWith('!'),
          before,
          after: current.slice(col),
        })
      : bytes?.length && dir
        ? clipboardImageText(bytes, dir, before)
        : await (host.options.readClipboardText ?? readClipboardText)()
    if (!pasted) return
    host.editor.insertTextAtCursor(pasted)
    host.requestRender()
  } catch (error) {
    if (host.isShuttingDown()) return
    host.addNotice(`Clipboard paste failed: ${errorMessage(error)}`, 'warning')
  }
}
