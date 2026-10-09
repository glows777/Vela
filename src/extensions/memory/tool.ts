import z from 'zod'
import type { ToolDefinition } from '../../index.ts'
import type { MemoryStore } from './store.ts'

const memoryToolParamSchema = z
  .object({
    action: z
      .enum(['save', 'list', 'search', 'read', 'delete', 'lint'])
      .describe('Memory operation'),
    name: z.string().optional().describe('Memory name (required for save)'),
    description: z
      .string()
      .optional()
      .describe('One-sentence description (required for save)'),
    type: z.enum(['user', 'feedback', 'project', 'reference']).optional(),
    content: z
      .string()
      .optional()
      .describe('Memory content (required for save)'),
    query: z
      .string()
      .optional()
      .describe('Search keywords (required for search)'),
    filename: z
      .string()
      .optional()
      .describe(
        'Actual filename (required for read/delete; includes the type prefix and .md suffix). Do not provide the memory name/logical name. For example, user_favorite_language maps to user_user-favorite-language.md',
      ),
  })
  .strict()

export function createMemoryTool(memoryStore: MemoryStore): ToolDefinition {
  return {
    name: 'memory',
    description:
      'Manage cross-session memories. name is the logical memory name, while filename is the actual filename on disk. read and delete require the complete filename (including the type prefix and .md suffix), not name. For example, name=user_favorite_language maps to filename=user_user-favorite-language.md. Actions: save | list | search | read | delete',
    inputSchema: memoryToolParamSchema,
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async (args: z.infer<typeof memoryToolParamSchema>) => {
      switch (args.action) {
        case 'save': {
          if (!args.name || !args.type || !args.content)
            return 'Save failed: name, type and content are required'
          const filename = memoryStore.save({
            name: args.name,
            description: args.description || args.name,
            type: args.type,
            content: args.content,
          })
          return `Saved to memory: ${filename}`
        }
        case 'list': {
          const entries = memoryStore.list()
          if (entries.length === 0) return 'No memories stored.'
          return (
            `Memories (${entries.length}):\n` +
            entries
              .map((e) => `  [${e.type}] ${e.name} — ${e.description}`)
              .join('\n')
          )
        }
        case 'search': {
          const results = memoryStore.search(args.query || '', 5)
          if (results.length === 0)
            return `No memories found for "${args.query}".`
          return (
            `BM25 search results (${results.length}):\n` +
            results
              .map(
                (h) =>
                  `  [score=${h.score.toFixed(2)}] [${h.entry.type}] ${h.entry.name} — ${h.entry.description}`,
              )
              .join('\n')
          )
        }
        case 'read':
          if (!args.filename) return 'Read failed: filename is required'
          return (
            memoryStore.loadFile(args.filename) ??
            `File not found: ${args.filename}`
          )
        case 'delete':
          if (!args.filename) return 'Delete failed: filename is required'
          return memoryStore.delete(args.filename)
            ? `Deleted: ${args.filename}`
            : `File not found: ${args.filename}`
        case 'lint': {
          const reports = memoryStore.lint()
          if (reports.length === 0)
            return 'Memory store is healthy; no issues found.'
          const lines = [
            `Memory lint report (${reports.length} with issues):`,
            '',
          ]
          for (const r of reports) {
            const fname = r.entry.filePath.split('/').pop()
            const preview = r.entry.content.slice(0, 100).replace(/\n/g, ' ')
            lines.push(`📁 ${fname}  [${r.entry.type}] ${r.entry.name}`)
            lines.push(
              `   Preview: ${preview}${r.entry.content.length > 100 ? '...' : ''}`,
            )
            for (const issue of r.issues)
              lines.push(`   • ${issue.kind}: ${issue.message}`)
            lines.push('')
          }
          lines.push(
            'Tip: act directly on this report (delete to remove, save to overwrite); no need to read entries one by one.',
          )
          return lines.join('\n')
        }
        default:
          return `Unknown action: ${args.action}`
      }
    },
  }
}
