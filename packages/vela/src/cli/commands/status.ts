import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import type { UsageTotals, VelaSession } from '@glows777/vela-core'
import { inspectVela } from '@glows777/vela-core/diagnostics'
import { formatUsd } from '../format.ts'
import { formatContextFileList, formatStatusPath } from '../status-display.ts'
import { sanitize } from '../tui/components.ts'
import type { CommandHandler } from './index.ts'

/** `/status`: session overview (model, id and where it is saved, context and token usage). */
export const statusCommands: CommandHandler[] = [
  (cmd, { print, vela, session, agentDir }) => {
    if (cmd !== '/status') return false

    let model: string
    let windowTokens = session.usage.contextWindow
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
      `  Path: ${sessionPath(session, agentDir)}`,
      `  Cwd: ${plain(vela.cwd)}`,
    ]
    const contextFiles = plain(
      formatContextFileList(inspectVela(vela).contextFiles, {
        cwd: vela.cwd,
        homeDir: homedir(),
        agentDir,
      }),
    )
    if (contextFiles) lines.push(`  Context files: ${contextFiles}`)
    lines.push(
      `  Model: ${plain(model)}`,
      `  Thinking: ${session.thinkingLevel}`,
    )
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
 * A file storage that has not been written yet says so: the path is a destination, not a file.
 * A storage that does not say is custom: it may still be durable, and its path is unknown.
 */
function sessionPath(
  session: VelaSession,
  agentDir: string | undefined,
): string {
  return plain(
    formatStatusPath({
      persistence: session.persistence,
      homeDir: homedir(),
      agentDir,
      isFile: isSessionFile,
    }),
  )
}

/** True when this path is a file. A missing file is not a saved session; other errors are not "missing". */
function isSessionFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
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
  const cost =
    typeof totals.cost === 'number' ? ` ${formatUsd(totals.cost)}` : ''
  const steps = `${totals.steps} ${totals.steps === 1 ? 'step' : 'steps'}`
  return `  Usage: ↑${formatCount(input)} ↓${formatCount(totals.outputTokens)}${cost} (${steps})`
}
