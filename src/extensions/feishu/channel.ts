import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { channelSessionId } from '../../channels/gateway.ts'
import { groupWorkspace } from '../../channels/scope.ts'
import type {
  ChannelFeedbackUpdate,
  ChannelOutcome,
  ChannelRunFeedback,
} from '../../channels/types.ts'
import { imageMimeType } from '../../images/metadata.ts'
import type {
  ChannelDefinition,
  IncomingMessage,
  OutgoingMessage,
  Role,
  VelaLogger,
} from '../../index.ts'
import { errorMessage } from '../../logger.ts'
import type { ImageContent } from '../../messages.ts'
import {
  type FeishuCardAction,
  type FeishuCardResponse,
  runControlsCard,
  topicRunCard,
} from './cards.ts'
import { type FeishuChat, parseChats } from './chats.ts'
import { readGroupContext, readTopicContext } from './history.ts'
import { imageKeys, messageText, safeName } from './messages.ts'
import { FeishuProgress } from './progress.ts'
import { FeishuTopics, topicToolNames } from './topics.ts'
import {
  type FeishuMessageEvent,
  type FeishuSentMessage,
  type FeishuTransport,
  larkTransport,
} from './transport.ts'

export interface FeishuChannelConfig {
  appId: string
  appSecret: string
  /** These senders (open_id) always have their direct chats enabled. */
  owners: readonly string[]
  /** Every member of these chats is trusted with owner access. */
  chats?: unknown
  dataDir: string
  logger: VelaLogger
  /** Default: lark's long connection with appId / appSecret */
  transport?: FeishuTransport
  timezone?: unknown
}

/** Feishu may deliver an event more than once; this many recent message ids are remembered to drop repeats */
const SEEN_MESSAGES = 1000

export const UNSUPPORTED_MESSAGE =
  'Only text, images and files are supported; please send one of these message types.'

export class FeishuChannel implements ChannelDefinition {
  name = 'feishu'
  description = 'Feishu bot message channel (long-connection mode)'
  get timezone(): unknown {
    return this.config.timezone
  }

  async prepareRoutine(
    msg: IncomingMessage,
    chatKind: 'group' | 'direct',
  ): Promise<IncomingMessage | undefined> {
    if (msg.topic || chatKind === 'direct') return msg
    const receipt = await this.transport?.send(msg.channelId, msg.text)
    if (!receipt) {
      this.config.logger.warn(
        '[feishu] Routine skipped: top-level delivery requires a transport send receipt',
      )
      return
    }
    return { ...msg, replyToId: receipt.messageId }
  }

  readonly topics = new FeishuTopics(() => {
    if (!this.transport) throw new Error('Feishu is not connected')
    return this.transport
  })
  connect: NonNullable<ChannelDefinition['connect']> = (runtime) => {
    this.topics.runtime = runtime
  }
  sessionOptions: NonNullable<ChannelDefinition['sessionOptions']> = (msg) => {
    const options = this.topics.sessionOptions(msg)
    if (!msg.topic && !msg.replyToId) return options
    const chat = this.chats.get(msg.channelId)
    if (!chat) throw new Error('Feishu group is not enabled')
    const cwd = groupWorkspace(
      this.config.dataDir,
      this.name,
      chat.id,
      !msg.requireExistingSession,
    )
    return {
      ...options,
      cwd,
      tools:
        chat.tools === undefined
          ? undefined
          : [
              ...new Set([
                ...chat.tools,
                ...topicToolNames,
                ...(msg.topic ? ['feishu_wait_for_input'] : []),
              ]),
            ],
    }
  }

  validateTools(names: readonly string[]): void {
    const known = new Set(names)
    for (const chat of this.chats.values())
      for (const name of chat.tools ?? [])
        if (!known.has(name))
          throw new Error(`Unknown Feishu tool "${name}" for chat ${chat.id}`)
  }

