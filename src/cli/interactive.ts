import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
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
} from '@earendil-works/pi-tui'
import type {
  ImageContent,
  LoginOptions,
  ModelMessage,
  SessionUI,
  ThinkingLevel,
  VelaEvent,
  VelaSession,
} from '../core.ts'
import { resolveBinary } from '../core.ts'
import { inspectSession, inspectVela } from '../diagnostics.ts'
import { imageMimeType } from '../images/index.ts'
import {
  branchSummaryMessageText,
  contextEntries,
  type SessionEntry,
  summaryMessageText,
} from '../session/entries.ts'
import type { Vela } from '../vela.ts'
import {
  copyToClipboard,
  readClipboardImage,
  readClipboardText,
} from './clipboard.ts'
import { createCliDispatcher } from './dispatcher.ts'
import { formatContextFileList } from './status-display.ts'
import { loginCommand, logoutCommand } from './tui/auth-dialogs.ts'
import { CLI_COMMANDS, HOTKEYS, TUI_COMMANDS } from './tui/commands.ts'
import {
  AssistantMessage,
  BashExecution,
  CustomMessageBlock,
  compactionLine,
  contextLine,
  dialogBox,
  errorMessage,
  imagePlaceholder,
  isDeadTerminalError,
  lastAnswer,
  notice,
  oneLine,
  SecretInput,
  sanitize,
  ToolBlock,
  UserMessage,
} from './tui/components.ts'
import { VelaEditor } from './tui/editor.ts'
import { Footer } from './tui/footer.ts'
import { cycleModel, selectModel } from './tui/model-selector.ts'
import { forkCommand, treeCommand } from './tui/session-tree.ts'
import { editorTheme, selectListTheme, theme } from './tui/theme.ts'

export interface InteractiveOptions {
  vela: Vela
  /** Command-line prompts and attachments, sent after startup. */
  messages?: string[]
  images?: ImageContent[]
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
  /** Clipboard for `/copy`; defaults to the system clipboard (tests pass a fake) */
  copyToClipboard?: (text: string) => Promise<void>
  /** Defaults to pi-tui's native clipboard or wl-paste on Wayland. */
  readClipboardImage?: () => Promise<Uint8Array | undefined>
  /** Text fallback for the explicit paste shortcut when there is no image. */
  readClipboardText?: () => Promise<string | undefined>
  /** Passed to `vela.login()` by `/login` (the CLI's installation id for Sign in with ChatGPT) */
  loginOptions?: LoginOptions
  /** Opens a sign-in URL; defaults to the system browser (tests pass a fake) */
  openBrowser?: (url: string) => void
  /** Settings `enabledModels`: the models Ctrl+P cycles through */
  enabledModels?: string[]
  /** Configured agent directory (`VELA_DIR` or `~/.vela`), for `/status` path shortening */
  agentDir?: string
}

type LogLevel = 'info' | 'warning' | 'error'

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
  for (const [index, message] of (options.messages ?? []).entries()) {
    await mode.submit(message, index === 0 ? options.images : undefined)
  }
  return mode.exited
}

export class InteractiveMode {
  readonly tui: TuiMainScreen
  private readonly terminal: Terminal
  private readonly vela: Vela
  private readonly options: InteractiveOptions
  private session!: VelaSession

