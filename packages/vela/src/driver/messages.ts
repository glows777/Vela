/**
 * Vela message helpers (image normalization, foreign reasoning stripping, envelope char estimates).
 *
 * Pure Vela types live in `../shared/messages.ts`; AI SDK wire conversion lives strictly in
 * `../providers/messages.ts`.
 */

import { normalizeImage } from '../shared/images/normalize.ts'
import type {
  TextContent,
  ToolContent,
  ToolResultPart,
  UserContent,
  VelaMessage,
} from '../shared/messages.ts'

export type {
  AssistantContent,
  AssistantContentPart,
  AssistantModelMessage,
  CustomProviderPart,
  FilePart,
  ImageContent,
  ModelMessage,
  ProviderOptions,
  ReasoningFilePart,
  TextContent,
  TextPart,
  ThinkingPart,
  ToolApprovalRequestPart,
  ToolApprovalResponsePart,
  ToolCallPart,
  ToolContent,
  ToolMessageContentPart,
  ToolModelMessage,
  ToolResultContentItem,
  ToolResultOutput,
  ToolResultPart,
  UserContent,
  UserContentPart,
  VelaAssistantMessage,
  VelaMessage,
  VelaPart,
  VelaSystemMessage,
  VelaToolMessage,
  VelaUserMessage,
} from '../shared/messages.ts'

/** @experimental Shared frontend contract. */
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

/** Pi's conservative image estimate (4800 chars ≈ 1200 tokens), independent of encoded byte length. */
const IMAGE_CHARS = 4800
export const IMAGE_TOKENS = 1200

/** Canonical images (or image file parts). */
export function isImageContentPart(part: {
  type: string
  mediaType?: string
}): boolean {
  return (
    part.type === 'image' ||
    (part.type === 'file' && /^image(?:\/|$)/i.test(part.mediaType ?? ''))
  )
}

/**
 * Normalize new user content once, after input hooks and before recording it (like pi). History and
 * extension-supplied messages are sent as stored: the request edge never decodes images again.
 */
export async function normalizeUserMessage(
  message: VelaMessage,
): Promise<VelaMessage> {
  if (message.role !== 'user' || typeof message.content === 'string')
    return message
  const content: Exclude<UserContent, string> = []
  for (const part of message.content) {
    if (part.type !== 'image' || !('data' in part)) {
      content.push(part)
      continue
    }
    const result = await normalizeImage(part)
    if (result.image)
      content.push(
        part.providerOptions
          ? { ...result.image, providerOptions: part.providerOptions }
          : result.image,
      )
    else
      content.push({
        type: 'text',
        text: `(image omitted: ${result.reason ?? 'could not process image'})`,
      })
  }
  return { ...message, content }
}

/**
 * One request's messages with thinking/reasoning another model produced dropped (pi's transform-messages):
 * its signature and encrypted content are only valid for the model that wrote them, and a model that
 * receives them can carry them into the visible answer. Text, tool calls and results stay, and the
 * history the session keeps is untouched, so switching back to the earlier model sends its thinking again.
 */
export function withoutForeignReasoning(
  messages: VelaMessage[],
  producer: string,
  producedBy: ReadonlyMap<VelaMessage, string>,
): VelaMessage[] {
  const foreignHosted = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string')
      continue
    const owner = producedBy.get(message)
    if (owner === undefined || owner === producer) continue
    for (const part of message.content)
      if (part.type === 'tool_call' && part.providerExecuted)
        foreignHosted.add(part.toolCallId)
  }
  return messages.flatMap((message) => {
    if (message.role === 'tool') {
      const hostedResults = message.content.filter(
        (part): part is ToolResultPart =>
          part.type === 'tool_result' && foreignHosted.has(part.toolCallId),
      )
      if (!hostedResults.length) return [message]
      const remaining = message.content.filter(
        (part) =>
          part.type !== 'tool_result' || !foreignHosted.has(part.toolCallId),
      )
      const text = hostedResults
        .map(
          (part) =>
            `Provider search result: ${JSON.stringify(part.output, (key, value) => (key === 'encrypted_content' || key === 'encryptedContent' ? undefined : value))}`,
        )
        .join('\n')
      return [
        ...(remaining.length
          ? [{ ...message, content: remaining } as VelaMessage]
          : []),
        {
          role: 'assistant',
          content: [{ type: 'text', text }],
        } as VelaMessage,
      ]
    }
    if (message.role !== 'assistant' || typeof message.content === 'string')
      return [message]
    const owner = producedBy.get(message)
    if (owner === undefined || owner === producer) return [message]
    const hosted = foreignHosted
    const content = message.content.flatMap((part) => {
      if (part.type === 'thinking' || part.type === 'reasoning-file') return []
      if (part.type === 'tool_call' && hosted.has(part.toolCallId))
        return [
          {
            type: 'text' as const,
            text: `Provider search: ${JSON.stringify(part.input)}`,
          },
        ]
      if (part.type === 'tool_result' && hosted.has(part.toolCallId))
        return [
          {
            type: 'text' as const,
            text: `Provider search result: ${JSON.stringify(part.output, (key, value) => (key === 'encrypted_content' || key === 'encryptedContent' ? undefined : value))}`,
          },
        ]
      if ('providerOptions' in part && part.providerOptions !== undefined) {
        const { providerOptions: _, ...rest } = part
        return [rest]
      }
      return [part]
    })
    const { providerOptions: _, ...messageWithoutOptions } = message
    // A message that held nothing but thinking would reach the provider empty
    return content.length ? [{ ...messageWithoutOptions, content }] : []
  })
}

