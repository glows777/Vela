import type { ToolContent } from '@glows777/vela-core'

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
