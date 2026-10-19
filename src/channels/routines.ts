import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { errorMessage, type VelaLogger } from '../logger.ts'
import type { VelaSession } from '../vela-session.ts'
import { writeAtomicJson } from './atomic-json.ts'
import type { ChannelDirectory } from './directory.ts'
import {
  latestOccurrence,
  localRoutineInstant,
  nextOccurrence,
  routineLocalTime,
  routineTimezone,
} from './routine-time.ts'
import type {
  ChannelDefinition,
  ChannelRoutine,
  ChannelRoutineInfo,
  ChannelRuntime,
  IncomingMessage,
} from './types.ts'

const instant = z.iso
  .datetime()
  .refine((value) => Number.isFinite(Date.parse(value)), 'Invalid instant')
const recurringSchema = z
  .object({
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    days: z
      .array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']))
      .min(1)
      .optional(),
  })
  .strict()
const scheduleSchema = z.union([
  z.object({ at: instant }).strict(),
  recurringSchema,
])

const createRoutineSchema = z
  .object({
    action: z.literal('create'),
    message: z.string().trim().min(1),
    schedule: z.union([z.object({ at: z.string() }).strict(), recurringSchema]),
  })
  .strict()

/** Provider input must have an object root; the pipe retains strict operation validation. */
export const routineToolSchema = createRoutineSchema
  .extend({
    action: z.enum(['create', 'list', 'cancel']),
    id: z.string().min(1).optional(),
  })
  .partial({ message: true, schedule: true })
  .pipe(
    z.discriminatedUnion('action', [
      createRoutineSchema,
      z.object({ action: z.literal('list') }).strict(),
      z.object({ action: z.literal('cancel'), id: z.string().min(1) }).strict(),
    ]),
  )
const routineSchema = z
  .object({
    id: z.string().min(1),
    channel: z.string().min(1),
    chatId: z.string().min(1),
    targetKey: z.string().min(1),
    creator: z.object({ id: z.string().min(1), name: z.string().min(1) }),
    message: z.string().trim().min(1),
    schedule: scheduleSchema,
    createdAt: instant,
    lastFiredAt: instant.nullable(),
  })
  .strict()
const fileSchema = z
  .object({ version: z.literal(1), routines: z.array(routineSchema) })
  .strict()

export interface RoutineClock {
  now(): number
  setTimeout(callback: () => void, delay: number): unknown
  clearTimeout(timer: unknown): void
}

