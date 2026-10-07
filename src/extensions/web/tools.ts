import TurndownService from 'turndown'
import z from 'zod'
import type { ToolDefinition } from '../../index'

const searchInputSchema = z.object({
  query: z.string().describe('搜索关键词'),
  max_results: z.number().describe('返回结果数量，默认 5').default(5),
})

type SearchInput = z.infer<typeof searchInputSchema>

/** Tavily：返回整理过的网页内容和 AI 摘要 */
export function tavilySearchTool(apiKey: string): ToolDefinition {
  return {
    name: 'search',
    description: '搜索互联网获取最新信息。返回相关网页的标题、链接和内容摘要',
    inputSchema: searchInputSchema,
    isConcurrencySafe: true,
    isReadOnly: true,
    maxResultChars: 3000,
    execute: async ({ query, max_results = 5 }: SearchInput, context) => {
      const res = await fetch('https://api.tavily.com/search', {
        signal: context?.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          max_results,
          include_answer: true,
        }),
      })
      if (!res.ok) return `[web_search] 请求失败: HTTP ${res.status}`

      const data = (await res.json()) as {
        answer?: string
        results?: {
          title: string
          url: string
          content?: string
          snippet?: string
        }[]
      }
      const lines: string[] = []
      if (data.answer) lines.push(`## AI 摘要\n${data.answer}\n`)
      for (const r of data.results || []) {
        lines.push(`### ${r.title}`)
        lines.push(r.url)
        lines.push(r.content || r.snippet || '')
        lines.push('')
      }
      return lines.join('\n') || '没有找到相关结果'
    },
  }
}

/** Serper：只返回 Google 搜索结果的摘要，需要正文时配合 web_fetch */
export function serperSearchTool(apiKey: string): ToolDefinition {
  return {
    name: 'search',
    description:
      '搜索互联网获取最新信息。返回 Google 搜索结果的标题、链接和摘要',
    inputSchema: searchInputSchema,
    isConcurrencySafe: true,
    isReadOnly: true,
    maxResultChars: 3000,
    execute: async ({ query, max_results = 5 }: SearchInput, context) => {
      const res = await fetch('https://google.serper.dev/search', {
        signal: context?.signal,
        method: 'POST',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: max_results }),
      })
      if (!res.ok) return `[web_search] 请求失败: HTTP ${res.status}`

      const data = (await res.json()) as {
        knowledgeGraph?: { title: string; description?: string }
        organic?: { title: string; link: string; snippet?: string }[]
      }
      const lines: string[] = []
      if (data.knowledgeGraph) {
        const kg = data.knowledgeGraph
        lines.push(`## ${kg.title}`)
        if (kg.description) lines.push(kg.description)
        lines.push('')
      }
      for (const r of (data.organic || []).slice(0, max_results)) {
        lines.push(`### ${r.title}`)
        lines.push(r.link)
        lines.push(r.snippet || '')
        lines.push('')
      }
      return lines.join('\n') || '没有找到相关结果'
    },
  }
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
})
turndown.remove(['script', 'style', 'nav', 'footer', 'header', 'iframe'])

const fetchInputSchema = z.object({
  url: z.string().describe('完整 URL'),
})

export const webFetchTool: ToolDefinition = {
  name: 'fetch',
  description: '抓取指定 URL 的网页内容，转换为 Markdown 格式',
  inputSchema: fetchInputSchema,
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({ url }: { url: string }, context) => {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Vela/1.0)' },
        signal: AbortSignal.any([
          AbortSignal.timeout(15000),
          ...(context?.signal ? [context.signal] : []),
        ]),
      })
      if (!res.ok) return `抓取失败: HTTP ${res.status}`
      return turndown.turndown(await res.text())
    } catch (err) {
      return `抓取失败: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}
