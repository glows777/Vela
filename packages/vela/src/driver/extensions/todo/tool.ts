import z from 'zod'
import {
  type ToolDefinition,
  ToolExecutionResult,
} from '../../extension-api.ts'

export const todoInputSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            text: z.string().min(1).describe('A short step description'),
            status: z
              .enum(['pending', 'in_progress', 'done'])
              .describe('pending | in_progress | done'),
          })
          .strict(),
      )
      .describe(
        'The complete task list, in order. It replaces the previous list; send [] to clear it.',
      ),
  })
  .strict()

type TodoItem = z.infer<typeof todoInputSchema>['items'][number]
export type TodoList = z.infer<typeof todoInputSchema>

export function createTodoTool(): ToolDefinition {
  return {
    name: 'todo',
    description:
      'Replace the task list for the current work. Send the complete list every time; it replaces the previous one. Use it for multi-step work, keep at most one item in_progress, and mark items done as soon as they are finished. Do not call it for a single simple step.',
    inputSchema: todoInputSchema,
    executionMode: 'sequential',
    execute: async (input: TodoList) => {
      const { items } = input
      if (items.length === 0)
        return new ToolExecutionResult({ items }, 'Cleared the task list.')
      const count = (status: TodoItem['status']) =>
        items.filter((item) => item.status === status).length
      return new ToolExecutionResult(
        { items },
        `Task list updated: ${items.length} item(s) — ${count('done')} done, ${count('in_progress')} in progress, ${count('pending')} pending.`,
      )
    },
  }
}
