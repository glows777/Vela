import type { ToolInputSchema } from '../shared/tool-schema.ts'
import type { ProjectRecord, SessionRecord } from './domain-types.ts'
import type { RuntimeEventListener, StreamDeltaListener } from './event-bus.ts'
import type { RuntimeMessagePage } from './messages.ts'

/**
 * v0.9 Runtime-level channel adapter contracts, completely decoupled from `ExtensionAPI`.
 *
 * Channels (e.g. Lark) attach directly to `Runtime` as first-class `ChannelAdapter`s bound to
 * a `Project` (group chat) or standalone `Session` (DM), rather than registering through the
 * tool/hook extension API.
 */

export type ChannelBindingKind = 'group' | 'direct'

/** Durable link between an external chat/thread and a Vela `Project` or `Session`. */
export interface ChannelBinding {
  id: string
  channel: string
  externalId: string
  threadId?: string | null
  kind: ChannelBindingKind
  projectId: string | null
  sessionId: string | null
  enabled: boolean
  config?: Record<string, unknown>
}

export interface ChannelInboundAttachment {
  name: string
  mimeType?: string
  /** Opaque channel-specific handle used to fetch bytes lazily. */
  ref: string
  /** Keep image inline-only without materializing an attachment file inside the workspace. */
  inlineOnly?: boolean
}

/** Normalized inbound event pushed by a `ChannelAdapter` into `Runtime` `inbox_events`. */
export interface ChannelInboundMessage {
  channel: string
  dedupeKey: string
  externalChatId: string
  kind: ChannelBindingKind
  threadId?: string
  threadRootId?: string
  messageId?: string
  senderId: string
  senderName: string
  text: string
  mentioned?: boolean
  mentionRecipient?: boolean
  passive?: boolean
  wake?: boolean
  /** Do not auto-create a topic or DM session if no active binding exists yet. */
  requireExistingSession?: boolean
  /** Adapter already formatted attribution/context; driver should not prepend `${senderName}: `. */
  preformatted?: boolean
  /** Original raw text preserved for memory/dream provenance when `preformatted` is true. */
  rawText?: string
  attachments?: ChannelInboundAttachment[]
  timestamp: string
  raw?: unknown
}

/** Outbound payload delivered by `Runtime` `outbox` through a `ChannelAdapter`. */
export interface ChannelOutboundMessage {
  outboxId: string
  runId?: string
  kind?: 'reply' | 'topic_start' | 'forward' | 'file'
  channel: string
  externalChatId: string
  threadId?: string
  replyToMessageId?: string
  title?: string
  forwardMessageId?: string
  recipientId?: string
  mentionRecipient?: boolean
  isRoutine?: boolean
  isHandoff?: boolean
  text: string
  files?: { path: string; name?: string; mimeType?: string }[]
}

export interface ChannelDeliveryResult {
  externalMessageId?: string
  threadId?: string
  rootId?: string
}

export interface ChannelConnectionState {
  connected: boolean
  error?: string
}

export interface ChannelStatusInfo {
  name: string
  enabled: boolean
  connected: boolean
  error?: string
}

export interface ChannelChatInfo {
  chatId: string
  name?: string
}

export interface ChannelHostSubmitInput {
  chatId: string
  text: string
  author: { id: string; name: string }
  sessionId?: string
  newTopic?: { title: string }
}

export interface ChannelHostSubmitResult {
  outcome: 'posted' | 'not-sent' | 'uncertain'
  sessionId?: string
  messageId?: string
  topic?: { rootId: string; threadId: string }
  error?: string
}

export interface ChannelAnnouncementInput {
  externalChatId: string
  threadId?: string
  text: string
  idempotencyKey?: string
  signal?: AbortSignal
}

export interface ChannelAnnouncementResult {
  externalMessageId?: string
}

export interface ChannelToolContext {
  sessionId: string
  projectId: string | null
  channel: string
  externalChatId: string
  threadId?: string | null
  kind: ChannelBindingKind
  signal?: AbortSignal
}

export interface ChannelToolSpec {
  readonly name: string
  readonly description: string
  readonly inputSchema: ToolInputSchema
  readonly maxResultChars?: number
  readonly readOnly?: boolean
  execute(
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous channel tool inputs
    input: any,
    context: ChannelToolContext,
  ): Promise<unknown> | unknown
}

export interface ChannelIngestReceipt {
  admitted: boolean
  sessionId?: string
  inboxEventId?: string
  shortcut?: boolean
  reason?: string
}

export interface ChannelAdapterContext {
  /** Submit a normalized inbound event into the durable `inbox_events` queue. */
  ingest(message: ChannelInboundMessage): Promise<void>
  ingestWithReceipt?(
    message: ChannelInboundMessage,
  ): Promise<ChannelIngestReceipt>
  subscribeEvents?(listener: RuntimeEventListener): () => void
  subscribeDeltas?(listener: StreamDeltaListener): () => void
  stopSession?(sessionId: string, reason?: string): Promise<boolean>
  steerSession?(sessionId: string, text: string): Promise<void>
  discardInboxEvent?(inboxEventId: string): boolean
  steerInboxEvent?(
    sessionId: string,
    inboxEventId: string,
    text: string,
  ): Promise<boolean>
  listBindings?(filter?: {
    channel?: string
    projectId?: string
    enabledOnly?: boolean
  }): ChannelBinding[]
  getSession?(id: string): SessionRecord | undefined
  getProject?(id: string): ProjectRecord | undefined
  recordHostPostAuthor?(externalMessageId: string, authorName: string): void
  getHostPostAuthor?(externalMessageId: string): string | undefined
}

/** First-class external messaging adapter hosted by `Runtime`. */
export interface ChannelAdapter {
  readonly name: string
  readonly description?: string
  readonly timezone?: string
  start(ctx: ChannelAdapterContext): Promise<void>
  stop(): Promise<void>
  deliver(message: ChannelOutboundMessage): Promise<ChannelDeliveryResult>
  onDeliverySettled?(info: {
    outboxId: string
    runId?: string
    kind: string
    status: 'sent' | 'failed'
  }): void
  fetchAttachment?(ref: string, signal?: AbortSignal): Promise<Uint8Array>
  status?(): ChannelConnectionState
  listMessages?(input: {
    sessionId: string
    externalChatId: string
    threadId?: string | null
    kind: ChannelBindingKind
    cursor?: string
    limit?: number
  }): Promise<RuntimeMessagePage>
  listChats?(): Promise<ChannelChatInfo[]>
  submitFromHost?(
    input: ChannelHostSubmitInput,
  ): Promise<ChannelHostSubmitResult>
  announce?(
    input: ChannelAnnouncementInput,
  ): Promise<ChannelAnnouncementResult | undefined>
  getTools?(binding: ChannelBinding): readonly ChannelToolSpec[]
}
