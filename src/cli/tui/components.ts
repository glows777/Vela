import {
  Box,
  type Component,
  Container,
  Markdown,
  Spacer,
  stripTerminalSequences,
  Text,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui'
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

/** Tool call: name + key argument; the result shows only the first lines by default (Ctrl+O expands, like pi). */
export class ToolBlock implements Component {
  private status: 'pending' | 'success' | 'error' = 'pending'
  private output = ''
  private expanded: boolean

  constructor(
    private readonly name: string,
    private readonly input: unknown,
    expanded: boolean,
  ) {
    this.expanded = expanded
  }

  setResult(output: unknown, isError = false): void {
    this.status = isError ? 'error' : 'success'
    this.output = formatOutput(output)
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
    const title = `${theme.bold(this.name)} ${theme.fg('muted', summarizeInput(this.name, this.input))}`
    const lines = [title]
    if (this.output) {
      const all = this.output.split('\n')
      const limit = this.expanded ? all.length : 5
      lines.push('')
      for (const line of all.slice(0, limit))
        lines.push(theme.fg(this.status === 'error' ? 'red' : 'muted', line))
      if (all.length > limit)
        lines.push(
          theme.fg(
            'dim',
            `… ${all.length - limit} more lines (Ctrl+O to expand)`,
          ),
        )
    }
    const pad = (line: string) => {
      const cut = truncateToWidth(line, inner)
      return theme.bg(
        bg,
        ` ${cut}${' '.repeat(Math.max(0, inner - visibleWidth(cut)))} `,
      )
    }
    return ['', pad(''), ...lines.map(pad), pad('')]
  }
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
