import {
  type AssistantModelMessage,
  type LanguageModel,
  type ModelMessage,
  streamText,
  type Tool,
  type ToolSet,
} from 'ai'
import {
  createRequestSnapshot,
  estimateRequestTokens,
  type RequestSnapshot,
} from '../context/request.ts'
import { resolveLimits, type VelaLimits } from '../limits.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import { normalizeUsage, type TokenTracker } from '../usage/tracker.ts'
import { withPromptCache } from './cache.ts'
import type { VelaEvent, VelaEventListener } from './events.ts'
import { LoopDetector } from './loop-detection.ts'
import { isContextOverflow } from './overflow.ts'
import { calculateDelay, isRetryable, sleep } from './retry.ts'
import {
  ABORTED_RESULT,
  errorMessageOf,
  failedToolCallResult,
  StepMessage,
  toolResultsOf,
  truncatedToolCallResult,
} from './step.ts'

interface AgentLoopParameter {
  model: LanguageModel
  systemPrompt: string | (() => string)
  toolRegistry: ToolRegistry
  messages: ModelMessage[]
  tokenTracker: TokenTracker
  prepareContext?: (request: RequestSnapshot) => Promise<void>
  /**
   * Called once per step when the provider rejects the request because the context is too long (like pi's
   * overflow recovery): compacts the history, then the step is sent again. A second overflow fails the loop.
   */
  compactOnOverflow?: (signal?: AbortSignal) => Promise<void>
  abortSignal?: AbortSignal
  /** Event callback; without it agentLoop produces no terminal output. */
  onEvent?: VelaEventListener
  /** Retry, context and other limits; missing fields use defaults. */
  limits?: Partial<VelaLimits>
  /** AI SDK reasoning option (mapped from the thinking level); not sent when omitted */
  reasoning?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  /**
   * Takes queued steer messages (like pi's getSteeringMessages): called once after each step's tools
   * finish and before the next model request; results are appended as user messages. If the model
   * was about to stop and steer messages arrive, the loop keeps going.
   */
  takeSteering?: () => string[]
  /**
   * Takes queued followUp messages (like pi's getFollowUpMessages): called when the model is about to
   * stop (no tool calls, no steer); results run as user messages in the same loop.
   */
  takeFollowUp?: () => string[]
  /** Messages already added for this loop (e.g. the user input); agent_end reports them plus the loop's own. */
  newMessages?: ModelMessage[]
}

// support tools as array or object, if array, convert to object with title as key
const resolveTools = (tools: ToolSet | Tool[]): ToolSet => {
  if (!Array.isArray(tools)) {
    return tools
  }

  return tools.reduce<ToolSet>((resolvedTools, tool) => {
    const title = tool.title?.trim()

    if (!title) {
      throw new Error('Tool arrays require every tool to have a title.')
    }

    if (Object.hasOwn(resolvedTools, title)) {
      throw new Error(`Duplicate tool title: ${title}`)
    }

    resolvedTools[title] = tool
    return resolvedTools
  }, {})
}

