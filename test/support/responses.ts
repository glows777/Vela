/** Successful offline HTTP responses for tests of the real OpenAI Responses adapter. */
export function responsesReply(body: { model?: unknown; stream?: unknown }) {
  const item = {
    type: 'message',
    id: 'msg_test',
    role: 'assistant',
    phase: 'final_answer',
    content: [{ type: 'output_text', text: 'OK', annotations: [] }],
  }
  const response = {
    id: 'resp_test',
    created_at: 1,
    model: body.model,
    status: 'completed',
    output: [item],
    usage: { input_tokens: 10, output_tokens: 1 },
  }
  if (!body.stream) return Response.json(response)
  const events = [
    { type: 'response.created', response },
    { type: 'response.output_item.added', output_index: 0, item },
    {
      type: 'response.output_text.delta',
      item_id: item.id,
      output_index: 0,
      delta: 'OK',
    },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ]
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  )
}
