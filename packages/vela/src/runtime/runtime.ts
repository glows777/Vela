import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { VelaDatabase } from '../db/index.ts'
import { silentLogger, type VelaLogger } from '../shared/logger.ts'
import {
  type ApprovalRecord,
  createApprovalRequest,
  listRuntimePendingApprovals,
  resolveRuntimeApproval,
} from './approvals.ts'
import { BackgroundJobManager } from './background-jobs.ts'
import { BlobStore } from './blobs.ts'
import {
  type ChannelStatusTracker,
  createChannelStatusTracker,
  getChannelToolsForSessionInDb,
  ingestWebhookEventInRuntime,
  isChannelAdapterReady,
  isChannelEnabledInDb,
  listChannelStatusesInRuntime,
  listRuntimeOrChannelMessages,
  registerChannelInRuntime,
  setChannelEnabledInDb,
  steerSessionInRuntime,
  submitChannelHostMessageInRuntime,
} from './channel-control.ts'
import type {
  ChannelAdapter,
  ChannelBinding,
  ChannelChatInfo,
  ChannelHostSubmitInput,
  ChannelHostSubmitResult,
  ChannelStatusInfo,
  ChannelToolSpec,
} from './channels.ts'
import {
  type SubmitRuntimePromptInput,
  submitPromptInRuntime,
} from './control-inbox.ts'
import {
  ChannelBindingStore,
  ProjectStore,
  type SessionRecord,
  SessionStoreControl,
} from './domain.ts'
import {
  type AgentDriver,
  isOwnerLive,
  PROCESS_OWNER_PREFIX,
  registerLiveOwner,
  unregisterLiveOwner,
} from './driver.ts'
import { EnvironmentRegistry } from './environments.ts'
import {
  type ChannelRuntimeEventListener,
  RuntimeEventBus,
  type RuntimeEventListener,
  type StreamDeltaListener,
} from './event-bus.ts'
import type { RuntimeEvent, StreamDeltaEvent } from './events.ts'
import { type InboxEventRecord, listDeferredWakeSessionIds } from './inbox.ts'
import { OutboxDispatcher } from './outbox.ts'
import { isSessionInChannels, scheduleRuntimeWakeTimer } from './recovery.ts'
import type { ActiveWorker, VelaRuntimeEngineOptions } from './runtime-types.ts'
import { type ControlShortcut, executeControlShortcut } from './shortcuts.ts'
import { SubscriptionManager } from './subscriptions.ts'
import { TimerScheduler } from './timers.ts'
import { executeRuntimeClaimedTurn } from './turn-runner.ts'
import {
  canWakeSessionInDb,
  claimNextTurnInDb,
  disposeRuntimeResources,
  recoverRuntimeState,
  stopSessionInRuntime,
} from './worker.ts'

