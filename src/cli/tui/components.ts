import {
  type Component,
  Container,
  Markdown,
  Spacer,
  stripTerminalSequences,
  Text,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui'
import { renderDiff } from './diff.ts'
import { markdownTheme, theme } from './theme.ts'

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
    // The model's copy of bash output starts with a `[<ISO time>]` line (the bash-timestamp hook); the block has its own clock
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
export function formatDuration(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const total = Math.floor(seconds)
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${total % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${total % 60}s`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ')
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
  container.addChild(
    new Text(theme.fg(color, raw ? text : sanitize(text)), 1, 0),
  )
  return container
}

/** A tool's key argument: bash command, file path, search pattern; other tools show compact JSON. */
export function summarizeInput(name: string, input: unknown): string {
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
  // AI SDK tool results: { type: 'text', value } / { type: 'json', value } / { type: 'error-text', value }
  if (output && typeof output === 'object' && 'value' in output) {
    const value = (output as { value: unknown }).value
    if (typeof value === 'string') return value.trimEnd()
  }
  return JSON.stringify(output, null, 2) ?? ''
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
