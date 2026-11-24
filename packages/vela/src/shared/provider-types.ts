/**
 * Provider-agnostic model handle, usage, finish reason, and hook contracts.
 *
 * Keeps `@ai-sdk/provider` and `ai` types completely inside `src/providers/`.
 */

import type { ProviderOptions } from './messages.ts'
import type { ModelPricing } from './pricing.ts'

/** Thinking level (like pi). Maps to the AI SDK `reasoning` call option. */
export type ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

/** @experimental Shared thinking-level choices for frontends. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

/** Default thinking level (like pi). */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium'

/** Explicit provider compatibility settings; model fields override provider fields. */
export interface ModelCompat {
  hostedTools?: 'web_search'[]
  store?: boolean
  /** Whether Responses accepts the developer role (pi's supportsDeveloperRole); false keeps system. */
  supportsDeveloperRole?: boolean
  /** Recover DeepSeek Responses plaintext reasoning deltas dropped by the OpenAI SDK. */
  deepseekReasoningStream?: boolean
  includeWebSearchSources?: boolean
}

/** Model metadata (a `config.json` provider model entry or a catalog entry, same field names as pi). */
export interface ModelSpec {
  id: string
  compat?: ModelCompat
  /** Display name */
  name?: string
  /** Context window in tokens; when set, compaction thresholds and the input cap derive from it */
  contextWindow?: number
  /** Maximum output tokens */
  maxTokens?: number
  /** Whether thinking is supported; false limits the thinking level to `off` */
  reasoning?: boolean
  /**
   * Provider value per thinking level (pi's thinkingLevelMap); `null` marks a level the model doesn't support.
   * `xhigh` and `max` are only offered when listed here.
   */
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>
  /** Input types (`text`, `image`) */
  input?: string[]
  /** Price in $ / 1M tokens; used for usage stats when set */
  cost?: ModelPricing
}

/** Wire protocol of a `config.json` provider (pi's `api` field; only these are supported). */
export type ProviderApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'

export const PROVIDER_APIS: readonly ProviderApi[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
]

/** One provider in `~/.vela/config.json` (same shape as pi's `models.json`). */
export interface ProviderConfig {
  api?: ProviderApi
  baseUrl?: string
  /** `$VAR` / `${VAR}` reads an environment variable */
  apiKey?: string
  headers?: Record<string, string>
  models?: ModelSpec[]
  compat?: ModelCompat
}

/** Opaque handle to a resolved language model; concrete AI SDK instances stay inside `src/providers/`. */
export interface ModelHandle {
  readonly specificationVersion: string
  readonly provider: string
  readonly modelId: string
}

/** Either a `provider/id` reference string or a resolved `ModelHandle`. */
export type ModelInput = string | ModelHandle

/** Normalized finish reason across providers. */
export type FinishReason =
  | 'stop'
  | 'length'
  | 'content-filter'
  | 'tool-calls'
  | 'error'
  | 'other'
  | 'interrupted'

/** Reasoning effort level passed to providers. */
export type ReasoningOption =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

/** Provider-reported token usage for a single model request. */
export interface ProviderUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  inputTokenDetails?: {
    noCacheTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  outputTokenDetails?: {
    textTokens?: number
    reasoningTokens?: number
  }
  raw?: unknown
}

/** Provider-agnostic request parameters exposed to `before_provider_request` hooks. */
export type ProviderRequestParams = Record<string, unknown> & {
  prompt?: unknown[]
  tools?: unknown[]
  headers?: Record<string, string | undefined>
  includeRawChunks?: boolean
  providerOptions?: ProviderOptions
}

/** Provider hook callbacks invoked around model requests. */
export interface ProviderHooks {
  /** Whether anyone handles the event, so idle hooks cost nothing. */
  has(
    event:
      | 'before_provider_request'
      | 'after_provider_response'
      | 'provider_stream_event'
      | 'tool_call',
    toolName?: string,
  ): boolean
  beforeRequest(params: ProviderRequestParams): Promise<ProviderRequestParams>
  afterResponse(headers: Record<string, string>): Promise<void>
  streamEvent(event: { provider: string; model: string; data: unknown }): void
}

/** Parsed error details extracted from a provider HTTP/API error inside `src/providers/`. */
export interface ProviderApiErrorInfo {
  statusCode?: number
  responseBody?: string
  isRetryable: boolean
  message: string
}
