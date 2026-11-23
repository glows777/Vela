/**
 * Edge conversion between Vela's own `VelaMessage` and Vercel AI SDK `ModelMessage`.
 *
 * This is the ONLY layer that knows AI SDK wire shapes (`reasoning`, `tool-call`, `tool-result`,
 * `SharedV4FileData`, etc.). Everything outside `src/providers/` speaks `VelaMessage`.
 */

import type { SharedV4ProviderOptions } from '@ai-sdk/provider'
import type {
  ModelMessage as AIModelMessage,
  ToolResultPart as AIToolResultPart,
  UserContent as AIUserContent,
} from 'ai'
import type {
  AssistantContentPart,
  ProviderOptions,
  ToolMessageContentPart,
  ToolResultOutput,
  VelaAssistantMessage,
  VelaMessage,
  VelaToolMessage,
} from '../shared/messages.ts'

/** Canonical images plus legacy AI SDK image shapes accepted during transition. */
function isImagePart(part: { type: string; mediaType?: string }): boolean {
  return (
    part.type === 'image' ||
    part.type.startsWith('image-') ||
    (part.type === 'file' && /^image(?:\/|$)/i.test(part.mediaType ?? ''))
  )
}

/** AI SDK v7 / provider v4 tool media use nested `SharedV4FileData`. */
export function toAiToolOutput(
  output: ToolResultOutput,
): AIToolResultPart['output'] {
  if (output.type !== 'content') {
    return output as AIToolResultPart['output']
  }
  return {
    ...output,
    value: output.value.map((part) =>
      part.type === 'image'
        ? {
            type: 'file' as const,
            mediaType: part.mimeType,
            data: { type: 'data' as const, data: part.data },
          }
        : part,
    ),
  } as AIToolResultPart['output']
}

/** Convert an AI SDK `ToolResultPart['output']` back into Vela's `ToolResultOutput`. */
export function fromAiToolOutput(
  output: AIToolResultPart['output'],
): ToolResultOutput {
  if (output.type !== 'content') {
    return output as ToolResultOutput
  }
  return {
    ...output,
    value: output.value.map((part) =>
      part.type === 'file' &&
      part.mediaType.startsWith('image/') &&
      part.data.type === 'data'
        ? {
            type: 'image' as const,
            data: part.data.data,
            mimeType: part.mediaType,
          }
        : part,
    ),
  } as ToolResultOutput
}

