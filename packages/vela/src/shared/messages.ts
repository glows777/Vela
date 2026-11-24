/**
 * Vela's own cross-version message and content types.
 *
 * Completely independent of Vercel AI SDK (`ai` / `@ai-sdk/provider`): used everywhere inside
 * `driver/`, `runtime/`, `db/`, `cli/`, and the public SDK. Conversion to/from AI SDK wire
 * shapes happens strictly at the `src/providers/` request edge.
 */

/** Opaque per-provider metadata attached to messages or parts (e.g. Anthropic cache control, OpenAI encrypted reasoning). */
export type ProviderOptions = Record<string, Record<string, unknown>>

/** An inline base64 image everywhere in Vela; converted to the AI SDK shape only at the request edge. */
export interface ImageContent {
  type: 'image'
  data: string
  mimeType: string
  providerOptions?: ProviderOptions
}

export interface TextPart {
  type: 'text'
  text: string
  providerOptions?: ProviderOptions
}

export type TextContent = TextPart

/** Model reasoning / thinking block. */
export interface ThinkingPart {
  type: 'thinking'
  text: string
  providerOptions?: ProviderOptions
}

/** Non-image or binary file attachment (or provider file reference) carried in user or assistant messages. */
export interface FilePart {
  type: 'file'
  data: string | Uint8Array | URL | Record<string, string>
  mediaType: string
  filename?: string
  providerOptions?: ProviderOptions
}

/** Provider-emitted reasoning file (e.g. encrypted/binary reasoning payload). */
export interface ReasoningFilePart {
  type: 'reasoning-file'
  data: string | Uint8Array | URL
  mediaType: string
  providerOptions?: ProviderOptions
}

/** Provider-emitted custom opaque part. */
export interface CustomProviderPart {
  type: 'custom'
  kind: string
  providerOptions?: ProviderOptions
}

/** A tool invocation emitted by the assistant. */
export interface ToolCallPart {
  type: 'tool_call'
  toolCallId: string
  toolName: string
  input: unknown
  providerExecuted?: boolean
  providerOptions?: ProviderOptions
}

/** Ordered text and inline images produced by a tool or a `tool_result` hook. */
export type ToolContent = (TextContent | ImageContent)[]

export type ToolResultContentItem =
  | TextContent
  | ImageContent
  | {
      type: 'file'
      mediaType: string
      data: { type: 'data'; data: string } | { type: 'url'; url: string }
    }
  | {
      type: 'media'
      data: string
      mediaType: string
    }
  | {
      type: 'image-data'
      data: string
      mediaType: string
    }
  | {
      type: 'custom'
      providerOptions?: ProviderOptions
    }
  | {
      type: 'image-file-reference'
      [key: string]: unknown
    }

export type ToolResultOutput =
  | { type: 'text'; value: string }
  | { type: 'json'; value: unknown }
  | { type: 'error-text'; value: string }
  | { type: 'error-json'; value: unknown }
  | { type: 'execution-denied'; reason?: string }
  | {
      type: 'content'
      /** Failed tool content retains images; request adaptation keeps the error status. */
      isError?: boolean
      value: ToolResultContentItem[]
    }

/** A tool execution result sent back to the model (or provider-executed inline on an assistant message). */
export interface ToolResultPart {
  type: 'tool_result'
  toolCallId: string
  toolName: string
  output: ToolResultOutput
  providerExecuted?: boolean
  providerOptions?: ProviderOptions
}

/** Provider-emitted tool approval request carried on an assistant message. */
export interface ToolApprovalRequestPart {
  type: 'tool-approval-request'
  approvalId: string
  toolCallId: string
  reason?: string
  isAutomatic?: boolean
  signature?: string
  inputSchemaInput?: unknown
  providerOptions?: ProviderOptions
}

/** Tool approval response carried on a tool message. */
export interface ToolApprovalResponsePart {
  type: 'tool-approval-response'
  approvalId: string
  approved: boolean
  reason?: string
  providerExecuted?: boolean
  providerOptions?: ProviderOptions
}

export type ToolMessageContentPart = ToolResultPart | ToolApprovalResponsePart

export type UserContentPart = TextPart | ImageContent | FilePart
export type UserContent = string | UserContentPart[]

export type AssistantContentPart =
  | TextPart
  | ThinkingPart
  | FilePart
  | ReasoningFilePart
  | CustomProviderPart
  | ToolCallPart
  | ToolResultPart
  | ToolApprovalRequestPart

export type AssistantContent = string | AssistantContentPart[]

/** Canonical union of all content parts in Vela messages. */
export type VelaPart =
  | TextPart
  | ThinkingPart
  | ImageContent
  | FilePart
  | ReasoningFilePart
  | CustomProviderPart
  | ToolCallPart
  | ToolResultPart
  | ToolApprovalRequestPart
  | ToolApprovalResponsePart

export interface VelaSystemMessage {
  role: 'system'
  content: string
  providerOptions?: ProviderOptions
}

export interface VelaUserMessage {
  role: 'user'
  content: UserContent
  providerOptions?: ProviderOptions
}

export interface VelaAssistantMessage {
  role: 'assistant'
  content: AssistantContent
  providerOptions?: ProviderOptions
}

export interface VelaToolMessage {
  role: 'tool'
  content: ToolMessageContentPart[]
  providerOptions?: ProviderOptions
}

/** Vela's own conversation message type (replaces AI SDK `ModelMessage`). */
export type VelaMessage =
  | VelaSystemMessage
  | VelaUserMessage
  | VelaAssistantMessage
  | VelaToolMessage

/** Alias kept during v0.9 transition for internal modules migrating to `VelaMessage`. */
export type ModelMessage = VelaMessage
export type AssistantModelMessage = VelaAssistantMessage
export type ToolModelMessage = VelaToolMessage