  private config: FeishuChannelConfig
  private readonly chats: Map<string, FeishuChat>
  private messageHandler?: (msg: IncomingMessage) => void | Promise<void>
  private transport?: FeishuTransport
  private readonly seen = new Set<string>()
  private stopped = false
  private readonly pending = new Set<Promise<void>>()
  private readonly controls = new Map<
    string,
    {
      msg: IncomingMessage
      choose: (action: 'queue' | 'steer' | 'stop') => boolean
      clear: () => void
    }
  >()
  private botId?: string
  private readonly names = new Map<string, Promise<string>>()
  private readonly images = new WeakMap<
    IncomingMessage,
    Map<string, Promise<ImageContent>>
  >()
  private readonly files = new WeakMap<IncomingMessage, Promise<string>>()
  // Custom transports without appId cannot identify own-app history items.
  private readonly lastReplies = new Map<string, FeishuSentMessage>()

  constructor(config: FeishuChannelConfig) {
    this.config = config
    this.chats = new Map(
      parseChats(config.chats).map((chat) => [chat.id, chat]),
    )
  }

  canRecover(msg: IncomingMessage, chatKind: 'group' | 'direct'): boolean {
    return (
      !!this.transport &&
      (this.chats.has(msg.channelId) ||
        (chatKind === 'direct' && this.config.owners.includes(msg.senderId)))
    )
  }

  roleFor(): Role {
    return 'owner'
  }

  onMessage(handler: (msg: IncomingMessage) => void | Promise<void>): void {
    this.messageHandler = handler
  }

  async start(): Promise<void> {
    this.stopped = false
    this.botId = undefined
    const transport =
      this.config.transport ??
      (this.config.appId && this.config.appSecret
        ? larkTransport(this.config.appId, this.config.appSecret)
        : undefined)
    if (!transport) {
      this.config.logger.warn(
        '[feishu] appId / appSecret not configured; channel will not connect to Feishu',
      )
      return
    }
    if (!this.chats.size)
      this.config.logger.info(
        '[feishu] chats is empty; only owners’ direct chats are enabled',
      )
    this.transport = transport
    try {
      this.botId = await transport.getBotId()
    } catch (error) {
      this.config.logger.warn(
        `[feishu] Cannot identify bot; group messages will be ignored: ${String(error)}`,
      )
    }
    await transport.start(
      (event) => this.receive(event),
      (event) => this.receiveAction(event),
    )
    this.config.logger.info('[feishu] Long connection established')
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.transport?.stop()
    for (const entry of this.controls.values()) entry.clear()
    await Promise.all(this.pending)
  }

  private async createControls(
    msg: IncomingMessage,
    controls: Extract<ChannelFeedbackUpdate, { type: 'controls' }>,
    report?: (error: unknown) => Promise<void>,
  ): Promise<FeishuProgress | void> {
    if (
      this.stopped ||
      controls.signal.aborted ||
      !this.transport ||
      (msg.raw !== undefined &&
        messageText((msg.raw as FeishuMessageEvent).message) === undefined)
    )
      return
    const token = randomUUID()
    const clear = () => {
      this.controls.delete(token)
      controls.signal.removeEventListener('abort', clear)
    }
    this.controls.set(token, { msg, choose: controls.choose, clear })
    controls.signal.addEventListener('abort', clear, { once: true })
    const card = msg.topic ? topicRunCard(token) : runControlsCard(token)
    try {
      // Control cards are not answers and must not advance the chat-history boundary.
      const messageId = await this.transport.sendCard(
        msg.channelId,
        card,
        msg.replyToId,
      )
      if (report)
        return new FeishuProgress(this.transport, messageId, card, report)
    } catch (error) {
      clear()
      throw error
    }
  }

  async startRun(
    msg: IncomingMessage,
    { acknowledge }: { acknowledge: boolean },
  ): Promise<ChannelRunFeedback> {
    const transport = this.transport
    // Group reply targets are normalized service IDs; no live receive event is needed.
    const messageId = acknowledge ? msg.replyToId : undefined
    const reactionId =
      transport && messageId
        ? await transport.addReaction(messageId, 'OnIt')
        : undefined
    let progress: FeishuProgress | undefined
    let report: ((error: unknown) => Promise<void>) | undefined
    return {
      event: (update) => {
        if (update.type === 'agent') return progress?.event(update.event)
        report = update.error
        return this.createControls(
          update.message,
          update,
          update.message.topic ? update.error : undefined,
        ).then((value) => {
          progress = value || undefined
        })
      },
      finish: async (outcome: ChannelOutcome) => {
        try {
          await progress?.finish(outcome)
        } catch (error) {
          await report?.(error)
        }
        if (transport && messageId && reactionId) {
          await transport.removeReaction(messageId, reactionId)
          await transport.addReaction(
            messageId,
            outcome === 'done' ? 'DONE' : 'CrossMark',
          )
        }
      },
    }
  }

