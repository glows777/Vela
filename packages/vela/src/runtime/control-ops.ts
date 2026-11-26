import { basename, isAbsolute, relative, sep, win32 } from 'node:path'
import type { VelaDatabase } from '../db/index.ts'
import type { ExecutionEnv } from '../shared/execution.ts'
import {
  createApprovalRequest,
  listRuntimePendingApprovals,
  resolveWaitForInputOnUserReplyInTx,
} from './approvals.ts'
import type { BlobStore } from './blobs.ts'
import {
  ProjectStore,
  type SessionRecord,
  SessionStoreControl,
} from './domain.ts'
import type { RuntimeEventBus } from './event-bus.ts'
import { enqueueInboxEvent } from './inbox.ts'
import { enqueueOutboxInTx } from './outbox.ts'
import {
  recordChildStatusNoteForHubInTx,
  resolveOutboxTargetInDb,
} from './worker.ts'

const MAX_HANDOFF_DEPTH = 3

const OUTSIDE_WORKSPACE_MSG =
  'Choose a file inside this workspace using a relative path.'

function clipLine(text: string, limit = 200): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > limit ? `${line.slice(0, limit)}…` : line
}

function extractMessageText(contentJson: string): string {
  let parsed: { content?: unknown }
  try {
    parsed = JSON.parse(contentJson) as { content?: unknown }
  } catch {
    return ''
  }
  if (typeof parsed.content === 'string') return parsed.content
  if (!Array.isArray(parsed.content)) return ''
  return parsed.content
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

function requireProjectSession(
  db: VelaDatabase,
  callerSessionId: string,
  action: string,
) {
  const sessions = new SessionStoreControl(db)
  const projects = new ProjectStore(db)
  const caller = sessions.get(callerSessionId)
  if (!caller) throw new Error(`Session ${callerSessionId} not found`)
  if (!caller.projectId) {
    throw new Error(`${action} requires a project session`)
  }
  const project = projects.get(caller.projectId)
  if (!project) throw new Error(`Project ${caller.projectId} not found`)
  return { sessions, projects, caller, project }
}

function resolveRootBindingForCaller(
  db: VelaDatabase,
  projectId: string,
  callerRunId?: string,
): { channel: string; externalId: string } | undefined {
  if (callerRunId) {
    const stored = db.get<{ value_json: string }>(
      'SELECT value_json FROM kv_meta WHERE key = ?',
      `run_target:${callerRunId}`,
    )
    if (stored) {
      try {
        const target = JSON.parse(stored.value_json) as {
          channel?: string
          externalChatId?: string
        }
        if (target.channel && target.externalChatId) {
          const matchingRoot = db.get<{
            channel: string
            external_id: string
          }>(
            `SELECT channel, external_id FROM channel_bindings
             WHERE project_id = ? AND channel = ? AND external_id = ? AND thread_id IS NULL AND enabled = 1
             ORDER BY created_at ASC LIMIT 1`,
            projectId,
            target.channel,
            target.externalChatId,
          )
          if (matchingRoot) {
            return {
              channel: matchingRoot.channel,
              externalId: matchingRoot.external_id,
            }
          }
        }
      } catch {
        /* fall back to project root binding */
      }
    }
  }
  const fallback = db.get<{ channel: string; external_id: string }>(
    `SELECT channel, external_id FROM channel_bindings
     WHERE project_id = ? AND thread_id IS NULL AND enabled = 1
     ORDER BY created_at ASC LIMIT 1`,
    projectId,
  )
  return fallback
    ? { channel: fallback.channel, externalId: fallback.external_id }
    : undefined
}

export function getActiveChannelForSession(
  db: VelaDatabase,
  sessionId: string,
  callerRunId?: string,
): string | undefined {
  if (callerRunId) {
    const stored = db.get<{ value_json: string }>(
      'SELECT value_json FROM kv_meta WHERE key = ?',
      `run_target:${callerRunId}`,
    )
    if (stored) {
      try {
        const parsed = JSON.parse(stored.value_json) as { channel?: unknown }
        if (typeof parsed.channel === 'string' && parsed.channel) {
          return parsed.channel
        }
      } catch {
        /* fall back to persisted bindings */
      }
    }
  }
  const sessions = new SessionStoreControl(db)
  const session = sessions.get(sessionId)
  if (!session) return undefined
  const direct = db.get<{ channel: string }>(
    `SELECT channel FROM channel_bindings WHERE session_id = ? AND enabled = 1 ORDER BY rowid DESC LIMIT 1`,
    sessionId,
  )
  if (direct) return direct.channel
  if (session.projectId && session.kind === 'hub') {
    const root = db.get<{ channel: string }>(
      `SELECT channel FROM channel_bindings
       WHERE project_id = ? AND thread_id IS NULL AND enabled = 1
       ORDER BY rowid DESC LIMIT 1`,
      session.projectId,
    )
    if (root) return root.channel
  }
  return undefined
}

export interface ControlOpsContext {
  db: VelaDatabase
  blobs: BlobStore
  eventBus: RuntimeEventBus
  scheduleSession: (sessionId: string) => void
  flushOutbox?: () => void
}

export async function startProjectSession(
  ctx: ControlOpsContext,
  input: {
    callerSessionId: string
    callerRunId?: string
    title: string
    brief: string
    replyToMessageId?: string
    attachments?: Array<{ blobId: string; name: string; mimeType?: string }>
  },
): Promise<{ sessionId: string; kind: 'topic' | 'work'; title: string }> {
  const title = input.title.trim()
  const brief = input.brief.trim()
  if (!title) throw new Error('title must not be empty')
  if (!brief) throw new Error('brief must not be empty')

  const { sessions, caller, project } = requireProjectSession(
    ctx.db,
    input.callerSessionId,
    'session_start',
  )
  if (project.hubSessionId && project.hubSessionId !== caller.id) {
    throw new Error('Only the project hub session can start child sessions')
  }

  const rootBinding = resolveRootBindingForCaller(
    ctx.db,
    project.id,
    input.callerRunId,
  )
  const childKind: 'topic' | 'work' = rootBinding ? 'topic' : 'work'

  const clonedAttachments: Array<{
    blobId: string
    name: string
    mimeType?: string
  }> = []
  let child: SessionRecord
  try {
    if (input.attachments?.length) {
      for (const att of input.attachments) {
        const cloned = await ctx.blobs.cloneForSession(
          att.blobId,
          null,
          project.id,
          caller.id,
        )
        clonedAttachments.push({
          blobId: cloned.id,
          name: att.name,
          ...(att.mimeType ? { mimeType: att.mimeType } : {}),
        })
      }
    }

    child = ctx.db.transaction(() => {
      const created = sessions.create({
        projectId: project.id,
        kind: childKind,
        name: title,
        parentSessionId: caller.id,
      })

      if (clonedAttachments.length > 0) {
        ctx.blobs.bindSession(
          clonedAttachments.map((a) => a.blobId),
          created.id,
        )
      }

      enqueueInboxEvent(ctx.db, {
        sessionId: created.id,
        projectId: project.id,
        source: 'session',
        wake: true,
        payload: {
          type: 'session_start',
          title,
          text: brief,
          callerSessionId: caller.id,
          ...(clonedAttachments.length
            ? { attachments: clonedAttachments }
            : {}),
        },
      })

      if (rootBinding) {
        enqueueOutboxInTx(ctx.db, {
          sessionId: created.id,
          channel: rootBinding.channel,
          externalChatId: rootBinding.externalId,
          replyToMessageId: input.replyToMessageId,
          kind: 'topic_start',
          text: title,
          title,
        })
      }
      return created
    })
  } catch (error) {
    for (const att of clonedAttachments) {
      await ctx.blobs.deleteBlob(att.blobId).catch(() => {})
    }
    throw error
  }

  if (rootBinding && ctx.flushOutbox) {
    ctx.flushOutbox()
  } else {
    ctx.scheduleSession(child.id)
  }
  return { sessionId: child.id, kind: childKind, title }
}

export function forwardToProjectSession(
  ctx: ControlOpsContext,
  input: {
    callerSessionId: string
    targetSessionId: string
    text: string
    replyToMessageId?: string
    humanProvenance?: { inboxEventId: string; senderName?: string }
  },
): { sessionId: string; forwarded: true } {
  const text = input.text.trim()
  if (!text) throw new Error('text must not be empty')

  const { sessions, caller, project } = requireProjectSession(
    ctx.db,
    input.callerSessionId,
    'session_forward',
  )
  if (project.hubSessionId && project.hubSessionId !== caller.id) {
    throw new Error(
      'Only the project hub session can forward to child sessions',
    )
  }
  if (input.targetSessionId === caller.id) {
    throw new Error('Cannot forward a session to itself')
  }
  const target = sessions.get(input.targetSessionId)
  if (!target || target.projectId !== project.id || target.archived) {
    throw new Error(
      `Session ${input.targetSessionId} is not an active session in this project`,
    )
  }

  const targetBinding = ctx.db.get<{
    channel: string
    external_id: string
    thread_id: string | null
  }>(
    `SELECT channel, external_id, thread_id FROM channel_bindings
     WHERE session_id = ? AND enabled = 1
     ORDER BY created_at ASC LIMIT 1`,
    target.id,
  )

  ctx.db.transaction(() => {
    if (target.state === 'waiting_human') {
      const pending = listRuntimePendingApprovals(ctx.db, target.id)
      const verifiedHuman =
        input.humanProvenance &&
        Boolean(
          ctx.db.get<{ id: string }>(
            `SELECT id FROM inbox_events
             WHERE id = ? AND session_id = ? AND source IN ('user', 'channel') AND passive = 0
             LIMIT 1`,
            input.humanProvenance.inboxEventId,
            caller.id,
          ),
        )
      if (
        !verifiedHuman ||
        pending.some((a) => a.toolName !== 'wait_for_input')
      ) {
        throw new Error(
          `Session ${target.id} is waiting for human input or tool approval and cannot accept a forwarded message`,
        )
      }
      resolveWaitForInputOnUserReplyInTx(ctx.db, ctx.eventBus, {
        sessionId: target.id,
        replyText: text,
        decidedBy: input.humanProvenance?.senderName,
      })
    }

    enqueueInboxEvent(ctx.db, {
      sessionId: target.id,
      projectId: project.id,
      source: targetBinding ? 'channel' : 'session',
      wake: true,
      payload: {
        type: 'session_forward',
        text,
        callerSessionId: caller.id,
        ...(targetBinding
          ? {
              channel: targetBinding.channel,
              externalChatId: targetBinding.external_id,
              ...(targetBinding.thread_id
                ? { threadId: targetBinding.thread_id }
                : {}),
            }
          : {}),
      },
    })
    if (targetBinding?.thread_id) {
      enqueueOutboxInTx(ctx.db, {
        sessionId: target.id,
        channel: targetBinding.channel,
        externalChatId: targetBinding.external_id,
        threadId: targetBinding.thread_id,
        replyToMessageId: input.replyToMessageId,
        forwardMessageId: input.replyToMessageId,
        kind: 'forward',
        text,
      })
    }
  })

  ctx.scheduleSession(target.id)
  return { sessionId: target.id, forwarded: true }
}

export function listProjectSessions(
  db: VelaDatabase,
  input: { callerSessionId: string; includeArchived?: boolean },
): Array<{
  id: string
  kind: SessionRecord['kind']
  name: string | null
  state: SessionRecord['state']
  waitingReason: string | null
  updatedAt: string
}> {
  const { sessions, project } = requireProjectSession(
    db,
    input.callerSessionId,
    'session_list',
  )
  return sessions
    .list({ projectId: project.id, includeArchived: input.includeArchived })
    .map((session) => ({
      id: session.id,
      kind: session.kind,
      name: session.name,
      state: session.state,
      waitingReason: session.waitingReason,
      updatedAt: session.updatedAt,
    }))
}

export function readProjectSessionMessages(
  db: VelaDatabase,
  input: { callerSessionId: string; targetSessionId: string; limit?: number },
): {
  sessionId: string
  name: string | null
  state: SessionRecord['state']
  messages: Array<{ id: string; role: string; text: string; createdAt: string }>
} {
  const { sessions, project } = requireProjectSession(
    db,
    input.callerSessionId,
    'session_read',
  )
  const target = sessions.get(input.targetSessionId)
  if (!target || target.projectId !== project.id) {
    throw new Error(
      `Session ${input.targetSessionId} does not belong to this project`,
    )
  }
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200))
  const rows = target.leafMessageId
    ? db.all<{
        id: string
        role: string | null
        content_json: string
        created_at: string
      }>(
        `WITH RECURSIVE branch(id, parent_id, seq, kind, role, content_json, created_at, path) AS (
           SELECT id, parent_id, seq, kind, role, content_json, created_at, ',' || id || ','
           FROM vela_messages
           WHERE session_id = ? AND id = ?
           UNION ALL
           SELECT m.id, m.parent_id, m.seq, m.kind, m.role, m.content_json, m.created_at, b.path || m.id || ','
           FROM vela_messages m
           JOIN branch b ON m.id = b.parent_id
           WHERE m.session_id = ? AND instr(b.path, ',' || m.id || ',') = 0
         )
         SELECT id, role, content_json, created_at
         FROM branch
         WHERE kind = 'message' AND role IN ('user', 'assistant')
         ORDER BY seq ASC`,
        target.id,
        target.leafMessageId,
        target.id,
      )
    : []
  const sliced = rows.slice(-limit)
  return {
    sessionId: target.id,
    name: target.name,
    state: target.state,
    messages: sliced.map((row) => ({
      id: row.id,
      role: row.role ?? 'user',
      text: extractMessageText(row.content_json),
      createdAt: row.created_at,
    })),
  }
}

