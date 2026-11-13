import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function sessionExample(markdown: string): string[] {
  const heading = markdown.indexOf('## Session header')
  const fenceStart = markdown.indexOf('```json\n', heading)
  const fenceEnd = markdown.indexOf('\n```', fenceStart)
  return markdown
    .slice(fenceStart + '```json\n'.length, fenceEnd)
    .split('\n')
    .filter((line) => line.length > 0)
}

test('each toolcall_delta in the JSON mode example is part of the tool input on the same line', () => {
  const markdown = readFileSync(
    join(import.meta.dir, '../../docs/json.md'),
    'utf8',
  )
  const deltas = sessionExample(markdown).flatMap((line) => {
    const event = JSON.parse(line) as {
      message?: { content?: Array<{ input?: unknown }> }
      assistantMessageEvent?: {
        type?: string
        contentIndex?: number
        delta?: string
      }
    }
    const streamed = event.assistantMessageEvent
    if (streamed?.type !== 'toolcall_delta') return []
    const part = event.message?.content?.[streamed.contentIndex ?? -1]
    return [
      {
        delta: streamed.delta,
        input: JSON.stringify(part?.input),
      },
    ]
  })
  expect(deltas.length).toBeGreaterThan(0)
  expect(
    deltas.filter(({ delta, input }) => !input.includes(delta ?? '')),
  ).toEqual([])
})