  private receiveAction(event: FeishuCardAction): FeishuCardResponse {
    const ignored: FeishuCardResponse = {
      toast: {
        type: 'info',
        content: 'This control is unavailable or has expired.',
      },
    }
    const value = event.action?.value
    if (this.stopped || !value || typeof value !== 'object') return ignored
    const { action, token } = value as { action?: unknown; token?: unknown }
    if (
      typeof token !== 'string' ||
      (action !== 'queue' && action !== 'steer' && action !== 'stop')
    )
      return ignored
    const entry = this.controls.get(token)
    const operator = event.operator?.open_id
    if (
      !entry ||
      !operator ||
      event.context?.open_chat_id !== entry.msg.channelId
    )
      return ignored
    if (
      !this.chats.has(entry.msg.channelId) &&
      !(!entry.msg.replyToId && this.config.owners.includes(operator))
    )
      return ignored
    if (entry.msg.topic && action !== 'stop') return ignored
    entry.clear()
    if (!entry.choose(action)) return ignored
    return {
      toast: {
        type: 'success',
        content: {
          queue: 'Message queued.',
          steer: 'Adding the message to the current run.',
          stop: 'Stopping the current run.',
        }[action],
      },
    }
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (!this.transport) {
      this.config.logger.warn(
        `[feishu] Feishu not configured, skipping send: ${message.text.slice(0, 50)}`,
      )
      return
    }
    const text =
      message.recipientId && (message.topic || message.routine)
        ? `<at user_id="${message.recipientId}"></at> ${message.text}`
        : message.text
    // A failed send throws: the gateway reports it as channel_error instead of a channel_reply that never arrived
    if (message.replyToId) {
      const receipt = await this.transport.reply(message.replyToId, text)
      if (!this.config.appId && !message.topic)
        this.lastReplies.set(message.channelId, receipt)
    } else {
      await this.transport.send(message.channelId, text)
    }
  }

