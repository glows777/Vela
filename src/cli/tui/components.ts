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
import { markdownTheme, theme } from './theme.ts'

/** 用户消息：深色底的 Markdown（同 pi）；很长的（skill 正文）只显示前几行。 */
export class UserMessage extends Container {
  constructor(text: string, maxLines = 12) {
    super()
    const lines = sanitize(text).split('\n')
    const shown =
      lines.length > maxLines
        ? `${lines.slice(0, maxLines).join('\n')}\n…（还有 ${lines.length - maxLines} 行）`
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

/** 助手的一段回答：thinking（可隐藏）+ Markdown 正文，流式追加。 */
export class AssistantMessage extends Container {
  private thinking = ''
  private text = ''
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
  }
}

/** 工具调用：名字 + 关键参数，结果默认只显示前几行（Ctrl+O 展开，同 pi）。 */
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
          theme.fg('dim', `… 还有 ${all.length - limit} 行（Ctrl+O 展开）`),
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
 * 对话区里的一行提示（错误、重试、压缩、扩展通知、命令输出…）。
 * `raw`：CLI 命令自己的输出（如 /context 的配色），不去掉颜色序列。
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
  container.addChild(new Text(theme.fg(color, raw ? text : sanitize(text)), 1, 0))
  return container
}

/** 工具的关键参数：bash 命令、文件路径、搜索模式；其它工具显示压缩后的 JSON。 */
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
  // AI SDK 的工具结果：{ type: 'text', value } / { type: 'json', value } / { type: 'error-text', value }
  if (output && typeof output === 'object' && 'value' in output) {
    const value = (output as { value: unknown }).value
    if (typeof value === 'string') return value.trimEnd()
  }
  return JSON.stringify(output, null, 2) ?? ''
}

/**
 * 工具输出、模型回答、通道消息这些外部文本直接写进终端前，去掉终端控制序列和控制字符
 * （同 pi 的 stripAnsi + sanitizeBinaryOutput）：否则文件内容或通道里的人能改终端标题、
 * 写剪贴板（OSC 52）或打乱画面。保留换行和 Tab。
 */
export function sanitize(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\r\n?/g, '\n')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要去掉控制字符
    .replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F\uFFF9-\uFFFB]/g, '')
}
