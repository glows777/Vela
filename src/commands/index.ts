import type { ModelMessage } from 'ai'
import type { MemoryStore } from '../memory/store'
import type { PromptContext, PromptPipeline } from '../prompt'
import type { SessionStore } from '../session'
import type { ToolRegistry } from '../tools/registry'
import type { TokenTracker } from '../usage/tracker'

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
  ask: () => void
  memoryStore?: MemoryStore
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
