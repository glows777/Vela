import type { Vela, VelaInternals } from '../../vela'
import type { VelaSession } from '../../vela-session'

export * from './context'
export * from './debug'
export * from './memory'

/**
 * 斜杠命令属于 CLI：它们读 SDK 提供的数据（vela / session），自己负责打印。
 * ask() 让 CLI 重新显示输入提示；异步命令结束时调用。
 */
export interface CommandContext {
  vela: Vela
  /** CLI 和 core 在同一个包里，命令可以读内部对象（记忆、知识库、hooks…） */
  internals: VelaInternals
  session: VelaSession
  ask: () => void
}

export type CommandHandler = (
  cmd: string,
  ctx: CommandContext,
) => boolean | 'async'

export function createDispatcher(handlers: CommandHandler[]): CommandHandler {
  return (cmd, ctx) => {
    for (const h of handlers) {
      const result = h(cmd, ctx)
      if (result) return result
    }
    return false
  }
}
