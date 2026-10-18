import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { ChannelTopic, IncomingMessage } from './types.ts'

const recordSchema = z
  .object({
    key: z.string(),
    channel: z.string(),
    chatId: z.string(),
    chatKind: z.enum(['group', 'direct']),
    rootId: z.string().optional(),
    threadId: z.string().optional(),
    requester: z.object({ id: z.string(), name: z.string() }),
    replyTarget: z.string().optional(),
    task: z.string(),
    activeSessionId: z.string(),
    previousSessionIds: z.array(z.string()),
    state: z.enum(['running', 'waiting', 'done', 'stopped']),
    waitingReason: z.string().optional(),
    passive: z.boolean().optional(),
    pendingMessageIds: z.array(
      z.union([
        z.string(),
        z.object({ id: z.string(), passive: z.literal(true) }),
      ]),
    ),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .refine(
    (record) => !!record.rootId === !!record.threadId,
    'Incomplete topic address',
  )
const indexSchema = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  records: z.array(recordSchema),
})
export type ChannelRecord = z.infer<typeof recordSchema>

/** Passive metadata travels with the existing pending ID, never in a second ID registry. */
export function pendingMessageId(
  input: ChannelRecord['pendingMessageIds'][number],
): string {
  return typeof input === 'string' ? input : input.id
}

/** One directory for recovery and topic discovery. No input text is copied here except the task label. */
export class ChannelDirectory {
  private records = new Map<string, ChannelRecord>()
  private loaded?: Promise<void>
  private writing: Promise<void> = Promise.resolve()
  private readonly path?: string
  private createdAt = new Date().toISOString()

  constructor(dataDir?: string) {
    this.path = dataDir ? join(dataDir, 'channels', 'index.json') : undefined
  }

  load(): Promise<void> {
    this.loaded ??= this.read()
    return this.loaded
  }

