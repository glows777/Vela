import type { StepRecord, StepUsage } from '../usage/tracker'

/**
 * Agent 运行过程中对外报告的事件。核心代码只发事件，不直接写终端；
 * CLI、通道和测试各自决定怎么展示或断言。
 */
export type VelaEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string; input: unknown }
  | {
      type: 'tool_result'
      toolCallId: string
      toolName: string
      input: unknown
      output: unknown
    }
  | {
      type: 'tool_error'
      toolCallId: string
      toolName: string
      input: unknown
      error: unknown
    }
  | {
      type: 'loop_detected'
      level: 'warning' | 'critical'
      detector: string
      message: string
    }
  | {
      type: 'retry'
      attempt: number
      maxRetries: number
      delayMs: number
      error: unknown
    }
  | {
      type: 'usage'
      modelId: string
      usage: StepUsage
      record?: StepRecord
    }
  | { type: 'budget_warning'; used: number; limit: number }
  | { type: 'turn_end'; turn: number; needsToolCall: boolean }
  | {
      type: 'agent_end'
      reason: 'done' | 'max_turns' | 'budget' | 'loop' | 'aborted' | 'error'
      error?: unknown
    }
  | {
      type: 'context'
      action: 'micro' | 'summary' | 'summary-required'
      before: number
      after?: number
      saved?: number
      calls?: number
      messages?: number
    }
  | { type: 'session_save_failed'; error: unknown }
  /** 文件写入类工具调用前的审计记录（pre hook 发出） */
  | { type: 'audit'; toolName: string; path: string }

export type VelaEventListener = (event: VelaEvent) => void
