import {
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
import type { VelaEvent, VelaEventListener } from './events.ts'
import { LoopDetector } from './loop-detection.ts'
import { calculateDelay, isRetryable, sleep } from './retry.ts'

interface AgentLoopParameter {
  model: LanguageModel
  systemPrompt: string | (() => string)
  toolRegistry: ToolRegistry
  messages: ModelMessage[]
  tokenTracker: TokenTracker
  prepareContext?: (request: RequestSnapshot) => Promise<void>
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
  abortSignal,
  onEvent,
  limits: limitOverrides,
  reasoning,
  takeSteering,
  takeFollowUp,
}: AgentLoopParameter) => {
  const limits = resolveLimits(limitOverrides)
  let turn = 0
  // Each agent loop has its own call history, so concurrent sessions don't interfere
  const loopDetector = new LoopDetector()
  const emit = (event: VelaEvent) => onEvent?.(event)
  let endReason: Extract<VelaEvent, { type: 'agent_end' }>['reason'] | undefined

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
        throw new Error('Request exceeds the safe input size; this turn was stopped.')

      let needToolCall = false
      let fullContent = ''
      let shouldBreak = false
      let loopWarning: string | undefined
      let finalStep:
        | Awaited<ReturnType<typeof streamText>['finalStep']>
        | undefined

      const started = performance.now()
      for (let attempt = 1; ; attempt++) {
        try {
          const result = streamText({
            model,
            instructions: inferenceSystem,
            tools: request.tools,
            messages,
            maxRetries: 0, // No retries inside streamText; the outer loop handles retries
            ...(reasoning ? { reasoning } : {}),
            abortSignal,
            // Errors are thrown in the 'error' branch below and reported via retry/agent_end events, not printed by the SDK
            onError: () => {},
          })

          for await (const part of result.stream) {
            switch (part.type) {
              case 'text-delta': {
                emit({ type: 'text_delta', text: part.text })
                fullContent += part.text
                break
              }
              case 'reasoning-delta': {
                emit({ type: 'thinking_delta', text: part.text })
                break
              }
              case 'tool-call': {
                needToolCall = true
                emit({
                  type: 'tool_call',
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  input: part.input,
                })

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
                emit({
                  type: 'tool_error',
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  input: part.input,
                  error: part.error,
                })
                await toolRegistry.recordRejection(
                  part.toolName,
                  part.toolCallId,
                  part.input,
                  part.error,
                )
                toolRegistry.assertHealthy()
                break
              }
              case 'error': {
                // Errors from the model request or mid-stream: rethrow the original error so the retry
                // decision below uses the real cause. Otherwise the AI SDK reports NoOutputGeneratedError
                // at finalStep (so even a 400 would be retried), or treats the partial text before the
                // disconnect as a complete answer.
                throw part.error
              }
              case 'tool-result': {
                loopDetector.recordResult(
                  part.toolCallId,
                  part.toolName,
                  part.input,
                  part.output,
                )
                emit({
                  type: 'tool_result',
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  input: part.input,
                  output: part.output,
                })
                break
              }
            }
          }

          finalStep = await result.finalStep
          abortSignal?.throwIfAborted()
          break
        } catch (error) {
          abortSignal?.throwIfAborted()
          toolRegistry.assertHealthy()
          if (attempt > limits.maxRetries || !isRetryable(error as Error))
            throw error
          const delay = calculateDelay(
            attempt,
            limits.retryBaseMs,
            limits.retryMaxMs,
          )
          emit({
            type: 'retry',
            attempt,
            maxRetries: limits.maxRetries,
            delayMs: delay,
            error,
          })
          await sleep(delay, abortSignal)
          needToolCall = false
          fullContent = ''
          shouldBreak = false
          loopWarning = undefined
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

      if (shouldBreak) {
        emit({ type: 'turn_end', turn, needsToolCall: needToolCall })
        endReason = 'loop'
        break
      }

      const responseMessages: ModelMessage[] = finalStep.response.messages
      messages.push(...responseMessages)
      tokenTracker.addMessages(responseMessages)
      for (const message of responseMessages) emit({ type: 'message', message })
      if (loopWarning) {
        const warning: ModelMessage = { role: 'user', content: loopWarning }
        messages.push(warning)
        tokenTracker.addMessage(warning)
        emit({ type: 'message', message: warning })
      }

      // Every turn_start has a matching turn_end; the following agent_end gives the stop reason
      emit({ type: 'turn_end', turn, needsToolCall: needToolCall })
      // Steer messages queued during the run go after this step and before the next request;
      // followUp is checked only when the loop would otherwise end (like pi)
      let queued = takeSteering?.() ?? []
      if (!needToolCall && queued.length === 0) queued = takeFollowUp?.() ?? []
      for (const text of queued) {
        const message: ModelMessage = { role: 'user', content: text }
        messages.push(message)
        tokenTracker.addMessage(message)
        emit({ type: 'message', message })
      }
      if (!needToolCall && queued.length === 0) {
        endReason = 'done'
        break
      }
    }

    emit({ type: 'agent_end', reason: endReason ?? 'done' })
  } catch (error) {
    emit({
      type: 'agent_end',
      reason: abortSignal?.aborted ? 'aborted' : 'error',
      error,
    })
    throw error
  } finally {
    // streamText may end before an aborted tool finishes recording its outcome.
    if (abortSignal?.aborted) await toolRegistry.waitForIdle()
  }
}
