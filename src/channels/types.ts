import type { VelaEvent } from '../agent/events.ts'
import type { ImageContent } from '../messages.ts'
import type { PermissionRules } from '../security/permissions.ts'

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
  /** Unsolicited group discussion: queue quietly and never recover work after restart. */
  passive?: boolean
  /** Scheduled inputs have no incoming service message ID and always queue. */
  routine?: { id: string; scheduledAt: string }
  raw?: unknown
}

export type RoutineSchedule =
  | { at: string }
  | {
      time: string
      days?: ('mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun')[]
    }

export interface ChannelRoutine {
  id: string
  channel: string
  chatId: string
  targetKey: string
  creator: { id: string; name: string }
  message: string
  schedule: RoutineSchedule
  createdAt: string
  lastFiredAt: string | null
}

/** A persisted routine with deployment-local display metadata. */
export interface ChannelRoutineInfo extends ChannelRoutine {
  timezone: string
  scheduleText: string
  target: string
  nextRun: string | null
}

export interface OutgoingMessage {
  routine?: IncomingMessage['routine']
  topic?: IncomingMessage['topic']
  channelId: string
  /** Optional person to mention; a reply target alone addresses a service message. */
  recipientId?: string
  text: string
  replyToId?: string
}

/** An owned topic from the durable directory with its current execution state. */
export interface ChannelTopic {
  rootId: string
  threadId: string
  task: string
  state: 'running' | 'queued' | 'waiting' | 'done' | 'stopped'
  requester: { id: string; name: string }
  updatedAt: string
  waitingReason?: string
}

export interface ChannelRuntime {
  routines: {
    /** One-off at is deployment-local YYYY-MM-DDTHH:mm; recurring times are local too. */
    create(
      sessionId: string,
      message: string,
      schedule: RoutineSchedule,
    ): Promise<ChannelRoutineInfo>
    list(sessionId: string): {
      timezone: string
      routines: ChannelRoutineInfo[]
    }
    cancel(sessionId: string, id: string): Promise<boolean>
  }
  context(sessionId: string): IncomingMessage | undefined
  topics(chatId: string): ChannelTopic[]
  topicCoverage(): string
  /** Suppress this active passive run's reply; the tool call is its only durable decision. */
  skipReply(sessionId: string): void
  /** Record a required human decision; waiting becomes visible after successful delivery. */
  waitForInput(sessionId: string, reason: string): Promise<void>
  /** Hand off without waiting for the target run; suppress the source run's duplicate reply. `label` is the topic list entry when the message text is a longer brief. */
  dispatch(
    sourceSessionId: string,
    message: IncomingMessage,
    label?: string,
  ): void
}

/** `silent` removes a deferred passive marker without adding an outcome reaction. */
export type ChannelOutcome = 'done' | 'failed' | 'stopped' | 'silent'

/** Channel-local lifecycle updates; agent events retain their core shape. */
export type ChannelFeedbackUpdate =
  | {
      type: 'controls'
      message: IncomingMessage
      /** Aborted when the targeted run ends; expire its callbacks then. */
      signal: AbortSignal
      /** Synchronously reserves a choice; false means expired or already chosen. */
      choose: (action: 'queue' | 'steer' | 'stop') => boolean
      error: (error: unknown) => Promise<void>
    }
  | { type: 'agent'; event: VelaEvent }

export interface ChannelRunFeedback {
  /** Controls are awaited before prompting. Agent updates do not block the stream; pending work drains before the reply. */
  event(update: ChannelFeedbackUpdate): void | Promise<void>
  /** Called once after result delivery (or failure/Stop), including transferred inputs. */
  finish(outcome: ChannelOutcome): Promise<void>
}

/** Channel hooks remain experimental: only Feishu is implemented so far; stabilization waits for a second channel implementation. */
export interface ChannelDefinition {
  name: string
  description: string
  /** Deployment-local schedule zone, validated before transport startup. */
  timezone?: unknown
  /** Adapt scheduled input routing; undefined skips a wake-up with operator diagnostics. */
  prepareRoutine?: (
    msg: IncomingMessage,
    chatKind: 'group' | 'direct',
    reminder: { message: string; lateByMs: number },
  ) => Promise<IncomingMessage | undefined>

  connect?: (runtime: ChannelRuntime) => void
  sessionOptions?: (msg: IncomingMessage) => {
    cwd?: string
    tools?: string[]
    permissions?: PermissionRules
  }
  /** Validate configured tool names after extensions load, before transport or recovery starts. */
  validateTools?: (names: readonly string[]) => void

  /** Recheck current channel access before restoring work from the directory. False skips recovery. */
  canRecover?: (
    message: IncomingMessage,
    chatKind: 'group' | 'direct',
  ) => boolean

  /** `false` means the channel is not configured to connect; the gateway skips its startup line, routines and recovery. */
  // biome-ignore lint/suspicious/noConfusingVoidType: public shape: `undefined` would reject channel implementations whose start returns nothing
  start(): Promise<boolean | void> | boolean | void
  stop(): Promise<void> | void
  send(message: OutgoingMessage): Promise<void>

  /** Await the handler to wait until the gateway finishes this message and its reply. */
  onMessage?: (handler: (msg: IncomingMessage) => void | Promise<void>) => void

  /** Prepare names/context when ready to run. Steer also receives the active trigger already in the session. Undefined means handled without a prompt. */
  prepareMessage?: (
    msg: IncomingMessage,
    activeMessage?: IncomingMessage,
  ) => Promise<IncomingMessage | undefined>

  /** Remains experimental pending a second channel implementation. Starts after admission, before preparation; false requests presentation without another acknowledgement. No live receive event is required. */
  startRun?: (
    message: IncomingMessage,
    options: { acknowledge: boolean },
    // biome-ignore lint/suspicious/noConfusingVoidType: public shape: `undefined` would reject channel implementations whose async startRun returns nothing (Promise<void>)
  ) => Promise<ChannelRunFeedback | void>
}
