import { stripOpaqueFields, type ToolResultPart } from '../messages.ts'

export type ToolResultOutput = ToolResultPart['output']

export function isToolResultError(output: ToolResultOutput): boolean {
  return (
    output.type === 'error-text' ||
    output.type === 'error-json' ||
    output.type === 'execution-denied' ||
    (output.type === 'content' && output.isError === true)
  )
}

export function toolResultOutputToText(output: ToolResultOutput): string {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value
    case 'json':
    case 'error-json':
      return JSON.stringify(stripOpaqueFields(output.value))
    case 'content':
      return output.value
        .map((part) => {
          switch (part.type) {
            case 'text':
              return part.text
            case 'image':
              return `[image: ${part.mimeType}]`
            case 'file':
              return `[file: ${part.mediaType}]`
            default:
              return `[${part.type}]`
          }
        })
        .join('\n')
    default:
      return JSON.stringify(output)
  }
}