  /** The gateway prepares queued input after the preceding reply; Steer prepares it during the run. */
  async prepareMessage(
    msg: IncomingMessage,
    activeMessage?: IncomingMessage,
  ): Promise<IncomingMessage | undefined> {
    if (this.stopped) return
    if (!msg.raw) return msg
    const event = msg.raw as FeishuMessageEvent
    const activeTrigger = (activeMessage?.raw as FeishuMessageEvent | undefined)
      ?.message
    if (messageText(event.message) === undefined) {
      await this.send({
        channelId: msg.channelId,
        recipientId: msg.senderId,
        topic: msg.topic,
        replyToId: msg.replyToId,
        text: UNSUPPORTED_MESSAGE,
      })
      return
    }
    let images: ImageContent[]
    let imageCache = this.images.get(msg)
    if (!imageCache) {
      imageCache = new Map()
      this.images.set(msg, imageCache)
    }
    let input = messageText(event.message) ?? msg.text
    if (!input) return
    if (msg.topic || msg.replyToId)
      groupWorkspace(this.config.dataDir, this.name, msg.channelId)
    const attachmentType =
      event.message.message_type === 'file' ? 'file' : 'image'
    try {
      images = await this.downloadImages(event.message, imageCache)
      if (event.message.message_type === 'file') {
        let file = this.files.get(msg)
        if (!file) {
          file = this.downloadFile(event.message)
          this.files.set(msg, file)
        }
        input = await file
      }
    } catch (error) {
      if (msg.passive) {
        this.config.logger.warn(
          `[feishu] Passive attachment preparation failed: ${errorMessage(error)}`,
        )
        return
      }
      await this.send({
        channelId: msg.channelId,
        recipientId: msg.senderId,
        topic: msg.topic,
        replyToId: msg.replyToId,
        text:
          error instanceof FileTooLarge
            ? 'File too large. The limit is 20MB.'
            : `Couldn't download the ${attachmentType}: ${errorMessage(error)}. Check the bot's im:resource permission and retry.`,
      })
      return
    }
    this.topics.triggerImages.set(event, [...images])
    msg = { ...msg, text: input, images }
    // Preserve extension commands, skills and templates; attribution must not hide their leading slash.
    if (!msg.passive && msg.text.startsWith('/')) return msg
    const name = await this.senderName(msg.senderId)
    const question = { name, text: msg.text }
    let text = `${name}: ${msg.text}`
    if (msg.passive || (msg.topic && !msg.isNewTopic))
      return { ...msg, senderName: name, text }
    if (msg.topic && this.transport) {
      try {
        const history = []
        let pageToken: string | undefined
        do {
          const page = await this.transport.listTopicMessages(
            msg.topic.threadId,
            pageToken,
          )
          history.push(...page.items)
          pageToken = page.pageToken
        } while (pageToken)
        const context = await readTopicContext(history, {
          chatId: msg.channelId,
          message: event.message,
          appId: this.config.appId,
          question,
          senderName: (id) => this.senderName(id),
          downloadImages: (message, limit) =>
            this.downloadImages(message, imageCache, limit),
        })
        return {
          ...msg,
          senderName: name,
          text: context.text,
          images: [...context.images, ...images],
        }
      } catch (error) {
        await this.send({
          channelId: msg.channelId,
          recipientId: msg.senderId,
          topic: msg.topic,
          replyToId: msg.replyToId,
          text: `Couldn't read the topic history: ${errorMessage(error)}. Check im:message:readonly and im:message.group_msg permissions and retry.`,
        })
        return
      }
    }
    if (event.message.chat_type === 'group' && this.transport) {
      try {
        const history = await this.transport.listMessages(msg.channelId, {
          before: event.message.create_time,
          limit: 50,
        })
        const context = await readGroupContext(history, {
          chatId: msg.channelId,
          message: event.message,
          activeTrigger,
          previous: this.lastReplies.get(msg.channelId),
          appId: this.config.appId,
          question,
          senderName: (id) => this.senderName(id),
          downloadImages: (message, limit) =>
            this.downloadImages(message, imageCache, limit),
        })
        images.unshift(...context.images)
        text = context.text
      } catch (error) {
        this.config.logger.warn(
          `[feishu] Failed to fetch context for chat ${msg.channelId}: ${String(error)}. History images require im:resource permission.`,
        )
      }
    }
    return { ...msg, senderName: name, text }
  }

  private async downloadImages(
    message: FeishuMessageEvent['message'],
    cache: Map<string, Promise<ImageContent>>,
    limit = Infinity,
  ): Promise<ImageContent[]> {
    if (limit === 0) return []
    const keys = imageKeys(message).slice(-limit)
    if (!keys.length) return []
    if (!message.message_id || !this.transport)
      throw new Error('Image has no message id or transport')
    const images: ImageContent[] = []
    for (const key of keys) {
      const cacheKey = JSON.stringify([message.message_id, key])
      let image = cache.get(cacheKey)
      if (!image) {
        image = this.downloadImage(message.message_id, key)
        cache.set(cacheKey, image)
      }
      images.push(await image)
    }
    return images
  }

  private async downloadImage(
    messageId: string,
    key: string,
  ): Promise<ImageContent> {
    if (!this.transport) throw new Error('Image has no transport')
    const stream = await this.transport.getResource(messageId, key, 'image')
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    const bytes = Buffer.concat(chunks)
    return {
      type: 'image',
      data: bytes.toString('base64'),
      mimeType: imageMimeType(bytes) ?? 'application/octet-stream',
    }
  }

