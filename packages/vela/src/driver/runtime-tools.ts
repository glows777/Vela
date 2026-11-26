import { z } from 'zod'
import type { VelaDatabase } from '../db/index.ts'
import {
  forwardToProjectSession,
  listProjectSessions,
  readProjectSessionMessages,
  recordWaitForInput,
  sendProjectSessionMessage,
  sendSessionFile,
  startProjectSession,
} from '../runtime/control-ops.ts'
import type { RuntimeEventBus } from '../runtime/event-bus.ts'
import type { BlobStore } from '../runtime/index.ts'
import type { SubscriptionManager } from '../runtime/subscriptions.ts'
import type { TimerScheduler } from '../runtime/timers.ts'
import { localRoutineInstant, routineTimezone } from '../shared/routine-time.ts'
import type { ToolContext, ToolDefinition } from './tools/registry.ts'

export interface RuntimeToolDeps {
  db: VelaDatabase
  blobs: BlobStore
  eventBus: RuntimeEventBus
  timers: TimerScheduler
  subscriptions: SubscriptionManager
  scheduleSession: (sessionId: string) => void
  flushOutbox?: () => void
  getRunContext: (sessionId: string) =>
    | {
        runId: string
        projectId: string | null
        replyToMessageId?: string
        handoffDepth?: number
        humanProvenance?: { inboxEventId: string; senderName?: string }
        attachments?: Array<{ blobId: string; name: string; mimeType?: string }>
        markSilent: () => void
      }
    | undefined
}

const recurringSchema = z
  .object({
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    days: z
      .array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']))
      .min(1)
      .optional(),
  })
  .strict()

const routineScheduleSchema = z.union([
  z.object({ at: z.string().min(1) }).strict(),
  recurringSchema,
])

const timersToolSchema = z
  .object({
    action: z.enum(['create', 'list', 'edit', 'cancel']),
    kind: z.enum(['routine', 'followup']).optional(),
    id: z.string().min(1).optional(),
    message: z.string().trim().min(1).optional(),
    schedule: routineScheduleSchema.optional(),
    timezone: z.string().min(1).optional(),
    fire_at: z.string().min(1).optional(),
    delay_seconds: z
      .number()
      .positive()
      .max(30 * 86_400)
      .optional(),
  })
  .strict()

const subscriptionsToolSchema = z
  .object({
    action: z.enum(['create', 'list', 'remove']),
    source: z.string().trim().min(1).max(512).optional(),
    key: z.string().trim().min(1).max(512).optional(),
    id: z.string().trim().min(1).max(512).optional(),
  })
  .strict()

function requireRun(deps: RuntimeToolDeps, ctx?: ToolContext) {
  const sessionId = ctx?.sessionId
  if (!sessionId) throw new Error('Runtime tool requires an active session')
  const run = deps.getRunContext(sessionId)
  if (!run) throw new Error(`No active run found for session ${sessionId}`)
  return { sessionId, ...run }
}

/**
 * Creates the platform-agnostic Runtime control-plane tools (`session_*`, `timers`,
 * `subscriptions`, `wait_for_input`, `send_file`) plus channel-only `skip_reply`.
 */
