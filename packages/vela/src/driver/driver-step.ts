import type { VelaDatabase } from '../db/index.ts'
import {
  inspectProviderApiError,
  type ProviderStepFinal,
  type ResolvedProviderTools,
  streamProviderStep,
} from '../providers/index.ts'
import type { VelaLimits } from '../shared/limits.ts'
import type {
  FinishReason,
  ModelInput,
  ProviderUsage,
  ReasoningOption,
} from '../shared/provider-types.ts'
import type { VelaEvent } from './agent/events.ts'
import { isContextOverflow } from './agent/overflow.ts'
import { isRetryable, retryDelayMs, sleep } from './agent/retry.ts'
import { ABORTED_RESULT, errorMessageOf, StepMessage } from './agent/step.ts'
import type { ModelMessage, ToolCallPart } from './messages.ts'
import type { SessionMessageEntry } from './session/entries.ts'
import type { SessionStore } from './session/index.ts'
import type { ToolRegistry } from './tools/registry.ts'
import {
  normalizeUsage,
  type StepRecord,
  type TokenTracker,
} from './usage/tracker.ts'

function recordMidStreamAbort(options: {
  store: SessionStore
  tracker: TokenTracker
  messages?: ModelMessage[]
  newMessages?: ModelMessage[]
  emit: (event: VelaEvent) => void
  step: StepMessage
  stopReason: 'aborted' | 'error'
  errorMessage: string
  turn: number
  runId: string
}): void {
  const {
    store,
    tracker,
    messages,
    newMessages,
    emit,
    step,
    stopReason,
    errorMessage,
    turn,
    runId,
  } = options
  step.endInterrupted(stopReason, errorMessage)
  let assistant = step.snapshot({ complete: step.complete })
  step.closeOpenCalls(errorMessage)
  const hosted = step.toolCalls.filter((call) => call.providerExecuted)
  if (hosted.length && Array.isArray(assistant.content)) {
    const ids = new Set(hosted.map((call) => call.toolCallId))
    assistant = {
      ...assistant,
      content: assistant.content.flatMap((part) => {
        if (part.type !== 'tool_call' || !ids.has(part.toolCallId))
          return [part]
        const detail = JSON.stringify(
          step.results.get(part.toolCallId)?.output,
          (key, value) =>
            key === 'encrypted_content' || key === 'encryptedContent'
              ? undefined
              : value,
        )
        const text = `Provider search: ${JSON.stringify(part.input)}\nProvider search result: ${detail ?? 'unavailable'}`
        return [{ type: 'text' as const, text }]
      }),
    }
  }
  const toolMessage = step.toolMessage(true)
  if (!step.complete && !step.toolsStarted) {
    if (assistant.content.length) {
      store.appendMessage(assistant, { stopReason, runId })
    }
  } else {
    if (assistant.content.length) {
      store.appendMessage(assistant, { runId })
      messages?.push(assistant)
      newMessages?.push(assistant)
      tracker.addMessage(assistant)
    }
    if (toolMessage) {
      store.appendMessage(toolMessage, { runId })
      messages?.push(toolMessage)
      newMessages?.push(toolMessage)
      tracker.addMessage(toolMessage)
    }
  }
  emit({
    type: 'turn_end',
    turn,
    message: assistant,
    toolResults: [...step.results.values()],
  })
}

export interface SdkToolError {
  toolCallId: string
  toolName: string
  input: unknown
  error: string
}

