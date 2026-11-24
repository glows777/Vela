import type {
  ProviderOptions,
  VelaAssistantMessage,
} from '../shared/messages.ts'

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Recursively merges streamed provider metadata chunks while keeping leaf scalars/arrays from newer parts. */
export function deepMergeProviderOptions(
  base: ProviderOptions | undefined,
  patch: ProviderOptions | undefined,
): ProviderOptions | undefined {
  if (!patch) return base
  if (!base) return patch
  const merge = (
    target: Record<string, unknown>,
    src: Record<string, unknown>,
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...target }
    for (const [k, v] of Object.entries(src)) {
      const prev = out[k]
      out[k] = isPlainRecord(prev) && isPlainRecord(v) ? merge(prev, v) : v
    }
    return out
  }
  return merge(
    base as Record<string, unknown>,
    patch as Record<string, unknown>,
  ) as ProviderOptions
}

export interface StreamedSlot {
  hasContent: boolean
  meta: ProviderOptions
}

export interface StreamedPartMetadata {
  text: StreamedSlot[]
  reasoning: StreamedSlot[]
  tools: Map<string, ProviderOptions>
}

function activeSlotMetas(slots: StreamedSlot[]): ProviderOptions[] {
  return slots
    .filter((slot) => slot.hasContent || Object.keys(slot.meta).length > 0)
    .map((slot) => slot.meta)
}

/** Merges start/delta/end streamed metadata back onto assistant message parts in ordinal order. */
export function applyStreamedMetadata(
  message: VelaAssistantMessage,
  streamed: StreamedPartMetadata,
): VelaAssistantMessage {
  if (typeof message.content === 'string') return message
  const textMetas = activeSlotMetas(streamed.text)
  const reasoningMetas = activeSlotMetas(streamed.reasoning)
  let textIdx = 0
  let reasoningIdx = 0
  let changed = false
  const content = message.content.map((part) => {
    let extra: ProviderOptions | undefined
    if (part.type === 'text') extra = textMetas[textIdx++]
    else if (part.type === 'thinking') extra = reasoningMetas[reasoningIdx++]
    else if (part.type === 'tool_call')
      extra = streamed.tools.get(part.toolCallId)
    if (!extra) return part
    const merged = deepMergeProviderOptions(extra, part.providerOptions)
    if (merged === part.providerOptions) return part
    changed = true
    return { ...part, providerOptions: merged }
  })
  return changed ? { ...message, content } : message
}
