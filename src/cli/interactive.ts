import { homedir } from 'node:os'
import { format } from 'node:util'
import {
  CombinedAutocompleteProvider,
  type Component,
  Container,
  Input,
  Loader,
  ProcessTerminal,
  type SelectItem,
  SelectList,
  Spacer,
  type Terminal,
  Text,
  TruncatedText,
  TuiMainScreen,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui'
import type { ModelMessage } from 'ai'
import type { VelaEvent } from '../agent/events.ts'
import type { SessionUI } from '../extensions/types.ts'
import { THINKING_LEVELS, type ThinkingLevel } from '../models/index.ts'
import { type Vela, velaInternals } from '../vela.ts'
import type { VelaSession } from '../vela-session.ts'
import { createCliDispatcher } from './dispatcher.ts'
import {
  AssistantMessage,
  notice,
  sanitize,
  ToolBlock,
  UserMessage,
} from './tui/components.ts'
import { VelaEditor } from './tui/editor.ts'
import { editorTheme, selectListTheme, theme } from './tui/theme.ts'

export interface InteractiveOptions {
  vela: Vela
  /** Session at startup */
  sessionId: string
  /** Restore this session's history at startup (`-c` / `--session`) */
  resume: boolean
  /** `-r`: pick from saved sessions at startup */
  pick: boolean
  /** Id for a new session (`/new`) */
  newSessionId: () => string
  /** Called after a session opens (and resumes): command-line --model / --thinking override saved settings; returns whether the model is usable */
  configure: (session: VelaSession) => boolean
  /** Called before exit (dispose, write the recording file) */
  onExit: () => Promise<void>
  /** Fake terminal for tests; defaults to the real terminal */
  terminal?: Terminal
  /** Attach the logger: warn / error show in the chat log */
  attachLogger?: (sink: (level: LogLevel, message: string) => void) => void
  /** Rewrites an error for display (the CLI swaps the SDK's no-model hint for its own) */
  describeError?: (error: unknown) => string
}

type LogLevel = 'info' | 'warning' | 'error'

/** Commands the TUI handles itself (besides extension and CLI slash commands), for autocomplete */
const TUI_COMMANDS = [
  { name: 'new', description: 'Start a new session' },
  { name: 'resume', description: 'Resume a saved session' },
  { name: 'name', description: 'Set the session name' },
  {
    name: 'model',
    description: 'Select model (/model provider/id switches directly)',
  },
  { name: 'thinking', description: 'Select thinking level' },
  {
    name: 'compact',
    description: 'Manually compact the session context (optional focus)',
  },
  { name: 'hotkeys', description: 'Show keyboard shortcuts' },
  { name: 'quit', description: 'Quit Vela' },
]
const CLI_COMMANDS = [
  { name: 'context', description: 'Context usage' },
  { name: 'usage', description: 'Token usage and cost' },
  { name: 'skill', description: 'List / load / unload skills' },
  { name: 'extensions', description: 'Loaded extensions' },
  { name: 'channel', description: 'Channels' },
  { name: 'role', description: 'Show / switch role' },
  { name: 'hooks', description: 'Registered hooks' },
]

const HOTKEYS = [
  'Enter send; while running, Enter = steer (inserted after the current step)',
  'Alt+Enter while running, queue a follow-up (after the task finishes)',
  'Alt+Up move queued messages back to the editor',
  'Esc interrupt (queued messages go back to the editor)',
  'Shift+Tab cycle thinking level · Ctrl+L select model',
  'Ctrl+O expand / collapse tool output · Ctrl+T show / hide thinking',
  'Ctrl+C clear editor, twice to exit · Ctrl+D exit when editor is empty',
]

/**
 * Interactive mode (TUI, like pi's interactive mode): pi-tui provides components and rendering.
 * Layout: header → chat log → queued messages → status line → extension widgets → editor → footer.
 * The returned Promise resolves on exit.
 */
export async function runInteractive(
  options: InteractiveOptions,
): Promise<void> {
  const mode = new InteractiveMode(options)
  await mode.start()
  return mode.exited
}

export class InteractiveMode {
  readonly tui: TuiMainScreen
  private readonly vela: Vela
  private readonly options: InteractiveOptions
  private session!: VelaSession

  private readonly header = new Container()
  private readonly chat = new Container()
  private readonly pending = new Container()
  private readonly status = new Container()
  private readonly widgets = new Container()
  private readonly editorArea = new Container()
  private readonly footer: Footer
  private readonly editor: VelaEditor
  private readonly dispatch: ReturnType<typeof createCliDispatcher>
  private loader?: Loader

  private current?: AssistantMessage
  private readonly tools = new Map<string, ToolBlock>()
  private readonly allTools: ToolBlock[] = []
  private readonly allAssistant: AssistantMessage[] = []
  private toolsExpanded = false
  private hideThinking = false
  private lastCtrlC = 0
  private shownError?: unknown
  private readonly widgetLines = new Map<string, string[]>()
  private dialogs = Promise.resolve()
  private restoreConsole?: () => void
  private readonly cleanups: (() => void)[] = []
  private shuttingDown = false
  private resolveExit!: () => void
  readonly exited = new Promise<void>((resolve) => {
    this.resolveExit = resolve
  })

  private readonly ui: SessionUI = {
    notify: (message, level = 'info') => this.addNotice(message, level),
    confirm: async (title, message) =>
      (await this.select(`${title}\n${message}`, [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ])) === 'yes',
    select: (title, choices) =>
      this.select(
        title,
        choices.map((choice) => ({ value: choice, label: choice })),
      ),
    input: (title, placeholder) => this.input(title, placeholder),
    setStatus: (key, text) => {
      this.footer.setStatus(key, text)
      this.tui.requestRender()
    },
    setWidget: (key, lines) => {
      if (lines?.length) this.widgetLines.set(key, lines)
      else this.widgetLines.delete(key)
      this.renderWidgets()
    },
  }

  constructor(options: InteractiveOptions) {
    this.options = options
    this.vela = options.vela
    this.tui = new TuiMainScreen(options.terminal ?? new ProcessTerminal())
    this.editor = new VelaEditor(this.tui, editorTheme, { paddingX: 1 })
    this.footer = new Footer(this.vela.cwd, () => this.session)
    this.dispatch = createCliDispatcher(this.vela)
    for (const child of [
      this.header,
      this.chat,
      this.pending,
      this.status,
      this.widgets,
      this.editorArea,
      this.footer,
    ])
      this.tui.addChild(child)
    this.editorArea.addChild(this.editor)
    this.setupKeys()
  }

  async start(): Promise<void> {
    const { vela, options } = this
    this.tui.start()
    this.tui.setFocus(this.editor)
    this.captureConsole()
    this.registerSignalHandlers()
    options.attachLogger?.((level, message) => this.addNotice(message, level))
    vela.subscribe((event, sessionId) => this.onEvent(event, sessionId))

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
      await vela.ready()
    } catch (error) {
      this.addNotice(errorMessage(error), 'error')
    }
    await this.openSession(sessionId, resume)
    this.setAutocomplete()
    // Like pi: @ file completion needs fd; find (or download) it after the UI is up so startup doesn't block
    velaInternals(vela)
      .resolveBinary('fd')
      .then((fdPath) => this.setAutocomplete(fdPath))
      .catch((error) =>
        this.addNotice(
          `@ file completion is off: ${errorMessage(error)}`,
          'warning',
        ),
      )
    await vela
      .startChannels()
      .catch((error) =>
        this.addNotice(
          `Failed to start channels: ${errorMessage(error)}`,
          'error',
        ),
      )
    this.tui.requestRender()
  }

  private setAutocomplete(fdPath?: string): void {
    const vela = this.vela
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(
        [
          ...TUI_COMMANDS,
          ...CLI_COMMANDS,
          ...velaInternals(vela)
            .skillLoader.list()
            .map((s) => ({ name: s.name, description: s.description })),
          ...vela.commands().map((c) => ({
            name: c.name,
            description: c.description ?? `Extension ${c.extension}`,
          })),
        ],
        vela.cwd,
        fdPath,
      ),
    )
  }

  // ---------------------------------------------------------------- Sessions

  private async openSession(id: string, resume: boolean): Promise<void> {
    const session = this.vela.session(id, { ui: this.ui })
    this.session = session
    this.resetChat()
    let resumed = false
    if (resume) {
      try {
        resumed = await session.resume()
      } catch (error) {
        this.addNotice(
          `Failed to resume session: ${errorMessage(error)}`,
          'error',
        )
      }
    }
    const modelOk = this.options.configure(session)
    this.renderHeader(modelOk)
    if (resumed) {
      this.renderHistory(session.messages)
      this.addNotice(
        `Resumed session ${session.name ?? session.id}, ${session.messages.length} messages`,
        'dim',
      )
    }
    if (process.env.VELA_DEBUG === '1') {
      const internals = velaInternals(this.vela)
      const lines = internals.builder
        .status({
          ...session.promptContext(),
          toolCount: internals.registry.getAllTools().length,
        })
        .map(
          ({ name, chars }) =>
            `  ${name}: ${chars === null ? '[OFF]' : `[ON] ${chars} chars`}`,
        )
      this.addNotice(['Prompt PipeLine Debug', ...lines].join('\n'), 'dim')
    }
    this.updatePending()
    this.updateBorder()
  }

  private async switchSession(id: string, resume: boolean): Promise<void> {
    if (this.session.isRunning) {
      this.addNotice(
        'A task is running; press Esc to interrupt or wait for it to finish',
        'warning',
      )
      return
    }
    const previous = this.session
    if (id === previous.id) return
    await previous.close()
    await this.openSession(id, resume)
  }

  private async pickSession(): Promise<string | undefined> {
    const saved = await this.vela.listSessions()
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
    this.chat.clear()
    this.tools.clear()
    this.allTools.length = 0
    this.allAssistant.length = 0
    this.current = undefined
    this.stopLoader()
  }

  private renderHeader(modelOk: boolean): void {
    this.header.clear()
    const extensions = this.vela.extensions().map((e) => e.name)
    const lines = [
      `${theme.bold(theme.fg('accent', 'Vela'))} ${theme.fg('dim', `session ${this.session.id}`)}`,
      theme.fg(
        'dim',
        `Esc interrupt · Ctrl+C clear · Ctrl+D exit · / commands · Alt+Enter follow-up · /hotkeys for more`,
      ),
    ]
    if (extensions.length)
      lines.push(theme.fg('dim', `Extensions: ${extensions.join(', ')}`))
    if (!modelOk)
      lines.push(
        theme.fg(
          'yellow',
          'No model available: pick one with /model provider/id',
        ),
      )
    this.header.addChild(new Spacer(1))
    this.header.addChild(new Text(lines.join('\n'), 1, 0))
  }

  /** Render history when resuming a session */
  private renderHistory(messages: ModelMessage[]): void {
    for (const message of messages) this.renderMessage(message, true)
    this.current = undefined
  }

  // ---------------------------------------------------------------- Events

  private onEvent(event: VelaEvent, sessionId: string): void {
    // Channel activity (Feishu etc.) gets one line each; channel session content is not streamed
    switch (event.type) {
      case 'channel_message':
        this.addNotice(
          `[${event.channel}] ${event.senderName}: ${event.text}`,
          'dim',
        )
        return
      case 'channel_reply':
        this.addNotice(
          `[${event.channel}] → ${event.text.slice(0, 80)}${event.text.length > 80 ? '…' : ''}`,
          'dim',
        )
        return
      case 'channel_error':
        this.addNotice(
          event.aborted
            ? `[${event.channel}] Turn aborted`
            : `[${event.channel}] Turn stopped: ${errorMessage(event.error)}`,
          event.aborted ? 'dim' : 'error',
        )
        return
    }
    if (sessionId !== this.session.id) return
    switch (event.type) {
      case 'agent_start':
        this.shownError = undefined
        this.startLoader('Thinking…')
        break
      case 'message':
        if (event.message.role === 'user') this.renderMessage(event.message)
        break
      case 'turn_start':
        this.current = undefined
        this.startLoader('Thinking…')
        break
      case 'thinking_delta':
        this.assistant().appendThinking(event.text)
        break
      case 'text_delta':
        this.assistant().appendText(event.text)
        this.setLoader('Answering…')
        break
      case 'tool_call': {
        this.current = undefined
        this.addTool(event.toolCallId, event.toolName, event.input)
        this.setLoader(`Running ${event.toolName}…`)
        break
      }
      case 'tool_result':
        this.tools.get(event.toolCallId)?.setResult(event.output)
        break
      case 'tool_error':
        this.tools.get(event.toolCallId)?.setResult(event.error, true)
        break
      case 'retry':
        this.addNotice(
          `Request failed, retrying in ${Math.round(event.delayMs / 1000)}s (${event.attempt}/${event.maxRetries}): ${errorMessage(event.error)}`,
          'warning',
        )
        break
      case 'loop_detected':
        this.addNotice(
          event.message,
          event.level === 'critical' ? 'error' : 'warning',
        )
        break
      case 'agent_end':
        this.current = undefined
        if (event.reason === 'aborted') this.addNotice('Interrupted', 'dim')
        else if (event.reason === 'loop')
          this.addNotice('Repeated tool calls detected, stopped', 'error')
        else if (event.reason === 'error') {
          this.shownError = event.error
          this.addNotice(`Error: ${errorMessage(event.error)}`, 'error')
        }
        break
      case 'agent_settled':
        this.stopLoader()
        break
      case 'queue_update':
        this.updatePending()
        break
      case 'context':
        this.addNotice(contextLine(event), 'dim')
        if (event.action === 'summary-required')
          this.setLoader('Compacting context…')
        break
      case 'session_save_failed':
        this.addNotice(
          `Failed to save session: ${errorMessage(event.error)}`,
          'error',
        )
        break
      case 'audit':
        this.addNotice(`[audit] ${event.toolName} → ${event.path}`, 'dim')
        break
      case 'security_warning':
        this.addNotice(`⚠ ${event.reason}: ${event.command}`, 'warning')
        break
      case 'notify':
        this.addNotice(event.message, event.level)
        break
    }
    this.tui.requestRender()
  }

  private renderMessage(message: ModelMessage, history = false): void {
    if (message.role === 'user') {
      const text =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .map((part) => (part.type === 'text' ? part.text : ''))
              .join('')
      if (text.trim()) this.chat.addChild(new UserMessage(text))
      this.current = undefined
      return
    }
    if (!history) return
    if (message.role === 'assistant') {
      if (typeof message.content === 'string') {
        this.assistant().appendText(message.content)
        return
      }
      for (const part of message.content) {
        if (part.type === 'text') this.assistant().appendText(part.text)
        else if (part.type === 'reasoning')
          this.assistant().appendThinking(part.text)
        else if (part.type === 'tool-call') {
          this.current = undefined
          this.addTool(part.toolCallId, part.toolName, part.input)
        }
      }
    } else if (message.role === 'tool') {
      for (const part of message.content)
        if (part.type === 'tool-result')
          this.tools
            .get(part.toolCallId)
            ?.setResult(part.output, part.output.type.startsWith('error'))
    }
  }

  private assistant(): AssistantMessage {
    if (!this.current) {
      this.current = new AssistantMessage(this.hideThinking)
      this.allAssistant.push(this.current)
      this.chat.addChild(this.current)
    }
    return this.current
  }

  private addTool(id: string, name: string, input: unknown): void {
    const block = new ToolBlock(name, input, this.toolsExpanded)
    this.tools.set(id, block)
    this.allTools.push(block)
    this.chat.addChild(block)
  }

  private addNotice(
    text: string,
    level: LogLevel | 'dim' = 'info',
    raw = false,
  ): void {
    const trimmed = text.replace(/^\n+|\n+$/g, '')
    if (!trimmed.trim()) return
    this.chat.addChild(notice(trimmed, level, raw))
    this.tui.requestRender()
  }

  private startLoader(message: string): void {
    if (!this.loader) {
      this.loader = new Loader(
        this.tui,
        (t) => theme.fg('accent', t),
        (t) => theme.fg('muted', t),
        message,
      )
      this.status.clear()
      this.status.addChild(new Spacer(1))
      this.status.addChild(this.loader)
      this.loader.start()
    }
    this.setLoader(message)
  }

  private setLoader(message: string): void {
    this.loader?.setMessage(
      `${message} ${theme.fg('dim', '(Esc to interrupt)')}`,
    )
  }

  private stopLoader(): void {
    this.loader?.stop()
    this.loader = undefined
    this.status.clear()
  }

  private updatePending(): void {
    this.pending.clear()
    const { steering, followUp } = this.session.queue
    if (!steering.length && !followUp.length) return
    this.pending.addChild(new Spacer(1))
    for (const text of steering)
      this.pending.addChild(
        new TruncatedText(theme.fg('dim', `Steering: ${oneLine(text)}`), 1, 0),
      )
    for (const text of followUp)
      this.pending.addChild(
        new TruncatedText(theme.fg('dim', `Follow-up: ${oneLine(text)}`), 1, 0),
      )
    this.pending.addChild(
      new TruncatedText(
        theme.fg('dim', '↳ Alt+Up to edit queued messages'),
        1,
        0,
      ),
    )
  }

  private renderWidgets(): void {
    this.widgets.clear()
    for (const lines of this.widgetLines.values())
      this.widgets.addChild(new Text(lines.join('\n'), 1, 0))
    this.tui.requestRender()
  }

  private updateBorder(): void {
    this.editor.borderColor = theme.thinkingBorder(this.session.thinkingLevel)
    this.tui.requestRender()
  }

  // ---------------------------------------------------------------- Input

  private setupKeys(): void {
    const { editor } = this
    editor.onSubmit = (text) => void this.submit(text)
    const actions = editor.actions
    actions.set('interrupt', () => {
      if (this.session.isRunning) this.restoreQueue({ abort: true })
    })
    actions.set('dequeue', () => {
      if (!this.restoreQueue()) this.addNotice('No queued messages', 'dim')
    })
    actions.set('followUp', () => {
      const text = editor.getExpandedText().trim()
      if (!text) return
      if (!this.session.isRunning) {
        editor.setText('')
        void this.submit(text)
        return
      }
      editor.addToHistory(text)
      editor.setText('')
      void this.queue(text, 'followUp')
    })
    actions.set('clear', () => {
      const now = Date.now()
      if (now - this.lastCtrlC < 500) void this.shutdown()
      else {
        editor.setText('')
        this.lastCtrlC = now
      }
    })
    actions.set('exit', () => void this.shutdown())
    actions.set('cycleThinking', () => {
      const levels = THINKING_LEVELS
      const next =
        levels[
          (levels.indexOf(this.session.thinkingLevel) + 1) % levels.length
        ]!
      this.setThinking(next)
    })
    actions.set('selectModel', () => void this.selectModel())
    actions.set('expandTools', () => {
      this.toolsExpanded = !this.toolsExpanded
      for (const block of this.allTools) block.setExpanded(this.toolsExpanded)
      this.chat.invalidate()
      this.tui.requestRender()
    })
    actions.set('toggleThinking', () => {
      this.hideThinking = !this.hideThinking
      for (const message of this.allAssistant)
        message.setHideThinking(this.hideThinking)
      this.tui.requestRender()
    })
  }

  /** Move queued messages back to the editor (like pi); with abort, also interrupt the current task. Returns how many were moved. */
  private restoreQueue(options: { abort?: boolean } = {}): number {
    const { steering, followUp } = this.session.clearQueue()
    const queued = [...steering, ...followUp]
    if (queued.length) {
      const text = [...queued, this.editor.getText()]
        .filter((t) => t.trim())
        .join('\n\n')
      this.editor.setText(text)
    }
    this.updatePending()
    if (options.abort) void this.session.abort()
    this.tui.requestRender()
    return queued.length
  }

  private isExtensionCommand(text: string): boolean {
    if (!text.startsWith('/')) return false
    const name = text.slice(1).split(/\s/, 1)[0]
    return this.vela.commands().some((c) => c.name === name)
  }

  private async queue(text: string, behavior: 'steer' | 'followUp') {
    try {
      await this.session.prompt(text, { streamingBehavior: behavior })
    } catch (error) {
      this.addNotice(this.describeError(error), 'error')
    }
    this.updatePending()
    this.tui.requestRender()
  }

  async submit(raw: string): Promise<void> {
    const text = raw.trim()
    if (!text) return
    this.editor.addToHistory(text)
    this.editor.setText('')
    const name = text.split(/\s+/, 1)[0] ?? ''
    const args = text.slice(name.length).trim()
    switch (name) {
      case '/exit':
      case '/quit':
        await this.shutdown()
        return
      case '/hotkeys':
        this.addNotice(HOTKEYS.join('\n'))
        return
      case '/new':
        await this.switchSession(this.options.newSessionId(), false)
        return
      case '/resume': {
        if (this.session.isRunning) {
          this.addNotice(
            'A task is running; press Esc to interrupt or wait for it to finish',
            'warning',
          )
          return
        }
        const id = await this.pickSession()
        if (id) await this.switchSession(id, true)
        return
      }
      case '/name':
        if (!args) {
          this.addNotice(`Session name: ${this.session.name ?? '(unnamed)'}`)
          return
        }
        this.session.setName(args)
        // Saving mid-run is unsafe (it would interleave with this turn's save); the turn saves when it ends
        if (!this.session.isRunning) await this.session.save()
        this.addNotice(`Session name: ${args}`, 'dim')
        this.tui.requestRender()
        return
      case '/model':
        if (!args) {
          await this.selectModel()
          return
        }
        break
      case '/thinking':
        if (!args) {
          const level = await this.select(
            'Thinking level',
            THINKING_LEVELS.map((l) => ({
              value: l,
              label: l === this.session.thinkingLevel ? `${l} ✓` : l,
            })),
            this.session.thinkingLevel,
          )
          if (level) this.setThinking(level as ThinkingLevel)
          return
        }
        break
      case '/compact':
        if (this.session.isRunning) {
          this.addNotice(
            'A task is running; press Esc to interrupt or wait for it to finish',
            'warning',
          )
          return
        }
        this.startLoader('Compacting context…')
        try {
          await this.session.compact(args || undefined)
        } catch (error) {
          this.addNotice(`Compaction failed: ${errorMessage(error)}`, 'error')
        } finally {
          this.stopLoader()
          this.tui.requestRender()
        }
        return
    }
    // Slash commands run as usual (also while running); other input while running steers (like pi)
    const running = this.session.isRunning
    if (!running || text.startsWith('/')) {
      const handled = this.dispatch(text, {
        vela: this.vela,
        internals: velaInternals(this.vela),
        session: this.session,
        print: this.commandOutput(),
      })
      if (handled instanceof Promise)
        await handled.catch((error) =>
          this.addNotice(errorMessage(error), 'error'),
        )
      if (handled) {
        this.updateBorder()
        return
      }
    }
    // Extension commands run immediately, even while running
    if (running && !this.isExtensionCommand(text)) {
      await this.queue(text, 'steer')
      return
    }
    try {
      await this.session.prompt(text)
    } catch (error) {
      // Loop errors were already shown at agent_end
      if (error !== this.shownError)
        this.addNotice(`Error: ${this.describeError(error)}`, 'error')
    }
    this.tui.requestRender()
  }

  private describeError(error: unknown): string {
    return this.options.describeError?.(error) ?? errorMessage(error)
  }

  /** Commands print line by line: lines from one synchronous call merge into one notice so there's no blank line between them; the command's own colors are kept */
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

  private setThinking(level: ThinkingLevel): void {
    try {
      this.session.setThinkingLevel(level)
      this.addNotice(`thinking: ${level}`, 'dim')
    } catch (error) {
      this.addNotice(errorMessage(error), 'error')
    }
    this.updateBorder()
  }

  private async selectModel(): Promise<void> {
    let current: string | undefined
    try {
      current = this.session.modelInfo.ref
    } catch {}
    const models = this.vela.models()
    if (!models.length) {
      this.addNotice(
        'No configured models to list: switch directly with /model provider/id',
        'dim',
      )
      return
    }
    const ref = await this.select(
      'Select Model',
      models.map((m) => ({
        value: m.ref,
        label: m.ref === current ? `${m.ref} ✓` : m.ref,
        description: [
          m.name,
          m.contextWindow && `${Math.round(m.contextWindow / 1000)}k`,
          m.reasoning === false && 'no thinking',
        ]
          .filter(Boolean)
          .join(' · '),
      })),
      current,
    )
    if (!ref) return
    try {
      this.session.setModel(ref)
      this.addNotice(`Model: ${this.session.modelInfo.ref}`, 'dim')
      this.renderHeader(true)
    } catch (error) {
      this.addNotice(errorMessage(error), 'error')
    }
    this.updateBorder()
  }

  // ---------------------------------------------------------------- Dialogs

  /** Show a dialog in place of the editor (like pi's ExtensionSelector); one at a time, the rest queue. */
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
  ): Promise<string | undefined> {
    return this.dialog<string | undefined>((done) => {
      const list = new SelectList(items, 10, selectListTheme)
      const index = items.findIndex((item) => item.value === selected)
      if (index > 0) list.setSelectedIndex(index)
      list.onSelect = (item) => done(item.value)
      list.onCancel = () => done(undefined)
      return {
        component: dialogBox(
          title,
          list,
          '↑↓ navigate · Enter select · Esc cancel',
        ),
        focus: list,
      }
    })
  }

  input(title: string, placeholder?: string): Promise<string | undefined> {
    return this.dialog<string | undefined>((done) => {
      const input = new Input()
      input.onSubmit = (value) => done(value.trim() || undefined)
      input.onEscape = () => done(undefined)
      const hint = placeholder
        ? `${placeholder} · Enter confirm · Esc cancel`
        : 'Enter confirm · Esc cancel'
      return { component: dialogBox(title, input, hint), focus: input }
    })
  }

  // ---------------------------------------------------------------- Exit

  /** console output would garble the screen while the TUI runs: turn it into notice lines in the chat log */
  private captureConsole(): void {
    const original = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    }
    const to =
      (level: LogLevel | 'dim') =>
      (...args: unknown[]) =>
        this.addNotice(format(...args), level)
    console.log = to('dim')
    console.info = to('dim')
    console.warn = to('warning')
    console.error = to('error')
    this.restoreConsole = () => Object.assign(console, original)
  }

  /**
   * Like pi: SIGTERM / SIGHUP exit cleanly (session wrap-up, extension session_shutdown);
   * on a real terminal, an uncaught exception restores the terminal before exiting so it isn't left in raw mode with the cursor hidden.
   */
  private registerSignalHandlers(): void {
    const signals: NodeJS.Signals[] =
      process.platform === 'win32' ? ['SIGTERM'] : ['SIGTERM', 'SIGHUP']
    for (const signal of signals) {
      const handler = () => void this.shutdown()
      process.prependListener(signal, handler)
      this.cleanups.push(() => process.off(signal, handler))
    }
    if (this.options.terminal) return
    const crash = (error: Error) => {
      try {
        this.tui.stop()
      } catch {}
      this.restoreConsole?.()
      console.error('vela exited due to an uncaught exception:', error)
      process.exit(1)
    }
    process.prependListener('uncaughtException', crash)
    this.cleanups.push(() => process.off('uncaughtException', crash))
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    this.stopLoader()
    this.tui.stop()
    this.restoreConsole?.()
    try {
      await this.options.onExit()
    } finally {
      this.resolveExit()
    }
  }
}

