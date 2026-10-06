import {
  asSchema,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai'
import { DEFAULT_LIMITS } from '../limits'

export interface RequestSnapshot {
  model: LanguageModel
  systemPrompt: string
  tools: ToolSet
  messages: ModelMessage[]
  toolDefinitions: unknown[]
  abortSignal?: AbortSignal
}

export async function createRequestSnapshot(
  model: LanguageModel,
  systemPrompt: string,
  tools: ToolSet,
  messages: ModelMessage[],
  abortSignal?: AbortSignal,
): Promise<RequestSnapshot> {
  const toolDefinitions = await Promise.all(
    Object.entries(tools).map(async ([name, tool]) => {
      if (tool.type === 'provider')
        return { type: tool.type, name, id: tool.id, args: tool.args }
      return {
        name,
        description:
          typeof tool.description === 'string' ? tool.description : undefined,
        inputSchema: await asSchema(tool.inputSchema).jsonSchema,
        strict: tool.strict,
        providerOptions: tool.providerOptions,
        inputExamples: tool.inputExamples,
      }
    }),
  )
  return {
    model,
    systemPrompt,
    tools,
    messages: messages.slice(),
    toolDefinitions,
    abortSignal,
  }
}

// A conservative, consistent local estimate, not a provider tokenizer.
export function estimateRequestTokens(
  request: RequestSnapshot,
  messages = request.messages,
): number {
  return Math.ceil(
    (request.systemPrompt.length +
      JSON.stringify(request.toolDefinitions).length +
      JSON.stringify(messages).length) *
      0.3,
  )
}

export const MAX_INPUT_TOKENS = DEFAULT_LIMITS.maxInputTokens