export function sendProjectSessionMessage(
  ctx: ControlOpsContext,
  input: {
    callerSessionId: string
    target: string
    text: string
    currentHandoffDepth?: number
  },
): {
  queued: true
  target: { id: string; name: string | null; state: SessionRecord['state'] }
} {
  const text = input.text.trim()
  if (!text) throw new Error('text must not be empty')
  const nextDepth = (input.currentHandoffDepth ?? 0) + 1
  if (nextDepth > MAX_HANDOFF_DEPTH) {
    throw new Error(
      'Hand-off chain limit reached: tell the requester in your reply instead',
    )
  }

  const { sessions, caller, project } = requireProjectSession(
    ctx.db,
    input.callerSessionId,
    'session_message',
  )
  const targetId =
    input.target === 'hub' ? project.hubSessionId : input.target.trim()
  if (!targetId) {
    throw new Error('This project has no hub session to message')
  }
  const target = sessions.get(targetId)
  if (!target || target.projectId !== project.id || target.archived) {
    throw new Error(`${input.target} is not an active session in this project`)
  }
  if (target.id === caller.id) {
    throw new Error('A session cannot message itself')
  }

  const callerLabel = caller.name
    ? `session "${caller.name}" (${caller.id})`
    : `${caller.kind} session (${caller.id})`

  ctx.db.transaction(() => {
    enqueueInboxEvent(ctx.db, {
      sessionId: target.id,
      projectId: project.id,
      source: 'handoff',
      wake: true,
      payload: {
        type: 'handoff',
        fromSessionId: caller.id,
        fromName: caller.name ?? caller.kind,
        handoffDepth: nextDepth,
        text: `Message from Vela's ${callerLabel} (not from a person):\n${text}`,
      },
    })
    if (
      project.hubSessionId &&
      caller.id !== project.hubSessionId &&
      target.id !== project.hubSessionId
    ) {
      const targetLabel = target.name
        ? `session "${target.name}" (${target.id})`
        : `${target.kind} session (${target.id})`
      enqueueInboxEvent(ctx.db, {
        sessionId: project.hubSessionId,
        projectId: project.id,
        source: 'handoff',
        wake: false,
        payload: {
          type: 'handoff_note',
          text: `${callerLabel} → ${targetLabel}: ${clipLine(text)}`,
        },
      })
    }
  })

  ctx.scheduleSession(target.id)
  return {
    queued: true,
    target: { id: target.id, name: target.name, state: target.state },
  }
}

