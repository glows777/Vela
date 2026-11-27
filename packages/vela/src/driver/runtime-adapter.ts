import { clampThinkingLevel } from '../providers/models/catalog.ts'
import {
  limitsForModel,
  ModelRegistry,
  reasoningOption,
  resolveModel,
  THINKING_LEVELS,
} from '../providers/models/index.ts'
import {
  type AgentDriver,
  assertSafePathSegment,
  type DriverTurnRequest,
  type DriverTurnResult,
} from '../runtime/driver.ts'
import { MemoryRegistry } from '../runtime/memory/index.ts'
import { errorMessage, silentLogger } from '../shared/logger.ts'
import type { ModelInput } from '../shared/provider-types.ts'
import type { VelaEvent } from './agent/events.ts'
import { classifyAgentError, failureHint } from './agent/retry.ts'
import { ContextManager } from './context/manager.ts'
import { resolveRequestSnapshot } from './context/request.ts'
import type { AssistantModelMessage, ModelMessage } from './messages.ts'
import { createRuntimeBackgroundController } from './runtime-background.ts'
import {
  createRuntimeControl,
  type RuntimeControlHandle,
} from './runtime-control.ts'
import {
  recordRuntimeDreamTurn,
  scheduleRuntimeAutoDream,
} from './runtime-dream.ts'
import { createRuntimeEventForwarder } from './runtime-events.ts'
import {
  createExtensionSessionView,
  RuntimeExtensionHost,
} from './runtime-extensions.ts'
import {
  type DriverSharedState,
  disposeDriverSharedState,
  type PreparedSessionEnv,
  prepareSessionSetup,
  resolveSessionModels,
} from './runtime-session-setup.ts'
import {
  assistantText,
  flushUnconsumedSteering,
  prepareRuntimeTurnMessages,
  resolveRunInputMeta,
  resolveRunSilenceAndDepth,
} from './runtime-turn.ts'
import {
  applyBeforeAgentStartHooks,
  applyInputExtensionHooks,
  wireRuntimeToolInterception,
  wrapModelWithExtensionHooks,
} from './runtime-turn-hooks.ts'
import type {
  RuntimeMcpAdapter,
  RuntimeMcpLease,
  VelaAgentDriverOptions,
} from './runtime-types.ts'
import {
  resolveRunProducer,
  runPostTurnCompaction,
} from './session/defaults.ts'
import { SessionStore } from './session/index.ts'
import { pendingToolCalls } from './session/recovery.ts'
import { repairStoppedPendingToolStepInTx } from './step-recovery.ts'
import { CONTEXT_WINDOW, TokenTracker } from './usage/tracker.ts'
import { VelaDriver } from './vela-driver.ts'

export type { RuntimeMcpAdapter, RuntimeMcpLease, VelaAgentDriverOptions }

export type VelaAgentDriverHandle = AgentDriver & {
  control: RuntimeControlHandle
}

/**
 * Bridges `Runtime`'s driver-agnostic `AgentDriver` contract onto `VelaDriver`
 * (step-durable SQLite transactions, `SessionStore`, `ToolRegistry`, `ExtensionRunner`,
 * and `EnvironmentRegistry`).
 */
