import type { ToolResultPart } from '@glows777/vela-core'

export type ToolResultOutput = ToolResultPart['output']

export function toolResultOutputToText(output: ToolResultOutput): string {
  const stored = getStoredResult(output)
  if (stored) return stored.preview
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value
    case 'json':
    case 'error-json':
      return JSON.stringify(output.value)
    case 'content':
      return output.value
        .map((part) =>
          part.type === 'text' ? part.text : `[media: ${part.type}]`,
        )
        .join('\n')
    default:
      return JSON.stringify(output)
  }
}

function getStoredResult(
  output: ToolResultPart['output'],
): { preview: string } | undefined {
  if (
    output.type !== 'json' ||
    !output.value ||
    typeof output.value !== 'object' ||
    Array.isArray(output.value)
  )
    return
  // Array.isArray doesn't narrow readonly arrays; arrays are already excluded here
  const value = output.value as Readonly<Record<string, unknown>>
  if (
    value.kind === 'vela-tool-result' &&
    typeof value.path === 'string' &&
    typeof value.indexPath === 'string' &&
    typeof value.bytes === 'number' &&
    typeof value.preview === 'string' &&
    typeof value.read === 'string'
  ) {
    return value as unknown as { preview: string }
  }
}
