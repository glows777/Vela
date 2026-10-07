import type { LanguageModel, ModelMessage } from 'ai'
import { agentLoop } from '../agent'
import type { VelaEventListener } from '../agent/events'
import type { VelaLimits } from '../limits'
import type { RequestSnapshot } from '../context/request'
import type { ToolRegistry } from '../tools/registry'
import { TokenTracker } from '../usage/tracker'
import type {
  ChannelDefinition,
  IncomingMessage,
  OutgoingMessage,
} from './types'

interface GatewayOptions {
  model: LanguageModel
  registry: ToolRegistry
  buildSystem: () => string
  prepareContext: (request: RequestSnapshot) => Promise<void>
  /** 每轮对话使用的 token 记录器；默认写入 .usage/today.jsonl */
  createTracker?: () => TokenTracker
  onEvent?: VelaEventListener
  limits?: Partial<VelaLimits>
}

export class ChannelGateway {
  private channels = new Map<string, ChannelDefinition>()
  private sessions = new Map<string, ModelMessage[]>()
  private controllers = new Map<string, AbortController>()
  private options: GatewayOptions

  constructor(options: GatewayOptions) {
    this.options = options
  }

  register(channel: ChannelDefinition): void {
    this.channels.set(channel.name, channel)

    channel.onMessage?.((msg: IncomingMessage) => {
      this.handleIncoming(channel.name, msg)
    })
  }

  async startAll(): Promise<void> {
    for (const [name, ch] of this.channels) {
      try {
        await ch.start()
        console.log(`  [gateway] ✓ ${name} 已启动`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`  [gateway] ✗ ${name} 启动失败: ${msg}`)
      }
    }
  }

  async stopAll(): Promise<void> {
    // 先中断所有仍在跑的 agent loop，再关停通道
    for (const controller of this.controllers.values()) {
      controller.abort()
    }
    this.controllers.clear()

    for (const [, ch] of this.channels) {
      await ch.stop()
    }
  }

  private async handleIncoming(
    channelName: string,
    msg: IncomingMessage,
  ): Promise<void> {
    const sessionKey = `${channelName}:${msg.senderId}`
    console.log(`\n  [${channelName}] ${msg.senderName}: ${msg.text}`)

    if (!this.sessions.has(sessionKey)) {
      this.sessions.set(sessionKey, [])
    }
    const messages = this.sessions.get(sessionKey)!

    const userMsg: ModelMessage = { role: 'user', content: msg.text }
    messages.push(userMsg)

    const controller = new AbortController()
    this.controllers.set(sessionKey, controller)

    try {
      await agentLoop({
        model: this.options.model,
        toolRegistry: this.options.registry,
        messages,
        // 传函数而非快照：agent loop 每轮都会重新构建 system prompt
        systemPrompt: this.options.buildSystem,
        tokenTracker:
          this.options.createTracker?.() ??
          new TokenTracker('.usage/today.jsonl'),
        prepareContext: this.options.prepareContext,
        abortSignal: controller.signal,
        onEvent: this.options.onEvent,
        limits: this.options.limits,
      })
    } catch (err) {
      if (controller.signal.aborted) {
        console.log(`  [${channelName}] 本轮已中断`)
      } else {
        const text = err instanceof Error ? err.message : String(err)
        console.error(`  [${channelName}] 本轮停止: ${text}`)
      }
      return
    } finally {
      this.controllers.delete(sessionKey)
    }

    // 从 messages 里取最后一条 assistant 消息作为回复
    const lastMsg = messages[messages.length - 1]
    let replyText = ''
    if (lastMsg && lastMsg.role === 'assistant') {
      const content = lastMsg.content
      if (typeof content === 'string') {
        replyText = content
      } else if (Array.isArray(content)) {
        replyText = content
          .map((c) => (c.type === 'text' ? c.text : ''))
          .join('')
      }
    }

    if (replyText) {
      const channel = this.channels.get(channelName)
      if (channel) {
        await channel.send({
          channelId: msg.channelId,
          recipientId: msg.senderId,
          text: replyText,
        })
        console.log(
          `  [${channelName}] → ${replyText.slice(0, 80)}${replyText.length > 80 ? '...' : ''}`,
        )
      }
    }
  }

  list(): Array<{ name: string; description: string }> {
    return Array.from(this.channels.values()).map((ch) => ({
      name: ch.name,
      description: ch.description,
    }))
  }
}
