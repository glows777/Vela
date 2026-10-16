import type { Role } from '../security/roles.ts'

export interface IncomingMessage {
  /** The conversation the message came from (a group chat or a direct chat); replies go here. Together with the channel name it selects the shared session. */
  channelId: string
  /** Who sent the message */
  senderId: string
  senderName: string
  text: string
  /** Reply to this service message instead of starting a new message (for group conversations). */
  replyToId?: string
  raw?: unknown
}

export interface OutgoingMessage {
  channelId: string
  recipientId: string
  text: string
  replyToId?: string
}

export interface ChannelDefinition {
  name: string
  description: string

  start(): Promise<void> | void
  stop(): Promise<void> | void
  send(message: OutgoingMessage): Promise<void>

  /** Await the handler to wait until the gateway finishes this message and its reply. */
  onMessage?: (handler: (msg: IncomingMessage) => void | Promise<void>) => void

  /** Prepare names/context when ready to run. Steer also receives the active trigger already in the session. Undefined means handled without a prompt. */
  prepareMessage?: (
    msg: IncomingMessage,
    activeMessage?: IncomingMessage,
  ) => Promise<IncomingMessage | undefined>

  /** Offer controls for this queued message while the preceding run is active. */
  showRunControls?: (
    msg: IncomingMessage,
    controls: {
      /** Aborted when the original run ends; old cards must no longer control anything. */
      signal: AbortSignal
      /** Reserves a choice synchronously; false means expired or already chosen. */
      choose: (action: 'queue' | 'steer' | 'stop') => boolean
    },
  ) => Promise<void>

  /**
   * The Vela role for the enabled chat. Defaults to owner: a channel must enforce
   * its own chat enablement boundary before delivering messages.
   */
  roleFor?: (msg: IncomingMessage) => Role
}
