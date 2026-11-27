import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelAnnouncementInput,
  ChannelAnnouncementResult,
  ChannelBinding,
  ChannelChatInfo,
  ChannelConnectionState,
  ChannelDeliveryResult,
  ChannelHostSubmitInput,
  ChannelHostSubmitResult,
  ChannelOutboundMessage,
  ChannelToolSpec,
} from '../runtime/channels.ts'
import type { RuntimeMessagePage } from '../runtime/messages.ts'
import { silentLogger, type VelaLogger } from '../shared/logger.ts'
import { routineTimezone } from '../shared/routine-time.ts'
import { FileTooLarge, MAX_ATTACHMENT_BYTES } from './attachments.ts'
import { type LarkChat, parseChats } from './chats.ts'
import { LarkConnection } from './connection.ts'
import { messageText } from './messages.ts'
import {
  listLarkRuntimeMessages,
  submitLarkRuntimeHostMessage,
} from './runtime-host.ts'
import { decodeLarkRef, processLarkInboundEvent } from './runtime-inbound.ts'
import { LarkRuntimeProgressManager } from './runtime-progress.ts'
import { historySearchSchema, searchHistory } from './search-history.ts'
import { sendLarkFile } from './send-file.ts'
import {
  type LarkChatNames,
  type LarkMessageEvent,
  type LarkSentMessage,
  type LarkTransport,
  larkChatName,
} from './transport.ts'

const SEEN_MESSAGES = 1000
const PREFETCH_CACHE_MAX = 128

function outboxUuid(outboxId: string, step: string): string {
  const combined = `${outboxId}:${step}`
  if (combined.length <= 50) return combined
  return `${step}:${createHash('sha256').update(combined).digest('hex').slice(0, 42)}`
}

function abortPromise<T>(signal?: AbortSignal): Promise<T> {
  if (!signal) return new Promise<T>(() => {})
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException('Aborted', 'AbortError'),
    )
  }
  return new Promise<T>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')),
      { once: true },
    )
  })
}

export interface LarkChannelAdapterOptions {
  appId?: string
  appSecret?: string
  owners?: readonly string[] | string
  chats?: unknown
  logger?: VelaLogger
  transport?: LarkTransport
  timezone?: unknown
  hostEnv?: Record<string, string | undefined>
}

function parseOwners(
  input: readonly string[] | string | undefined,
  envOwners: string | undefined,
): string[] {
  const raw = input ?? envOwners
  if (!raw) return []
  const items =
    typeof raw === 'string'
      ? raw.split(',')
      : Array.isArray(raw)
        ? raw.filter((v): v is string => typeof v === 'string')
        : []
  return [...new Set(items.map((v) => v.trim()).filter(Boolean))]
}

async function readStreamWithCap(
  stream: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    signal?.throwIfAborted?.()
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_ATTACHMENT_BYTES) throw new FileTooLarge()
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

/**
 * First-class v0.9 `Runtime` channel adapter for Lark/Feishu long connections.
 */
export class LarkChannelAdapter implements ChannelAdapter {
  readonly name = 'lark'
  readonly description = 'Lark bot message channel (long-connection mode)'

  private readonly appId: string
  private readonly appSecret: string
  private readonly owners: Set<string>
  private readonly chats: Map<string, LarkChat>
  private readonly logger: VelaLogger
  private readonly customTransport?: LarkTransport
  readonly timezone?: unknown

  private ctx?: ChannelAdapterContext
  private transport?: LarkTransport & Partial<LarkChatNames>
  private botId?: string
  private stopped = true
  private connectionState: ChannelConnectionState = { connected: false }
  private readonly connection = new LarkConnection()
  private unsubConnection?: () => void
  private progressManager?: LarkRuntimeProgressManager
  private stopController?: AbortController
  private readonly seen = new Set<string>()
  private readonly inFlightSeen = new Set<string>()
  private readonly names = new Map<string, Promise<string>>()
  private readonly pending = new Set<Promise<void>>()
  private readonly routeQueues = new Map<string, Promise<void>>()
  private readonly prefetchedAttachments = new Map<string, Uint8Array>()
  private readonly threadRootIds = new Map<string, string>()
  private readonly lastReplies = new Map<string, LarkSentMessage>()
  private readonly handledTriggers = new Map<string, LarkSentMessage>()
  private readonly hostPostAuthors = new Map<string, string>()

