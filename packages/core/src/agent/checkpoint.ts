import type {
  AssistantModelMessage,
  LanguageModelCallEndEvent,
  ToolSet,
} from 'ai'

/** The SDK model-call event has provider metadata; history uses model-message provider options. */
export async function checkpointMessage(
  event: LanguageModelCallEndEvent,
  tools: ToolSet,
): Promise<AssistantModelMessage> {
  const content: Exclude<AssistantModelMessage['content'], string> = []
  const sources = new Map<string, string>()
  for (const part of event.content) {
    if (part.type === 'source') {
      if (part.sourceType === 'url')
        sources.set(part.url, part.title ?? part.url)
      continue
    }
    const providerOptions =
      'providerMetadata' in part ? part.providerMetadata : undefined
    switch (part.type) {
      case 'text':
      case 'reasoning':
        if (part.text || providerOptions)
          content.push({ type: part.type, text: part.text, providerOptions })
        break
      case 'custom':
        content.push({ type: 'custom', kind: part.kind, providerOptions })
        break
      case 'file':
      case 'reasoning-file':
        content.push({
          type: part.type,
          data: part.file.base64,
          mediaType: part.file.mediaType,
          providerOptions,
        })
        break
      case 'tool-call':
        content.push({
          type: 'tool-call',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input:
            part.invalid && typeof part.input !== 'object' ? {} : part.input,
          providerExecuted: part.providerExecuted,
          providerOptions,
        })
        break
      case 'tool-result':
      case 'tool-error':
        if (part.providerExecuted)
          content.push({
            type: 'tool-result',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output:
              part.type === 'tool-error'
                ? {
                    type: 'error-json',
                    value: JSON.parse(JSON.stringify(part.error) ?? 'null'),
                  }
                : tools[part.toolName]?.toModelOutput
                  ? await tools[part.toolName]!.toModelOutput!({
                      toolCallId: part.toolCallId,
                      input: part.input,
                      output: part.output,
                    })
                  : typeof part.output === 'string'
                    ? { type: 'text', value: part.output }
                    : {
                        type: 'json',
                        value: JSON.parse(
                          JSON.stringify(part.output) ?? 'null',
                        ),
                      },
            providerOptions,
          })
        break
    }
  }
  if (sources.size)
    content.push({
      type: 'text',
      text: `\n\nSources:\n${[...sources].map(([url, title]) => `- ${title}: ${url}`).join('\n')}`,
    })
  return { role: 'assistant', content }
}
