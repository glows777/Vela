import type {
  ModelMessage as AIModelMessage,
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
export type ModelMessage =
  | Exclude<AIModelMessage, UserModelMessage>
  | (Omit<UserModelMessage, 'content'> & { content: UserContent })

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
): Promise<AIModelMessage[]> {
  return Promise.all(
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
      if (message.role === 'tool' && !supportsImages)
        return {
          ...message,
          content: message.content.map((part) =>
            part.type !== 'tool-result' || part.output.type !== 'content'
              ? part
              : {
                  ...part,
                  output: {
                    ...part.output,
                    value: part.output.value.map((item) =>
                      isImageContentPart(item)
                        ? {
                            type: 'text' as const,
                            text: '(tool image omitted: model does not support images)',
                          }
                        : item,
                    ),
                  },
                },
          ),
        }
      return message as AIModelMessage
    }),
  )
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
