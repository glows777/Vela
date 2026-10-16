import type {
  ModelMessage as AIModelMessage,
  ToolModelMessage as AIToolModelMessage,
  ToolResultPart as AIToolResultPart,
  UserContent as AIUserContent,
  TextPart,
  UserModelMessage,
} from 'ai'
import { normalizeImage } from './images/normalize.ts'

/** An inline image everywhere in Vela; converted to the AI SDK shape only at the request edge. */
export interface ImageContent {
  type: 'image'
  data: string
  mimeType: string
}

export type TextContent = TextPart
export type UserContent =
  | string
  | (Exclude<AIUserContent, string>[number] | ImageContent)[]
/** Ordered text and inline images produced by a tool or a tool_result hook. */
export type ToolContent = (TextContent | ImageContent)[]
export type ToolResultOutput =
  | Exclude<AIToolResultPart['output'], { type: 'content' }>
  | (Omit<Extract<AIToolResultPart['output'], { type: 'content' }>, 'value'> & {
      /** Failed tool content retains images; request adaptation keeps the error status. */
      isError?: boolean
      value: (
        | Extract<
            AIToolResultPart['output'],
            { type: 'content' }
          >['value'][number]
        | ImageContent
      )[]
    })
export type ToolResultPart = Omit<AIToolResultPart, 'output'> & {
  output: ToolResultOutput
}
export type ToolModelMessage = Omit<AIToolModelMessage, 'content'> & {
  content: (
    | Exclude<AIToolModelMessage['content'][number], AIToolResultPart>
    | ToolResultPart
  )[]
}
export type ModelMessage =
  | Exclude<AIModelMessage, UserModelMessage | AIToolModelMessage>
  | (Omit<UserModelMessage, 'content'> & { content: UserContent })
  | ToolModelMessage

export function isToolContent(value: unknown): value is ToolContent {
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

export const toolContentText = (content: ToolContent): string =>
  content
    .filter((part): part is TextContent => part.type === 'text')
    .map((part) => part.text)
    .join('\n')

/** Canonical tool images use the same decoder and omission hints as prompt images. */
export async function normalizeToolContent(
  content: ToolContent,
): Promise<ToolContent> {
  const message = await normalizeUserMessage({ role: 'user', content })
  return message.content as ToolContent
}

/** AI SDK v7/provider v4 tool media use nested SharedV4FileData. */
export function toAIToolOutput(
  output: ToolResultOutput,
): AIToolResultPart['output'] {
  if (output.type !== 'content') return output
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
  }
}

/** Pi's conservative image estimate, independent of the encoded file's byte length. */
export const IMAGE_CHARS = 4800

// Avoid decoding a saved image on every turn; field checks keep deliberate history edits observable.
const normalizedImages = new WeakMap<
  ImageContent,
  { data: string; mimeType: string }
>()

/** Canonical images plus image shapes the existing AI SDK message API accepts. */
export function isImageContentPart(part: {
  type: string
  mediaType?: string
}): boolean {
  return (
    part.type === 'image' ||
    part.type.startsWith('image-') ||
    (part.type === 'file' && /^image(?:\/|$)/i.test(part.mediaType ?? ''))
  )
}

/** Normalize new user content after input hooks, before recording or requesting it. */
export async function normalizeUserMessage(
  message: ModelMessage,
): Promise<ModelMessage> {
  if (message.role !== 'user' || typeof message.content === 'string')
    return message
  const content: Exclude<UserContent, string> = []
  for (const part of message.content) {
    if (part.type !== 'image' || !('data' in part)) {
      content.push(part)
      continue
    }
    const cached = normalizedImages.get(part)
    if (cached?.data === part.data && cached.mimeType === part.mimeType) {
      content.push(part)
      continue
    }
    const result = await normalizeImage(part)
    if (result.image) {
      normalizedImages.set(result.image, {
        data: result.image.data,
        mimeType: result.image.mimeType,
      })
      content.push(result.image)
    } else
      content.push({
        type: 'text',
        text: `(image omitted: ${result.reason ?? 'could not process image'})`,
      })
  }
  return { ...message, content }
}

/** Request-only conversion: fallback never removes images from the saved history. */
export async function toModelMessages(
  messages: ModelMessage[],
  supportsImages = true,
  toolImagesAsUser = false,
): Promise<AIModelMessage[]> {
  const converted = await Promise.all(
    messages.map(async (message): Promise<AIModelMessage> => {
      if (message.role === 'user' && typeof message.content !== 'string') {
        const normalized = supportsImages
          ? await normalizeUserMessage(message)
          : message
        if (
          normalized.role !== 'user' ||
          typeof normalized.content === 'string'
        )
          return normalized as AIModelMessage
        return {
          ...normalized,
          content: normalized.content.map((part) => {
            if (part.type !== 'image' && !isImageContentPart(part)) return part
            if (!supportsImages)
              return {
                type: 'text' as const,
                text: '(image omitted: model does not support images)',
              }
            return part.type === 'image' && 'data' in part
              ? {
                  type: 'file' as const,
                  data: part.data,
                  mediaType: part.mimeType,
                }
              : part
          }),
        }
      }
      if (message.role === 'tool')
        return {
          ...message,
          content: message.content.map((part) =>
            part.type !== 'tool-result'
              ? part
              : {
                  ...part,
                  output: toAIToolOutput(
                    part.output.type === 'content' && !supportsImages
                      ? {
                          ...part.output,
                          value: part.output.value.map((item) =>
                            isImageContentPart(item)
                              ? {
                                  type: 'text' as const,
                                  text: '(tool image omitted: model does not support images)',
                                }
                              : item,
                          ),
                        }
                      : part.output,
                  ),
                },
          ),
        }
      return message as AIModelMessage
    }),
  )
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

/** JSON-envelope estimate that replaces image payloads instead of counting base64 as prose. */
export function messageEnvelopeChars(messages: ModelMessage[]): number {
  let imageCount = 0
  const image = () => {
    imageCount++
    return null
  }
  const envelope = messages.map((message) => {
    if (typeof message.content === 'string') return message
    return {
      ...message,
      content: message.content.map((part) => {
        if (isImageContentPart(part)) return image()
        if (part.type !== 'tool-result' || part.output.type !== 'content')
          return part
        return {
          ...part,
          output: {
            ...part.output,
            value: part.output.value.map((item) =>
              isImageContentPart(item) ? image() : item,
            ),
          },
        }
      }),
    }
  })
  return JSON.stringify(envelope).length + imageCount * (IMAGE_CHARS - 4)
}
