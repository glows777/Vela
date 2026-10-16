import type {
  FeishuHistoryMessage,
  FeishuMessageEvent,
  FeishuTransport,
} from '../../src/extensions/feishu/channel.ts'

/** Offline Feishu boundary; the actual extension and gateway still process every event. */
export function fakeFeishu() {
  let receive: ((event: FeishuMessageEvent) => void) | undefined
  const sent: { chatId?: string; messageId?: string; text: string }[] = []
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
    start: async (handler) => {
      receive = handler
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
    reply: async (messageId, text) => {
      if (failReply) throw new Error('reply failed')
      sent.push({ messageId, text })
      return { messageId: `reply_${messageId}`, createTime: String(Date.now()) }
    },
  }
  return {
    transport,
    sent,
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
    message_type: 'text',
    body: { content: JSON.stringify({ text }) },
    sender: { id: sender, sender_type: 'user' },
  }
}
