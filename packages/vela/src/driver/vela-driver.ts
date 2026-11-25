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
  errorMessageOf,
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
  type ToolResultOutput,
} from './messages.ts'
import type { SessionStore } from './session/index.ts'
import {
  assembleCompletedToolMessage,
  loadStepToolCallRows,
  recoverPendingStep,
} from './step-recovery.ts'
import { executeStepCalls } from './tool-executor.ts'
import type { ToolRegistry } from './tools/registry.ts'
import { normalizeUsage, type TokenTracker } from './usage/tracker.ts'

type RunTrigger =
  | 'user'
  | 'channel'
  | 'timer'
  | 'webhook'
  | 'approval'
  | 'job'
  | 'handoff'
  | 'session'

export interface DriverCapabilities {
  readonly recovery: 'step'
  readonly executionEnv: 'managed'
  readonly steer: boolean
  readonly approval: boolean
}

export interface VelaDriverRunOptions {
  model: ModelInput
  systemPrompt: string | (() => string)
  messages: ModelMessage[]
  newMessages?: ModelMessage[]
  trigger?: RunTrigger
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
  onRecoveryComplete?: () => Promise<void> | void
  appendInput?: (message: ModelMessage) => void
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

  private setSessionState(
    state: 'idle' | 'running' | 'waiting_human' | 'stopped',
    waitingReason: string | null = null,
  ): void {
    this.deps.db.run(
      'UPDATE sessions SET state = ?, waiting_reason = ?, updated_at = ? WHERE id = ?',
      state,
      waitingReason,
      new Date().toISOString(),
      this.deps.sessionId,
    )
  }

  private finishRun(
    runId: string,
    status:
      | 'completed'
      | 'waiting_human'
      | 'stopped'
      | 'failed'
      | 'interrupted',
    error?: unknown,
  ): void {
    const now = new Date().toISOString()
    this.deps.db.transaction(() => {
      this.deps.db.run(
        'UPDATE runs SET status = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?',
        status,
        error === undefined ? null : errorMessageOf(error),
        now,
        now,
        runId,
      )
      this.setSessionState(
        status === 'waiting_human' ? 'waiting_human' : 'idle',
        status === 'waiting_human' ? 'approval' : null,
      )
    })
  }

