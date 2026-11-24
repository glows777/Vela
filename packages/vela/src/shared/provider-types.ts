/**
 * Provider-agnostic model handle, usage, finish reason, and hook contracts.
 *
 * Keeps `@ai-sdk/provider` and `ai` types completely inside `src/providers/`.
 */

import type { ProviderOptions } from './messages.ts'

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
