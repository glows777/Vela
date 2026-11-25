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
      type: 'custom'
      providerOptions?: ProviderOptions
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
