import type { Readable } from 'node:stream'
import * as lark from '@larksuiteoapi/node-sdk'
import type {
  FeishuCard,
  FeishuCardAction,
  FeishuCardResponse,
} from './cards.ts'

/** The parts of an `im.message.receive_v1` event the channel reads */
export interface FeishuMessageEvent {
  message: {
    message_id?: string
    root_id?: string
    thread_id?: string
    create_time?: string
    chat_id: string
    /** `p2p` or `group` */
    chat_type?: string
    message_type: string
    content: string
    mentions?: { key: string; id?: { open_id?: string } }[]
  }
  sender: { sender_id?: { open_id?: string } }
}

/** History items returned newest first by Feishu's message API. Times are milliseconds. */
export interface FeishuHistoryMessage {
  message_id?: string
  create_time?: string
  msg_type?: string
  body?: { content?: string }
  sender?: { id?: string; sender_type?: string }
  mentions?: { key: string }[]
  deleted?: boolean
}

export interface FeishuSentMessage {
  messageId: string
  createTime: string
}

/** The connection to Feishu: receives message events and sends text to a chat (lark's long connection by default). */
export interface FeishuTransport {
  start(
    onMessage: (event: FeishuMessageEvent) => void,
    onAction: (event: FeishuCardAction) => FeishuCardResponse,
  ): Promise<void>
  stop(): void
  send(chatId: string, text: string): Promise<void>
  reply(messageId: string, text: string): Promise<FeishuSentMessage>
  sendCard(chatId: string, card: FeishuCard, replyToId?: string): Promise<void>
  getResource(
    messageId: string,
    key: string,
    type: 'image' | 'file',
  ): Promise<Readable>
  getBotId(): Promise<string>
  getSenderName(openId: string): Promise<string | undefined>
  listTopicMessages(
    threadId: string,
    pageToken?: string,
  ): Promise<{ items: FeishuHistoryMessage[]; pageToken?: string }>
  listMessages(
    chatId: string,
    options: { before?: string; limit: number },
  ): Promise<FeishuHistoryMessage[]>
}

function checked<T extends { code?: number; msg?: string }>(response: T): T {
  if (response.code !== undefined && response.code !== 0)
    throw new Error(
      `Feishu ${response.code}: ${response.msg ?? 'request failed'}`,
    )
  return response
}

export function larkTransport(
  appId: string,
  appSecret: string,
): FeishuTransport {
  const client = new lark.Client({ appId, appSecret })
  let wsClient: lark.WSClient | undefined
  return {
    async start(onMessage, onAction) {
      const dispatcher = new lark.EventDispatcher({})
      dispatcher.register({
        'im.message.receive_v1': (data) =>
          onMessage(data as FeishuMessageEvent),
        'card.action.trigger': (data: FeishuCardAction) => onAction(data),
      })
      wsClient = new lark.WSClient({
        appId,
        appSecret,
        loggerLevel: lark.LoggerLevel.warn,
      })
      await wsClient.start({ eventDispatcher: dispatcher })
    },
    stop() {
      wsClient?.close()
    },
    async send(chatId, text) {
      checked(
        await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text }),
          },
        }),
      )
    },
    async sendCard(chatId, card, replyToId) {
      const data = { msg_type: 'interactive', content: JSON.stringify(card) }
      checked(
        replyToId
          ? await client.im.message.reply({
              path: { message_id: replyToId },
              data,
            })
          : await client.im.message.create({
              params: { receive_id_type: 'chat_id' },
              data: { ...data, receive_id: chatId },
            }),
      )
    },
    async reply(messageId, text) {
      const response = checked(
        await client.im.message.reply({
          path: { message_id: messageId },
          data: { msg_type: 'text', content: JSON.stringify({ text }) },
        }),
      )
      const data = response.data
      if (!data?.message_id || !data.create_time)
        throw new Error('Feishu reply returned no message receipt')
      return { messageId: data.message_id, createTime: data.create_time }
    },
    async getResource(messageId, key, type) {
      const resource = await client.im.messageResource.get({
        path: { message_id: messageId, file_key: key },
        params: { type },
      })
      return resource.getReadableStream()
    },
    async getBotId() {
      const response = checked(
        await client.request<{
          code?: number
          msg?: string
          bot?: { open_id?: string }
        }>({ url: '/open-apis/bot/v3/info', method: 'GET' }),
      )
      if (!response.bot?.open_id)
        throw new Error('Feishu bot info returned no open_id')
      return response.bot.open_id
    },
    async getSenderName(openId) {
      const response = checked(
        await client.contact.user.get({
          path: { user_id: openId },
          params: { user_id_type: 'open_id' },
        }),
      )
      return response.data?.user?.name
    },
    async listTopicMessages(threadId, pageToken) {
      const response = checked(
        await client.im.message.list({
          params: {
            container_id_type: 'thread',
            container_id: threadId,
            sort_type: 'ByCreateTimeAsc',
            page_size: 50,
            page_token: pageToken,
          },
        }),
      )
      return {
        items: response.data?.items ?? [],
        pageToken: response.data?.has_more
          ? response.data.page_token
          : undefined,
      }
    },
    async listMessages(chatId, { before, limit }) {
      const response = checked(
        await client.im.message.list({
          params: {
            container_id_type: 'chat',
            container_id: chatId,
            sort_type: 'ByCreateTimeDesc',
            page_size: Math.min(50, limit),
            ...(before
              ? { end_time: String(Math.floor(Number(before) / 1000) + 1) }
              : {}),
          },
        }),
      )
      return response.data?.items ?? []
    },
  }
}
