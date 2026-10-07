import type { Role } from '../security/roles'

export interface IncomingMessage {
  channelId: string
  senderId: string
  senderName: string
  text: string
  raw?: unknown
}

export interface OutgoingMessage {
  channelId: string
  recipientId: string
  text: string
}

export interface ChannelDefinition {
  name: string
  description: string

  start(): Promise<void> | void
  stop(): Promise<void> | void
  send(message: OutgoingMessage): Promise<void>

  onMessage?: (handler: (msg: IncomingMessage) => void) => void

  /**
   * 这条消息的发送者在 Vela 里是什么角色。不实现时一律 guest：
   * 外部发送者默认不能读写文件、跑命令、看到主人的记忆。
   */
  roleFor?: (msg: IncomingMessage) => Role
}
