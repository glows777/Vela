import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type Component,
  Container,
  ProcessTerminal,
  type SelectItem,
  Spacer,
  type Terminal,
  TruncatedText,
  type TuiAltScreen,
} from '@earendil-works/pi-tui'
import {
  createBinaryResolver,
  type ImageContent,
  type SessionEntry,
  type ThinkingLevel,
} from '../driver/index.ts'
import type { VelaRuntime } from '../runtime-sdk-types.ts'
import { copyToClipboard } from './clipboard.ts'
import { createCliDispatcher } from './dispatcher.ts'
import type { CliSessionClient } from './runtime-client.ts'
import { formatContextFileList, headerSessionLabel } from './status-display.ts'
import { ChatLog } from './tui/chat-log.ts'
import { submitInteractiveInput } from './tui/command-router.ts'
import { commandCompletions, HOTKEYS } from './tui/commands.ts'
import {
  errorMessage,
  lastAnswer,
  oneLine,
  sanitize,
} from './tui/components.ts'
import { keyLabel, VelaEditor } from './tui/editor.ts'
import {
  handleRuntimeDeltaForTui,
  handleRuntimeEventForTui,
  type InteractiveEventHost,
  renderSessionBranchHistory,
} from './tui/event-bridge.ts'
import { Footer } from './tui/footer.ts'
import { inputDialog, selectDialog } from './tui/input-dialogs.ts'
import { wireInteractiveKeys } from './tui/keybindings.ts'
import { larkSetup } from './tui/lark-setup.ts'
import { createInteractiveTui } from './tui/layout.ts'
import { StartupHeader } from './tui/logo.ts'
import { captureCliLogs } from './tui/logs.ts'
import { isModelUsable } from './tui/model-availability.ts'
import { cycleModel, pickModel, selectModel } from './tui/model-selector.ts'
import { prepareInteractiveSession } from './tui/session-open.ts'
import { setupWizard } from './tui/setup-wizard.ts'
import { StatusLine } from './tui/status-line.ts'
import { registerInteractiveSignalHandlers } from './tui/terminal-signals.ts'
import { editorTheme, theme } from './tui/theme.ts'
import type { InteractiveOptions, LogLevel } from './tui/types.ts'

export type { InteractiveOptions } from './tui/types.ts'

const BUSY =
  'A task is running; press Esc to interrupt or wait for it to finish'

/**
 * Interactive mode (TUI, like pi's interactive mode): pi-tui provides components and rendering.
 * Layout: header -> chat log -> queued messages -> status line -> editor -> footer.
 */
export async function runInteractive(
  options: InteractiveOptions,
): Promise<void> {
  const mode = new InteractiveMode(options)
  await mode.start()
  if (options.setupOnly && mode.setupSummary)
    process.stdout.write(`${mode.setupSummary}\n`)
  if (mode.stopped) return mode.exited
  for (const [index, message] of (options.messages ?? []).entries()) {
    await mode.submit(message, index === 0 ? options.images : undefined)
  }
  return mode.exited
}

export class InteractiveMode {
  get stopped(): boolean {
    return this.shuttingDown
  }
  private readonly setupAbort = new AbortController()
  setupSummary?: string
  readonly tui: TuiAltScreen
  private readonly terminal: Terminal
  private readonly runtime: VelaRuntime
  private readonly options: InteractiveOptions
  private fdPath?: string
  private refreshCompletion?: () => void
  private session?: CliSessionClient

  private readonly header = new Container()
  private readonly transcript = new Container()
  private readonly log = new ChatLog(() => this.tui.requestRender())
  private readonly pendingBash = new Container()
  private readonly pending = new Container()
  private readonly status = new Container()
  private readonly editorArea = new Container()
  private readonly footer: Footer
  private readonly editor: VelaEditor
  private readonly dispatch: ReturnType<typeof createCliDispatcher>
  private readonly statusLine: StatusLine
  private readonly bashOutputListeners = new Map<
    string,
    (chunk: string) => void
  >()

