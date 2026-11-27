import type { VelaDatabase } from '../db/index.ts'
import { resolveProviderTools } from '../providers/index.ts'
import { describeModel } from '../providers/models/index.ts'
import { resolveLimits, type VelaLimits } from '../shared/limits.ts'
import type { ModelInput, ReasoningOption } from '../shared/provider-types.ts'
import type { VelaEvent, VelaEventListener } from './agent/events.ts'
import { classifyAgentError } from './agent/retry.ts'
import {
  ABORTED_RESULT,
  CONTENT_FILTER_ERROR,
  failedToolCallResult,
  toolResultsOf,
  truncatedToolCallResult,
} from './agent/step.ts'
import {
  createRequestSnapshot,
  estimateToolDefinitionsTokens,
  type RequestSnapshot,
} from './context/request.ts'
import {
  persistAssistantStepTx,
  streamSingleStepWithRetries,
} from './driver-step.ts'
import {
  type AssistantModelMessage,
  estimateMessagesTokens,
  type ModelMessage,
  type ToolCallPart,
} from './messages.ts'
import {
  claimRunInDb,
  type DriverCapabilities,
  type DriverRunClaim,
  finishRunInDb,
  pendingApprovalState,
  type RunTrigger,
} from './run-store.ts'
import type { SessionStore } from './session/index.ts'
import {
  assembleCompletedToolMessage,
  loadStepToolCallRows,
  recoverPendingStep,
} from './step-recovery.ts'
import { executeStepCalls } from './tool-executor.ts'
import type { ToolRegistry } from './tools/registry.ts'
import { normalizeUsage, type TokenTracker } from './usage/tracker.ts'

export type { DriverCapabilities, DriverRunClaim }

export interface VelaDriverRunOptions {
  model: ModelInput
  producer?: string | (() => string)
  systemPrompt: string | (() => string)
  messages: ModelMessage[]
  newMessages?: ModelMessage[]
  trigger?: RunTrigger
  claim?: DriverRunClaim
  supportsImages?: boolean
  maxOutputTokens?: number | (() => number | undefined)
  reasoning?: ReasoningOption | (() => ReasoningOption | undefined)
  limits?: Partial<VelaLimits>
  abortSignal?: AbortSignal
  isDraining?: () => boolean
  prepareContext?: (request: RequestSnapshot) => Promise<void>
  transformContext?: (
    messages: ModelMessage[],
    producer: string,
  ) => Promise<ModelMessage[]>
  compactOnOverflow?: (signal?: AbortSignal) => Promise<void>
  takeSteering?: () => ModelMessage[] | Promise<ModelMessage[]>
  hasSteering?: () => boolean
  recoverPending?: boolean
  allowWaitingHuman?: boolean
  onRecoveryComplete?: () => Promise<void> | void
  appendInput?: (message: ModelMessage) => void
  /** Skip driver-side `finishRun()` when the caller (e.g. `Runtime` worker) commits run status atomically. */
  skipFinishRun?: boolean
  /**
   * Optional Runtime callback executed inside the SQLite transaction committing each
   * user/assistant/hosted/tool message so `message_committed` carries the exact DB entry ID atomically.
   */
  onMessageCommittedInTx?: (entryId: string, message: ModelMessage) => void
  /**
   * Optional Runtime callback executed inside TX1 when the final no-tool assistant
   * message is committed, sealing `runs`, `sessions`, `inbox_events`, and `outbox` atomically.
   */
  onTerminalCommitInTx?: (info: {
    assistantEntryId: string
    assistant: AssistantModelMessage
    runId: string
  }) => void
}

/**
 * Vela's step-based durable execution driver.
 * Owns TX1 (atomic assistant + usage + tool-call queueing), gated tool execution,
 * human approval suspension (`waiting_human`), and step recovery.
 */
export class VelaDriver {
  readonly capabilities: DriverCapabilities = {
    recovery: 'step',
    executionEnv: 'managed',
    steer: true,
    approval: true,
  }

  constructor(
    private readonly deps: {
      sessionId: string
      db: VelaDatabase
      store: SessionStore
      registry: ToolRegistry
      tracker: TokenTracker
      onEvent?: VelaEventListener
    },
  ) {}

  private emit(event: VelaEvent): void {
    this.deps.onEvent?.(event)
  }

