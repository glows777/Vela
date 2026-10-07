import type { Vela, VelaInternals } from '../../vela.ts'
import type { VelaSession } from '../../vela-session.ts'

export * from './context.ts'
export * from './debug.ts'

/**
 * 斜杠命令属于 CLI：它们读 SDK 提供的数据（vela / session），输出交给 print()
 * （TUI 写进对话区，测试捕获）。
 */
export interface CommandContext {
  vela: Vela
  /** CLI 和 core 在同一个包里，命令可以读内部对象（记忆、知识库、hooks…） */
  internals: VelaInternals
  session: VelaSession
  /** 输出一段文字（可以多行） */
  print: (text: string) => void
}

/** 返回 false 表示不是这个命令；true 表示已处理；Promise 表示已处理、还在异步执行。 */
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
