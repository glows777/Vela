import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { VelaDatabase } from '../db/index.ts'
import { silentLogger, type VelaLogger } from '../shared/logger.ts'
import {
  type ApprovalRecord,
  cancelPendingApprovalsForSession,
  createApprovalRequest,
  listRuntimePendingApprovals,
  resolveRuntimeApproval,
} from './approvals.ts'
import { BackgroundJobManager } from './background-jobs.ts'
import { BlobStore } from './blobs.ts'
import type {
  ChannelAdapter,
  ChannelBinding,
  ChannelInboundMessage,
} from './channels.ts'
import {
  ChannelBindingStore,
  ProjectStore,
  type SessionRecord,
  SessionStoreControl,
} from './domain.ts'
import type { AgentDriver, DriverTurnResult } from './driver.ts'
import { EnvironmentRegistry } from './environments.ts'
import {
  RuntimeEventBus,
  type RuntimeEventListener,
  type StreamDeltaListener,
} from './event-bus.ts'
import type { RunEndStatus, RuntimeEvent, StreamDeltaEvent } from './events.ts'
import { enqueueInboxEvent, type InboxEventRecord } from './inbox.ts'
import { OutboxDispatcher } from './outbox.ts'
import {
  type ControlShortcut,
  executeControlShortcut,
  parseControlShortcut,
} from './shortcuts.ts'
import { SubscriptionManager } from './subscriptions.ts'
import { TimerScheduler } from './timers.ts'
import {
  claimNextTurnInDb,
  commitCompletedTurnInTx,
  finalizeTurnInDb,
  recoverRuntimeState,
  resolveOutboxTargetInDb,
} from './worker.ts'

export interface VelaRuntimeEngineOptions {
  db: VelaDatabase
  agentDir: string
  environments?: EnvironmentRegistry
  drivers?: AgentDriver[]
  logger?: VelaLogger
}

interface ActiveWorker {
  runId: string
  ownerToken: string
  controller: AbortController
  promise: Promise<void>
}

/**
 * Agent-agnostic Runtime control plane over a single `<agentDir>/vela.db`.
 * Coordinates `Project` / `Session` / `ChannelBinding`, single-active per-session workers,
 * `inbox_events` ingress, `approvals` suspension, `outbox`, `timers`, `subscriptions`,
 * `background_jobs`, `blobs`, and direct `!` control shortcuts.
 */
export class VelaRuntimeEngine {
  readonly db: VelaDatabase
  readonly agentDir: string
  readonly blobs: BlobStore
  readonly environments: EnvironmentRegistry
  readonly projects: ProjectStore
  readonly sessions: SessionStoreControl
  readonly bindings: ChannelBindingStore
  readonly eventBus: RuntimeEventBus
  readonly outbox: OutboxDispatcher
  readonly timers: TimerScheduler
  readonly subscriptions: SubscriptionManager
  readonly backgroundJobs: BackgroundJobManager

  private readonly logger: VelaLogger
  private readonly drivers = new Map<string, AgentDriver>()
  private readonly channels = new Map<string, ChannelAdapter>()
  private readonly activeWorkers = new Map<string, ActiveWorker>()
  private readonly activeOwners = new Set<string>()
  private readonly transientBlobDir?: string
  private disposed = false