  private lastCtrlC = 0
  private shownError?: string
  private dialogs = Promise.resolve()
  private restoreLogs?: () => void
  private readonly cleanups: (() => void)[] = []
  private shuttingDown = false
  private clipboardDir?: string
  private resolveExit!: () => void
  readonly exited = new Promise<void>((resolve) => {
    this.resolveExit = resolve
  })

  constructor(options: InteractiveOptions) {
    this.options = options
    this.runtime = options.runtime
    this.terminal = options.terminal ?? new ProcessTerminal()
    this.footer = new Footer(options.cwd, () => this.session)
    this.tui = createInteractiveTui(
      this.terminal,
      this.header,
      this.transcript,
      this.editorArea,
      this.footer,
    )
    this.editor = new VelaEditor(this.tui, editorTheme, { paddingX: 1 })
    this.dispatch = createCliDispatcher(this.runtime)
    this.statusLine = new StatusLine(this.tui, this.status)
    for (const child of [
      this.log.container,
      this.pendingBash,
      this.pending,
      this.status,
    ])
      this.transcript.addChild(child)
    this.editorArea.addChild(this.editor)
    this.setupKeys()
  }

  private eventHost(): InteractiveEventHost {
    return {
      log: this.log,
      statusLine: this.statusLine,
      requestRender: () => this.tui.requestRender(),
      addNotice: this.addNotice.bind(this),
      setShownError: (err) => {
        this.shownError = err
      },
      movePendingBash: this.movePendingBash.bind(this),
      onRunFinished: () => {
        if (!this.session || this.shuttingDown) return
        void this.session
          .refresh()
          .then(() => {
            this.updatePending()
            this.tui.requestRender()
          })
          .catch(() => {})
      },
    }
  }

  async start(): Promise<void> {
    const { runtime, options } = this
    this.tui.start()
    this.tui.setFocus(this.editor)
    this.captureLogs()
    this.registerSignalHandlers()
    options.attachLogger?.((level, message) => this.addNotice(message, level))

    const host = this.eventHost()
    const unsubEvents = runtime.events.subscribe((event) => {
      if (!this.session) return
      handleRuntimeEventForTui(host, event, this.session.id)
    })
    const unsubDeltas = runtime.events.subscribeDeltas((delta) => {
      if (!this.session) return
      handleRuntimeDeltaForTui(
        host,
        delta,
        this.session.id,
        this.bashOutputListeners,
      )
    })
    this.cleanups.push(unsubEvents, unsubDeltas)
    if (options.registerDisconnectHandler) {
      this.cleanups.push(
        options.registerDisconnectHandler((err) => {
          if (this.shuttingDown) return
          this.session?.markDisconnected()
          this.statusLine.stop()
          this.addNotice(
            `Disconnected from Vela daemon: ${errorMessage(err)}`,
            'error',
          )
          this.tui.requestRender()
        }),
      )
    }

    let sessionId = options.sessionId
    let resume = options.resume
    if (options.pick) {
      const picked = await this.pickSession()
      if (picked) {
        sessionId = picked
        resume = true
      }
    }
    try {
      await runtime.ready()
    } catch (error) {
      this.addNotice(errorMessage(error), 'error')
    }

    const resolveFd = createBinaryResolver({
      binDir: options.agentDir ? join(options.agentDir, 'bin') : undefined,
      offline: options.offline,
    })
    resolveFd('fd')
      .then((fdPath) => {
        this.fdPath = fdPath
        this.refreshCompletion?.()
      })
      .catch((error) =>
        this.addNotice(
          `@ file completion is off: ${errorMessage(error)}`,
          'warning',
        ),
      )

    const modelOk = await this.openSession(sessionId, resume, true)
    if ((options.setupOnly || !modelOk) && options.agentDir && this.session) {
      try {
        const wizardHost: Parameters<typeof setupWizard>[0] = {
          runtime: this.runtime,
          session: this.session,
          agentDir: options.agentDir,
          projectSettingsPath: options.projectSettingsPath,
          select: (title, choices, selected) =>
            this.select(title, choices, selected, this.setupAbort.signal),
          input: (title, placeholder, signal, secret, allowEmpty) =>
            this.input(
              title,
              placeholder,
              signal
                ? AbortSignal.any([signal, this.setupAbort.signal])
                : this.setupAbort.signal,
              secret,
              allowEmpty,
            ),
          addNotice: this.addNotice.bind(this),
          openBrowser: options.openBrowser,
          signal: this.setupAbort.signal,
          onConfigured: () => options.onConfigured?.(),
          pickModel: (models, current) =>
            pickModel(
              { dialog: this.dialog.bind(this) },
              models,
              current,
              this.setupAbort.signal,
            ),
          setSummary: (summary) => {
            this.setupSummary = summary
          },
        }
        const saved =
          options.setupTarget === 'lark'
            ? await larkSetup(wizardHost)
            : await setupWizard(wizardHost)
        if (!this.shuttingDown) this.renderHeader(saved || modelOk)
      } catch (error) {
        if (this.shuttingDown) return
        this.addNotice(`Setup failed: ${errorMessage(error)}`, 'error')
        this.renderHeader(modelOk)
      }
      if (options.setupOnly) {
        await this.shutdown()
        return
      }
    }
    if (this.shuttingDown) return
    this.tui.requestRender()
  }

