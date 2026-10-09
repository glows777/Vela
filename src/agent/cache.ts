import type { SharedV4ProviderOptions } from '@ai-sdk/provider'
import type { ModelMessage, SystemModelMessage, ToolSet } from 'ai'

/**
 * Anthropic prompt caching, like pi (`ai/src/api/anthropic-messages.ts`): a cache breakpoint on the system prompt,
 * the last tool definition and the last message, so each request reuses the prefix the previous one wrote.
 * The `anthropic` provider options are only read by the Anthropic provider; other providers ignore them.
 * Messages and tools are copied, never changed: history keeps no cache markers.
 */
const cacheControl = { type: 'ephemeral' } as const

/** Adds the cache breakpoint to provider options, keeping any other Anthropic options already set. */
const withCacheControl = (
  providerOptions: SharedV4ProviderOptions | undefined,
): SharedV4ProviderOptions => ({
  ...providerOptions,
  anthropic: { ...providerOptions?.anthropic, cacheControl },
})

export function withPromptCache(request: {
  system: string
  tools: ToolSet
  messages: ModelMessage[]
}): {
  instructions: SystemModelMessage
  tools: ToolSet
  messages: ModelMessage[]
} {
  const names = Object.keys(request.tools)
  const lastTool = names.at(-1)
  const tools =
    lastTool === undefined
      ? request.tools
      : {
          ...request.tools,
          [lastTool]: {
            ...request.tools[lastTool],
            providerOptions: withCacheControl(
              request.tools[lastTool]?.providerOptions,
            ),
          } as ToolSet[string],
        }
  const last = request.messages.at(-1)
  const messages =
    last === undefined
      ? request.messages
      : [
          ...request.messages.slice(0, -1),
          {
            ...last,
            providerOptions: withCacheControl(last.providerOptions),
          } as ModelMessage,
        ]
  return {
    instructions: {
      role: 'system',
      content: request.system,
      providerOptions: withCacheControl(undefined),
    },
    tools,
    messages,
  }
}
