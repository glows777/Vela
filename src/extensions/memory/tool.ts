import z from 'zod'
import type { ToolDefinition } from '../../index'
import type { MemoryStore } from './store'

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
            return '保存失败：需要 name、type、content'
          const filename = memoryStore.save({
            name: args.name,
            description: args.description || args.name,
            type: args.type,
            content: args.content,
          })
          return `已保存到记忆: ${filename}`
        }
        case 'list': {
          const entries = memoryStore.list()
          if (entries.length === 0) return '当前没有存储任何记忆。'
          return (
            `记忆列表（共 ${entries.length} 条）：\n` +
            entries
              .map((e) => `  [${e.type}] ${e.name} — ${e.description}`)
              .join('\n')
          )
        }
        case 'search': {
          const results = memoryStore.search(args.query || '', 5)
          if (results.length === 0)
            return `没有找到与 "${args.query}" 相关的记忆。`
          return (
            `BM25 搜索结果（${results.length} 条）：\n` +
            results
              .map(
                (h) =>
                  `  [score=${h.score.toFixed(2)}] [${h.entry.type}] ${h.entry.name} — ${h.entry.description}`,
              )
              .join('\n')
          )
        }
        case 'read':
          if (!args.filename) return '读取失败：需要 filename'
          return (
            memoryStore.loadFile(args.filename) ??
            `文件不存在: ${args.filename}`
          )
        case 'delete':
          if (!args.filename) return '删除失败：需要 filename'
          return memoryStore.delete(args.filename)
            ? `已删除: ${args.filename}`
            : `文件不存在: ${args.filename}`
        case 'lint': {
          const reports = memoryStore.lint()
          if (reports.length === 0) return '记忆库健康，没有发现问题。'
          const lines = [`记忆库 lint 报告（${reports.length} 条有问题）：`, '']
          for (const r of reports) {
            const fname = r.entry.filePath.split('/').pop()
            const preview = r.entry.content.slice(0, 100).replace(/\n/g, ' ')
            lines.push(`📁 ${fname}  [${r.entry.type}] ${r.entry.name}`)
            lines.push(
              `   内容预览: ${preview}${r.entry.content.length > 100 ? '...' : ''}`,
            )
            for (const issue of r.issues)
              lines.push(`   • ${issue.kind}: ${issue.message}`)
            lines.push('')
          }
          lines.push(
            '提示: 基于以上报告直接操作即可（delete 删除、save 覆盖更新），不需要逐条 read。',
          )
          return lines.join('\n')
        }
        default:
          return `未知操作: ${args.action}`
      }
    },
  }
}
