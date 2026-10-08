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
  /** 启动时的会话 */
  sessionId: string
  /** 启动时恢复这个会话的历史（`-c` / `--session`） */
  resume: boolean
  /** `-r`：启动时先从保存过的会话里选 */
  pick: boolean
  /** 新会话的 id（`/new`） */
  newSessionId: () => string
  /** 会话打开（恢复）之后调用：命令行的 --model / --thinking 覆盖保存的设置；返回模型是否可用 */
  configure: (session: VelaSession) => boolean
  /** 退出前调用（dispose、写录制文件） */
  onExit: () => Promise<void>
  /** 测试用假终端；默认是真实终端 */
  terminal?: Terminal
  /** 接上 logger：warn / error 显示在对话区 */
  attachLogger?: (sink: (level: LogLevel, message: string) => void) => void
}

type LogLevel = 'info' | 'warning' | 'error'

/** CLI 自己处理的命令（扩展命令和 CLI 斜杠命令之外），给补全用 */
const TUI_COMMANDS = [
  { name: 'new', description: '开一个新会话' },
  { name: 'resume', description: '选一个保存过的会话继续' },
  { name: 'name', description: '给当前会话起名字' },
  { name: 'model', description: '选模型（/model provider/id 直接切换）' },
  { name: 'thinking', description: '选 thinking 级别' },
  { name: 'compact', description: '手动压缩上下文（可加关注点）' },
  { name: 'hotkeys', description: '快捷键' },
  { name: 'quit', description: '退出' },
]
const CLI_COMMANDS = [
  { name: 'context', description: '上下文占用' },
  { name: 'usage', description: '用量和费用' },
  { name: 'skill', description: 'skill 列表 / load / unload' },
  { name: 'extensions', description: '已加载的扩展' },
  { name: 'channel', description: '通道' },
  { name: 'role', description: '查看 / 切换角色' },
  { name: 'hooks', description: '已注册的 hook' },
]

const HOTKEYS = [
  'Enter 发送；运行中 Enter = steer（这一步之后插进去）',
  'Alt+Enter 运行中排到任务最后（followUp）',
  'Alt+Up 把排队的消息拿回输入框',
  'Esc 中断（排队的消息放回输入框）',
  'Shift+Tab 切 thinking 级别 · Ctrl+L 选模型',
  'Ctrl+O 展开 / 收起工具输出 · Ctrl+T 显示 / 隐藏 thinking',
  'Ctrl+C 清空输入，连按两次退出 · Ctrl+D 空输入时退出',
]