export async function streamSingleStepWithRetries(options: {
  model: ModelInput
  sessionId: string
  systemPrompt: string
  supportsImages: boolean
  reasoning?: ReasoningOption
  maxOutputTokens?: number
  tools: ResolvedProviderTools
  messages?: ModelMessage[]
  newMessages?: ModelMessage[]
  getMessages: () => ModelMessage[]
  refreshMessages: (producer?: string) => Promise<ModelMessage[]>
  resolveProducer?: () => string
  abortSignal?: AbortSignal
  isDraining?: () => boolean
  compactOnOverflow?: (signal?: AbortSignal) => Promise<void>
  limits: VelaLimits
  tracker: TokenTracker
  emit: (event: VelaEvent) => void
  turn: number
  runId: string
  store: SessionStore
  hostedCalls: Set<string>
}): Promise<{
  finalStep: ProviderStepFinal
  sources: Map<string, string>
  startedAt: number
  sdkToolErrors: SdkToolError[]
  producer?: string
}> {
  const {
    model,
    sessionId,
    systemPrompt,
    supportsImages,
    reasoning,
    maxOutputTokens,
    tools,
    abortSignal,
    isDraining,
    compactOnOverflow,
    limits,
    tracker,
    emit,
    turn,
    runId,
    store,
    hostedCalls,
  } = options

  let requestMessages = options.getMessages()
  const sources = new Map<string, string>()
  let step!: StepMessage
  let sourcesShown = false
  const showSources = () => {
    if (sourcesShown || !sources.size || step.ended) return
    sourcesShown = true
    const text = `\n\nSources:\n${[...sources].map(([url, title]) => `- ${title}: ${url}`).join('\n')}`
    step.textStart('web-search-sources')
    step.textDelta('web-search-sources', text)
    step.textEnd('web-search-sources')
  }
  const emitEmptyTurnEnd = () => {
    emit({
      type: 'turn_end',
      turn,
      message: { role: 'assistant', content: [] },
      toolResults: [],
    })
  }
  const shutdownError = () =>
    new DOMException('Run interrupted by graceful shutdown', 'AbortError')

  let retried = 0
  let compactedForOverflow = false
  let attemptProducer = options.resolveProducer?.()
  const recoverOverflow = async () => {
    compactedForOverflow = true
    await compactOnOverflow?.(abortSignal)
    attemptProducer = options.resolveProducer?.() ?? attemptProducer
    requestMessages = await options.refreshMessages(attemptProducer)
  }

  const startedAt = performance.now()
  for (;;) {
    if (isDraining?.()) throw shutdownError()
    abortSignal?.throwIfAborted()
    sources.clear()
    sourcesShown = false
    let stepHostedStarted = false
    let contextWindowExceeded = false
    let finalStep!: ProviderStepFinal
    const sdkToolErrors: SdkToolError[] = []
    step = new StepMessage(emit)
    try {
      if (isDraining?.()) throw shutdownError()
      const result = streamProviderStep({
        model,
        system: systemPrompt,
        messages: requestMessages,
        tools,
        supportsImages,
        reasoning,
        maxOutputTokens,
        sessionId,
        abortSignal,
      })

      let streamFinishReason: FinishReason | undefined
      for await (const part of result.stream) {
        switch (part.type) {
          case 'text-start':
            step.textStart(part.id, part.providerMetadata)
            break
          case 'text-delta':
            step.textDelta(part.id, part.text, part.providerMetadata)
            break
          case 'text-end':
            step.textEnd(part.id, part.providerMetadata)
            break
          case 'reasoning-start':
            step.thinkingStart(part.id, part.providerMetadata)
            break
          case 'reasoning-delta':
            step.thinkingDelta(part.id, part.text, part.providerMetadata)
            break
          case 'reasoning-end':
            step.thinkingEnd(part.id, part.providerMetadata)
            break
          case 'source':
            if (part.sourceType === 'url')
              sources.set(part.url, part.title ?? part.url)
            break
          case 'tool-input-start':
            if (part.providerExecuted) stepHostedStarted = true
            step.toolCallStart(
              part.id,
              part.toolName,
              part.providerMetadata,
              part.providerExecuted,
            )
            break
          case 'tool-input-delta':
            await step.toolCallDelta(part.id, part.delta)
            break
          case 'tool-call':
            if (part.providerExecuted) {
              stepHostedStarted = true
              hostedCalls.add(part.toolCallId)
            }
            step.toolCallEnd(part)
            break
          case 'tool-error':
            if (hostedCalls.has(part.toolCallId)) {
              step.result(
                part,
                { error: part.error },
                !step.providerExecuted(part.toolCallId),
              )
            } else {
              sdkToolErrors.push({
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
                error: errorMessageOf(part.error),
              })
            }
            break
          case 'tool-result':
            if (hostedCalls.has(part.toolCallId)) {
              step.result(
                part,
                { output: part.output },
                !step.providerExecuted(part.toolCallId),
              )
            }
            break
          case 'finish-step':
            streamFinishReason = part.finishReason
            break
          case 'error':
            throw part.error
        }
      }

      finalStep = await result.getFinalStep()
      abortSignal?.throwIfAborted()

      if (finalStep.rawFinishReason === 'model_context_window_exceeded') {
        contextWindowExceeded = true
      } else {
        if (streamFinishReason !== undefined) {
          showSources()
          step.end(streamFinishReason, false)
        }
        if (retried) {
          emit({ type: 'auto_retry_end', success: true, attempt: retried })
        }
        return {
          finalStep,
          sources,
          startedAt,
          sdkToolErrors,
          producer: attemptProducer,
        }
      }
    } catch (error) {
      if (abortSignal?.aborted) {
        recordMidStreamAbort({
          store,
          tracker,
          messages: options.messages,
          newMessages: options.newMessages,
          emit,
          step,
          stopReason: 'aborted',
          errorMessage: ABORTED_RESULT,
          turn,
          runId,
        })
        throw abortSignal.reason ?? error
      }
      if (isDraining?.()) {
        recordMidStreamAbort({
          store,
          tracker,
          messages: options.messages,
          newMessages: options.newMessages,
          emit,
          step,
          stopReason: 'aborted',
          errorMessage: 'Run interrupted by graceful shutdown',
          turn,
          runId,
        })
        throw shutdownError()
      }
      const errorMessage = errorMessageOf(error)
      const canResend = !tools.hasHostedTools && !stepHostedStarted
      const apiError = inspectProviderApiError(error)
      const canRecoverOverflow =
        (canResend ||
          (apiError !== undefined &&
            (apiError.statusCode === 400 || apiError.statusCode === 413))) &&
        !stepHostedStarted
      if (
        canRecoverOverflow &&
        !compactedForOverflow &&
        compactOnOverflow &&
        isContextOverflow(error)
      ) {
        step.endInterrupted('error', errorMessage)
        try {
          await recoverOverflow()
        } catch (compactError) {
          const message = `${errorMessage} (compacting the context to recover failed: ${errorMessageOf(compactError)})`
          if (retried) {
            emit({
              type: 'auto_retry_end',
              success: false,
              attempt: retried,
              finalError: message,
            })
          }
          emitEmptyTurnEnd()
          abortSignal?.throwIfAborted()
          throw new Error(message, { cause: error })
        }
        continue
      }
      if (canResend && retried < limits.maxRetries && isRetryable(error)) {
        step.endInterrupted('error', errorMessage)
        retried++
        const delay = retryDelayMs(
          error,
          retried,
          limits.retryBaseMs,
          limits.retryMaxMs,
        )
        emit({
          type: 'auto_retry_start',
          attempt: retried,
          maxAttempts: limits.maxRetries,
          delayMs: delay,
          errorMessage,
        })
        await sleep(delay, abortSignal).catch((sleepError) => {
          emitEmptyTurnEnd()
          throw sleepError
        })
        const nextProducer = options.resolveProducer?.()
        if (nextProducer !== undefined && nextProducer !== attemptProducer) {
          attemptProducer = nextProducer
          requestMessages = await options.refreshMessages(nextProducer)
        }
        continue
      }
      if (retried) {
        emit({
          type: 'auto_retry_end',
          success: false,
          attempt: retried,
          finalError: errorMessage,
        })
      }
      recordMidStreamAbort({
        store,
        tracker,
        messages: options.messages,
        newMessages: options.newMessages,
        emit,
        step,
        stopReason: 'error',
        errorMessage,
        turn,
        runId,
      })
      throw error
    }

    if (contextWindowExceeded) {
      const norm = normalizeUsage(finalStep.usage)
      const modelId = typeof model === 'string' ? model : model.modelId
      const rec = tracker.record(modelId || 'mock-model', norm, {
        kind: 'main',
        usage: finalStep.usage,
        durationMs: performance.now() - startedAt,
      })
      emit({
        type: 'usage',
        modelId: modelId || 'mock-model',
        usage: norm,
        record: rec,
      })
      step.endInterrupted('error', 'model_context_window_exceeded')
      if (!stepHostedStarted && !compactedForOverflow && compactOnOverflow) {
        try {
          await recoverOverflow()
        } catch (compactError) {
          const message = `model_context_window_exceeded (compacting the context to recover failed: ${errorMessageOf(compactError)})`
          if (retried) {
            emit({
              type: 'auto_retry_end',
              success: false,
              attempt: retried,
              finalError: message,
            })
          }
          emitEmptyTurnEnd()
          abortSignal?.throwIfAborted()
          throw new Error(message)
        }
        continue
      }
      if (retried) {
        emit({
          type: 'auto_retry_end',
          success: false,
          attempt: retried,
          finalError: 'Context overflow: model_context_window_exceeded',
        })
      }
      emitEmptyTurnEnd()
      throw new Error('Context overflow: model_context_window_exceeded')
    }
  }
}

