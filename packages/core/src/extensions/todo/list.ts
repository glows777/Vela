import type { ModelMessage } from '../../messages.ts'
import { type TodoList, todoInputSchema } from './tool.ts'

/**
 * The list from the latest `todo` call in `messages`, or null when there is none. The tool always
 * replaces the whole list, so the last call in history is the current checklist.
 */
export function latestTodoList(
  messages: readonly ModelMessage[],
): TodoList | null {
  let latest: TodoList | null = null
  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string')
      continue
    for (const part of message.content) {
      if (part.type !== 'tool-call' || part.toolName !== 'todo') continue
      const parsed = todoInputSchema.safeParse(part.input)
      if (parsed.success) latest = parsed.data
    }
  }
  return latest
}
