import {
  type Check,
  chars,
  type Evidence,
  type Repetition,
  type ScenarioId,
} from './graders.ts'

export interface Usage {
  input: number
  cached: number
  output: number
  main: number
  summary: number
  requests: number
  unknown: number
  cost: number
}
export const emptyUsage = (): Usage => ({
  input: 0,
  cached: 0,
  output: 0,
  main: 0,
  summary: 0,
  requests: 0,
  unknown: 0,
  cost: 0,
})
// Conservative official peak list prices; this is an estimate, not an invoice.
export const pricing = {
  input: 0.3,
  cached: 0.006,
  output: 1.2,
  source: 'https://api-docs.deepseek.com/quick_start/pricing/',
  date: '2026-10-26',
  basis: 'peak USD per million tokens',
}
export interface Attempt {
  repetition?: Repetition
  scenario: ScenarioId
  arm: 'old' | 'new'
  run: number
  attempt: number
  status: 'pass' | 'fail' | 'error' | 'skipped'
  reason?: string
  checks: Check[]
  evidence?: Evidence
  usage: Usage
  durationMs: number
  sessionFiles: string[]
  finalChars: number
  toolCalls: number
  artifactDir: string
}
function median(values: number[]): number | undefined {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1]! + sorted[middle]!) / 2
}
const display = (value: number | undefined) =>
  value === undefined ? '—' : Number(value.toFixed(2)).toString()
export function table(
  attempts: Attempt[],
  ids: readonly ScenarioId[],
  runs: number,
): string {
  const lines = [
    '| Scenario | Old pass/valid | New pass/valid | Median chars old/new (Δ) | Repeat % old/new (T2/T3/T4; max) | Median tools old/new (Δ) | Estimated $ old/new | Notes |',
    '|---|---:|---:|---:|---|---:|---:|---|',
  ]
  for (const id of ids) {
    const arms = (['old', 'new'] as const).map((arm) => {
      const all = attempts.filter((a) => a.scenario === id && a.arm === arm)
      const valid = all.filter(
        (a) => a.status === 'pass' || a.status === 'fail',
      )
      return {
        all,
        valid,
        passes: valid.filter((a) => a.status === 'pass').length,
        chars: median(valid.map((a) => a.finalChars)),
        tools: median(valid.map((a) => a.toolCalls)),
        cost: all.reduce((sum, a) => sum + a.usage.cost, 0),
      }
    })
    const old = arms[0]!
    const current = arms[1]!
    const notes: string[] = []
    if (arms.every((a) => a.passes === runs && a.valid.length === runs))
      notes.push('too easy')
    if (arms.some((a) => a.passes > 0 && a.passes < a.valid.length))
      notes.push('flaky')
    for (const [index, arm] of arms.entries()) {
      const errors = arm.all.filter((a) => a.status === 'error').length
      const skips = arm.all.filter((a) => a.status === 'skipped').length
      if (errors || skips)
        notes.push(
          `${index ? 'new' : 'old'}: ${errors} error, ${skips} skipped`,
        )
    }
    if (arms.some((a) => a.all.some((item) => item.usage.unknown)))
      notes.push('usage unknown')
    if (id === 'C6') notes.push('recorded only')
    const pair = (a: number | undefined, b: number | undefined) =>
      `${display(a)}/${display(b)} (${display(a === undefined || b === undefined ? undefined : b - a)})`
    const repeats = arms.map(({ valid }) => {
      const metrics = valid.flatMap((attempt) =>
        attempt.repetition ? [attempt.repetition] : [],
      )
      if (!metrics.length) return '—'
      const perTurn = [2, 3, 4].map((turn) =>
        Math.max(
          ...metrics.flatMap((metric) =>
            metric.turns
              .filter((item) => item.turn === turn)
              .map((item) => item.percent),
          ),
        ),
      )
      return `${perTurn.map(display).join('/')}; max ${display(Math.max(...metrics.map((metric) => metric.maxPercent)))}`
    })
    lines.push(
      `| ${id} | ${old.passes}/${old.valid.length} | ${current.passes}/${current.valid.length} | ${repeats.join(' / ')} | ${pair(old.tools, current.tools)} | ${old.cost.toFixed(4)}/${current.cost.toFixed(4)} | ${notes.join('; ')} |`,
    )
  }
  for (const arm of ['old', 'new']) {
    const lengths = attempts
      .filter(
        (a) =>
          a.arm === arm &&
          ['C1', 'C4'].includes(a.scenario) &&
          ['pass', 'fail'].includes(a.status),
      )
      .flatMap((a) => a.evidence?.answers.map(chars) ?? [])
    const value = median(lengths)
    lines.push(
      `${arm} C1/C4 aggregate answer median: ${display(value)} chars; ≤1000 target: ${value === undefined ? 'unavailable' : value <= 1000 ? 'met' : 'not met'} (not a per-run gate).`,
    )
  }
  const problems = attempts.filter(
    (a) => a.status === 'error' || a.status === 'skipped',
  )
  if (problems.length)
    lines.push(
      '',
      ...problems.map(
        (a) =>
          `${a.scenario}/${a.arm}/${a.run}/attempt-${a.attempt}: ${a.status}: ${a.reason}`,
      ),
    )
  return lines.join('\n')
}