export function createRuntimeTools(deps: RuntimeToolDeps): ToolDefinition[] {
  const controlCtx = {
    db: deps.db,
    blobs: deps.blobs,
    eventBus: deps.eventBus,
    scheduleSession: deps.scheduleSession,
    flushOutbox: deps.flushOutbox,
  }

  return [
    {
      name: 'session_start',
      executionMode: 'sequential',
      description:
        'Start a new child work or topic session in this project. Supply a short title (<=40 chars) and a clear brief with the requester goal and facts needed. Returns immediately after queuing.',
      inputSchema: z
        .object({
          title: z.string().trim().min(1).max(200),
          brief: z.string().trim().min(1),
        })
        .strict(),
      execute: async (
        { title, brief }: { title: string; brief: string },
        ctx,
      ) => {
        const run = requireRun(deps, ctx)
        return startProjectSession(controlCtx, {
          callerSessionId: run.sessionId,
          callerRunId: run.runId,
          title,
          brief,
          replyToMessageId: run.replyToMessageId,
          attachments: run.attachments,
        })
      },
    },
    {
      name: 'session_forward',
      executionMode: 'sequential',
      description:
        'Forward a request or follow-up message to an existing active child session in this project.',
      inputSchema: z
        .object({
          session_id: z.string().trim().min(1),
          text: z.string().trim().min(1),
        })
        .strict(),
      execute: async (
        { session_id, text }: { session_id: string; text: string },
        ctx,
      ) => {
        const run = requireRun(deps, ctx)
        return forwardToProjectSession(controlCtx, {
          callerSessionId: run.sessionId,
          targetSessionId: session_id,
          text,
          replyToMessageId: run.replyToMessageId,
          humanProvenance: run.humanProvenance,
        })
      },
    },
    {
      name: 'session_list',
      executionMode: 'parallel',
      annotations: { readOnlyHint: true },
      description:
        'List sessions in this project along with their kind, state, and waitingReason.',
      inputSchema: z
        .object({
          include_archived: z.boolean().optional(),
        })
        .strict(),
      execute: async (
        { include_archived }: { include_archived?: boolean },
        ctx,
      ) => {
        const run = requireRun(deps, ctx)
        return {
          sessions: listProjectSessions(deps.db, {
            callerSessionId: run.sessionId,
            includeArchived: include_archived,
          }),
        }
      },
    },
    {
      name: 'session_read',
      executionMode: 'parallel',
      maxResultChars: 20_000,
      annotations: { readOnlyHint: true },
      description:
        'Read visible user and assistant messages from another session in this project.',
      inputSchema: z
        .object({
          session_id: z.string().trim().min(1),
          limit: z.number().int().positive().max(200).optional(),
        })
        .strict(),
      execute: async (
        { session_id, limit }: { session_id: string; limit?: number },
        ctx,
      ) => {
        const run = requireRun(deps, ctx)
        return readProjectSessionMessages(deps.db, {
          callerSessionId: run.sessionId,
          targetSessionId: session_id,
          limit,
        })
      },
    },
    {
      name: 'session_message',
      executionMode: 'sequential',
      description:
        'Send a handoff note to another active session in this project (or target="hub" for the project hub). Enforces a 3-hop depth limit.',
      inputSchema: z
        .object({
          target: z.string().trim().min(1),
          text: z.string().trim().min(1).max(4000),
        })
        .strict(),
      execute: async (
        { target, text }: { target: string; text: string },
        ctx,
      ) => {
        const run = requireRun(deps, ctx)
        return sendProjectSessionMessage(controlCtx, {
          callerSessionId: run.sessionId,
          target,
          text,
          currentHandoffDepth: run.handoffDepth,
        })
      },
    },
    {
      name: 'timers',
      executionMode: 'sequential',
      description:
        'Create, list, edit, or cancel scheduled wake-ups (`routine` with `schedule: { at }` or `{ time, days? }`, max 20/project; or `followup` one-shot self-wake with `fire_at` or `delay_seconds`, max 3 consecutive self-wakes without human input).',
      inputSchema: timersToolSchema,
      execute: async (input: z.infer<typeof timersToolSchema>, ctx) => {
        const run = requireRun(deps, ctx)
        const ownScopeFilter = run.projectId
          ? { projectId: run.projectId }
          : { sessionId: run.sessionId }
        const ownsTimer = (timer: {
          projectId: string | null
          sessionId: string | null
        }) =>
          run.projectId
            ? timer.projectId === run.projectId
            : timer.sessionId === run.sessionId

        if (input.action === 'list') {
          return {
            timezone: routineTimezone(),
            timers: deps.timers.list(ownScopeFilter),
          }
        }
        if (input.action === 'cancel') {
          if (!input.id) throw new Error('id is required to cancel a timer')
          const existing = deps.timers.get(input.id)
          if (!existing || !ownsTimer(existing)) {
            return { id: input.id, cancelled: false }
          }
          return { id: input.id, cancelled: deps.timers.delete(input.id) }
        }
        if (input.action === 'edit') {
          if (!input.id) throw new Error('id is required to edit a timer')
          const existing = deps.timers.get(input.id)
          if (!existing || !ownsTimer(existing)) {
            return { id: input.id, edited: false }
          }
          const hasDeadlinePatch =
            input.fire_at !== undefined || input.delay_seconds !== undefined
          if (
            input.message === undefined &&
            input.schedule === undefined &&
            !hasDeadlinePatch &&
            input.timezone === undefined
          ) {
            throw new Error('Provide a new message, a new schedule, or both')
          }
          if (existing.kind === 'routine' && hasDeadlinePatch) {
            throw new Error(
              'fire_at and delay_seconds only apply to followup timers',
            )
          }
          const zone = routineTimezone(input.timezone ?? existing.timezone)
          let schedule =
            input.schedule === undefined
              ? undefined
              : 'at' in input.schedule
                ? { at: localRoutineInstant(input.schedule.at, zone) }
                : input.schedule
          if (existing.kind === 'followup' && hasDeadlinePatch) {
            const fireAt =
              input.fire_at ??
              new Date(
                Date.now() + (input.delay_seconds as number) * 1000,
              ).toISOString()
            const fireMs = Date.parse(fireAt)
            if (!Number.isFinite(fireMs)) {
              throw new Error(`Invalid followup fire_at timestamp "${fireAt}"`)
            }
            schedule = { at: new Date(fireMs).toISOString() }
          }
          if (existing.kind === 'followup' && schedule && !('at' in schedule)) {
            throw new Error('Followup timers require a single timestamp')
          }
          const updated = deps.timers.update(input.id, {
            message: input.message,
            schedule,
            timezone: input.timezone,
          })
          return updated
            ? { edited: true, timer: updated }
            : { id: input.id, edited: false }
        }

        const kind = input.kind ?? 'routine'
        if (!input.message) {
          throw new Error('message is required to create a timer')
        }
        if (kind === 'followup') {
          const fireAt =
            input.fire_at ??
            (input.delay_seconds !== undefined
              ? new Date(Date.now() + input.delay_seconds * 1000).toISOString()
              : undefined)
          if (!fireAt) {
            throw new Error('followup timers require fire_at or delay_seconds')
          }
          return deps.timers.createFollowup({
            sessionId: run.sessionId,
            projectId: run.projectId,
            message: input.message,
            fireAt,
          })
        }

        if (!input.schedule) {
          throw new Error('routine timers require schedule')
        }
        const zone = routineTimezone(input.timezone)
        const schedule =
          'at' in input.schedule
            ? { at: localRoutineInstant(input.schedule.at, zone) }
            : input.schedule
        return deps.timers.createRoutine({
          projectId: run.projectId,
          sessionId: run.sessionId,
          message: input.message,
          schedule,
          timezone: zone,
        })
      },
    },
    {
      name: 'subscriptions',
      executionMode: 'sequential',
      description:
        'Create, list, or remove external-event subscriptions for this session. Final events automatically remove matching subscriptions after enqueue.',
      inputSchema: subscriptionsToolSchema,
      execute: async (input: z.infer<typeof subscriptionsToolSchema>, ctx) => {
        const run = requireRun(deps, ctx)
        const ownsSub = (sub: {
          projectId: string | null
          sessionId: string
        }) =>
          run.projectId
            ? sub.projectId === run.projectId
            : sub.sessionId === run.sessionId

        if (input.action === 'list') {
          return {
            subscriptions: deps.subscriptions.list(
              run.projectId
                ? { projectId: run.projectId }
                : { sessionId: run.sessionId },
            ),
          }
        }
        if (input.action === 'remove') {
          if (!input.id) {
            throw new Error('id is required to remove a subscription')
          }
          const existing = deps.subscriptions
            .list(
              run.projectId
                ? { projectId: run.projectId }
                : { sessionId: run.sessionId },
            )
            .find((sub) => sub.id === input.id && ownsSub(sub))
          if (!existing) return { id: input.id, removed: false }
          return {
            id: input.id,
            removed: deps.subscriptions.remove(input.id),
          }
        }
        if (!input.source || !input.key) {
          throw new Error(
            'source and key are required to create a subscription',
          )
        }
        return deps.subscriptions.create({
          source: input.source,
          eventKey: input.key,
          projectId: run.projectId,
          sessionId: run.sessionId,
        })
      },
    },
    {
      name: 'wait_for_input',
      executionMode: 'sequential',
      description:
        'Mark this session as waiting for required human input. Supply the reason, then ask one clear question and end the run.',
      inputSchema: z
        .object({ reason: z.string().trim().min(1).max(2000) })
        .strict(),
      execute: async ({ reason }: { reason: string }, ctx) => {
        const run = requireRun(deps, ctx)
        return recordWaitForInput(
          { db: deps.db, eventBus: deps.eventBus },
          { sessionId: run.sessionId, runId: run.runId, reason },
        )
      },
    },
    {
      name: 'send_file',
      executionMode: 'sequential',
      replay: 'unsafe',
      activeByDefault: false,
      description:
        'Snapshot one workspace file to host storage and deliver it to the current conversation (if channel-bound). Supply a workspace-relative path.',
      inputSchema: z.object({ path: z.string().min(1) }).strict(),
      execute: async ({ path }: { path: string }, ctx) => {
        const run = requireRun(deps, ctx)
        if (!ctx?.requireEnv) {
          throw new Error('send_file requires an execution environment')
        }
        const env = await ctx.requireEnv(ctx.signal)
        return sendSessionFile(
          { db: deps.db, blobs: deps.blobs },
          {
            sessionId: run.sessionId,
            runId: run.runId,
            env,
            path,
            signal: ctx.signal,
          },
        )
      },
    },
    {
      name: 'skip_reply',
      channel: true,
      executionMode: 'sequential',
      description:
        'Remain silent for untagged group discussion or a note from another session. Call this when no reply should be posted, then end the run.',
      inputSchema: z.object({}).strict(),
      execute: async (_input: Record<string, never>, ctx) => {
        const run = requireRun(deps, ctx)
        run.markSilent()
        return 'No reply will be sent. End the run.'
      },
    },
  ]
}