/** Channel-local persistence and wake-ups. Gateway queues own execution and recovery. */
export class ChannelRoutines {
  clock: RoutineClock = {
    now: Date.now,
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) =>
      clearTimeout(timer as ReturnType<typeof setTimeout>),
  }
  private records: ChannelRoutine[] = []
  private writing: Promise<void> = Promise.resolve()
  private loaded?: Promise<void>
  private zones = new Map<string, string>()
  private started = new Set<string>()
  private disabled = new Set<string>()
  private inFlight = new Map<string, number>()
  readonly active = new Set<Promise<void>>()
  private timer?: unknown
  private stopped = true
  private readonly path?: string

  constructor(
    dataDir: string | undefined,
    private directory: ChannelDirectory,
    private channel: (name: string) => ChannelDefinition | undefined,
    private enqueue: (name: string, msg: IncomingMessage) => Promise<void>,
    private restored: (
      key: string,
      name: string,
      msg: IncomingMessage,
    ) => Promise<VelaSession | undefined>,
    private logger: VelaLogger,
  ) {
    this.path = dataDir ? join(dataDir, 'channels', 'routines.json') : undefined
  }

  async load(channels: Iterable<ChannelDefinition>): Promise<void> {
    for (const ch of channels)
      this.zones.set(ch.name, routineTimezone(ch.timezone))
    this.loaded ??= this.read()
    await this.loaded
    this.started.clear()
    this.disabled.clear()
    this.stopped = false
  }

  private async read(): Promise<void> {
    if (!this.path) return
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new Error(`Cannot read channel routines ${this.path}`, {
        cause: error,
      })
    }
    try {
      const data = fileSchema.parse(JSON.parse(text))
      if (new Set(data.routines.map((r) => r.id)).size !== data.routines.length)
        throw new Error('Duplicate routine id')
      this.records = data.routines
    } catch (cause) {
      throw new Error(
        `Invalid channel routines ${this.path}: ${String(cause)}`,
        { cause },
      )
    }
  }

  start(name: string): void {
    this.started.add(name)
    this.tick(name)
  }

  private change(
    update: (records: ChannelRoutine[]) => ChannelRoutine[],
  ): Promise<void> {
    const task = this.writing
      .catch(() => {})
      .then(async () => {
        const next = update(this.records)
        if (this.path)
          await writeAtomicJson(this.path, { version: 1, routines: next })
        this.records = next
      })
    this.writing = task
    this.active.add(task)
    void task.then(
      () => this.active.delete(task),
      () => this.active.delete(task),
    )
    return task
  }

  list(channel: string, chatId: string): ChannelRoutine[] {
    return structuredClone(
      this.records.filter((r) => r.channel === channel && r.chatId === chatId),
    )
  }

  async create(
    input: Omit<ChannelRoutine, 'id' | 'createdAt' | 'lastFiredAt'>,
  ): Promise<ChannelRoutine> {
    const record = routineSchema.parse({
      ...input,
      id: crypto.randomUUID(),
      createdAt: new Date(this.clock.now()).toISOString(),
      lastFiredAt: null,
    })
    if (
      !nextOccurrence(
        record.schedule,
        this.clock.now(),
        this.zones.get(record.channel)!,
      )
    )
      throw new Error('A one-off routine must be in the future')
    await this.change((records) => {
      if (
        records.filter(
          (r) => r.channel === record.channel && r.chatId === record.chatId,
        ).length >= 20
      )
        throw new Error('This chat already has 20 routines')
      return [...records, record]
    })
    this.arm()
    return structuredClone(record)
  }

  async cancel(channel: string, chatId: string, id: string): Promise<boolean> {
    let cancelled = false
    await this.change((records) =>
      records.filter((r) => {
        const matches =
          r.id === id && r.channel === channel && r.chatId === chatId
        if (matches) cancelled = true
        return !matches
      }),
    )
    this.arm()
    return cancelled
  }

  private describe(record: ChannelRoutine): ChannelRoutineInfo {
    const timezone = this.zones.get(record.channel)!
    const target = this.directory.get(record.targetKey)
    const next = nextOccurrence(record.schedule, this.clock.now(), timezone)
    return {
      ...structuredClone(record),
      timezone,
      scheduleText:
        'at' in record.schedule
          ? routineLocalTime(Date.parse(record.schedule.at), timezone)
          : `${record.schedule.days?.join(',') ?? 'daily'} at ${record.schedule.time}`,
      target: !target
        ? 'Unavailable target'
        : target.rootId
          ? `Topic ${target.rootId}: ${target.task}`
          : target.chatKind === 'group'
            ? 'Group channel'
            : 'Direct chat',
      nextRun: next === undefined ? null : routineLocalTime(next, timezone),
    }
  }

  private describeChat(channel: string, chatId: string) {
    return {
      timezone: this.zones.get(channel)!,
      routines: this.list(channel, chatId).map((r) => this.describe(r)),
    }
  }

  formatList(channel: string, chatId: string): string {
    const { timezone, routines } = this.describeChat(channel, chatId)
    return [
      `Routines (${timezone})`,
      ...routines.map(
        (r) =>
          `${r.id} | ${r.scheduleText} | ${r.target} | set by ${r.creator.name} | next: ${r.nextRun ?? 'no future occurrence'}`,
      ),
      ...(routines.length ? [] : ['No routines in this chat.']),
    ].join('\n')
  }

  scoped(
    name: string,
    context: (id: string) => IncomingMessage | undefined,
  ): ChannelRuntime['routines'] {
    const source = (id: string) => {
      const msg = context(id)
      const key = this.directory.keyForSession(id)
      if (!msg || this.directory.sessionId(key) !== id)
        throw new Error('Routines require an active channel run')
      return { msg, key }
    }
    return {
      create: async (id, message, schedule) => {
        const { msg, key } = source(id)
        const record = await this.create({
          channel: name,
          chatId: msg.channelId,
          targetKey: key,
          creator: { id: msg.senderId, name: msg.senderName },
          message,
          schedule:
            'at' in schedule
              ? { at: localRoutineInstant(schedule.at, this.zones.get(name)!) }
              : schedule,
        })
        return this.describe(record)
      },
      list: (id) => this.describeChat(name, source(id).msg.channelId),
      cancel: (id, routineId) =>
        this.cancel(name, source(id).msg.channelId, routineId),
    }
  }

  async confirmed(msg: IncomingMessage): Promise<void> {
    if (!msg.routine) return
    const { id, scheduledAt } = msg.routine
    await this.change((records) =>
      records.flatMap((r) => {
        if (
          r.id !== id ||
          r.channel !== this.directory.get(r.targetKey)?.channel ||
          r.chatId !== msg.channelId ||
          (r.lastFiredAt &&
            Date.parse(r.lastFiredAt) >= Date.parse(scheduledAt))
        )
          return [r]
        return 'at' in r.schedule ? [] : [{ ...r, lastFiredAt: scheduledAt }]
      }),
    )
    this.arm()
  }

  /** Re-align a committed session marker before submitting another scheduled input. */
  async shouldRun(
    msg: IncomingMessage,
    session: VelaSession,
  ): Promise<boolean> {
    for (const entry of session.getEntries()) {
      if (entry.type !== 'custom' || entry.customType !== 'channel.input')
        continue
      const routine = (entry.data as { routine?: IncomingMessage['routine'] })
        ?.routine
      if (routine?.id === msg.routine?.id)
        await this.confirmed({ ...msg, routine })
    }
    const record = this.records.find((r) => r.id === msg.routine?.id)
    return (
      !!record &&
      (!record.lastFiredAt ||
        Date.parse(record.lastFiredAt) < Date.parse(msg.routine!.scheduledAt))
    )
  }

  private tick(name?: string): void {
    if (this.stopped) return
    const now = this.clock.now()
    for (const record of this.records) {
      if (
        (name && name !== record.channel) ||
        !this.started.has(record.channel) ||
        (this.inFlight.has(record.id) &&
          Date.parse(record.lastFiredAt ?? record.createdAt) <
            this.inFlight.get(record.id)!)
      )
        continue
      const at = latestOccurrence(
        record.schedule,
        Date.parse(record.lastFiredAt ?? record.createdAt),
        now,
        this.zones.get(record.channel)!,
      )
      if (at === undefined) continue
      this.inFlight.set(record.id, at)
      const task = this.deliver(record, at, !!name)
        .catch((error) => {
          this.logger.error(
            `[${record.channel}] Routine ${record.id} failed: ${errorMessage(error)}`,
          )
        })
        .finally(() => {
          if (this.inFlight.get(record.id) === at)
            this.inFlight.delete(record.id)
          this.active.delete(task)
          this.arm()
        })
      this.active.add(task)
    }
    this.arm()
  }

  private async deliver(
    routine: ChannelRoutine,
    at: number,
    startup: boolean,
  ): Promise<void> {
    const record = this.directory.get(routine.targetKey)
    const channel = this.channel(routine.channel)
    if (
      !record ||
      record.channel !== routine.channel ||
      record.chatId !== routine.chatId ||
      !channel
    ) {
      this.logger.warn(
        `[${routine.channel}] Routine ${routine.id} has no logical target`,
      )
      return
    }
    const late = this.clock.now() - at
    let msg: IncomingMessage = {
      channelId: routine.chatId,
      senderId: routine.creator.id,
      senderName: routine.creator.name,
      text: `Scheduled wake-up ${routine.id}, set by ${routine.creator.name}, scheduled for ${new Date(at).toISOString()} (${this.zones.get(routine.channel)})${late > 0 ? `; late by ${Math.ceil(late / 1000)} seconds` : ''}:\n${routine.message}`,
      routine: { id: routine.id, scheduledAt: new Date(at).toISOString() },
      ...(record.rootId && record.threadId
        ? {
            topic: { rootId: record.rootId, threadId: record.threadId },
            replyToId: record.rootId,
          }
        : {}),
    }
    if (channel.canRecover?.(msg, record.chatKind) === false) {
      const chat = `${routine.channel}\0${routine.chatId}`
      if (!this.disabled.has(chat)) {
        this.disabled.add(chat)
        this.logger.info(
          `[${routine.channel}] Routine skipped: chat is disabled`,
        )
      }
      return
    }
    if (this.stopped || !this.records.some((r) => r.id === routine.id)) return
    if (startup) {
      // Recovery owns the key first. Reconcile saved inputs before announcing a catch-up.
      const session = await this.restored(
        routine.targetKey,
        routine.channel,
        msg,
      )
      if (!session || !(await this.shouldRun(msg, session)) || this.stopped)
        return
    }
    if (channel.prepareRoutine) {
      const prepared = await channel.prepareRoutine(msg, record.chatKind, {
        message: routine.message,
        lateByMs: late,
      })
      if (!prepared) return
      msg = prepared
    }
    if (!this.stopped) await this.enqueue(routine.channel, msg)
  }

  private arm(): void {
    this.clock.clearTimeout(this.timer)
    this.timer = undefined
    if (this.stopped) return
    const now = this.clock.now()
    const times = this.records.flatMap((r) => {
      if (!this.started.has(r.channel)) return []
      const next = nextOccurrence(
        r.schedule,
        Math.max(now, Date.parse(r.lastFiredAt ?? r.createdAt)),
        this.zones.get(r.channel)!,
      )
      return next === undefined ? [] : [next]
    })
    if (!times.length) return
    this.timer = this.clock.setTimeout(
      () => this.tick(),
      Math.min(2_147_483_647, Math.max(0, Math.min(...times) - now)),
    )
  }

  stop(): void {
    this.stopped = true
    this.clock.clearTimeout(this.timer)
    this.timer = undefined
  }

  async drain(): Promise<void> {
    while (this.active.size) await Promise.all([...this.active])
    await this.writing
  }
}
