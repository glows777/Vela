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
}

/** Normalized inbound event pushed by a `ChannelAdapter` into `Runtime` `inbox_events`. */
export interface ChannelInboundMessage {
  channel: string
  dedupeKey: string
  externalChatId: string
  kind: ChannelBindingKind
  threadId?: string
  messageId?: string
  senderId: string
  senderName: string
  text: string
  mentioned?: boolean
  passive?: boolean
  wake?: boolean
  attachments?: ChannelInboundAttachment[]
  timestamp: string
  raw?: unknown
}

/** Outbound payload delivered by `Runtime` `outbox` through a `ChannelAdapter`. */
export interface ChannelOutboundMessage {
  outboxId: string
  kind?: 'reply' | 'topic_start' | 'forward' | 'file'
  channel: string
  externalChatId: string
  threadId?: string
  replyToMessageId?: string
  title?: string
  forwardMessageId?: string
  text: string
  files?: { path: string; name?: string; mimeType?: string }[]
}

export interface ChannelDeliveryResult {
  externalMessageId?: string
  threadId?: string
  rootId?: string
}

export interface ChannelAdapterContext {
  /** Submit a normalized inbound event into the durable `inbox_events` queue. */
  ingest(message: ChannelInboundMessage): Promise<void>
}

/** First-class external messaging adapter hosted by `Runtime`. */
export interface ChannelAdapter {
  readonly name: string
  readonly description?: string
  start(ctx: ChannelAdapterContext): Promise<void>
  stop(): Promise<void>
  deliver(message: ChannelOutboundMessage): Promise<ChannelDeliveryResult>
  fetchAttachment?(ref: string, signal?: AbortSignal): Promise<Uint8Array>
}
