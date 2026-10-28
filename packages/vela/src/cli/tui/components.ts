import {
  Box,
  type Component,
  Container,
  Input,
  Markdown,
  Spacer,
  stripTerminalSequences,
  Text,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui'
import type { ModelMessage, VelaEvent } from '@glows777/vela-core'
import { isToolContent } from '@glows777/vela-core/diagnostics'
import { fitStatusLines, noticeContentWidth } from '../status-display.ts'
import { renderDiff } from './diff.ts'
import { markdownTheme, theme } from './theme.ts'

/** Render image metadata only; inline base64 belongs in session storage, never the terminal. */
export function imagePlaceholder(image: unknown): string | undefined {
  if (!image || typeof image !== 'object') return undefined
  const part = image as Record<string, unknown>
  const mimeType =
    part.type === 'image' && typeof part.mimeType === 'string'
      ? part.mimeType
      : part.type === 'file' && typeof part.mediaType === 'string'
        ? part.mediaType
        : ''
  if (!/^image\//i.test(mimeType)) return undefined
  const source = part.data
  const data =
    part.type === 'file' &&
    source &&
    typeof source === 'object' &&
    'type' in source &&
    source.type === 'data' &&
    'data' in source
      ? source.data
      : source
  if (typeof data !== 'string') return undefined
  const bytes = Buffer.byteLength(data, 'base64')
  const size = bytes
    ? ` ${bytes < 1024 ? `${bytes}B` : `${Math.round(bytes / 1024)}KB`}`
    : ''
  const format = mimeType.replace(/^image\/?/, '')
  return `[image${format ? ` ${format}` : ''}${size}]`
}

/** User message: Markdown on a dark background (like pi); very long ones (skill bodies) show only the first lines. */
export class UserMessage extends Container {
  constructor(text: string, maxLines = 12) {
    super()
    const lines = sanitize(text).split('\n')
    const shown =
      lines.length > maxLines
        ? `${lines.slice(0, maxLines).join('\n')}\n… (${lines.length - maxLines} more lines)`
        : lines.join('\n')
    this.addChild(new Spacer(1))
    this.addChild(
      new Markdown(shown, 1, 1, markdownTheme, {
        color: (t) => theme.fg('text', t),
        bgColor: (t) => theme.bg('userBg', t),
      }),
    )
  }
}

/**
 * An extension's custom message (`session.sendMessage()` with `display: true`), drawn like pi's default:
 * `[customType]` above the text on a violet background; long ones show only the first lines.
 */
export class CustomMessageBlock extends Container {
  constructor(customType: string, text: string, maxLines = 12) {
    super()
    const lines = sanitize(text).split('\n')
    const shown =
      lines.length > maxLines
        ? `${lines.slice(0, maxLines).join('\n')}\n… (${lines.length - maxLines} more lines)`
        : lines.join('\n')
    const box = new Box(1, 1, (t) => theme.bg('customMessageBg', t))
    box.addChild(
      new Text(
        theme.bold(theme.fg('accent', `[${sanitize(customType)}]`)),
        0,
        0,
      ),
    )
    box.addChild(new Spacer(1))
    box.addChild(
      new Markdown(shown, 0, 0, markdownTheme, {
        color: (t) => theme.fg('muted', t),
      }),
    )
    this.addChild(new Spacer(1))
    this.addChild(box)
  }
}

/** One assistant answer: thinking (hideable) + Markdown body, appended as it streams. */
export class AssistantMessage extends Container {
  private thinking = ''
  private text = ''
  private failed = false
  private hideThinking: boolean

  constructor(hideThinking: boolean) {
    super()
    this.hideThinking = hideThinking
  }

  appendThinking(delta: string): void {
    this.thinking += delta
    this.rebuild()
  }

  appendText(delta: string): void {
    this.text += delta
    this.rebuild()
  }

  get hasContent(): boolean {
    return this.thinking.trim() !== '' || this.text.trim() !== ''
  }

  /** The request that produced this text failed (it was retried or the turn stopped). */
  markFailed(): void {
    this.failed = true
    this.rebuild()
  }

  setHideThinking(hide: boolean): void {
    this.hideThinking = hide
    this.rebuild()
  }

  private rebuild(): void {
    this.clear()
    const thinking = sanitize(this.thinking).trim()
    const text = sanitize(this.text).trim()
    if (!thinking && !text) return
    this.addChild(new Spacer(1))
    if (thinking) {
      this.addChild(
        this.hideThinking
          ? new Text(
              theme.italic(theme.fg('thinkingText', 'Thinking...')),
              1,
              0,
            )
          : new Markdown(thinking, 1, 0, markdownTheme, {
              color: (t) => theme.fg('thinkingText', t),
              italic: true,
            }),
      )
      if (text) this.addChild(new Spacer(1))
    }
    if (text) this.addChild(new Markdown(text, 1, 0, markdownTheme))
    if (this.failed)
      this.addChild(new Text(theme.fg('red', '(response failed)'), 1, 0))
  }
}

/** Collapsed previews (pi's defaults): bash keeps the last lines, other tools the first. */
const BASH_PREVIEW_LINES = 5
const PREVIEW_LINES = 10

interface NestedCall {
  name: string
  input: unknown
  status: 'running' | 'ok' | 'error'
  durationMs?: number
}

/**
 * Tool call (like pi's ToolExecutionComponent with its built-in renderers): name + key argument, then
 * the output. bash streams its output while it runs and shows the last lines with the elapsed time;
 * edit_file shows its diff; other tools show the first lines (Ctrl+O expands). Calls the tool made
 * through `ctx.executeTool()` are listed inside the block, one line each (like pi's codemode renderer).
 */
export class ToolBlock implements Component {
  private status: 'pending' | 'success' | 'error' = 'pending'
  private output = ''
  private details: unknown
  private expanded: boolean
  private startedAt?: number
  private durationMs?: number
  private timer?: ReturnType<typeof setInterval>
  private readonly nested = new Map<string, NestedCall>()

  constructor(
    private readonly name: string,
    private readonly input: unknown,
    expanded: boolean,
    private readonly requestRender: () => void = () => {},
  ) {
    this.expanded = expanded
  }

  /** The tool started running: bash shows a live elapsed time. */
  start(): void {
    if (this.startedAt !== undefined || this.status !== 'pending') return
    this.startedAt = Date.now()
    if (this.name === 'bash') {
      this.timer = setInterval(() => this.requestRender(), 1000)
      this.timer.unref?.()
    }
  }

  /** Partial output while running (`tool_execution_update`). */
  update(partialResult: unknown): void {
    if (this.status !== 'pending') return
    this.output = formatOutput(partialResult)
  }

  private get displayOutput(): string {
    // Older sessions may carry the removed bash timestamp hook's prefix; the block has its own clock
    return this.name === 'bash'
      ? this.output.replace(/^\[\d{4}-\d\d-\d\dT[\d:.]+Z\]\n/, '')
      : this.output
  }

  setResult(
    output: unknown,
    isError = false,
    details?: unknown,
    durationMs?: number,
  ): void {
    this.stop()
    this.status = isError ? 'error' : 'success'
    this.output = formatOutput(output)
    this.details = details
    this.durationMs =
      durationMs ??
      (this.startedAt === undefined ? undefined : Date.now() - this.startedAt)
  }

  /** The call ended without a result (the run stopped): stop the clock. */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  addNested(id: string, name: string, input: unknown): void {
    if (!this.nested.has(id))
      this.nested.set(id, { name, input, status: 'running' })
  }

  setNestedResult(id: string, isError: boolean, durationMs?: number): void {
    const call = this.nested.get(id)
    if (!call) return
    call.status = isError ? 'error' : 'ok'
    call.durationMs = durationMs
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded
  }

  invalidate(): void {}

  render(width: number): string[] {
    const bg =
      this.status === 'pending'
        ? 'toolPendingBg'
        : this.status === 'success'
          ? 'toolSuccessBg'
          : 'toolErrorBg'
    const inner = Math.max(1, width - 2)
    const lines = [this.title()]
    for (const call of this.nested.values()) lines.push(nestedLine(call))
    const body = this.body()
    if (body.length) lines.push('', ...body)
    const clock = this.clock()
    if (clock) lines.push('', theme.fg('muted', clock))
    const pad = (line: string) => {
      const cut = truncateToWidth(line, inner)
      return theme.bg(
        bg,
        ` ${cut}${' '.repeat(Math.max(0, inner - visibleWidth(cut)))} `,
      )
    }
    return ['', pad(''), ...lines.map(pad), pad('')]
  }

  private title(): string {
    if (this.name === 'bash' && this.input && typeof this.input === 'object') {
      const { command, timeout } = this.input as {
        command?: unknown
        timeout?: unknown
      }
      if (typeof command === 'string')
        return (
          theme.bold(`$ ${oneLine(sanitize(command))}`) +
          (typeof timeout === 'number'
            ? theme.fg('muted', ` (timeout ${timeout}s)`)
            : '')
        )
    }
    return `${theme.bold(this.name)} ${theme.fg('muted', summarizeInput(this.name, this.input))}`
  }

  private body(): string[] {
    const diff = editDiff(this.name, this.details)
    if (diff && this.status === 'success')
      return renderDiff(sanitize(diff)).split('\n')
    const output = this.displayOutput
    if (!output) return []
    const color = (line: string) =>
      theme.fg(this.status === 'error' ? 'red' : 'muted', line)
    const all = output.split('\n')
    if (this.expanded) return all.map(color)
    if (this.name === 'bash') {
      if (all.length <= BASH_PREVIEW_LINES) return all.map(color)
      return [
        theme.fg(
          'dim',
          `… ${all.length - BASH_PREVIEW_LINES} earlier lines (Ctrl+O to expand)`,
        ),
        ...all.slice(-BASH_PREVIEW_LINES).map(color),
      ]
    }
    if (all.length <= PREVIEW_LINES) return all.map(color)
    return [
      ...all.slice(0, PREVIEW_LINES).map(color),
      theme.fg(
        'dim',
        `… ${all.length - PREVIEW_LINES} more lines (Ctrl+O to expand)`,
      ),
    ]
  }

  /** bash only (like pi): `Elapsed 3.0s` while running, `Took 3.2s` after. */
  private clock(): string | undefined {
    if (this.name !== 'bash') return undefined
    if (this.status === 'pending')
      return this.startedAt === undefined || !this.timer
        ? undefined
        : `Elapsed ${formatDuration(Date.now() - this.startedAt)}`
    return this.durationMs === undefined
      ? undefined
      : `Took ${formatDuration(this.durationMs)}`
  }
}

/** Collapsed `!` output keeps the last lines (pi's BashExecutionComponent PREVIEW_LINES) */
const USER_BASH_PREVIEW_LINES = 20

/**
 * A command the user ran with `!` / `!!` (like pi's BashExecutionComponent): `$ command` between two rules,
 * green when its result goes to the model and dim when it doesn't (`!!`), the output's last lines while
 * it runs and after, then how it ended.
 */
export class BashExecution implements Component {
  private output = ''
  private status: 'running' | 'done' | 'error' = 'running'
  private exitCode?: number
  private cancelled = false
  private fullOutputPath?: string
  private expanded: boolean

  constructor(
    private readonly command: string,
    private readonly excludeFromContext: boolean,
    expanded: boolean,
  ) {
    this.expanded = expanded
  }

  update(output: string): void {
    if (this.status === 'running') this.output = sanitize(output).trimEnd()
  }

  setResult(result: {
    output: string
    exitCode?: number
    cancelled: boolean
    fullOutputPath?: string
  }): void {
    this.status = 'done'
    this.output = sanitize(result.output).trimEnd()
    this.exitCode = result.exitCode
    this.cancelled = result.cancelled
    this.fullOutputPath = result.fullOutputPath
  }

  /** The command could not run (the error is shown as a notice) */
  setFailed(): void {
    this.status = 'error'
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded
  }

  invalidate(): void {}

  render(width: number): string[] {
    const color = this.excludeFromContext ? 'dim' : 'green'
    const inner = Math.max(1, width - 2)
    const rule = theme.fg(color, '─'.repeat(width))
    const lines = [
      theme.fg(color, theme.bold(`$ ${oneLine(sanitize(this.command))}`)),
    ]
    if (this.output) {
      const all = this.output.split('\n')
      const hidden = this.expanded
        ? 0
        : Math.max(0, all.length - USER_BASH_PREVIEW_LINES)
      lines.push('')
      if (hidden)
        lines.push(
          theme.fg('dim', `… ${hidden} earlier lines (Ctrl+O to expand)`),
        )
      for (const line of all.slice(hidden)) lines.push(theme.fg('muted', line))
    }
    if (this.status === 'running')
      lines.push('', theme.fg('muted', 'Running… (Esc to cancel)'))
    else if (this.cancelled) lines.push('', theme.fg('yellow', '(cancelled)'))
    else if (this.status === 'error')
      lines.push('', theme.fg('red', '(failed)'))
    else if (this.exitCode !== undefined && this.exitCode !== 0)
      lines.push('', theme.fg('red', `(exit ${this.exitCode})`))
    if (this.fullOutputPath)
      lines.push(
        theme.fg(
          'yellow',
          `Output truncated. Full output: ${sanitize(this.fullOutputPath)}`,
        ),
      )
    return [
      '',
      rule,
      ...lines.map((line) => ` ${truncateToWidth(line, inner)}`),
      rule,
    ]
  }
}

function nestedLine(call: NestedCall): string {
  const icon =
    call.status === 'running'
      ? theme.fg('yellow', '…')
      : call.status === 'ok'
        ? theme.fg('green', '✓')
        : theme.fg('red', '✗')
  const args = summarizeInput(call.name, call.input)
  return [
    `↳ ${icon} ${call.name}`,
    args && theme.fg('muted', args),
    call.durationMs !== undefined &&
      theme.fg('dim', formatDuration(call.durationMs)),
  ]
    .filter(Boolean)
    .join(' ')
}

/** edit_file's display diff from its `details` (`EditFileDetails`) */
function editDiff(name: string, details: unknown): string | undefined {
  if (name !== 'edit_file' || !details || typeof details !== 'object')
    return undefined
  const diff = (details as { diff?: unknown }).diff
  return typeof diff === 'string' && diff ? diff : undefined
}

/** Like pi's bash renderer: `3.2s`, `2m 5s`, `1h 2m 5s`. */
function formatDuration(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const total = Math.floor(seconds)
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${total % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${total % 60}s`
}

/**
 * A notice line in the chat log (errors, retries, compaction, extension notifications, command output, ...).
 * `raw`: the CLI command's own output (e.g. /context colors); color sequences are kept.
 */
export function notice(
  text: string,
  level: 'info' | 'dim' | 'warning' | 'error' = 'info',
  raw = false,
): Component {
  const color =
    level === 'error'
      ? 'red'
      : level === 'warning'
        ? 'yellow'
        : level === 'dim'
          ? 'dim'
          : 'muted'
  const container = new Container()
  container.addChild(new Spacer(1))
  container.addChild(new NoticeText(raw ? text : sanitize(text), color))
  return container
}

/**
 * Command and notice text. A `/status` Path line is fitted to `render`'s width
 * before pi-tui wraps it, so an 80-column terminal does not crack the session id.
 */
class NoticeText implements Component {
  constructor(
    private readonly text: string,
    private readonly color: 'red' | 'yellow' | 'dim' | 'muted',
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const fitted = fitStatusLines(this.text, noticeContentWidth(width))
    return new Text(theme.fg(this.color, fitted), 1, 0).render(width)
  }
}

/** A tool's key argument: bash command, file path, search pattern; other tools show compact JSON. */
function summarizeInput(name: string, input: unknown): string {
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>
    for (const key of ['command', 'path', 'pattern', 'query', 'url'])
      if (typeof record[key] === 'string') {
        const extra =
          key === 'pattern' && typeof record.path === 'string'
            ? ` (${record.path})`
            : ''
        return sanitize(`${record[key]}${extra}`).replace(/\s+/g, ' ')
      }
  }
  const json = sanitize(JSON.stringify(input) ?? '')
  return name && json === '{}' ? '' : json
}

function formatOutput(output: unknown): string {
  return sanitize(rawOutput(output))
}

function rawOutput(output: unknown): string {
  if (typeof output === 'string') return output.trimEnd()
  if (output instanceof Error) return output.message
  if (isToolContent(output))
    return output
      .map((part) =>
        part.type === 'text' ? part.text : imagePlaceholder(part),
      )
      .join('\n')
  // Partial results (`tool_execution_update`, like pi): { content: [{ type: 'text', text }] }
  if (
    output &&
    typeof output === 'object' &&
    Array.isArray((output as { content?: unknown }).content)
  )
    return (output as { content: { type?: string; text?: unknown }[] }).content
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trimEnd()
  // Long results saved to a file (StoredToolResult): what the model got is the preview
  if (
    output &&
    typeof output === 'object' &&
    (output as { kind?: unknown }).kind === 'vela-tool-result' &&
    typeof (output as { preview?: unknown }).preview === 'string'
  )
    return (output as { preview: string }).preview.trimEnd()
  // Canonical image tool results must not fall through to JSON/base64 rendering.
  if (
    output &&
    typeof output === 'object' &&
    'type' in output &&
    output.type === 'content' &&
    'value' in output &&
    isToolContent(output.value)
  )
    return rawOutput(output.value)
  // AI SDK tool results: { type: 'text', value } / { type: 'json', value } / { type: 'error-text', value }
  if (output && typeof output === 'object' && 'value' in output) {
    const value = (output as { value: unknown }).value
    if (typeof value === 'string') return value.trimEnd()
  }
  return (
    JSON.stringify(
      output,
      (_key, value) => imagePlaceholder(value) ?? value,
      2,
    ) ?? ''
  )
}

/**
 * Strip terminal escape sequences and control characters from external text (tool output, model answers,
 * channel messages) before it reaches the terminal (like pi's stripAnsi + sanitizeBinaryOutput); otherwise file
 * contents or people in a channel could change the terminal title, write the clipboard (OSC 52) or garble the
 * screen. Newlines and tabs are kept.
 */
export function sanitize(text: string): string {
  return (
    stripTerminalSequences(text)
      .replace(/\r\n?/g, '\n')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
      .replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F\uFFF9-\uFFFB]/g, '')
  )
}

export function dialogBox(
  title: string,
  body: Component,
  hint: string,
): Component {
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

export function compactionLine(
  event: Extract<VelaEvent, { type: 'compaction_end' }>,
): string {
  const result = event.result
  if (!result) return ''
  switch (event.reason) {
    case 'threshold':
      return `[context] Summarized ${result.tokensBefore} → ${result.tokensAfter} tokens`
    case 'manual':
      return `[context] Manually compacted ${result.tokensBefore} → ${result.tokensAfter} tokens`
    case 'overflow':
      return `[context] The model said the context is too long; summarized ${result.tokensBefore} → ${result.tokensAfter} tokens and retrying`
  }
}

export function contextLine(
  event: Extract<VelaEvent, { type: 'context_prepare' }>,
): string {
  switch (event.action) {
    case 'micro':
      return `[context] Folded old tool results ${event.before} → ${event.after} tokens`
    case 'summary-required':
      return `[context] ${event.before} tokens, summarizing before the next request`
  }
}

/** Text of the last assistant message that has any (tool-call-only steps are skipped). */
export function lastAnswer(messages: readonly ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as ModelMessage
    if (message.role !== 'assistant') continue
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join('')
    if (text.trim()) return text
  }
  return ''
}

/** EIO: tty reads / writes after hangup; ENOTTY: the tty was revoked (same set as pi). */
const DEAD_TERMINAL_ERROR_CODES = new Set([
  'EIO',
  'EPIPE',
  'ENOTCONN',
  'ENOTTY',
])

export function isDeadTerminalError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && DEAD_TERMINAL_ERROR_CODES.has(code)
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ')
}

/** An Input that draws `*` for each character (API keys in `/login`); the cursor stays in place since lengths match */
export class SecretInput extends Input {
  override render(width: number): string[] {
    const value = this.getValue()
    this.setValue('*'.repeat(value.length))
    try {
      return super.render(width)
    } finally {
      this.setValue(value)
    }
  }
}
