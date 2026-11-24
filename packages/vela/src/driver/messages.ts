/**
 * Vela message helpers (image normalization, foreign reasoning stripping, envelope char estimates).
 *
 * Pure Vela types live in `../shared/messages.ts`; AI SDK wire conversion lives strictly in
 * `../providers/messages.ts`.
 */

import { normalizeImage } from '../shared/images/normalize.ts'
import type {
  ProviderOptions,
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
  ImageContent,
  ModelMessage,
  ProviderOptions,
  TextContent,
  TextPart,
  ThinkingPart,
  ToolCallPart,
  ToolContent,
  ToolModelMessage,
  ToolResultOutput,
  ToolResultPart,
  UserContent,
  VelaAssistantMessage,
  VelaMessage,
  VelaPart,
  VelaSystemMessage,
  VelaToolMessage,
  VelaUserMessage,
} from '../shared/messages.ts'
export { normalizeVelaMessage } from '../shared/messages.ts'

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

/** Pi's conservative image estimate, independent of the encoded file's byte length. */
export const IMAGE_CHARS = 4800

/** Canonical images plus image shapes legacy messages may carry. */
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
    if (result.image) content.push(result.image)
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
      return [part]
    })
    if (!hosted.size && content.length === message.content.length)
      return [message]
    // A message that held nothing but thinking would reach the provider empty
    return content.length ? [{ ...message, content }] : []
  })
}

/** JSON-envelope estimate: replace image payloads and exclude opaque encrypted provider data. */
export function messageEnvelopeChars(messages: VelaMessage[]): number {
  const withoutOpaqueOptions = <
    T extends { providerOptions?: ProviderOptions },
  >(
    part: T,
  ): T => {
    const options = part.providerOptions
    const openai = options?.openai
    if (
      !openai ||
      !('reasoningEncryptedContent' in openai || 'encryptedContent' in openai)
    )
      return part
    const counted = { ...openai }
    delete counted.reasoningEncryptedContent
    delete counted.encryptedContent
    return { ...part, providerOptions: { ...options, openai: counted } }
  }
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
        const counted =
          'providerOptions' in part ? withoutOpaqueOptions(part) : part
        if (part.type !== 'tool_result' || part.output.type !== 'content')
          return counted
        return {
          ...counted,
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
