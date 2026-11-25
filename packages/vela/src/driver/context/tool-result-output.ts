import type { ToolResultPart } from '../messages.ts'

export type ToolResultOutput = ToolResultPart['output']

export function toolResultOutputToText(output: ToolResultOutput): string {
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
