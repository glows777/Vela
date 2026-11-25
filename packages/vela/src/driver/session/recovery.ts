import type { ModelMessage } from '../messages.ts'

export function assertInterruptedTurn(messages: readonly ModelMessage[]): void {
  if (!messages.some((message) => message.role === 'user'))
    throw new Error('No saved turn to continue')
  const last = messages.at(-1)
  if (
    last?.role === 'assistant' &&
    (typeof last.content === 'string' ||
      !last.content.some((part) => part.type === 'tool_call'))
  )
    throw new Error('No interrupted turn to continue')
}

/** Client calls still missing a model-facing result on the active branch. */
export function pendingToolCalls(messages: readonly ModelMessage[]) {
  const unresolved = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content))
      for (const part of message.content)
        if (part.type === 'tool_call' && !part.providerExecuted)
          unresolved.add(part.toolCallId)
    if (message.role === 'tool')
      for (const part of message.content)
        if (part.type === 'tool_result') unresolved.delete(part.toolCallId)
    if (
      (message.role === 'user' || message.role === 'system') &&
      unresolved.size
    )
      throw new Error(
        'Saved history has a user message before unresolved tool results. Recovery stopped without replaying tools or changing that history. Open a new session, or inspect the saved branch before continuing.',
      )
  }
  const completed = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'tool') continue
    for (const part of message.content)
      if (part.type === 'tool_result') completed.add(part.toolCallId)
  }
  // Snapshot before appending repairs; sibling calls retain the model's order.
  return messages.flatMap((message) =>
    message.role === 'assistant' && Array.isArray(message.content)
      ? message.content.flatMap((part) =>
          part.type === 'tool_call' &&
          !part.providerExecuted &&
          !completed.has(part.toolCallId)
            ? [part]
            : [],
        )
      : [],
  )
}