/**
 * 交互模式（TUI，同 pi 的 interactive mode）：pi-tui 做组件和渲染。
 * 布局：头部 → 对话区 → 排队消息 → 状态行 → 扩展 widget → 输入框 → 底栏。
 * 返回的 Promise 在退出时 resolve。
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
        { value: 'yes', label: '是' },
        { value: 'no', label: '否' },
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
            description: c.description ?? `扩展 ${c.extension}`,
          })),
        ],
        vela.cwd,
      ),
    )
    await vela
      .startChannels()
      .catch((error) =>
        this.addNotice(`通道启动失败: ${errorMessage(error)}`, 'error'),
      )
    this.tui.requestRender()
  }

  // ---------------------------------------------------------------- 会话

  private async openSession(id: string, resume: boolean): Promise<void> {
    const session = this.vela.session(id, { ui: this.ui })
    this.session = session
    this.resetChat()
    let resumed = false
    if (resume) {
      try {
        resumed = await session.resume()
      } catch (error) {
        this.addNotice(`恢复会话失败: ${errorMessage(error)}`, 'error')
      }
    }
    const modelOk = this.options.configure(session)
    this.renderHeader(modelOk)
    if (resumed) {
      this.renderHistory(session.messages)
      this.addNotice(
        `恢复会话 ${session.name ?? session.id}，${session.messages.length} 条消息`,
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
      this.addNotice('有任务正在执行中，先 Esc 中断或等它结束', 'warning')
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
      this.addNotice('没有保存过的会话', 'dim')
      return undefined
    }
    return this.select(
      '选择要恢复的会话',
      saved.map((s) => ({
        value: s.id,
        label: oneLine(sanitize(s.name ?? s.firstMessage)).slice(0, 60),
        description: `${sanitize(s.id)} · ${s.messageCount} 条 · ${s.updatedAt}`,
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
      `${theme.bold(theme.fg('accent', 'Vela'))} ${theme.fg('dim', `会话 ${this.session.id}`)}`,
      theme.fg(
        'dim',
        `Esc 中断 · Ctrl+C 清空 · Ctrl+D 退出 · / 命令 · Alt+Enter 排到最后 · /hotkeys 更多`,
      ),
    ]
    if (extensions.length)
      lines.push(theme.fg('dim', `扩展: ${extensions.join(', ')}`))
    if (!modelOk)
      lines.push(
        theme.fg('yellow', '没有可用的模型：用 /model provider/id 选一个'),
      )
    this.header.addChild(new Spacer(1))
    this.header.addChild(new Text(lines.join('\n'), 1, 0))
  }

  /** 恢复会话时把历史画出来 */
  private renderHistory(messages: ModelMessage[]): void {
    for (const message of messages) this.renderMessage(message, true)
    this.current = undefined
  }

  // ---------------------------------------------------------------- 事件

  private onEvent(event: VelaEvent, sessionId: string): void {
    // 通道活动（飞书等）各一行，不流式显示通道会话的内容
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
            ? `[${event.channel}] 本轮已中断`
            : `[${event.channel}] 本轮停止: ${errorMessage(event.error)}`,
          event.aborted ? 'dim' : 'error',
        )
        return
    }
    if (sessionId !== this.session.id) return
    switch (event.type) {
      case 'agent_start':
        this.shownError = undefined
        this.startLoader('思考中…')
        break
      case 'message':
        if (event.message.role === 'user') this.renderMessage(event.message)
        break
      case 'turn_start':
        this.current = undefined
        this.startLoader('思考中…')
        break
      case 'thinking_delta':
        this.assistant().appendThinking(event.text)
        break
      case 'text_delta':
        this.assistant().appendText(event.text)
        this.setLoader('回答中…')
        break
      case 'tool_call': {
        this.current = undefined
        this.addTool(event.toolCallId, event.toolName, event.input)
        this.setLoader(`运行 ${event.toolName}…`)
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
          `请求失败，${Math.round(event.delayMs / 1000)} 秒后重试（${event.attempt}/${event.maxRetries}）: ${errorMessage(event.error)}`,
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
        if (event.reason === 'aborted') this.addNotice('已中断', 'dim')
        else if (event.reason === 'loop')
          this.addNotice('检测到重复的工具调用，已停止', 'error')
        else if (event.reason === 'error') {
          this.shownError = event.error
          this.addNotice(`出错: ${errorMessage(event.error)}`, 'error')
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
        if (event.action === 'summary-required') this.setLoader('压缩上下文…')
        break
      case 'session_save_failed':
        this.addNotice(`会话保存失败: ${errorMessage(event.error)}`, 'error')
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
    this.loader?.setMessage(`${message} ${theme.fg('dim', '(Esc 中断)')}`)
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
        theme.fg('dim', '↳ Alt+Up 把排队的消息拿回输入框'),
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

  // ---------------------------------------------------------------- 输入

  private setupKeys(): void {
    const { editor } = this
    editor.onSubmit = (text) => void this.submit(text)
    const actions = editor.actions
    actions.set('interrupt', () => {
      if (this.session.isRunning) this.restoreQueue({ abort: true })
    })
    actions.set('dequeue', () => {
      if (!this.restoreQueue()) this.addNotice('没有排队的消息', 'dim')
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

  /** 把排队的消息放回输入框（同 pi）；abort 时随后中断当前任务。返回放回了几条。 */
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
      this.addNotice(errorMessage(error), 'error')
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
      case 'exit':
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
          this.addNotice('有任务正在执行中，先 Esc 中断或等它结束', 'warning')
          return
        }
        const id = await this.pickSession()
        if (id) await this.switchSession(id, true)
        return
      }
      case '/name':
        if (!args) {
          this.addNotice(`会话名: ${this.session.name ?? '（未命名）'}`)
          return
        }
        this.session.setName(args)
        // 运行中保存不安全（会和这一轮的保存交错），这一轮结束时会一起保存
        if (!this.session.isRunning) await this.session.save()
        this.addNotice(`会话名: ${args}`, 'dim')
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
            'thinking 级别',
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
          this.addNotice('有任务正在执行中，先 Esc 中断或等它结束', 'warning')
          return
        }
        this.startLoader('压缩上下文…')
        try {
          await this.session.compact(args || undefined)
        } catch (error) {
          this.addNotice(`压缩失败: ${errorMessage(error)}`, 'error')
        } finally {
          this.stopLoader()
          this.tui.requestRender()
        }
        return
    }
    // 斜杠命令照常执行（运行中也是）；运行中其它输入 steer（同 pi）
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
    // 扩展命令运行中也立即执行
    if (running && !this.isExtensionCommand(text)) {
      await this.queue(text, 'steer')
      return
    }
    try {
      await this.session.prompt(text)
    } catch (error) {
      // loop 里的错误已经在 agent_end 显示过
      if (error !== this.shownError)
        this.addNotice(`出错: ${errorMessage(error)}`, 'error')
    }
    this.tui.requestRender()
  }

  /** 命令逐行 print：同一次同步调用里的几行合成一条提示，免得每行之间空一行；保留命令自己的配色 */
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
        '没有已配置的模型列表：用 /model provider/id 直接切换',
        'dim',
      )
      return
    }
    const ref = await this.select(
      '选择模型',
      models.map((m) => ({
        value: m.ref,
        label: m.ref === current ? `${m.ref} ✓` : m.ref,
        description: [
          m.name,
          m.contextWindow && `${Math.round(m.contextWindow / 1000)}k`,
          m.reasoning === false && '无 thinking',
        ]
          .filter(Boolean)
          .join(' · '),
      })),
      current,
    )
    if (!ref) return
    try {
      this.session.setModel(ref)
      this.addNotice(`模型: ${this.session.modelInfo.ref}`, 'dim')
      this.renderHeader(true)
    } catch (error) {
      this.addNotice(errorMessage(error), 'error')
    }
    this.updateBorder()
  }

  // ---------------------------------------------------------------- 对话框

  /** 在输入框的位置弹一个对话框（同 pi 的 ExtensionSelector）；同时只弹一个，其余排队。 */
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
        component: dialogBox(title, list, '↑↓ 选择 · Enter 确定 · Esc 取消'),
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
        ? `${placeholder} · Enter 确定 · Esc 取消`
        : 'Enter 确定 · Esc 取消'
      return { component: dialogBox(title, input, hint), focus: input }
    })
  }

  // ---------------------------------------------------------------- 退出

  /** TUI 运行时 console 输出会打乱画面：改成对话区的提示行 */
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
   * 同 pi：SIGTERM / SIGHUP 正常退出（会话收尾、扩展 session_shutdown）；
   * 真实终端上未捕获的异常先还原终端再退出，免得终端停在 raw 模式、光标隐藏。
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
      console.error('vela 因未捕获的异常退出:', error)
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

/** 底栏（同 pi）：目录和会话名；用量、上下文占比、模型和 thinking；扩展的状态。 */
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
    let model = '（无模型）'
    try {
      model = session.modelInfo.ref
    } catch {}
    const left = [
      `↑${compact(totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens)}`,
      `↓${compact(totals.outputTokens)}`,
      totals.cost > 0 ? `$${totals.cost.toFixed(3)}` : undefined,
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
      return `[上下文] 折叠旧工具结果 ${event.before} → ${event.after} tokens`
    case 'summary-required':
      return `[上下文] ${event.before} tokens，下次请求前生成摘要`
    case 'summary':
      return `[上下文] 生成摘要 ${event.before} → ${event.after} tokens`
    case 'compact':
      return `[上下文] 手动压缩 ${event.before} → ${event.after} tokens`
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
