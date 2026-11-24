import { homedir } from 'node:os'
import {
  type Component,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui'
import type { VelaSession } from '../../driver/index.ts'
import { formatUsd } from '../format.ts'
import { sanitize } from './components.ts'
import { theme } from './theme.ts'

export class Footer implements Component {
  constructor(
    private readonly cwd: string,
    private readonly session: () => VelaSession | undefined,
  ) {}

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
    // A plan-funded session says which plan pays, e.g. `openai/gpt-6.2-sol · medium · ChatGPT plan`
    const plan = session.planLabel
    const right = `${model} · ${session.thinkingLevel}${plan ? ` · ${plan}` : ''}`
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
    const running =
      session.registry.background
        ?.tasks()
        .filter((task) => task.snapshot.state === 'running') ?? []
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
