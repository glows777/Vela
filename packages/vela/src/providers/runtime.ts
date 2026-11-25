/**
 * AI SDK execution edge: ALL `streamText`, `generateText`, `tool`, `jsonSchema`, and
 * `parsePartialJson` calls live strictly inside `src/providers/`.
 */

import {
  tool as AITool,
  jsonSchema as aiJsonSchema,
  parsePartialJson as aiParsePartialJson,
  asSchema,
  generateText,
  type LanguageModel,
  streamText,
  type Tool,
  type ToolSet,
} from 'ai'
import type {
  ProviderOptions,
  VelaAssistantMessage,
  VelaMessage,
  VelaToolMessage,
} from '../shared/messages.ts'
import type {
  FinishReason,
  ModelInput,
  ProviderUsage,
  ReasoningOption,
} from '../shared/provider-types.ts'
import { type ToolInputSchema, toJsonSchema } from '../shared/tool-schema.ts'
import { withPromptCache } from './cache.ts'
import { fromAiResponseMessage, toAiModelMessages } from './messages.ts'
import type { HostedToolModel } from './models/index.ts'
import { isAnthropicMessagesModel } from './models-config.ts'
import {
  applyStreamedMetadata,
  deepMergeProviderOptions,
  type StreamedPartMetadata,
  type StreamedSlot,
} from './stream-metadata.ts'

export { aiParsePartialJson as parsePartialJson }

export interface ProviderToolSpec {
  name: string
  description: string
  inputSchema: ToolInputSchema
  hostedOnly?: true
}

export interface ResolvedProviderTools {
  /** Opaque AI SDK ToolSet passed to `streamProviderStep`. */
  readonly sdkTools: ToolSet
  /** Plain JSON Schema tool definitions for token estimation. */
  readonly toolDefinitions: unknown[]
  /** True when at least one provider-hosted tool is active. */
  readonly hasHostedTools: boolean
}

async function extractJsonSchema(
  schema: ToolInputSchema,
): Promise<Record<string, unknown>> {
  const isLegacyZodV3 =
    typeof schema === 'object' &&
    schema !== null &&
    '_def' in schema &&
    !('_zod' in schema)
  return isLegacyZodV3
    ? ((await asSchema(
        // biome-ignore lint/suspicious/noExplicitAny: Zod v3 schema adapted at provider edge
        schema as any,
      ).jsonSchema) as Record<string, unknown>)
    : await toJsonSchema(schema)
}

/** Build AI SDK `ToolSet` + plain JSON Schema definitions for a model request. */
export async function resolveProviderTools(
  model: ModelInput,
  tools: ProviderToolSpec[],
  options: {
    reasoning?: ReasoningOption
  } = {},
): Promise<ResolvedProviderTools> {
  const hostedTools: ToolSet =
    typeof model === 'string'
      ? {}
      : (((await (model as HostedToolModel).hostedTools?.({
          reasoning: options.reasoning,
        })) as ToolSet | undefined) ?? {})

  const sdkTools: Record<string, Tool> = {}
  const toolDefinitions: unknown[] = []
  let hasHostedTools = false

  for (const spec of tools) {
    const hosted = hostedTools[spec.name]
    if (hosted) {
      sdkTools[spec.name] = hosted
      if (hosted.type === 'provider') {
        hasHostedTools = true
        toolDefinitions.push({
          type: hosted.type,
          name: spec.name,
          id: hosted.id,
          args: hosted.args,
        })
      } else {
        toolDefinitions.push({
          name: spec.name,
          description:
            typeof hosted.description === 'string'
              ? hosted.description
              : undefined,
          inputSchema: await extractJsonSchema(
            hosted.inputSchema as unknown as ToolInputSchema,
          ),
          strict: hosted.strict,
          providerOptions: hosted.providerOptions,
          inputExamples: hosted.inputExamples,
        })
      }
      continue
    }
    if (spec.hostedOnly) continue

    const jsonSchemaObj = await extractJsonSchema(spec.inputSchema)
    toolDefinitions.push({
      name: spec.name,
      description: spec.description,
      inputSchema: jsonSchemaObj,
    })

    // Wrap every inputSchema with aiJsonSchema so AI SDK preserves raw parsed JSON args
    // without running Zod .transform() or custom validate() twice (tool-executor runs full schema validation once).
    const sdkSchema = aiJsonSchema(jsonSchemaObj)

    sdkTools[spec.name] = AITool({
      description: spec.description,
      // biome-ignore lint/suspicious/noExplicitAny: Zod or JSON Schema adapted for AI SDK
      inputSchema: sdkSchema as any,
    })
  }

  return { sdkTools, toolDefinitions, hasHostedTools }
}

