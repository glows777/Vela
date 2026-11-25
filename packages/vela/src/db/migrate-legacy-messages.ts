import type {
  FilePart,
  ImageContent,
  ProviderOptions,
  TextPart,
  UserContentPart,
  VelaMessage,
} from '../shared/messages.ts'

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

/** Normalizes legacy AI SDK / pre-v0.9 transcript content parts into canonical Vela parts. */
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

/** Normalizes legacy custom_message array content into canonical user content parts. */
export function normalizeUserContent(content: unknown[]): {
  content: UserContentPart[]
  changed: boolean
} {
  const base = normalizeVelaContent(content)
  let changed = base.changed
  const userParts: UserContentPart[] = []
  for (const item of base.content) {
    if (!item || typeof item !== 'object') {
      changed = true
      if (typeof item === 'string') {
        userParts.push({ type: 'text', text: item })
      }
      continue
    }
    const part = item as Record<string, unknown>
    if (part.type === 'text' && typeof part.text === 'string') {
      userParts.push(item as TextPart)
    } else if (
      part.type === 'image' &&
      typeof part.data === 'string' &&
      typeof part.mimeType === 'string'
    ) {
      userParts.push(item as ImageContent)
    } else if (part.type === 'file' && typeof part.mediaType === 'string') {
      userParts.push(item as FilePart)
    } else if (part.type === 'thinking' && typeof part.text === 'string') {
      changed = true
      userParts.push({
        type: 'text',
        text: part.text,
        ...(part.providerOptions
          ? { providerOptions: part.providerOptions as ProviderOptions }
          : {}),
      })
    } else {
      changed = true
    }
  }
  return { content: userParts, changed }
}

/** Normalizes a single legacy JSONL transcript message into a canonical VelaMessage. */
export function normalizeVelaMessage(message: unknown): VelaMessage {
  if (!message || typeof message !== 'object') return message as VelaMessage
  const raw = message as Record<string, unknown>
  if (!Array.isArray(raw.content)) return raw as unknown as VelaMessage
  const { content, changed } = normalizeVelaContent(raw.content)
  return changed
    ? ({ ...raw, content } as unknown as VelaMessage)
    : (raw as unknown as VelaMessage)
}
