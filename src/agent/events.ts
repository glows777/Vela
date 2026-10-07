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
  /** 模型的 thinking / reasoning 文本（provider 返回时才有） */
  | { type: 'thinking_delta'; text: string }
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
  /** 排队的消息变化（steer / followUp 入队、取出、清空），两个字段都是完整的当前队列 */
  | { type: 'queue_update'; steering: string[]; followUp: string[] }
  /**
   * prompt() 的所有工作都结束了（包括它之后排队的 steer / followUp 各自跑的 loop），
   * 会话回到空闲；同 pi 的 agent_settled。
   */
  | { type: 'agent_settled' }
  | {
      type: 'context'
      /** compact = session.compact() 手动摘要 */
      action: 'micro' | 'summary' | 'summary-required' | 'compact'
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
  /** 扩展在没有界面的会话里调用了 ui.notify() */
  | { type: 'notify'; message: string; level: 'info' | 'warning' | 'error' }
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