/** Provider-agnostic stream chunks yielded by `streamProviderStep`. */
export type ProviderStreamPart =
  | { type: 'text-start'; id: string; providerMetadata?: ProviderOptions }
  | {
      type: 'text-delta'
      id: string
      text: string
      providerMetadata?: ProviderOptions
    }
  | { type: 'text-end'; id: string; providerMetadata?: ProviderOptions }
  | { type: 'reasoning-start'; id: string; providerMetadata?: ProviderOptions }
  | {
      type: 'reasoning-delta'
      id: string
      text: string
      providerMetadata?: ProviderOptions
    }
  | { type: 'reasoning-end'; id: string; providerMetadata?: ProviderOptions }
  | { type: 'source'; sourceType: string; url: string; title?: string }
  | {
      type: 'tool-input-start'
      id: string
      toolName: string
      providerMetadata?: ProviderOptions
      providerExecuted?: boolean
    }
  | { type: 'tool-input-delta'; id: string; delta: string }
  | {
      type: 'tool-call'
      toolCallId: string
      toolName: string
      input: unknown
      providerExecuted?: boolean
      providerMetadata?: ProviderOptions
    }
  | {
      type: 'tool-error'
      toolCallId: string
      toolName: string
      input: unknown
      error: unknown
    }
  | {
      type: 'tool-result'
      toolCallId: string
      toolName: string
      output: unknown
    }
  | { type: 'finish-step'; finishReason: FinishReason }
  | { type: 'error'; error: unknown }

export interface ProviderStepFinal {
  finishReason: FinishReason
  rawFinishReason?: string
  usage: ProviderUsage
  messages: (VelaAssistantMessage | VelaToolMessage)[]
}

export interface StreamProviderStepOptions {
  model: ModelInput
  system: string
  messages: VelaMessage[]
  tools: ResolvedProviderTools
  supportsImages?: boolean
  reasoning?: ReasoningOption
  maxOutputTokens?: number
  sessionId?: string
  abortSignal?: AbortSignal
}

function isAnthropicModel(model: LanguageModel): boolean {
  if (typeof model === 'string') return model.startsWith('anthropic/')
  return (
    isAnthropicMessagesModel(model) || model.provider.startsWith('anthropic')
  )
}

