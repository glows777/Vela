import type { LanguageModelV4Usage } from '@ai-sdk/provider'
import { pricing } from './report.ts'

// The selected text-only model has a 1M context. Reserve peak, entirely uncached
// input plus the enforced output limit before each provider request.
export const isolatedOutputLimit = 8192
export const requestReservation =
  (1_000_000 * pricing.input + isolatedOutputLimit * pricing.output) / 1_000_000

export class RequestBudget {
  private known = 0
  private pending = new Set<symbol>()
  private waiters = new Set<() => void>()
  constructor(
    readonly limit: number,
    private readonly waitMs = 30_000,
  ) {
    if (!Number.isFinite(limit) || limit <= 0)
      throw new Error('Invalid evaluation request budget')
  }
  get upperBound() {
    return this.known + this.pending.size * requestReservation
  }
  async admit(): Promise<symbol> {
    const deadline = Date.now() + this.waitMs
    while (this.upperBound + requestReservation > this.limit) {
      // A concurrent stream can still settle below its peak reserve. Wait for
      // that settlement, never release unknown usage or exceed the allowance.
      if (
        !this.pending.size ||
        this.known + requestReservation > this.limit ||
        Date.now() >= deadline
      )
        throw new Error('Evaluation budget exhausted before provider request')
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer)
          this.waiters.delete(wake)
          resolve()
        }
        const timer = setTimeout(wake, Math.max(0, deadline - Date.now()))
        this.waiters.add(wake)
      })
    }
    const ticket = Symbol()
    this.pending.add(ticket)
    return ticket
  }
  settle(ticket: symbol, usage: LanguageModelV4Usage | undefined) {
    if (
      !this.pending.has(ticket) ||
      usage?.inputTokens.total == null ||
      usage.outputTokens.total == null
    )
      return
    const input = usage.inputTokens.total
    const cached = usage.inputTokens.cacheRead ?? 0
    const cost =
      (Math.max(0, input - cached) * pricing.input +
        cached * pricing.cached +
        usage.outputTokens.total * pricing.output) /
      1_000_000
    if (
      input > 1_000_000 ||
      usage.outputTokens.total > isolatedOutputLimit ||
      cost > requestReservation
    )
      throw new Error(
        'Provider usage exceeded the evaluation reservation contract',
      )
    this.pending.delete(ticket)
    this.known += cost
    for (const wake of this.waiters) wake()
  }
}