  private async downloadFile(
    message: FeishuMessageEvent['message'],
  ): Promise<string> {
    const content = JSON.parse(message.content) as {
      file_key: string
      file_name?: string
    }
    if (!message.message_id || !content.file_key || !this.transport)
      throw new Error('File has no resource key or message id')
    const messageId = safeName(message.message_id, 64)
    const name = safeName(
      content.file_name ?? 'file',
      254 - Buffer.byteLength(messageId),
    )
    await mkdir(this.config.dataDir, { recursive: true })
    const root = await realpath(this.config.dataDir)
    const directory = resolve(
      root,
      'channels',
      channelSessionId(this.name, message.chat_id),
      'files',
    )
    await mkdir(directory, { recursive: true })
    if ((await realpath(directory)) !== directory)
      throw new Error('File directory must not contain symlinks')
    const path = join(directory, `${messageId}-${name}`)
    const reference = `[file: ${name}, saved at ${path}]`
    try {
      const existing = await lstat(path)
      if (!existing.isFile())
        throw new Error('Attachment destination is not a regular file')
      return reference
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    // Only completed downloads get the replayable name. A crash may leave a .part file,
    // but redelivery cannot mistake those bytes for a completed attachment.
    const temporary = join(directory, `${randomUUID()}.part`)
    const file = await open(temporary, 'wx')
    try {
      const stream = await this.transport.getResource(
        message.message_id,
        content.file_key,
        'file',
      )
      let size = 0
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk)
        size += bytes.length
        if (size > 20 * 1024 * 1024) throw new FileTooLarge()
        await file.writeFile(bytes)
      }
      await file.close()
      await rename(temporary, path)
    } finally {
      await file.close()
      await rm(temporary, { force: true })
    }
    return reference
  }

  private senderName(id: string): Promise<string> {
    let name = this.names.get(id)
    if (!name) {
      name = Promise.resolve()
        .then(() => this.transport?.getSenderName(id))
        .then((value) => value?.trim() || id)
        .catch(() => id)
      this.names.set(id, name)
      if (this.names.size > SEEN_MESSAGES)
        this.names.delete(this.names.keys().next().value as string)
    }
    return name
  }

  private receive(event: FeishuMessageEvent): void {
    if (this.stopped) return
    const { message } = event
    if (message.message_id) {
      if (this.seen.has(message.message_id)) return
      this.seen.add(message.message_id)
      if (this.seen.size > SEEN_MESSAGES)
        this.seen.delete(this.seen.values().next().value as string)
    }
    const senderId = event.sender.sender_id?.open_id || 'unknown'
    const enabled =
      this.chats.has(message.chat_id) ||
      (message.chat_type === 'p2p' && this.config.owners.includes(senderId))
    if (
      !enabled ||
      event.sender.sender_type !== 'user' ||
      senderId === this.botId
    )
      return
    const group = message.chat_type === 'group'
    const mentioned =
      !!this.botId &&
      !!message.mentions?.some((mention) => mention.id?.open_id === this.botId)
    const passive = group && !mentioned && !message.thread_id
    if (
      group &&
      (!this.botId ||
        (passive && this.chats.get(message.chat_id)?.readUntagged === false))
    )
      return
    // A group reply needs its actual trigger; never accidentally post an unthreaded answer.
    if (group && !message.message_id) return
    // Normalized replyToId identifies a group input, including during recovery.
    const replyToId = group ? message.message_id : undefined
    const requireExistingSession = group && !!message.thread_id && !mentioned
    const text = messageText(message)
    if (text === '' || (passive && text === undefined) || !this.messageHandler)
      return
    this.config.logger.debug(
      `[feishu] input ${message.message_id ?? '-'} received at=${new Date().toISOString()} created=${message.create_time ?? '-'}`,
    )
    // Deliver immediately so the gateway can show run controls, then serialize preparation and replies there.
    const next = Promise.resolve(
      this.messageHandler({
        channelId: message.chat_id,
        senderId,
        senderName: senderId,
        text: text ?? '',
        replyToId,
        ...(group && message.thread_id && message.message_id
          ? {
              topic: {
                rootId: message.root_id || message.message_id,
                threadId: message.thread_id,
              },
            }
          : {}),
        requireExistingSession,
        passive,
        raw: event,
      }),
    ).catch((error) =>
      this.config.logger.warn(
        `[feishu] Failed to handle message: ${String(error)}`,
      ),
    )
    this.pending.add(next)
    void next.then(() => this.pending.delete(next))
  }
}

class FileTooLarge extends Error {}