export function recordWaitForInput(
  ctx: Pick<ControlOpsContext, 'db' | 'eventBus'>,
  input: { sessionId: string; runId: string; reason: string },
): { approvalId: string; reason: string; instruction: string } {
  const reason = input.reason.trim()
  if (!reason) throw new Error('reason must not be empty')
  const session = new SessionStoreControl(ctx.db).get(input.sessionId)
  if (!session) throw new Error(`Session ${input.sessionId} not found`)
  const approval = createApprovalRequest(ctx.db, ctx.eventBus, {
    sessionId: input.sessionId,
    projectId: session.projectId,
    runId: input.runId,
    toolCallRowId: null,
    toolCallId: null,
    toolName: 'wait_for_input',
    summary: reason,
    input: { reason },
  })
  return {
    approvalId: approval.id,
    reason,
    instruction: 'Ask the question and end the run.',
  }
}

export async function sendSessionFile(
  ctx: Pick<ControlOpsContext, 'db' | 'blobs'>,
  input: {
    sessionId: string
    runId?: string
    env: ExecutionEnv
    path: string
    signal?: AbortSignal
  },
): Promise<{
  blobId: string
  filename: string
  sizeBytes: number
  deliveredViaOutbox: boolean
}> {
  const filePath = input.path
  if (
    !filePath ||
    isAbsolute(filePath) ||
    win32.isAbsolute(filePath) ||
    filePath.split(/[\\/]/).includes('..') ||
    /\p{Cc}/u.test(filePath)
  ) {
    throw new Error(OUTSIDE_WORKSPACE_MSG)
  }

  const rootRes = await input.env.canonicalPath(input.env.cwd, input.signal)
  if (!rootRes.ok) throw rootRes.error
  const joinedRes = await input.env.joinPath(
    [rootRes.value, filePath],
    input.signal,
  )
  if (!joinedRes.ok) throw joinedRes.error
  const resolvedRes = await input.env.canonicalPath(
    joinedRes.value,
    input.signal,
  )
  if (!resolvedRes.ok) {
    if (resolvedRes.error.code === 'not_found') {
      throw new Error(`${basename(filePath)} was not found in this workspace.`)
    }
    throw resolvedRes.error
  }
  const within = relative(rootRes.value, resolvedRes.value)
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    throw new Error(OUTSIDE_WORKSPACE_MSG)
  }

  const session = new SessionStoreControl(ctx.db).get(input.sessionId)
  if (!session) throw new Error(`Session ${input.sessionId} not found`)

  const blob = await ctx.blobs.storeOutboundFromEnv({
    sessionId: session.id,
    projectId: session.projectId,
    env: input.env,
    sourcePath: resolvedRes.value,
    filename: basename(filePath),
    signal: input.signal,
  })
  if (blob.sizeBytes === 0) {
    await ctx.blobs.deleteBlob(blob.id)
    throw new Error(`${blob.filename} is empty. Choose a nonempty file.`)
  }

  const outboxTarget = resolveOutboxTargetInDb(ctx.db, session, [], input.runId)
  if (outboxTarget) {
    enqueueOutboxInTx(ctx.db, {
      sessionId: session.id,
      runId: input.runId ?? null,
      channel: outboxTarget.channel,
      externalChatId: outboxTarget.externalChatId,
      threadId: outboxTarget.threadId,
      replyToMessageId: outboxTarget.replyToMessageId,
      kind: 'file',
      text: '',
      files: [
        {
          path: blob.storagePath,
          name: blob.filename,
          ...(blob.mimeType ? { mimeType: blob.mimeType } : {}),
        },
      ],
    })
  }

  return {
    blobId: blob.id,
    filename: blob.filename,
    sizeBytes: blob.sizeBytes,
    deliveredViaOutbox: Boolean(outboxTarget),
  }
}