  private async openSession(id: string, resume: boolean, startup = false) {
    const { session, inspection, resumed, resumeFailure, setupNext } =
      await prepareInteractiveSession(
        this.runtime,
        this.options,
        id,
        resume,
        startup,
      )
    this.session = session
    this.resetChat()
    if (resumeFailure) {
      this.addNotice(`Failed to resume session: ${resumeFailure}`, 'error')
    }
    if (inspection.extensionErrors.length > 0 && startup) {
      for (const err of inspection.extensionErrors) {
        this.addNotice(err, 'error')
      }
    }
    const modelOk = isModelUsable(session, this.options.hasUsableModel)
    this.refreshCompletion = () =>
      this.editor.setAutocompleteProvider(
        commandCompletions(session, inspection, this.fdPath),
      )
    this.refreshCompletion()
    if (startup) {
      const contextFiles = formatContextFileList(
        inspection.resources.contextFiles,
        {
          cwd: inspection.cwd,
          homeDir: homedir(),
          agentDir: this.options.agentDir,
        },
      )
      if (contextFiles) this.addNotice(`[context] ${contextFiles}`)
    }
    this.renderHeader(modelOk || setupNext)
    if (resumed) {
      this.renderHistory(inspection.branch)
      this.addNotice(
        `Resumed session ${inspection.name ?? inspection.sessionId}, ${inspection.entries.length} entries`,
        'dim',
      )
    } else if (inspection.parentSession && inspection.branch.length) {
      this.renderHistory(inspection.branch)
      this.addNotice(
        `Session ${inspection.sessionId}, copied from ${inspection.parentSession}`,
        'dim',
      )
    }
    if (process.env.VELA_DEBUG === '1') {
      const debugSnap = await session.refresh({ previewPrompt: true })
      const lines = (debugSnap.promptSnapshot?.stages ?? []).map(
        ({ name, chars }) =>
          `  ${name}: ${chars === null ? '[OFF]' : `[ON] ${chars} chars`}`,
      )
      this.addNotice(['Prompt PipeLine Debug', ...lines].join('\n'), 'dim')
    }
    this.updatePending()
    this.updateBorder()
    return modelOk
  }

  private async switchSession(id: string, resume: boolean): Promise<void> {
    if (!this.session) return
    if (this.session.isRunning) {
      this.addNotice(BUSY, 'warning')
      return
    }
    const previous = this.session
    if (id === previous.id) return
    await this.openSession(id, resume)
    previous.dispose()
  }