export function createVelaAgentDriver(
  options: VelaAgentDriverOptions,
): VelaAgentDriverHandle {
  const logger = options.logger ?? silentLogger
  const models =
    options.models ??
    new ModelRegistry(
      options.providers,
      options.credentials,
      options.registrations,
    )
  const memoryRegistry = options.memoryRegistry ?? new MemoryRegistry(logger)

  const state: DriverSharedState = {
    options,
    db: options.db,
    logger,
    models,
    registrations: options.registrations,
    rawConfigProviders: options.rawConfigProviders,
    memoryRegistry,
    extHost: new RuntimeExtensionHost({
      agentDir: options.agentDir,
      models,
      logger,
      onBeforeImport: options.onBeforeExtensionImport,
    }),
    reloadable: {
      defaultModel: options.defaultModel,
      defaultThinkingLevel: options.defaultThinkingLevel,
      providers: options.providers,
      rawConfigProviders: options.rawConfigProviders,
      limits: options.limits,
      defaultTools: options.defaultTools,
      extensionConfig: options.extensionConfig,
      extensions: options.extensions,
      enabledModels: options.enabledModels,
      githubRepositories: options.githubRepositories,
      dreamEnabled: options.dreamEnabled,
      offline: options.offline ?? false,
    },
    sessionOverrides: new Map(),
    specialModels: new Map(),
    sessionRunners: new Map(),
    sessionRunnerLocks: new Map(),
    sessionActiveTools: new Map(),
    sessionResourceSnapshots: new Map(),
    activeAbort: new Map(),
    activeSteering: new Map(),
    activeRunMeta: new Map(),
    sessionBackgrounds: new Map(),
    pendingBashBySession: new Map(),
    activeBash: new Map(),
    activeBashPromises: new Set(),
    activeDreams: new Map(),
    pendingDreamTasks: new Set(),
    activeMcpLeases: new Set(),
    activeTurns: new Set(),
    disposeController: new AbortController(),
    disposed: false,
  }

  void state.extHost.reload({
    configured: options.extensions,
    extensionConfig: options.extensionConfig ?? {},
  })

  const control = createRuntimeControl(state)

  return {
    name: 'vela',
    control,
    capabilities: {
      recovery: 'step',
      executionEnv: 'managed',
      steer: true,
      approval: true,
    },
    steer(sessionId, text, images) {
      const list = state.activeSteering.get(sessionId)
      if (!list) return false
      if (images && images.length > 0) {
        const parts: Array<
          | { type: 'text'; text: string }
          | { type: 'image'; data: string; mimeType: string }
        > = []
        if (text) parts.push({ type: 'text', text })
        for (const img of images) {
          parts.push({ type: 'image', data: img.data, mimeType: img.mimeType })
        }
        list.push({ role: 'user', content: parts })
      } else {
        list.push({ role: 'user', content: text })
      }
      return true
    },
    abort(sessionId) {
      state.activeAbort
        .get(sessionId)
        ?.abort(new DOMException('Stopped', 'AbortError'))
    },
    async waitForBackground() {
      while (state.pendingDreamTasks.size > 0) {
        await Promise.allSettled([...state.pendingDreamTasks])
      }
    },
    dispose() {
      return disposeDriverSharedState(state)
    },
    runTurn(request: DriverTurnRequest): Promise<DriverTurnResult> {
      const promise = runSingleTurn(request)
      state.activeTurns.add(promise)
      void promise.then(
        () => state.activeTurns.delete(promise),
        () => state.activeTurns.delete(promise),
      )
      return promise
    },
  }

  async function maybeResolveImplicitSpecialModel(
    sessionId: string,
    savedModel?: string,
  ): Promise<void> {
    if (state.specialModels.has(sessionId) || !options.resolveSpecialModel) {
      return
    }
    const override = state.sessionOverrides.get(sessionId)
    const envRecord = override?.recordPath ?? options.hostEnv?.VELA_RECORD
    const defaultModelStr =
      typeof state.reloadable.defaultModel === 'string'
        ? state.reloadable.defaultModel
        : undefined
    const envModel =
      override?.model ?? defaultModelStr ?? options.hostEnv?.VELA_MODEL
    if (!envRecord && envModel !== 'mock' && !envModel?.startsWith('faux:')) {
      return
    }
    let fallbackModel: ModelInput | undefined
    if (envRecord && envModel !== 'mock' && !envModel?.startsWith('faux:')) {
      const activeModels = resolveSessionModels(state, override)
      const candidate =
        override?.model ?? savedModel ?? state.reloadable.defaultModel
      fallbackModel = resolveModel(candidate, {
        providers: activeModels.providerDefinitions(),
        credentials: activeModels.credentials,
      })
    }
    const special = await options.resolveSpecialModel({
      modelRef: envModel,
      recordPath: envRecord,
      fallbackModel,
    })
    if (special) {
      state.specialModels.set(sessionId, special)
    }
  }

  async function runSingleTurn(
    request: DriverTurnRequest,
  ): Promise<DriverTurnResult> {
    if (state.disposed) {
      return { status: 'stopped' }
    }
    assertSafePathSegment(request.sessionId, 'sessionId')
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(request.abortSignal.reason)
    if (request.abortSignal.aborted) {
      controller.abort(request.abortSignal.reason)
    } else {
      request.abortSignal.addEventListener('abort', forwardAbort, {
        once: true,
      })
    }
    state.activeAbort.set(request.sessionId, controller)
    state.activeSteering.set(request.sessionId, [])
    const deferredSteering: ModelMessage[] = []
    let waitingHuman = false
    const flushSteering = (wake: boolean): void => {
      const live = state.activeSteering.get(request.sessionId)
      state.activeSteering.delete(request.sessionId)
      flushUnconsumedSteering({
        db: options.db,
        sessionId: request.sessionId,
        projectId: request.projectId,
        unconsumed: [...deferredSteering.splice(0), ...(live ?? [])],
        wake,
        shouldWakeSession: !waitingHuman && !state.disposed,
        wakeSession: request.wakeSession ?? options.wakeSession,
      })
    }

    let releasedClaim = false
    let claim:
      | {
          runId: string
          ownerToken: string
          resumedFromWaitingHuman: boolean
          release: () => void
        }
      | undefined
    let store: SessionStore | undefined
    let prepared: PreparedSessionEnv | undefined
    let lastAssistant: AssistantModelMessage | undefined
    let committedInTx = false
    let isSilent = false
    let systemPromptOverride: string | undefined

    try {
      const activeStore = new SessionStore(request.sessionId, options.db, {
        blobsDir: options.blobs.rootDir,
        logger,
      })
      store = activeStore
      const saved = await activeStore.loadSaved()

      await maybeResolveImplicitSpecialModel(request.sessionId, saved?.model)

      const inputMeta = resolveRunInputMeta(options.db, request)
      const runState = resolveRunSilenceAndDepth(
        options.db,
        request.runId,
        inputMeta.handoffDepth ?? 0,
      )
      isSilent = runState.isSilent
      state.activeRunMeta.set(request.sessionId, {
        runId: request.runId,
        projectId: request.projectId,
        replyToMessageId: inputMeta.replyToMessageId,
        handoffDepth: runState.handoffDepth,
        channelTarget: inputMeta.channelTarget,
        humanProvenance: inputMeta.humanProvenance,
        attachments: inputMeta.attachments,
        markSilent: () => {
          isSilent = true
          runState.markSilent()
        },
      })

      const messages: ModelMessage[] = [...(saved?.messages ?? [])]
      const buildSystemPrompt = () =>
        systemPromptOverride ??
        (prepared
          ? prepared.builder.build({
              sessionId: request.sessionId,
              activeTools: prepared.registry.getActiveTools(),
              deferredToolSummary: prepared.registry.getDeferredToolSummary(),
              extensionSections: prepared.runtimeSections,
            })
          : '')

      prepared = await prepareSessionSetup({
        state,
        sessionId: request.sessionId,
        projectId: request.projectId,
        runId: request.runId,
        saved,
        store: activeStore,
        messages,
        signal: controller.signal,
        attachMcp: true,
        allowNoModel: false,
        buildSystem: buildSystemPrompt,
        wakeSession: request.wakeSession,
        flushOutbox: request.flushOutbox,
      })

      if (!prepared.resolved) {
        throw new Error(
          prepared.modelError ??
            `No model configured for session ${request.sessionId}`,
        )
      }
      const resolved = prepared.resolved
      const registry = prepared.registry
      const extensionRunner = prepared.extensionRunner

      let bgController = state.sessionBackgrounds.get(request.sessionId)
      if (!bgController) {
        bgController = createRuntimeBackgroundController({
          db: options.db,
          sessionId: request.sessionId,
          runId: request.runId,
          wakeSession: request.wakeSession ?? options.wakeSession,
          location: prepared.location,
        })
        state.sessionBackgrounds.set(request.sessionId, bgController)
      } else {
        bgController.setRunContext({
          runId: request.runId,
          wakeSession: request.wakeSession ?? options.wakeSession,
          location: prepared.location,
        })
      }
      registry.background = bgController

      const extView = createExtensionSessionView({
        sessionId: request.sessionId,
        cwd: prepared.location.cwd,
        name: prepared.sessionName,
        channel: prepared.boundChannel,
        messages,
        registry,
        store: activeStore,
        eventBus: options.eventBus,
        runId: request.runId,
        projectId: request.projectId,
        signal: controller.signal,
        onSetActiveTools: (names) =>
          state.sessionActiveTools.set(
            request.sessionId,
            names ? [...names] : undefined,
          ),
        buildSystem: (sections) =>
          systemPromptOverride ??
          prepared!.builder.build({
            sessionId: request.sessionId,
            activeTools: registry.getActiveTools(),
            deferredToolSummary: registry.getDeferredToolSummary(),
            extensionSections: sections ?? prepared!.runtimeSections,
          }),
      })
      await prepared.ensureSessionStarted(extView)

      wireRuntimeToolInterception({
        registry,
        prepared,
        extensionRunner,
        extView,
        sessionId: request.sessionId,
        signal: controller.signal,
        toolApprovalCheck: options.toolApprovalCheck,
      })

      const tracker = new TokenTracker((record) =>
        activeStore.recordUsageRecord(record),
      )
      tracker.setModel(
        resolved.info.contextWindow ?? CONTEXT_WINDOW,
        resolved.info.cost,
        {
          keepCalibration: true,
        },
      )
      for (const message of messages) tracker.addMessage(message)
      if (saved?.latestAssistantUsage) {
        tracker.restoreCalibration(
          saved.latestAssistantUsage.inputTokens,
          saved.latestAssistantUsage.outputTokens,
          saved.latestAssistantUsage.trailingMessages,
        )
      }
      const effectiveLimits = limitsForModel(
        resolved.info,
        state.reloadable.limits,
      )
      const forwardBase = createRuntimeEventForwarder(request, (msg) => {
        lastAssistant = msg
      })
      const forwardEvent = (ev: VelaEvent) => {
        forwardBase(ev)
        extensionRunner.notify(ev, extView)
      }
      const contextManager = new ContextManager(
        activeStore,
        tracker,
        { messages, timestamps: new Map(), summary: '' },
        forwardEvent,
        effectiveLimits,
      )

      const alreadyHasRunMessages = Boolean(
        options.db.get<{ ok: number }>(
          `SELECT 1 AS ok FROM vela_messages WHERE session_id = ? AND run_id = ? AND kind = 'message' AND role = 'user' LIMIT 1`,
          request.sessionId,
          request.runId,
        ),
      )

      if (!request.recoverPending) {
        repairStoppedPendingToolStepInTx({
          db: options.db,
          store: activeStore,
          sessionId: request.sessionId,
          messages,
          runId: request.runId,
          onMessageCommittedInTx: (messageId, message) =>
            request.onEvent({
              type: 'message_committed',
              runId: request.runId,
              messageId,
              message,
            }),
        })
      }

      if (!alreadyHasRunMessages) {
        await control.flushPendingBash(
          request.sessionId,
          activeStore,
          messages,
          tracker,
        )
      }

      let effectiveRequest = request
      if (!alreadyHasRunMessages) {
        const hookRes = await applyInputExtensionHooks({
          extensionRunner,
          extView,
          request,
        })
        effectiveRequest = hookRes.request
        if (hookRes.handledAll) {
          return {
            status: 'completed',
            replyText: '',
            silent: true,
            committedInTx: false,
          }
        }
      }

      systemPromptOverride = await applyBeforeAgentStartHooks({
        extensionRunner,
        extView,
        prepared,
        request: effectiveRequest,
        activeStore,
        messages,
        tracker,
        alreadyHasRunMessages,
      })

      const deferWaitForInput =
        alreadyHasRunMessages && pendingToolCalls(messages).length > 0
      const prepareTurnMessages = (defer: boolean) =>
        prepareRuntimeTurnMessages({
          db: options.db,
          blobs: options.blobs,
          store: activeStore,
          tracker,
          request: effectiveRequest,
          messages,
          memoryActive: prepared!.memoryActive,
          memoryStores: prepared!.memoryStores,
          resolveEnv: prepared!.resolveEnv,
          signal: controller.signal,
          skills: prepared!.resources.skills,
          hostSkills: prepared!.resources.hostSkills,
          promptTemplates: prepared!.resources.promptTemplates,
          onlyWaitForInput: alreadyHasRunMessages,
          deferWaitForInput: defer,
        })
      let turnUserMsg = await prepareTurnMessages(deferWaitForInput)

      if (prepared.specialModel?.addInput) {
        const humanInput = effectiveRequest.inputs
          .filter((i) => i.source === 'user' || i.source === 'channel')
          .map((i) =>
            typeof i.payload.text === 'string' ? i.payload.text : '',
          )
          .filter(Boolean)
          .join('\n\n')
        if (humanInput) {
          prepared.specialModel.addInput(humanInput)
        }
      }

      committedInTx = false
      let attemptedDreamInTx = false
      const driver = new VelaDriver({
        sessionId: request.sessionId,
        db: options.db,
        store: activeStore,
        registry,
        tracker,
        onEvent: forwardEvent,
      })

      claim = {
        runId: request.runId,
        ownerToken: request.ownerToken,
        resumedFromWaitingHuman: request.recoverPending,
        release: () => {
          releasedClaim = true
        },
      }

      const activeRegistry = registry
      const buildSnapshot = (sig?: AbortSignal) =>
        resolveRequestSnapshot(
          resolved.model,
          buildSystemPrompt(),
          activeRegistry.toProviderTools(),
          messages,
          sig,
          resolved.info.maxTokens,
        )

      const turnModel = wrapModelWithExtensionHooks(
        resolved.model,
        extensionRunner,
        extView,
      )

      const result = await driver.run({
        model: turnModel,
        producer: () =>
          resolveRunProducer(
            resolved.model,
            prepared!.modelInput!,
            resolved.info.provider,
            prepared!.boundChannel,
            (provider, channel) =>
              prepared!.activeModels.authMode(provider, channel),
          ),
        systemPrompt: buildSystemPrompt,
        messages,
        prepareContext: (snapshot) => contextManager.prepare(snapshot),
        transformContext: (msgs, producerForAttempt) =>
          extensionRunner.transformContext(extView, msgs, producerForAttempt),
        trigger: request.trigger,
        claim,
        skipFinishRun: true,
        supportsImages: resolved.info.input?.includes('image') ?? true,
        maxOutputTokens: resolved.info.maxTokens,
        reasoning: reasoningOption(
          clampThinkingLevel(
            prepared.thinkingLevel,
            resolved.info,
            THINKING_LEVELS,
          ),
          resolved.info,
        ),
        limits: effectiveLimits,
        abortSignal: controller.signal,
        recoverPending: request.recoverPending,
        allowWaitingHuman: request.allowWaitingHuman,
        onRecoveryComplete: deferWaitForInput
          ? async () => {
              turnUserMsg = await prepareTurnMessages(false)
            }
          : undefined,
        compactOnOverflow: async (sig) => {
          await contextManager.compact(
            await buildSnapshot(sig),
            undefined,
            'overflow',
          )
        },
        hasSteering: () =>
          (state.activeSteering.get(request.sessionId)?.length ?? 0) > 0,
        takeSteering: () => {
          const list = state.activeSteering.get(request.sessionId) ?? []
          state.activeSteering.set(request.sessionId, [])
          return list
        },
        onMessageCommittedInTx: (messageId, message) => {
          request.onEvent({
            type: 'message_committed',
            runId: request.runId,
            messageId,
            message,
          })
        },
        onTerminalCommitInTx: request.onTerminalCommitInTx
          ? ({ assistant }) => {
              const live = state.activeSteering.get(request.sessionId)
              if (live?.length) deferredSteering.push(...live)
              state.activeSteering.delete(request.sessionId)
              lastAssistant = assistant
              if (prepared!.memoryActive && !isSilent && !state.disposed) {
                recordRuntimeDreamTurn({
                  db: options.db,
                  activeDreams: state.activeDreams,
                  localStore: prepared!.memoryStores.local,
                  projectId: request.projectId,
                  sessionId: request.sessionId,
                  userEntryId: turnUserMsg.userEntryId,
                  hasHumanText: turnUserMsg.hasHumanText,
                })
                attemptedDreamInTx = true
              }
              request.onTerminalCommitInTx?.({
                status: 'completed',
                replyText: assistantText(assistant),
                silent: isSilent,
              })
            }
          : undefined,
      })

      committedInTx = Boolean(result.committedInTx)
      const recordedDreamInTx = committedInTx && attemptedDreamInTx
      const waitingApproval = options.db.get<{ id: string }>(
        "SELECT id FROM approvals WHERE run_id = ? AND status = 'pending' LIMIT 1",
        request.runId,
      )
      if (result.reason === 'waiting_human' || waitingApproval) {
        waitingHuman = true
        flushSteering(true)
        return {
          status: 'waiting_human',
          replyText: assistantText(lastAssistant),
          silent: isSilent,
          committedInTx,
        }
      }
      flushSteering(!controller.signal.aborted)

      await runPostTurnCompaction({
        enabled: contextManager.autoCompaction && !isSilent && !state.disposed,
        signal: controller.signal,
        isDraining: () => state.disposed,
        buildSnapshot: () => buildSnapshot(controller.signal),
        compactIfNeeded: (req) => contextManager.compactIfNeeded(req),
        warn: (msg) => logger.warn(`[runtime] auto-compaction skipped: ${msg}`),
      })

      if (prepared.memoryActive && !isSilent && !state.disposed) {
        if (!recordedDreamInTx) {
          recordRuntimeDreamTurn({
            db: options.db,
            activeDreams: state.activeDreams,
            localStore: prepared.memoryStores.local,
            projectId: request.projectId,
            sessionId: request.sessionId,
            userEntryId: turnUserMsg.userEntryId,
            hasHumanText: turnUserMsg.hasHumanText,
          })
        }
        scheduleRuntimeAutoDream({
          db: options.db,
          activeDreams: state.activeDreams,
          pendingDreamTasks: state.pendingDreamTasks,
          localStore: prepared.memoryStores.local,
          projectId: request.projectId,
          sessionId: request.sessionId,
          dreamEnabled: state.reloadable.dreamEnabled,
          resolved,
          tracker,
          resolveEnv: prepared.resolveEnv,
          signal: state.disposeController.signal,
          logger,
        })
      }

      return {
        status: 'completed',
        replyText: assistantText(lastAssistant),
        silent: isSilent,
        committedInTx,
      }
    } catch (error) {
      if (committedInTx) {
        return {
          status: 'completed',
          replyText: assistantText(lastAssistant),
          silent: isSilent,
          committedInTx: true,
        }
      }
      if (controller.signal.aborted) {
        return { status: 'stopped' }
      }
      const errorKind = classifyAgentError(error)
      return {
        status: 'failed',
        error: errorMessage(error),
        errorKind,
        errorHint: failureHint(errorKind, error),
      }
    } finally {
      try {
        flushSteering(!controller.signal.aborted)
      } catch (error) {
        logger.warn(
          `[runtime] failed preserving unconsumed steer inputs for ${request.sessionId}: ${errorMessage(error)}`,
        )
      }
      if (prepared?.specialModel?.flush) {
        await prepared.specialModel.flush().catch((err) => {
          logger.warn(
            `[record] failed flushing recording: ${errorMessage(err)}`,
          )
        })
      }
      if (store && prepared?.registry) {
        store.setDiscoveredTools(prepared.registry.discoveredTools)
      }
      if (claim && !releasedClaim) claim.release()
      request.abortSignal.removeEventListener('abort', forwardAbort)
      state.activeAbort.delete(request.sessionId)
      state.activeSteering.delete(request.sessionId)
      state.activeRunMeta.delete(request.sessionId)
      if (prepared?.mcpLease) {
        state.activeMcpLeases.delete(prepared.mcpLease)
        await prepared.mcpLease.release().catch(() => {})
      }
      if (prepared?.registry) {
        await prepared.registry.waitForIdle().catch(() => {})
      }
      await prepared?.releaseSession().catch(() => {})
    }
  }
}
