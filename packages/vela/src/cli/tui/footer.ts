import { homedir } from 'node:os'
import {
  type Component,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui'
import type { VelaSession } from '@glows777/vela-core'
import { formatUsd } from '../format.ts'
import { sanitize } from './components.ts'
import { theme } from './theme.ts'

export class Footer implements Component {
  private readonly statuses = new Map<string, string>()

  constructor(
    private readonly cwd: string,
    private readonly session: () => VelaSession | undefined,
  ) {}

  setStatus(key: string, text?: string): void {
    if (text) this.statuses.set(key, text)
    else this.statuses.delete(key)
  }

  invalidate(): void {}

  render(width: number): string[] {
    const session = this.session()
    if (!session) return []
    const home = homedir()
    const dir = this.cwd.startsWith(home)
      ? `~${this.cwd.slice(home.length)}`
      : this.cwd
    const usage = session.usage
    const totals = usage.totals
    let model = '(no model)'
    try {
      model = session.modelInfo.ref
    } catch {}
    const left = [
      `↑${compact(totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens)}`,
      `↓${compact(totals.outputTokens)}`,
      typeof totals.cost === 'number' ? formatUsd(totals.cost) : undefined,
      `${usage.percent}%`,
    ]
      .filter(Boolean)
      .join(' ')
    const right = `${model} · ${session.thinkingLevel}`
    const gap = Math.max(
      1,
      width - visibleWidth(left) - visibleWidth(right) - 2,
    )
    const lines = [
      truncateToWidth(
        ` ${dir} · ${sanitize(session.name ?? session.id)}`,
        width,
      ),
      truncateToWidth(` ${left}${' '.repeat(gap)}${right}`, width),
    ]
    if (this.statuses.size)
      lines.push(
        truncateToWidth(` ${[...this.statuses.values()].join(' · ')}`, width),
      )
    return lines.map((line) => theme.fg('dim', line))
  }
}

function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)
}