  private async read(): Promise<void> {
    if (!this.path) return
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new Error(`Cannot read channel directory ${this.path}`, {
        cause: error,
      })
    }
    try {
      const data = indexSchema.parse(JSON.parse(text))
      if (new Set(data.records.map((r) => r.key)).size !== data.records.length)
        throw new Error('Duplicate channel key')
      this.createdAt = data.createdAt
      this.records = new Map(data.records.map((record) => [record.key, record]))
    } catch (error) {
      throw new Error(
        `Invalid channel directory ${this.path}: ${String(error)}`,
        { cause: error },
      )
    }
  }

  get(key: string): ChannelRecord | undefined {
    return this.records.get(key)
  }
  sessionId(key: string): string {
    return this.records.get(key)?.activeSessionId ?? key
  }
  keyForSession(id: string): string {
    return (
      [...this.records.values()].find((record) => record.activeSessionId === id)
        ?.key ?? id
    )
  }

  async restart(key: string): Promise<void> {
    const record = this.records.get(key)
    if (!record) throw new Error(`Unknown channel session ${key}`)
    const next = {
      ...record,
      activeSessionId: `channel-${crypto.randomUUID()}`,
      previousSessionIds: [
        ...record.previousSessionIds,
        record.activeSessionId,
      ],
      state: 'done' as const,
      waitingReason: undefined,
    }
    await this.save(next, true)
  }
  entries(channel: string): ChannelRecord[] {
    return [...this.records.values()].filter(
      (record) => record.channel === channel,
    )
  }
  get coverage(): string {
    return `Topics recorded since M2 directory creation at ${this.createdAt}; earlier topics may exist until they receive a new message. An empty list does not mean there are no tasks.`
  }

  observe(
    key: string,
    channel: string,
    msg: IncomingMessage,
    task = msg.text,
  ): ChannelRecord {
    let record = this.records.get(key)
    if (!record) {
      const now = new Date().toISOString()
      record = {
        key,
        channel,
        chatId: msg.channelId,
        chatKind: msg.topic || msg.replyToId ? 'group' : 'direct',
        rootId: msg.topic?.rootId,
        threadId: msg.topic?.threadId,
        requester: { id: msg.senderId, name: msg.senderName },
        replyTarget: msg.replyToId,
        task: task.slice(0, 120),
        activeSessionId: key,
        previousSessionIds: [],
        state: 'done',
        pendingMessageIds: [],
        createdAt: now,
        updatedAt: now,
      }
      this.records.set(key, record)
    }
    return record
  }

  async admit(
    key: string,
    channel: string,
    msg: IncomingMessage,
  ): Promise<void> {
    const record = this.observe(key, channel, msg)
    record.waitingReason = undefined
    if (record.state === 'waiting') record.state = 'done'
    if (
      msg.replyToId &&
      !record.pendingMessageIds.some(
        (input) => pendingMessageId(input) === msg.replyToId,
      )
    )
      record.pendingMessageIds.push(
        msg.passive ? { id: msg.replyToId, passive: true } : msg.replyToId,
      )
    await this.save(record)
  }

  async begin(key: string, msg: IncomingMessage): Promise<void> {
    const record = this.records.get(key)
    if (!record) return
    record.state = 'running'
    record.passive = msg.passive
    if (!record.rootId || record.requester.id === msg.senderId)
      record.requester = { id: msg.senderId, name: msg.senderName }
    record.replyTarget = msg.replyToId
    await this.save(record)
  }

  async forget(key: string, ids: string[]): Promise<void> {
    const record = this.records.get(key)
    if (
      !record ||
      !record.pendingMessageIds.some((input) =>
        ids.includes(pendingMessageId(input)),
      )
    )
      return
    record.pendingMessageIds = record.pendingMessageIds.filter(
      (input) => !ids.includes(pendingMessageId(input)),
    )
    await this.save(record)
  }

  async waitForInput(key: string, reason: string): Promise<void> {
    const record = this.records.get(key)
    if (!record?.rootId) throw new Error('Waiting requires a topic')
    record.waitingReason = reason
    await this.save(record)
  }

  async finish(
    key: string,
    state: ChannelRecord['state'],
    answered = false,
  ): Promise<void> {
    const record = this.records.get(key)
    if (!record) return
    record.state =
      state === 'done' && answered && record.waitingReason ? 'waiting' : state
    if (record.state !== 'waiting') record.waitingReason = undefined
    await this.save(record)
  }

  list(
    channel: string,
    chatId: string,
    state: (id: string) => ChannelTopic['state'],
  ): ChannelTopic[] {
    return this.entries(channel).flatMap((record) =>
      record.chatId === chatId && record.rootId && record.threadId
        ? [
            {
              rootId: record.rootId,
              threadId: record.threadId,
              task: record.task,
              state: state(record.key),
              requester: record.requester,
              updatedAt: record.updatedAt,
              waitingReason: record.waitingReason,
            },
          ]
        : [],
    )
  }

  flush(): Promise<void> {
    return this.writing
  }

  private save(record: ChannelRecord, replace = false): Promise<void> {
    record.updatedAt = new Date().toISOString()
    const path = this.path
    if (!path) {
      if (replace) this.records.set(record.key, record)
      return Promise.resolve()
    }
    const write = this.writing
      .catch(() => {})
      .then(async () => {
        // Later saves see only generations whose index write succeeded.
        const text =
          JSON.stringify({
            version: 1,
            createdAt: this.createdAt,
            records: [...this.records.values()].map((current) =>
              replace && current.key === record.key ? record : current,
            ),
          }) + '\n'
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        const temporary = `${path}.${crypto.randomUUID()}.tmp`
        try {
          const file = await open(temporary, 'wx', 0o600)
          try {
            await file.writeFile(text)
            await file.sync()
          } finally {
            await file.close()
          }
          await rename(temporary, path)
        } finally {
          await rm(temporary, { force: true })
        }
        if (replace) this.records.set(record.key, record)
      })
    this.writing = write
    return write
  }
}
