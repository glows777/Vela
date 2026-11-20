import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  LarkHistoryMessage,
  LarkMessageEvent,
  LarkTransport,
} from '@glows777/vela-lark'

/**
 * The fake Lark behind `VELA_DESKTOP_LARK=fake`. It keeps a group's history in
 * memory, posts what the app sends, and delivers the person's messages the verify
 * script appends to `control.jsonl`. Nothing here is a product path.
 */
type Seed = {
  chats?: Record<
    string,
    {
      name?: string
      messages?: { sender: string; text: string; app?: boolean }[]
    }
  >
}

type Stored = {
  row: LarkHistoryMessage
  chatId: string
  threadId?: string
  rootId?: string
}

type Control =
  | {
      op: 'say'
      chatId: string
      text: string
      senderName?: string
    }
  | { op: 'failNextTopicStart' }
  | { op: 'failNextSend' }
  | { op: 'failNextTopicHistory' }
  /** A card Vela posted in a topic, after the row whose text matches `after`. */
  | { op: 'cardInTopic'; chatId: string; threadId: string; after: string }
  /** A person recalls a message in Lark: history stops returning it. */
  | { op: 'recall'; text: string }
  /**
   * Group messages that arrive while the app does not read: appended without an
   * event, so only the next read (or the person leaving and returning) sees them.
   */
  | { op: 'backlog'; chatId: string; texts: string[] }
  /**
   * The newest `count` messages of a group become cards: they still fill history
   * pages but carry no visible text, so a page can return nothing while a next page
   * exists.
   */
  | { op: 'filterNewest'; chatId: string; count: number }
  /** Named messages become cards: they fill a page with no visible text. */
  | { op: 'filterText'; chatId: string; texts: string[] }
  | { op: 'holdGroupRefresh'; chatId: string; refreshedText: string }
  | { op: 'releaseGroupRefresh' }
  /** The next group history read fails, as a dropped connection would. */
  | { op: 'failNextGroupHistory' }

const botId = 'cli_desktop_fake'
const botName = 'Vela'
const poll = 40