export function stopSessionRunsInDb(
  db: VelaDatabase,
  session: SessionRecord | undefined,
  sessionId: string,
  reason: string,
): boolean {
  const now = new Date().toISOString()
  return db.transaction(() => {
    const rows = db.all<{ id: string }>(
      `SELECT id FROM runs
       WHERE session_id = ? AND status IN ('queued', 'running', 'waiting_human')`,
      sessionId,
    )
    const updated = db.run(
      `UPDATE runs SET status = 'stopped', finished_at = COALESCE(finished_at, ?), updated_at = ?
       WHERE session_id = ? AND status IN ('queued', 'running', 'waiting_human')`,
      now,
      now,
      sessionId,
    )
    for (const r of rows) {
      db.run(
        `UPDATE vela_tool_calls SET status = 'interrupted', updated_at = ?
         WHERE run_id = ? AND status IN ('pending', 'running', 'awaiting_approval')`,
        now,
        r.id,
      )
      db.run(
        'DELETE FROM kv_meta WHERE key IN (?, ?, ?, ?, ?)',
        `run_target:${r.id}`,
        `stop_requested:${r.id}`,
        `run_silent:${r.id}`,
        `run_handoff_depth:${r.id}`,
        `run_input_meta:${r.id}`,
      )
    }
    db.run(
      `UPDATE sessions SET state = 'idle', waiting_reason = NULL, updated_at = ?
       WHERE id = ? AND state IN ('running', 'waiting_human')`,
      now,
      sessionId,
    )
    const latestStoppedRun = rows.at(-1)
    if (session && latestStoppedRun) {
      recordChildStatusNoteForHubInTx(
        db,
        { session, runId: latestStoppedRun.id, inputs: [] },
        'stopped',
        reason,
      )
    }
    return updated.changes > 0
  })
}
