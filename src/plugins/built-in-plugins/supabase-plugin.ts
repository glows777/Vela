import z from 'zod'
import type { PluginApi, PluginDefinition } from '../types'

const listTablesInputSchema = z.object({})

const queryInputSchema = z.object({
  table: z.string().describe('表名'),
  select: z.string().optional().describe('查询字段，默认 *'),
  where: z.string().optional().describe('过滤条件，如 status=active'),
  limit: z.number().optional().describe('返回条数限制，默认 10'),
})

const insertInputSchema = z.object({
  table: z.string().describe('表名'),
  data: z.record(z.string(), z.unknown()).describe('要插入的数据'),
})

export const supabasePlugin: PluginDefinition = {
  name: 'supabase',
  version: '1.0.0',
  description: '提供 Supabase 数据库操作能力（query / insert / list_tables）',
  config: {
    supabaseUrl: '${SUPABASE_URL}',
    supabaseKey: '${SUPABASE_KEY}',
  },

  activate(api: PluginApi) {
    const config = api.getConfig()
    const url = config.supabaseUrl as string
    const key = config.supabaseKey as string

    if (!url || !key) {
      api.log('未配置 SUPABASE_URL / SUPABASE_KEY，使用 Mock 模式')
    }

    api.registerTools([
      {
        name: 'list_tables',
        description: '列出数据库中所有表',
        inputSchema: listTablesInputSchema,
        isConcurrencySafe: true,
        isReadOnly: true,
        execute: async () => {
          if (!url) {
            return JSON.stringify({
              tables: ['users', 'posts', 'comments', 'sessions'],
              note: 'Mock 模式 — 配置 SUPABASE_URL 和 SUPABASE_KEY 连接真实数据库',
            })
          }
          return `连接 ${url} 查询表列表...（真实实现会调用 Supabase API）`
        },
      },
      {
        name: 'query',
        description: '查询指定表的数据，支持 select / where / limit',
        inputSchema: queryInputSchema,
        isConcurrencySafe: true,
        isReadOnly: true,
        execute: async (input: {
          table: string
          select?: string
          where?: string
          limit?: number
        }) => {
          const { table, select = '*', where, limit = 10 } = input
          if (!url) {
            const mockData: Record<string, any[]> = {
              users: [
                {
                  id: 1,
                  name: '张三',
                  email: 'zhang@example.com',
                  role: 'admin',
                },
                { id: 2, name: '李四', email: 'li@example.com', role: 'user' },
                {
                  id: 3,
                  name: '王五',
                  email: 'wang@example.com',
                  role: 'user',
                },
              ],
              posts: [
                {
                  id: 1,
                  title: 'Agent 开发入门',
                  author_id: 1,
                  status: 'published',
                },
                {
                  id: 2,
                  title: 'Plugin 架构设计',
                  author_id: 1,
                  status: 'draft',
                },
              ],
              comments: [
                { id: 1, post_id: 1, user_id: 2, content: '写得不错！' },
              ],
              sessions: [
                {
                  id: 'sess-001',
                  user_id: 1,
                  created_at: '2026-05-01T10:00:00Z',
                },
              ],
            }
            const rows = mockData[table] || []
            let filtered = rows
            if (where) {
              const [field, value] = where.split('=')
              filtered = rows.filter((r) => String(r[field]) === value)
            }
            return JSON.stringify({
              table,
              rows: filtered.slice(0, limit),
              total: filtered.length,
            })
          }
          return `SELECT ${select} FROM ${table}${where ? ` WHERE ${where}` : ''} LIMIT ${limit}`
        },
      },
      {
        name: 'insert',
        description: '向指定表插入一条记录',
        inputSchema: insertInputSchema,
        isConcurrencySafe: false,
        isReadOnly: false,
        execute: async (input: {
          table: string
          data: Record<string, unknown>
        }) => {
          const { table, data } = input
          if (!url) {
            return JSON.stringify({
              success: true,
              table,
              inserted: { id: Math.floor(Math.random() * 1000), ...data },
              note: 'Mock 模式',
            })
          }
          return `INSERT INTO ${table} — ${JSON.stringify(data)}`
        },
      },
    ])

    api.log(`已注册 3 个工具（list_tables / query / insert）`)
  },

  destroy() {
    console.log('  [plugin:supabase] 连接已释放')
  },
}
