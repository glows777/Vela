import type { VelaSettings } from '../config/settings-values.ts'
import type { ToolRegistry } from './registry.ts'

/** Seconds a foreground `bash` command may wait before it moves to the background. */
const DEFAULT_FOREGROUND_TIMEOUT_SECONDS = 120
/** Ceiling for a `timeout` the model asks for, in seconds. */
const DEFAULT_FOREGROUND_TIMEOUT_MAX_SECONDS = 600

/** A session's foreground `bash` budget (settings `bashForegroundTimeoutSeconds` / `…MaxSeconds`). */
export interface ForegroundBudget {
  /** Seconds before an unfinished foreground command moves to the background; 0 turns that off. */
  seconds: number
  /** Ceiling for a requested `timeout`, in seconds. */
  maxSeconds: number
}

/** The defaults, for a session whose settings say nothing (such as a bare SDK one). */
const DEFAULT_FOREGROUND_BUDGET: ForegroundBudget = {
  seconds: DEFAULT_FOREGROUND_TIMEOUT_SECONDS,
  maxSeconds: DEFAULT_FOREGROUND_TIMEOUT_MAX_SECONDS,
}

const budgets = new WeakMap<ToolRegistry, ForegroundBudget>()

/** Records the budget the session behind this registry resolved from its own settings. */
export function setForegroundBudget(
  registry: ToolRegistry,
  budget: ForegroundBudget,
): void {
  budgets.set(registry, budget)
}

/**
 * The budget for a tool call: the session's, or the defaults for a session with no settings of its
 * own (a bare SDK one). The registry is per session, so the value goes with it.
 */
export function foregroundBudgetOf(context: {
  registry?: ToolRegistry
}): ForegroundBudget {
  return (
    (context.registry ? budgets.get(context.registry) : undefined) ??
    DEFAULT_FOREGROUND_BUDGET
  )
}

/** The budget a session's settings ask for; the defaults when they say nothing. */
export function resolveForegroundBudget(
  settings: VelaSettings,
): ForegroundBudget {
  return {
    seconds:
      settings.bashForegroundTimeoutSeconds ??
      DEFAULT_FOREGROUND_TIMEOUT_SECONDS,
    maxSeconds:
      settings.bashForegroundTimeoutMaxSeconds ??
      DEFAULT_FOREGROUND_TIMEOUT_MAX_SECONDS,
  }
}

/**
 * A command that starts with `sleep` has no work to lose, so it keeps the old deadline: the
 * process is killed at it instead of being moved to the background.
 */
export function sleepsFirst(command: string): boolean {
  return /^sleep(?:\s|$)/.test(command.trimStart())
}

/** The seconds a timeout is reported with: `0.3`, `1`, `120`. */
export function seconds(value: number): string {
  return String(Math.round(value * 1000) / 1000)
}
