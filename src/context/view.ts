/**
 * Terminal view for /context, modeled on Claude Code's /context view.
 *
 * Splits context usage by category and draws it as a grid where each cell ≈ 1/256 of the window (16x16).
 * Each category gets its own color (ANSI 256) so you can see at a glance what is eating the context.
 */
import type { ModelMessage } from 'ai'
import type { TokenTracker } from '../usage/tracker.ts'

export interface ContextSlice {
  name: string
  tokens: number
  color: number // ANSI 256 color code
  icon: string
}

export interface ContextSnapshot {
  modelName: string
  modelId: string
  windowTokens: number
  usedTokens: number
  slices: ContextSlice[]
  // Window above the summary threshold: a request that reaches it gets summarized
  autocompactBufferTokens: number
}

const COLORS = {
  system: 63, // purple
  tools: 99, // pinkish purple
  memory: 220, // yellow
  skills: 36, // cyan
  messages: 111, // blue
  free: 240, // gray (empty cells)
  buffer: 244, // gray (autocompact buffer)
  text: 255, // white text
  dim: 244, // dark gray
}

function fg(code: number, s: string): string {
  return `\x1b[38;5;${code}m${s}\x1b[0m`
}

function pct(n: number, total: number): string {
  if (total === 0) return '0.0%'
  return `${((n / total) * 100).toFixed(1)}%`
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/**
 * Draws a 16×16 = 256 cell grid; each cell stands for window/256 tokens.
 * Used cells are filled with colored ● in slice order, free with ○, autocompact buffer with ▢.
 */
export function renderContextMatrix(snapshot: ContextSnapshot): string {
  const { windowTokens, slices, autocompactBufferTokens } = snapshot
  const TOTAL_CELLS = 256
  const tokensPerCell = windowTokens / TOTAL_CELLS

  // Convert each slice's tokens to a cell count (round up so small slices don't vanish)
  const cells: number[] = [] // ANSI color for each cell, or -1 for free, -2 for buffer
  let used = 0
  for (const s of slices) {
    if (s.tokens <= 0) continue
    const n = Math.max(1, Math.round(s.tokens / tokensPerCell))
    for (let i = 0; i < n && cells.length < TOTAL_CELLS; i++) {
      cells.push(s.color)
    }
    used += n
  }
  const bufferCells = Math.max(
    0,
    Math.round(autocompactBufferTokens / tokensPerCell),
  )
  const freeCells = TOTAL_CELLS - cells.length - bufferCells
  for (let i = 0; i < freeCells; i++) cells.push(-1)
  for (let i = 0; i < bufferCells && cells.length < TOTAL_CELLS; i++)
    cells.push(-2)

  const lines: string[] = []
  for (let row = 0; row < 16; row++) {
    const rowCells: string[] = []
    for (let col = 0; col < 16; col++) {
      const idx = row * 16 + col
      const c = cells[idx]!
      if (c === -1) rowCells.push(fg(COLORS.free, '○'))
      else if (c === -2) rowCells.push(fg(COLORS.buffer, '▢'))
      else rowCells.push(fg(c, '●'))
    }
    lines.push(rowCells.join(' '))
  }
  return lines.join('\n')
}

export function renderContextLegend(snapshot: ContextSnapshot): string {
  const { slices, autocompactBufferTokens, windowTokens, usedTokens } = snapshot
  const lines: string[] = []

  lines.push(
    fg(COLORS.text, fg(255, '\x1b[1m') + snapshot.modelName + '\x1b[0m'),
  )
  lines.push(fg(COLORS.dim, snapshot.modelId))
  lines.push(
    `${fmtTokens(usedTokens)}/${fmtTokens(windowTokens)} tokens (${pct(usedTokens, windowTokens)})`,
  )
  lines.push('')
  lines.push(fg(COLORS.dim, '\x1b[3mEstimated usage by category\x1b[0m'))
  for (const s of slices) {
    if (s.tokens <= 0) continue
    const dot = fg(s.color, '●')
    const label = `${s.icon} ${s.name}`
    const value = `${fmtTokens(s.tokens)} tokens (${pct(s.tokens, windowTokens)})`
    lines.push(`${dot} ${label}: ${value}`)
  }
  const free = windowTokens - usedTokens - autocompactBufferTokens
  lines.push(
    `${fg(COLORS.free, '○')}  Free space: ${fmtTokens(Math.max(0, free))} (${pct(Math.max(0, free), windowTokens)})`,
  )
  lines.push(
    `${fg(COLORS.buffer, '▢')}  Autocompact buffer: ${fmtTokens(autocompactBufferTokens)} (${pct(autocompactBufferTokens, windowTokens)})`,
  )

  return lines.join('\n')
}

/**
 * Shows the grid and legend side by side, joined line by line: grid on the left, legend on the right.
 */
export function renderContextView(snapshot: ContextSnapshot): string {
  const matrix = renderContextMatrix(snapshot).split('\n')
  const legend = renderContextLegend(snapshot).split('\n')
  const rows = Math.max(matrix.length, legend.length)
  const out: string[] = []
  for (let i = 0; i < rows; i++) {
    const left = (matrix[i] || '').padEnd(80, ' ')
    const right = legend[i] || ''
    out.push(`  ${left}  ${right}`)
  }
  return '\n' + out.join('\n') + '\n'
}

// ── Snapshot: token slices from the message list plus known sizes ─────────

export interface BuildSnapshotInput {
  modelName: string // e.g. "Mock Model" / "Qwen Plus"
  modelId: string
  windowTokens: number // e.g. 1_000_000
  systemPromptChars: number
  toolDescriptionChars: number
  memoryChars: number
  skillsChars: number
  messages: ModelMessage[]
  /** Window above the summary threshold (where autocompaction kicks in); 0 when not given */
  autocompactBufferTokens?: number
}

const CHARS_PER_TOKEN = 3.5
function approxTokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

function approxMessageTokens(messages: ModelMessage[]): number {
  let chars = 0
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'text') chars += (part.text || '').length
        else if (part.type === 'tool-call')
          chars += JSON.stringify(part.input || {}).length + 80
        else if (part.type === 'tool-result') {
          const out = part.output
          if ('value' in out && out.value)
            chars +=
              typeof out.value === 'string'
                ? out.value.length
                : JSON.stringify(out.value).length
          else chars += JSON.stringify(out || {}).length
          chars += 80
        }
      }
    }
  }
  return approxTokensFromChars(chars)
}