/** Request-only conversion: fallback never removes images from saved history. */
export function toAiModelMessages(
  messages: VelaMessage[],
  supportsImages = true,
  toolImagesAsUser = false,
): AIModelMessage[] {
  const converted = messages.map((message): AIModelMessage => {
    if (message.role === 'system') {
      return {
        role: 'system',
        content: message.content,
        ...(message.providerOptions
          ? {
              providerOptions:
                message.providerOptions as SharedV4ProviderOptions,
            }
          : {}),
      }
    }
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        return {
          role: 'user',
          content: message.content,
          ...(message.providerOptions
            ? {
                providerOptions:
                  message.providerOptions as SharedV4ProviderOptions,
              }
            : {}),
        }
      }
      return {
        role: 'user',
        ...(message.providerOptions
          ? {
              providerOptions:
                message.providerOptions as SharedV4ProviderOptions,
            }
          : {}),
        content: message.content.map((part) => {
          if (part.type !== 'image' && !isImagePart(part)) return part
          if (!supportsImages) {
            return {
              type: 'text' as const,
              text: '(image omitted: model does not support images)',
            }
          }
          if (part.type === 'image') {
            const legacy = part as unknown as {
              data?: string | Uint8Array | URL | Record<string, string>
              mimeType?: string
              image?: string | Uint8Array | URL | Record<string, string>
              mediaType?: string
            }
            const rawData = legacy.data ?? legacy.image
            const data =
              rawData instanceof Uint8Array
                ? Buffer.from(rawData).toString('base64')
                : (rawData ?? '')
            const mediaType = legacy.mimeType ?? legacy.mediaType ?? 'image/png'
            return {
              type: 'file' as const,
              data,
              mediaType,
            }
          }
          return part
        }) as Exclude<AIUserContent, string>,
      }
    }
    if (message.role === 'assistant') {
      if (typeof message.content === 'string') {
        return {
          role: 'assistant',
          content: message.content,
          ...(message.providerOptions
            ? {
                providerOptions:
                  message.providerOptions as SharedV4ProviderOptions,
              }
            : {}),
        }
      }
      return {
        role: 'assistant',
        ...(message.providerOptions
          ? {
              providerOptions:
                message.providerOptions as SharedV4ProviderOptions,
            }
          : {}),
        content: message.content.map((part) => {
          const opts = part.providerOptions
            ? {
                providerOptions:
                  part.providerOptions as SharedV4ProviderOptions,
              }
            : {}
          switch (part.type) {
            case 'thinking':
              return { type: 'reasoning' as const, text: part.text, ...opts }
            case 'tool_call':
              return {
                type: 'tool-call' as const,
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
                ...(part.providerExecuted !== undefined
                  ? { providerExecuted: part.providerExecuted }
                  : {}),
                ...opts,
              }
            case 'tool_result':
              return {
                type: 'tool-result' as const,
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                output: toAiToolOutput(part.output),
                ...opts,
              }
            case 'text':
              return { type: 'text' as const, text: part.text, ...opts }
            case 'file':
              return {
                type: 'file' as const,
                data: part.data,
                mediaType: part.mediaType,
                ...(part.filename ? { filename: part.filename } : {}),
                ...opts,
              }
            case 'reasoning-file':
              return {
                type: 'reasoning-file' as const,
                data: part.data,
                mediaType: part.mediaType,
                ...opts,
              }
            case 'tool-approval-request':
              return {
                type: 'tool-approval-request' as const,
                approvalId: part.approvalId,
                toolCallId: part.toolCallId,
                ...opts,
              }
            case 'custom':
              return { type: 'custom' as const, kind: part.kind, ...opts }
            default: {
              const _never: never = part
              throw new Error(`Unsupported assistant part: ${String(_never)}`)
            }
          }
        }),
      } as AIModelMessage
    }
    return {
      role: 'tool',
      ...(message.providerOptions
        ? {
            providerOptions: message.providerOptions as SharedV4ProviderOptions,
          }
        : {}),
      content: message.content.map((part) => {
        if (part.type === 'tool-approval-response') {
          return {
            type: 'tool-approval-response' as const,
            approvalId: part.approvalId,
            approved: part.approved,
            ...(part.reason !== undefined ? { reason: part.reason } : {}),
            ...(part.providerOptions
              ? {
                  providerOptions:
                    part.providerOptions as SharedV4ProviderOptions,
                }
              : {}),
          }
        }
        return {
          type: 'tool-result' as const,
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          ...(part.providerOptions
            ? {
                providerOptions:
                  part.providerOptions as SharedV4ProviderOptions,
              }
            : {}),
          output: toAiToolOutput(
            part.output.type === 'content' && !supportsImages
              ? {
                  ...part.output,
                  value: part.output.value.map((item) =>
                    isImagePart(item)
                      ? {
                          type: 'text' as const,
                          text: '(tool image omitted: model does not support images)',
                        }
                      : item,
                  ),
                }
              : part.output,
          ),
        }
      }),
    } as AIModelMessage
  })

  // Chat-compatible adapters serialize tool content as JSON text. Lift images after the
  // complete consecutive tool-result group, so all outstanding calls stay answered first.
  const result: AIModelMessage[] = []
  let lifted: Exclude<AIUserContent, string> = []
  const flush = () => {
    if (lifted.length) result.push({ role: 'user', content: lifted })
    lifted = []
  }
  for (const message of converted) {
    if (message.role !== 'tool') {
      flush()
      result.push(message)
      continue
    }
    result.push({
      ...message,
      content: message.content.map((part) => {
        if (part.type !== 'tool-result' || part.output.type !== 'content')
          return part
        const isError = 'isError' in part.output && part.output.isError === true
        if (!isError && (!toolImagesAsUser || !supportsImages)) return part
        const liftedBefore = lifted.length
        const value = part.output.value.filter((item) => {
          if (
            supportsImages &&
            item.type === 'file' &&
            item.mediaType.startsWith('image/') &&
            item.data.type === 'data'
          ) {
            lifted.push({
              type: 'file',
              mediaType: item.mediaType,
              data: item.data.data,
            })
            return false
          }
          return true
        })
        return {
          ...part,
          output: isError
            ? {
                type: 'error-text' as const,
                value:
                  value
                    .filter((item) => item.type === 'text')
                    .map((item) => item.text)
                    .join('\n') || 'Tool reported an error',
              }
            : value.length || lifted.length === liftedBefore
              ? { ...part.output, value }
              : {
                  type: 'text' as const,
                  value: '(tool image follows in the next user message)',
                },
        }
      }),
    })
  }
  flush()
  return result
}