  private async pickSession(): Promise<string | undefined> {
    const saved = await this.runtime.sessions.listSummaries({
      cwd: this.options.cwd,
      excludeChannels: true,
    })
    if (!saved.length) {
      this.addNotice('No saved sessions', 'dim')
      return undefined
    }
    return this.select(
      'Resume Session',
      saved.map((s) => ({
        value: s.id,
        label: oneLine(sanitize(s.name ?? s.firstMessage)).slice(0, 60),
        description: `${sanitize(s.id)} · ${s.messageCount} messages · ${s.updatedAt}`,
      })),
    )
  }

  private resetChat(): void {
    this.log.clear()
    this.pendingBash.clear()
    this.statusLine.stop()
  }

  private renderHeader(modelOk: boolean): void {
    if (!this.session) return
    this.header.clear()
    const lines = [
      `${theme.bold('Vela')} ${theme.fg('dim', headerSessionLabel(this.session.id))}`,
      theme.fg(
        'dim',
        `${keyLabel('interrupt')} interrupt · ${keyLabel('clear')} clear · ${keyLabel('exit')} exit · / commands · /hotkeys for more`,
      ),
    ]
    if (!modelOk)
      lines.push(
        theme.fg(
          'yellow',
          'No model available: pick one with /model provider/id',
        ),
      )
    this.header.addChild(new Spacer(1))
    this.header.addChild(new StartupHeader(() => lines, this.tui))
  }

  private renderHistory(branch: SessionEntry[]): void {
    renderSessionBranchHistory(this.log, branch)
  }

  private movePendingBash(): void {
    for (const child of [...this.pendingBash.children]) this.log.add(child)
    this.pendingBash.clear()
  }

  private async runBash(command: string, excludeFromContext: boolean) {
    const session = this.session
    if (!session) return
    const running = session.isRunning
    const block = this.log.addBash(
      command,
      excludeFromContext,
      running ? this.pendingBash : this.log.container,
    )
    if (!running) this.log.endTurn()
    this.tui.requestRender()
    const bashId = randomUUID()
    let output = ''
    this.bashOutputListeners.set(bashId, (chunk) => {
      output += chunk
      block.update(output)
      this.tui.requestRender()
    })
    try {
      const result = await session.execBash(command, {
        excludeFromContext,
        id: bashId,
      })
      block.setResult(result)
    } catch (error) {
      block.setFailed()
      this.addNotice(`Shell command failed: ${errorMessage(error)}`, 'error')
    } finally {
      this.bashOutputListeners.delete(bashId)
    }
    this.tui.requestRender()
  }

  private addNotice(
    text: string,
    level: LogLevel | 'dim' = 'info',
    raw = false,
  ): void {
    this.log.addNotice(text, level, raw)
  }

  private updatePending(): void {
    this.pending.clear()
    const steering = this.session?.snapshot?.queuedSteering ?? []
    if (!steering.length) return
    this.pending.addChild(new Spacer(1))
    for (const text of steering)
      this.pending.addChild(
        new TruncatedText(theme.fg('dim', `Steering: ${oneLine(text)}`), 1, 0),
      )
    this.pending.addChild(
      new TruncatedText(
        theme.fg('dim', `↳ ${keyLabel('dequeue')} to edit queued messages`),
        1,
        0,
      ),
    )
  }

  private updateBorder(): void {
    this.editor.borderColor = this.editor.getText().trimStart().startsWith('!')
      ? theme.bashBorder
      : theme.thinkingBorder(this.session?.thinkingLevel ?? 'medium')
    this.tui.requestRender()
  }

  private setupKeys(): void {
    wireInteractiveKeys(
      {
        runtime: this.runtime,
        editor: this.editor,
        log: this.log,
        options: this.options,
        getSession: () => this.session,
        isShuttingDown: () => this.shuttingDown,
        getClipboardDir: () => this.clipboardDir,
        setClipboardDir: (dir) => {
          this.clipboardDir = dir
        },
        getLastCtrlC: () => this.lastCtrlC,
        setLastCtrlC: (ts) => {
          this.lastCtrlC = ts
        },
        addNotice: this.addNotice.bind(this),
        updateBorder: this.updateBorder.bind(this),
        restoreQueue: this.restoreQueue.bind(this),
        shutdown: () => this.shutdown(),
        setThinking: this.setThinking.bind(this),
        selectModel: this.selectModel.bind(this),
        cycleModel: this.cycleModel.bind(this),
        requestRender: () => this.tui.requestRender(),
      },
      (text) =>
        void this.submit(text).catch((error) => {
          if (!this.shuttingDown) this.addNotice(errorMessage(error), 'error')
        }),
    )
  }

