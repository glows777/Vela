import {
  type ProviderToolSpec,
  type ResolvedProviderTools,
  resolveProviderTools,
} from '../../providers/index.ts'
import type { ModelInput } from '../../shared/provider-types.ts'
import {
  estimateMessagesTokens,
  estimateTextTokens,
  type ModelMessage,
} from '../messages.ts'

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

/** Estimate tokens for plain JSON Schema tool definitions. */
export function estimateToolDefinitionsTokens(
  toolDefinitions: unknown[],
): number {
  return estimateTextTokens(JSON.stringify(toolDefinitions))
}

// Weighted ASCII/CJK local estimate, not a provider tokenizer.
export function estimateRequestTokens(
  request: RequestSnapshot,
  messages = request.messages,
): number {
  return (
    estimateTextTokens(request.systemPrompt) +
    estimateToolDefinitionsTokens(request.toolDefinitions) +
    estimateMessagesTokens(messages)
  )
}

export function contextRequestTokens(
  request: RequestSnapshot,
  reported: number | undefined,
  estimate?: number,
): number {
  return reported ?? estimate ?? estimateRequestTokens(request)
}
