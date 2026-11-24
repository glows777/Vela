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
  type LanguageModelCallEndEvent,
  streamText,
  type Tool,
  type ToolSet,
} from 'ai'
import type {
  AssistantContentPart,
  ProviderOptions,
  ToolContent,
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
import {
  isVelaJsonSchema,
  type ToolInputSchema,
  toJsonSchema,
} from '../shared/tool-schema.ts'
import { withPromptCache } from './cache.ts'
import {
  fromAiResponseMessage,
  fromAiToolOutput,
  toAiModelMessages,
  toAiToolOutput,
} from './messages.ts'
import type { HostedToolModel } from './models/index.ts'

export { aiParsePartialJson as parsePartialJson }

export interface ProviderToolSpec {
  name: string
  description: string
  inputSchema: ToolInputSchema
  hostedOnly?: true
  execute: (
    input: unknown,
    options: { toolCallId?: string; abortSignal?: AbortSignal },
  ) => Promise<unknown>
}

export interface ResolvedProviderTools {
  /** Opaque AI SDK ToolSet passed to `streamProviderStep`. */
  readonly sdkTools: ToolSet
  /** Plain JSON Schema tool definitions for token estimation. */
  readonly toolDefinitions: unknown[]
  /** True when at least one provider-hosted tool is active. */
  readonly hasHostedTools: boolean
}

function isToolContentValue(value: unknown): value is ToolContent {
  return (
    Array.isArray(value) &&
    value.every(
      (part) =>
        part &&
        typeof part === 'object' &&
        (part.type === 'image' ||
          (part.type === 'text' && typeof part.text === 'string')),
    )
  )
}

/** Build AI SDK `ToolSet` + plain JSON Schema definitions for a model request. */
export async function resolveProviderTools(
  model: ModelInput,
  tools: ProviderToolSpec[],
  options: {
    reasoning?: ReasoningOption
    wrapExecute?: (
      execute: (
        input: unknown,
        options: { toolCallId?: string; abortSignal?: AbortSignal },
      ) => Promise<unknown>,
    ) => (
      input: unknown,
      options: { toolCallId?: string; abortSignal?: AbortSignal },
    ) => Promise<unknown>
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
      sdkTools[spec.name] =
        options.wrapExecute && hosted.execute
          ? {
              ...hosted,
              execute: (input, execOptions) =>
                options.wrapExecute!((wrappedInput, wrappedOptions) =>
                  Promise.resolve(
                    hosted.execute!(wrappedInput, {
                      ...execOptions,
                      toolCallId:
                        wrappedOptions.toolCallId ?? execOptions.toolCallId,
                      abortSignal:
                        wrappedOptions.abortSignal ?? execOptions.abortSignal,
                    }),
                  ),
                )(input, {
                  toolCallId: execOptions?.toolCallId,
                  abortSignal: execOptions?.abortSignal,
                }),
            }
          : hosted
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
          inputSchema: await toJsonSchema(
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

    const isLegacyZodV3 =
      typeof spec.inputSchema === 'object' &&
      spec.inputSchema !== null &&
      '_def' in spec.inputSchema &&
      !('_zod' in spec.inputSchema)
    const jsonSchemaObj = isLegacyZodV3
      ? ((await asSchema(
          // biome-ignore lint/suspicious/noExplicitAny: Zod v3 schema adapted at provider edge
          spec.inputSchema as any,
        ).jsonSchema) as Record<string, unknown>)
      : await toJsonSchema(spec.inputSchema)
    toolDefinitions.push({
      name: spec.name,
      description: spec.description,
      inputSchema: jsonSchemaObj,
    })

    const sdkSchema = isVelaJsonSchema(spec.inputSchema)
      ? aiJsonSchema(jsonSchemaObj, {
          validate: spec.inputSchema.validate
            ? async (value) => {
                const validator = spec.inputSchema as {
                  validate: (
                    v: unknown,
                  ) => Promise<
                    | { success: true; value: unknown }
                    | { success: false; error: Error }
                  >
                }
                const res = await validator.validate(value)
                return res.success
                  ? { success: true as const, value: res.value }
                  : { success: false as const, error: res.error }
              }
            : undefined,
        })
      : spec.inputSchema

    const runExecute = options.wrapExecute
      ? options.wrapExecute(spec.execute)
      : spec.execute

    sdkTools[spec.name] = AITool({
      description: spec.description,
      // biome-ignore lint/suspicious/noExplicitAny: Zod or JSON Schema adapted for AI SDK
      inputSchema: sdkSchema as any,
      toModelOutput: ({ output }) =>
        isToolContentValue(output)
          ? toAiToolOutput({ type: 'content', value: output })
          : typeof output === 'string'
            ? { type: 'text', value: output }
            : {
                type: 'json',
                value: JSON.parse(JSON.stringify(output ?? null)),
              },
      execute: async (input, execOptions) =>
        runExecute(input, {
          toolCallId: execOptions?.toolCallId,
          abortSignal: execOptions?.abortSignal,
        }),
    })
  }

  return { sdkTools, toolDefinitions, hasHostedTools }
}

/** Convert an AI SDK `LanguageModelCallEndEvent` into a Vela checkpoint assistant message. */
async function checkpointMessage(
  event: LanguageModelCallEndEvent,
  tools: ToolSet,
): Promise<VelaAssistantMessage> {
  const content: AssistantContentPart[] = []
  const sources = new Map<string, string>()
  for (const part of event.content) {
    if (part.type === 'source') {
      if (part.sourceType === 'url')
        sources.set(part.url, part.title ?? part.url)
      continue
    }
    const providerOptions =
      'providerMetadata' in part
        ? (part.providerMetadata as ProviderOptions | undefined)
        : undefined
    switch (part.type) {
      case 'text':
        if (part.text || providerOptions)
          content.push({ type: 'text', text: part.text, providerOptions })
        break
      case 'reasoning':
        if (part.text || providerOptions)
          content.push({ type: 'thinking', text: part.text, providerOptions })
        break
      case 'custom':
        content.push({ type: 'custom', kind: part.kind, providerOptions })
        break
      case 'file':
      case 'reasoning-file':
        content.push({
          type: part.type,
          data: part.file.base64,
          mediaType: part.file.mediaType,
          providerOptions,
        })
        break
      case 'tool-call':
        content.push({
          type: 'tool_call',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input:
            part.invalid && typeof part.input !== 'object' ? {} : part.input,
          providerExecuted: part.providerExecuted,
          providerOptions,
        })
        break
      case 'tool-result':
      case 'tool-error':
        if (part.providerExecuted) {
          const output =
            part.type === 'tool-error'
              ? ({
                  type: 'error-json',
                  value: JSON.parse(JSON.stringify(part.error) ?? 'null'),
                } as const)
              : tools[part.toolName]?.toModelOutput
                ? fromAiToolOutput(
                    await tools[part.toolName]!.toModelOutput!({
                      toolCallId: part.toolCallId,
                      input: part.input,
                      output: part.output,
                    }),
                  )
                : typeof part.output === 'string'
                  ? ({ type: 'text', value: part.output } as const)
                  : ({
                      type: 'json',
                      value: JSON.parse(JSON.stringify(part.output) ?? 'null'),
                    } as const)
          content.push({
            type: 'tool_result',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output,
            providerExecuted: true,
            providerOptions,
          })
        }
        break
    }
  }
  if (sources.size)
    content.push({
      type: 'text',
      text: `\n\nSources:\n${[...sources].map(([url, title]) => `- ${title}: ${url}`).join('\n')}`,
    })
  return { role: 'assistant', content }
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
  abortSignal?: AbortSignal
  onModelCallEnd?: (info: {
    finishReason: FinishReason
    toolCallIds: string[]
    hasClientToolCalls: boolean
    buildCheckpoint: () => Promise<VelaAssistantMessage>
  }) => Promise<void>
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
  )

  const result = streamText({
    model: aiModel,
    ...withPromptCache({
      system: options.system,
      tools: options.tools.sdkTools,
      messages: modelMessages,
    }),
    maxRetries: 0,
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
    abortSignal: options.abortSignal,
    onError: () => {},
    onLanguageModelCallEnd: options.onModelCallEnd
      ? async (event) => {
          const toolCallIds = event.content.flatMap((part) =>
            part.type === 'tool-call' ? [part.toolCallId] : [],
          )
          const hasClientToolCalls = event.content.some(
            (part) => part.type === 'tool-call' && !part.providerExecuted,
          )
          await options.onModelCallEnd!({
            finishReason: event.finishReason as FinishReason,
            toolCallIds,
            hasClientToolCalls,
            buildCheckpoint: () =>
              checkpointMessage(event, options.tools.sdkTools),
          })
        }
      : undefined,
  })

  const stream: AsyncIterable<ProviderStreamPart> = {
    async *[Symbol.asyncIterator]() {
      for await (const part of result.stream) {
        switch (part.type) {
          case 'text-start':
            yield {
              type: 'text-start',
              id: part.id,
              providerMetadata: part.providerMetadata as
                | ProviderOptions
                | undefined,
            }
            break
          case 'text-delta':
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
            yield {
              type: 'text-end',
              id: part.id,
              providerMetadata: part.providerMetadata as
                | ProviderOptions
                | undefined,
            }
            break
          case 'reasoning-start':
            yield {
              type: 'reasoning-start',
              id: part.id,
              providerMetadata: part.providerMetadata as
                | ProviderOptions
                | undefined,
            }
            break
          case 'reasoning-delta':
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
      messages: step.response.messages.map((message) =>
        fromAiResponseMessage(message),
      ),
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
        messages: toAiModelMessages(options.messages, false),
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
