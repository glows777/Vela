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
import type {
  AgentDriver,
  DriverInboxItem,
  DriverTurnRequest,
  DriverTurnResult,
} from '../runtime/driver.ts'
import type { BlobStore, EnvironmentRegistry } from '../runtime/index.ts'
import type { VelaLimits } from '../shared/limits.ts'
import { silentLogger, type VelaLogger } from '../shared/logger.ts'
import type { ModelInput } from '../shared/provider-types.ts'
import type { VelaEvent } from './agent/events.ts'
import { ContextManager, createRequestSnapshot } from './context/manager.ts'
import { createSessionLocalExecutionEnv } from './execution/local.ts'
import type { ExecutionEnv, ExecutionLocation } from './execution/types.ts'
import type { AssistantModelMessage, ModelMessage } from './messages.ts'
import { SessionStore } from './session/index.ts'
import { createSessionPrompt } from './session/prompt-builder.ts'
import { createCoreTools } from './tools/index.ts'
import { type ToolDefinition, ToolRegistry } from './tools/registry.ts'
import { TokenTracker } from './usage/tracker.ts'
import { VelaDriver } from './vela-driver.ts'

interface VelaAgentDriverOptions {
  db: VelaDatabase
  agentDir: string
  blobs: BlobStore
  environments: EnvironmentRegistry
  defaultModel?: ModelInput
  defaultThinkingLevel?: ThinkingLevel
  providers?: Record<string, ProviderDefinition>
  credentials?: CredentialStore
  limits?: Partial<VelaLimits>
  tools?: ToolDefinition[]
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

function assistantText(msg: AssistantModelMessage | undefined): string {
  if (!msg) return ''
  if (typeof msg.content === 'string') return msg.content
  return msg.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

function formatInboxItemText(item: DriverInboxItem): string {
  const p = item.payload
  if (item.source === 'timer') {
    const kind = p.kind === 'followup' ? 'Follow-up timer' : 'Scheduled routine'
    return `[${kind}] ${String(p.message ?? '')}`
  }
  if (item.source === 'webhook') {
    const header = `[Event ${String(p.eventSource ?? 'webhook')}:${String(p.eventKey ?? '')}] ${String(p.summary ?? '')}`
    return p.details ? `${header}\n${String(p.details)}` : header
  }
  if (item.source === 'job') {
    return String(p.text ?? '')
  }
  if (item.source === 'channel') {
    const sender = typeof p.senderName === 'string' ? p.senderName : 'User'
    const prefix = item.passive
      ? `[Passive group message from ${sender}] `
      : `${sender}: `
    return `${prefix}${String(p.text ?? '')}`
  }
  if (!item.wake) {
    return `[Background note] ${String(p.text ?? '')}`
  }
  return String(p.text ?? '')
}

/**
 * Bridges `Runtime`'s driver-agnostic `AgentDriver` contract onto `VelaDriver`
 * (step-durable SQLite transactions, `SessionStore`, `ToolRegistry`, and `EnvironmentRegistry`).
 */
export function createVelaAgentDriver(
  options: VelaAgentDriverOptions,
): AgentDriver {
  const logger = options.logger ?? silentLogger
  const models = new ModelRegistry(options.providers, options.credentials)
  const activeAbort = new Map<string, AbortController>()
  const activeSteering = new Map<string, ModelMessage[]>()

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
    async runTurn(request: DriverTurnRequest): Promise<DriverTurnResult> {
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

      const store = new SessionStore(request.sessionId, options.db, {
        blobsDir: options.blobs.rootDir,
        logger,
      })
      const saved = await store.loadSaved()
      const cwd = saved?.location?.cwd ?? process.cwd()
      const location: ExecutionLocation = saved?.location ?? {
        environment: 'local',
        cwd,
      }
      const modelInput =
        saved?.model ?? options.defaultModel ?? models.defaultRef()
      if (!modelInput) {
        throw new Error(`No model configured for session ${request.sessionId}`)
      }
      const resolved =
        typeof modelInput === 'string'
          ? models.resolve(modelInput)
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

      const registry = new ToolRegistry(spillDir)
      registry.setLogger(logger)
      registry.register(...createCoreTools({ cwd: location.cwd }))
      if (options.tools?.length) {
        registry.register(...options.tools)
      }
      registry.setInterception({
        resolveEnv: () => resolveEnv(),
        before: async (toolName, input, ctx) => {
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
        store.recordUsageRecord(record, { runId: request.runId }),
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
        store,
        tracker,
        { messages, timestamps: new Map(), summary: '' },
        () => {},
        options.limits ?? {},
      )

      const alreadyHasRunMessages = Boolean(
        options.db.get<{ ok: number }>(
          `SELECT 1 AS ok FROM vela_messages WHERE session_id = ? AND run_id = ? LIMIT 1`,
          request.sessionId,
          request.runId,
        ),
      )

      if (!alreadyHasRunMessages) {
        const usableInputs = request.inputs.filter(
          (item) => item.source !== 'approval',
        )
        if (usableInputs.length > 0) {
          const lines: string[] = []
          for (const item of usableInputs) {
            let line = formatInboxItemText(item)
            const atts = item.payload.attachments as
              | Array<{ blobId: string; name: string }>
              | undefined
            if (atts?.length) {
              const env = await resolveEnv()
              const attachmentLines: string[] = []
              for (const att of atts) {
                const matPath = await options.blobs.materializeIntoEnv(
                  att.blobId,
                  env,
                  request.sessionId,
                  controller.signal,
                )
                attachmentLines.push(`[file: ${att.name}, saved at ${matPath}]`)
              }
              line = line
                ? `${line}\n${attachmentLines.join('\n')}`
                : attachmentLines.join('\n')
            }
            if (line) lines.push(line)
          }
          if (lines.length > 0) {
            const userMsg: ModelMessage = {
              role: 'user',
              content: lines.join('\n\n'),
            }
            const entry = store.appendMessage(userMsg, { runId: request.runId })
            messages.push(userMsg)
            tracker.addMessage(userMsg)
            request.onEvent({
              type: 'message_committed',
              runId: request.runId,
              messageId: entry.id,
              message: userMsg,
            })
          }
        }
      }

      const builder = createSessionPrompt(
        () => ({
          contextFiles: [],
          skills: [],
          promptTemplates: [],
        }),
        () => location.cwd,
        () => undefined,
        false,
        () => location.environment === 'local',
        () => options.environments.osFor(location.environment),
        () => new Date().toISOString().slice(0, 10),
      )

      let lastAssistant: AssistantModelMessage | undefined
      let committedInTx = false
      const forwardEvent = (event: VelaEvent) => {
        switch (event.type) {
          case 'message_update': {
            const inner = event.assistantMessageEvent
            if (inner.type === 'text_delta') {
              request.onDelta({
                type: 'text_delta',
                sessionId: request.sessionId,
                runId: request.runId,
                contentIndex: inner.contentIndex,
                delta: inner.delta,
              })
            } else if (inner.type === 'thinking_delta') {
              request.onDelta({
                type: 'thinking_delta',
                sessionId: request.sessionId,
                runId: request.runId,
                contentIndex: inner.contentIndex,
                delta: inner.delta,
              })
            }
            break
          }
          case 'tool_execution_update': {
            const delta =
              typeof event.partialResult === 'string'
                ? event.partialResult
                : JSON.stringify(event.partialResult ?? '')
            request.onDelta({
              type: 'tool_output_delta',
              sessionId: request.sessionId,
              runId: request.runId,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              delta,
            })
            break
          }
          case 'tool_execution_start':
            request.onEvent({
              type: 'tool_started',
              runId: request.runId,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: event.args,
            })
            break
          case 'tool_execution_end':
            request.onEvent({
              type: 'tool_finished',
              runId: request.runId,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              isError: event.isError,
              durationMs: event.durationMs,
              details: event.details,
            })
            break
          case 'approval_requested':
            request.onEvent({
              type: 'approval_requested',
              runId: request.runId,
              approvalId: event.approvalId,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              summary: event.summary,
              input: {},
            })
            break
          case 'message_end': {
            if (event.message.role === 'assistant') {
              lastAssistant = event.message
            }
            if (!committedInTx) {
              request.onEvent({
                type: 'message_committed',
                runId: request.runId,
                messageId: store.idOf(event.message) ?? request.runId,
                message: event.message,
              })
            }
            break
          }
          case 'compaction_end':
            if (event.result) {
              request.onEvent({
                type: 'compaction_finished',
                runId: request.runId,
                reason: event.reason,
                tokensBefore: event.result.tokensBefore,
                tokensAfter: event.result.tokensAfter,
                messages: event.result.messages,
              })
            }
            break
        }
      }

      const driver = new VelaDriver({
        sessionId: request.sessionId,
        db: options.db,
        store,
        registry,
        tracker,
        onEvent: forwardEvent,
      })

      let releasedClaim = false
      const claim = {
        runId: request.runId,
        ownerToken: request.ownerToken,
        resumedFromWaitingHuman: request.recoverPending,
        release: () => {
          releasedClaim = true
        },
      }

      try {
        const buildSystemPrompt = () =>
          builder.build({
            sessionId: request.sessionId,
            activeTools: registry.getActiveTools(),
            deferredToolSummary: registry.getDeferredToolSummary(),
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
              registry.toProviderTools(),
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
          onTerminalCommitInTx: request.onTerminalCommitInTx
            ? ({ assistantEntryId, assistant }) => {
                lastAssistant = assistant
                committedInTx = true
                request.onEvent({
                  type: 'message_committed',
                  runId: request.runId,
                  messageId: assistantEntryId,
                  message: assistant,
                })
                request.onTerminalCommitInTx?.({
                  status: 'completed',
                  replyText: assistantText(assistant),
                })
              }
            : undefined,
        })

        if (result.reason === 'waiting_human') {
          return { status: 'waiting_human' }
        }
        return {
          status: 'completed',
          replyText: assistantText(lastAssistant),
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
        if (!releasedClaim) claim.release()
        request.abortSignal.removeEventListener('abort', forwardAbort)
        activeAbort.delete(request.sessionId)
        activeSteering.delete(request.sessionId)
        await registry.waitForIdle().catch(() => {})
      }
    },
  }
}
