import type { ToolResultPart } from 'ai'
import { getStoredResult } from '../session/tool-results.ts'

export type ToolResultOutput = ToolResultPart['output']

export function textToolResultOutput(value: string): ToolResultOutput {
  return { type: 'text', value }
}

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
