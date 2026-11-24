import {
  inspectProviderApiError,
  type ProviderStepFinal,
  resolveProviderTools,
  streamProviderStep,
} from '../../providers/index.ts'
import { describeModel } from '../../providers/models/index.ts'
import { resolveLimits, type VelaLimits } from '../../shared/limits.ts'
import type {
  ModelInput,
  ReasoningOption,
} from '../../shared/provider-types.ts'
import {
  contextRequestTokens,
  createRequestSnapshot,
  type RequestSnapshot,
} from '../context/request.ts'
import type { AssistantModelMessage, ModelMessage } from '../messages.ts'
import { getStoredResult } from '../session/tool-results.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import { normalizeUsage, type TokenTracker } from '../usage/tracker.ts'
import type { VelaEvent, VelaEventListener } from './events.ts'
import { LoopDetector } from './loop-detection.ts'
import { isContextOverflow } from './overflow.ts'
import {
  calculateDelay,
  classifyAgentError,
  isRetryable,
  sleep,
} from './retry.ts'
import {
  ABORTED_RESULT,
  CONTENT_FILTER_ERROR,
  errorMessageOf,
  failedToolCallResult,
  StepMessage,
  toolResultsOf,
  truncatedToolCallResult,
} from './step.ts'

interface AgentLoopParameter {
  model: ModelInput
  systemPrompt: string | (() => string)
  toolRegistry: ToolRegistry
  messages: ModelMessage[]
  tokenTracker: TokenTracker
  prepareContext?: (request: RequestSnapshot) => Promise<void>
  /**
   * Called before every model request, after `prepareContext` (the extension `context` event, like pi): returns
   * the messages this request sends. The history in `messages` is not changed. `producer` is the identity of
   * `model`, the model that sends the request.
   */
  transformContext?: (
    messages: ModelMessage[],
    producer: string,
  ) => Promise<ModelMessage[]>
  /**
   * Called at most once per step when the local cap or provider rejects an oversized request.
   * Compacts the history before the next attempt.
   */
  compactOnOverflow?: (signal?: AbortSignal) => Promise<void>
  abortSignal?: AbortSignal
  /** Stop admitting model/tool work while already executing tools finish normally. */
  isDraining?: () => boolean
  /** Event callback; without it agentLoop produces no terminal output. */
  onEvent?: VelaEventListener
  /** Retry, context and other limits; missing fields use defaults. */
  limits?: Partial<VelaLimits>
  /** Whether the selected model accepts image input; unknown models default to true. */
  supportsImages?: boolean
  /**
   * AI SDK reasoning option (mapped from the thinking level); not sent when omitted. A function is
   * called before every request, so a change during the run applies to the next step (like pi).
   */
  reasoning?: ReasoningOption | (() => ReasoningOption | undefined)
  /**
   * Takes queued steer messages (like pi's getSteeringMessages): called once after each step's tools
   * finish and before the next model request; the messages are appended to the history. If the model
   * was about to stop and steer messages arrive, the loop keeps going.
   */
  takeSteering?: () => ModelMessage[] | Promise<ModelMessage[]>
  /**
   * Takes queued followUp messages (like pi's getFollowUpMessages): called when the model is about to
   * stop (no tool calls, no steer); the messages run in the same loop.
   */
  takeFollowUp?: () => ModelMessage[] | Promise<ModelMessage[]>
  /** Messages already added for this loop (e.g. the user input); agent_end reports them plus the loop's own. */
  newMessages?: ModelMessage[]
  /**
   * Called for every message the loop adds to `messages` (the session appends it to its log); `producer` is
   * the identity of the model that answered.
   */
  onMessage?: (message: ModelMessage, producer: string) => void
  /** Flush the recorded assistant tool calls before the SDK may execute them. */
  onCheckpoint?: () => Promise<void>
  /**
   * Turns a loop-detection warning into the message appended after that step (pi's custom notice).
   * The model sees the returned message. Absent, the warning is only an event.
   */
  injectNotice?: (content: string) => ModelMessage
  /**
   * Called for an assistant message aborted or failed while it streamed. Like pi, it is kept for the session
   * record but not added to `messages`, so it is never sent to the model.
   */
  onInterrupted?: (
    message: AssistantModelMessage,
    stopReason: 'aborted' | 'error',
  ) => void
}

