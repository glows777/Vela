import { Buffer } from 'node:buffer'
import type {
  LocalVelaRuntime,
  RuntimeEvent,
} from '@glows777/vela/legacy-desktop'
import type { Message, Request } from '../shared/bridge.ts'

type RuntimeMessageRecord = Awaited<
  ReturnType<LocalVelaRuntime['sessions']['messages']>
>['messages'][number]

export type BridgedMessage = {
  id: string
  sessionId: string
  runId: string | null
  kind: string
  role: 'user' | 'assistant' | 'tool' | 'system' | null
  text: string
  content: unknown
  senderName?: string
  display?: boolean
  createdAt: string
}

export function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (part): part is { type: string; text: string } =>
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text)
    .join('\n')
}

export function formatFailedTaskReply(
  error: string,
  errorHint?: string,
): string {
  return errorHint
    ? `Task failed: ${error}\n\n${errorHint}`
    : `Task failed: ${error}`
}

export function toDesktopMessage(
  msg: BridgedMessage,
  clientMessageId?: string,
): Message | undefined {
  if (msg.role === 'tool' || !msg.role) return undefined
  if (msg.role === 'system' && msg.display !== true) return undefined
  if (msg.kind === 'custom_message' && msg.display !== true) return undefined
  if (!msg.text && msg.role === 'assistant') return undefined
  return {
    id: msg.id,
    sessionId: msg.sessionId,
    role: msg.role,
    text: msg.text,
    createdAt: msg.createdAt,
    ...(msg.senderName ? { senderName: msg.senderName } : {}),
    ...(clientMessageId ? { clientMessageId } : {}),
  }
}

/**
 * Tracks optimistic `clientMessageId` tokens across batched Runtime `inbox_events`
 * (`prompt`), active task steering (`steer`), and committed messages.
 */
export class DesktopClientIdTracker {
  private readonly byInboxId = new Map<string, string>()
  private readonly runIdByInboxId = new Map<string, string>()
  private readonly inboxIdsByRunId = new Map<string, string[]>()
  private readonly bySteerText = new Map<
    string,
    Array<{ text: string; clientMessageId: string }>
  >()
  private readonly byRunId = new Map<string, string[]>()
  private readonly byMessageId = new Map<string, string>()

  trackPrompt(inboxEventId: string, clientMessageId: string): void {
    const existingRunId = this.runIdByInboxId.get(inboxEventId)
    if (existingRunId) {
      this.runIdByInboxId.delete(inboxEventId)
      const list = this.byRunId.get(existingRunId) ?? []
      list.push(clientMessageId)
      this.byRunId.set(existingRunId, list)
      return
    }
    this.byInboxId.set(inboxEventId, clientMessageId)
  }

  trackSteer(
    sessionId: string,
    text: string,
    clientMessageId: string,
  ): () => void {
    const queue = this.bySteerText.get(sessionId) ?? []
    const entry = { text, clientMessageId }
    queue.push(entry)
    this.bySteerText.set(sessionId, queue)
    return () => {
      const current = this.bySteerText.get(sessionId)
      if (!current) return
      const idx = current.indexOf(entry)
      if (idx >= 0) current.splice(idx, 1)
      if (current.length === 0) this.bySteerText.delete(sessionId)
    }
  }

  onRunStarted(runId: string, inboxEventIds?: readonly string[]): void {
    if (!inboxEventIds?.length) return
    const ids: string[] = []
    const trackedInboxIds = this.inboxIdsByRunId.get(runId) ?? []
    for (const inboxId of inboxEventIds) {
      const clientId = this.byInboxId.get(inboxId)
      if (clientId) {
        this.byInboxId.delete(inboxId)
        ids.push(clientId)
      } else {
        this.runIdByInboxId.set(inboxId, runId)
        trackedInboxIds.push(inboxId)
      }
    }
    if (trackedInboxIds.length > 0) {
      this.inboxIdsByRunId.set(runId, trackedInboxIds)
    }
    if (ids.length > 0) {
      const prev = this.byRunId.get(runId) ?? []
      this.byRunId.set(runId, [...prev, ...ids])
    }
  }

  private cleanupRunInboxIndex(runId: string): void {
    const inboxIds = this.inboxIdsByRunId.get(runId)
    if (!inboxIds) return
    this.inboxIdsByRunId.delete(runId)
    for (const inboxId of inboxIds) {
      this.runIdByInboxId.delete(inboxId)
    }
  }

