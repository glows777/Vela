import type { Vela, VelaInternals } from '../../vela.ts'
import type { VelaSession } from '../../vela-session.ts'

export * from './context.ts'
export * from './debug.ts'

/**
 * Slash commands belong to the CLI: they read data the SDK exposes (vela / session) and
 * write output through print() (the TUI puts it in the chat log; tests capture it).
 */
export interface CommandContext {
  vela: Vela
  /** The CLI ships in the same package as core, so commands may read internals (memory, knowledge base, hooks, ...) */
  internals: VelaInternals
  session: VelaSession
  /** Print text (may be multi-line) */
  print: (text: string) => void
}

/** false: not this command; true: handled; Promise: handled and still running. */
export type CommandHandler = (
  cmd: string,
  ctx: CommandContext,
) => boolean | Promise<void>

export function createDispatcher(handlers: CommandHandler[]): CommandHandler {
  return (cmd, ctx) => {
    for (const h of handlers) {
      const result = h(cmd, ctx)
      if (result) return result
    }
    return false
  }
}
