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
    state: z.enum(['running', 'done', 'stopped']),
    pendingMessageIds: z.array(z.string()),
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
    }
    this.records.set(key, next)
    try {
      await this.save(next)
    } catch (error) {
      this.records.set(key, record)
      throw error
    }
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
    if (msg.replyToId && !record.pendingMessageIds.includes(msg.replyToId))
      record.pendingMessageIds.push(msg.replyToId)
    await this.save(record)
  }

  async begin(key: string, msg: IncomingMessage): Promise<void> {
    const record = this.records.get(key)
    if (!record) return
    record.state = 'running'
    record.requester = { id: msg.senderId, name: msg.senderName }
    record.replyTarget = msg.replyToId
    await this.save(record)
  }

  async forget(key: string, ids: string[]): Promise<void> {
    const record = this.records.get(key)
    if (!record || !ids.some((id) => record.pendingMessageIds.includes(id)))
      return
    record.pendingMessageIds = record.pendingMessageIds.filter(
      (id) => !ids.includes(id),
    )
    await this.save(record)
  }

  async finish(key: string, state: ChannelRecord['state']): Promise<void> {
    const record = this.records.get(key)
    if (!record) return
    record.state = state
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
            },
          ]
        : [],
    )
  }

  flush(): Promise<void> {
    return this.writing
  }

  private save(record: ChannelRecord): Promise<void> {
    record.updatedAt = new Date().toISOString()
    const path = this.path
    if (!path) return Promise.resolve()
    const text =
      JSON.stringify({
        version: 1,
        createdAt: this.createdAt,
        records: [...this.records.values()],
      }) + '\n'
    const write = this.writing
      .catch(() => {})
      .then(async () => {
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
      })
    this.writing = write
    return write
  }
}
