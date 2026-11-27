import type { VelaRuntime } from '../../runtime-sdk-types.ts'
import type { CliSessionClient } from '../runtime-client.ts'

/**
 * Slash commands belong to the CLI: they read data `VelaRuntime` and `CliSessionClient` expose
 * and write output through `print()`.
 */
export interface CommandContext {
  runtime: VelaRuntime
  session: CliSessionClient
  /** Print text (may be multi-line) */
  print: (text: string) => void
  /** Configured agent directory (`VELA_DIR` or `~/.vela`). */
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