  private async restoreQueue(
    options: { abort?: boolean } = {},
  ): Promise<number> {
    if (!this.session) return 0
    const { steering } = await this.runtime.sessions.clearQueue(this.session.id)
    if (steering.length) {
      const text = [...steering, this.editor.getText()]
        .filter((t) => t.trim())
        .join('\n\n')
      this.editor.setText(text)
    }
    await this.session.refresh().catch(() => {})
    this.updatePending()
    if (options.abort) {
      await this.runtime.stop(this.session.id).catch(() => {})
    }
    this.tui.requestRender()
    return steering.length
  }

  async submit(raw: string, images?: ImageContent[]): Promise<void> {
    await submitInteractiveInput(
      {
        runtime: this.runtime,
        session: this.session,
        cwd: this.options.cwd,
        agentDir: this.options.agentDir,
        newSessionId: this.options.newSessionId,
        shownError: this.shownError,
        dispatch: this.dispatch,
        addNotice: this.addNotice.bind(this),
        busyNotice: this.busyNotice.bind(this),
        describeError: this.describeError.bind(this),
        commandOutput: this.commandOutput.bind(this),
        editorAddHistory: (t) => this.editor.addToHistory(t),
        editorSetText: (t) => this.editor.setText(t),
        requestRender: () => this.tui.requestRender(),
        runBash: this.runBash.bind(this),
        shutdown: () => this.shutdown(),
        copyLastAnswer: this.copyLastAnswer.bind(this),
        pickSession: this.pickSession.bind(this),
        switchSession: this.switchSession.bind(this),
        selectModel: this.selectModel.bind(this),
        setThinking: this.setThinking.bind(this),
        updateBorder: this.updateBorder.bind(this),
        updatePending: this.updatePending.bind(this),
        startLoader: (t) => this.statusLine.start(t),
        stopLoader: () => this.statusLine.stop(),
        select: this.select.bind(this),
        authHost: () => this.authHost(),
        treeHost: () => this.treeHost(),
        hotkeys: () => HOTKEYS,
      },
      raw,
      images,
    )
  }

  private busyNotice(): boolean {
    if (!this.session?.isRunning) return false
    this.addNotice(BUSY, 'warning')
    return true
  }

  private treeHost() {
    return {
      session: this.session!,
      options: this.options,
      select: this.select.bind(this),
      input: this.input.bind(this),
      addNotice: this.addNotice.bind(this),
      busyNotice: this.busyNotice.bind(this),
      startLoader: (message: string) => this.statusLine.start(message),
      stopLoader: () => this.statusLine.stop(),
      resetChat: this.resetChat.bind(this),
      renderHistory: this.renderHistory.bind(this),
      updateBorder: this.updateBorder.bind(this),
      switchSession: this.switchSession.bind(this),
      editor: this.editor,
      tui: this.tui,
    }
  }

  private async copyLastAnswer(): Promise<void> {
    if (!this.session) return
    const snap = await this.session.refresh({ includeEntries: true })
    const msgs = snap.branch.flatMap((e) =>
      e.type === 'message' ? [e.message] : [],
    )
    const text = lastAnswer(msgs)
    if (!text) {
      this.addNotice('No answer to copy yet', 'error')
      return
    }
    try {
      await (
        this.options.copyToClipboard ??
        ((value: string) =>
          copyToClipboard(value, {
            writeTerminal: (data) => this.terminal.write(data),
          }))
      )(text)
      this.addNotice('Copied the last answer to the clipboard', 'dim')
    } catch (error) {
      this.addNotice(errorMessage(error), 'error')
    }
  }

  private describeError(error: unknown): string {
    return this.options.describeError?.(error) ?? errorMessage(error)
  }