const IMAGE_MEDIA_TYPE = /^image(?:\/|$)/i

function toBase64IfBinary(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw
  if (raw instanceof Uint8Array) return Buffer.from(raw).toString('base64')
  if (raw instanceof ArrayBuffer)
    return Buffer.from(new Uint8Array(raw)).toString('base64')
  if (
    raw &&
    typeof raw === 'object' &&
    (raw as { type?: unknown }).type === 'Buffer' &&
    Array.isArray((raw as { data?: unknown }).data)
  ) {
    return Buffer.from((raw as { data: number[] }).data).toString('base64')
  }
  return undefined
}

function normalizeToolResultItem(item: unknown): {
  item: unknown
  changed: boolean
} {
  if (!item || typeof item !== 'object') return { item, changed: false }
  const rec = item as Record<string, unknown>
  const mediaType = typeof rec.mediaType === 'string' ? rec.mediaType : ''
  const opts = rec.providerOptions
    ? { providerOptions: rec.providerOptions }
    : {}
  if (rec.type === 'image-data') {
    const data = toBase64IfBinary(rec.data)
    if (data !== undefined) {
      return {
        item: {
          type: 'image',
          data,
          mimeType: mediaType || 'image/png',
          ...opts,
        },
        changed: true,
      }
    }
  }
  if (rec.type === 'media' && IMAGE_MEDIA_TYPE.test(mediaType)) {
    const data = toBase64IfBinary(rec.data)
    if (data !== undefined) {
      return {
        item: { type: 'image', data, mimeType: mediaType, ...opts },
        changed: true,
      }
    }
  }
  if (rec.type === 'file-data' && IMAGE_MEDIA_TYPE.test(mediaType)) {
    const data = toBase64IfBinary(rec.data)
    if (data !== undefined) {
      return {
        item: { type: 'image', data, mimeType: mediaType, ...opts },
        changed: true,
      }
    }
  }
  if (
    rec.type === 'file' &&
    IMAGE_MEDIA_TYPE.test(mediaType) &&
    rec.data &&
    typeof rec.data === 'object' &&
    (rec.data as { type?: unknown }).type === 'data'
  ) {
    const data = toBase64IfBinary((rec.data as { data?: unknown }).data)
    if (data !== undefined) {
      return {
        item: { type: 'image', data, mimeType: mediaType, ...opts },
        changed: true,
      }
    }
  }
  return { item, changed: false }
}

/**
 * Normalize content array items loaded from legacy JSONL transcripts (where AI SDK part tags
 * `'reasoning'`, `'tool-call'`, `'tool-result'` and legacy `{ type: 'image', image, mediaType }`
 * may appear) into canonical `VelaPart` shapes.
 */
export function normalizeVelaContent(content: unknown[]): {
  content: unknown[]
  changed: boolean
} {
  let changed = false
  const normalized = content.map((item) => {
    if (!item || typeof item !== 'object') return item
    const part = item as Record<string, unknown>
    if (part.type === 'reasoning') {
      changed = true
      return { ...part, type: 'thinking' }
    }
    if (part.type === 'tool-call') {
      changed = true
      return { ...part, type: 'tool_call' }
    }
    if (part.type === 'tool-result' || part.type === 'tool_result') {
      let nextPart = part
      let partChanged = part.type === 'tool-result'
      if (
        part.output &&
        typeof part.output === 'object' &&
        (part.output as { type?: unknown }).type === 'content' &&
        Array.isArray((part.output as { value?: unknown }).value)
      ) {
        const output = part.output as {
          value: unknown[]
          [key: string]: unknown
        }
        let itemsChanged = false
        const nextValue = output.value.map((entry) => {
          const res = normalizeToolResultItem(entry)
          if (res.changed) itemsChanged = true
          return res.item
        })
        if (itemsChanged) {
          partChanged = true
          nextPart = { ...part, output: { ...output, value: nextValue } }
        }
      }
      if (partChanged) {
        changed = true
        return { ...nextPart, type: 'tool_result' }
      }
      return item
    }
    if (
      part.type === 'image' &&
      part.data === undefined &&
      part.image !== undefined
    ) {
      changed = true
      const rawImage = part.image
      const mediaType =
        typeof part.mimeType === 'string'
          ? part.mimeType
          : typeof part.mediaType === 'string'
            ? part.mediaType
            : 'image/png'
      const { image: _img, mediaType: _mt, mimeType: _mime, ...rest } = part
      const binaryData = toBase64IfBinary(rawImage)
      if (binaryData !== undefined) {
        return { ...rest, type: 'image', data: binaryData, mimeType: mediaType }
      }
      if (
        rawImage &&
        typeof rawImage === 'object' &&
        !(rawImage instanceof Uint8Array) &&
        !(rawImage instanceof URL)
      ) {
        return { ...rest, type: 'file', data: rawImage, mediaType }
      }
      return {
        ...rest,
        type: 'image',
        data: String(rawImage),
        mimeType: mediaType,
      }
    }
    return item
  })
  return { content: normalized, changed }
}

/**
 * Normalize a message loaded from legacy JSONL transcripts (where AI SDK part tags
 * `'reasoning'`, `'tool-call'`, `'tool-result'` and legacy `{ type: 'image', image, mediaType }`
 * may appear) into canonical `VelaMessage`.
 */
export function normalizeVelaMessage(message: unknown): VelaMessage {
  if (!message || typeof message !== 'object') return message as VelaMessage
  const raw = message as Record<string, unknown>
  if (!Array.isArray(raw.content)) return raw as unknown as VelaMessage
  const { content, changed } = normalizeVelaContent(raw.content)
  return changed
    ? ({ ...raw, content } as unknown as VelaMessage)
    : (raw as unknown as VelaMessage)
}
