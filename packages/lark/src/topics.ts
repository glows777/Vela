import type {
  ChannelRuntime,
  ChannelTopicCapabilities,
  IncomingMessage,
} from '@glows777/vela-channels'
import { topicSessionOptions } from '@glows777/vela-channels'
import type {
  ExtensionAPI,
  ImageContent,
} from '@glows777/vela-core/extension-api'
import { messageText } from './messages.ts'
import { historySearchSchema, searchHistory } from './search-history.ts'
import type { LarkMessageEvent, LarkTransport } from './transport.ts'

export class LarkTopics {
  runtime?: ChannelRuntime
  readonly triggerImages = new WeakMap<LarkMessageEvent, ImageContent[]>()
  constructor(
    private transport: () => LarkTransport,
    private onHandled: (
      chatId: string,
      messageId: string,
      createTime: string,
    ) => void,
    private readTopic: (chatId: string, threadId: string) => Promise<string>,
  ) {}

  readonly capabilities: ChannelTopicCapabilities = {
    startTopic: (msg, title) =>
      this.transport().startTopic(msg.replyToId!, title),
    forwardToTopic: async (msg, target) => {
      const receipt = await this.transport().forward(
        msg.replyToId!,
        target.threadId,
      )
      const original = msg.raw as LarkMessageEvent | undefined
      return {
        ...msg,
        text: original ? '' : msg.text,
        images: original ? undefined : msg.images,
        replyToId: receipt.messageId,
        raw: original
          ? {
              ...original,
              message: {
                ...original.message,
                root_id: target.rootId,
                thread_id: target.threadId,
              },
            }
          : undefined,
      }
    },
    readTopic: (chatId, threadId) => this.readTopic(chatId, threadId),
    originalText: (msg) => {
      const raw = (msg.raw as LarkMessageEvent | undefined)?.message
      return raw ? messageText(raw) : undefined
    },
    triggerImages: (msg) => this.triggerImages.get(msg.raw as LarkMessageEvent),
    handled: (msg) => {
      const message = (msg.raw as LarkMessageEvent | undefined)?.message
      if (message?.message_id && message.create_time)
        this.onHandled(msg.channelId, message.message_id, message.create_time)
    },
  }

  sessionOptions(msg: IncomingMessage) {
    const options = topicSessionOptions(msg)
    if (!msg.topic && !msg.replyToId && !msg.handoff)
      options.tools.push('-lark_search_history')
    return options
  }

  register(vela: ExtensionAPI): void {
    vela.registerTool({
      name: 'search_history',
      channel: 'lark',
      maxResultChars: 20000,
      description:
        'Search older messages in this group by keyword or time range (default last seven days). Chat listing includes topic roots, not every thread reply; absence does not establish indexing delay. Report the returned matchCounts, senderType, ISO UTC times, coverage and truncation accurately; use an earlier end_time to search further.',
      inputSchema: historySearchSchema,
      annotations: { readOnlyHint: true },
      execute: async (input, ctx) => {
        const scope = ctx?.sessionId
          ? this.runtime?.scope(ctx.sessionId)
          : undefined
        if (scope?.channel !== 'lark' || scope.chatKind !== 'group')
          throw new Error('History search requires a Lark group session')
        return searchHistory(this.transport(), scope.chatId, input)
      },
    })
  }
}