function gate() {
  let release: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

/** The transport the verify script drives through seed.json and control.jsonl. */
type FakeTransport = LarkTransport & {
  getChat(chatId: string): Promise<{ name?: string } | undefined>
}

export function fakeLark(dir: string): FakeTransport {
  let onMessage: ((event: LarkMessageEvent) => void) | undefined
  let stopped = true
  let handled = 0
  // Times are real wall clock, in milliseconds: a history cursor carries the moment it
  // was created, so a message that arrives later must be outside an older cursor.
  let clock = Date.now() - 1000
  let failNextTopicStart = false
  let failNextSend = false
  let failNextTopicHistory = false
  let failNextGroupHistory = false
  let groupRefresh:
    | {
        chatId: string
        refreshedText: string
        started: ReturnType<typeof gate>
        released: ReturnType<typeof gate>
      }
    | undefined
  let threads = 0
  const chats = new Map<string, { name?: string; rows: Stored[] }>()
  const threadsById = new Map<string, Stored[]>()
  const byId = new Map<string, Stored>()
  const names = new Map<string, string>()

  const nextClock = () => (clock = Math.max(clock + 1, Date.now()))
  const stamp = () => ({
    messageId: `om_${nextClock()}`,
    createTime: String(clock),
  })

  function add(
    chatId: string,
    content: string,
    sender: { id: string; app: boolean },
    thread?: { rootId: string; threadId: string },
    mentions?: { key: string; id?: { open_id?: string } }[],
  ): Stored {
    const { messageId, createTime } = stamp()
    const stored: Stored = {
      chatId,
      ...(thread ? { threadId: thread.threadId, rootId: thread.rootId } : {}),
      row: {
        message_id: messageId,
        create_time: createTime,
        msg_type: 'text',
        body: { content: JSON.stringify({ text: content }) },
        sender: {
          id: sender.id,
          sender_type: sender.app ? 'app' : 'user',
        },
        ...(mentions ? { mentions } : {}),
      },
    }
    byId.set(messageId, stored)
    // A thread reply is not part of the group's top-level history; its root is.
    if (thread) threadsById.get(thread.threadId)?.push(stored)
    else chats.get(chatId)?.rows.push(stored)
    return stored
  }

  function event(
    stored: Stored,
    text: string,
    mentions?: LarkMessageEvent['message']['mentions'],
  ): LarkMessageEvent {
    const row = stored.row
    return {
      message: {
        message_id: row.message_id,
        ...(stored.rootId ? { root_id: stored.rootId } : {}),
        ...(stored.threadId ? { thread_id: stored.threadId } : {}),
        create_time: row.create_time,
        chat_id: stored.chatId,
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text }),
        ...(mentions ? { mentions } : {}),
      },
      sender: {
        ...(row.sender?.sender_type === 'user'
          ? { sender_id: { open_id: row.sender.id } }
          : {}),
        sender_type: row.sender?.sender_type ?? 'user',
      },
    }
  }

  const visibleText = (stored: Stored) =>
    (JSON.parse(stored.row.body?.content ?? '{}') as { text?: string }).text ??
    ''

  const senderId = (senderName: string) =>
    `ou_${senderName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`

  function say(chatId: string, text: string, senderName: string) {
    const id = senderId(senderName)
    const key = `@_user_${byId.size + 1}`
    const content = `${key} ${text}`
    const mentions = [{ key, id: { open_id: botId } }]
    const stored = add(chatId, content, { id, app: false }, undefined, mentions)
    names.set(id, senderName)
    onMessage?.(event(stored, content, mentions))
  }

  async function readControl() {
    let source: string
    try {
      source = await readFile(join(dir, 'control.jsonl'), 'utf8')
    } catch {
      return
    }
    const lines = source.split('\n').filter((line) => line.trim() !== '')
    if (handled >= lines.length) return
    while (handled < lines.length) {
      const line = lines[handled++]!
      let control: Control
      try {
        control = JSON.parse(line) as Control
      } catch {
        continue
      }
      switch (control.op) {
        case 'failNextTopicStart':
          failNextTopicStart = true
          break
        case 'failNextSend':
          failNextSend = true
          break
        case 'failNextTopicHistory':
          failNextTopicHistory = true
          break
        case 'backlog': {
          // No event: the next read, or the person leaving and returning, sees them.
          // Stamped just after the moment the last read happened, so they fall outside
          // the history cursor the app held before it stopped reading.
          clock = Date.now() + 2000
          for (const text of control.texts)
            add(control.chatId, text, { id: senderId('Alice'), app: false })
          break
        }
        case 'filterNewest': {
          const rows = (chats.get(control.chatId)?.rows ?? [])
            .filter((stored) => !stored.row.deleted)
            .slice(-control.count)
          for (const stored of rows) stored.row.msg_type = 'interactive'
          break
        }
        case 'holdGroupRefresh':
          groupRefresh = {
            chatId: control.chatId,
            refreshedText: control.refreshedText,
            started: gate(),
            released: gate(),
          }
          break
        case 'releaseGroupRefresh':
          groupRefresh?.released.release()
          break
        case 'failNextGroupHistory':
          failNextGroupHistory = true
          break
        case 'filterText': {
          const wanted = new Set(control.texts)
          for (const stored of chats.get(control.chatId)?.rows ?? [])
            if (wanted.has(visibleText(stored)))
              stored.row.msg_type = 'interactive'
          break
        }
        case 'recall':
          for (const stored of byId.values())
            if (visibleText(stored) === control.text) stored.row.deleted = true
          break
        case 'cardInTopic': {
          const thread = threadsById.get(control.threadId)
          const root = thread?.[0]
          if (!thread || !root) break
          const at = thread.findIndex(
            (stored) => visibleText(stored) === control.after,
          )
          const card: Stored = {
            chatId: control.chatId,
            rootId: root.rootId,
            threadId: control.threadId,
            row: {
              message_id: `om_${nextClock()}`,
              create_time: String(clock),
              // A card has no text; the host drops it from the visible history.
              msg_type: 'interactive',
              body: { content: JSON.stringify({ card: 'progress' }) },
              sender: { id: botId, sender_type: 'app' },
            },
          }
          byId.set(card.row.message_id!, card)
          thread.splice(at < 0 ? thread.length : at + 1, 0, card)
          break
        }
        case 'say':
          say(control.chatId, control.text, control.senderName ?? 'Alice')
          break
      }
    }
    // Lets the verify script wait until a control line took effect before acting on it.
    await writeFile(
      join(dir, 'handled.json'),
      JSON.stringify({ lines: handled }),
    )
  }

  async function seed() {
    let source: string
    try {
      source = await readFile(join(dir, 'seed.json'), 'utf8')
    } catch {
      return
    }
    const seeded = JSON.parse(source) as Seed
    for (const [chatId, chat] of Object.entries(seeded.chats ?? {})) {
      const entry: { name?: string; rows: Stored[] } = { rows: [] }
      if (chat.name) entry.name = chat.name
      chats.set(chatId, entry)
      for (const message of chat.messages ?? []) {
        const stored = add(
          chatId,
          message.text,
          message.app
            ? { id: botId, app: true }
            : { id: senderId(message.sender), app: false },
        )
        if (!message.app) names.set(stored.row.sender!.id!, message.sender)
      }
    }
  }

  return {
    async start(receive) {
      await seed()
      onMessage = receive
      stopped = false
      const loop = async () => {
        while (!stopped) {
          await readControl()
          await new Promise((resolve) => setTimeout(resolve, poll))
        }
      }
      void loop()
    },
    stop() {
      stopped = true
      onMessage = undefined
    },
    async startTopic(messageId, title) {
      if (failNextTopicStart) {
        failNextTopicStart = false
        throw new Error('Fake Lark could not start the topic')
      }
      const anchor = byId.get(messageId)
      if (!anchor) throw new Error('Fake Lark has no such message')
      if (anchor.threadId && anchor.rootId) {
        const stored = add(
          anchor.chatId,
          title,
          { id: botId, app: true },
          {
            rootId: anchor.rootId,
            threadId: anchor.threadId,
          },
        )
        return {
          messageId: stored.row.message_id!,
          createTime: stored.row.create_time!,
          rootId: anchor.rootId,
          threadId: anchor.threadId,
        }
      }
      const threadId = `th_${++threads}`
      threadsById.set(threadId, [])
      const rootId = messageId
      anchor.rootId = rootId
      anchor.threadId = threadId
      threadsById.get(threadId)!.push(anchor)
      const stored = add(
        anchor.chatId,
        title,
        { id: botId, app: true },
        {
          rootId,
          threadId,
        },
      )
      return {
        messageId: stored.row.message_id!,
        createTime: stored.row.create_time!,
        rootId,
        threadId,
      }
    },
    async forward(messageId, threadId) {
      const source = byId.get(messageId)
      const thread = threadsById.get(threadId)
      if (!source || !thread?.[0]) throw new Error('Fake Lark cannot forward')
      const stored = add(
        source.chatId,
        String(
          (JSON.parse(source.row.body?.content ?? '{}') as { text?: string })
            .text ?? '',
        ),
        { id: botId, app: true },
        { rootId: thread[0].rootId!, threadId },
      )
      return {
        messageId: stored.row.message_id!,
        createTime: stored.row.create_time!,
      }
    },
    async send(chatId, text) {
      const stored = add(chatId, text, { id: botId, app: true })
      // Posted in the group, but the caller never learns the receipt.
      if (failNextSend) {
        failNextSend = false
        throw new Error('Fake Lark lost the send receipt')
      }
      return {
        messageId: stored.row.message_id!,
        createTime: stored.row.create_time!,
      }
    },
    async reply(messageId, text) {
      const source = byId.get(messageId)
      if (!source) throw new Error('Fake Lark has no such message')
      const stored = source.threadId
        ? add(
            source.chatId,
            text,
            { id: botId, app: true },
            {
              rootId: source.rootId!,
              threadId: source.threadId,
            },
          )
        : add(source.chatId, text, { id: botId, app: true })
      return {
        messageId: stored.row.message_id!,
        createTime: stored.row.create_time!,
      }
    },
    async sendCard(chatId) {
      // A card is not text history; the visible-message mapping drops it.
      const stored = add(chatId, '', { id: botId, app: true })
      stored.row.msg_type = 'interactive'
      return stored.row.message_id!
    },
    async patchCard() {},
    async addReaction() {
      return 'reaction'
    },
    async removeReaction() {},
    async getResource() {
      throw new Error('Fake Lark has no resources')
    },
    async getBotId() {
      return botId
    },
    async getSenderName(openId) {
      return openId === botId ? botName : (names.get(openId) ?? openId)
    },
    async getChat(chatId) {
      const chat = chats.get(chatId)
      return chat ? { name: chat.name } : undefined
    },
    async listTopicMessages(threadId, pageToken) {
      if (failNextTopicHistory) {
        failNextTopicHistory = false
        throw new Error('Fake Lark denied the topic history')
      }
      // One row per page: a page the host filters to nothing must not end the read.
      const rows = threadsById.get(threadId) ?? []
      const start = pageToken ? Number(pageToken) : 0
      const items = rows.slice(start, start + 1).map((stored) => stored.row)
      const next = start + items.length
      return {
        items,
        ...(next < rows.length ? { pageToken: String(next) } : {}),
      }
    },
    async searchMessages(chatId, { endTime, limit, pageToken }) {
      const refresh = groupRefresh?.chatId === chatId ? groupRefresh : undefined
      if (refresh) {
        if (pageToken) {
          // The older page must land after the renderer starts its refresh.
          await refresh.started.promise
        } else {
          refresh.started.release()
          await refresh.released.promise
          groupRefresh = undefined
        }
      }
      if (failNextGroupHistory) {
        failNextGroupHistory = false
        throw new Error('Fake Lark dropped the group history read')
      }
      const before = Number(endTime) * 1000
      const rows = (chats.get(chatId)?.rows ?? [])
        .filter((stored) => Number(stored.row.create_time) <= before)
        .sort(
          (one, other) =>
            Number(other.row.create_time) - Number(one.row.create_time),
        )
        .map((stored) => stored.row)
      const start = pageToken ? Number(pageToken) : 0
      const items = rows.slice(start, start + limit)
      const newest = items[0]
      if (refresh && !pageToken && newest) {
        // The visible marker comes only from the released first-page response.
        items[0] = {
          ...newest,
          body: { content: JSON.stringify({ text: refresh.refreshedText }) },
        }
      }
      const next = start + items.length
      return {
        items,
        ...(next < rows.length ? { pageToken: String(next) } : {}),
      }
    },
    async listMessages(chatId, { limit }) {
      return (chats.get(chatId)?.rows ?? [])
        .slice()
        .sort(
          (one, other) =>
            Number(other.row.create_time) - Number(one.row.create_time),
        )
        .slice(0, limit)
        .map((stored) => stored.row)
    },
  }
}