  async run(options: VelaDriverRunOptions): Promise<{
    reason: 'done' | 'waiting_human'
  }> {
    const { db, store, registry, tracker, sessionId } = this.deps
    const limits = resolveLimits(options.limits)
    const producer = describeModel(options.model).ref
    const runId = crypto.randomUUID()
    const newMessages = options.newMessages ?? []
    const now = new Date().toISOString()

    store.ensureSessionRow()
    db.transaction(() => {
      db.run(
        `INSERT INTO runs (
           id, session_id, project_id, driver, trigger, status, model, started_at, updated_at
         ) VALUES (?, ?, NULL, 'vela', ?, 'running', ?, ?, ?)`,
        runId,
        sessionId,
        options.trigger ?? 'user',
        producer,
        now,
        now,
      )
      this.setSessionState('running', null)
    })

    let turn = 0
    let hostedPauses = 0
    const hostedCalls = new Set<string>()
    const shutdownError = () =>
      new DOMException('Run interrupted by graceful shutdown', 'AbortError')
    const appendAndTrack = (
      message: ModelMessage,
      announce: boolean,
      extra: { details?: Record<string, unknown> } = {},
    ) => {
      store.appendMessage(message, { ...extra, runId })
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
          this.finishRun(runId, 'waiting_human')
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
        const refreshMessages = async () => {
          const transformed = options.transformContext
            ? await options.transformContext(options.messages, producer)
            : options.messages
          if (options.transformContext) {
            tracker.setContextDelta(
              estimateMessagesTokens(transformed) -
                estimateMessagesTokens(options.messages),
            )
          }
          return transformed
        }
        let requestMessages = await refreshMessages()
        await options.prepareContext?.(request)
        options.abortSignal?.throwIfAborted()

        const { finalStep, sources, startedAt, sdkToolErrors } =
          await streamSingleStepWithRetries({
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
            refreshMessages: async () => {
              requestMessages = await refreshMessages()
              return requestMessages
            },
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

        const assistantEntry = persistAssistantStepTx({
          db,
          store,
          registry,
          sessionId,
          runId,
          producer,
          assistant,
          responseMessages,
          clientCalls,
          stepRecord,
          rawUsage: finalStep.usage,
          sdkToolErrors: sdkErrorMap,
        })

        options.messages.push(assistant)
        newMessages.push(assistant)
        tracker.addMessage(assistant)
        if (inputToken > 0 || outputToken > 0) {
          tracker.updateFromAPI(inputToken, outputToken, requestToolTokens)
        }
        if (pendingClientCalls.length === 0) emitUsage()
        for (const hostedMsg of responseMessages) {
          if (hostedMsg.role === 'tool') {
            options.messages.push(hostedMsg)
            newMessages.push(hostedMsg)
            tracker.addMessage(hostedMsg)
            this.emit({ type: 'message_start', message: hostedMsg })
            this.emit({ type: 'message_end', message: hostedMsg })
          }
        }

        const isTruncated = finalStep.finishReason === 'length'
        const isFiltered = finalStep.finishReason === 'content-filter'
        if ((isTruncated || isFiltered) && pendingClientCalls.length > 0) {
          const rows = loadStepToolCallRows(
            db,
            sessionId,
            assistantEntry.id,
          ).filter((row) => !sdkErrorMap.has(row.tool_call_id))
          const syntheticNow = new Date().toISOString()
          db.transaction(() => {
            for (const row of rows) {
              const errMsg = isTruncated
                ? truncatedToolCallResult(row.tool_name)
                : failedToolCallResult(CONTENT_FILTER_ERROR)
              const out: ToolResultOutput = {
                type: 'error-text',
                value: errMsg,
              }
              db.run(
                `UPDATE vela_tool_calls
                 SET status = 'failed', is_error = 1, preview = ?, result_json = ?,
                     finished_at = ?, updated_at = ?
                 WHERE id = ?`,
                errMsg,
                JSON.stringify(out),
                syntheticNow,
                syntheticNow,
                row.id,
              )
              row.status = 'failed'
              row.is_error = 1
              row.preview = errMsg
              row.result_json = JSON.stringify(out)
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
                result: errMsg,
                isError: true,
                durationMs: 0,
              })
            }
          })
          emitUsage()
          const allRows = loadStepToolCallRows(db, sessionId, assistantEntry.id)
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
        } else if (pendingClientCalls.length > 0) {
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
            this.emit({
              type: 'turn_end',
              turn,
              message: assistant,
              toolResults: toolResultsOf([assistant]),
            })
            this.finishRun(runId, 'waiting_human')
            this.emit({
              type: 'agent_end',
              messages: newMessages,
              reason: 'waiting_human',
            })
            return { reason: 'waiting_human' }
          }
          emitUsage()
          const runnableIds = new Set(
            pendingClientCalls.map((call) => call.toolCallId),
          )
          const finalRows = loadStepToolCallRows(
            db,
            sessionId,
            assistantEntry.id,
          ).filter((row) => runnableIds.has(row.tool_call_id))
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

      this.finishRun(runId, 'completed')
      this.emit({
        type: 'agent_end',
        messages: newMessages,
        reason: 'done',
      })
      return { reason: 'done' }
    } catch (error) {
      const aborted = Boolean(
        options.abortSignal?.aborted || options.isDraining?.(),
      )
      this.finishRun(runId, aborted ? 'stopped' : 'failed', error)
      this.emit({
        type: 'agent_end',
        messages: newMessages,
        reason: aborted ? 'aborted' : 'error',
        error,
        ...(!aborted && { errorKind: classifyAgentError(error) }),
      })
      throw error
    } finally {
      if (options.abortSignal?.aborted) {
        await registry.waitForIdle().catch(() => {})
      }
    }
  }
}
