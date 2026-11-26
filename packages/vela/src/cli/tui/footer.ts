import { homedir } from 'node:os'
import {
  type Component,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui'
import { formatUsd } from '../format.ts'
import type { CliSessionClient } from '../runtime-client.ts'
import { sanitize } from './components.ts'
import { theme } from './theme.ts'

export class Footer implements Component {
  constructor(
    private readonly cwd: string,
    private readonly session: () => CliSessionClient | undefined,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const session = this.session()
    const snap = session?.snapshot
    if (!session || !snap) return []
    const home = homedir()
    const dir = this.cwd.startsWith(home)
      ? `~${this.cwd.slice(home.length)}`
      : this.cwd
    const usage = snap.usage
    const totals = usage.totals
    const model = snap.modelInfo?.ref ?? '(no model)'
    const plan = snap.modelInfo?.planLabel
    const left = [
      `↑${compact(totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens)}`,
      `↓${compact(totals.outputTokens)}`,
      typeof totals.cost === 'number' ? formatUsd(totals.cost) : undefined,
      `${usage.percent}%`,
    ]
      .filter(Boolean)
      .join(' ')
    const right = `${model} · ${snap.thinkingLevel}${plan ? ` · ${plan}` : ''}`
    const gap = Math.max(
      1,
      width - visibleWidth(left) - visibleWidth(right) - 2,
    )
    const lines = [
      truncateToWidth(` ${dir} · ${sanitize(snap.name ?? session.id)}`, width),
      truncateToWidth(` ${left}${' '.repeat(gap)}${right}`, width),
    ]
    const running = snap.runningJobs.filter(
      (task) => task.snapshot.state === 'running',
    )
    if (running.length) {
      const label = `${running.length} background ${running.length === 1 ? 'task' : 'tasks'} · ${running.map((task) => task.snapshot.id).join(', ')}`
      lines.push(truncateToWidth(` ${label}`, width))
    }
    return lines.map((line) => theme.fg('dim', line))
  }
}

function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)
}