function filterHostedToolMessages(
  responseMessages: readonly ModelMessage[],
  clientCalls: readonly ToolCallPart[],
): ModelMessage[] {
  const clientCallIds = new Set(clientCalls.map((call) => call.toolCallId))
  const out: ModelMessage[] = []
  for (const msg of responseMessages) {
    if (msg.role !== 'tool') continue
    const hostedParts = msg.content.filter(
      (part) =>
        part.type !== 'tool_result' || !clientCallIds.has(part.toolCallId),
    )
    if (hostedParts.length > 0) {
      out.push({ ...msg, content: hostedParts })
    }
  }
  return out
}

export function persistAssistantStepTx(options: {
  db: VelaDatabase
  store: SessionStore
  registry: ToolRegistry
  sessionId: string
  runId: string
  producer: string
  assistant: ModelMessage & { role: 'assistant' }
  responseMessages: ModelMessage[]
  clientCalls: ToolCallPart[]
  stepRecord: StepRecord
  rawUsage: ProviderUsage
  sdkToolErrors?: ReadonlyMap<string, string>
  terminalError?: (toolName: string) => string
  onCommittedInTx?: (assistantEntryId: string) => void
}): { entry: SessionMessageEntry; hostedMessages: ModelMessage[] } {
  const {
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
    rawUsage,
    sdkToolErrors,
    terminalError,
    onCommittedInTx,
  } = options
  const txNow = new Date().toISOString()
  return store.runInTransaction(() => {
    const entry = store.appendMessage(assistant, {
      producedBy: producer,
      runId,
      inputTokens: stepRecord.inputTokens,
      outputTokens: stepRecord.outputTokens,
      cacheReadTokens: stepRecord.cacheReadTokens,
      cacheWriteTokens: stepRecord.cacheWriteTokens,
      costUsd: stepRecord.cost,
      durationMs: stepRecord.durationMs,
    })
    const usageNow = new Date(stepRecord.ts).toISOString()
    db.run(
      `INSERT INTO usage_records (
         id, session_id, project_id, run_id, message_id, kind, model,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         cost_usd, duration_ms, raw_json, created_at
       ) VALUES (?, ?, NULL, ?, ?, 'main', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      sessionId,
      runId,
      entry.id,
      stepRecord.model,
      stepRecord.inputTokens,
      stepRecord.outputTokens,
      stepRecord.cacheReadTokens,
      stepRecord.cacheWriteTokens,
      stepRecord.cost ?? null,
      stepRecord.durationMs === undefined
        ? null
        : Math.round(stepRecord.durationMs),
      JSON.stringify(rawUsage),
      usageNow,
    )
    db.run(
      `UPDATE runs
       SET input_tokens = input_tokens + ?,
           output_tokens = output_tokens + ?,
           cache_read_tokens = cache_read_tokens + ?,
           cache_write_tokens = cache_write_tokens + ?,
           cost_usd = CASE
             WHEN ? IS NULL THEN cost_usd
             ELSE COALESCE(cost_usd, 0) + ?
           END,
           updated_at = ?
       WHERE id = ?`,
      stepRecord.inputTokens,
      stepRecord.outputTokens,
      stepRecord.cacheReadTokens,
      stepRecord.cacheWriteTokens,
      stepRecord.cost ?? null,
      stepRecord.cost ?? null,
      usageNow,
      runId,
    )
    for (const [idx, call] of clientCalls.entries()) {
      const def = registry.get(call.toolName)
      const execMode = def?.executionMode ?? 'sequential'
      const replay = def?.replay === 'safe' ? 'safe' : 'none'
      const failureText =
        sdkToolErrors?.get(call.toolCallId) ?? terminalError?.(call.toolName)
      db.run(
        `INSERT INTO vela_tool_calls (
           id, session_id, run_id, assistant_message_id, tool_call_id, call_index,
           tool_name, input_json, execution_mode, replay, status, attempt, is_error,
           preview, result_json, finished_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        sessionId,
        runId,
        entry.id,
        call.toolCallId,
        idx,
        call.toolName,
        JSON.stringify(call.input ?? {}),
        execMode,
        replay,
        failureText !== undefined ? 'failed' : 'pending',
        failureText !== undefined ? 1 : 0,
        failureText ?? null,
        failureText !== undefined
          ? JSON.stringify({ type: 'error-text', value: failureText })
          : null,
        failureText !== undefined ? txNow : null,
        txNow,
        txNow,
      )
    }
    const hostedMessages = filterHostedToolMessages(
      responseMessages,
      clientCalls,
    )
    for (const hostedMsg of hostedMessages) {
      store.appendMessage(hostedMsg, { runId })
    }
    onCommittedInTx?.(entry.id)
    return { entry, hostedMessages }
  })
}
