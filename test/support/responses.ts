/** Successful offline HTTP responses for tests of the real OpenAI Responses adapter. */
export function responsesReply(
  body: { model?: unknown; stream?: unknown },
  reasoning?: 'text' | 'summary',
  tool?: { name: string; arguments: string },
) {
  const item = tool
    ? {
        type: 'function_call',
        id: 'fc_test',
        call_id: 'call_test',
        status: 'completed',
        ...tool,
      }
    : {
        type: 'message',
        id: 'msg_test',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'OK', annotations: [] }],
      }
  const reasoningItem = {
    type: 'reasoning',
    id: 'rs_test',
    summary: [],
    encrypted_content: 'encrypted-test',
  }
  const response = {
    id: 'resp_test',
    created_at: 1,
    model: body.model,
    status: 'completed',
    output: reasoning ? [reasoningItem, item] : [item],
    usage: { input_tokens: 10, output_tokens: 1 },
  }
  if (!body.stream) return Response.json(response)
  const outputIndex = reasoning ? 1 : 0
  const events: Record<string, unknown>[] = [
    { type: 'response.created', response },
    { type: 'response.output_item.added', output_index: outputIndex, item },
    {
      type: tool
        ? 'response.function_call_arguments.delta'
        : 'response.output_text.delta',
      item_id: item.id,
      output_index: outputIndex,
      delta: tool ? tool.arguments : 'OK',
    },
    { type: 'response.output_item.done', output_index: outputIndex, item },
    { type: 'response.completed', response },
  ]
  if (reasoning) {
    events.splice(
      1,
      0,
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: reasoningItem,
      },
      ...['Check ', 'the result.'].map((delta) => ({
        type:
          reasoning === 'text'
            ? 'response.reasoning_text.delta'
            : 'response.reasoning_summary_text.delta',
        item_id: reasoningItem.id,
        output_index: 0,
        ...(reasoning === 'text' ? { content_index: 0 } : { summary_index: 0 }),
        delta,
      })),
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: reasoningItem,
      },
    )
  }
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}
