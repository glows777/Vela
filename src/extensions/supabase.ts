import z from 'zod'
import type { ToolDefinition, VelaExtension } from '../index.ts'
import { configString } from './config.ts'

const listTablesInputSchema = z.object({})

const queryInputSchema = z.object({
  table: z.string().describe('Table name'),
  select: z.string().optional().describe('Columns to select, default *'),
  where: z.string().optional().describe('Filter, e.g. status=active'),
  limit: z.number().optional().describe('Maximum rows to return, default 10'),
})

const insertInputSchema = z.object({
  table: z.string().describe('Table name'),
  data: z.record(z.string(), z.unknown()).describe('Data to insert'),
})

export interface SupabaseOptions {
  url?: string
  key?: string
}

/**
 * Supabase database tools (supabase_list_tables / supabase_query / supabase_insert). Without url / key they use built-in mock data.
 * Options not passed are read from the config section (`extensionConfig.supabase`).
 */
export function supabase(options: SupabaseOptions = {}): VelaExtension {
  return function supabase(vela) {
    const url = options.url ?? configString(vela.config, 'url')
    const key = options.key ?? configString(vela.config, 'key')
    if (!url || !key)
      vela.logger.info('[supabase] url / key not configured; using mock mode')

    const tools: ToolDefinition[] = [
      {
        name: 'list_tables',
        description: 'List all tables in the database',
        inputSchema: listTablesInputSchema,
        isConcurrencySafe: true,
        isReadOnly: true,
        execute: async () => {
          if (!url) {
            return JSON.stringify({
              tables: ['users', 'posts', 'comments', 'sessions'],
              note: 'Mock mode — configure SUPABASE_URL and SUPABASE_KEY to connect to a real database',
            })
          }
          return `Connecting to ${url} to list tables... (a real implementation would call the Supabase API)`
        },
      },
      {
        name: 'query',
        description: 'Query rows from a table; supports select / where / limit',
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
            const mockData: Record<string, Record<string, unknown>[]> = {
              users: [
                {
                  id: 1,
                  name: 'Alice Zhang',
                  email: 'zhang@example.com',
                  role: 'admin',
                },
                { id: 2, name: 'Bob Li', email: 'li@example.com', role: 'user' },
                {
                  id: 3,
                  name: 'Carol Wang',
                  email: 'wang@example.com',
                  role: 'user',
                },
              ],
              posts: [
                {
                  id: 1,
                  title: 'Getting started with agents',
                  author_id: 1,
                  status: 'published',
                },
                {
                  id: 2,
                  title: 'Plugin architecture design',
                  author_id: 1,
                  status: 'draft',
                },
              ],
              comments: [
                { id: 1, post_id: 1, user_id: 2, content: 'Nicely written!' },
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
              const [field = '', value] = where.split('=')
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
        description: 'Insert a row into a table',
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
              note: 'Mock mode',
            })
          }
          return `INSERT INTO ${table} — ${JSON.stringify(data)}`
        },
      },
    ]
    for (const tool of tools)
      vela.registerTool({
        ...tool,
        description: `[supabase] ${tool.description}`,
      })
  }
}