function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0x3000 && cp <= 0x303f) || // CJK Symbols and Punctuation
    (cp >= 0x3040 && cp <= 0x30ff) || // Hiragana & Katakana
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
    (cp >= 0xff00 && cp <= 0xffef) || // Halfwidth and Fullwidth Forms
    (cp >= 0x20000 && cp <= 0x2ebef) // CJK Extensions B-F
  )
}

/** Weighted token estimator: ASCII (~0.25), CJK (~1.2), other non-ASCII (~0.5). */
export function estimateTextTokens(text: string): number {
  let sum = 0
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!
    i += cp > 0xffff ? 2 : 1
    if (cp <= 0x7f) sum += 0.25
    else if (isCjkCodePoint(cp)) sum += 1.2
    else sum += 0.5
  }
  return Math.ceil(sum)
}

/** Recursively strips opaque provider encryption payloads (e.g. web_search `encrypted_content`). */
export function stripOpaqueFields<T>(
  value: T,
  seen = new WeakSet<object>(),
): T {
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return value
  if (Array.isArray(value)) {
    seen.add(value)
    return value.map((item) => stripOpaqueFields(item, seen)) as unknown as T
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  seen.add(value)
  const record = value as Record<string, unknown>
  const cleaned: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (key === 'encrypted_content' || key === 'encryptedContent') continue
    cleaned[key] = stripOpaqueFields(entry, seen)
  }
  return cleaned as T
}

function withoutProviderOptions<T extends object>(value: T): T {
  if (!('providerOptions' in value)) return value
  const { providerOptions: _, ...rest } = value as T & {
    providerOptions?: unknown
  }
  return rest as T
}

function sanitizeMessagesForEstimation(messages: VelaMessage[]): {
  cleaned: unknown[]
  imageCount: number
} {
  let imageCount = 0
  const image = () => {
    imageCount++
    return null
  }
  const cleaned = messages.map((message) => {
    const baseMessage = stripOpaqueFields(withoutProviderOptions(message))
    if (typeof baseMessage.content === 'string') return baseMessage
    return {
      ...baseMessage,
      content: baseMessage.content.map((part) => {
        if (isImageContentPart(part)) return image()
        const stripped = stripOpaqueFields(withoutProviderOptions(part))
        if (
          stripped.type !== 'tool_result' ||
          stripped.output.type !== 'content'
        )
          return stripped
        return {
          ...stripped,
          output: {
            ...stripped.output,
            value: stripped.output.value.map((item) =>
              isImageContentPart(item)
                ? image()
                : stripOpaqueFields(withoutProviderOptions(item)),
            ),
          },
        }
      }),
    }
  })
  return { cleaned, imageCount }
}

/** Weighted token estimate for Vela messages, stripping all provider signatures and encrypted payloads. */
export function estimateMessagesTokens(messages: VelaMessage[]): number {
  const { cleaned, imageCount } = sanitizeMessagesForEstimation(messages)
  // `null` serializes as 4 ASCII chars (1 token), replaced by IMAGE_TOKENS.
  return (
    estimateTextTokens(JSON.stringify(cleaned)) +
    imageCount * (IMAGE_TOKENS - 1)
  )
}

/** JSON-envelope char estimate: strips opaque providerOptions / encrypted payloads and replaces images. */
export function messageEnvelopeChars(messages: VelaMessage[]): number {
  const { cleaned, imageCount } = sanitizeMessagesForEstimation(messages)
  return JSON.stringify(cleaned).length + imageCount * (IMAGE_CHARS - 4)
}
