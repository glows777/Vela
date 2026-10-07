import type { ModelMessage } from 'ai'
import type { StepRecord, StepUsage } from '../usage/tracker'

/**
 * Agent 运行过程中对外报告的事件。核心代码只发事件，不直接写终端；
 * CLI、通道和测试各自决定怎么展示或断言。
 */
export type VelaEvent =
  /** session.prompt() 开始处理一条用户输入（斜杠命令触发的 skill / dream 也算） */
  | { type: 'agent_start'; input: string }
  /** 一条消息进入会话历史：用户输入、模型回复、工具结果、循环检测提醒 */
  | { type: 'message'; message: ModelMessage }
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
  /** bash 命令被判为中等风险，照常执行但提示一下 */
  | { type: 'security_warning'; toolName: string; reason: string; command: string }
  /** 通道收到一条消息（channel 会话） */
  | {
      type: 'channel_message'
      channel: string
      senderId: string
      senderName: string
      text: string
    }
  /** 通道回发了一条回复 */
  | { type: 'channel_reply'; channel: string; recipientId: string; text: string }
  /** 通道这一轮处理失败（含中断） */
  | {
      type: 'channel_error'
      channel: string
      senderId: string
      error: unknown
      aborted: boolean
    }

export type VelaEventListener = (event: VelaEvent) => void

/** vela.subscribe() 的回调：所有会话的事件，第二个参数是事件所属的会话 id。 */
export type VelaSessionEventListener = (
  event: VelaEvent,
  sessionId: string,
) => void
