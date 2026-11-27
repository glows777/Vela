import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import type { UsageTotals } from '../../driver/index.ts'
import { formatUsd } from '../format.ts'
import { formatContextFileList, formatStatusPath } from '../status-display.ts'
import { sanitize } from '../tui/components.ts'
import { cliVersion } from '../version.ts'
import type { CommandHandler } from './index.ts'

/** `/status`: session overview (model, id and where it is saved, context and token usage). */
export const statusCommands: CommandHandler[] = [
  (cmd, { print, session, agentDir }) => {
    if (cmd !== '/status') return false
    return (async () => {
      const snap = await session.refresh({ includeEntries: true })
      const windowTokens =
        snap.modelInfo?.contextWindow ?? snap.usage.contextWindow
      const model = snap.modelInfo
        ? snap.modelInfo.ref
        : `(unavailable: ${snap.modelError ?? 'no model selected'})`
      const usage = snap.usage
      const name = snap.name ? plain(snap.name) : ''
      const messageCount = snap.branch.filter(
        (e) => e.type === 'message' || e.type === 'custom_message',
      ).length
      const lines = [
        '\n[status]',
        `  Version: ${cliVersion()}`,
        `  Session: ${name ? `${name} (${session.id})` : session.id}`,
        `  Path: ${plain(
          formatStatusPath({
            persistence: snap.persistence,
            homeDir: homedir(),
            agentDir,
            isFile: (path) => snap.entries.length > 0 && isSessionFile(path),
          }),
        )}`,
        `  Cwd: ${plain(snap.cwd)}`,
      ]
      const contextFiles = plain(
        formatContextFileList(snap.resources.contextFiles, {
          cwd: snap.cwd,
          homeDir: homedir(),
          agentDir,
        }),
      )
      if (contextFiles) lines.push(`  Context files: ${contextFiles}`)
      lines.push(
        `  Model: ${plain(model)}`,
        `  Thinking: ${snap.thinkingLevel}`,
      )
      if (snap.channel) lines.push(`  Channel: ${plain(snap.channel)}`)
      if (snap.parentSession) {
        lines.push(`  Forked from: ${plain(snap.parentSession)}`)
      }
      lines.push(
        `  Messages: ${messageCount}`,
        `  Context: ${formatCount(usage.tokens)} tokens (${usage.percent}% of ${formatCount(windowTokens)})`,
      )
      if (usage.totals.steps) lines.push(usageLine(usage.totals))
      print(`${lines.join('\n')}\n`)
    })()
  },
]

function isSessionFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

function plain(value: string): string {
  return sanitize(value).replace(/\n+/g, ' ').trim()
}

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
