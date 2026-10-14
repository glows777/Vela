import { join } from 'node:path'
import type { CommandHandler } from './index.ts'

/** `/status`: short session/agent status (model, session id/path, context usage). */
export const statusCommands: CommandHandler[] = [
  (cmd, { print, vela, session }) => {
    if (cmd !== '/status') return false

    let model: string
    try {
      model = session.modelInfo.ref
    } catch (error) {
      model = `(unavailable: ${error instanceof Error ? error.message : error})`
    }

    const usage = session.usage
    const sessionPath = join(vela.dataDir, 'sessions', `${session.id}.jsonl`)
    const lines = [
      '\n[status]',
      `  Session: ${session.name ? `${session.name} (${session.id})` : session.id}`,
      `  Path: ${sessionPath}`,
      `  Cwd: ${vela.cwd}`,
      `  Model: ${model}`,
      `  Thinking: ${session.thinkingLevel}`,
      `  Messages: ${session.messages.length}`,
      `  Context: ${usage.tokens} tokens (${usage.percent}%)`,
    ]
    if (usage.totals.steps)
      lines.push(
        `  Usage: ↑${usage.totals.inputTokens + usage.totals.cacheReadTokens + usage.totals.cacheWriteTokens} ↓${usage.totals.outputTokens}${usage.totals.cost != null ? ` $${usage.totals.cost.toFixed(4)}` : ''} (${usage.totals.steps} steps)`,
      )
    print(lines.join('\n'))
    return true
  },
]
