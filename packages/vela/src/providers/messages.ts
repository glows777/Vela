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

const IMAGE_MEDIA_TYPE = /^image(?:\/|$)/i

/** Canonical images (or image file parts). */
function isImagePart(part: { type: string; mediaType?: string }): boolean {
  return (
    part.type === 'image' ||
    (part.type === 'file' && IMAGE_MEDIA_TYPE.test(part.mediaType ?? ''))
  )
}

function binaryDataToBase64(data: unknown): string {
  if (typeof data === 'string') return data
  if (data instanceof Uint8Array) return Buffer.from(data).toString('base64')
  if (data instanceof ArrayBuffer)
    return Buffer.from(new Uint8Array(data)).toString('base64')
  return String(data)
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
            ...(part.providerOptions
              ? { providerOptions: part.providerOptions }
              : {}),
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
    value: output.value.map((part) => {
      const rec = part as Record<string, unknown>
      const providerOptions =
        'providerOptions' in rec && rec.providerOptions
          ? (rec.providerOptions as ProviderOptions)
          : undefined
      const opts = providerOptions ? { providerOptions } : {}
      if (
        part.type === 'file' &&
        IMAGE_MEDIA_TYPE.test(part.mediaType) &&
        part.data.type === 'data'
      ) {
        return {
          type: 'image' as const,
          data: binaryDataToBase64(part.data.data),
          mimeType: part.mediaType,
          ...opts,
        }
      }
      return part
    }),
  } as ToolResultOutput
}

function omitImagesInToolOutput(
  output: ToolResultOutput,
  supportsImages: boolean,
): ToolResultOutput {
  if (output.type !== 'content' || supportsImages) return output
  return {
    ...output,
    value: output.value.map((item) =>
      isImagePart(item)
        ? {
            type: 'text' as const,
            text: '(tool image omitted: model does not support images)',
          }
        : item,
    ),
  }
}

const ANTHROPIC_TOOL_ID = /^[a-zA-Z0-9_-]{1,64}$/

function createToolIdNormalizer() {
  const mapped = new Map<string, string>()
  const used = new Set<string>()
  return (raw: string): string => {
    const existing = mapped.get(raw)
    if (existing !== undefined) return existing
    let candidate = ANTHROPIC_TOOL_ID.test(raw)
      ? raw
      : raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'tool_call'
    if (candidate !== raw && used.has(candidate)) {
      let n = 1
      let suffixed = `${candidate.slice(0, 56)}_${n}`
      while (used.has(suffixed)) suffixed = `${candidate.slice(0, 56)}_${++n}`
      candidate = suffixed
    }
    used.add(candidate)
    mapped.set(raw, candidate)
    return candidate
  }
}

function mergeConsecutiveAssistants(
  messages: AIModelMessage[],
): AIModelMessage[] {
  const merged: AIModelMessage[] = []
  for (const msg of messages) {
    const prev = merged.at(-1)
    if (msg.role === 'assistant' && prev?.role === 'assistant') {
      const toParts = (content: AIModelMessage['content']) =>
        typeof content === 'string'
          ? content
            ? [{ type: 'text' as const, text: content }]
            : []
          : content
      const parts = [...toParts(prev.content), ...toParts(msg.content)]
      merged[merged.length - 1] = {
        ...prev,
        ...(msg.providerOptions
          ? {
              providerOptions: {
                ...prev.providerOptions,
                ...msg.providerOptions,
              },
            }
          : {}),
        content: parts,
      } as AIModelMessage
      continue
    }
    merged.push(msg)
  }
  return merged
}