export const agentLoop = async ({
  model,
  systemPrompt,
  toolRegistry,
  messages,
  tokenTracker,
  prepareContext,
  transformContext,
  compactOnOverflow,
  abortSignal,
  isDraining,
  onEvent,
  limits: limitOverrides,
  reasoning,
  supportsImages = true,
  takeSteering,
  takeFollowUp,
  newMessages = [],
  onMessage,
  onCheckpoint,
  onInterrupted,
  injectNotice,
}: AgentLoopParameter) => {
  const limits = resolveLimits(limitOverrides)
  // The model that sends this loop's requests, as provider/modelId (pi's provider + api + model): the
  // session stamps its messages with it and leaves other models' reasoning out of them.
  const producer = describeModel(model).ref
  let turn = 0
  let hostedPauses = 0
  const hostedCalls = new Set<string>()
  const checkpoints = new WeakMap<StepMessage, AssistantModelMessage>()
  // Each agent loop has its own call history, so concurrent sessions don't interfere
  const loopDetector = new LoopDetector()
  const emit = (event: VelaEvent) => onEvent?.(event)
  let endReason: Extract<VelaEvent, { type: 'agent_end' }>['reason'] | undefined

  /** Adds a message to history; one-shot messages (user, tool, reminders) get message_start / message_end. */
  const add = (message: ModelMessage, announce = true) => {
    messages.push(message)
    newMessages.push(message)
    tokenTracker.addMessage(message)
    onMessage?.(message, producer)
    if (announce) {
      emit({ type: 'message_start', message })
      emit({ type: 'message_end', message })
    }
  }

  const shutdown = () =>
    new DOMException('Run interrupted by graceful shutdown', 'AbortError')
  const checkDrain = () => {
    if (isDraining?.()) throw shutdown()
  }

  const currentSystem = () =>
    typeof systemPrompt === 'function' ? systemPrompt() : systemPrompt
  const currentReasoning = () =>
    typeof reasoning === 'function' ? reasoning() : reasoning
  try {
    // Like pi: no turn limit. Run until the model stops calling tools and nothing is queued
    // (or until aborted / stopped by loop detection)
    for (;;) {
      checkDrain()
      abortSignal?.throwIfAborted()
      toolRegistry.assertHealthy()
      turn++
      emit({ type: 'turn_start', turn })

      // Prepare context before every actual model request, including tool continuations.
      const requestReasoning = currentReasoning()
      let checkpointFailure: { error: unknown } | undefined
      const resolvedTools = await resolveProviderTools(
        model,
        toolRegistry.toProviderTools(),
        {
          reasoning: requestReasoning,
          wrapExecute:
            onCheckpoint || isDraining
              ? (execute) => async (input, options) => {
                  if (isDraining?.())
                    throw new Error(
                      'Tool was not executed because the session is shutting down.',
                    )
                  // SDK lifecycle callbacks swallow errors. Check again at the actual
                  // execution boundary so a failed flush cannot authorize side effects.
                  if (checkpointFailure)
                    throw new Error(
                      `Tool was not executed because its checkpoint could not be saved: ${errorMessageOf(checkpointFailure.error)}`,
                    )
                  return execute(input, options)
                }
              : undefined,
        },
      )
      const request = createRequestSnapshot(
        model,
        currentSystem(),
        resolvedTools,
        messages,
        abortSignal,
      )
      await prepareContext?.(request)
      abortSignal?.throwIfAborted()
      const inferenceSystem = currentSystem()
      const messagesForRequest = async () =>
        transformContext ? transformContext(messages, producer) : messages
      let requestMessages = await messagesForRequest()

      let shouldBreak = false
      const sources = new Map<string, string>()
      let loopWarning: string | undefined
      let finalStep: ProviderStepFinal | undefined
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
      // Retry attempts that already failed (auto_retry_start was emitted for each)
      let retried = 0
      let compactedForOverflow = false
      const recoverOverflow = async (signal?: AbortSignal) => {
        compactedForOverflow = true
        await compactOnOverflow?.(signal)
        requestMessages = await messagesForRequest()
      }
      const sizeError =
        'Request exceeds the safe input size; this turn was stopped.'

      const started = performance.now()
      for (;;) {
        checkDrain()
        abortSignal?.throwIfAborted()
        if (
          contextRequestTokens(
            {
              ...request,
              systemPrompt: inferenceSystem,
              messages: requestMessages,
            },
            tokenTracker.reportedContextTokens,
          ) > limits.maxInputTokens
        ) {
          if (compactedForOverflow || !compactOnOverflow) {
            endTurnEmpty()
            throw new Error(sizeError)
          }
          try {
            await recoverOverflow(abortSignal)
          } catch (error) {
            endTurnEmpty()
            abortSignal?.throwIfAborted()
            throw new Error(
              `${sizeError} (compacting the context to recover failed: ${errorMessageOf(error)})`,
              { cause: error },
            )
          }
          continue
        }
        const current = new StepMessage(emit)
        step = current
        shouldBreak = false
        loopWarning = undefined
        try {
          const preparedMessages: ModelMessage[] = requestMessages.map(
            (message) => {
              if (message.role !== 'tool') return message
              return {
                ...message,
                content: message.content.map((part) => {
                  if (part.type !== 'tool_result') return part
                  const stored = getStoredResult(part.output)
                  if (!stored) return part
                  return {
                    ...part,
                    output: {
                      type: 'text' as const,
                      value:
                        stored.preview.includes(
                          '[tool result preview omitted; original available at path]',
                        ) || stored.preview.includes('[preview: first ')
                          ? `${stored.preview}\n\n[Full output: ${stored.path}; use read_file with offset to read the rest.]`
                          : stored.preview,
                    },
                  }
                }),
              }
            },
          )
          checkDrain()
          const result = streamProviderStep({
            model,
            system: inferenceSystem,
            messages: preparedMessages,
            tools: request.tools,
            supportsImages,
            reasoning: requestReasoning,
            abortSignal,
            onModelCallEnd: async (event) => {
              current.modelFinished(event.finishReason, event.toolCallIds)
              if (
                onCheckpoint &&
                (event.finishReason === 'stop' ||
                  event.finishReason === 'tool-calls') &&
                event.hasClientToolCalls
              ) {
                try {
                  const assistant = await event.buildCheckpoint()
                  checkpoints.set(current, assistant)
                  add(assistant, false)
                  await onCheckpoint()
                } catch (error) {
                  checkpointFailure = { error }
                }
              }
            },
          })

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
              case 'tool-call': {
                if (part.providerExecuted) hostedCalls.add(part.toolCallId)
                step.toolCallEnd(part)
                const detectResult = loopDetector.detect(
                  part.toolName,
                  part.input,
                )
                if (detectResult.stuck) {
                  emit({
                    type: 'loop_detected',
                    level: detectResult.level,
                    detector: detectResult.detector,
                    message: detectResult.message,
                  })
                  if (detectResult.level === 'critical') {
                    shouldBreak = true
                  } else if (detectResult.level === 'warning') {
                    // Appended after this step's assistant and tool messages, once the call that triggered it has a result
                    loopWarning = detectResult.message
                  }
                }
                loopDetector.record(part.toolCallId, part.toolName, part.input)
                break
              }
              case 'tool-error': {
                const hosted = hostedCalls.has(part.toolCallId)
                if (!hosted) {
                  showSources()
                  step.endBeforeResults()
                }
                toolRegistry.takeDetails(part.toolCallId)
                step.result(
                  part,
                  { error: part.error },
                  hosted && !step.providerExecuted(part.toolCallId),
                )
                if (!hosted)
                  await toolRegistry.recordRejection(
                    part.toolName,
                    part.toolCallId,
                    part.input,
                    part.error,
                  )
                toolRegistry.assertHealthy()
                break
              }
              case 'tool-result': {
                const hosted = hostedCalls.has(part.toolCallId)
                if (!hosted) {
                  showSources()
                  step.endBeforeResults()
                }
                step.result(
                  part,
                  {
                    output: part.output,
                    details: toolRegistry.takeDetails(part.toolCallId),
                  },
                  hosted && !step.providerExecuted(part.toolCallId),
                )
                break
              }
              case 'finish-step':
                showSources()
                step.end(part.finishReason)
                break
              case 'error': {
                // Errors from the model request or mid-stream: rethrow the original error so the retry
                // decision below uses the real cause. Otherwise the AI SDK reports NoOutputGeneratedError
                // at finalStep (so even a 400 would be retried), or treats the partial text before the
                // disconnect as a complete answer.
                throw part.error
              }
            }
          }

          finalStep = await result.getFinalStep()
          if (checkpointFailure) throw checkpointFailure.error
          abortSignal?.throwIfAborted()
          if (retried)
            emit({ type: 'auto_retry_end', success: true, attempt: retried })
          break
        } catch (error) {
          if (checkpointFailure) {
            const reason = errorMessageOf(checkpointFailure.error)
            keepInterrupted(
              step,
              'error',
              reason,
              `Tool was not executed because its checkpoint could not be saved: ${reason}`,
            )
            throw checkpointFailure.error
          }
          if (abortSignal?.aborted) {
            // Keep what this step produced: the text and whole tool calls so far, each call answered
            // (its real result, or "Operation aborted" like pi), so the model knows what already happened
            keepInterrupted(step, 'aborted', ABORTED_RESULT, ABORTED_RESULT)
            throw abortSignal.reason ?? error
          }
          if (isDraining?.()) {
            keepInterrupted(
              step,
              'aborted',
              'Run interrupted by graceful shutdown',
              'Tool was not executed because the model request was interrupted by shutdown.',
            )
            throw shutdown()
          }
          const errorMessage = errorMessageOf(error)
          // Once tools ran, sending the request again would run them twice
          // A provider-hosted tool can execute before its first stream event arrives.
          const canResend =
            !step.toolsStarted &&
            !checkpoints.has(step) &&
            !request.tools.hasHostedTools
          const apiError = inspectProviderApiError(error)
          if (
            (canResend ||
              (!step.toolsStarted &&
                apiError &&
                (apiError.statusCode === 400 ||
                  apiError.statusCode === 413))) &&
            !compactedForOverflow &&
            compactOnOverflow &&
            isContextOverflow(error)
          ) {
            // Like pi: the provider said the context is too long; compact once and send the step again
            step.endInterrupted('error', errorMessage)
            try {
              await recoverOverflow(abortSignal)
            } catch (compactError) {
              endTurnEmpty()
              abortSignal?.throwIfAborted()
              throw new Error(
                `${errorMessage} (compacting the context to recover failed: ${errorMessageOf(compactError)})`,
                { cause: error },
              )
            }
            continue
          }
          toolRegistry.assertHealthy()
          if (canResend && retried < limits.maxRetries && isRetryable(error)) {
            // Like pi: this attempt's message ends as an error (not kept in history) and the step is sent again
            step.endInterrupted('error', errorMessage)
            retried++
            const delay = calculateDelay(
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
              endTurnEmpty()
              throw sleepError
            })
            continue
          }
          if (retried)
            emit({
              type: 'auto_retry_end',
              success: false,
              attempt: retried,
              finalError: errorMessage,
            })
          keepInterrupted(
            step,
            'error',
            errorMessage,
            failedToolCallResult(errorMessage),
          )
          throw error
        }
      }

      if (!finalStep) {
        throw new Error('Agent loop did not receive a final response.')
      }

      const inputToken = finalStep.usage.inputTokens ?? 0
      if (inputToken > 0) tokenTracker.updateFromAPI(inputToken)

      // Normalize usage and record it in the shared tracker
      const norm = normalizeUsage(finalStep.usage)
      const modelId = typeof model === 'string' ? model : model.modelId
      const stepRecord = tokenTracker.record(modelId || 'mock-model', norm, {
        kind: 'main',
        usage: finalStep.usage,
        durationMs: performance.now() - started,
      })

      emit({
        type: 'usage',
        modelId: modelId || 'mock-model',
        usage: norm,
        record: stepRecord ?? undefined,
      })

      step.end(finalStep.finishReason)
      // Push this step's assistant and tool messages even on a critical stop: its tools already ran,
      // so the history must keep each call paired with its result
      // The SDK's response converts tool images to provider edge shapes. Keep canonical
      // tool content from the execution stream in history (also used on interrupted steps).
      const responseMessages: ModelMessage[] = finalStep.messages.map(
        (message) =>
          message.role !== 'tool'
            ? message
            : {
                ...message,
                content: message.content.map((part) =>
                  part.type === 'tool_result'
                    ? (step.results.get(part.toolCallId) ?? part)
                    : part,
                ),
              },
      )
      if (sources.size) {
        const message = responseMessages.find(
          (item) => item.role === 'assistant',
        )
        if (message && Array.isArray(message.content))
          message.content.push({
            type: 'text',
            text: `\n\nSources:\n${[...sources].map(([url, title]) => `- ${title}: ${url}`).join('\n')}`,
          })
      }
      if (finalStep.finishReason === 'length' && step.toolCalls.length) {
        // Like pi: the AI SDK runs no tools for a truncated response, and their arguments may be cut off.
        // Answer each call with an error so the history stays valid and the model re-issues them.
        for (const call of step.toolCalls)
          step.result(call, {
            error: new Error(truncatedToolCallResult(call.toolName)),
          })
        const toolMessage = step.toolMessage(true)
        if (toolMessage) responseMessages.push(toolMessage)
      }
      if (
        finalStep.finishReason === 'content-filter' &&
        step.toolCalls.length
      ) {
        // A blocked response never runs tools: answer each call with an error so the history stays valid
        for (const call of step.toolCalls)
          step.result(call, {
            error: new Error(failedToolCallResult(CONTENT_FILTER_ERROR)),
          })
        const toolMessage = step.toolMessage(true)
        if (toolMessage) responseMessages.push(toolMessage)
      }
      // The assistant message was announced while it streamed
      for (const message of responseMessages)
        if (message.role !== 'assistant' || !checkpoints.has(step))
          add(message, message.role !== 'assistant')
      const assistant = responseMessages.find(
        (message): message is AssistantModelMessage =>
          message.role === 'assistant',
      ) ?? { role: 'assistant', content: [] }
      const toolResults = toolResultsOf(responseMessages)
      const pausedHosted =
        finalStep.rawFinishReason === 'pause_turn' &&
        step.toolCalls.some((call) => call.providerExecuted)
      if (pausedHosted && ++hostedPauses > 3) {
        emit({ type: 'turn_end', turn, message: assistant, toolResults })
        throw new Error(
          'Provider-hosted tool did not finish after three continuations',
        )
      }
      if (!pausedHosted) hostedPauses = 0
      const needToolCall =
        pausedHosted || step.toolCalls.some((call) => !call.providerExecuted)

      if (finalStep.finishReason === 'content-filter') {
        // Like pi: a blocked response is final. Keep what streamed in history, end its turn, then fail the run.
        emit({ type: 'turn_end', turn, message: assistant, toolResults })
        throw new Error(CONTENT_FILTER_ERROR)
      }

      if (isDraining?.()) {
        emit({ type: 'turn_end', turn, message: assistant, toolResults })
        if (needToolCall) throw shutdown()
        endReason = 'done'
        break
      }

      if (shouldBreak) {
        emit({ type: 'turn_end', turn, message: assistant, toolResults })
        endReason = 'loop'
        break
      }

      if (loopWarning) {
        const notice = injectNotice?.(loopWarning)
        if (notice) add(notice)
      }

      // Every turn_start has a matching turn_end; the following agent_end gives the stop reason
      emit({ type: 'turn_end', turn, message: assistant, toolResults })
      // Steer messages queued during the run go after this step and before the next request;
      // followUp is checked only when the loop would otherwise end (like pi)
      let queued = (await takeSteering?.()) ?? []
      if (!needToolCall && queued.length === 0)
        queued = (await takeFollowUp?.()) ?? []
      for (const message of queued) add(message)
      if (!needToolCall && queued.length === 0) {
        endReason = 'done'
        break
      }
    }

    emit({
      type: 'agent_end',
      messages: newMessages,
      reason: endReason ?? 'done',
    })
  } catch (error) {
    emit({
      type: 'agent_end',
      messages: newMessages,
      reason: abortSignal?.aborted || isDraining?.() ? 'aborted' : 'error',
      error,
      ...(!abortSignal?.aborted &&
        !isDraining?.() && { errorKind: classifyAgentError(error) }),
    })
    throw error
  } finally {
    // streamText may end before an aborted tool finishes recording its outcome.
    if (abortSignal?.aborted) await toolRegistry.waitForIdle()
  }

  /** The step stopped while nothing of it is kept (aborted during a retry delay, failed compaction): still end the turn. */
  function endTurnEmpty(): void {
    emit({
      type: 'turn_end',
      turn,
      message: { role: 'assistant', content: [] },
      toolResults: [],
    })
  }

  /**
   * The step was aborted or failed for good: end its message as interrupted, answer its open tool calls, then
   * end the turn. A message the model finished (its tools were running) stays in history with every call
   * paired with a result. One cut off while streaming goes to the session record only (like pi, which skips
   * such messages when sending the context): none of its tools ran, since the AI SDK runs tools only after
   * the model call ends.
   */
  function keepInterrupted(
    step: StepMessage,
    stopReason: 'aborted' | 'error',
    errorMessage: string,
    openCallResult: string,
  ): void {
    step.endInterrupted(stopReason, errorMessage)
    const checkpoint = checkpoints.get(step)
    let assistant = checkpoint ?? step.snapshot({ complete: step.complete })
    if (checkpoint && Array.isArray(checkpoint.content)) {
      for (const call of checkpoint.content) {
        if (call.type !== 'tool_call' || call.providerExecuted) continue
        if (
          !step.toolCalls.some((known) => known.toolCallId === call.toolCallId)
        )
          step.toolCalls.push(call)
      }
    }
    step.closeOpenCalls(openCallResult)
    // A call that finished after the stream stopped never reached its tool-result: drop its details
    for (const call of step.toolCalls) toolRegistry.takeDetails(call.toolCallId)
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
    if (!checkpoint && !step.complete && !step.toolsStarted) {
      if (assistant.content.length) onInterrupted?.(assistant, stopReason)
    } else {
      if (!checkpoint && assistant.content.length) add(assistant, false)
      if (toolMessage) add(toolMessage)
    }
    emit({
      type: 'turn_end',
      turn,
      message: assistant,
      toolResults: [...step.results.values()],
    })
  }
}
