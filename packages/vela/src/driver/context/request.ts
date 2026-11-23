import {
  type ProviderToolSpec,
  type ResolvedProviderTools,
  resolveProviderTools,
} from '../../providers/index.ts'
import { DEFAULT_LIMITS } from '../../shared/limits.ts'
import type { ModelInput } from '../../shared/provider-types.ts'
import { type ModelMessage, messageEnvelopeChars } from '../messages.ts'

export interface RequestSnapshot {
  model: ModelInput
  systemPrompt: string
  tools: ResolvedProviderTools
  messages: ModelMessage[]
  toolDefinitions: unknown[]
  abortSignal?: AbortSignal
  /** Model output limit for summarization, independent of compaction thresholds. */
  maxOutputTokens?: number
}

export function createRequestSnapshot(
  model: ModelInput,
  systemPrompt: string,
  tools: ResolvedProviderTools,
  messages: ModelMessage[],
  abortSignal?: AbortSignal,
): RequestSnapshot {
  return {
    model,
    systemPrompt,
    tools,
    messages: messages.slice(),
    toolDefinitions: tools.toolDefinitions,
    abortSignal,
  }
}

export async function resolveRequestSnapshot(
  model: ModelInput,
  systemPrompt: string,
  tools: ProviderToolSpec[],
  messages: ModelMessage[],
  abortSignal?: AbortSignal,
  maxOutputTokens?: number,
): Promise<RequestSnapshot> {
  const resolved = await resolveProviderTools(model, tools)
  const request = createRequestSnapshot(
    model,
    systemPrompt,
    resolved,
    messages,
    abortSignal,
  )
  request.maxOutputTokens = maxOutputTokens
  return request
}

// A conservative, consistent local estimate, not a provider tokenizer.
export function estimateRequestTokens(
  request: RequestSnapshot,
  messages = request.messages,
): number {
  return Math.ceil(
    (request.systemPrompt.length +
      JSON.stringify(request.toolDefinitions).length +
      messageEnvelopeChars(messages)) *
      0.3,
  )
}

/** Prefer the provider's latest prompt size plus the local message delta. */
export function contextRequestTokens(
  request: RequestSnapshot,
  reported: number | undefined,
  estimate?: number,
): number {
  return reported ?? estimate ?? estimateRequestTokens(request)
}

export const MAX_INPUT_TOKENS = DEFAULT_LIMITS.maxInputTokens
