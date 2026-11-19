/**
 * A local OpenAI-compatible endpoint for the first-run journey. Only the key it knows answers;
 * anything else gets the provider-style refusal the app shows, so the journey can prove that a
 * wrong key is rejected before anything is written.
 */
export const GOOD_KEY = 'good-key'

export function startVerifyProvider() {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== '/v1/chat/completions')
        return new Response('not found', { status: 404 })
      if (request.headers.get('authorization') !== `Bearer ${GOOD_KEY}`)
        return Response.json(
          { error: { message: 'invalid api key' } },
          { status: 401 },
        )
      const body = (await request.json()) as { model?: string }
      return Response.json({
        id: 'verify-reply',
        object: 'chat.completion',
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'OK' },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    stop: () => {
      server.stop(true)
    },
  }
}
