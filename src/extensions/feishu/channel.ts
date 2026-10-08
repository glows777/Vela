import * as lark from '@larksuiteoapi/node-sdk'
import type {
  ChannelDefinition,
  IncomingMessage,
  OutgoingMessage,
  Role,
  VelaLogger,
} from '../../index.ts'

export interface FeishuChannelConfig {
  appId: string
  appSecret: string
  /** These senders (open_id) are owners; all other senders are guests */
  owners: readonly string[]
  logger: VelaLogger
}

export class FeishuChannel implements ChannelDefinition {
  name = 'feishu'
  description = 'Feishu bot message channel (long-connection mode)'

  private config: FeishuChannelConfig
  private messageHandler?: (msg: IncomingMessage) => void
  private wsClient?: lark.WSClient
  private larkClient?: lark.Client

  constructor(config: FeishuChannelConfig) {
    this.config = config
  }

  roleFor(msg: IncomingMessage): Role {
    return this.config.owners.includes(msg.senderId) ? 'owner' : 'guest'
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler
  }

  async start(): Promise<void> {
    if (!this.config.appId || !this.config.appSecret) {
      this.config.logger.warn(
        '[feishu] appId / appSecret not configured; channel will not connect to Feishu',
      )
      return
    }

    this.larkClient = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    })

    const dispatcher = new lark.EventDispatcher({})

    dispatcher.register({
      'im.message.receive_v1': (data) => {
        if (data.message.message_type !== 'text') return

        const content = JSON.parse(data.message.content)
        let text = content.text || ''
        // Strip @Bot mention markers
        if (data.message.mentions) {
          for (const m of data.message.mentions) {
            text = text.replace(m.key, '').trim()
          }
        }

        if (text && this.messageHandler) {
          this.messageHandler({
            // The chat (group or direct) is the conversation: each sender gets one session per chat
            channelId: data.message.chat_id,
            senderId: data.sender.sender_id?.open_id || 'unknown',
            senderName: data.sender.sender_id?.open_id || 'unknown',
            text,
            raw: data,
          })
        }
      },
    })

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.warn,
    })

    await this.wsClient.start({ eventDispatcher: dispatcher })
    this.config.logger.info('[feishu] Long connection established')
  }

  async stop(): Promise<void> {
    this.wsClient?.close()
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (!this.larkClient) {
      this.config.logger.warn(
        `[feishu] Feishu not configured, skipping send: ${message.text.slice(0, 50)}`,
      )
      return
    }

    try {
      await this.larkClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: message.channelId,
          msg_type: 'text',
          content: JSON.stringify({ text: message.text }),
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.config.logger.error(`[feishu] Send failed: ${msg}`)
    }
  }
}
