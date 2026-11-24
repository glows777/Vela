import {
  type Component,
  Container,
  Text,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@earendil-works/pi-tui'
import { theme } from './theme.ts'

/** What a turn did, by kind. The summary line counts them (like Claude Code's collapsed tools). */
export interface TurnCounts {
  searched: number
  read: number
  listed: number
  edited: number
  shell: number
  mcp: number
  other: number
}

const TOOL_KIND: Record<string, keyof TurnCounts> = {
  grep: 'searched',
  find: 'searched',
  read_file: 'read',
  list_directory: 'listed',
  edit_file: 'edited',
  write_file: 'edited',
  bash: 'shell',
}

/** `mcp__docs__search` and anything else the turn called */
function toolKind(name: string): keyof TurnCounts {
  return TOOL_KIND[name] ?? (name.startsWith('mcp__') ? 'mcp' : 'other')
}

interface Part {
  kind: keyof TurnCounts
  /** Past tense and present participle, as in `searched for` / `searching for` */
  verb: [done: string, running: string]
  noun: [one: string, many: string]
}

/** Claude Code's order: what was searched, read, listed, edited, then shell, MCP and other tools. */
const PARTS: Part[] = [
  {
    kind: 'searched',
    verb: ['searched for', 'searching for'],
    noun: ['pattern', 'patterns'],
  },
  { kind: 'read', verb: ['read', 'reading'], noun: ['file', 'files'] },
  {
    kind: 'listed',
    verb: ['listed', 'listing'],
    noun: ['directory', 'directories'],
  },
  { kind: 'edited', verb: ['edited', 'editing'], noun: ['file', 'files'] },
  {
    kind: 'shell',
    verb: ['ran', 'running'],
    noun: ['shell command', 'shell commands'],
  },
  { kind: 'mcp', verb: ['called', 'calling'], noun: ['MCP tool', 'MCP tools'] },
  {
    kind: 'other',
    verb: ['called', 'calling'],
    noun: ['other tool', 'other tools'],
  },
]

/** `2m 39s`, `12s`: whole seconds, like the summary line reads aloud. */
function thoughtDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * The fold line: `Thought for 12s, searched for 3 patterns, ran 2 shell commands`. While the turn runs the
 * verbs are present tense (`Thinking for 12s, running 2 shell commands`); zero counts are left out.
 */
export function foldSummary(
  counts: TurnCounts,
  options: { running: boolean; thoughtMs: number },
): string {
  const parts: string[] = []
  if (options.thoughtMs > 0)
    parts.push(
      `${options.running ? 'Thinking' : 'Thought'} for ${thoughtDuration(options.thoughtMs)}`,
    )
  for (const part of PARTS) {
    const count = counts[part.kind]
    if (!count) continue
    const verb = part.verb[options.running ? 1 : 0]
    parts.push(`${verb} ${count} ${count === 1 ? part.noun[0] : part.noun[1]}`)
  }
  return parts.join(', ')
}

/**
 * One turn's process collapsed into a line above the answer (like Claude Code): thinking and tool calls
 * live in `details`, hidden until the fold is opened by a click on the line or Ctrl+O. While the turn runs
 * the line keeps its own elapsed time, so the transcript shows one moving row instead of a wall of output.
 */
export class TurnFold implements Component {
  /** Thinking and tool blocks, in the order the turn produced them. */
  readonly details = new Container()
  private readonly counts: TurnCounts = {
    searched: 0,
    read: 0,
    listed: 0,
    edited: 0,
    shell: 0,
    mcp: 0,
    other: 0,
  }
  private expanded: boolean
  private running = true
  private sawThinking = false
  private thoughtMs = 0
  private thinkingSince?: number
  private timer?: ReturnType<typeof setInterval>

  constructor(
    private readonly requestRender: () => void,
    expanded: boolean,
  ) {
    this.expanded = expanded
    this.timer = setInterval(() => this.requestRender(), 1000)
    this.timer.unref?.()
  }

  add(child: Component): void {
    this.details.addChild(child)
  }

  remove(child: Component): void {
    this.details.removeChild(child)
  }

  /** A tool call joined this turn; failures count too, and stay visible outside the fold. */
  noteTool(name: string): void {
    this.counts[toolKind(name)] += 1
  }

  /** The model started thinking (idempotent). */
  startThinking(): void {
    this.sawThinking = true
    this.thinkingSince ??= Date.now()
  }

  /** Thinking stopped: the model moved on to text or a tool call. */
  stopThinking(): void {
    if (this.thinkingSince === undefined) return
    this.thoughtMs += Date.now() - this.thinkingSince
    this.thinkingSince = undefined
  }

  get isExpanded(): boolean {
    return this.expanded
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return
    this.expanded = expanded
    this.requestRender()
  }

  /**
   * The turn ended. A turn that left no answer text stays open, so an interrupted or tool-only turn never
   * hides its only evidence.
   */
  settle(hasAnswer: boolean): void {
    if (!this.running) return
    this.stopThinking()
    this.running = false
    this.stopClock()
    if (!hasAnswer) this.expanded = true
    this.requestRender()
  }

  /** Stop the clock without touching the fold (session switch, shutdown). */
  stop(): void {
    this.stopThinking()
    this.stopClock()
  }

  private stopClock(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // Only the fold line is a target; the rest of the row keeps terminal text selection.
    if (event.type !== 'click' || event.button !== 'left' || event.y !== 0)
      return undefined
    this.setExpanded(!this.expanded)
    return { handled: true }
  }

  invalidate(): void {
    this.details.invalidate()
  }

  render(width: number): string[] {
    const thoughtMs =
      this.thoughtMs +
      (this.thinkingSince === undefined ? 0 : Date.now() - this.thinkingSince)
    const summary = foldSummary(this.counts, {
      running: this.running,
      // Thinking always shows: a sub-second thought still reads `for 1s`, never nothing
      thoughtMs: this.sawThinking ? Math.max(1, thoughtMs) : 0,
    })
    const line = `${theme.fg('dim', this.expanded ? '▾' : '▸')} ${theme.fg(
      this.running ? 'muted' : 'dim',
      summary,
    )}`
    const lines = new Text(line, 1, 0).render(width)
    if (!this.expanded) return lines
    return [...lines, ...this.details.render(width)]
  }
}
