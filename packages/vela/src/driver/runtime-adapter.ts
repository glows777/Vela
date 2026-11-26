import { join } from 'node:path'
import type { VelaDatabase } from '../db/index.ts'
import type { CredentialStore } from '../providers/auth/types.ts'
import { resolveProviderTools } from '../providers/index.ts'
import { clampThinkingLevel } from '../providers/models/catalog.ts'
import {
  DEFAULT_THINKING_LEVEL,
  describeModel,
  ModelRegistry,
  type ProviderDefinition,
  reasoningOption,
  THINKING_LEVELS,
  type ThinkingLevel,
} from '../providers/models/index.ts'
import { getActiveChannelForSession } from '../runtime/control-ops.ts'
import type { SessionRecord } from '../runtime/domain.ts'
import {
  type AgentDriver,
  assertSafePathSegment,
  type DriverTurnRequest,
  type DriverTurnResult,
} from '../runtime/driver.ts'
import type { RuntimeEventBus } from '../runtime/event-bus.ts'
import type { BlobStore, EnvironmentRegistry } from '../runtime/index.ts'
import { MEMORY_RULES, MemoryRegistry } from '../runtime/memory/index.ts'
import type { SubscriptionManager } from '../runtime/subscriptions.ts'
import type { TimerScheduler } from '../runtime/timers.ts'
import type { VelaLimits } from '../shared/limits.ts'
import { silentLogger, type VelaLogger } from '../shared/logger.ts'
import type { ModelInput } from '../shared/provider-types.ts'
import { ContextManager, createRequestSnapshot } from './context/manager.ts'
import { createSessionLocalExecutionEnv } from './execution/local.ts'
import type { ExecutionEnv, ExecutionLocation } from './execution/types.ts'
import { createBackgroundTools } from './extensions/background/tool.ts'
import { createMemoryTool } from './extensions/memory/tool.ts'
import { createTodoTool } from './extensions/todo/tool.ts'
import type { MemoryDream } from './memory/dream.ts'
import type { AssistantModelMessage, ModelMessage } from './messages.ts'
import type { ContextFile } from './prompt/context-files.ts'
import { localDateString } from './prompt/environment.ts'
import type { PromptTemplate } from './prompt/templates.ts'
import {
  createRuntimeBackgroundController,
  type RuntimeBackgroundController,
} from './runtime-background.ts'
import {
  buildRuntimePromptSections,
  runtimeToolModifiers,
} from './runtime-prompt.ts'
import {
  createRuntimeWebTools,
  loadTrustedRuntimeResources,
  resolveRuntimeMemoryStores,
} from './runtime-resources.ts'
import { createRuntimeTools } from './runtime-tools.ts'
import {
  assistantText,
  createRuntimeEventForwarder,
  prepareRuntimeTurnMessages,
  recordRuntimeDreamTurn,
  resolveRunInputMeta,
  resolveRunSilenceAndDepth,
  scheduleRuntimeAutoDream,
} from './runtime-turn.ts'
import { SessionStore } from './session/index.ts'
import { createSessionPrompt } from './session/prompt-builder.ts'
import type { SkillDefinition } from './skills/loader.ts'
import { repairStoppedPendingToolStepInTx } from './step-recovery.ts'
import { createCoreTools } from './tools/index.ts'
import { type ToolDefinition, ToolRegistry } from './tools/registry.ts'
import { registerToolSearchTool } from './tools/tool-search.ts'
import { TokenTracker } from './usage/tracker.ts'
import { VelaDriver } from './vela-driver.ts'

export interface RuntimeMcpLease {
  waitForAll: () => Promise<void>
  release: () => Promise<void>
}

export interface RuntimeMcpAdapter {
  attach: (options: {
    registry: ToolRegistry
    agentDir: string
    cwd: string
    environment: string
    trusted: boolean
    env?: Record<string, string | undefined>
    waitMs?: number
    discoveredTools?: readonly string[]
  }) => Promise<RuntimeMcpLease>
  dispose?: () => Promise<void>
}

