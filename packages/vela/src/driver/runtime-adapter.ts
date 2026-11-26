import { join } from 'node:path'
import { clampThinkingLevel } from '../providers/models/catalog.ts'
import {
  DEFAULT_THINKING_LEVEL,
  limitsForModel,
  ModelRegistry,
  reasoningOption,
  resolveModelInput,
  THINKING_LEVELS,
} from '../providers/models/index.ts'
import { getActiveChannelForSession } from '../runtime/control-ops.ts'
import type { SessionRecord } from '../runtime/domain.ts'
import {
  type AgentDriver,
  assertSafePathSegment,
  type DriverTurnRequest,
  type DriverTurnResult,
} from '../runtime/driver.ts'
import { MEMORY_RULES, MemoryRegistry } from '../runtime/memory/index.ts'
import { silentLogger } from '../shared/logger.ts'
import { ContextManager } from './context/manager.ts'
import { resolveRequestSnapshot } from './context/request.ts'
import { createSessionLocalExecutionEnv } from './execution/local.ts'
import type { ExecutionEnv, ExecutionLocation } from './execution/types.ts'
import type { MemoryDream } from './memory/dream.ts'
import {
  type AssistantModelMessage,
  type ModelMessage,
  withoutForeignReasoning,
} from './messages.ts'
import { localDateString } from './prompt/environment.ts'
import {
  createRuntimeBackgroundController,
  type RuntimeBackgroundController,
} from './runtime-background.ts'
import {
  recordRuntimeDreamTurn,
  scheduleRuntimeAutoDream,
} from './runtime-dream.ts'
import {
  buildRuntimePromptSections,
  runtimeToolModifiers,
} from './runtime-prompt.ts'
import {
  loadTrustedRuntimeResources,
  resolveRuntimeMemoryStores,
} from './runtime-resources.ts'
import { createRuntimeSessionToolRegistry } from './runtime-tools.ts'
import {
  applyRuntimeProjectToolSelection,
  assistantText,
  createRuntimeEventForwarder,
  flushUnconsumedSteering,
  prepareRuntimeTurnMessages,
  resolveRunInputMeta,
  resolveRunSilenceAndDepth,
} from './runtime-turn.ts'
import type {
  ActiveRunMeta,
  RuntimeMcpAdapter,
  RuntimeMcpLease,
  VelaAgentDriverOptions,
} from './runtime-types.ts'
import {
  resolveRunProducer,
  runPostTurnCompaction,
} from './session/defaults.ts'
import { SessionStore } from './session/index.ts'
import { createSessionPrompt } from './session/prompt-builder.ts'
import { pendingToolCalls } from './session/recovery.ts'
import { repairStoppedPendingToolStepInTx } from './step-recovery.ts'
import type { ToolRegistry } from './tools/registry.ts'
import { CONTEXT_WINDOW, TokenTracker } from './usage/tracker.ts'
import { VelaDriver } from './vela-driver.ts'

export type { RuntimeMcpAdapter, RuntimeMcpLease, VelaAgentDriverOptions }

/**
 * Bridges `Runtime`'s driver-agnostic `AgentDriver` contract onto `VelaDriver`
 * (step-durable SQLite transactions, `SessionStore`, `ToolRegistry`, and `EnvironmentRegistry`).
 */