export const agentLoop = async ({
  model,
  systemPrompt,
  toolRegistry,
  messages,
  tokenTracker,
  prepareContext,
  compactOnOverflow,
  abortSignal,
  onEvent,
  limits: limitOverrides,
  reasoning,
  takeSteering,
  takeFollowUp,
  newMessages = [],
}: AgentLoopParameter) => {
  const limits = resolveLimits(limitOverrides)
  let turn = 0
  // Each agent loop has its own call history, so concurrent sessions don't interfere
  const loopDetector = new LoopDetector()
  const emit = (event: VelaEvent) => onEvent?.(event)
  let endReason: Extract<VelaEvent, { type: 'agent_end' }>['reason'] | undefined

  /** Adds a message to history; one-shot messages (user, tool, reminders) get message_start / message_end. */
  const add = (message: ModelMessage, announce = true) => {
    messages.push(message)
    newMessages.push(message)
    tokenTracker.addMessage(message)
    if (announce) {
      emit({ type: 'message_start', message })
      emit({ type: 'message_end', message })
    }
  }

  const currentSystem = () =>
    typeof systemPrompt === 'function' ? systemPrompt() : systemPrompt
  try {
    // Like pi: no turn limit. Run until the model stops calling tools and nothing is queued
    // (or until aborted / stopped by loop detection)
    for (;;) {
      abortSignal?.throwIfAborted()
      toolRegistry.assertHealthy()
      turn++
      emit({ type: 'turn_start', turn })

      // Prepare context before every actual model request, including tool continuations.
      const request = await createRequestSnapshot(
        model,
        currentSystem(),
        toolRegistry.toAISDKFormat(),
        messages,
        abortSignal,
      )
      await prepareContext?.(request)
      abortSignal?.throwIfAborted()
      const inferenceSystem = currentSystem()
      if (
        estimateRequestTokens(
          { ...request, systemPrompt: inferenceSystem },
          messages,
        ) > limits.maxInputTokens
      )
        throw new Error(
          'Request exceeds the safe input size; this turn was stopped.',
        )

      let shouldBreak = false
      let loopWarning: string | undefined
      let finalStep:
        | Awaited<ReturnType<typeof streamText>['finalStep']>
        | undefined
      let step!: StepMessage
      // Retry attempts that already failed (auto_retry_start was emitted for each)
      let retried = 0
      let compactedForOverflow = false

      const started = performance.now()
      for (;;) {
        const current = new StepMessage(emit)
        step = current
        shouldBreak = false
        loopWarning = undefined
        try {
          const result = streamText({
            model,
            // Messages are copied here, so compaction or an abort never sees cache markers in history
            ...withPromptCache({
              system: inferenceSystem,
              tools: request.tools,
              messages,
            }),
            maxRetries: 0, // No retries inside streamText; the loop below handles retries
            ...(reasoning ? { reasoning } : {}),
            abortSignal,
            // Errors are thrown in the 'error' branch below and reported via events, not printed by the SDK
            onError: () => {},
            // The model finished (tools run only after this): its tool calls tell when the message is complete
            onLanguageModelCallEnd: (event) =>
              current.modelFinished(
                event.finishReason,
                event.content.flatMap((part) =>
                  part.type === 'tool-call' ? [part.toolCallId] : [],
                ),
              ),
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
              case 'tool-input-start':
                step.toolCallStart(
                  part.id,
                  part.toolName,
                  part.providerMetadata,
                )
                break
              case 'tool-input-delta':
                await step.toolCallDelta(part.id, part.delta)
                break
              case 'tool-call': {
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
                    // Append after this step's assistant/tool messages so the reminder follows the call that triggered it
                    loopWarning = `[system message] ${detectResult.message}.\n Please change your idea and try again.Don't repeat the same tool call again.`
                  }
                }
                loopDetector.record(part.toolCallId, part.toolName, part.input)
                break
              }
              case 'tool-error': {
                step.endBeforeResults()
                step.result(part, { error: part.error })
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
                step.endBeforeResults()
                step.result(part, { output: part.output })
                break
              }
              case 'finish-step':
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

          finalStep = await result.finalStep
          abortSignal?.throwIfAborted()
          if (retried)
            emit({ type: 'auto_retry_end', success: true, attempt: retried })
          break
        } catch (error) {
          if (abortSignal?.aborted) {
            // Keep what this step produced: the text and whole tool calls so far, each call answered
            // (its real result, or "Operation aborted" like pi), so the model knows what already happened
            keepInterrupted(step, 'aborted', ABORTED_RESULT, ABORTED_RESULT)
            throw abortSignal.reason ?? error
          }
          const errorMessage = errorMessageOf(error)
          // Once tools ran, sending the request again would run them twice
          const canResend = !step.toolsStarted
          if (
            canResend &&
            !compactedForOverflow &&
            compactOnOverflow &&
            isContextOverflow(error)
          ) {
            // Like pi: the provider said the context is too long; compact once and send the step again
            step.endInterrupted('error', errorMessage)
            compactedForOverflow = true
            try {
              await compactOnOverflow(abortSignal)
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
      const responseMessages: ModelMessage[] = [...finalStep.response.messages]
      if (finalStep.finishReason === 'length' && step.toolCalls.length) {
        // Like pi: the AI SDK runs no tools for a truncated response, and their arguments may be cut off.
        // Answer each call with an error so the history stays valid and the model re-issues them.
        for (const call of step.toolCalls)
          step.result(call, {
            error: new Error(truncatedToolCallResult(call.toolName)),
          })
        const toolMessage = step.toolMessage()
        if (toolMessage) responseMessages.push(toolMessage)
      }
      // The assistant message was announced while it streamed
      for (const message of responseMessages)
        add(message, message.role !== 'assistant')
      const assistant = responseMessages.find(
        (message): message is AssistantModelMessage =>
          message.role === 'assistant',
      ) ?? { role: 'assistant', content: [] }
      const toolResults = toolResultsOf(responseMessages)
      const needToolCall = step.toolCalls.length > 0

      if (shouldBreak) {
        emit({ type: 'turn_end', turn, message: assistant, toolResults })
        endReason = 'loop'
        break
      }

      if (loopWarning) add({ role: 'user', content: loopWarning })

      // Every turn_start has a matching turn_end; the following agent_end gives the stop reason
      emit({ type: 'turn_end', turn, message: assistant, toolResults })
      // Steer messages queued during the run go after this step and before the next request;
      // followUp is checked only when the loop would otherwise end (like pi)
      let queued = takeSteering?.() ?? []
      if (!needToolCall && queued.length === 0) queued = takeFollowUp?.() ?? []
      for (const text of queued) add({ role: 'user', content: text })
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
      reason: abortSignal?.aborted ? 'aborted' : 'error',
      error,
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
   * The step was aborted or failed for good: end its message as interrupted and keep it in history with
   * whatever streamed (text, whole tool calls), every tool call paired with a result, then end the turn.
   */
  function keepInterrupted(
    step: StepMessage,
    stopReason: 'aborted' | 'error',
    errorMessage: string,
    openCallResult: string,
  ): void {
    step.endInterrupted(stopReason, errorMessage)
    const assistant = step.snapshot({ complete: step.complete })
    step.closeOpenCalls(openCallResult)
    const toolMessage = step.toolMessage()
    if (assistant.content.length) add(assistant, false)
    if (toolMessage) add(toolMessage)
    emit({
      type: 'turn_end',
      turn,
      message: assistant,
      toolResults: toolMessage ? toolResultsOf([toolMessage]) : [],
    })
  }
}
