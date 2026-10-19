import { Readable } from 'node:stream'
import type { FeishuCard } from '../../src/extensions/feishu/cards.ts'
import type {
  FeishuHistoryMessage,
  FeishuMessageEvent,
  FeishuTransport,
} from '../../src/extensions/feishu/transport.ts'

/** Offline Feishu boundary; the actual extension and gateway still process every event. */
export function fakeFeishu() {
  let receive: ((event: FeishuMessageEvent) => void) | undefined
  let action: ((event: CardAction) => unknown) | undefined
  const sent: { chatId?: string; messageId?: string; text: string }[] = []
  const cards: { chatId: string; replyToId?: string; card: Card }[] = []
  const patches: { messageId: string; card: FeishuCard }[] = []
  const reactions: {
    messageId: string
    emoji: string
    id: string
    removed?: boolean
  }[] = []
  const topics: { messageId: string; task: string }[] = []
  const forwards: { messageId: string; threadId: string }[] = []
  const names = new Map<string, string>([
    ['ou_alice', 'Alice'],
    ['ou_bob', 'Bob'],
  ])
  const nameCalls: string[] = []
  const historyCalls: { chatId: string; before?: string; limit: number }[] = []
  const history: FeishuHistoryMessage[] = []
  const topicHistory: FeishuHistoryMessage[][] = []
  const topicHistoryCalls: { threadId: string; pageToken?: string }[] = []
  let failHistory = false
  let failReply = false
  const resources = new Map<string, Buffer[]>()
  const resourceCalls: {
    messageId: string
    key: string
    type: 'image' | 'file'
  }[] = []
  const transport: FeishuTransport = {
    startTopic: async (messageId, task) => {
      if (failReply) throw new Error('topic permission denied')
      topics.push({ messageId, task })
      return {
        messageId: `topic_${messageId}`,
        rootId: messageId,
        threadId: `thread_${messageId}`,
        createTime: String(Date.now()),
      }
    },
    forward: async (messageId, threadId) => {
      forwards.push({ messageId, threadId })
      return {
        messageId: `forward_${messageId}`,
        createTime: String(Date.now()),
      }
    },
    getResource: async (
      messageId: string,
      key: string,
      type: 'image' | 'file',
    ) => {
      resourceCalls.push({ messageId, key, type })
      const chunks = resources.get(key)
      if (!chunks) throw new Error(`Missing fake resource ${key}`)
      return Readable.from(chunks)
    },
    start: async (handler, onAction) => {
      receive = handler
      action = onAction
    },
    stop: () => {},
    getBotId: async () => 'ou_bot',
    getSenderName: async (id) => {
      nameCalls.push(id)
      if (!names.has(id)) throw new Error('contact unavailable')
      return names.get(id)
    },
    listMessages: async (chatId, options) => {
      historyCalls.push({ chatId, ...options })
      if (failHistory) throw new Error('history permission denied')
      return [...history]
    },
    searchMessages: async () => ({ items: [] }),
    listTopicMessages: async (threadId, pageToken) => {
      topicHistoryCalls.push({ threadId, pageToken })
      if (failHistory) throw new Error('history permission denied')
      const page = Number(pageToken ?? 0)
      return {
        items: topicHistory[page] ?? [],
        pageToken:
          page + 1 < topicHistory.length ? String(page + 1) : undefined,
      }
    },
    send: async (chatId, text) => {
      sent.push({ chatId, text })
      return {
        messageId: `sent_${sent.length}`,
        createTime: String(Date.now()),
      }
    },
    sendCard: async (chatId: string, card: Card, replyToId?: string) => {
      cards.push({ chatId, replyToId, card })
      return `card_${cards.length}`
    },
    patchCard: async (messageId, card) => {
      patches.push({ messageId, card })
    },
    addReaction: async (messageId, emoji) => {
      const id = `reaction_${reactions.length}`
      reactions.push({ messageId, emoji, id })
      return id
    },
    removeReaction: async (_messageId, id) => {
      const reaction = reactions.find((item) => item.id === id)
      if (reaction) reaction.removed = true
    },
    reply: async (messageId, text) => {
      if (failReply) throw new Error('reply failed')
      sent.push({ messageId, text })
      return { messageId: `reply_${messageId}`, createTime: String(Date.now()) }
    },
  }
  return {
    transport,
    patches,
    reactions,
    topics,
    forwards,
    resources,
    resourceCalls,
    sent,
    cards,
    callback: (event: CardAction) => action?.(event),
    click: (
      index: number,
      choice: string,
      overrides: Partial<CardAction> = {},
    ) => {
      const item = cards[index]
      if (!item) throw new Error(`No card at index ${index}`)
      const callbacks = item.card.body.elements
        .flatMap((element) => element.columns ?? [])
        .flatMap((column) => column.elements)
        .flatMap((button) => button.behaviors)
      const callback = callbacks.find(
        (entry) => entry.type === 'callback' && entry.value.action === choice,
      )
      if (!callback) throw new Error(`No ${choice} callback button`)
      return action?.({
        operator: { open_id: 'ou_bob' },
        context: { open_chat_id: item.chatId },
        action: { value: callback.value },
        ...overrides,
      })
    },
    names,
    nameCalls,
    historyCalls,
    topicHistory,
    topicHistoryCalls,
    history,
    failHistory: () => {
      failHistory = true
    },
    failReply: () => {
      failReply = true
    },
    deliver: (event: FeishuMessageEvent) => receive?.(event),
  }
}

interface Card {
  schema: '2.0'
  body: {
    elements: {
      tag: string
      columns?: {
        elements: {
          behaviors: {
            type: 'callback'
            value: { action: string; token: string }
          }[]
        }[]
      }[]
    }[]
  }
}

interface CardAction {
  operator?: { open_id?: string }
  context?: { open_chat_id?: string }
  action?: { value?: unknown }
}

export function feishuEvent(
  overrides: Partial<FeishuMessageEvent['message']> = {},
  sender = 'ou_alice',
): FeishuMessageEvent {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: sender } },
    message: {
      chat_id: 'oc_group',
      chat_type: 'group',
      message_id: crypto.randomUUID(),
      create_time: String(Date.now()),
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 hello' }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
      ...overrides,
    },
  }
}

export function historyMessage(
  id: string,
  sender: string,
  text: string,
  time = '1000',
): FeishuHistoryMessage {
  return {
    message_id: id,
    create_time: time,
    msg_type: 'text',
    body: { content: JSON.stringify({ text }) },
    sender: { id: sender, sender_type: 'user' },
  }
}
