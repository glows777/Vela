import { canonicalLocalPath } from '../db/trust.ts'
import { supportedThinkingLevels } from '../providers/models/catalog.ts'
import {
  limitsForModel,
  type ModelInfo,
  resolveModel,
  THINKING_LEVELS,
  type ThinkingLevel,
} from '../providers/models/index.ts'
import { clearPendingUserInbox } from '../runtime/control-inbox.ts'
import { getActiveChannelForSession } from '../runtime/control-ops.ts'
import type { CompactionResult } from './agent/events.ts'
import { ContextManager } from './context/manager.ts'
import { resolveRequestSnapshot } from './context/request.ts'
import type { ModelMessage } from './messages.ts'
import { createInspectAndBashControl } from './runtime-control-inspect.ts'
import { createTreeControl } from './runtime-control-tree.ts'
import {
  type DriverSharedState,
  type PreparedSessionEnv,
  prepareSessionSetup,
  resolveSessionModels,
  retireOrDisposeCachedRunner,
} from './runtime-session-setup.ts'
import type {
  RuntimeReloadableConfig,
  RuntimeSessionInspection,
  RuntimeSessionOverride,
} from './runtime-types.ts'
import { updateSessionColumn } from './session/db-store.ts'
import {
  bashExecutionToText,
  type SessionEntry,
  type SessionTreeNode,
} from './session/entries.ts'
import { exportBranch } from './session/export.ts'
import { SessionStore } from './session/index.ts'
import type { ForkOptions, NavigateTreeOptions } from './session/options.ts'
import type { BackgroundSnapshot, BackgroundTask } from './tools/background.ts'
import type { BashResult } from './tools/shell.ts'
import { CONTEXT_WINDOW, TokenTracker } from './usage/tracker.ts'

export interface RuntimeControlHandle {
  ready(): Promise<void>
  extensionErrors(): string[]
  reloadConfig(next: RuntimeReloadableConfig): Promise<void>
  configure(sessionId: string, override: RuntimeSessionOverride): Promise<void>
  setModel(sessionId: string, modelRef: string): Promise<ModelInfo>
  setThinkingLevel(
    sessionId: string,
    level: ThinkingLevel,
  ): Promise<ThinkingLevel>
  compact(
    sessionId: string,
    instructions?: string,
  ): Promise<CompactionResult | undefined>
  tree(sessionId: string): Promise<{
    tree: SessionTreeNode[]
    branch: SessionEntry[]
    entries: SessionEntry[]
    leafId: string | null
  }>
  navigateTree(
    sessionId: string,
    targetId: string,
    options?: NavigateTreeOptions,
  ): Promise<{
    editorText?: string
    cancelled: boolean
    branch: SessionEntry[]
  }>
  setLabel(
    sessionId: string,
    entryId: string,
    label: string | undefined,
  ): Promise<void>
  fork(
    sessionId: string,
    entryId: string,
    options?: ForkOptions,
  ): Promise<{ cancelled: boolean; sessionId?: string; selectedText?: string }>
  clone(
    sessionId: string,
    options?: Omit<ForkOptions, 'position'>,
  ): Promise<{ cancelled: boolean; sessionId?: string; selectedText?: string }>
  inspect(
    sessionId: string,
    options?: { previewPrompt?: boolean },
  ): Promise<RuntimeSessionInspection>
  execBash(
    sessionId: string,
    command: string,
    options?: { excludeFromContext?: boolean; id?: string },
  ): Promise<BashResult>
  abortBash(sessionId: string): void
  runCommand(sessionId: string, input: string): Promise<{ handled: boolean }>
  clearQueue(sessionId: string): { steering: string[] }
  listJobs(sessionId?: string): BackgroundTask[]
  stopJob(sessionId: string, jobId: string): Promise<BackgroundSnapshot>
  promoteForeground(sessionId: string, toolCallId?: string): Promise<string[]>
  exportSession(
    sessionId: string,
    format: 'jsonl' | 'html',
    outputPath?: string,
    baseCwd?: string,
  ): Promise<string>
  flushPendingBash(
    sessionId: string,
    store: SessionStore,
    messages: ModelMessage[],
    tracker: TokenTracker,
  ): Promise<boolean>
  closeSession(sessionId: string): Promise<void>
}

