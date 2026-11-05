import type { SessionEntry } from '../../session/entries.ts'
import { type TodoList, todoInputSchema } from './tool.ts'

/**
 * The list from the latest successful `todo` call in `entries` (a branch), or null when there is
 * none. The tool always replaces the whole list, so the last call is the current one, and its
 * display data is what a frontend renders (a failed or rejected call did not change the list).
 */
export function latestTodoList(
  entries: readonly SessionEntry[],
): TodoList | null {
  let latest: TodoList | null = null
  for (const entry of entries) {
    if (entry.type !== 'message' || entry.message.role !== 'tool') continue
    for (const part of entry.message.content) {
      if (part.type !== 'tool-result' || part.toolName !== 'todo') continue
      const parsed = todoInputSchema.safeParse(entry.details?.[part.toolCallId])
      if (parsed.success) latest = parsed.data
    }
  }
  return latest
}
