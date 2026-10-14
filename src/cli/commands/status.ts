import type { UsageTotals } from '../../usage/tracker.ts'
import type { VelaSession } from '../../vela-session.ts'
import { sanitize } from '../tui/components.ts'
import type { CommandHandler } from './index.ts'

/** `/status`: session overview (model, id and where it is saved, context and token usage). */
export const statusCommands: CommandHandler[] = [
  (cmd, { print, vela, session }) => {
    if (cmd !== '/status') return false

    let model: string
    let windowTokens = session.tracker.contextWindow
    try {
      const info = session.modelInfo
      model = info.ref
      windowTokens = info.contextWindow ?? windowTokens
    } catch (error) {
      model = `(unavailable: ${error instanceof Error ? error.message : error})`
    }

    const usage = session.usage
    const name = session.name ? plain(session.name) : ''
    const lines = [
      '\n[status]',
      `  Session: ${name ? `${name} (${session.id})` : session.id}`,
      `  Path: ${sessionPath(session)}`,
      `  Cwd: ${plain(vela.cwd)}`,
      `  Model: ${plain(model)}`,
      `  Thinking: ${session.thinkingLevel}`,
      `  Role: ${session.role}`,
    ]
    const channel = session.channel ? plain(session.channel) : ''
    if (channel) lines.push(`  Channel: ${channel}`)
    const parent = session.parentSession ? plain(session.parentSession) : ''
    if (parent) lines.push(`  Forked from: ${parent}`)
    lines.push(
      `  Messages: ${session.messages.length}`,
      `  Context: ${formatCount(usage.tokens)} tokens (${usage.percent}% of ${formatCount(windowTokens)})`,
    )
    if (usage.totals.steps) lines.push(usageLine(usage.totals))
    print(`${lines.join('\n')}\n`)
    return true
  },
]

/**
 * Where history is kept, as one display line. Only a reported memory storage is "not saved".
 * A storage that does not say is custom: it may still be durable, and its path is unknown.
 */
function sessionPath(session: VelaSession): string {
  const where = session.persistence
  if (where.type === 'file') return plain(where.path)
  if (where.type === 'memory') return 'in-memory (not saved)'
  return 'custom storage (path unknown)'
}

/**
 * One line of external text for raw command output: terminal sequences and control bytes are
 * removed (the TUI prints this with `raw: true`), and line breaks cannot split the overview.
 */
function plain(value: string): string {
  return sanitize(value).replace(/\n+/g, ' ').trim()
}

/** Same rounding as /usage: one decimal from 1k, and millions from 1M. */
function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function usageLine(totals: UsageTotals): string {
  const input =
    totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
  const cost = totals.cost != null ? ` $${totals.cost.toFixed(4)}` : ''
  const steps = `${totals.steps} ${totals.steps === 1 ? 'step' : 'steps'}`
  return `  Usage: ↑${formatCount(input)} ↓${formatCount(totals.outputTokens)}${cost} (${steps})`
}
