import { Buffer } from 'node:buffer'
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
  private readonly seen = new Set<string>()
  private readonly names = new Map<string, Promise<string>>()
  private readonly pending = new Set<Promise<void>>()
  private readonly threadRootIds = new Map<string, string>()
  private readonly lastReplies = new Map<string, LarkSentMessage>()
  private readonly handledTriggers = new Map<string, LarkSentMessage>()

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
    this.timezone = options.timezone
  }

  status(): ChannelConnectionState {
    return { ...this.connectionState }
  }

  async start(ctx: ChannelAdapterContext): Promise<void> {
    this.ctx = ctx
    this.stopped = false
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
    this.connection.stop()
    this.unsubConnection?.()
    this.unsubConnection = undefined
    this.transport?.stop()
    if (this.progressManager) {
      await this.progressManager.stop()
      this.progressManager = undefined
    }
    await Promise.allSettled([...this.pending])
    this.connectionState = { connected: false }
  }

  async fetchAttachment(
    ref: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    signal?.throwIfAborted?.()
    if (!this.transport) throw new Error('Lark is not connected')
    const parsed = decodeLarkRef(ref)
    if (!parsed) throw new Error(`Unsupported Lark attachment ref: ${ref}`)
    const stream = await this.transport.getResource(
      parsed.messageId,
      parsed.key,
      parsed.kind,
    )
    return readStreamWithCap(stream, signal)
  }

  async deliver(
    message: ChannelOutboundMessage,
  ): Promise<ChannelDeliveryResult> {
    if (!this.transport) {
      throw new Error('Lark is not connected')
    }
    const kind = message.kind ?? 'reply'
    if (kind === 'topic_start') {
      const title = (message.title ?? message.text).trim()
      if (message.replyToMessageId) {
        const opened = await this.transport.startTopic(
          message.replyToMessageId,
          title,
          message.outboxId,
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
        message.outboxId,
      )
      if (!root?.messageId) {
        throw new Error('Lark send returned no message receipt for topic_start')
      }
      const opened = await this.transport.startTopic(root.messageId, title)
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
      const receipt = await this.transport.forward(forwardId, message.threadId)
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
      const bytes = new Uint8Array(await readFile(firstFile.path))
      const rootId = this.resolveTopicRoot(message.threadId)
      const receipt = await sendLarkFile(this.transport, {
        chatId: message.externalChatId,
        name: firstFile.name ?? firstFile.path,
        bytes,
        replyToId: rootId ?? message.replyToMessageId,
        replyInThread: message.threadId ? true : undefined,
        uuid: message.outboxId,
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

    const replyTarget =
      message.replyToMessageId ?? this.resolveTopicRoot(message.threadId)
    let receipt: LarkSentMessage | undefined
    if (replyTarget) {
      receipt = await this.transport.reply(replyTarget, text, message.outboxId)
      if (!this.appId && !message.threadId) {
        this.lastReplies.set(message.externalChatId, receipt)
      }
    } else {
      const sent = await this.transport.send(
        message.externalChatId,
        text,
        message.outboxId,
      )
      if (sent) receipt = sent
    }
    return receipt?.messageId ? { externalMessageId: receipt.messageId } : {}
  }

  async announce(
    input: ChannelAnnouncementInput,
  ): Promise<ChannelAnnouncementResult | undefined> {
    if (!this.transport) return undefined
    input.signal?.throwIfAborted?.()
    const receipt = await this.transport.send(
      input.externalChatId,
      input.text,
      input.idempotencyKey,
    )
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
    })
  }

  async listChats(): Promise<ChannelChatInfo[]> {
    const transport = this.connectionState.connected
      ? this.transport
      : undefined
    const bindings =
      this.ctx?.listBindings?.({ channel: 'lark', enabledOnly: true }) ?? []
    const bindingChatIds = bindings
      .filter((b) => b.kind === 'group' && !b.threadId)
      .map((b) => b.externalId)
    const ids = [...new Set([...this.chats.keys(), ...bindingChatIds])]
    return Promise.all(
      ids.map(async (chatId) => {
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
      noteHostInbound: (info) =>
        this.progressManager?.notePendingInbound({
          ...info,
          isDirect: false,
        }),
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
    if (this.chats.has(chatId)) return true
    const bindings =
      this.ctx?.listBindings?.({ channel: 'lark', enabledOnly: true }) ?? []
    return bindings.some(
      (b) => b.externalId === chatId && b.kind === 'group' && !b.threadId,
    )
  }

  private readUntaggedEnabled(chatId: string): boolean {
    const fromConfig = this.chats.get(chatId)?.readUntagged
    if (fromConfig !== undefined) return fromConfig !== false
    const binding = this.ctx
      ?.listBindings?.({ channel: 'lark', enabledOnly: true })
      ?.find((b) => b.externalId === chatId && !b.threadId)
    return binding?.config?.readUntagged !== false
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

  private receive(event: LarkMessageEvent): void {
    if (this.stopped || !this.ctx) return
    const { message } = event
    if (message.message_id) {
      if (this.seen.has(message.message_id)) return
      this.seen.add(message.message_id)
      if (this.seen.size > SEEN_MESSAGES) {
        this.seen.delete(this.seen.values().next().value as string)
      }
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
    const passive = group && !mentioned && !message.thread_id
    if (group && !this.botId) return

    const text = messageText(message)
    if (
      passive &&
      !this.readUntaggedEnabled(message.chat_id) &&
      text?.trim() !== '!routines'
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

    const task = processLarkInboundEvent({
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
      ctx: this.ctx,
      transport: this.transport,
      appId: this.appId,
      logger: this.logger,
      isStopped: () => this.stopped,
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
        if (current && Number(createTime) < Number(current.createTime)) return
        this.handledTriggers.set(chatId, { messageId, createTime })
      },
      deliver: (msg) => this.deliver(msg),
      notePendingInbound: (input) =>
        this.progressManager?.notePendingInbound(input),
    }).catch((error) => {
      this.logger.warn(`[lark] Failed to handle message: ${String(error)}`)
    })
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task))
  }
}

export function createLarkChannelAdapter(
  options: LarkChannelAdapterOptions = {},
): LarkChannelAdapter {
  return new LarkChannelAdapter(options)
}
