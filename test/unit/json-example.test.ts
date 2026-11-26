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

test('the JSON mode example validates v0.9 RuntimeEvent and StreamDeltaEvent lines', () => {
  const markdown = readFileSync(
    join(import.meta.dir, '../../docs/json.md'),
    'utf8',
  )
  const events = sessionExample(markdown).map(
    (line) =>
      JSON.parse(line) as {
        type: string
        toolCall?: { input?: unknown }
        input?: unknown
      },
  )
  expect(events[0]?.type).toBe('session')
  const toolcallEnd = events.find((event) => event.type === 'toolcall_end')
  const toolStarted = events.find((event) => event.type === 'tool_started')
  expect(toolcallEnd?.toolCall?.input).toBeDefined()
  expect(toolcallEnd?.toolCall?.input).toEqual(toolStarted?.input)
  expect(events.some((event) => event.type === 'run_started')).toBe(true)
  expect(events.some((event) => event.type === 'tool_finished')).toBe(true)
  expect(events.some((event) => event.type === 'text_delta')).toBe(true)
  expect(events.some((event) => event.type === 'run_finished')).toBe(true)
})