  private readonly header = new Container()
  private readonly chat = new Container()
  /** `!` commands run while the agent works; they move to the chat when it stops, where they are recorded (like pi) */
  private readonly pendingBash = new Container()
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
  private readonly allBash: BashExecution[] = []
  private toolsExpanded = false
  private hideThinking = false
  private lastCtrlC = 0
  private shownError?: unknown
  private readonly widgetLines = new Map<string, string[]>()
  private dialogs = Promise.resolve()
  private restoreConsole?: () => void
  private readonly cleanups: (() => void)[] = []
  private shuttingDown = false
  private clipboardDir?: string
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
    this.terminal = options.terminal ?? new ProcessTerminal()
    this.tui = new TuiMainScreen(this.terminal)
    this.editor = new VelaEditor(this.tui, editorTheme, { paddingX: 1 })
    this.footer = new Footer(this.vela.cwd, () => this.session)
    this.dispatch = createCliDispatcher(this.vela)
    for (const child of [
      this.header,
      this.chat,
      this.pendingBash,
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
    const contextFiles = formatContextFileList(inspectVela(vela).contextFiles, {
      cwd: vela.cwd,
      homeDir: homedir(),
      agentDir: options.agentDir,
    })
    if (contextFiles) this.addNotice(`[context] ${contextFiles}`)
    this.setAutocomplete()
    // Like pi: @ file completion needs fd; find (or download) it after the UI is up so startup doesn't block
    resolveBinary(vela, 'fd')
      .then((fdPath) => this.setAutocomplete(fdPath))
      .catch((error) =>
        this.addNotice(
          `@ file completion is off: ${errorMessage(error)}`,
          'warning',
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
          ...inspectVela(vela).promptTemplates.map((t) => ({
            name: t.name,
            description: t.argumentHint
              ? `${t.argumentHint} — ${t.description}`
              : t.description,
          })),
          ...inspectVela(vela).skills.map((s) => ({
            name: `skill:${s.name}`,
            description: s.description,
          })),
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
      this.renderHistory(session.getBranch())
      this.addNotice(
        `Resumed session ${session.name ?? session.id}, ${session.messages.length} messages`,
        'dim',
      )
    } else if (session.parentSession && session.messages.length) {
      // A fork / clone opens with the copied branch
      this.renderHistory(session.getBranch())
      this.addNotice(
        `Session ${session.id}, copied from ${session.parentSession}`,
        'dim',
      )
    }
    if (process.env.VELA_DEBUG === '1') {
      const lines = (await inspectSession(this.vela, session)).stages.map(
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
    for (const block of this.allTools) block.stop()
    this.chat.clear()
    this.pendingBash.clear()
    this.tools.clear()
    this.allTools.length = 0
    this.allAssistant.length = 0
    this.allBash.length = 0
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

  /**
   * Render history when resuming, forking or moving in the tree (like pi, from the current branch's entries):
   * the summary and what the model still sees, with the original tool output, edit diffs, nested calls and
   * `!` commands.
   */
  private renderHistory(branch: SessionEntry[]): void {
    const { compaction, entries: shown } = contextEntries(branch)
    if (compaction)
      this.renderMessage({
        role: 'user',
        content: summaryMessageText(compaction.summary),
      })
    for (const entry of shown) {
      if (entry.type === 'bash_execution') {
        this.addBash(entry.command, !!entry.excludeFromContext).setResult(entry)
        this.current = undefined
        continue
      }
      if (entry.type === 'branch_summary') {
        if (entry.summary)
          this.renderMessage({
            role: 'user',
            content: branchSummaryMessageText(entry.summary),
          })
        continue
      }
      if (entry.type === 'custom_message') {
        this.renderMessage({ role: 'user', content: entry.content }, true, {
          customType: entry.customType,
          display: entry.display,
        })
        continue
      }
      if (entry.type !== 'message' || entry.stopReason) continue
      const { message } = entry
      if (message.role !== 'tool') {
        this.renderMessage(message, true)
        continue
      }
      for (const part of message.content) {
        if (part.type !== 'tool-result') continue
        const block = this.tools.get(part.toolCallId)
        if (!block) continue
        for (const call of entry.nestedCalls?.[part.toolCallId]?.calls ?? []) {
          block.addNested(call.id, call.name, call.arguments)
          if (call.status !== 'unfinished')
            block.setNestedResult(
              call.id,
              call.status === 'error',
              call.durationMs,
            )
        }
        block.setResult(
          part.output,
          part.output.type.startsWith('error'),
          entry.details?.[part.toolCallId],
        )
      }
    }
    this.current = undefined
  }

  // ---------------------------------------------------------------- Events

  private onEvent(event: VelaEvent, sessionId: string): void {
    if (sessionId !== this.session.id) return
    switch (event.type) {
      case 'agent_start':
        this.shownError = undefined
        this.startLoader('Thinking…')
        break
      case 'message_start':
        if (event.message.role === 'user')
          this.renderMessage(event.message, false, event.custom)
        break
      case 'turn_start':
        this.current = undefined
        this.startLoader('Thinking…')
        break
      case 'message_update': {
        const update = event.assistantMessageEvent
        if (update.type === 'thinking_delta')
          this.assistant().appendThinking(update.delta)
        else if (update.type === 'text_delta') {
          this.assistant().appendText(update.delta)
          this.setLoader('Answering…')
        } else if (update.type === 'toolcall_end') {
          // Like pi: the tool block appears once the call is written; its result arrives with tool_execution_end
          this.current = undefined
          this.addTool(
            update.toolCall.toolCallId,
            update.toolCall.toolName,
            update.toolCall.input,
          )
        }
        break
      }
      case 'message_end':
        if (event.message.role !== 'assistant') break
        // Like pi: a failed attempt keeps its partial text, marked as failed; a retry starts a new message
        if (event.stopReason === 'error' && this.current?.hasContent)
          this.current.markFailed()
        this.current = undefined
        break
      case 'tool_execution_start':
        // Calls made through ctx.executeTool() are listed inside the top-level call's block (like pi)
        if (event.parentToolCallId) {
          this.rootTool(event.parentToolCallId)?.addNested(
            event.toolCallId,
            event.toolName,
            event.args,
          )
          break
        }
        if (!this.tools.has(event.toolCallId))
          this.addTool(event.toolCallId, event.toolName, event.args)
        this.tools.get(event.toolCallId)?.start()
        this.setLoader(`Running ${event.toolName}…`)
        break
      case 'tool_execution_update':
        if (!event.parentToolCallId)
          this.tools.get(event.toolCallId)?.update(event.partialResult)
        break
      case 'tool_execution_end':
        if (event.parentToolCallId) {
          this.rootTool(event.parentToolCallId)?.setNestedResult(
            event.toolCallId,
            event.isError,
            event.durationMs,
          )
          break
        }
        this.tools
          .get(event.toolCallId)
          ?.setResult(
            event.result,
            event.isError,
            event.details,
            event.durationMs,
          )
        break
      case 'auto_retry_start':
        this.addNotice(
          `Request failed, retrying in ${Math.round(event.delayMs / 1000)}s (${event.attempt}/${event.maxAttempts}): ${event.errorMessage}`,
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
        for (const block of this.allTools) block.stop()
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
        this.movePendingBash()
        break
      case 'queue_update':
        this.updatePending()
        break
      case 'context_prepare':
        this.addNotice(contextLine(event), 'dim')
        if (event.action === 'summary-required')
          this.setLoader('Compacting context…')
        break
      case 'compaction_start':
        this.setLoader('Compacting context…')
        break
      case 'compaction_end':
        if (event.result) this.addNotice(compactionLine(event), 'dim')
        else if (event.errorMessage)
          this.addNotice(
            `[context] Compaction failed: ${event.errorMessage}`,
            'error',
          )
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
      case 'notify':
        this.addNotice(event.message, event.level)
        break
    }
    this.tui.requestRender()
  }

  private renderMessage(
    message: ModelMessage,
    history = false,
    custom = this.session.customMessageOf(message),
  ): void {
    if (message.role === 'user') {
      const text =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .map((part) =>
                part.type === 'text'
                  ? part.text
                  : `\n${imagePlaceholder(part) ?? ''}`,
              )
              .join('')
      // Like pi: an extension's custom message shows only with `display: true`, in its own block
      if (custom) {
        if (custom.display)
          this.chat.addChild(new CustomMessageBlock(custom.customType, text))
      } else if (text.trim()) this.chat.addChild(new UserMessage(text))
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
    const block = new ToolBlock(name, input, this.toolsExpanded, () =>
      this.tui.requestRender(),
    )
    this.tools.set(id, block)
    this.allTools.push(block)
    this.chat.addChild(block)
  }

  private addBash(
    command: string,
    excludeFromContext: boolean,
    container: Container = this.chat,
  ): BashExecution {
    const block = new BashExecution(
      command,
      excludeFromContext,
      this.toolsExpanded,
    )
    this.allBash.push(block)
    container.addChild(block)
    return block
  }

  /** The agent stopped: `!` blocks run meanwhile go to the chat, where their results are now recorded */
  private movePendingBash(): void {
    for (const child of [...this.pendingBash.children])
      this.chat.addChild(child)
    this.pendingBash.clear()
  }

  /** `!cmd` / `!!cmd` (like pi): runs the command; its output goes to the model with the next message unless `!!` */
  private async runBash(command: string, excludeFromContext: boolean) {
    const session = this.session
    const block = this.addBash(
      command,
      excludeFromContext,
      session.isRunning ? this.pendingBash : this.chat,
    )
    this.current = undefined
    this.tui.requestRender()
    try {
      const result = await session.executeBash(command, {
        excludeFromContext,
        onUpdate: (output) => {
          block.update(output)
          this.tui.requestRender()
        },
      })
      block.setResult(result)
    } catch (error) {
      block.setFailed()
      this.addNotice(`Shell command failed: ${errorMessage(error)}`, 'error')
    }
    this.tui.requestRender()
  }

  /** The top-level block a nested call belongs to: nested ids are `<parent>/<n>`, at any depth */
  private rootTool(parentToolCallId: string): ToolBlock | undefined {
    return (
      this.tools.get(parentToolCallId) ??
      this.tools.get(parentToolCallId.split('/', 1)[0] as string)
    )
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
    // Bash mode (input starts with `!`) has its own border color, like pi
    this.editor.borderColor = this.editor.getText().trimStart().startsWith('!')
      ? theme.bashBorder
      : theme.thinkingBorder(this.session.thinkingLevel)
    this.tui.requestRender()
  }

  // ---------------------------------------------------------------- Input

  private setupKeys(): void {
    const { editor } = this
    editor.onSubmit = (text) => void this.submit(text)
    let bashMode = false
    editor.onChange = (text) => {
      const next = text.trimStart().startsWith('!')
      if (next === bashMode) return
      bashMode = next
      this.updateBorder()
    }
    const actions = editor.actions
    actions.set('interrupt', () => {
      // Like pi: a running `!` command first, then the agent, then leave bash mode
      if (this.session.isBashRunning) this.session.abortBash()
      else if (this.session.isRunning) this.restoreQueue({ abort: true })
      else if (editor.getText().trimStart().startsWith('!')) editor.setText('')
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
    actions.set('pasteImage', () => void this.pasteClipboard())
    actions.set('cycleThinking', () => {
      // Like pi: only the levels the model supports
      const levels = this.session.availableThinkingLevels()
      if (levels.length < 2) {
        this.addNotice(
          'This model has no thinking levels to cycle through',
          'dim',
        )
        return
      }
      const next =
        levels[
          (levels.indexOf(this.session.thinkingLevel) + 1) % levels.length
        ]!
      this.setThinking(next)
    })
    actions.set('selectModel', () => void this.selectModel())
    actions.set('cycleModelForward', () => this.cycleModel(1))
    actions.set('cycleModelBackward', () => this.cycleModel(-1))
    actions.set('expandTools', () => {
      this.toolsExpanded = !this.toolsExpanded
      for (const block of [...this.allTools, ...this.allBash])
        block.setExpanded(this.toolsExpanded)
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
      await this.session.prompt(text, {
        streamingBehavior: behavior,
        source: 'interactive',
      })
    } catch (error) {
      this.addNotice(this.describeError(error), 'error')
    }
    this.updatePending()
    this.tui.requestRender()
  }

  private async pasteClipboard(): Promise<void> {
    try {
      const bytes = await (
        this.options.readClipboardImage ?? readClipboardImage
      )()
      const text = bytes?.length
        ? undefined
        : await (this.options.readClipboardText ?? readClipboardText)()
      if (!bytes?.length) {
        if (text) {
          this.editor.insertTextAtCursor(text)
          this.tui.requestRender()
        }
        return
      }
      const mimeType = imageMimeType(Buffer.from(bytes))
      if (!mimeType) throw new Error('Unsupported clipboard image format')
      this.clipboardDir ??= mkdtempSync(join(tmpdir(), 'vela-clipboard-'))
      const file = join(
        this.clipboardDir,
        `${randomUUID()}.${mimeType.slice('image/'.length)}`,
      )
      writeFileSync(file, bytes, { mode: 0o600 })
      const cursor = this.editor.getCursor()
      const before =
        this.editor.getLines()[cursor.line]?.slice(0, cursor.col) ?? ''
      this.editor.insertTextAtCursor(
        `${before && !/\s$/.test(before) ? ' ' : ''}${file} `,
      )
      this.tui.requestRender()
    } catch (error) {
      this.addNotice(
        `Clipboard paste failed: ${errorMessage(error)}`,
        'warning',
      )
    }
  }

  async submit(raw: string, images?: ImageContent[]): Promise<void> {
    const text = raw.trim()
    if (!text && !images?.length) return
    this.editor.addToHistory(text)
    this.editor.setText('')
    if (text.startsWith('!')) {
      const excluded = text.startsWith('!!')
      const command = text.slice(excluded ? 2 : 1).trim()
      if (command) {
        if (this.session.isBashRunning) {
          this.addNotice(
            'A shell command is already running; press Esc to cancel it first',
            'warning',
          )
          this.editor.setText(text)
          return
        }
        await this.runBash(command, excluded)
        return
      }
    }
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
      case '/copy':
        await this.copyLastAnswer()
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
        await this.session.save()
        this.addNotice(`Session name: ${args}`, 'dim')
        this.tui.requestRender()
        return
      case '/model':
        if (!args) {
          await this.selectModel()
          return
        }
        break
      case '/login':
        await this.loginCommand(args)
        return
      case '/logout':
        await this.logoutCommand(args)
        return
      case '/thinking':
        if (!args) {
          const level = await this.select(
            'Thinking level',
            this.session.availableThinkingLevels().map((l) => ({
              value: l,
              label: l === this.session.thinkingLevel ? `${l} ✓` : l,
            })),
            this.session.thinkingLevel,
          )
          if (level) this.setThinking(level as ThinkingLevel)
          return
        }
        break
      case '/tree':
        await this.treeCommand()
        return
      case '/fork':
        await this.forkCommand()
        return
      case '/clone':
        await this.forkCommand(true)
        return
      case '/export':
        try {
          const path = args.endsWith('.jsonl')
            ? await this.session.exportJsonl(args)
            : await this.session.exportHtml(args || undefined)
          this.addNotice(`Exported to ${path}`, 'dim')
        } catch (error) {
          this.addNotice(`Export failed: ${errorMessage(error)}`, 'error')
        }
        return
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
        session: this.session,
        print: this.commandOutput(),
        agentDir: this.options.agentDir,
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
      await this.session.prompt(text, { source: 'interactive', images })
    } catch (error) {
      // Loop errors were already shown at agent_end
      if (error !== this.shownError)
        this.addNotice(`Error: ${this.describeError(error)}`, 'error')
    }
    this.tui.requestRender()
  }

  // ---------------------------------------------------------------- Session tree

  private busyNotice(): boolean {
    if (!this.session.isRunning) return false
    this.addNotice(
      'A task is running; press Esc to interrupt or wait for it to finish',
      'warning',
    )
    return true
  }

  /** `/tree` (like pi): pick an entry, choose whether to summarize the branch being left, then move. */
  private treeHost() {
    return {
      session: this.session,
      options: this.options,
      select: this.select.bind(this),
      input: this.input.bind(this),
      addNotice: this.addNotice.bind(this),
      busyNotice: this.busyNotice.bind(this),
      startLoader: this.startLoader.bind(this),
      stopLoader: this.stopLoader.bind(this),
      resetChat: this.resetChat.bind(this),
      renderHistory: this.renderHistory.bind(this),
      updateBorder: this.updateBorder.bind(this),
      switchSession: this.switchSession.bind(this),
      editor: this.editor,
      tui: this.tui,
    }
  }
  private treeCommand(): Promise<void> {
    return treeCommand(this.treeHost())
  }
  private forkCommand(clone = false): Promise<void> {
    return forkCommand(this.treeHost(), clone)
  }

  /** `/copy` (like pi): the last assistant answer with text goes to the clipboard */
  private async copyLastAnswer(): Promise<void> {
    const text = lastAnswer(this.session.messages)
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

  private modelHost() {
    const mode = this
    return {
      vela: this.vela,
      get session() {
        return mode.session
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
    cycleModel(this.modelHost(), direction)
  }

  private authHost() {
    return {
      vela: this.vela,
      options: this.options,
      select: this.select.bind(this),
      input: this.input.bind(this),
      addNotice: this.addNotice.bind(this),
      renderHeader: this.renderHeader.bind(this),
    }
  }
  private loginCommand(args: string): Promise<void> {
    return loginCommand(this.authHost(), args)
  }
  private logoutCommand(args: string): Promise<void> {
    return logoutCommand(this.authHost(), args)
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

  /** A one-line input dialog; `signal` closes it (resolving undefined) from outside; `secret` masks what is typed */
  input(
    title: string,
    placeholder?: string,
    signal?: AbortSignal,
    secret = false,
  ): Promise<string | undefined> {
    if (signal?.aborted) return Promise.resolve(undefined)
    return this.dialog<string | undefined>((close) => {
      let closed = false
      const done = (value: string | undefined) => {
        if (closed) return
        closed = true
        close(value)
      }
      // A prompt closed while it waited behind another dialog closes as soon as it opens
      if (signal?.aborted) queueMicrotask(() => done(undefined))
      else
        signal?.addEventListener('abort', () => done(undefined), { once: true })
      const input = secret ? new SecretInput() : new Input()
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
      const handler = () => void this.shutdown({ fromSignal: true })
      process.prependListener(signal, handler)
      this.cleanups.push(() => process.off(signal, handler))
    }
    if (this.options.terminal) return
    // Like pi: once the terminal is gone, reads, writes and setRawMode fail with EIO / EPIPE / ENOTTY.
    // Without a listener those errors are uncaught; exit without touching the terminal again.
    const terminalError = (error: Error) => {
      if (isDeadTerminalError(error)) this.emergencyExit()
      throw error
    }
    for (const stream of [process.stdin, process.stdout, process.stderr]) {
      stream.on('error', terminalError)
      this.cleanups.push(() => stream.off('error', terminalError))
    }
    const crash = (error: Error) => {
      if (isDeadTerminalError(error)) this.emergencyExit()
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

  /**
   * Exit: restore the terminal, then wrap up the sessions (`onExit`). After SIGHUP / SIGTERM the
   * sessions are wrapped up first (like pi), since the terminal may already be gone. Restoring a
   * terminal that is gone throws (setRawMode fails with EIO); that must not stop the exit, or the
   * process stays alive polling a dead terminal and spins a CPU.
   */
  async shutdown(options: { fromSignal?: boolean } = {}): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.stopLoader()
    const restore = () => {
      try {
        this.tui.stop()
      } catch {}
      this.restoreConsole?.()
    }
    try {
      if (!options.fromSignal) restore()
      await this.options.onExit()
    } finally {
      if (this.clipboardDir)
        rmSync(this.clipboardDir, { recursive: true, force: true })
      if (options.fromSignal) restore()
      for (const cleanup of this.cleanups.splice(0)) cleanup()
      this.resolveExit()
    }
  }

  /** The terminal is gone (like pi's emergencyTerminalExit): exit without writing restore sequences. */
  private emergencyExit(): never {
    this.shuttingDown = true
    process.exit(129)
  }
}

/** Footer (like pi): directory and session name; usage, context percentage, model and thinking; extension statuses. */
