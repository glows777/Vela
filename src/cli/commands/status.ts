import { join } from 'node:path'
import type { CommandHandler } from './index.ts'

/** `/status`: short session overview (model, session id/path, context usage). */
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
    // File storage writes `<dataDir>/sessions/<id>.jsonl`. `--no-session` keeps the
    // session in memory and does not create this file.
    const sessionPath = join(vela.dataDir, 'sessions', `${session.id}.jsonl`)
    const sessionLabel = session.name
      ? `${session.name} (${session.id})`
      : session.id
    const lines = [
      '\n[status]',
      `  Session: ${sessionLabel}`,
      `  Path: ${sessionPath}`,
      `  Cwd: ${vela.cwd}`,
      `  Model: ${model}`,
      `  Thinking: ${session.thinkingLevel}`,
      `  Role: ${session.role}`,
      `  Messages: ${session.messages.length}`,
      `  Context: ${usage.tokens} tokens (${usage.percent}%)`,
    ]
    if (usage.totals.steps) {
      const input =
        usage.totals.inputTokens +
        usage.totals.cacheReadTokens +
        usage.totals.cacheWriteTokens
      const cost =
        usage.totals.cost !== undefined
          ? ` $${usage.totals.cost.toFixed(4)}`
          : ''
      const steps = usage.totals.steps
      lines.push(
        `  Usage: ↑${input} ↓${usage.totals.outputTokens}${cost} (${steps} ${steps === 1 ? 'step' : 'steps'})`,
      )
    }
    print(lines.join('\n'))
    return true
  },
]
