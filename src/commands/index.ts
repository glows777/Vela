import type { ModelMessage } from 'ai'
import type { MemoryStore } from '../memory/store'
import type { PromptContext, PromptPipeline } from '../prompt'
import type { SessionStore } from '../session'
import type { ToolRegistry } from '../tools/registry'
import type { TokenTracker } from '../usage/tracker'
import type { RequestSnapshot } from '../context/request'
import type { VelaEventListener } from '../agent/events'

export * from './context'
export * from './debug'
export * from './memory'

export interface CommandContext {
  messages: ModelMessage[]
  timestamps: Map<ModelMessage, number>
  registry: ToolRegistry
  builder: PromptPipeline
  tracker: TokenTracker
  sessionStore: SessionStore
  model: any
  makePromptCtx: () => PromptContext
  prepareContext: (request: RequestSnapshot, options?: { allowSummary?: boolean }) => Promise<void>
  saveSession: () => Promise<void>
  ask: () => void
  memoryStore?: MemoryStore
  /** agent 循环互斥锁：任一 agentLoop 运行时置位，防止并发启动第二个循环共享 messages */
  busy: { locked: boolean; controller?: AbortController }
  /** 命令内启动的 agentLoop 使用的事件回调 */
  onEvent?: VelaEventListener
  [key: string]: any
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
