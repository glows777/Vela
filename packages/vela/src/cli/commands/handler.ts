import type { VelaSession } from '@glows777/vela-core'
import type { Vela } from '../../vela.ts'

/**
 * Slash commands belong to the CLI: they read data the SDK exposes (vela / session) and
 * write output through print() (the TUI puts it in the chat log; tests capture it).
 */
export interface CommandContext {
  vela: Vela
  session: VelaSession
  /** Print text (may be multi-line) */
  print: (text: string) => void
  /** Configured agent directory (`VELA_DIR` or `~/.vela`). `/status` substitutes `$VELA_DIR` only for files under it. */
  agentDir?: string
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
