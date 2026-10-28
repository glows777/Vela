import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { LanguageModelMiddleware } from 'ai'
import { isPlainObject } from './interpolate.ts'

/** The OpenAI SDK opens/closes reasoning items but drops DeepSeek's text deltas. */
export const deepseekReasoningStream: LanguageModelMiddleware['wrapStream'] =
  async ({ model, params }) => {
    const result = await model.doStream({ ...params, includeRawChunks: true })
    const reasoning = new Map<string, string>()
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream<
          LanguageModelV4StreamPart,
          LanguageModelV4StreamPart
        >({
          transform(part, controller) {
            if (part.type !== 'raw') {
              if (
                part.type === 'reasoning-start' ||
                part.type === 'reasoning-end'
              ) {
                const itemId = part.providerMetadata?.openai?.itemId
                if (typeof itemId === 'string') {
                  if (part.type === 'reasoning-start')
                    reasoning.set(itemId, part.id)
                  else reasoning.delete(itemId)
                }
              }
              controller.enqueue(part)
              return
            }
            if (params.includeRawChunks) controller.enqueue(part)
            const event = part.rawValue
            if (
              isPlainObject(event) &&
              event.type === 'response.reasoning_text.delta' &&
              typeof event.item_id === 'string' &&
              typeof event.delta === 'string'
            ) {
              const id = reasoning.get(event.item_id)
              if (id)
                controller.enqueue({
                  type: 'reasoning-delta',
                  id,
                  delta: event.delta,
                })
            }
          },
        }),
      ),
    }
  }