export interface VelaAgentDriverOptions {
  db: VelaDatabase
  agentDir: string
  blobs: BlobStore
  environments: EnvironmentRegistry
  timers?: TimerScheduler
  subscriptions?: SubscriptionManager
  eventBus?: RuntimeEventBus
  wakeSession?: (sessionId: string) => void
  flushOutbox?: () => void
  mcp?: RuntimeMcpAdapter
  memoryRegistry?: MemoryRegistry
  defaultModel?: ModelInput
  defaultThinkingLevel?: ThinkingLevel
  providers?: Record<string, ProviderDefinition>
  credentials?: CredentialStore
  /** @internal Shared ModelRegistry (for live OAuth registrations & planLabel consistency). */
  models?: ModelRegistry
  limits?: Partial<VelaLimits>
  tools?: ToolDefinition[]
  extensionConfig?: Record<string, Record<string, unknown>>
  hostEnv?: Record<string, string | undefined>
  contextFiles?: readonly ContextFile[]
  skills?: readonly SkillDefinition[]
  promptTemplates?: readonly PromptTemplate[]
  offline?: boolean
  dreamEnabled?: boolean
  trustOverride?: (location: ExecutionLocation) => boolean | Promise<boolean>
  toolApprovalCheck?: (
    toolName: string,
    input: unknown,
    sessionId: string,
  ) =>
    | Promise<{ requireApproval?: boolean; summary?: string } | undefined>
    | { requireApproval?: boolean; summary?: string }
    | undefined
  logger?: VelaLogger
}

