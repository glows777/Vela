import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import { web } from '../../../../src/extensions/web/index.ts'
import {
  MAX_FETCH_BYTES,
  serperSearchTool,
  tavilySearchTool,
  webFetchTool,
} from '../../../../src/extensions/web/tools.ts'
import { fauxText, fauxToolCall } from '../../../../src/testing/faux.ts'
import { cleanupTestVelas, createTestVela } from '../../../support/vela.ts'

afterEach(cleanupTestVelas)

const server = Bun.serve({
  port: 0,
  routes: {
    '/page': () =>
      new Response(
        '<html><head><script>alert(1)</script></head><body><h1>Title</h1><p>Some <b>bold</b> text</p></body></html>',
        { headers: { 'content-type': 'text/html' } },
      ),
    '/missing': () => new Response('nope', { status: 404 }),
    '/huge': () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            // Endless: the tool must stop reading at its limit
            controller.enqueue(new TextEncoder().encode('x'.repeat(64 * 1024)))
          },
        }),
      ),
  },
})
afterAll(() => server.stop(true))
const url = (path: string) => `http://localhost:${server.port}${path}`

test('web_fetch returns the page as Markdown without scripts', async () => {
  const text = (await webFetchTool.execute({ url: url('/page') })) as string
  expect(text).toContain('# Title')
  expect(text).toContain('Some **bold** text')
  expect(text).not.toContain('alert')
})

test('web_fetch reports HTTP and network errors as text', async () => {
  expect(await webFetchTool.execute({ url: url('/missing') })).toBe(
    'Fetch failed: HTTP 404',
  )
  expect(
    await webFetchTool.execute({ url: 'http://localhost:1/nothing' }),
  ).toStartWith('Fetch failed:')
})

test('web_fetch reads at most MAX_FETCH_BYTES of an endless response', async () => {
  const text = (await webFetchTool.execute({ url: url('/huge') })) as string
  expect(text).toContain('[Truncated:')
  expect(text.length).toBeLessThan(MAX_FETCH_BYTES + 1000)
}, 20_000)

test('Tavily and Serper results are formatted for the model; HTTP errors are reported', async () => {
  const fetchSpy = spyOn(globalThis, 'fetch')
  try {
    fetchSpy.mockResolvedValueOnce(
      Response.json({
        answer: 'Bun is a runtime',
        results: [{ title: 'Bun', url: 'https://bun.sh', content: 'Fast' }],
      }),
    )
    const tavily = (await tavilySearchTool('key').execute({
      query: 'bun',
      max_results: 3,
    })) as string
    expect(tavily).toContain('## AI summary\nBun is a runtime')
    expect(tavily).toContain('### Bun\nhttps://bun.sh\nFast')
    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body))
    expect(body).toMatchObject({ api_key: 'key', query: 'bun', max_results: 3 })

    fetchSpy.mockResolvedValueOnce(
      Response.json({
        organic: [
          { title: 'A', link: 'https://a', snippet: 'a' },
          { title: 'B', link: 'https://b', snippet: 'b' },
        ],
      }),
    )
    const serper = (await serperSearchTool('key').execute({
      query: 'x',
      max_results: 1,
    })) as string
    expect(serper).toBe('### A\nhttps://a\na\n')

    fetchSpy.mockResolvedValueOnce(new Response('', { status: 429 }))
    expect(
      await tavilySearchTool('key').execute({ query: 'x', max_results: 5 }),
    ).toBe('[web_search] Request failed: HTTP 429')
  } finally {
    fetchSpy.mockRestore()
  }
})

test('a guest can use web_search but not web_fetch', async () => {
  const t = createTestVela({
    responses: [
      [
        fauxToolCall('web_fetch', { url: url('/page') }),
        fauxToolCall('web_search', { query: 'bun' }),
      ],
      fauxText('done'),
    ],
    extensions: [web({ tavilyKey: 'key' })],
    session: { role: 'guest' },
  })
  const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ results: [{ title: 'Bun', url: 'https://bun.sh' }] }),
  )
  let fetched: string[]
  try {
    await t.run('look it up')
  } finally {
    fetched = fetchSpy.mock.calls.map(([target]) => String(target))
    fetchSpy.mockRestore()
  }
  expect(t.model.calls[0]!.tools).toContain('web_search')
  expect(t.model.calls[0]!.tools).not.toContain('web_fetch')
  const results = t.model.calls[1]!.toolResults
  expect(JSON.stringify(results)).toContain("unavailable tool 'web_fetch'")
  expect(JSON.stringify(results)).toContain('https://bun.sh')
  // Only the search API was called, never the page
  expect(fetched).toEqual(['https://api.tavily.com/search'])
})

test.each(['tavily', 'serper'] as const)(
  '%s web_search sends a 20KB result through the SDK whole',
  async (provider) => {
    const content = 'search content '.repeat(1500)
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json(
        provider === 'tavily'
          ? {
              results: [
                { title: 'Result', url: 'https://example.com', content },
              ],
            }
          : {
              organic: [
                {
                  title: 'Result',
                  link: 'https://example.com',
                  snippet: content,
                },
              ],
            },
      ),
    )
    try {
      const t = createTestVela({
        extensions: [
          web(
            provider === 'tavily'
              ? { tavilyKey: 'faux-key' }
              : { serperKey: 'faux-key' },
          ),
        ],
        responses: [
          fauxToolCall('web_search', { query: 'example' }),
          fauxText('done'),
        ],
      })
      await t.run('Search the web')
      expect(t.model.calls[1]!.toolResults[0]!.output).toBe(
        `### Result\nhttps://example.com\n${content}\n`,
      )
    } finally {
      fetchSpy.mockRestore()
    }
  },
)
