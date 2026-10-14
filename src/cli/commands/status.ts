import { join } from 'node:path'
import type { UsageTotals } from '../../usage/tracker.ts'
import type { CommandHandler } from './index.ts'

/** `/status`: session overview (model, id and path, context and token usage). */
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
    const lines = [
      '\n[status]',
      `  Session: ${session.name ? `${session.name} (${session.id})` : session.id}`,
      `  Path: ${join(vela.dataDir, 'sessions', `${session.id}.jsonl`)}`,
      `  Cwd: ${vela.cwd}`,
      `  Model: ${model}`,
      `  Thinking: ${session.thinkingLevel}`,
      `  Role: ${session.role}`,
    ]
    if (session.channel) lines.push(`  Channel: ${session.channel}`)
    if (session.parentSession)
      lines.push(`  Forked from: ${session.parentSession}`)
    lines.push(
      `  Messages: ${session.messages.length}`,
      `  Context: ${formatCount(usage.tokens)} tokens (${usage.percent}% of ${formatCount(windowTokens)})`,
    )
    if (usage.totals.steps) lines.push(usageLine(usage.totals))
    print(`${lines.join('\n')}\n`)
    return true
  },
]

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