export function buildContextSnapshot(
  input: BuildSnapshotInput,
): ContextSnapshot {
  const slices: ContextSlice[] = [
    {
      name: 'System prompt',
      tokens: approxTokensFromChars(input.systemPromptChars),
      color: COLORS.system,
      icon: '◆',
    },
    {
      name: 'System tools',
      tokens: approxTokensFromChars(input.toolDescriptionChars),
      color: COLORS.tools,
      icon: '◇',
    },
    {
      name: 'Memory',
      tokens: approxTokensFromChars(input.memoryChars),
      color: COLORS.memory,
      icon: '◈',
    },
    {
      name: 'Skills',
      tokens: approxTokensFromChars(input.skillsChars),
      color: COLORS.skills,
      icon: '◉',
    },
    {
      name: 'Messages',
      tokens: approxMessageTokens(input.messages),
      color: COLORS.messages,
      icon: '◎',
    },
  ]
  const usedTokens = slices.reduce((a, s) => a + s.tokens, 0)
  return {
    modelName: input.modelName,
    modelId: input.modelId,
    windowTokens: input.windowTokens,
    usedTokens,
    slices,
    autocompactBufferTokens: input.autocompactBufferTokens ?? 0,
  }
}

// ── /usage view: cumulative cost + cache hit rate ─────────────────────────

export function renderUsageView(tracker: TokenTracker): string {
  const t = tracker.totals()
  const lines: string[] = []
  const C = (n: number, s: string) => fg(n, s)
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`

  const totalCacheable = t.cacheReadTokens + t.cacheWriteTokens + t.inputTokens

  lines.push(bold(C(255, '  Usage Summary')))
  lines.push(
    C(
      244,
      `  ${t.steps} ${t.steps === 1 ? 'step' : 'steps'} total · ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
    ),
  )
  lines.push('')
  lines.push(
    `  ${C(111, '◎')} Input          ${fmtTokens(t.inputTokens).padStart(8)} tokens`,
  )
  lines.push(
    `  ${C(220, '◈')} Cache write    ${fmtTokens(t.cacheWriteTokens).padStart(8)} tokens`,
  )
  lines.push(
    `  ${C(36, '◉')} Cache read     ${fmtTokens(t.cacheReadTokens).padStart(8)} tokens   (${(t.hitRate * 100).toFixed(1)}% hit)`,
  )
  lines.push(
    `  ${C(99, '◇')} Output         ${fmtTokens(t.outputTokens).padStart(8)} tokens`,
  )
  lines.push('')

  // Cache hit rate bar
  const barWidth = 30
  const filled = Math.round(t.hitRate * barWidth)
  const bar = C(36, '█'.repeat(filled)) + C(240, '░'.repeat(barWidth - filled))
  lines.push(`  Cache hit rate  ${bar}  ${(t.hitRate * 100).toFixed(1)}%`)
  lines.push('')

  // No cost lines when no request had a known price: tokens only, no made-up dollar amount
  if (
    t.cost !== undefined &&
    t.baselineCost !== undefined &&
    t.savedCost !== undefined
  ) {
    lines.push(
      `  ${bold('Cost')}            ${C(220, '$' + t.cost.toFixed(4))}`,
    )
    lines.push(
      `  ${C(244, 'Without cache')}   ${C(244, '$' + t.baselineCost.toFixed(4))}`,
    )
    const savedPct =
      t.baselineCost > 0 ? (t.savedCost / t.baselineCost) * 100 : 0
    if (t.savedCost > 0) {
      lines.push(
        `  ${bold(C(36, 'Saved'))}           ${C(36, '$' + t.savedCost.toFixed(4))} (${savedPct.toFixed(1)}% off)`,
      )
    }
  }
  if (totalCacheable === 0) {
    lines.push(
      '  ' +
        C(244, 'No cacheable input yet; check again after a few more turns :)'),
    )
  }

  return '\n' + lines.join('\n') + '\n'
}