  consumeForUserMessage(
    sessionId: string,
    runId: string | null,
    text: string,
    messageId: string,
  ): string[] {
    let ids: string[] = []
    if (runId) {
      this.cleanupRunInboxIndex(runId)
      const batched = this.byRunId.get(runId)
      if (batched?.length) {
        this.byRunId.delete(runId)
        ids = batched
      }
    }
    if (ids.length === 0) {
      const queue = this.bySteerText.get(sessionId)
      const idx = queue?.findIndex((q) => q.text === text) ?? -1
      if (queue && idx >= 0) {
        ids = [queue.splice(idx, 1)[0]!.clientMessageId]
        if (queue.length === 0) this.bySteerText.delete(sessionId)
      }
    }
    if (ids[0]) {
      this.byMessageId.set(messageId, ids[0])
    }
    return ids
  }

  onRunFinished(runId: string): void {
    this.cleanupRunInboxIndex(runId)
    this.byRunId.delete(runId)
  }

  getForMessage(messageId: string): string | undefined {
    return this.byMessageId.get(messageId)
  }

  clear(): void {
    this.byInboxId.clear()
    this.runIdByInboxId.clear()
    this.inboxIdsByRunId.clear()
    this.bySteerText.clear()
    this.byRunId.clear()
    this.byMessageId.clear()
  }
}

interface LocalHistoryCursorV2 {
  msgCursor: string | null
  failAt?: { createdAt: string; id: string } | null
}

const V2_CURSOR_PREFIX = 'v2:'

function decodeLocalHistoryCursor(after?: string): LocalHistoryCursorV2 {
  if (!after) return { msgCursor: '' }
  if (after.startsWith(V2_CURSOR_PREFIX)) {
    try {
      const parsed = JSON.parse(
        Buffer.from(after.slice(V2_CURSOR_PREFIX.length), 'base64url').toString(
          'utf8',
        ),
      ) as Partial<LocalHistoryCursorV2>
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed.msgCursor === null || typeof parsed.msgCursor === 'string')
      ) {
        return {
          msgCursor: parsed.msgCursor,
          failAt: parsed.failAt,
        }
      }
    } catch {
      // Fall through to invalid cursor error below.
    }
    throw new Error('Invalid local history cursor')
  }
  if (after.startsWith('db:')) {
    return { msgCursor: after.slice(3), failAt: null }
  }
  return { msgCursor: after, failAt: null }
}

function encodeLocalHistoryCursor(cursor: LocalHistoryCursorV2): string {
  return `${V2_CURSOR_PREFIX}${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`
}

function compareMessagesChronological(
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
): number {
  return a.createdAt === b.createdAt
    ? a.id.localeCompare(b.id)
    : a.createdAt.localeCompare(b.createdAt)
}

async function listAllSessionFailureMessages(
  runtime: LocalVelaRuntime,
  sessionId: string,
  afterFailAt?: { createdAt: string; id: string } | null,
): Promise<Message[]> {
  if (afterFailAt === null) return []
  const byId = new Map<string, Message>()
  let afterSeq: number | undefined
  while (true) {
    const page: RuntimeEvent[] = await runtime.events
      .list({
        sessionId,
        ...(afterSeq !== undefined ? { afterSeq } : {}),
        limit: 200,
      })
      .catch(() => [])
    for (const evt of page) {
      if (evt.type === 'session_reset') {
        byId.clear()
        continue
      }
      if (
        evt.type === 'run_finished' &&
        (evt.status === 'failed' || evt.status === 'interrupted') &&
        evt.error
      ) {
        const id = `failed-${evt.runId}`
        const item: Message = {
          id,
          sessionId,
          role: 'assistant',
          text: formatFailedTaskReply(evt.error, evt.errorHint),
          createdAt: evt.timestamp,
        }
        if (
          !afterFailAt ||
          compareMessagesChronological(item, afterFailAt) > 0
        ) {
          byId.set(id, item)
        }
      }
    }
    if (page.length < 200) break
    const lastSeq = page.at(-1)?.seq
    if (lastSeq === undefined) break
    afterSeq = lastSeq
  }
  return [...byId.values()].sort(compareMessagesChronological)
}

