import type {
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  SharedV4Headers,
} from '@ai-sdk/provider'
import { type LanguageModel, wrapLanguageModel } from 'ai'

/** What the provider hook middleware calls (the extension runner, bound to one session). */
export interface ProviderHooks {
  /** Whether anyone handles the event, so idle hooks cost nothing */
  has(
    event:
      | 'before_provider_request'
      | 'after_provider_response'
      | 'provider_stream_event',
  ): boolean
  beforeRequest(
    params: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4CallOptions>
  afterResponse(headers: Record<string, string>): Promise<void>
  streamEvent(event: { provider: string; model: string; data: unknown }): void
}

/**
 * Wraps a model so every request goes through the extension provider hooks (pi's `before_provider_request`,
 * `after_provider_response` and `provider_stream_event`). Raw stream chunks are requested from the provider
 * only while someone listens to them, and are not passed on unless the caller asked for them too.
 * A model given by gateway id (a string) is returned unchanged.
 */
export function withProviderHooks(
  model: LanguageModel,
  hooks: ProviderHooks,
): LanguageModel {
  if (typeof model === 'string') return model
  const before = async (params: LanguageModelV4CallOptions) =>
    hooks.has('before_provider_request')
      ? await hooks.beforeRequest(params)
      : params
  const after = async (headers: SharedV4Headers | undefined) => {
    if (hooks.has('after_provider_response'))
      await hooks.afterResponse(stringHeaders(headers))
  }
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      // The inner model is called directly (not through doGenerate / doStream) so the hooks' params are used
      wrapGenerate: async ({ params, model: inner }) => {
        const result = await inner.doGenerate(await before(params))
        await after(result.response?.headers)
        return result
      },
      wrapStream: async ({ params, model: inner }) => {
        let request = await before(params)
        const listen = hooks.has('provider_stream_event')
        const added = listen && !request.includeRawChunks
        if (added) request = { ...request, includeRawChunks: true }
        const result = await inner.doStream(request)
        await after(result.response?.headers)
        if (!listen) return result
        const info = { provider: inner.provider, model: inner.modelId }
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream<
              LanguageModelV4StreamPart,
              LanguageModelV4StreamPart
            >({
              transform(part, controller) {
                if (part.type === 'raw') {
                  hooks.streamEvent({ ...info, data: part.rawValue })
                  if (added) return
                }
                controller.enqueue(part)
              },
            }),
          ),
        }
      },
    },
  })
}

function stringHeaders(
  headers: SharedV4Headers | undefined,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {}))
    if (value !== undefined) result[key] = value
  return result
}
