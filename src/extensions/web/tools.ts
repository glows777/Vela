import TurndownService from 'turndown'
import z from 'zod'
import type { ToolDefinition } from '../../index.ts'

const searchInputSchema = z.object({
  query: z.string().describe('Search keywords'),
  max_results: z
    .number()
    .describe('Number of results to return, default 5')
    .default(5),
})

type SearchInput = z.infer<typeof searchInputSchema>

/** Tavily: returns cleaned-up page content and an AI summary */
export function tavilySearchTool(apiKey: string): ToolDefinition {
  return {
    name: 'search',
    description:
      'Search the web for up-to-date information. Returns titles, links and content summaries of relevant pages',
    inputSchema: searchInputSchema,
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
      if (!res.ok) return `[web_search] Request failed: HTTP ${res.status}`

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
      if (data.answer) lines.push(`## AI summary\n${data.answer}\n`)
      for (const r of data.results || []) {
        lines.push(`### ${r.title}`)
        lines.push(r.url)
        lines.push(r.content || r.snippet || '')
        lines.push('')
      }
      return lines.join('\n') || 'No results found'
    },
  }
}

/** Serper: returns only Google result snippets; use web_fetch for the full text */
export function serperSearchTool(apiKey: string): ToolDefinition {
  return {
    name: 'search',
    description:
      'Search the web for up-to-date information. Returns titles, links and snippets of Google search results',
    inputSchema: searchInputSchema,
    isReadOnly: true,
    maxResultChars: 3000,
    execute: async ({ query, max_results = 5 }: SearchInput, context) => {
      const res = await fetch('https://google.serper.dev/search', {
        signal: context?.signal,
        method: 'POST',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: max_results }),
      })
      if (!res.ok) return `[web_search] Request failed: HTTP ${res.status}`

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
      return lines.join('\n') || 'No results found'
    },
  }
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
})
turndown.remove(['script', 'style', 'nav', 'footer', 'header', 'iframe'])

const fetchInputSchema = z.object({
  url: z.string().describe('Full URL'),
})

export const webFetchTool: ToolDefinition = {
  name: 'fetch',
  description: 'Fetch the web page at a URL and convert it to Markdown',
  inputSchema: fetchInputSchema,
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
      if (!res.ok) return `Fetch failed: HTTP ${res.status}`
      return turndown.turndown(await res.text())
    } catch (err) {
      return `Fetch failed: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}
