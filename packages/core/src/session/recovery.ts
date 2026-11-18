import type { ModelMessage, ToolResultOutput } from '../messages.ts'

/** Repair only missing results. Existing results and the branch containing them stay untouched. */
export async function reconcileInterruptedTools({
  messages,
  recover,
  append,
  save,
  signal,
}: {
  messages: readonly ModelMessage[]
  recover: (
    name: string,
    id: string,
    input: unknown,
    signal?: AbortSignal,
  ) => Promise<ToolResultOutput>
  append: (message: ModelMessage) => void
  save: () => Promise<void>
  signal: AbortSignal
}): Promise<void> {
  const completed = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'tool') continue
    for (const part of message.content)
      if (part.type === 'tool-result') completed.add(part.toolCallId)
  }
  // Snapshot before appending repairs; sibling calls retain the model's order.
  const pending = messages.flatMap((message) =>
    message.role === 'assistant' && Array.isArray(message.content)
      ? message.content.flatMap((part) =>
          part.type === 'tool-call' &&
          !part.providerExecuted &&
          !completed.has(part.toolCallId)
            ? [part]
            : [],
        )
      : [],
  )
  for (const call of pending) {
    signal.throwIfAborted()
    const output = await recover(
      call.toolName,
      call.toolCallId,
      call.input,
      signal,
    )
    signal.throwIfAborted()
    append({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolName: call.toolName,
          toolCallId: call.toolCallId,
          output,
        },
      ],
    })
    // A second crash must see the repair before attempting another sibling or model request.
    await save()
  }
}