/** Convert an AI SDK `ResponseMessage` (assistant or tool) into a canonical `VelaMessage`. */
export function fromAiResponseMessage(
  message: AIModelMessage,
): VelaAssistantMessage | VelaToolMessage {
  const providerOptions = message.providerOptions as ProviderOptions | undefined
  if (message.role === 'tool') {
    const content: ToolMessageContentPart[] = []
    for (const part of message.content) {
      if (part.type === 'tool-approval-response') {
        content.push({
          type: 'tool-approval-response',
          approvalId: part.approvalId,
          approved: part.approved,
          ...(part.reason !== undefined ? { reason: part.reason } : {}),
          ...('providerOptions' in part && part.providerOptions
            ? { providerOptions: part.providerOptions as ProviderOptions }
            : {}),
        })
        continue
      }
      if (part.type !== 'tool-result') continue
      content.push({
        type: 'tool_result',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: fromAiToolOutput(part.output),
        ...(part.providerOptions
          ? { providerOptions: part.providerOptions as ProviderOptions }
          : {}),
      })
    }
    return {
      role: 'tool',
      content,
      ...(providerOptions ? { providerOptions } : {}),
    }
  }

  if (message.role === 'assistant') {
    if (typeof message.content === 'string') {
      return {
        role: 'assistant',
        content: message.content,
        ...(providerOptions ? { providerOptions } : {}),
      }
    }
    const content: AssistantContentPart[] = []
    for (const part of message.content) {
      const partOpts =
        'providerOptions' in part && part.providerOptions
          ? { providerOptions: part.providerOptions as ProviderOptions }
          : {}
      switch (part.type) {
        case 'text':
          content.push({ type: 'text', text: part.text, ...partOpts })
          break
        case 'reasoning':
          content.push({ type: 'thinking', text: part.text, ...partOpts })
          break
        case 'tool-call':
          content.push({
            type: 'tool_call',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
            ...(part.providerExecuted !== undefined
              ? { providerExecuted: part.providerExecuted }
              : {}),
            ...partOpts,
          })
          break
        case 'tool-result':
          content.push({
            type: 'tool_result',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: fromAiToolOutput(part.output),
            providerExecuted: true,
            ...partOpts,
          })
          break
        case 'file':
          content.push({
            type: 'file',
            data: part.data as string | Uint8Array | URL,
            mediaType: part.mediaType,
            ...(part.filename ? { filename: part.filename } : {}),
            ...partOpts,
          })
          break
        case 'reasoning-file':
          content.push({
            type: 'reasoning-file',
            data: part.data as string | Uint8Array | URL,
            mediaType: part.mediaType,
            ...partOpts,
          })
          break
        case 'tool-approval-request':
          content.push({
            type: 'tool-approval-request',
            approvalId: part.approvalId,
            toolCallId: part.toolCallId,
            ...partOpts,
          })
          break
        case 'custom':
          content.push({ type: 'custom', kind: part.kind, ...partOpts })
          break
      }
    }
    return {
      role: 'assistant',
      content,
      ...(providerOptions ? { providerOptions } : {}),
    }
  }

  return { role: 'assistant', content: [] }
}