/** Request-only conversion: fallback never removes images from saved history. */
export function toAiModelMessages(
  messages: VelaMessage[],
  supportsImages = true,
  toolImagesAsUser = false,
  options: { normalizeToolCallIds?: boolean } = {},
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
            return {
              type: 'file' as const,
              data: part.data,
              mediaType: part.mimeType,
              ...(part.providerOptions
                ? {
                    providerOptions:
                      part.providerOptions as SharedV4ProviderOptions,
                  }
                : {}),
            }
          }
          return part
        }) as Exclude<AIUserContent, string>,
      }
    }
    if (message.role === 'assistant') {
      const normalized = message as VelaAssistantMessage
      if (typeof normalized.content === 'string') {
        return {
          role: 'assistant',
          content: normalized.content,
          ...(normalized.providerOptions
            ? {
                providerOptions:
                  normalized.providerOptions as SharedV4ProviderOptions,
              }
            : {}),
        }
      }
      return {
        role: 'assistant',
        ...(normalized.providerOptions
          ? {
              providerOptions:
                normalized.providerOptions as SharedV4ProviderOptions,
            }
          : {}),
        content: normalized.content.map((part) => {
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
            case 'tool_result': {
              const filtered = omitImagesInToolOutput(
                part.output,
                supportsImages,
              )
              return {
                type: 'tool-result' as const,
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                output: toAiToolOutput(filtered),
                ...opts,
              }
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
                ...(part.reason !== undefined ? { reason: part.reason } : {}),
                ...(part.isAutomatic !== undefined
                  ? { isAutomatic: part.isAutomatic }
                  : {}),
                ...(part.signature !== undefined
                  ? { signature: part.signature }
                  : {}),
                ...(part.inputSchemaInput !== undefined
                  ? { inputSchemaInput: part.inputSchemaInput }
                  : {}),
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
            ...(part.providerExecuted !== undefined
              ? { providerExecuted: part.providerExecuted }
              : {}),
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
            omitImagesInToolOutput(part.output, supportsImages),
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
  const adaptToolResult = <
    T extends { type: 'tool-result'; output: AIToolResultPart['output'] },
  >(
    part: T,
  ): T => {
    if (part.output.type !== 'content') return part
    const isError = 'isError' in part.output && part.output.isError === true
    if (!isError && (!toolImagesAsUser || !supportsImages)) return part
    const liftedBefore = lifted.length
    const value = part.output.value.filter((item) => {
      if (
        supportsImages &&
        item.type === 'file' &&
        IMAGE_MEDIA_TYPE.test(item.mediaType)
      ) {
        let data: string | Uint8Array | ArrayBuffer | URL | undefined
        if (item.data.type === 'data') {
          data = item.data.data
        } else if (item.data.type === 'url') {
          try {
            data = new URL(item.data.url)
          } catch {
            return true
          }
        }
        if (data !== undefined) {
          lifted.push({
            type: 'file',
            mediaType: item.mediaType,
            data,
            ...('providerOptions' in item && item.providerOptions
              ? {
                  providerOptions:
                    item.providerOptions as SharedV4ProviderOptions,
                }
              : {}),
          })
          return false
        }
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
  }
  for (const message of converted) {
    if (message.role === 'assistant') {
      flush()
      result.push(
        typeof message.content === 'string'
          ? message
          : ({
              ...message,
              content: message.content.map((part) =>
                part.type === 'tool-result' ? adaptToolResult(part) : part,
              ),
            } as AIModelMessage),
      )
      continue
    }
    if (message.role !== 'tool') {
      flush()
      result.push(message)
      continue
    }
    result.push({
      ...message,
      content: message.content.map((part) =>
        part.type === 'tool-result' ? adaptToolResult(part) : part,
      ),
    } as AIModelMessage)
  }
  flush()
  const merged = mergeConsecutiveAssistants(result)
  if (!options.normalizeToolCallIds) return merged
  const normalizeId = createToolIdNormalizer()
  return merged.map((message) => {
    if (
      (message.role !== 'assistant' && message.role !== 'tool') ||
      typeof message.content === 'string'
    )
      return message
    return {
      ...message,
      content: message.content.map((part) => {
        if (
          part.type === 'tool-call' ||
          part.type === 'tool-result' ||
          part.type === 'tool-approval-request'
        ) {
          return { ...part, toolCallId: normalizeId(part.toolCallId) }
        }
        return part
      }),
    } as AIModelMessage
  })
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
          ...('providerExecuted' in part && part.providerExecuted !== undefined
            ? { providerExecuted: Boolean(part.providerExecuted) }
            : {}),
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
        case 'tool-approval-request': {
          const req = part as {
            approvalId: string
            toolCallId: string
            reason?: string
            isAutomatic?: boolean
            signature?: string
            inputSchemaInput?: unknown
          }
          content.push({
            type: 'tool-approval-request',
            approvalId: req.approvalId,
            toolCallId: req.toolCallId,
            ...(req.reason !== undefined ? { reason: req.reason } : {}),
            ...(req.isAutomatic !== undefined
              ? { isAutomatic: req.isAutomatic }
              : {}),
            ...(req.signature !== undefined
              ? { signature: req.signature }
              : {}),
            ...(req.inputSchemaInput !== undefined
              ? { inputSchemaInput: req.inputSchemaInput }
              : {}),
            ...partOpts,
          })
          break
        }
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