  constructor(options: VelaRuntimeEngineOptions) {
    this.db = options.db
    this.agentDir = resolve(options.agentDir)
    this.logger = options.logger ?? silentLogger
    if (options.db.path === ':memory:') {
      this.transientBlobDir = mkdtempSync(join(tmpdir(), 'vela-blobs-'))
      this.blobs = new BlobStore(this.db, join(this.transientBlobDir, 'blobs'))
    } else {
      this.blobs = new BlobStore(this.db, join(this.agentDir, 'blobs'))
    }
    this.environments =
      options.environments ??
      new EnvironmentRegistry({ dataDir: this.agentDir })
    this.projects = new ProjectStore(this.db)
    this.sessions = new SessionStoreControl(this.db)
    this.bindings = new ChannelBindingStore(this.db)
    this.eventBus = new RuntimeEventBus(this.db)
    this.outbox = new OutboxDispatcher(this.db, (name) =>
      this.channels.get(name),
    )
    this.timers = new TimerScheduler(this.db, (sessionId) =>
      this.scheduleSession(sessionId),
    )
    this.subscriptions = new SubscriptionManager(this.db, (sessionId) =>
      this.scheduleSession(sessionId),
    )
    this.backgroundJobs = new BackgroundJobManager(this.db, (sessionId) =>
      this.scheduleSession(sessionId),
    )
    for (const driver of options.drivers ?? []) {
      this.registerDriver(driver)
    }
  }

  registerDriver(driver: AgentDriver): void {
    this.drivers.set(driver.name, driver)
  }

  getDriver(name: string): AgentDriver | undefined {
    return this.drivers.get(name)
  }

  async registerChannel(adapter: ChannelAdapter): Promise<void> {
    if (this.disposed) throw new Error('Runtime has been disposed')
    const existing = this.channels.get(adapter.name)
    if (existing) {
      await existing.stop()
    }
    this.channels.set(adapter.name, adapter)
    await adapter.start({
      ingest: (message) => this.ingestChannelMessage(adapter, message),
    })
  }

  async unregisterChannel(name: string): Promise<void> {
    const existing = this.channels.get(name)
    if (!existing) return
    this.channels.delete(name)
    await existing.stop()
  }

  channelAdapter(name: string): ChannelAdapter | undefined {
    return this.channels.get(name)
  }