async function assertLocalSessionInProject(
  runtime: LocalVelaRuntime,
  projectId: string,
  sessionId: string,
): Promise<void> {
  const bindings = await runtime.bindings.list({ channel: 'lark' })
  const larkProjectIds = new Set(
    bindings.map((b) => b.projectId).filter((id): id is string => Boolean(id)),
  )
  const project = await runtime.projects.get(projectId)
  if (!project || project.archived || larkProjectIds.has(project.id)) {
    throw new Error(`Unknown project ${projectId}`)
  }
  const session = await runtime.sessions.get(sessionId)
  if (
    !session ||
    (session.projectId !== project.id && session.id !== project.hubSessionId)
  ) {
    throw new Error(
      `Session ${sessionId} does not belong to project ${projectId}`,
    )
  }
}

/**
 * Fetches paginated Local conversation history combining persisted `vela_messages`
 * and failed-run error replies across arbitrary page sizes and event counts.
 */
export async function fetchLocalDesktopMessages(
  runtime: LocalVelaRuntime,
  input: Extract<Request, { method: 'messages' }>['input'],
  clientIdsByMessage:
    | ReadonlyMap<string, string>
    | Pick<DesktopClientIdTracker, 'getForMessage'>,
): Promise<{ messages: Message[]; nextCursor?: string }> {
  await assertLocalSessionInProject(runtime, input.projectId, input.sessionId)

  const getClientId = (messageId: string) =>
    clientIdsByMessage instanceof Map
      ? clientIdsByMessage.get(messageId)
      : 'getForMessage' in clientIdsByMessage
        ? clientIdsByMessage.getForMessage(messageId)
        : (clientIdsByMessage as ReadonlyMap<string, string>).get(messageId)

  const decoded = decodeLocalHistoryCursor(input.after)
  const want = Math.max(1, input.limit ?? 100)

  const visibleMsgs: Array<{ msg: Message; seq: number }> = []
  let msgCursor: string | undefined =
    decoded.msgCursor === null
      ? undefined
      : decoded.msgCursor === ''
        ? undefined
        : decoded.msgCursor
  let reachedDbEnd = decoded.msgCursor === null
  while (!reachedDbEnd && visibleMsgs.length <= want) {
    const page = await runtime.sessions.messages({
      sessionId: input.sessionId,
      cursor: msgCursor,
      limit: Math.max(want - visibleMsgs.length + 1, 20),
    })
    for (const row of page.messages as RuntimeMessageRecord[]) {
      const mapped = toDesktopMessage(row, getClientId(row.id))
      if (mapped) {
        visibleMsgs.push({ msg: mapped, seq: row.seq })
      }
    }
    if (!page.nextCursor) {
      reachedDbEnd = true
      break
    }
    msgCursor = page.nextCursor
  }

  const failures = await listAllSessionFailureMessages(
    runtime,
    input.sessionId,
    decoded.failAt,
  )

  const collected: Message[] = []
  let mi = 0
  let fi = 0
  let lastEmittedMsgSeq: number | undefined
  let lastEmittedFailAt: { createdAt: string; id: string } | undefined

  while (
    collected.length < want &&
    (mi < visibleMsgs.length || fi < failures.length)
  ) {
    const nextMsg = visibleMsgs[mi]
    const nextFail = failures[fi]
    if (
      nextMsg &&
      (!nextFail || compareMessagesChronological(nextMsg.msg, nextFail) <= 0)
    ) {
      collected.push(nextMsg.msg)
      lastEmittedMsgSeq = nextMsg.seq
      mi += 1
    } else if (nextFail) {
      collected.push(nextFail)
      lastEmittedFailAt = { createdAt: nextFail.createdAt, id: nextFail.id }
      fi += 1
    }
  }

  const hasMoreMsgs = mi < visibleMsgs.length || !reachedDbEnd
  const hasMoreFails = fi < failures.length
  if (!hasMoreMsgs && !hasMoreFails) {
    return { messages: collected }
  }

  const nextCursor: LocalHistoryCursorV2 = {
    msgCursor: hasMoreMsgs
      ? lastEmittedMsgSeq !== undefined
        ? String(lastEmittedMsgSeq)
        : decoded.msgCursor
      : null,
    failAt: hasMoreFails
      ? (lastEmittedFailAt ?? decoded.failAt ?? undefined)
      : null,
  }

  return {
    messages: collected,
    nextCursor: encodeLocalHistoryCursor(nextCursor),
  }
}