export function createRuntimeControl(
  state: DriverSharedState,
): RuntimeControlHandle {
  const controlQueues = new Map<string, Promise<unknown>>()
  const withSessionLock = <T>(
    sessionId: string,
    task: () => Promise<T>,
  ): Promise<T> => {
    const prev = controlQueues.get(sessionId) ?? Promise.resolve()
    const run = prev.then(task, task)
    const tail = run.catch(() => {})
    controlQueues.set(sessionId, tail)
    void tail.then(() => {
      if (controlQueues.get(sessionId) === tail) {
        controlQueues.delete(sessionId)
      }
    })
    return run
  }

  const isSessionRunning = (sessionId: string): boolean => {
    if (state.options.isSessionBusy?.(sessionId)) return true
    if (state.activeAbort.has(sessionId)) return true
    const row = state.db.get<{ state: string }>(
      'SELECT state FROM sessions WHERE id = ?',
      sessionId,
    )
    return row?.state === 'running'
  }

  const assertIdle = (sessionId: string, action: string): void => {
    if (isSessionRunning(sessionId)) {
      throw new Error(
        `Session ${sessionId} is running; wait for it to finish or stop it before ${action}`,
      )
    }
  }

  const loadStore = async (
    sessionId: string,
  ): Promise<{
    store: SessionStore
    saved: Awaited<ReturnType<SessionStore['loadSaved']>>
  }> => {
    const row = state.db.get<{ id: string }>(
      'SELECT id FROM sessions WHERE id = ?',
      sessionId,
    )
    if (!row) throw new Error(`Session ${sessionId} not found`)
    const store = new SessionStore(sessionId, state.db, {
      blobsDir: state.options.blobs.rootDir,
      logger: state.logger,
    })
    const saved = await store.loadSaved()
    return { store, saved }
  }

  const emitNotify = (
    sessionId: string,
    projectId: string | null,
    message: string,
    level: 'info' | 'warning' | 'error' = 'info',
  ) => {
    state.options.eventBus?.append({
      sessionId,
      projectId,
      payload: { type: 'notify', level, message },
    })
  }

  const buildTrackerAndContext = (options: {
    store: SessionStore
    saved: Awaited<ReturnType<SessionStore['loadSaved']>>
    prepared: PreparedSessionEnv
    sessionId: string
    projectId: string | null
  }) => {
    const { store, saved, prepared, sessionId, projectId } = options
    const tracker = new TokenTracker((record) =>
      store.recordUsageRecord(record),
    )
    const info = prepared.resolved?.info
    tracker.setModel(info?.contextWindow ?? CONTEXT_WINDOW, info?.cost, {
      keepCalibration: true,
    })
    const messages: ModelMessage[] = [...(saved?.messages ?? [])]
    for (const m of messages) tracker.addMessage(m)
    if (saved?.latestAssistantUsage) {
      tracker.restoreCalibration(
        saved.latestAssistantUsage.inputTokens,
        saved.latestAssistantUsage.outputTokens,
        saved.latestAssistantUsage.trailingMessages,
      )
    }
    const effectiveLimits = limitsForModel(info ?? {}, state.reloadable.limits)
    const contextManager = new ContextManager(
      store,
      tracker,
      { messages, timestamps: new Map(), summary: '' },
      (event) => {
        if (event.type === 'compaction_start') {
          state.options.eventBus?.append({
            sessionId,
            projectId,
            payload: { type: 'compaction_started', reason: event.reason },
          })
        } else if (event.type === 'compaction_end') {
          if (event.result) {
            state.options.eventBus?.append({
              sessionId,
              projectId,
              payload: {
                type: 'compaction_finished',
                reason: event.reason,
                tokensBefore: event.result.tokensBefore,
                tokensAfter: event.result.tokensAfter,
                messages: event.result.messages,
              },
            })
          } else if (event.aborted || event.errorMessage) {
            state.options.eventBus?.append({
              sessionId,
              projectId,
              payload: {
                type: 'compaction_failed',
                reason: event.reason,
                aborted: event.aborted,
                willRetry: event.willRetry,
                errorMessage: event.errorMessage ?? 'Compaction aborted',
              },
            })
          }
        }
      },
      effectiveLimits,
    )
    contextManager.autoCompaction = state.reloadable.autoCompaction ?? true
    return { tracker, messages, effectiveLimits, contextManager }
  }

  let configProviderNames = new Set(Object.keys(state.options.providers ?? {}))

  const treeControl = createTreeControl({
    state,
    withSessionLock,
    assertIdle,
    loadStore,
    buildTrackerAndContext,
  })

  const inspectAndBashControl = createInspectAndBashControl({
    state,
    isSessionRunning,
    loadStore,
    emitNotify,
    buildTrackerAndContext,
  })

  return {
    ready: () => state.extHost.ready(),
    extensionErrors: () => state.extHost.errors,

    async reloadConfig(next: RuntimeReloadableConfig): Promise<void> {
      await state.extHost.ready().catch(() => {})
      state.extHost.unregisterExtensionProviders()
      if (next.providers) {
        for (const oldName of configProviderNames) {
          if (!(oldName in next.providers)) {
            state.models.unregister(oldName)
          }
        }
        for (const [name, def] of Object.entries(next.providers)) {
          state.models.configure(name, def)
        }
        configProviderNames = new Set(Object.keys(next.providers))
      }
      if ('rawConfigProviders' in next) {
        state.rawConfigProviders = next.rawConfigProviders
      }
      state.reloadable = {
        ...state.reloadable,
        ...('shellPath' in next ? { shellPath: next.shellPath } : {}),
        ...('limits' in next ? { limits: next.limits } : {}),
        ...('defaultTools' in next ? { defaultTools: next.defaultTools } : {}),
        ...('extensionConfig' in next
          ? { extensionConfig: next.extensionConfig }
          : {}),
        ...('extensions' in next ? { extensions: next.extensions } : {}),
        ...('enabledModels' in next
          ? { enabledModels: next.enabledModels }
          : {}),
        ...('githubRepositories' in next
          ? { githubRepositories: next.githubRepositories }
          : {}),
        ...('dreamEnabled' in next ? { dreamEnabled: next.dreamEnabled } : {}),
        ...('autoCompaction' in next
          ? { autoCompaction: next.autoCompaction }
          : {}),
        ...('offline' in next && next.offline !== undefined
          ? { offline: next.offline }
          : {}),
      }
      if ('defaultModel' in next) {
        state.reloadable.defaultModel = next.defaultModel
      }
      if ('defaultThinkingLevel' in next) {
        state.reloadable.defaultThinkingLevel = next.defaultThinkingLevel
      }
      state.sessionResourceSnapshots.clear()
      await state.extHost.reload({
        configured: state.reloadable.extensions,
        extensionConfig: state.reloadable.extensionConfig ?? {},
      })
    },

    async configure(
      sessionId: string,
      override: RuntimeSessionOverride,
    ): Promise<void> {
      const { store, saved } = await loadStore(sessionId)
      if (override.cwd) {
        const row = state.db.get<{ location_json: string | null }>(
          'SELECT location_json FROM sessions WHERE id = ?',
          sessionId,
        )
        if (!row?.location_json) {
          state.db.run(
            'UPDATE sessions SET location_json = ? WHERE id = ?',
            JSON.stringify({
              environment: 'local',
              cwd: canonicalLocalPath(override.cwd),
            }),
            sessionId,
          )
        }
      }
      state.sessionOverrides.set(sessionId, { ...override })
      state.sessionResourceSnapshots.delete(sessionId)

      let changedRow = false
      if (
        override.model &&
        override.model !== 'mock' &&
        !override.model.startsWith('faux:')
      ) {
        updateSessionColumn(state.db, sessionId, 'model', override.model)
        store.setModelChoice(override.model)
        changedRow = true
      }
      if (override.thinkingLevel) {
        updateSessionColumn(
          state.db,
          sessionId,
          'thinking_level',
          override.thinkingLevel,
        )
        store.setThinkingLevelChoice(override.thinkingLevel)
        changedRow = true
      }
      if (changedRow) {
        await store.flush()
      }

      if (
        override.model === 'mock' ||
        override.model?.startsWith('faux:') ||
        override.recordPath
      ) {
        if (!state.options.resolveSpecialModel) {
          throw new Error('Special test/record models are unavailable here')
        }
        const existingSpecial = state.specialModels.get(sessionId)
        if (existingSpecial) {
          state.specialModels.delete(sessionId)
          await existingSpecial.flush?.().catch(() => {})
        }
        const activeModels = resolveSessionModels(state, override)
        let fallbackModel: ReturnType<typeof resolveModel> | undefined
        if (
          override.recordPath &&
          override.model !== 'mock' &&
          !override.model?.startsWith('faux:')
        ) {
          const candidateRef =
            override.model ??
            saved?.model ??
            (typeof state.reloadable.defaultModel === 'string'
              ? state.reloadable.defaultModel
              : undefined)
          fallbackModel = resolveModel(
            candidateRef ?? state.reloadable.defaultModel,
            {
              providers: activeModels.providerDefinitions(),
              credentials: activeModels.credentials,
            },
          )
        }
        const special = await state.options.resolveSpecialModel({
          modelRef: override.model,
          recordPath: override.recordPath,
          fallbackModel,
        })
        if (special) {
          state.specialModels.set(sessionId, special)
        }
      } else {
        const existingSpecial = state.specialModels.get(sessionId)
        if (existingSpecial) {
          state.specialModels.delete(sessionId)
          await existingSpecial.flush?.().catch(() => {})
        }
      }

      if (
        override.tools !== undefined ||
        override.noTools ||
        (override.excludeTools && override.excludeTools.length > 0)
      ) {
        state.sessionActiveTools.delete(sessionId)
        const sessionRow = state.db.get<{ project_id: string | null }>(
          'SELECT project_id FROM sessions WHERE id = ?',
          sessionId,
        )
        const prepared = await prepareSessionSetup({
          state,
          sessionId,
          projectId: sessionRow?.project_id ?? null,
          saved,
          store,
          messages: [...(saved?.messages ?? [])],
          signal: new AbortController().signal,
          attachMcp: false,
          allowNoModel: true,
        })
        await prepared.releaseSession()
      }
    },

    async setModel(sessionId: string, modelRef: string): Promise<ModelInfo> {
      const { store, saved } = await loadStore(sessionId)
      const override = state.sessionOverrides.get(sessionId)
      const activeModels = resolveSessionModels(state, override)
      const row = state.db.get<{
        thinking_level: string | null
      }>('SELECT thinking_level FROM sessions WHERE id = ?', sessionId)
      const channel =
        getActiveChannelForSession(state.db, sessionId) ?? saved?.channel
      const resolved = activeModels.resolve(modelRef, {
        channel: () => channel,
      })
      const existingSpecial = state.specialModels.get(sessionId)
      if (existingSpecial) {
        state.specialModels.delete(sessionId)
        await existingSpecial.flush?.().catch(() => {})
      }
      if (override) {
        state.sessionOverrides.set(sessionId, {
          ...override,
          model: undefined,
        })
      }
      updateSessionColumn(state.db, sessionId, 'model', resolved.info.ref)
      store.setModelChoice(resolved.info.ref)
      const currentThinking = (override?.thinkingLevel ??
        (row?.thinking_level as ThinkingLevel | null) ??
        saved?.thinkingLevel ??
        state.reloadable.defaultThinkingLevel ??
        'medium') as ThinkingLevel
      const supported = supportedThinkingLevels(resolved.info, THINKING_LEVELS)
      if (!supported.includes(currentThinking) && supported.length > 0) {
        const clamped = supported[0]!
        updateSessionColumn(state.db, sessionId, 'thinking_level', clamped)
        store.setThinkingLevelChoice(clamped)
      }
      await store.flush()
      return resolved.info
    },

    async setThinkingLevel(
      sessionId: string,
      level: ThinkingLevel,
    ): Promise<ThinkingLevel> {
      if (!THINKING_LEVELS.includes(level)) {
        throw new Error(
          `Thinking level must be one of ${THINKING_LEVELS.join(' / ')}`,
        )
      }
      const { store, saved } = await loadStore(sessionId)
      const override = state.sessionOverrides.get(sessionId)
      if (override) {
        state.sessionOverrides.set(sessionId, {
          ...override,
          thinkingLevel: undefined,
        })
      }
      let nextLevel = level
      const activeModels = resolveSessionModels(state, override)
      const modelRef =
        saved?.model ??
        (typeof state.reloadable.defaultModel === 'string'
          ? state.reloadable.defaultModel
          : undefined)
      if (modelRef) {
        try {
          const info = activeModels.resolve(modelRef).info
          const supported = supportedThinkingLevels(info, THINKING_LEVELS)
          if (!supported.includes(level) && supported.length > 0) {
            nextLevel = supported[0]!
          }
        } catch {}
      }
      updateSessionColumn(state.db, sessionId, 'thinking_level', nextLevel)
      store.setThinkingLevelChoice(nextLevel)
      await store.flush()
      return nextLevel
    },

    compact(sessionId: string, instructions?: string) {
      return withSessionLock(sessionId, async () => {
        assertIdle(sessionId, 'compacting')
        const row = state.db.get<{ project_id: string | null }>(
          'SELECT project_id FROM sessions WHERE id = ?',
          sessionId,
        )
        if (!row) throw new Error(`Session ${sessionId} not found`)
        const { store, saved } = await loadStore(sessionId)
        const controller = new AbortController()
        const messages: ModelMessage[] = [...(saved?.messages ?? [])]
        const prepared = await prepareSessionSetup({
          state,
          sessionId,
          projectId: row.project_id,
          saved,
          store,
          messages,
          signal: controller.signal,
          attachMcp: false,
          allowNoModel: false,
        })
        try {
          const { contextManager } = buildTrackerAndContext({
            store,
            saved,
            prepared,
            sessionId,
            projectId: row.project_id,
          })
          const systemPrompt = prepared.builder.build({
            sessionId,
            activeTools: prepared.registry.getActiveTools(),
            deferredToolSummary: prepared.registry.getDeferredToolSummary(),
            extensionSections: prepared.runtimeSections,
          })
          const snapshot = await resolveRequestSnapshot(
            prepared.resolved!.model,
            systemPrompt,
            prepared.registry.toProviderTools(),
            messages,
            controller.signal,
            prepared.resolved!.info.maxTokens,
          )
          const beforeLeaf = store.getLeafId()
          await contextManager.compact(snapshot, instructions, 'manual')
          await store.flush()
          const entries = store.getBranch()
          const compEntry = entries
            .slice()
            .reverse()
            .find((e) => e.type === 'compaction')
          if (compEntry?.type !== 'compaction' || compEntry.id === beforeLeaf) {
            return undefined
          }
          return {
            summary: compEntry.summary,
            firstKeptEntryId: compEntry.firstKeptEntryId,
            tokensBefore: compEntry.tokensBefore,
            tokensAfter: contextManager.tracker.status.tokens,
            messages: 0,
          }
        } finally {
          await prepared.releaseSession()
        }
      })
    },

    ...treeControl,
    ...inspectAndBashControl,

    clearQueue(sessionId: string): { steering: string[] } {
      const dbQueued = clearPendingUserInbox(state.db, sessionId)
      const live = state.activeSteering.get(sessionId) ?? []
      if (live.length > 0) {
        state.activeSteering.set(sessionId, [])
      }
      const liveTexts = live
        .map((m) =>
          typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        )
        .filter((t) => t.trim().length > 0)
      return { steering: [...dbQueued, ...liveTexts] }
    },

    listJobs(sessionId?: string): BackgroundTask[] {
      if (sessionId) {
        return state.sessionBackgrounds.get(sessionId)?.tasks() ?? []
      }
      const all: BackgroundTask[] = []
      for (const bg of state.sessionBackgrounds.values()) {
        all.push(...bg.tasks())
      }
      return all
    },

    async stopJob(
      sessionId: string,
      jobId: string,
    ): Promise<BackgroundSnapshot> {
      const bg = state.sessionBackgrounds.get(sessionId)
      if (!bg) throw new Error(`Unknown background command ${jobId}`)
      return bg.stop(jobId)
    },

    async promoteForeground(
      sessionId: string,
      toolCallId?: string,
    ): Promise<string[]> {
      const bg = state.sessionBackgrounds.get(sessionId)
      if (!bg) return []
      return bg.detach(toolCallId)
    },

    async exportSession(
      sessionId: string,
      format: 'jsonl' | 'html',
      outputPath?: string,
      baseCwd?: string,
    ): Promise<string> {
      const { saved, store } = await loadStore(sessionId)
      const row = state.db.get<{ parent_session_id: string | null }>(
        'SELECT parent_session_id FROM sessions WHERE id = ?',
        sessionId,
      )
      const override = state.sessionOverrides.get(sessionId)
      const location = saved?.location ?? {
        environment: 'local' as const,
        cwd: baseCwd ?? override?.cwd ?? process.cwd(),
      }
      return exportBranch({
        id: sessionId,
        baseCwd: baseCwd ?? override?.cwd ?? process.cwd(),
        location,
        path: outputPath,
        entries: store.getBranch(),
        name: saved?.name,
        model: saved?.model,
        channel: saved?.channel,
        parentSession: row?.parent_session_id ?? undefined,
        format,
      })
    },

    async flushPendingBash(
      sessionId: string,
      store: SessionStore,
      messages: ModelMessage[],
      tracker: TokenTracker,
    ): Promise<boolean> {
      const pending = state.pendingBashBySession.get(sessionId)
      if (!pending?.length) return false
      state.pendingBashBySession.delete(sessionId)
      for (const entry of pending) {
        const msg = entry.excludeFromContext
          ? undefined
          : ({
              role: 'user',
              content: bashExecutionToText(entry),
            } satisfies ModelMessage)
        store.appendBashExecution(entry, msg)
        if (msg) {
          messages.push(msg)
          tracker.addMessage(msg)
        }
      }
      await store.flush()
      return true
    },

    async closeSession(sessionId: string): Promise<void> {
      const cachedRunner = state.sessionRunners.get(sessionId)
      if (cachedRunner) {
        state.sessionRunners.delete(sessionId)
        await retireOrDisposeCachedRunner(cachedRunner)
      }
      state.sessionResourceSnapshots.delete(sessionId)
      state.sessionOverrides.delete(sessionId)
      state.sessionActiveTools.delete(sessionId)
      const special = state.specialModels.get(sessionId)
      if (special) {
        state.specialModels.delete(sessionId)
        await special.flush?.().catch(() => {})
      }
      const bg = state.sessionBackgrounds.get(sessionId)
      if (bg) {
        state.sessionBackgrounds.delete(sessionId)
        await bg.stopAll().catch(() => {})
      }
      const dream = state.activeDreams.get(sessionId)
      if (dream) {
        state.activeDreams.delete(sessionId)
        await dream.stop().catch(() => {})
      }
    },
  }
}
