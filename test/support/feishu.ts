import type {
  FeishuHistoryMessage,
  FeishuMessageEvent,
  FeishuTransport,
} from '../../src/extensions/feishu/channel.ts'

/** Offline Feishu boundary; the actual extension and gateway still process every event. */
export function fakeFeishu() {
  let receive: ((event: FeishuMessageEvent) => void) | undefined
  let action: ((event: CardAction) => unknown) | undefined
  const sent: { chatId?: string; messageId?: string; text: string }[] = []
  const cards: { chatId: string; replyToId?: string; card: Card }[] = []
  const names = new Map<string, string>([
    ['ou_alice', 'Alice'],
    ['ou_bob', 'Bob'],
  ])
  const nameCalls: string[] = []
  const historyCalls: { chatId: string; before?: string; limit: number }[] = []
  const history: FeishuHistoryMessage[] = []
  let failHistory = false
  let failReply = false
  const transport: FeishuTransport = {
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
    send: async (chatId, text) => {
      sent.push({ chatId, text })
    },
    sendCard: async (chatId: string, card: Card, replyToId?: string) => {
      cards.push({ chatId, replyToId, card })
    },
    reply: async (messageId, text) => {
      if (failReply) throw new Error('reply failed')
      sent.push({ messageId, text })
      return { messageId: `reply_${messageId}`, createTime: String(Date.now()) }
    },
  }
  return {
    transport,
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
    sender: { sender_id: { open_id: sender } },
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
