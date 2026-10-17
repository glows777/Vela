import type { VelaEvent } from '../agent/events.ts'
import type { ImageContent } from '../messages.ts'
import type { PermissionRules, Role } from '../security/roles.ts'

export interface IncomingMessage {
  /** The conversation the message came from (a group chat or a direct chat); replies go here. Together with the channel name and optional topic root it selects the session. */
  channelId: string
  /** Who sent the message */
  senderId: string
  senderName: string
  text: string
  images?: ImageContent[]
  /** Reply to this service message instead of starting a new message (for group conversations). */
  replyToId?: string
  /** The root message identifies a topic independently of its platform container. */
  topic?: { rootId: string; threadId: string }
  /** Admit only if this topic already has a saved session. */
  requireExistingSession?: boolean
  /** Set by the gateway before preparation when entering a topic without saved context. */
  isNewTopic?: boolean
  raw?: unknown
}

export interface OutgoingMessage {
  topic?: IncomingMessage['topic']
  channelId: string
  recipientId: string
  text: string
  replyToId?: string
}

/** The gateway's observed topic and current execution state, not a durable directory. */
export interface ChannelTopic {
  rootId: string
  threadId: string
  task: string
  state: 'running' | 'queued' | 'idle'
}

export interface ChannelRuntime {
  context(sessionId: string): IncomingMessage | undefined
  topics(chatId: string): ChannelTopic[]
  /** Hand off without waiting for the target run; suppress the source run's duplicate reply. */
  dispatch(sourceSessionId: string, message: IncomingMessage): void
}

export type ChannelOutcome = 'done' | 'failed' | 'stopped'

export interface ChannelAcknowledgement {
  finish(outcome: ChannelOutcome): Promise<void>
}

export interface ChannelRunFeedback {
  event(event: VelaEvent): void
  finish(outcome: ChannelOutcome): Promise<void>
}

export interface ChannelDefinition {
  name: string
  description: string

  connect?: (runtime: ChannelRuntime) => void
  sessionOptions?: (msg: IncomingMessage) => { permissions?: PermissionRules }

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

  /** Called after admission, before queued preparation. */
  acknowledge?: (msg: IncomingMessage) => Promise<ChannelAcknowledgement | void>

  /** One Stop/progress card for this run; events arrive before prompt completion. */
  showTopicControls?: (
    msg: IncomingMessage,
    controls: {
      signal: AbortSignal
      stop: () => boolean
      error: (error: unknown) => Promise<void>
    },
  ) => Promise<ChannelRunFeedback | void>

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