  private finishRun(
    runId: string,
    ownerToken: string,
    status:
      | 'completed'
      | 'waiting_human'
      | 'stopped'
      | 'failed'
      | 'interrupted',
    error?: unknown,
    sessionState?: 'idle' | 'waiting_human',
  ): void {
    finishRunInDb(
      this.deps.db,
      this.deps.sessionId,
      runId,
      ownerToken,
      status,
      error,
      sessionState,
    )
  }

  claim(options: {
    recoverPending?: boolean
    allowWaitingHuman?: boolean
    trigger?: RunTrigger
    model: ModelInput
  }): DriverRunClaim {
    return claimRunInDb({
      db: this.deps.db,
      sessionId: this.deps.sessionId,
      ensureSessionRow: () => this.deps.store.ensureSessionRow(),
      recoverPending: options.recoverPending,
      allowWaitingHuman: options.allowWaitingHuman,
      trigger: options.trigger,
      producer: describeModel(options.model).ref,
    })
  }

  async run(options: VelaDriverRunOptions): Promise<{
    reason: 'done' | 'waiting_human'
    committedInTx?: boolean
  }> {
    const { db, store, registry, tracker, sessionId } = this.deps
    const limits = resolveLimits(options.limits)
    const resolveProducer = () =>
      typeof options.producer === 'function'
        ? options.producer()
        : (options.producer ?? describeModel(options.model).ref)
    const shouldFinishRun = !options.skipFinishRun
    const claim =
      options.claim ??
      this.claim({
        recoverPending: options.recoverPending,
        allowWaitingHuman: options.allowWaitingHuman,
        trigger: options.trigger,
        model: options.model,
      })
    const { runId, ownerToken } = claim
    const newMessages = options.newMessages ?? []

    let turn = 0
    let hostedPauses = 0
    let committedTerminalInTx = false
    const hostedCalls = new Set<string>()
    const shutdownError = () =>
      new DOMException('Run interrupted by graceful shutdown', 'AbortError')
    const appendAndTrack = (
      message: ModelMessage,
      announce: boolean,
      extra: { details?: Record<string, unknown> } = {},
    ) => {
      store.runInTransaction(() => {
        const entry = store.appendMessage(message, { ...extra, runId })
        options.onMessageCommittedInTx?.(entry.id, message)
      })
      options.messages.push(message)
      newMessages.push(message)
      tracker.addMessage(message)
      if (announce) {
        this.emit({ type: 'message_start', message })
        this.emit({ type: 'message_end', message })
      }
    }

    try {
      if (options.recoverPending) {
        const rec = await recoverPendingStep({
          db,
          store,
          registry,
          sessionId,
          messages: options.messages,
          runId,
          emit: (event) => this.emit(event),
          isDraining: options.isDraining,
          signal: options.abortSignal,
        })
        if (rec.waitingHuman) {
          if (!options.allowWaitingHuman) {
            throw new Error(
              `Session ${sessionId} is awaiting human approval on a pending tool call; resolve pending approvals and call continueInterrupted() first`,
            )
          }
          this.finishRun(runId, ownerToken, 'waiting_human')
          this.emit({
            type: 'agent_end',
            messages: newMessages,
            reason: 'waiting_human',
          })
          return { reason: 'waiting_human' }
        }
        if (rec.recovered && rec.toolMessage) {
          appendAndTrack(rec.toolMessage, true, { details: rec.details })
        }
      }
      await options.onRecoveryComplete?.()
      options.abortSignal?.throwIfAborted()

      const currentSystem = () =>
        typeof options.systemPrompt === 'function'
          ? options.systemPrompt()
          : options.systemPrompt
      const currentReasoning = () =>
        typeof options.reasoning === 'function'
          ? options.reasoning()
          : options.reasoning
      const currentMaxOutputTokens = () =>
        typeof options.maxOutputTokens === 'function'
          ? options.maxOutputTokens()
          : options.maxOutputTokens

      for (;;) {
        if (options.isDraining?.()) throw shutdownError()
        options.abortSignal?.throwIfAborted()
        turn++
        this.emit({ type: 'turn_start', turn })

        const requestReasoning = currentReasoning()
        const resolvedTools = await resolveProviderTools(
          options.model,
          registry.toProviderTools(),
          { reasoning: requestReasoning },
        )
        const request = createRequestSnapshot(
          options.model,
          currentSystem(),
          resolvedTools,
          options.messages,
          options.abortSignal,
        )
        const requestToolTokens = estimateToolDefinitionsTokens(
          resolvedTools.toolDefinitions,
        )
        tracker.syncToolTokens(requestToolTokens)
        const stepProducer = resolveProducer()
        const refreshMessages = async (producerForStep = stepProducer) => {
          const transformed = options.transformContext
            ? await options.transformContext(options.messages, producerForStep)
            : options.messages
          if (options.transformContext) {
            tracker.setContextDelta(
              estimateMessagesTokens(transformed) -
                estimateMessagesTokens(options.messages),
            )
          }
          return transformed
        }
        let requestMessages = await refreshMessages(stepProducer)
        await options.prepareContext?.(request)
        options.abortSignal?.throwIfAborted()

        const {
          finalStep,
          sources,
          startedAt,
          sdkToolErrors,
          producer: winningProducer,
        } = await streamSingleStepWithRetries({
          model: options.model,
          sessionId,
          systemPrompt: currentSystem(),
          supportsImages: options.supportsImages ?? true,
          reasoning: requestReasoning,
          maxOutputTokens: currentMaxOutputTokens(),
          tools: request.tools,
          messages: options.messages,
          newMessages,
          getMessages: () => requestMessages,
          refreshMessages: async (producerForAttempt) => {
            requestMessages = await refreshMessages(producerForAttempt)
            return requestMessages
          },
          resolveProducer,
          abortSignal: options.abortSignal,
          isDraining: options.isDraining,
          compactOnOverflow: options.compactOnOverflow,
          limits,
          tracker,
          emit: (event) => this.emit(event),
          turn,
          runId,
          store,
          hostedCalls,
          onMessageCommittedInTx: options.onMessageCommittedInTx,
        })

        for (const sdkErr of sdkToolErrors) {
          this.emit({
            type: 'tool_execution_start',
            toolCallId: sdkErr.toolCallId,
            toolName: sdkErr.toolName,
            args: sdkErr.input,
          })
          this.emit({
            type: 'tool_execution_end',
            toolCallId: sdkErr.toolCallId,
            toolName: sdkErr.toolName,
            result: sdkErr.error,
            isError: true,
            durationMs: 0,
          })
        }

        const inputToken = finalStep.usage.inputTokens ?? 0
        const outputToken = finalStep.usage.outputTokens ?? 0
        const norm = normalizeUsage(finalStep.usage)
        const modelId =
          typeof options.model === 'string'
            ? options.model
            : options.model.modelId
        const stepRecord = tracker.record(
          modelId || 'mock-model',
          norm,
          {
            kind: 'main',
            usage: finalStep.usage,
            durationMs: performance.now() - startedAt,
          },
          undefined,
          false,
        )
        const emitUsage = () =>
          this.emit({
            type: 'usage',
            modelId: modelId || 'mock-model',
            usage: norm,
            record: stepRecord,
          })

        const responseMessages: ModelMessage[] = [...finalStep.messages]
        if (sources.size) {
          const msg = responseMessages.find(
            (item): item is AssistantModelMessage => item.role === 'assistant',
          )
          if (msg && Array.isArray(msg.content)) {
            msg.content.push({
              type: 'text',
              text: `\n\nSources:\n${[...sources].map(([url, title]) => `- ${title}: ${url}`).join('\n')}`,
            })
          }
        }
        const assistant = responseMessages.find(
          (message): message is AssistantModelMessage =>
            message.role === 'assistant',
        ) ?? { role: 'assistant', content: [] }
        const clientCalls = Array.isArray(assistant.content)
          ? assistant.content.filter(
              (part): part is ToolCallPart =>
                part.type === 'tool_call' && !part.providerExecuted,
            )
          : []
        const hostedToolCalls = Array.isArray(assistant.content)
          ? assistant.content.filter(
              (part): part is ToolCallPart =>
                part.type === 'tool_call' && Boolean(part.providerExecuted),
            )
          : []
        const sdkErrorMap = new Map(
          sdkToolErrors.map((item) => [item.toolCallId, item.error]),
        )
        for (const msg of responseMessages) {
          if (msg.role !== 'tool') continue
          for (const part of msg.content) {
            if (
              part.type === 'tool_result' &&
              !sdkErrorMap.has(part.toolCallId)
            ) {
              const isHosted = hostedToolCalls.some(
                (call) => call.toolCallId === part.toolCallId,
              )
              if (!isHosted) {
                sdkErrorMap.set(
                  part.toolCallId,
                  typeof part.output === 'object' &&
                    part.output !== null &&
                    'value' in part.output
                    ? String(part.output.value)
                    : 'Tool error',
                )
              }
            }
          }
        }
        const pendingClientCalls = clientCalls.filter(
          (call) => !sdkErrorMap.has(call.toolCallId),
        )

        const isTruncated = finalStep.finishReason === 'length'
        const isFiltered = finalStep.finishReason === 'content-filter'
        const terminalError =
          isTruncated || isFiltered
            ? (toolName: string) =>
                isTruncated
                  ? truncatedToolCallResult(toolName)
                  : failedToolCallResult(CONTENT_FILTER_ERROR)
            : undefined

        const pausedHostedBeforeTx =
          finalStep.rawFinishReason === 'pause_turn' &&
          hostedToolCalls.length > 0
        const canCompleteInTx =
          Boolean(options.onTerminalCommitInTx) &&
          clientCalls.length === 0 &&
          !isFiltered &&
          !pausedHostedBeforeTx &&
          !options.hasSteering?.()

        const { entry: assistantEntry, hostedMessages } =
          persistAssistantStepTx({
            db,
            store,
            registry,
            sessionId,
            runId,
            producer: winningProducer ?? stepProducer,
            assistant,
            responseMessages,
            clientCalls,
            stepRecord,
            rawUsage: finalStep.usage,
            sdkToolErrors: sdkErrorMap,
            terminalError,
            onCommittedInTx:
              options.onMessageCommittedInTx || canCompleteInTx
                ? (assistantEntryId, hostedEntries) => {
                    options.onMessageCommittedInTx?.(
                      assistantEntryId,
                      assistant,
                    )
                    for (const hosted of hostedEntries) {
                      options.onMessageCommittedInTx?.(
                        hosted.entryId,
                        hosted.message,
                      )
                    }
                    if (canCompleteInTx) {
                      options.onTerminalCommitInTx?.({
                        assistantEntryId,
                        assistant,
                        runId,
                      })
                    }
                  }
                : undefined,
          })
        if (canCompleteInTx) {
          committedTerminalInTx = true
        }

        options.messages.push(assistant)
        newMessages.push(assistant)
        tracker.addMessage(assistant)
        if (inputToken > 0 || outputToken > 0) {
          tracker.updateFromAPI(inputToken, outputToken, requestToolTokens)
        }
        if (pendingClientCalls.length === 0) emitUsage()
        for (const hostedMsg of hostedMessages) {
          options.messages.push(hostedMsg)
          newMessages.push(hostedMsg)
          tracker.addMessage(hostedMsg)
          this.emit({ type: 'message_start', message: hostedMsg })
          this.emit({ type: 'message_end', message: hostedMsg })
        }

        if (terminalError && pendingClientCalls.length > 0) {
          const allRows = loadStepToolCallRows(db, sessionId, assistantEntry.id)
          for (const row of allRows) {
            if (sdkErrorMap.has(row.tool_call_id)) continue
            this.emit({
              type: 'tool_execution_start',
              toolCallId: row.tool_call_id,
              toolName: row.tool_name,
              args: JSON.parse(row.input_json),
            })
            this.emit({
              type: 'tool_execution_end',
              toolCallId: row.tool_call_id,
              toolName: row.tool_name,
              result: row.preview ?? '',
              isError: true,
              durationMs: 0,
            })
          }
          emitUsage()
          const { message: toolMsg } = assembleCompletedToolMessage(allRows)
          appendAndTrack(toolMsg, true)
          if (isFiltered) {
            this.emit({
              type: 'turn_end',
              turn,
              message: assistant,
              toolResults: toolResultsOf([assistant, toolMsg]),
            })
            throw new Error(CONTENT_FILTER_ERROR)
          }
        } else if (clientCalls.length > 0) {
          if (pendingClientCalls.length > 0) {
            const rows = loadStepToolCallRows(db, sessionId, assistantEntry.id)
            const execResult = await executeStepCalls({
              db,
              store,
              registry,
              sessionId,
              rows,
              emit: (event) => this.emit(event),
              signal: options.abortSignal,
              isDraining: options.isDraining,
              shouldSkipForSteer: options.hasSteering,
            })
            if (execResult.waitingHuman) {
              emitUsage()
              const settledRows = loadStepToolCallRows(
                db,
                sessionId,
                assistantEntry.id,
              ).filter(
                (row) =>
                  row.result_json !== null &&
                  (row.status === 'completed' ||
                    row.status === 'failed' ||
                    row.status === 'skipped'),
              )
              const completedResults = toolResultsOf([
                assistant,
                ...hostedMessages,
                ...(settledRows.length > 0
                  ? [assembleCompletedToolMessage(settledRows).message]
                  : []),
              ])
              this.emit({
                type: 'turn_end',
                turn,
                message: assistant,
                toolResults: completedResults,
              })
              this.finishRun(runId, ownerToken, 'waiting_human')
              this.emit({
                type: 'agent_end',
                messages: newMessages,
                reason: 'waiting_human',
              })
              return { reason: 'waiting_human' }
            }
            emitUsage()
          }
          const finalRows = loadStepToolCallRows(
            db,
            sessionId,
            assistantEntry.id,
          )
          const { message: toolMsg, details } =
            assembleCompletedToolMessage(finalRows)
          appendAndTrack(toolMsg, true, { details })
          if (options.abortSignal?.aborted) {
            this.emit({
              type: 'turn_end',
              turn,
              message: assistant,
              toolResults: toolResultsOf([assistant, toolMsg]),
            })
            throw (
              options.abortSignal.reason ??
              new DOMException(ABORTED_RESULT, 'AbortError')
            )
          }
        }

        const latestToolMsg = options.messages.at(-1)
        const stepToolResults =
          latestToolMsg?.role === 'tool'
            ? toolResultsOf([assistant, latestToolMsg])
            : toolResultsOf([assistant])

        const pausedHosted =
          finalStep.rawFinishReason === 'pause_turn' &&
          hostedToolCalls.length > 0
        if (pausedHosted && ++hostedPauses > 3) {
          this.emit({
            type: 'turn_end',
            turn,
            message: assistant,
            toolResults: stepToolResults,
          })
          throw new Error(
            'Provider-hosted tool did not finish after three continuations',
          )
        }
        if (!pausedHosted) hostedPauses = 0

        if (isFiltered) {
          this.emit({
            type: 'turn_end',
            turn,
            message: assistant,
            toolResults: stepToolResults,
          })
          throw new Error(CONTENT_FILTER_ERROR)
        }

        const needAnotherStep = pausedHosted || clientCalls.length > 0
        if (options.isDraining?.()) {
          this.emit({
            type: 'turn_end',
            turn,
            message: assistant,
            toolResults: stepToolResults,
          })
          if (needAnotherStep) throw shutdownError()
          break
        }

        this.emit({
          type: 'turn_end',
          turn,
          message: assistant,
          toolResults: stepToolResults,
        })
        const queued = (await options.takeSteering?.()) ?? []
        for (const msg of queued) {
          if (options.appendInput) {
            options.appendInput(msg)
            newMessages.push(msg)
          } else {
            appendAndTrack(msg, true)
          }
        }
        if (!needAnotherStep && queued.length === 0) break
      }

      if (shouldFinishRun && !committedTerminalInTx) {
        this.finishRun(runId, ownerToken, 'completed')
      }
      this.emit({
        type: 'agent_end',
        messages: newMessages,
        reason: 'done',
      })
      return { reason: 'done', committedInTx: committedTerminalInTx }
    } catch (error) {
      if (committedTerminalInTx) {
        return { reason: 'done', committedInTx: true }
      }
      const draining = Boolean(options.isDraining?.())
      const aborted = Boolean(options.abortSignal?.aborted || draining)
      const { hasRunPendingApproval, hasSessionPendingApproval } =
        pendingApprovalState(db, sessionId, runId)
      if (shouldFinishRun) {
        this.finishRun(
          runId,
          ownerToken,
          hasRunPendingApproval
            ? 'waiting_human'
            : options.abortSignal?.aborted
              ? 'stopped'
              : draining
                ? 'interrupted'
                : 'failed',
          error,
          hasSessionPendingApproval ? 'waiting_human' : 'idle',
        )
      }
      this.emit({
        type: 'agent_end',
        messages: newMessages,
        reason: aborted ? 'aborted' : 'error',
        error,
        ...(!aborted && { errorKind: classifyAgentError(error) }),
      })
      throw error
    } finally {
      await registry.waitForIdle().catch(() => {})
      claim.release()
    }
  }
}