  /** Submits a user prompt (or queued steering/handoff/note) into `inbox_events` and wakes the worker. */
  submitPrompt(input: {
    sessionId: string
    text: string
    dedupeKey?: string
    source?: 'user' | 'handoff' | 'session'
    wake?: boolean
    passive?: boolean
    attachments?: Array<{ blobId: string; name: string; mimeType?: string }>
    metadata?: Record<string, unknown>
  }): { event: InboxEventRecord; inserted: boolean } {
    if (this.disposed) throw new Error('Runtime has been disposed')
    const session = this.sessions.get(input.sessionId)
    if (!session) throw new Error(`Session ${input.sessionId} not found`)
    const result = enqueueInboxEvent(this.db, {
      sessionId: input.sessionId,
      projectId: session.projectId,
      source: input.source ?? 'user',
      dedupeKey: input.dedupeKey ?? null,
      wake: input.wake ?? true,
      passive: input.passive ?? false,
      payload: {
        type: input.source ?? 'user',
        text: input.text,
        ...(input.attachments?.length
          ? { attachments: input.attachments }
          : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      },
    })
    if (result.event.wake) {
      this.scheduleSession(input.sessionId)
    }
    return result
  }

  requestApproval(input: {
    sessionId: string
    runId: string
    toolCallRowId?: string | null
    toolCallId?: string | null
    toolName: string
    summary: string
    input?: unknown
  }): ApprovalRecord {
    const session = this.sessions.get(input.sessionId)
    if (!session) throw new Error(`Session ${input.sessionId} not found`)
    return createApprovalRequest(this.db, this.eventBus, {
      ...input,
      projectId: session.projectId,
    })
  }

  listPendingApprovals(sessionId?: string): ApprovalRecord[] {
    return listRuntimePendingApprovals(this.db, sessionId)
  }

  resolveApproval(input: {
    approvalId: string
    decision: 'approved' | 'denied' | 'cancelled'
    reason?: string
    decidedBy?: string
  }): { approval: ApprovalRecord; shouldWake: boolean } {
    const result = resolveRuntimeApproval(this.db, this.eventBus, input)
    if (result.shouldWake && !this.disposed) {
      this.scheduleSession(result.approval.sessionId)
    }
    return result
  }

  async stopSession(
    sessionId: string,
    reason = 'Stopped by user',
  ): Promise<boolean> {
    const active = this.activeWorkers.get(sessionId)
    let cancelledRun = false
    if (active) {
      cancelledRun = true
      active.controller.abort(new DOMException(reason, 'AbortError'))
      const session = this.sessions.get(sessionId)
      const driver = session ? this.drivers.get(session.driver) : undefined
      await driver?.abort?.(sessionId)
      await active.promise.catch(() => {})
    }
    const cancelledApprovals = cancelPendingApprovalsForSession(
      this.db,
      this.eventBus,
      sessionId,
      reason,
    )
    const stoppedJobs = this.backgroundJobs.stopSessionJobs(sessionId)
    const now = new Date().toISOString()
    this.db.transaction(() => {
      const updated = this.db.run(
        `UPDATE runs SET status = 'stopped', finished_at = COALESCE(finished_at, ?), updated_at = ?
         WHERE session_id = ? AND status IN ('queued', 'running', 'waiting_human')`,
        now,
        now,
        sessionId,
      )
      if (updated.changes > 0) cancelledRun = true
      this.db.run(
        `UPDATE sessions SET state = 'idle', waiting_reason = NULL, updated_at = ?
         WHERE id = ? AND state IN ('running', 'waiting_human')`,
        now,
        sessionId,
      )
    })
    return cancelledRun || cancelledApprovals > 0 || stoppedJobs > 0
  }

  async restartSession(sessionId: string): Promise<SessionRecord> {
    await this.stopSession(sessionId, 'Session restarted')
    return this.sessions.reset(sessionId)
  }

  async executeShortcut(input: {
    command: ControlShortcut
    sessionId: string
    projectId?: string | null
  }): Promise<{ text: string; stopped?: boolean }> {
    return executeControlShortcut(
      {
        stopSession: (sid) => this.stopSession(sid),
        restartSession: async (sid) => {
          await this.restartSession(sid)
        },
        sessionStatus: (sid) => this.sessions.status(sid),
        listTimers: (filter) => this.timers.list(filter),
      },
      input,
    )
  }

  listEvents(
    options: {
      sessionId?: string
      projectId?: string
      afterSeq?: number
      limit?: number
    } = {},
  ): RuntimeEvent[] {
    return this.eventBus.list(options)
  }

  bufferedDeltas(sessionId: string): StreamDeltaEvent[] {
    return this.eventBus.bufferedDeltas(sessionId)
  }

  subscribeEvents(listener: RuntimeEventListener): () => void {
    return this.eventBus.subscribeEvents(listener)
  }

  subscribeDeltas(listener: StreamDeltaListener): () => void {
    return this.eventBus.subscribeDeltas(listener)
  }

  /** Single-DB deterministic crash recovery run on startup. */
  async recover(nowMs = Date.now()): Promise<{
    interruptedJobs: string[]
    recoveredRuns: string[]
    requeuedInboxRuns: string[]
    wokenSessions: string[]
  }> {
    if (this.disposed) throw new Error('Runtime has been disposed')
    const {
      interruptedJobs,
      recoveredRuns,
      requeuedInboxRuns,
      sessionsToWake,
    } = recoverRuntimeState({
      db: this.db,
      backgroundJobs: this.backgroundJobs,
      outbox: this.outbox,
      timers: this.timers,
      activeOwners: this.activeOwners,
      nowMs,
    })
    for (const sessionId of sessionsToWake) {
      this.scheduleSession(sessionId)
    }
    await this.outbox.flushOnce(nowMs)
    return {
      interruptedJobs,
      recoveredRuns,
      requeuedInboxRuns,
      wokenSessions: [...sessionsToWake],
    }
  }

  scheduleSession(sessionId: string): void {
    if (this.disposed || this.activeWorkers.has(sessionId)) return
    const controller = new AbortController()
    const worker: ActiveWorker = {
      runId: '',
      ownerToken: '',
      controller,
      promise: Promise.resolve(),
    }
    worker.promise = this.runSessionLoop(sessionId, worker).finally(() => {
      if (this.activeWorkers.get(sessionId) === worker) {
        this.activeWorkers.delete(sessionId)
      }
    })
    this.activeWorkers.set(sessionId, worker)
  }

  async waitForIdle(sessionId?: string): Promise<void> {
    if (sessionId) {
      await this.activeWorkers.get(sessionId)?.promise
      return
    }
    while (this.activeWorkers.size > 0) {
      await Promise.allSettled(
        [...this.activeWorkers.values()].map((w) => w.promise),
      )
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const worker of this.activeWorkers.values()) {
      worker.controller.abort(
        new DOMException('Runtime disposed', 'AbortError'),
      )
    }
    await Promise.allSettled(
      [...this.activeWorkers.values()].map((w) => w.promise),
    )
    for (const [name, adapter] of this.channels) {
      await adapter
        .stop()
        .catch((error) =>
          this.logger.error(
            `[runtime] failed stopping channel ${name}: ${error}`,
          ),
        )
    }
    this.channels.clear()
    for (const driver of this.drivers.values()) {
      await driver.dispose?.()
    }
    await this.environments.dispose()
    if (this.transientBlobDir) {
      rmSync(this.transientBlobDir, { recursive: true, force: true })
    }
  }

  private async ingestChannelMessage(
    adapter: ChannelAdapter,
    msg: ChannelInboundMessage,
  ): Promise<void> {
    const resolved = this.resolveChannelTarget(msg)
    if (!resolved) return
    const { binding, session } = resolved

    const shortcut = parseControlShortcut(msg.text)
    if (shortcut) {
      const outcome = await this.executeShortcut({
        command: shortcut,
        sessionId: session.id,
        projectId: binding.projectId,
      })
      if (outcome.text) {
        await adapter.deliver({
          outboxId: `shortcut-${randomUUID()}`,
          kind: 'reply',
          channel: msg.channel,
          externalChatId: msg.externalChatId,
          ...(msg.threadId ? { threadId: msg.threadId } : {}),
          ...(msg.messageId ? { replyToMessageId: msg.messageId } : {}),
          text: outcome.text,
        })
      }
      return
    }

    const attachments: Array<{
      blobId: string
      name: string
      mimeType?: string
    }> = []
    if (msg.attachments?.length && adapter.fetchAttachment) {
      for (const att of msg.attachments) {
        const bytes = await adapter.fetchAttachment(att.ref)
        const blob = await this.blobs.storeInbound({
          sessionId: session.id,
          projectId: binding.projectId,
          filename: att.name,
          mimeType: att.mimeType,
          bytes,
        })
        attachments.push({
          blobId: blob.id,
          name: att.name,
          ...(att.mimeType ? { mimeType: att.mimeType } : {}),
        })
      }
    }

    const { event, inserted } = enqueueInboxEvent(this.db, {
      sessionId: session.id,
      projectId: binding.projectId,
      source: 'channel',
      dedupeKey: msg.dedupeKey,
      wake: msg.wake ?? true,
      passive: msg.passive ?? false,
      payload: {
        type: 'channel',
        channel: msg.channel,
        externalChatId: msg.externalChatId,
        kind: msg.kind,
        ...(msg.threadId ? { threadId: msg.threadId } : {}),
        ...(msg.messageId ? { messageId: msg.messageId } : {}),
        senderId: msg.senderId,
        senderName: msg.senderName,
        text: msg.text,
        ...(msg.mentioned !== undefined ? { mentioned: msg.mentioned } : {}),
        timestamp: msg.timestamp,
        ...(attachments.length ? { attachments } : {}),
      },
    })
    if (inserted && event.wake) {
      this.scheduleSession(session.id)
    }
  }

  private resolveChannelTarget(
    msg: ChannelInboundMessage,
  ): { binding: ChannelBinding; session: SessionRecord } | undefined {
    const exact = this.bindings.findByExternal(
      msg.channel,
      msg.externalChatId,
      msg.threadId,
    )
    if (exact) {
      if (!exact.enabled) return undefined
      const session = exact.sessionId
        ? this.sessions.get(exact.sessionId)
        : exact.projectId
          ? this.getOrCreateHubSession(exact.projectId)
          : undefined
      return session ? { binding: exact, session } : undefined
    }
    if (!msg.threadId) return undefined
    const root = this.bindings.findByExternal(msg.channel, msg.externalChatId)
    if (!root?.enabled || !root.projectId) return undefined
    const topicSession = this.sessions.create({
      projectId: root.projectId,
      kind: 'topic',
      name: msg.text.trim().slice(0, 60) || 'Topic',
    })
    const topicBinding = this.bindings.upsert({
      channel: msg.channel,
      externalId: msg.externalChatId,
      threadId: msg.threadId,
      kind: 'group',
      projectId: root.projectId,
      sessionId: topicSession.id,
      enabled: true,
    })
    return { binding: topicBinding, session: topicSession }
  }

  private getOrCreateHubSession(projectId: string): SessionRecord | undefined {
    const project = this.projects.get(projectId)
    if (!project) return undefined
    if (project.hubSessionId) {
      return this.sessions.get(project.hubSessionId)
    }
    return this.sessions.create({ projectId, kind: 'work' })
  }

  private async runSessionLoop(
    sessionId: string,
    worker: ActiveWorker,
  ): Promise<void> {
    while (!this.disposed && !worker.controller.signal.aborted) {
      const claimed = claimNextTurnInDb({
        db: this.db,
        sessions: this.sessions,
        eventBus: this.eventBus,
        activeOwners: this.activeOwners,
        sessionId,
      })
      if (!claimed) break

      worker.runId = claimed.runId
      worker.ownerToken = claimed.ownerToken
      this.activeOwners.add(claimed.ownerToken)

      let result: DriverTurnResult | undefined
      try {
        const driver = this.drivers.get(claimed.session.driver)
        if (!driver) {
          throw new Error(
            `No AgentDriver registered for "${claimed.session.driver}"`,
          )
        }
        const outboxTarget = resolveOutboxTargetInDb(
          this.db,
          claimed.session,
          claimed.inputs,
        )

        result = await driver.runTurn({
          sessionId: claimed.session.id,
          projectId: claimed.session.projectId,
          runId: claimed.runId,
          ownerToken: claimed.ownerToken,
          trigger: claimed.trigger,
          inputs: claimed.inputs,
          recoverPending: claimed.recoverPending,
          allowWaitingHuman: claimed.allowWaitingHuman,
          abortSignal: worker.controller.signal,
          onDelta: (delta) => this.eventBus.emitDelta(delta),
          onEvent: (payload) => {
            this.eventBus.append({
              sessionId: claimed.session.id,
              projectId: claimed.session.projectId,
              runId: claimed.runId,
              payload,
            })
          },
          onTerminalCommitInTx: (outcome) =>
            commitCompletedTurnInTx({
              db: this.db,
              eventBus: this.eventBus,
              claimed,
              outcome,
              outboxTarget,
            }),
        })

        if (!result.committedInTx) {
          finalizeTurnInDb({
            db: this.db,
            eventBus: this.eventBus,
            claimed,
            result,
            outboxTarget,
          })
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        const status: RunEndStatus = worker.controller.signal.aborted
          ? 'stopped'
          : 'failed'
        finalizeTurnInDb({
          db: this.db,
          eventBus: this.eventBus,
          claimed,
          result: { status, error: msg },
        })
      } finally {
        this.activeOwners.delete(claimed.ownerToken)
        this.eventBus.clearDeltas(sessionId)
      }

      if (this.channels.size > 0) {
        await this.outbox
          .flushOnce()
          .catch((error) =>
            this.logger.error(`[runtime] outbox flush failed: ${error}`),
          )
      }
      if (result?.status === 'waiting_human') break
    }
  }
}