export type { VelaRuntimeEngineOptions }

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
  private readonly ignoredChannels: ReadonlySet<string>
  private readonly drivers = new Map<string, AgentDriver>()
  private readonly channels = new Map<string, ChannelAdapter>()
  private readonly channelStatuses: ChannelStatusTracker
  private readonly activeWorkers = new Map<string, ActiveWorker>()
  private readonly stoppingSessions = new Map<string, number>()
  private readonly inFlightDeliveries = new Set<string>()
  private readonly activeOwners = new Set<string>()
  private readonly transientBlobDir?: string
  private readonly onRestartSession?: (sid: string) => Promise<void> | void
  private readonly trySteerInboxEvent?: VelaRuntimeEngineOptions['trySteerInboxEvent']
  private nextWakeTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(options: VelaRuntimeEngineOptions) {
    this.db = options.db
    this.agentDir = resolve(options.agentDir)
    this.logger = options.logger ?? silentLogger
    this.ignoredChannels = new Set(options.ignoredChannels ?? [])
    this.onRestartSession = options.onRestartSession
    this.trySteerInboxEvent = options.trySteerInboxEvent
    if (options.db.path === ':memory:') {
      this.transientBlobDir = mkdtempSync(join(tmpdir(), 'vela-blobs-'))
      this.blobs = new BlobStore(this.db, join(this.transientBlobDir, 'blobs'))
    } else {
      this.blobs = new BlobStore(this.db, join(this.agentDir, 'blobs'))
    }
    this.environments =
      options.environments ??
      new EnvironmentRegistry({ dataDir: this.agentDir })
    this.projects = new ProjectStore(this.db, () => this.syncWakeTimer())
    this.sessions = new SessionStoreControl(this.db, () => this.syncWakeTimer())
    this.bindings = new ChannelBindingStore(this.db)
    this.eventBus = new RuntimeEventBus(this.db)
    this.channelStatuses = createChannelStatusTracker(this.eventBus)
    this.outbox = new OutboxDispatcher(
      this.db,
      (name) =>
        this.isChannelEnabled(name) ? this.readyChannel(name) : undefined,
      () => this.syncWakeTimer(),
      (sessionId) => this.scheduleSession(sessionId),
      (info) =>
        this.eventBus.emitChannelEvent({
          type: 'channel_history_changed',
          channel: info.channel,
          chatId: info.externalChatId,
          ...(info.threadId ? { sessionId: info.sessionId } : {}),
        }),
    )
    this.timers = new TimerScheduler(
      this.db,
      (sessionId) => this.scheduleSession(sessionId),
      () => this.syncWakeTimer(),
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
    await registerChannelInRuntime(
      this.channels,
      {
        db: this.db,
        blobs: this.blobs,
        projects: this.projects,
        sessions: this.sessions,
        bindings: this.bindings,
        eventBus: this.eventBus,
        inFlightDeliveries: this.inFlightDeliveries,
        adapter,
        executeShortcut: (s) => this.executeShortcut(s),
        scheduleSession: (sid) => this.scheduleSession(sid),
        stopSession: (sid, r) => this.stopSession(sid, r),
        steerSession: async (sid, t) => {
          await this.steerSession(sid, t)
        },
        trySteerSession: (sid, t, images) =>
          this.steerSession(sid, t, images, true),
        trySteerInboxEvent: this.trySteerInboxEvent,
      },
      this.channelStatuses,
    )
    void this.wakeDeferredAndFlushOutbox()
  }

  async unregisterChannel(name: string): Promise<void> {
    const existing = this.channels.get(name)
    if (!existing) return
    this.channels.delete(name)
    try {
      await existing.stop()
    } finally {
      this.channelStatuses.markStopped(name)
      this.syncWakeTimer()
    }
    await this.outbox.drainChannel(name).catch(() => {})
  }

  private readyChannel(name: string): ChannelAdapter | undefined {
    const adapter = this.channels.get(name)
    return isChannelAdapterReady(adapter) ? adapter : undefined
  }

  channelAdapter(name: string): ChannelAdapter | undefined {
    return this.readyChannel(name)
  }

  listSessionMessages(input: {
    sessionId: string
    cursor?: string
    limit?: number
  }) {
    return listRuntimeOrChannelMessages(
      this.db,
      this.sessions,
      this.bindings,
      this.channels,
      input,
    )
  }

  listChannelStatuses(
    knownNames?: readonly string[],
    lastErrors?: ReadonlyMap<string, string>,
  ): ChannelStatusInfo[] {
    return listChannelStatusesInRuntime(
      this.db,
      this.channels,
      knownNames,
      lastErrors,
    )
  }

  isChannelEnabled = (name: string): boolean =>
    isChannelEnabledInDb(this.db, name)
  setChannelEnabled = (name: string, enabled: boolean): void => {
    setChannelEnabledInDb(this.db, name, enabled)
    if (enabled && !this.disposed) {
      void this.wakeDeferredAndFlushOutbox()
    }
  }

  listChannelChats(channel: string): Promise<ChannelChatInfo[]> {
    if (!this.isChannelEnabled(channel)) return Promise.resolve([])
    return this.readyChannel(channel)?.listChats?.() ?? Promise.resolve([])
  }

  submitChannelHostMessage(
    channel: string,
    input: ChannelHostSubmitInput,
  ): Promise<ChannelHostSubmitResult> {
    return submitChannelHostMessageInRuntime(
      this.db,
      this.channels,
      channel,
      input,
    )
  }

  getChannelToolsForSession(
    sessionId: string,
    runId?: string,
  ):
    | { binding: ChannelBinding; tools: readonly ChannelToolSpec[] }
    | undefined {
    return getChannelToolsForSessionInDb(
      this.db,
      this.sessions,
      this.bindings,
      this.channels,
      sessionId,
      runId,
    )
  }

  ingestWebhookEvent(
    event: import('./webhooks/github-events.ts').RuntimeWebhookEvent,
    defaultTarget?: { channel: string; chatId: string },
  ) {
    return ingestWebhookEventInRuntime({
      db: this.db,
      projects: this.projects,
      sessions: this.sessions,
      bindings: this.bindings,
      subscriptions: this.subscriptions,
      channels: this.channels,
      scheduleSession: (sid) => this.scheduleSession(sid),
      logger: this.logger,
      event,
      defaultTarget,
    })
  }

  /** Submits a user prompt (or queued steering/handoff/note) into `inbox_events` and wakes the worker. */
  submitPrompt(input: SubmitRuntimePromptInput): {
    event: InboxEventRecord
    inserted: boolean
  } {
    return submitPromptInRuntime({
      disposed: this.disposed,
      db: this.db,
      sessions: this.sessions,
      eventBus: this.eventBus,
      scheduleSession: (sid) => this.scheduleSession(sid),
      input,
    })
  }

  steerSession(
    sessionId: string,
    text: string,
    images?: Array<{ data: string; mimeType: string }>,
    noQueueFallback = false,
  ): Promise<boolean> {
    return steerSessionInRuntime({
      disposed: this.disposed,
      db: this.db,
      sessions: this.sessions,
      blobs: this.blobs,
      drivers: this.drivers,
      activeWorkers: this.activeWorkers,
      submitPrompt: (input) => this.submitPrompt(input),
      sessionId,
      text,
      images,
      noQueueFallback,
    })
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

  private enterStopFence(sessionId: string): void {
    this.stoppingSessions.set(
      sessionId,
      (this.stoppingSessions.get(sessionId) ?? 0) + 1,
    )
  }

  private leaveStopFence(sessionId: string): void {
    const depth = (this.stoppingSessions.get(sessionId) ?? 0) - 1
    if (depth > 0) {
      this.stoppingSessions.set(sessionId, depth)
      return
    }
    this.stoppingSessions.delete(sessionId)
    if (!this.disposed && this.db.open && this.canWakeSessionNow(sessionId)) {
      this.scheduleSession(sessionId)
    }
  }

  async stopSession(
    sessionId: string,
    reason = 'Stopped by user',
    options?: { expectedRunId?: string },
  ): Promise<boolean> {
    this.enterStopFence(sessionId)
    try {
      return await stopSessionInRuntime({
        db: this.db,
        sessions: this.sessions,
        drivers: this.drivers,
        eventBus: this.eventBus,
        backgroundJobs: this.backgroundJobs,
        activeWorkers: this.activeWorkers,
        activeOwners: this.activeOwners,
        isDisposed: () => this.disposed,
        sessionId,
        reason,
        expectedRunId: options?.expectedRunId,
      })
    } finally {
      this.leaveStopFence(sessionId)
    }
  }

  async restartSession(sessionId: string): Promise<SessionRecord> {
    this.enterStopFence(sessionId)
    try {
      await this.stopSession(sessionId, 'Session restarted')
      const remaining = this.db.all<{ id: string; owner_token: string | null }>(
        `SELECT id, owner_token FROM runs WHERE session_id = ? AND status IN ('queued', 'running')`,
        sessionId,
      )
      if (
        remaining.some((r) => isOwnerLive(r.owner_token, this.activeOwners))
      ) {
        throw new Error(
          `Cannot restart session ${sessionId} while another live worker owns an active run`,
        )
      }
      this.timers.cancelFollowupsForSession(sessionId)
      await this.onRestartSession?.(sessionId)
      const resetSession = this.sessions.reset(sessionId)
      this.eventBus.append({
        sessionId,
        projectId: resetSession.projectId,
        payload: { type: 'session_reset' },
      })
      return resetSession
    } finally {
      this.leaveStopFence(sessionId)
    }
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

  isSessionBusy(sessionId: string): boolean {
    return (
      this.activeWorkers.has(sessionId) || this.stoppingSessions.has(sessionId)
    )
  }

  subscribeEvents(listener: RuntimeEventListener): () => void {
    return this.eventBus.subscribeEvents(listener)
  }

  subscribeDeltas(listener: StreamDeltaListener): () => void {
    return this.eventBus.subscribeDeltas(listener)
  }

  subscribeChannelEvents(listener: ChannelRuntimeEventListener): () => void {
    return this.eventBus.subscribeChannelEvents(listener)
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
      ignoredChannels: this.ignoredChannels,
    })
    for (const sessionId of sessionsToWake) {
      this.scheduleSession(sessionId)
    }
    await this.outbox.flushOnce(nowMs)
    this.syncWakeTimer()
    return {
      interruptedJobs,
      recoveredRuns,
      requeuedInboxRuns,
      wokenSessions: [...sessionsToWake],
    }
  }

  scheduleSession(sessionId: string): void {
    if (
      this.disposed ||
      this.activeWorkers.has(sessionId) ||
      this.stoppingSessions.has(sessionId) ||
      (this.ignoredChannels.size > 0 &&
        isSessionInChannels(this.db, sessionId, this.ignoredChannels))
    ) {
      return
    }
    const controller = new AbortController()
    const worker: ActiveWorker = {
      runId: '',
      ownerToken: '',
      controller,
      promise: Promise.resolve(),
    }
    this.activeWorkers.set(sessionId, worker)
    worker.promise = this.runSessionLoop(sessionId, worker)
      .catch((error) => {
        this.logger.error(
          `[runtime] session loop error for ${sessionId}: ${error}`,
        )
      })
      .finally(() => {
        if (this.activeWorkers.get(sessionId) === worker) {
          this.activeWorkers.delete(sessionId)
        }
        if (
          !this.disposed &&
          !worker.controller.signal.aborted &&
          !this.stoppingSessions.has(sessionId) &&
          this.canWakeSessionNow(sessionId, worker.suppressedInterruptedIds)
        ) {
          this.scheduleSession(sessionId)
        }
      })
  }

  private canWakeSessionNow(
    sessionId: string,
    excludeInboxIds?: ReadonlySet<string>,
  ): boolean {
    if (
      this.ignoredChannels.size > 0 &&
      isSessionInChannels(this.db, sessionId, this.ignoredChannels)
    ) {
      return false
    }
    return canWakeSessionInDb(
      this.db,
      this.sessions,
      sessionId,
      excludeInboxIds,
    )
  }

  private syncWakeTimer(): void {
    if (this.nextWakeTimer) {
      clearTimeout(this.nextWakeTimer)
      this.nextWakeTimer = undefined
    }
    if (this.disposed || !this.db.open) return
    const registeredChannels = [...this.channels.keys()].filter(
      (name) =>
        this.readyChannel(name) !== undefined &&
        this.isChannelEnabled(name) &&
        !this.ignoredChannels.has(name),
    )
    this.nextWakeTimer = scheduleRuntimeWakeTimer({
      db: this.db,
      timers: this.timers,
      outbox: this.outbox,
      registeredChannels,
      ignoredChannels: this.ignoredChannels,
      hasChannels: registeredChannels.length > 0,
      onFire: () => {
        this.nextWakeTimer = undefined
        return !this.disposed && this.db.open
      },
      onSync: () => this.syncWakeTimer(),
      onFlushError: (error) =>
        this.logger.error(`[runtime] outbox flush failed: ${error}`),
    })
  }

  async waitForIdle(sessionId?: string): Promise<void> {
    if (sessionId) {
      while (this.activeWorkers.has(sessionId)) {
        await this.activeWorkers.get(sessionId)?.promise
      }
      return
    }
    for (;;) {
      while (this.activeWorkers.size > 0) {
        await Promise.allSettled(
          [...this.activeWorkers.values()].map((w) => w.promise),
        )
      }
      let waitedBackground = false
      for (const driver of this.drivers.values()) {
        if (driver.waitForBackground) {
          waitedBackground = true
          await driver.waitForBackground()
        }
      }
      if (!waitedBackground || this.activeWorkers.size === 0) break
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.nextWakeTimer) {
      clearTimeout(this.nextWakeTimer)
      this.nextWakeTimer = undefined
    }
    const channels = [...this.channels.entries()]
    this.channels.clear()
    for (const worker of this.activeWorkers.values()) {
      worker.controller.abort(
        new DOMException('Runtime disposed', 'AbortError'),
      )
    }
    try {
      await disposeRuntimeResources({
        channels,
        workerPromises: [...this.activeWorkers.values()].map((w) => w.promise),
        drainOutbox: () => this.outbox.drain(),
        drivers: this.drivers.values(),
        disposeEnvironments: () => this.environments.dispose(),
        logError: (msg) => this.logger.error(msg),
      })
    } finally {
      if (this.transientBlobDir) {
        rmSync(this.transientBlobDir, { recursive: true, force: true })
      }
    }
  }

  private flushOutboxBestEffort(): Promise<void> {
    return this.outbox
      .flushOnce()
      .catch((error) =>
        this.logger.error(`[runtime] outbox flush failed: ${error}`),
      )
      .then(() => {})
  }

  private wakeDeferredAndFlushOutbox(): Promise<void> {
    return this.flushOutboxBestEffort().finally(() => {
      for (const sid of listDeferredWakeSessionIds(this.db)) {
        this.scheduleSession(sid)
      }
      this.syncWakeTimer()
    })
  }

  private async runSessionLoop(
    sessionId: string,
    worker: ActiveWorker,
  ): Promise<void> {
    while (!this.disposed && !worker.controller.signal.aborted) {
      const preOwnerToken = `${PROCESS_OWNER_PREFIX}:${process.pid}:${randomUUID()}`
      let stopWaitResolve: (() => void) | undefined
      const stoppedDone = new Promise<void>((resolve) => {
        stopWaitResolve = resolve
      })
      this.activeOwners.add(preOwnerToken)
      registerLiveOwner(preOwnerToken, {
        abort: async (abortReason) => {
          worker.controller.abort(new DOMException(abortReason, 'AbortError'))
          const session = this.sessions.get(sessionId)
          const driver = session ? this.drivers.get(session.driver) : undefined
          await driver?.abort?.(sessionId)
          await stoppedDone
        },
      })

      let claimed: ReturnType<typeof claimNextTurnInDb>
      try {
        claimed = claimNextTurnInDb({
          db: this.db,
          sessions: this.sessions,
          eventBus: this.eventBus,
          activeOwners: this.activeOwners,
          sessionId,
          ownerToken: preOwnerToken,
        })
      } catch (error) {
        unregisterLiveOwner(preOwnerToken)
        this.activeOwners.delete(preOwnerToken)
        stopWaitResolve?.()
        throw error
      }
      if (!claimed) {
        unregisterLiveOwner(preOwnerToken)
        this.activeOwners.delete(preOwnerToken)
        stopWaitResolve?.()
        break
      }

      worker.runId = claimed.runId
      worker.ownerToken = claimed.ownerToken

      let outcome: { lostOwnership: boolean; status?: string }
      try {
        outcome = await executeRuntimeClaimedTurn({
          db: this.db,
          eventBus: this.eventBus,
          driver: this.drivers.get(claimed.session.driver),
          claimed,
          abortController: worker.controller,
          isDisposed: () => this.disposed,
          wakeSession: (sid) => this.scheduleSession(sid),
          flushOutbox: () => {
            if (this.channels.size > 0) void this.flushOutboxBestEffort()
          },
          getChannelAdapter: (name) => this.readyChannel(name),
          isChannelEnabled: (name) => this.isChannelEnabled(name),
          logger: this.logger,
        })
      } finally {
        unregisterLiveOwner(claimed.ownerToken)
        this.activeOwners.delete(claimed.ownerToken)
        this.eventBus.clearDeltas(sessionId)
        stopWaitResolve?.()
      }
      if (outcome.lostOwnership) break
      if (outcome.status === 'interrupted') {
        worker.suppressedInterruptedIds = new Set(
          claimed.inputs.map((item) => item.id),
        )
        break
      }

      if (this.channels.size > 0) {
        await this.flushOutboxBestEffort()
      }
      this.syncWakeTimer()
      if (
        outcome.status === 'waiting_human' ||
        this.sessions.get(sessionId)?.state === 'waiting_human'
      )
        break
    }
  }
}