  private commandOutput(): (text: string) => void {
    const lines: string[] = []
    return (text) => {
      if (!lines.length)
        queueMicrotask(() =>
          this.addNotice(lines.splice(0).join('\n'), 'info', true),
        )
      lines.push(text)
    }
  }

  private async setThinking(level: ThinkingLevel): Promise<void> {
    if (!this.session) return
    try {
      const next = await this.session.setThinkingLevel(level)
      this.addNotice(`thinking: ${next}`, 'dim')
    } catch (error) {
      this.addNotice(errorMessage(error), 'error')
    }
    this.updateBorder()
  }

  private modelHost() {
    const mode = this
    return {
      runtime: this.runtime,
      get session() {
        return mode.session!
      },
      options: this.options,
      addNotice: this.addNotice.bind(this),
      dialog: this.dialog.bind(this),
      renderHeader: this.renderHeader.bind(this),
      updateBorder: this.updateBorder.bind(this),
    }
  }
  private selectModel(): Promise<void> {
    return selectModel(this.modelHost())
  }
  private cycleModel(direction: 1 | -1): void {
    void cycleModel(this.modelHost(), direction)
  }
  private authHost() {
    return {
      runtime: this.runtime,
      options: this.options,
      select: this.select.bind(this),
      input: this.input.bind(this),
      addNotice: this.addNotice.bind(this),
      renderHeader: this.renderHeader.bind(this),
    }
  }

  private dialog<T>(
    build: (done: (value: T) => void) => {
      component: Component
      focus: Component
    },
  ): Promise<T> {
    const run = () =>
      new Promise<T>((resolve) => {
        const { component, focus } = build((value) => {
          this.editorArea.clear()
          this.editorArea.addChild(this.editor)
          this.tui.setFocus(this.editor)
          this.tui.requestRender()
          resolve(value)
        })
        this.editorArea.clear()
        this.editorArea.addChild(component)
        this.tui.setFocus(focus)
        this.tui.requestRender()
      })
    const result = this.dialogs.then(run)
    this.dialogs = result.then(
      () => {},
      () => {},
    )
    return result
  }

  select(
    title: string,
    items: SelectItem[],
    selected?: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (signal?.aborted) return Promise.resolve(undefined)
    return this.dialog((done) =>
      selectDialog(title, items, selected, signal, done),
    )
  }

  input(
    title: string,
    placeholder?: string,
    signal?: AbortSignal,
    ...options: [secret?: boolean, allowEmpty?: boolean]
  ): Promise<string | undefined> {
    if (signal?.aborted) return Promise.resolve(undefined)
    return this.dialog((done) =>
      inputDialog(title, placeholder, signal, done, ...options),
    )
  }

  private captureLogs(): void {
    this.restoreLogs = captureCliLogs((text, level) =>
      this.addNotice(text, level),
    )
  }

  private registerSignalHandlers(): void {
    registerInteractiveSignalHandlers({
      hasCustomTerminal: Boolean(this.options.terminal),
      onShutdown: () => void this.shutdown({ fromSignal: true }),
      onEmergencyExit: () => this.emergencyExit(),
      onBeforeCrash: () => {
        try {
          this.tui.stop()
        } catch {}
        this.restoreLogs?.()
      },
      cleanups: this.cleanups,
    })
  }

  async shutdown(options: { fromSignal?: boolean } = {}): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.setupAbort.abort()
    this.statusLine.stop()
    const restore = () => {
      try {
        this.tui.stop()
      } catch {}
      this.restoreLogs?.()
    }
    try {
      if (!options.fromSignal) restore()
      this.session?.dispose()
      await this.options.onExit()
    } finally {
      if (this.clipboardDir)
        rmSync(this.clipboardDir, { recursive: true, force: true })
      this.clipboardDir = undefined
      if (options.fromSignal) restore()
      for (const cleanup of this.cleanups.splice(0)) cleanup()
      this.resolveExit()
    }
  }

  private emergencyExit(): never {
    this.shuttingDown = true
    process.exit(129)
  }
}
