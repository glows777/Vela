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
} from '../context/request'
import { resolveLimits, type VelaLimits } from '../limits'
import type { ToolRegistry } from '../tools/registry'
import { normalizeUsage, type TokenTracker } from '../usage/tracker'
import type { VelaEvent, VelaEventListener } from './events'
import { LoopDetector } from './loop-detection'
import { calculateDelay, isRetryable, sleep } from './retry'

export interface BudgetState {
  used: number
  limit: number
}

interface AgentLoopParameter {
  model: LanguageModel
  systemPrompt: string | (() => string)
  toolRegistry: ToolRegistry
  messages: ModelMessage[]
  tokenTracker: TokenTracker
  prepareContext?: (request: RequestSnapshot) => Promise<void>
  abortSignal?: AbortSignal
  /** 运行事件回调；不传时 agentLoop 不产生任何终端输出。 */
  onEvent?: VelaEventListener
  /** 轮数、重试、预算等上限；未给出的字段用默认值。 */
  limits?: Partial<VelaLimits>
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
}: AgentLoopParameter) => {
  const limits = resolveLimits(limitOverrides)
  let turn = 0
  tokenTracker.beginLoop()
  // 每次 agent loop 使用独立的调用历史，并发会话互不影响
  const loopDetector = new LoopDetector()
  const emit = (event: VelaEvent) => onEvent?.(event)
  let endReason: Extract<VelaEvent, { type: 'agent_end' }>['reason'] | undefined

  const currentSystem = () =>
    typeof systemPrompt === 'function' ? systemPrompt() : systemPrompt
  try {
    while (turn < limits.maxTurns) {
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
        throw new Error('当前请求超过安全容量，本轮已停止。')

      let needToolCall = false
      let fullContent = ''
      let shouldBreak = false
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
            maxRetries: 0, // 禁止 streamText 内部重试，交由外层控制重试逻辑
            abortSignal,
          })

          for await (const part of result.stream) {
            switch (part.type) {
              case 'text-delta': {
                emit({ type: 'text_delta', text: part.text })
                fullContent += part.text
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
                    messages.push({
                      role: 'user',
                      content: `[system message] ${detectResult.message}.\n Please change your idea and try again.Don't repeat the same tool call again.`,
                    })
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
          if (attempt > limits.maxRetries || !isRetryable(error as Error)) throw error
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
        }
      }

      if (!finalStep) {
        throw new Error('Agent loop did not receive a final response.')
      }

      const inputToken = finalStep.usage.inputTokens ?? 0
      if (inputToken > 0) tokenTracker.updateFromAPI(inputToken)

      // 将 usage 归一化后记录到统一 tracker，并累计当前 loop 的完整 token 预算
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
        endReason = 'loop'
        break
      }

      const responseMessages: ModelMessage[] = finalStep.response.messages
      messages.push(...responseMessages)
      tokenTracker.addMessages(responseMessages)

      if (tokenTracker.loopTokens > limits.tokenBudget * 0.9) {
        emit({
          type: 'budget_warning',
          used: tokenTracker.loopTokens,
          limit: limits.tokenBudget,
        })
      }
      if (tokenTracker.loopTokens > limits.tokenBudget) {
        endReason = 'budget'
        break
      }

      emit({ type: 'turn_end', turn, needsToolCall: needToolCall })
      if (!needToolCall) {
        endReason = 'done'
        break
      }
    }

    // 没有任何 break 时说明 while 条件耗尽，即达到轮次上限
    emit({ type: 'agent_end', reason: endReason ?? 'max_turns' })
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
