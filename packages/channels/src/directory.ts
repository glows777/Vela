import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { writeAtomicJson } from './atomic-json.ts'
import type { ChannelTopic, IncomingMessage } from './types.ts'

const recordSchema = z
  .object({
    key: z.string(),
    channel: z.string(),
    legacyKey: z.string().optional(),
    storageKey: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+$/)
      .refine((key) => key !== '.' && key !== '..')
      .optional(),
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
    handoff: z.object({ from: z.string(), depth: z.number() }).optional(),
    routine: z
      .object({
        id: z.string(),
        scheduledAt: z.string(),
        creator: z.object({ id: z.string(), name: z.string() }).optional(),
      })
      .optional(),
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
export const channelIndexSchema = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  records: z.array(recordSchema),
  /** Status lines waiting for a group session's next run, by group key. */
  notes: z.record(z.string(), z.array(z.string())).optional(),
})
export type ChannelRecord = z.infer<typeof recordSchema>

/** Hand-off notes exist only in groups and address the group session without a service message. */
export function isGroupInput(msg: IncomingMessage): boolean {
  return !!(msg.topic || msg.replyToId || msg.handoff)
}

const MAX_NOTES = 20
const MAX_NOTE_CHARS = 300

/** Passive metadata travels with the existing pending ID, never in a second ID registry. */
export function pendingMessageId(
  input: ChannelRecord['pendingMessageIds'][number],
): string {
  return typeof input === 'string' ? input : input.id
}

/** One directory for recovery and topic discovery. No input text is copied here except the task label. */
export class ChannelDirectory {
  private records = new Map<string, ChannelRecord>()
  private notes = new Map<string, string[]>()
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
    const marker = join(this.path, '..', 'migration.json')
    if (existsSync(marker)) {
      const migration = JSON.parse(await readFile(marker, 'utf8'))
      if (migration.version !== 1 || migration.status !== 'complete')
        throw new Error(
          'Channel migration is incomplete; rerun the migration utility before starting transports',
        )
    }
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
      const data = channelIndexSchema.parse(JSON.parse(text))
      if (new Set(data.records.map((r) => r.key)).size !== data.records.length)
        throw new Error('Duplicate channel key')
      const keys = new Set(data.records.map((record) => record.key))
      const legacy = data.records.flatMap((record) =>
        record.legacyKey ? [record.legacyKey] : [],
      )
      if (
        new Set(legacy).size !== legacy.length ||
        legacy.some((key) => keys.has(key))
      )
        throw new Error('Conflicting legacy channel key')
      const stores = new Map<string, string | undefined>()
      for (const record of data.records) {
        const chat = JSON.stringify([record.channel, record.chatId])
        if (stores.has(chat) && stores.get(chat) !== record.storageKey)
          throw new Error('Conflicting channel storage keys')
        stores.set(chat, record.storageKey)
      }
      this.createdAt = data.createdAt
      this.records = new Map(data.records.map((record) => [record.key, record]))
      this.notes = new Map(Object.entries(data.notes ?? {}))
    } catch (error) {
      throw new Error(
        `Invalid channel directory ${this.path}: ${String(error)}`,
        { cause: error },
      )
    }
  }

  get(key: string): ChannelRecord | undefined {
    return (
      this.records.get(key) ??
      [...this.records.values()].find((record) => record.legacyKey === key)
    )
  }
  storageKey(channel: string, chatId: string): string | undefined {
    return this.entries(channel).find((record) => record.chatId === chatId)
      ?.storageKey
  }
  sessionId(key: string): string {
    return this.get(key)?.activeSessionId ?? key
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
        chatKind: isGroupInput(msg) ? 'group' : 'direct',
        rootId: msg.topic?.rootId,
        threadId: msg.topic?.threadId,
        requester: { id: msg.senderId, name: msg.senderName },
        replyTarget: msg.replyToId,
        task: task.slice(0, 120),
        activeSessionId: key,
        storageKey: this.storageKey(channel, msg.channelId),
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
    // A note from another session never answers a person's pending decision.
    if (!msg.handoff) {
      record.waitingReason = undefined
      if (record.state === 'waiting') record.state = 'done'
    }
    // A note has no service message of its own: its reply target is the topic root.
    if (
      msg.replyToId &&
      !msg.routine &&
      !msg.handoff &&
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
    record.handoff = msg.handoff
    record.routine = msg.routine
      ? { ...msg.routine, creator: { id: msg.senderId, name: msg.senderName } }
      : undefined
    if (!record.rootId || record.requester.id === msg.senderId)
      record.requester = { id: msg.senderId, name: msg.senderName }
    record.replyTarget = msg.replyToId
    await this.save(record)
  }

  async forget(key: string, ids: string[]): Promise<void> {
    const record = this.records.get(key)
    if (
      !record?.pendingMessageIds.some((input) =>
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

  /** Status lines for a group session's next run, oldest first. */
  pendingNotes(key: string): readonly string[] {
    return this.notes.get(key) ?? []
  }

  addNote(key: string, line: string): Promise<void> {
    const note =
      line.length > MAX_NOTE_CHARS ? `${line.slice(0, MAX_NOTE_CHARS)}…` : line
    this.notes.set(key, [...this.pendingNotes(key), note].slice(-MAX_NOTES))
    return this.write()
  }

  /** Drops these delivered notes once a session has saved them; newer ones stay. */
  dropNotes(key: string, delivered: readonly string[]): Promise<void> {
    const rest = [...this.pendingNotes(key)]
    for (const note of delivered) {
      const index = rest.indexOf(note)
      if (index >= 0) rest.splice(index, 1)
    }
    if (rest.length) this.notes.set(key, rest)
    else this.notes.delete(key)
    return this.write()
  }

  flush(): Promise<void> {
    return this.writing
  }

  private save(record: ChannelRecord, replace = false): Promise<void> {
    record.updatedAt = new Date().toISOString()
    return this.write(replace ? record : undefined)
  }

  private write(replacement?: ChannelRecord): Promise<void> {
    const path = this.path
    if (!path) {
      if (replacement) this.records.set(replacement.key, replacement)
      return Promise.resolve()
    }
    const write = this.writing
      .catch(() => {})
      .then(async () => {
        // Later saves see only generations whose index write succeeded.
        await writeAtomicJson(path, {
          version: 1,
          createdAt: this.createdAt,
          records: [...this.records.values()].map((current) =>
            current.key === replacement?.key ? replacement : current,
          ),
          ...(this.notes.size ? { notes: Object.fromEntries(this.notes) } : {}),
        })
        if (replacement) this.records.set(replacement.key, replacement)
      })
    this.writing = write
    return write
  }
}
