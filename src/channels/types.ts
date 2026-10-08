import type { Role } from '../security/roles.ts'

export interface IncomingMessage {
  /** The conversation the message came from (a group chat or a direct chat); replies go here. Together with the channel name and `senderId` it selects the session. */
  channelId: string
  /** Who sent the message */
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
   * The Vela role of this message's sender. Defaults to guest when not implemented:
   * external senders cannot read or write files, run commands, or see the owner's memory.
   */
  roleFor?: (msg: IncomingMessage) => Role
}
