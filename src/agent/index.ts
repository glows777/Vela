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
  MAX_INPUT_TOKENS,
  type RequestSnapshot,
} from '../context/request'
import type { ToolRegistry } from '../tools/registry'
import { normalizeUsage, type TokenTracker } from '../usage/tracker'
import {
  detectLoop,
  recordToolCall,
  recordToolCallResult,
  resetHistory,
} from './loop-detection'
import { calculateDelay, isRetryable, sleep } from './retry'

const MAX_TURN = 15
const MAX_RETRIES = 3
const TOKEN_BUDGET = 200 * 1000

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
}: AgentLoopParameter) => {
  let turn = 0
  tokenTracker.beginLoop()
  resetHistory() // 每次新的 agent loop 开始时重置工具调用历史

  const currentSystem = () =>
    typeof systemPrompt === 'function' ? systemPrompt() : systemPrompt
  try {
    while (turn < MAX_TURN) {
      abortSignal?.throwIfAborted()
      toolRegistry.assertHealthy()
      turn++
      console.log(`\n--- Agent Loop Turn ${turn} ---\n`)

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
        ) > MAX_INPUT_TOKENS
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
                process.stdout.write(part.text)
                fullContent += part.text
                break
              }
              case 'tool-call': {
                needToolCall = true
                console.log(
                  `\n  [tool called: ${part.toolName}->(${JSON.stringify(part.input)})]`,
                )

                const detectResult = detectLoop(part.toolName, part.input)
                if (detectResult.stuck) {
                  console.log(detectResult.message)
                  if (detectResult.level === 'critical') {
                    shouldBreak = true
                  } else if (detectResult.level === 'warning') {
                    messages.push({
                      role: 'user',
                      content: `[system message] ${detectResult.message}.\n Please change your idea and try again.Don't repeat the same tool call again.`,
                    })
                  }
                }
                recordToolCall(part.toolCallId, part.toolName, part.input)
                break
              }
              case 'tool-error': {
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
                recordToolCallResult(
                  part.toolCallId,
                  part.toolName,
                  part.input,
                  part.output,
                )
                console.log(
                  `  [tool called result: ${part.toolName}->${JSON.stringify(part.output)}]`,
                )
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
          if (attempt > MAX_RETRIES || !isRetryable(error as Error)) throw error
          const delay = calculateDelay(attempt)
          console.log(
            `  [Retry] Attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delay}ms...`,
          )
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

      // cache 命中时才打印一行简洁状态，让 cache hit 立刻可见
      if (
        stepRecord &&
        (norm.cacheReadTokens > 0 || norm.cacheWriteTokens > 0)
      ) {
        const tag =
          norm.cacheReadTokens > 0
            ? `\x1b[38;5;36m✓ cache hit\x1b[0m`
            : `\x1b[38;5;220m✎ cache write\x1b[0m`
        const detail =
          norm.cacheReadTokens > 0
            ? `read ${norm.cacheReadTokens}`
            : `write ${norm.cacheWriteTokens}`
        console.log(
          `\n [${tag}] ${detail} tokens · current step $${stepRecord.cost.toFixed(5)}`,
        )
      }

      if (shouldBreak) {
        console.log(
          '\nAgent is stuck in a loop and has reached the critical threshold. Ending loop.',
        )
        break
      }

      const responseMessages: ModelMessage[] = finalStep.response.messages
      messages.push(...responseMessages)
      tokenTracker.addMessages(responseMessages)

      if (tokenTracker.loopTokens > TOKEN_BUDGET * 0.9) {
        console.log(
          `  [Token] ${tokenTracker.loopTokens}/${TOKEN_BUDGET} (${Math.round((tokenTracker.loopTokens / TOKEN_BUDGET) * 100)}%)`,
        )
      }
      if (tokenTracker.loopTokens > TOKEN_BUDGET) {
        console.log('\n[Token has exceeded the budget limit. Ending loop.]')
        break
      }

      if (!needToolCall) {
        console.log('\n--- Agent has completed its response. Ending loop. ---')
        break
      }

      console.log('agent needs to call tool, continue to next turn')
    }

    if (turn >= MAX_TURN) {
      console.log(
        '\nReached maximum turn limit. Ending loop to prevent infinite execution.',
      )
    }
  } finally {
    // streamText may end before an aborted tool finishes recording its outcome.
    if (abortSignal?.aborted) await toolRegistry.waitForIdle()
  }
}