  constructor(options: LarkChannelAdapterOptions = {}) {
    const env = options.hostEnv ?? {}
    this.appId = (options.appId ?? env.LARK_APP_ID ?? '').trim()
    this.appSecret = (options.appSecret ?? env.LARK_APP_SECRET ?? '').trim()
    this.owners = new Set(parseOwners(options.owners, env.LARK_OWNERS))
    this.chats = new Map(
      parseChats(options.chats).map((chat) => [chat.id, chat]),
    )
    this.logger = options.logger ?? silentLogger
    this.customTransport = options.transport
    if (options.timezone !== undefined) {
      if (typeof options.timezone !== 'string' || !options.timezone.trim()) {
        throw new Error(
          'lark.timezone must be a non-empty IANA timezone string',
        )
      }
      this.timezone = routineTimezone(options.timezone)
    }
  }

  status(): ChannelConnectionState {
    return { ...this.connectionState }
  }

  async start(ctx: ChannelAdapterContext): Promise<void> {
    this.ctx = ctx
    this.stopped = false
    this.stopController?.abort(new DOMException('Restarted', 'AbortError'))
    this.stopController = new AbortController()
    this.botId = undefined
    this.unsubConnection?.()
    this.unsubConnection = this.connection.subscribe((state) => {
      this.connectionState = { ...state }
    })

    const { active, report, transport } = this.connection.begin({
      appId: this.appId,
      appSecret: this.appSecret,
      transport: this.customTransport,
    })
    this.transport?.stop()
    this.transport = transport

    if (!transport) {
      this.logger.warn(
        '[lark] appId / appSecret not configured; channel will not connect to Lark',
      )
      return
    }
    if (this.chats.size === 0) {
      this.logger.info(
        '[lark] chats is empty; only owners’ direct chats are enabled',
      )
    }

    const manager = new LarkRuntimeProgressManager(ctx, transport, {
      isChatEnabled: (chatId) => this.isChatActiveInRuntime(chatId),
      isOwner: (senderId) => this.owners.has(senderId),
      logger: this.logger,
    })
    this.progressManager = manager

    try {
      const botId = await transport.getBotId()
      if (!active()) return
      this.botId = botId
    } catch (error) {
      this.logger.warn(
        `[lark] Cannot identify bot; group messages will be ignored: ${String(error)}`,
      )
    }
    if (!active()) return

    try {
      manager.start()
      await transport.start(
        (event) => this.receive(event),
        (event) => manager.handleCardAction(event),
      )
      if (this.customTransport && active()) {
        report({ connected: true })
      }
    } catch (error) {
      await manager.stop().catch(() => {})
      if (this.progressManager === manager) this.progressManager = undefined
      report({ connected: false, error: 'Lark connection failed' })
      throw error
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.stopController?.abort(
      new DOMException('Adapter stopped', 'AbortError'),
    )
    this.connection.stop()
    this.unsubConnection?.()
    this.unsubConnection = undefined
    this.transport?.stop()
    if (this.progressManager) {
      await this.progressManager.stop()
      this.progressManager = undefined
    }
    await Promise.allSettled([...this.pending])
    this.routeQueues.clear()
    this.prefetchedAttachments.clear()
    this.inFlightSeen.clear()
    this.connectionState = { connected: false }
  }

  async fetchAttachment(
    ref: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const cached = this.prefetchedAttachments.get(ref)
    if (cached) {
      this.prefetchedAttachments.delete(ref)
      return cached
    }
    const combinedSignal =
      signal && this.stopController
        ? AbortSignal.any([signal, this.stopController.signal])
        : (signal ?? this.stopController?.signal)
    combinedSignal?.throwIfAborted?.()
    if (!this.transport) throw new Error('Lark is not connected')
    const parsed = decodeLarkRef(ref)
    if (!parsed) throw new Error(`Unsupported Lark attachment ref: ${ref}`)
    const stream = await this.transport.getResource(
      parsed.messageId,
      parsed.key,
      parsed.kind,
    )
    return readStreamWithCap(stream, combinedSignal)
  }

  private async preflightAttachment(
    ref: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const bytes = await this.fetchAttachment(ref, signal)
    this.prefetchedAttachments.set(ref, bytes)
    if (this.prefetchedAttachments.size > PREFETCH_CACHE_MAX) {
      this.prefetchedAttachments.delete(
        this.prefetchedAttachments.keys().next().value as string,
      )
    }
  }

  async deliver(
    message: ChannelOutboundMessage,
  ): Promise<ChannelDeliveryResult> {
    const kind = message.kind ?? 'reply'
    try {
      const result = await this.deliverInner(message, kind)
      if (message.runId && kind === 'reply') {
        this.progressManager?.noteOutboxOutcome(message.runId, true)
      }
      return result
    } catch (error) {
      if (message.runId && kind === 'reply') {
        this.progressManager?.noteOutboxOutcome(message.runId, false)
      }
      throw error
    }
  }

  private async deliverInner(
    message: ChannelOutboundMessage,
    kind: NonNullable<ChannelOutboundMessage['kind']>,
  ): Promise<ChannelDeliveryResult> {
    if (!this.transport) {
      throw new Error('Lark is not connected')
    }
    if (kind === 'topic_start') {
      const title = (message.title ?? message.text).trim()
      if (message.replyToMessageId) {
        const opened = await this.transport.startTopic(
          message.replyToMessageId,
          title,
          outboxUuid(message.outboxId, 'topic'),
        )
        if (opened.threadId && opened.rootId) {
          this.threadRootIds.set(opened.threadId, opened.rootId)
        }
        return {
          externalMessageId: opened.messageId,
          threadId: opened.threadId,
          rootId: opened.rootId,
        }
      }
      const root = await this.transport.send(
        message.externalChatId,
        title,
        outboxUuid(message.outboxId, 'root'),
      )
      if (!root?.messageId) {
        throw new Error('Lark send returned no message receipt for topic_start')
      }
      const opened = await this.transport.startTopic(
        root.messageId,
        title,
        outboxUuid(message.outboxId, 'topic'),
      )
      if (opened.threadId && opened.rootId) {
        this.threadRootIds.set(opened.threadId, opened.rootId)
      }
      return {
        externalMessageId: opened.messageId,
        threadId: opened.threadId,
        rootId: opened.rootId,
      }
    }

    if (kind === 'forward') {
      const forwardId = message.forwardMessageId ?? message.replyToMessageId
      if (!forwardId || !message.threadId) {
        throw new Error(
          'Lark forward delivery requires forwardMessageId and threadId',
        )
      }
      const receipt = await this.transport.forward(
        forwardId,
        message.threadId,
        outboxUuid(message.outboxId, 'fwd'),
      )
      return {
        externalMessageId: receipt.messageId,
        threadId: message.threadId,
      }
    }

    if (kind === 'file') {
      const firstFile = message.files?.[0]
      if (!firstFile) {
        throw new Error('Lark file delivery requires at least one file')
      }
      const rootId = this.resolveTopicRoot(message.threadId)
      if (message.threadId && !rootId && !message.replyToMessageId) {
        throw new Error(
          `Cannot deliver file to Lark topic ${message.threadId}: unknown root message ID`,
        )
      }
      const bytes = new Uint8Array(await readFile(firstFile.path))
      const receipt = await sendLarkFile(this.transport, {
        chatId: message.externalChatId,
        name: firstFile.name ?? firstFile.path,
        bytes,
        replyToId: rootId ?? message.replyToMessageId,
        replyInThread: message.threadId ? true : undefined,
        uuid: outboxUuid(message.outboxId, 'file'),
      })
      return { externalMessageId: receipt.messageId }
    }

    const shouldMention =
      Boolean(message.recipientId) &&
      !message.recipientId!.startsWith('sdk:') &&
      Boolean(
        message.mentionRecipient ||
          message.threadId ||
          message.isRoutine ||
          message.isHandoff,
      )
    const text = shouldMention
      ? `<at user_id="${message.recipientId}"></at> ${message.text}`
      : message.text

    if (message.replyToMessageId) {
      const receipt = await this.transport.reply(
        message.replyToMessageId,
        text,
        outboxUuid(message.outboxId, 'reply'),
      )
      if (!this.appId && !message.threadId) {
        this.lastReplies.set(message.externalChatId, receipt)
      }
      return receipt?.messageId ? { externalMessageId: receipt.messageId } : {}
    }

    if (message.threadId) {
      const rootId = this.resolveTopicRoot(message.threadId)
      if (!rootId) {
        throw new Error(
          `Cannot deliver reply to Lark topic ${message.threadId}: unknown root message ID`,
        )
      }
      const opened = await this.transport.startTopic(
        rootId,
        text,
        outboxUuid(message.outboxId, 'reply'),
      )
      if (opened.threadId && opened.threadId !== message.threadId) {
        throw new Error('Lark returned a different topic')
      }
      if (opened.rootId) {
        this.threadRootIds.set(message.threadId, opened.rootId)
      }
      return {
        externalMessageId: opened.messageId,
        threadId: opened.threadId ?? message.threadId,
        rootId: opened.rootId ?? rootId,
      }
    }

    const sent = await this.transport.send(
      message.externalChatId,
      text,
      outboxUuid(message.outboxId, 'send'),
    )
    return sent?.messageId ? { externalMessageId: sent.messageId } : {}
  }

  async announce(
    input: ChannelAnnouncementInput,
  ): Promise<ChannelAnnouncementResult | undefined> {
    if (!this.transport || this.stopped) return undefined
    const signal =
      input.signal && this.stopController
        ? AbortSignal.any([input.signal, this.stopController.signal])
        : (input.signal ?? this.stopController?.signal)
    signal?.throwIfAborted?.()
    const sendPromise = this.transport.send(
      input.externalChatId,
      input.text,
      outboxUuid(input.idempotencyKey ?? randomUUID(), 'ann'),
    )
    const receipt = signal
      ? await Promise.race([
          sendPromise,
          abortPromise<undefined | LarkSentMessage>(signal),
        ])
      : await sendPromise
    if (!receipt?.messageId) return undefined
    return { externalMessageId: receipt.messageId }
  }

  listMessages(input: {
    sessionId: string
    externalChatId: string
    threadId?: string | null
    kind: 'group' | 'direct'
    cursor?: string
    limit?: number
  }): Promise<RuntimeMessagePage> {
    return listLarkRuntimeMessages({
      ...input,
      ownAppId: this.appId,
      transport: this.transport,
      senderName: (id) => this.senderName(id),
      hostPostAuthor: (messageId) => this.hostPostAuthors.get(messageId),
    })
  }

  async listChats(): Promise<ChannelChatInfo[]> {
    const transport = this.connectionState.connected
      ? this.transport
      : undefined
    const ids = this.ctx?.listBindings
      ? this.ctx
          .listBindings({ channel: 'lark', enabledOnly: true })
          .filter((b) => b.kind === 'group' && !b.threadId)
          .map((b) => b.externalId)
      : [...this.chats.keys()]
    const uniqueIds = [...new Set(ids)]
    return Promise.all(
      uniqueIds.map(async (chatId) => {
        const name = await larkChatName(transport, chatId)
        return name === undefined ? { chatId } : { chatId, name }
      }),
    )
  }

  submitFromHost(
    input: ChannelHostSubmitInput,
  ): Promise<ChannelHostSubmitResult> {
    return submitLarkRuntimeHostMessage({
      input,
      ctx: this.ctx,
      transport: this.transport,
      isConnected: () => this.connectionState.connected,
      isChatEnabled: (chatId) => this.isChatActiveInRuntime(chatId),
      getTopicRoot: (threadId) => this.resolveTopicRoot(threadId),
      rememberTopicRoot: (threadId, rootId) =>
        this.threadRootIds.set(threadId, rootId),
      rememberHostPost: (messageId, authorName) => {
        this.hostPostAuthors.set(messageId, authorName)
        if (this.hostPostAuthors.size > SEEN_MESSAGES) {
          this.hostPostAuthors.delete(
            this.hostPostAuthors.keys().next().value as string,
          )
        }
      },
      noteAdmittedInbound: (info) =>
        this.progressManager?.noteAdmittedInbound(info),
    })
  }

  getTools(binding: ChannelBinding): readonly ChannelToolSpec[] {
    if (binding.kind !== 'group') return []
    return [
      {
        name: 'lark_search_history',
        readOnly: true,
        maxResultChars: 20000,
        description:
          'Search older messages in this group by keyword or time range (default last seven days). Chat listing includes topic roots, not every thread reply; absence does not establish indexing delay. Report the returned matchCounts, senderType, ISO UTC times, coverage and truncation accurately; use an earlier end_time to search further.',
        inputSchema: historySearchSchema,
        execute: async (input, ctx) => {
          if (!this.transport) throw new Error('Lark is not connected')
          return searchHistory(this.transport, ctx.externalChatId, input)
        },
      },
    ]
  }

  private resolveTopicRoot(threadId?: string): string | undefined {
    if (!threadId) return undefined
    const cached = this.threadRootIds.get(threadId)
    if (cached) return cached
    const binding = this.ctx
      ?.listBindings?.({ channel: 'lark' })
      ?.find((b) => b.threadId === threadId)
    const rootId = binding?.config?.rootId
    if (typeof rootId === 'string' && rootId) {
      this.threadRootIds.set(threadId, rootId)
      return rootId
    }
    return undefined
  }

  private isChatActiveInRuntime(chatId: string): boolean {
    if (this.ctx?.listBindings) {
      const bindings = this.ctx.listBindings({
        channel: 'lark',
        enabledOnly: true,
      })
      return bindings.some(
        (b) => b.externalId === chatId && b.kind === 'group' && !b.threadId,
      )
    }
    return this.chats.has(chatId)
  }

  private readUntaggedEnabled(chatId: string): boolean {
    const binding = this.ctx
      ?.listBindings?.({ channel: 'lark', enabledOnly: true })
      ?.find((b) => b.externalId === chatId && !b.threadId)
    if (binding?.config?.readUntagged !== undefined) {
      return binding.config.readUntagged !== false
    }
    const fromConfig = this.chats.get(chatId)?.readUntagged
    return fromConfig !== false
  }

  private senderName(id: string): Promise<string> {
    let name = this.names.get(id)
    if (!name) {
      name = Promise.resolve()
        .then(() => this.transport?.getSenderName(id))
        .then((value) => value?.trim() || id)
        .catch(() => id)
      this.names.set(id, name)
      if (this.names.size > SEEN_MESSAGES) {
        this.names.delete(this.names.keys().next().value as string)
      }
    }
    return name
  }

  private enqueueRouteTask(routeKey: string, run: () => Promise<void>): void {
    const prev = this.routeQueues.get(routeKey) ?? Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(run)
      .finally(() => {
        if (this.routeQueues.get(routeKey) === next) {
          this.routeQueues.delete(routeKey)
        }
      })
    this.routeQueues.set(routeKey, next)
    this.pending.add(next)
    void next.finally(() => this.pending.delete(next))
  }

  private receive(event: LarkMessageEvent): void {
    if (this.stopped || !this.ctx) return
    const { message } = event
    const msgId = message.message_id
    if (msgId) {
      if (this.seen.has(msgId) || this.inFlightSeen.has(msgId)) return
    }
    const senderId = event.sender.sender_id?.open_id || 'unknown'
    const isOwnerDm = message.chat_type === 'p2p' && this.owners.has(senderId)
    const enabled = this.isChatActiveInRuntime(message.chat_id) || isOwnerDm
    if (
      !enabled ||
      event.sender.sender_type !== 'user' ||
      senderId === this.botId
    ) {
      return
    }
    const group = message.chat_type === 'group'
    const mentioned =
      !!this.botId &&
      !!message.mentions?.some((mention) => mention.id?.open_id === this.botId)
    const text = messageText(message)
    const trimmedText = text?.trim()
    const isShortcut =
      trimmedText === '!routines' ||
      trimmedText === '!timers' ||
      trimmedText === '!status' ||
      trimmedText === '!stop' ||
      trimmedText === '!restart'
    const passive = group && !mentioned && !message.thread_id && !isShortcut
    if (group && !this.botId) return

    if (
      group &&
      !mentioned &&
      !message.thread_id &&
      !this.readUntaggedEnabled(message.chat_id) &&
      trimmedText !== '!routines' &&
      trimmedText !== '!timers'
    ) {
      return
    }
    if (group && !message.message_id) return
    const replyToId = group ? message.message_id : undefined
    const requireExistingSession = group && !!message.thread_id && !mentioned
    if (text === '' || (passive && text === undefined)) return

    const topic =
      group && message.thread_id && message.message_id
        ? {
            rootId: message.root_id || message.message_id,
            threadId: message.thread_id,
          }
        : undefined
    if (topic) this.threadRootIds.set(topic.threadId, topic.rootId)

    if (msgId) this.inFlightSeen.add(msgId)
    const routeKey = `${message.chat_id}\0${topic?.threadId ?? ''}`
    this.enqueueRouteTask(routeKey, async () => {
      try {
        const committed = await processLarkInboundEvent({
          event,
          meta: {
            senderId,
            group,
            mentioned,
            passive,
            replyToId,
            requireExistingSession,
            topic,
            rawText: text,
          },
          ctx: this.ctx!,
          transport: this.transport,
          appId: this.appId,
          logger: this.logger,
          isStopped: () => this.stopped,
          signal: this.stopController?.signal,
          senderName: (id) => this.senderName(id),
          groupBoundary: (chatId) => {
            const reply = this.lastReplies.get(chatId)
            const handled = this.handledTriggers.get(chatId)
            if (!reply) return handled
            if (!handled) return reply
            return Number(handled.createTime) >= Number(reply.createTime)
              ? handled
              : reply
          },
          noteHandled: (chatId, messageId, createTime) => {
            const current = this.handledTriggers.get(chatId)
            if (current && Number(createTime) < Number(current.createTime)) {
              return
            }
            this.handledTriggers.set(chatId, { messageId, createTime })
          },
          deliver: (msg) => this.deliver(msg),
          preflightAttachment: (ref, signal) =>
            this.preflightAttachment(ref, signal),
          noteAdmittedInbound: (info) =>
            this.progressManager?.noteAdmittedInbound(info),
        })
        if (msgId && committed) {
          this.seen.add(msgId)
          if (this.seen.size > SEEN_MESSAGES) {
            this.seen.delete(this.seen.values().next().value as string)
          }
        }
      } catch (error) {
        this.logger.warn(`[lark] Failed to handle message: ${String(error)}`)
      } finally {
        if (msgId) this.inFlightSeen.delete(msgId)
      }
    })
  }
}

export function createLarkChannelAdapter(
  options: LarkChannelAdapterOptions = {},
): LarkChannelAdapter {
  return new LarkChannelAdapter(options)
}
