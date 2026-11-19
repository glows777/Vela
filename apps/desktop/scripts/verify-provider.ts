/**
 * A local OpenAI-compatible endpoint for the first-run journey. Only the key it knows answers;
 * anything else gets the provider-style refusal the app shows, so the journey can prove that a
 * wrong key is rejected before anything is written. A saved model then answers through it too,
 * which proves the host is using the choice it just saved.
 */
export const GOOD_KEY = 'good-key'

/** One streamed answer, in the shape the AI SDK's chat-completions reader expects. */
function stream(reply: { model?: string }, text: string): Response {
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({
      id: 'verify-reply',
      object: 'chat.completion.chunk',
      created: 1,
      model: reply.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
  return new Response(
    [
      chunk({ role: 'assistant', content: '' }, null),
      chunk({ content: text }, null),
      chunk({}, 'stop'),
      'data: [DONE]\n\n',
    ].join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

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
      const body = (await request.json()) as {
        model?: string
        stream?: boolean
      }
      const answer = {
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
      }
      return body.stream ? stream(body, 'Local answer') : Response.json(answer)
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    stop: () => {
      server.stop(true)
    },
  }
}
