import type { ModelMessage, ToolResultOutput } from '../messages.ts'
import type { SessionEntry } from './entries.ts'
import type { ToolHistoryStore } from './tool-history.ts'

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

/** Legacy executors could begin before their assistant step was saved. */
export async function assertLegacyAnchors(
  entries: readonly SessionEntry[],
  history: ToolHistoryStore,
): Promise<void> {
  const known = new Set(
    entries.flatMap((entry) =>
      entry.type === 'message' &&
      entry.message.role === 'assistant' &&
      Array.isArray(entry.message.content)
        ? entry.message.content.flatMap((part) =>
            part.type === 'tool-call' ? [part.toolCallId] : [],
          )
        : [],
    ),
  )
  const orphan = (await history.legacyUnfinished()).find(
    (call) => !call.toolCallId || !known.has(call.toolCallId),
  )
  if (orphan)
    throw new Error(
      `Tool ${orphan.toolName} has an unfinished legacy attempt (${orphan.callId}) without a saved assistant step. Its effects and branch are unknown; recovery stopped without replaying it. Reconcile its effects before continuing.`,
    )
}

export function assertInterruptedTurn(messages: readonly ModelMessage[]): void {
  if (!messages.some((message) => message.role === 'user'))
    throw new Error('No saved turn to continue')
  const last = messages.at(-1)
  if (
    last?.role === 'assistant' &&
    (typeof last.content === 'string' ||
      !last.content.some((part) => part.type === 'tool-call'))
  )
    throw new Error('No interrupted turn to continue')
}