/** Footer (like pi): directory and session name; usage, context percentage, model and thinking; extension statuses. */
class Footer implements Component {
  private readonly statuses = new Map<string, string>()

  constructor(
    private readonly cwd: string,
    private readonly session: () => VelaSession | undefined,
  ) {}

  setStatus(key: string, text?: string): void {
    if (text) this.statuses.set(key, text)
    else this.statuses.delete(key)
  }

  invalidate(): void {}

  render(width: number): string[] {
    const session = this.session()
    if (!session) return []
    const home = homedir()
    const dir = this.cwd.startsWith(home)
      ? `~${this.cwd.slice(home.length)}`
      : this.cwd
    const usage = session.usage
    const totals = usage.totals
    let model = '(no model)'
    try {
      model = session.modelInfo.ref
    } catch {}
    const left = [
      `↑${compact(totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens)}`,
      `↓${compact(totals.outputTokens)}`,
      totals.cost ? `$${totals.cost.toFixed(3)}` : undefined,
      `${usage.percent}%`,
    ]
      .filter(Boolean)
      .join(' ')
    const right = `${model} · ${session.thinkingLevel}`
    const gap = Math.max(
      1,
      width - visibleWidth(left) - visibleWidth(right) - 2,
    )
    const lines = [
      truncateToWidth(
        ` ${dir} · ${sanitize(session.name ?? session.id)}`,
        width,
      ),
      truncateToWidth(` ${left}${' '.repeat(gap)}${right}`, width),
    ]
    if (this.statuses.size)
      lines.push(
        truncateToWidth(` ${[...this.statuses.values()].join(' · ')}`, width),
      )
    return lines.map((line) => theme.fg('dim', line))
  }
}

function dialogBox(title: string, body: Component, hint: string): Component {
  const box = new Container()
  box.addChild(new Spacer(1))
  box.addChild(new Text(theme.fg('border', '─'.repeat(3)), 0, 0))
  box.addChild(new Text(theme.bold(title), 1, 0))
  box.addChild(new Spacer(1))
  box.addChild(body)
  box.addChild(new Spacer(1))
  box.addChild(new Text(theme.fg('dim', hint), 1, 0))
  return box
}

function contextLine(event: Extract<VelaEvent, { type: 'context' }>): string {
  switch (event.action) {
    case 'micro':
      return `[context] Folded old tool results ${event.before} → ${event.after} tokens`
    case 'summary-required':
      return `[context] ${event.before} tokens, summarizing before the next request`
    case 'summary':
      return `[context] Summarized ${event.before} → ${event.after} tokens`
    case 'compact':
      return `[context] Manually compacted ${event.before} → ${event.after} tokens`
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ')
}

function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)
}
