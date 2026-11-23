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

/** Non-image or binary file attachment carried in user or assistant messages. */
interface FilePart {
  type: 'file'
  data: string | Uint8Array | URL
  mediaType: string
  filename?: string
  providerOptions?: ProviderOptions
}

/** Provider-emitted reasoning file (e.g. encrypted/binary reasoning payload). */
interface ReasoningFilePart {
  type: 'reasoning-file'
  data: string | Uint8Array | URL
  mediaType: string
  providerOptions?: ProviderOptions
}

/** Provider-emitted custom opaque part. */
interface CustomProviderPart {
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

type ToolResultContentItem =
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

type UserContentPart = TextPart | ImageContent | FilePart
export type UserContent = string | UserContentPart[]

export type AssistantContentPart =
  | TextPart
  | ThinkingPart
  | FilePart
  | ReasoningFilePart
  | CustomProviderPart
  | ToolCallPart
  | ToolResultPart

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
  content: ToolResultPart[]
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
    if (part.type === 'tool-result') {
      changed = true
      return { ...part, type: 'tool_result' }
    }
    if (
      part.type === 'image' &&
      part.data === undefined &&
      part.image !== undefined
    ) {
      changed = true
      const rawImage = part.image
      const data =
        typeof rawImage === 'string'
          ? rawImage
          : rawImage instanceof Uint8Array
            ? Buffer.from(rawImage).toString('base64')
            : String(rawImage)
      const mimeType =
        typeof part.mimeType === 'string'
          ? part.mimeType
          : typeof part.mediaType === 'string'
            ? part.mediaType
            : 'image/png'
      const { image: _img, mediaType: _mt, ...rest } = part
      return { ...rest, type: 'image', data, mimeType }
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