export function streamProviderStep(options: StreamProviderStepOptions): {
  stream: AsyncIterable<ProviderStreamPart>
  getFinalStep: () => Promise<ProviderStepFinal>
} {
  const aiModel = options.model as LanguageModel
  const toolImagesAsUser =
    typeof options.model !== 'string' &&
    options.model.provider.endsWith('.chat')
  const modelMessages = toAiModelMessages(
    options.messages,
    options.supportsImages ?? true,
    toolImagesAsUser,
    { normalizeToolCallIds: isAnthropicModel(aiModel) },
  )
  const streamedMeta: StreamedPartMetadata = {
    text: [],
    reasoning: [],
    tools: new Map(),
  }
  const textIndices = new Map<string, number>()
  const reasoningIndices = new Map<string, number>()
  const recordSlotMeta = (
    indices: Map<string, number>,
    list: StreamedSlot[],
    id: string,
    meta: unknown,
    isStart: boolean,
    hasDeltaText = false,
  ) => {
    let idx = indices.get(id)
    if (idx === undefined && isStart) {
      idx = list.length
      indices.set(id, idx)
      list.push({ hasContent: false, meta: {} })
    }
    if (idx === undefined) return
    const slot = list[idx]!
    if (hasDeltaText) slot.hasContent = true
    if (meta)
      slot.meta = deepMergeProviderOptions(slot.meta, meta as ProviderOptions)!
  }
  const recordToolMeta = (id: string, meta: unknown) => {
    if (!meta) return
    streamedMeta.tools.set(
      id,
      deepMergeProviderOptions(
        streamedMeta.tools.get(id),
        meta as ProviderOptions,
      )!,
    )
  }

  const result = streamText({
    model: aiModel,
    ...withPromptCache({
      system: options.system,
      tools: options.tools.sdkTools,
      messages: modelMessages,
    }),
    maxRetries: 0,
    ...(options.maxOutputTokens !== undefined
      ? { maxOutputTokens: options.maxOutputTokens }
      : {}),
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
    ...(options.sessionId
      ? { providerOptions: { openai: { promptCacheKey: options.sessionId } } }
      : {}),
    abortSignal: options.abortSignal,
    onError: () => {},
  })

  const stream: AsyncIterable<ProviderStreamPart> = {
    async *[Symbol.asyncIterator]() {
      for await (const part of result.stream) {
        switch (part.type) {
          case 'text-start':
            recordSlotMeta(
              textIndices,
              streamedMeta.text,
              part.id,
              part.providerMetadata,
              true,
            )
            yield {
              type: 'text-start',
              id: part.id,
              providerMetadata: part.providerMetadata as
                | ProviderOptions
                | undefined,
            }
            break
          case 'text-delta':
            recordSlotMeta(
              textIndices,
              streamedMeta.text,
              part.id,
              part.providerMetadata,
              false,
              part.text.length > 0,
            )
            yield {
              type: 'text-delta',
              id: part.id,
              text: part.text,
              providerMetadata: part.providerMetadata as
                | ProviderOptions
                | undefined,
            }
            break
          case 'text-end':
            recordSlotMeta(
              textIndices,
              streamedMeta.text,
              part.id,
              part.providerMetadata,
              false,
            )
            yield {
              type: 'text-end',
              id: part.id,
              providerMetadata: part.providerMetadata as
                | ProviderOptions
                | undefined,
            }
            break
          case 'reasoning-start':
            recordSlotMeta(
              reasoningIndices,
              streamedMeta.reasoning,
              part.id,
              part.providerMetadata,
              true,
            )
            yield {
              type: 'reasoning-start',
              id: part.id,
              providerMetadata: part.providerMetadata as
                | ProviderOptions
                | undefined,
            }
            break
          case 'reasoning-delta':
            recordSlotMeta(
              reasoningIndices,
              streamedMeta.reasoning,
              part.id,
              part.providerMetadata,
              false,
              part.text.length > 0,
            )
            yield {
              type: 'reasoning-delta',
              id: part.id,
              text: part.text,
              providerMetadata: part.providerMetadata as
                | ProviderOptions
                | undefined,
            }
            break
          case 'reasoning-end':
            recordSlotMeta(
              reasoningIndices,
              streamedMeta.reasoning,
              part.id,
              part.providerMetadata,
              false,
            )
            yield {
              type: 'reasoning-end',
              id: part.id,
              providerMetadata: part.providerMetadata as
                | ProviderOptions
                | undefined,
            }
            break
          case 'source':
            if (part.sourceType === 'url') {
              yield {
                type: 'source',
                sourceType: part.sourceType,
                url: part.url,
                title: part.title,
              }
            }
            break
          case 'tool-input-start':
            recordToolMeta(part.id, part.providerMetadata)
            yield {
              type: 'tool-input-start',
              id: part.id,
              toolName: part.toolName,
              providerMetadata: part.providerMetadata as
                | ProviderOptions
                | undefined,
              providerExecuted: part.providerExecuted,
            }
            break
          case 'tool-input-delta':
            yield {
              type: 'tool-input-delta',
              id: part.id,
              delta: part.delta,
            }
            break
          case 'tool-call':
            recordToolMeta(part.toolCallId, part.providerMetadata)
            yield {
              type: 'tool-call',
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
              providerExecuted: part.providerExecuted,
              providerMetadata: part.providerMetadata as
                | ProviderOptions
                | undefined,
            }
            break
          case 'tool-error':
            yield {
              type: 'tool-error',
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
              error: part.error,
            }
            break
          case 'tool-result':
            yield {
              type: 'tool-result',
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              output: part.output,
            }
            break
          case 'finish-step':
            yield {
              type: 'finish-step',
              finishReason: part.finishReason as FinishReason,
            }
            break
          case 'error':
            yield { type: 'error', error: part.error }
            break
        }
      }
    },
  }

  const getFinalStep = async (): Promise<ProviderStepFinal> => {
    const step = await result.finalStep
    return {
      finishReason: step.finishReason as FinishReason,
      rawFinishReason: step.rawFinishReason,
      usage: step.usage as ProviderUsage,
      messages: step.response.messages.map((message) => {
        const converted = fromAiResponseMessage(message)
        return converted.role === 'assistant'
          ? applyStreamedMetadata(converted, streamedMeta)
          : converted
      }),
    }
  }

  return { stream, getFinalStep }
}

/** Single-shot non-streaming text generation (used by compaction & memory dream). */
export async function generateProviderText(options: {
  model: ModelInput
  instructions: string
  messages?: VelaMessage[]
  prompt?: string
  abortSignal?: AbortSignal
  maxOutputTokens?: number
}): Promise<{
  text: string
  finishReason: FinishReason
  toolCallCount: number
  usage: ProviderUsage
}> {
  const aiModel = options.model as LanguageModel
  const response = options.messages
    ? await generateText({
        model: aiModel,
        instructions: options.instructions,
        messages: toAiModelMessages(options.messages, false, false, {
          normalizeToolCallIds: isAnthropicModel(aiModel),
        }),
        abortSignal: options.abortSignal,
        maxOutputTokens: options.maxOutputTokens,
        maxRetries: 0,
      })
    : await generateText({
        model: aiModel,
        instructions: options.instructions,
        prompt: options.prompt ?? '',
        abortSignal: options.abortSignal,
        maxOutputTokens: options.maxOutputTokens,
        maxRetries: 0,
      })
  return {
    text: response.text,
    finishReason: response.finishReason as FinishReason,
    toolCallCount: response.toolCalls.length,
    usage: response.usage as ProviderUsage,
  }
}