export function createVelaAgentDriver(
  options: VelaAgentDriverOptions,
): AgentDriver {
  const logger = options.logger ?? silentLogger
  const models =
    options.models ?? new ModelRegistry(options.providers, options.credentials)
  const memoryRegistry = options.memoryRegistry ?? new MemoryRegistry(logger)
  const activeAbort = new Map<string, AbortController>()
  const activeSteering = new Map<string, ModelMessage[]>()
  const activeRunMeta = new Map<string, ActiveRunMeta>()
  const sessionBackgrounds = new Map<string, RuntimeBackgroundController>()
  const activeDreams = new Map<string, MemoryDream>()
  const pendingDreamTasks = new Set<Promise<void>>()
  const activeMcpLeases = new Set<RuntimeMcpLease>()
  const activeTurns = new Set<Promise<DriverTurnResult>>()
  const disposeController = new AbortController()
  let disposed = false

  return {
    name: 'vela',
    capabilities: {
      recovery: 'step',
      executionEnv: 'managed',
      steer: true,
      approval: true,
    },
    steer(sessionId, text) {
      const list = activeSteering.get(sessionId)
      if (!list) return false
      list.push({ role: 'user', content: text })
      return true
    },
    abort(sessionId) {
      activeAbort
        .get(sessionId)
        ?.abort(new DOMException('Stopped', 'AbortError'))
    },
    async waitForBackground() {
      while (pendingDreamTasks.size > 0) {
        await Promise.allSettled([...pendingDreamTasks])
      }
    },
    async dispose() {
      if (disposed) return
      disposed = true
      disposeController.abort(new DOMException('Driver disposed', 'AbortError'))
      for (const controller of activeAbort.values()) {
        controller.abort(new DOMException('Driver disposed', 'AbortError'))
      }
      await Promise.allSettled([...activeTurns])
      await Promise.allSettled([...activeDreams.values()].map((d) => d.stop()))
      await Promise.allSettled([...pendingDreamTasks])
      activeDreams.clear()
      await Promise.allSettled(
        [...sessionBackgrounds.values()].map((bg) => bg.stopAll()),
      )
      sessionBackgrounds.clear()
      await Promise.allSettled(
        [...activeMcpLeases].map((lease) => lease.release()),
      )
      activeMcpLeases.clear()
      await options.mcp?.dispose?.()
    },
    runTurn(request: DriverTurnRequest): Promise<DriverTurnResult> {
      const promise = runSingleTurn(request)
      activeTurns.add(promise)
      void promise.then(
        () => activeTurns.delete(promise),
        () => activeTurns.delete(promise),
      )
      return promise
    },
  }

  async function runSingleTurn(
    request: DriverTurnRequest,
  ): Promise<DriverTurnResult> {
    if (disposed) {
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
    activeAbort.set(request.sessionId, controller)
    activeSteering.set(request.sessionId, [])
    const deferredSteering: ModelMessage[] = []
    let waitingHuman = false
    const flushSteering = (wake: boolean): void => {
      const live = activeSteering.get(request.sessionId)
      activeSteering.delete(request.sessionId)
      flushUnconsumedSteering({
        db: options.db,
        sessionId: request.sessionId,
        projectId: request.projectId,
        unconsumed: [...deferredSteering.splice(0), ...(live ?? [])],
        wake,
        shouldWakeSession: !waitingHuman && !disposed,
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
    let registry: ToolRegistry | undefined
    let mcpLease: RuntimeMcpLease | undefined
    let lastAssistant: AssistantModelMessage | undefined
    let committedInTx = false
    let isSilent = false

    try {
      const activeStore = new SessionStore(request.sessionId, options.db, {
        blobsDir: options.blobs.rootDir,
        logger,
      })
      store = activeStore
      const saved = await activeStore.loadSaved()
      const cwd = saved?.location?.cwd ?? process.cwd()
      const location: ExecutionLocation = saved?.location ?? {
        environment: 'local',
        cwd,
      }
      const boundChannel =
        getActiveChannelForSession(
          options.db,
          request.sessionId,
          request.runId,
        ) ?? saved?.channel
      const hasChannelBinding = Boolean(boundChannel)
      const modelInput =
        saved?.model ?? options.defaultModel ?? models.defaultRef(boundChannel)
      if (!modelInput) {
        throw new Error(`No model configured for session ${request.sessionId}`)
      }
      const resolved = resolveModelInput(models, modelInput, () => boundChannel)
      const thinkingLevel =
        saved?.thinkingLevel ??
        options.defaultThinkingLevel ??
        DEFAULT_THINKING_LEVEL

      const spillDir = join(
        options.agentDir,
        'sessions',
        request.sessionId,
        'tool-results',
      )
      const resolveEnv = async (): Promise<ExecutionEnv> => {
        if (location.environment === 'local') {
          return createSessionLocalExecutionEnv({
            cwd: location.cwd,
            tempRoot: spillDir,
          })
        }
        const resolvedEnv = await options.environments.resolve({
          sessionId: request.sessionId,
          location,
        })
        if (!resolvedEnv) {
          throw new Error(
            `Execution environment unavailable for ${location.environment}:${location.cwd}`,
          )
        }
        return resolvedEnv
      }

      const inputMeta = resolveRunInputMeta(options.db, request)
      const runState = resolveRunSilenceAndDepth(
        options.db,
        request.runId,
        inputMeta.handoffDepth ?? 0,
      )
      isSilent = runState.isSilent
      activeRunMeta.set(request.sessionId, {
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

      const sessionRow = options.db.get<{ kind: string; created_at: string }>(
        'SELECT kind, created_at FROM sessions WHERE id = ?',
        request.sessionId,
      )
      const sessionKind = (sessionRow?.kind ??
        (request.projectId ? 'work' : 'chat')) as SessionRecord['kind']
      const networkMode = options.environments.networkMode(location.environment)

      const memoryStores = resolveRuntimeMemoryStores({
        registry: memoryRegistry,
        agentDir: options.agentDir,
        projectId: request.projectId,
        cwd: location.cwd,
      })

      const trustOverride = options.trustOverride
        ? await options.trustOverride(location)
        : undefined
      const resources = await loadTrustedRuntimeResources({
        db: options.db,
        agentDir: options.agentDir,
        trustDataDir: options.environments.dataDir,
        location,
        resolveEnv,
        signal: controller.signal,
        systemPrompt: options.systemPrompt,
        appendSystemPrompt: options.appendSystemPrompt,
        hostContextFiles: options.contextFiles,
        hostSkills: options.skills,
        hostPromptTemplates: options.promptTemplates,
        hostEnv: options.hostEnv,
        trustOverride,
      })

      registry = createRuntimeSessionToolRegistry({
        spillDir,
        cwd: location.cwd,
        logger,
        memoryGlobal: memoryStores.global,
        memoryLocal: () => memoryStores.local,
        webConfig: options.extensionConfig?.web,
        hostEnv: options.hostEnv,
        offline: options.offline,
        ...(options.timers && options.subscriptions && options.eventBus
          ? {
              runtimeToolDeps: {
                db: options.db,
                blobs: options.blobs,
                eventBus: options.eventBus,
                timers: options.timers,
                subscriptions: options.subscriptions,
                scheduleSession:
                  request.wakeSession ?? options.wakeSession ?? (() => {}),
                flushOutbox: request.flushOutbox ?? options.flushOutbox,
                getRunContext: (sid) => activeRunMeta.get(sid),
              },
            }
          : {}),
        extraTools: options.tools,
      })

      if (options.mcp) {
        mcpLease = await options.mcp.attach({
          registry,
          agentDir: options.agentDir,
          cwd: location.cwd,
          environment: location.environment,
          trusted: resources.trusted,
          env: options.hostEnv,
          discoveredTools: saved?.discoveredTools,
          signal: controller.signal,
        })
        activeMcpLeases.add(mcpLease)
      }

      if (boundChannel) {
        registry.setChannel(boundChannel)
      }
      registry.setRestrictedNetwork(networkMode !== 'on')
      const baseModifiers = runtimeToolModifiers({
        kind: sessionKind,
        projectId: request.projectId,
        hasChannelBinding,
        networkMode,
      })
      applyRuntimeProjectToolSelection(
        options.db,
        registry,
        request.projectId,
        baseModifiers,
      )
      if (saved?.discoveredTools.length) {
        registry.discoveredTools = new Set(saved.discoveredTools)
      }

      let bgController = sessionBackgrounds.get(request.sessionId)
      if (!bgController) {
        bgController = createRuntimeBackgroundController({
          db: options.db,
          sessionId: request.sessionId,
          runId: request.runId,
          wakeSession: request.wakeSession ?? options.wakeSession,
          location,
        })
        sessionBackgrounds.set(request.sessionId, bgController)
      } else {
        bgController.setRunContext({
          runId: request.runId,
          wakeSession: request.wakeSession ?? options.wakeSession,
          location,
        })
      }
      registry.background = bgController
      registry.setInterception({
        resolveEnv: () => resolveEnv(),
        before: async (toolName, input, ctx) => {
          if (toolName === 'tool_search' && mcpLease) {
            await mcpLease.waitForAll(controller.signal)
          }
          if (!options.toolApprovalCheck) return { input }
          const decision = await options.toolApprovalCheck(
            toolName,
            input,
            ctx.sessionId ?? request.sessionId,
          )
          if (decision?.requireApproval) {
            return {
              input,
              approval: {
                required: true,
                summary: decision.summary ?? `Approve ${toolName} execution`,
              },
            }
          }
          return { input }
        },
      })

      const tracker = new TokenTracker((record) =>
        activeStore.recordUsageRecord(record, { runId: request.runId }),
      )
      tracker.setModel(
        resolved.info.contextWindow ?? CONTEXT_WINDOW,
        resolved.info.cost,
        { keepCalibration: true },
      )
      const messages: ModelMessage[] = [...(saved?.messages ?? [])]
      for (const m of messages) tracker.addMessage(m)
      if (saved?.latestAssistantUsage) {
        tracker.restoreCalibration(
          saved.latestAssistantUsage.inputTokens,
          saved.latestAssistantUsage.outputTokens,
          saved.latestAssistantUsage.trailingMessages,
        )
      }
      const effectiveLimits = limitsForModel(resolved.info, options.limits)
      const forwardEvent = createRuntimeEventForwarder(request, (msg) => {
        lastAssistant = msg
      })
      const contextManager = new ContextManager(
        activeStore,
        tracker,
        { messages, timestamps: new Map(), summary: '' },
        forwardEvent,
        effectiveLimits,
      )

      const activeTools = registry.getActiveTools()
      const activeToolNames = new Set(activeTools.map((tool) => tool.name))
      const memoryActive = activeToolNames.has('memory')

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

      const deferWaitForInput =
        alreadyHasRunMessages && pendingToolCalls(messages).length > 0
      const prepareTurnMessages = (defer: boolean) =>
        prepareRuntimeTurnMessages({
          db: options.db,
          blobs: options.blobs,
          store: activeStore,
          tracker,
          request,
          messages,
          memoryActive,
          memoryStores,
          resolveEnv,
          signal: controller.signal,
          skills: resources.skills,
          promptTemplates: resources.promptTemplates,
          onlyWaitForInput: alreadyHasRunMessages,
          deferWaitForInput: defer,
        })
      let turnUserMsg = await prepareTurnMessages(deferWaitForInput)

      const pinnedDate = localDateString(
        new Date(sessionRow?.created_at ?? Date.now()),
      )
      const builder = createSessionPrompt(
        () => ({
          systemPrompt: resources.systemPrompt,
          appendSystemPrompt: resources.appendSystemPrompt,
          contextFiles: resources.contextFiles,
          skills: resources.skills,
          promptTemplates: resources.promptTemplates,
        }),
        () => location.cwd,
        () => undefined,
        location.environment === 'local' ? options.docsPaths : false,
        () => location.environment === 'local',
        () => options.environments.osFor(location.environment),
        () => pinnedDate,
      )
      const runtimeSections = {
        ...buildRuntimePromptSections({
          kind: sessionKind,
          projectId: request.projectId,
          hasChannelBinding,
          activeTools: activeToolNames,
        }),
        ...(memoryActive ? { memory: MEMORY_RULES } : {}),
      }

      committedInTx = false
      let recordedDreamInTx = false
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
      const buildSystemPrompt = () =>
        builder.build({
          sessionId: request.sessionId,
          activeTools: activeRegistry.getActiveTools(),
          deferredToolSummary: activeRegistry.getDeferredToolSummary(),
          extensionSections: runtimeSections,
        })
      const buildSnapshot = (sig?: AbortSignal) =>
        resolveRequestSnapshot(
          resolved.model,
          buildSystemPrompt(),
          activeRegistry.toProviderTools(),
          messages,
          sig,
          resolved.info.maxTokens,
        )
      const result = await driver.run({
        model: resolved.model,
        producer: () =>
          resolveRunProducer(
            resolved.model,
            modelInput,
            resolved.info.provider,
            boundChannel,
            (provider, channel) => models.authMode(provider, channel),
          ),
        systemPrompt: buildSystemPrompt,
        messages,
        prepareContext: (snapshot) => contextManager.prepare(snapshot),
        transformContext: async (msgs, producerForAttempt) =>
          withoutForeignReasoning(
            msgs,
            producerForAttempt,
            activeStore.producers,
          ),
        trigger: request.trigger,
        claim,
        supportsImages: resolved.info.input?.includes('image') ?? true,
        maxOutputTokens: resolved.info.maxTokens,
        reasoning: reasoningOption(
          clampThinkingLevel(thinkingLevel, resolved.info, THINKING_LEVELS),
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
          (activeSteering.get(request.sessionId)?.length ?? 0) > 0,
        takeSteering: () => {
          const list = activeSteering.get(request.sessionId) ?? []
          activeSteering.set(request.sessionId, [])
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
              const live = activeSteering.get(request.sessionId)
              if (live?.length) deferredSteering.push(...live)
              activeSteering.delete(request.sessionId)
              lastAssistant = assistant
              committedInTx = true
              if (memoryActive && !isSilent && !disposed) {
                recordRuntimeDreamTurn({
                  db: options.db,
                  activeDreams,
                  localStore: memoryStores.local,
                  projectId: request.projectId,
                  sessionId: request.sessionId,
                  userEntryId: turnUserMsg.userEntryId,
                  hasHumanText: turnUserMsg.hasHumanText,
                })
                recordedDreamInTx = true
              }
              request.onTerminalCommitInTx?.({
                status: 'completed',
                replyText: assistantText(assistant),
                silent: isSilent,
              })
            }
          : undefined,
      })
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
        enabled: contextManager.autoCompaction && !isSilent && !disposed,
        signal: controller.signal,
        isDraining: () => disposed,
        buildSnapshot: () => buildSnapshot(controller.signal),
        compactIfNeeded: (req) => contextManager.compactIfNeeded(req),
        warn: (msg) => logger.warn(`[runtime] auto-compaction skipped: ${msg}`),
      })

      if (memoryActive && !isSilent && !disposed) {
        if (!recordedDreamInTx) {
          recordRuntimeDreamTurn({
            db: options.db,
            activeDreams,
            localStore: memoryStores.local,
            projectId: request.projectId,
            sessionId: request.sessionId,
            userEntryId: turnUserMsg.userEntryId,
            hasHumanText: turnUserMsg.hasHumanText,
          })
        }
        scheduleRuntimeAutoDream({
          db: options.db,
          activeDreams,
          pendingDreamTasks,
          localStore: memoryStores.local,
          projectId: request.projectId,
          sessionId: request.sessionId,
          dreamEnabled: options.dreamEnabled,
          resolved,
          tracker,
          resolveEnv,
          signal: disposeController.signal,
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
      return {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      try {
        flushSteering(!controller.signal.aborted)
      } catch (error) {
        logger.warn(
          `[runtime] failed preserving unconsumed steer inputs for ${request.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (store && registry) {
        store.setDiscoveredTools(registry.discoveredTools)
      }
      if (claim && !releasedClaim) claim.release()
      request.abortSignal.removeEventListener('abort', forwardAbort)
      activeAbort.delete(request.sessionId)
      activeSteering.delete(request.sessionId)
      activeRunMeta.delete(request.sessionId)
      if (mcpLease) {
        activeMcpLeases.delete(mcpLease)
        await mcpLease.release().catch(() => {})
      }
      if (registry) {
        await registry.waitForIdle().catch(() => {})
      }
    }
  }
}