interface ActiveRunMeta {
  runId: string
  projectId: string | null
  replyToMessageId?: string
  handoffDepth?: number
  channelTarget?: { channel: string; externalChatId: string; threadId?: string }
  humanProvenance?: { inboxEventId: string; senderName?: string }
  attachments?: Array<{ blobId: string; name: string; mimeType?: string }>
  markSilent: () => void
}

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
  const activeMcpLeases = new Set<RuntimeMcpLease>()
  const activeTurns = new Set<Promise<DriverTurnResult>>()
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
      const list = activeSteering.get(sessionId) ?? []
      list.push({ role: 'user', content: text })
      activeSteering.set(sessionId, list)
    },
    abort(sessionId) {
      activeAbort
        .get(sessionId)
        ?.abort(new DOMException('Stopped', 'AbortError'))
    },
    async dispose() {
      if (disposed) return
      disposed = true
      for (const controller of activeAbort.values()) {
        controller.abort(new DOMException('Driver disposed', 'AbortError'))
      }
      await Promise.allSettled([...activeTurns])
      await Promise.allSettled([...activeDreams.values()].map((d) => d.stop()))
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
      const boundChannel = getActiveChannelForSession(
        options.db,
        request.sessionId,
        request.runId,
      )
      const hasChannelBinding = Boolean(boundChannel)
      const modelInput =
        saved?.model ?? options.defaultModel ?? models.defaultRef()
      if (!modelInput) {
        throw new Error(`No model configured for session ${request.sessionId}`)
      }
      const resolved =
        typeof modelInput === 'string'
          ? models.resolve(modelInput, { channel: () => boundChannel })
          : { model: modelInput, info: describeModel(modelInput) }
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
      let isSilent = runState.isSilent
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
        location,
        resolveEnv,
        signal: controller.signal,
        hostContextFiles: options.contextFiles,
        hostSkills: options.skills,
        hostPromptTemplates: options.promptTemplates,
        hostEnv: options.hostEnv,
        trustOverride,
      })

      registry = new ToolRegistry(spillDir)
      registry.setLogger(logger)
      registry.register(
        ...createCoreTools({ cwd: location.cwd }),
        ...createBackgroundTools((ctx) => {
          if (!ctx?.background) {
            throw new Error('Background commands require an open session')
          }
          return ctx.background
        }).map((tool) => ({ ...tool, name: `background_${tool.name}` })),
        createTodoTool(),
        createMemoryTool(memoryStores.global, () => memoryStores.local),
        ...createRuntimeWebTools({
          webConfig: options.extensionConfig?.web,
          hostEnv: options.hostEnv,
          offline: options.offline,
        }),
      )
      if (options.timers && options.subscriptions && options.eventBus) {
        registry.register(
          ...createRuntimeTools({
            db: options.db,
            blobs: options.blobs,
            eventBus: options.eventBus,
            timers: options.timers,
            subscriptions: options.subscriptions,
            scheduleSession:
              request.wakeSession ?? options.wakeSession ?? (() => {}),
            flushOutbox: request.flushOutbox ?? options.flushOutbox,
            getRunContext: (sid) => activeRunMeta.get(sid),
          }),
        )
      }
      registerToolSearchTool(registry)
      if (options.tools?.length) {
        registry.register(...options.tools)
      }

      if (options.mcp) {
        mcpLease = await options.mcp.attach({
          registry,
          agentDir: options.agentDir,
          cwd: location.cwd,
          environment: location.environment,
          trusted: resources.trusted,
          env: options.hostEnv,
          discoveredTools: saved?.discoveredTools,
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
      let appliedSelection = false
      if (request.projectId) {
        const proj = options.db.get<{ default_tools_json: string | null }>(
          'SELECT default_tools_json FROM projects WHERE id = ?',
          request.projectId,
        )
        if (proj?.default_tools_json) {
          const list = JSON.parse(proj.default_tools_json) as unknown
          if (
            !Array.isArray(list) ||
            !list.every((i) => typeof i === 'string')
          ) {
            throw new Error(
              `Invalid default_tools_json for project ${request.projectId}: expected a JSON array of tool names`,
            )
          }
          if (
            list.length > 0 &&
            list.every((name) => name.startsWith('+') || name.startsWith('-'))
          ) {
            registry.setDefaultToolModifiers([...baseModifiers, ...list])
          } else {
            registry.setDefaultToolModifiers(baseModifiers)
            registry.setSelection(list)
          }
          appliedSelection = true
        }
      }
      if (!appliedSelection) {
        registry.setDefaultToolModifiers(baseModifiers)
      }
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
        })
      }
      registry.background = bgController
      registry.setInterception({
        resolveEnv: () => resolveEnv(),
        before: async (toolName, input, ctx) => {
          if (toolName === 'tool_search' && mcpLease) {
            await mcpLease.waitForAll()
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
      const messages: ModelMessage[] = [...(saved?.messages ?? [])]
      for (const m of messages) tracker.addMessage(m)
      if (saved?.latestAssistantUsage) {
        tracker.restoreCalibration(
          saved.latestAssistantUsage.inputTokens,
          saved.latestAssistantUsage.outputTokens,
          saved.latestAssistantUsage.trailingMessages,
        )
      }
      const contextManager = new ContextManager(
        activeStore,
        tracker,
        { messages, timestamps: new Map(), summary: '' },
        () => {},
        options.limits ?? {},
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

      let turnUserMsg: { userEntryId?: string; hasHumanText: boolean } = {
        hasHumanText: false,
      }
      if (!alreadyHasRunMessages) {
        turnUserMsg = await prepareRuntimeTurnMessages({
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
        })
      } else {
        const existingUser = options.db.get<{
          id: string
          details_json: string | null
        }>(
          `SELECT id, details_json FROM vela_messages
           WHERE session_id = ? AND run_id = ? AND kind = 'message' AND role = 'user'
           ORDER BY rowid DESC LIMIT 1`,
          request.sessionId,
          request.runId,
        )
        if (existingUser?.details_json) {
          try {
            const parsed = JSON.parse(existingUser.details_json) as {
              dreamHumanText?: unknown
            }
            if (
              typeof parsed.dreamHumanText === 'string' &&
              parsed.dreamHumanText
            ) {
              turnUserMsg = { userEntryId: existingUser.id, hasHumanText: true }
            }
          } catch {
            /* ignore malformed details_json */
          }
        }
      }

      const pinnedDate = localDateString(
        new Date(sessionRow?.created_at ?? Date.now()),
      )
      const builder = createSessionPrompt(
        () => ({
          contextFiles: resources.contextFiles,
          skills: resources.skills,
          promptTemplates: resources.promptTemplates,
        }),
        () => location.cwd,
        () => undefined,
        false,
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

      let lastAssistant: AssistantModelMessage | undefined
      let committedInTx = false
      let recordedDreamInTx = false
      const driver = new VelaDriver({
        sessionId: request.sessionId,
        db: options.db,
        store: activeStore,
        registry,
        tracker,
        onEvent: createRuntimeEventForwarder(request, (msg) => {
          lastAssistant = msg
        }),
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
      const result = await driver.run({
        model: resolved.model,
        producer: resolved.info.ref,
        systemPrompt: buildSystemPrompt,
        messages,
        trigger: request.trigger,
        claim,
        supportsImages: resolved.info.input?.includes('image') ?? true,
        maxOutputTokens: resolved.info.maxTokens,
        reasoning: reasoningOption(
          clampThinkingLevel(thinkingLevel, resolved.info, THINKING_LEVELS),
          resolved.info,
        ),
        limits: options.limits,
        abortSignal: controller.signal,
        recoverPending: request.recoverPending,
        allowWaitingHuman: request.allowWaitingHuman,
        compactOnOverflow: async (sig) => {
          const resolvedTools = await resolveProviderTools(
            resolved.model,
            activeRegistry.toProviderTools(),
          )
          const snapshot = createRequestSnapshot(
            resolved.model,
            buildSystemPrompt(),
            resolvedTools,
            messages,
            sig,
          )
          await contextManager.compact(snapshot, undefined, 'overflow')
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
        return {
          status: 'waiting_human',
          replyText: assistantText(lastAssistant),
          silent: isSilent,
          committedInTx,
        }
      }

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
          localStore: memoryStores.local,
          projectId: request.projectId,
          sessionId: request.sessionId,
          dreamEnabled: options.dreamEnabled,
          resolved,
          tracker,
          resolveEnv,
          signal: controller.signal,
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
      if (controller.signal.aborted) {
        return { status: 'stopped' }
      }
      return {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
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
