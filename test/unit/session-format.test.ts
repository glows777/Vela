import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '../..')

type HeaderField = {
  name: string
  optional: boolean
  type: string
}

function sessionHeaderFields(source: string): HeaderField[] {
  const start = source.indexOf('interface SessionHeader {')
  if (start < 0) throw new Error('SessionHeader interface not found')
  const open = source.indexOf('{', start)
  const close = source.indexOf('\n}', open)
  if (close < 0) throw new Error('SessionHeader interface not closed')
  const fields: HeaderField[] = []
  for (const raw of source.slice(open + 1, close).split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim()
    if (
      line.length === 0 ||
      line.startsWith('/*') ||
      line.startsWith('*') ||
      line.startsWith('*/')
    )
      continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(\?)?:\s*(.+)$/.exec(line)
    if (!match) throw new Error(`unparsed SessionHeader line: ${raw}`)
    fields.push({
      name: match[1]!,
      optional: match[2] === '?',
      type: match[3]!.trim(),
    })
  }
  if (fields.length === 0) throw new Error('SessionHeader has no fields')
  return fields
}

function section(markdown: string, heading: string, next: string): string {
  const start = markdown.indexOf(`\n${heading}\n`)
  if (start < 0) throw new Error(`missing ${heading}`)
  const end = markdown.indexOf(`\n${next}\n`, start + heading.length)
  if (end < 0) throw new Error(`missing ${next}`)
  return markdown.slice(start, end)
}

test('the session-format Header matches SessionHeader and states how location is written', () => {
  const markdown = readFileSync(join(root, 'docs/session-format.md'), 'utf8')
  const source = readFileSync(
    join(root, 'packages/core/src/session/entries.ts'),
    'utf8',
  )
  const header = section(markdown, '## Header', '## Entries')
  const documented = sessionHeaderFields(header)
  const written = sessionHeaderFields(source)

  expect(documented).toEqual(written)
  expect(documented.some((field) => field.name === 'location')).toBe(true)
  expect(header).toContain("{ environment: 'local', cwd }")
  expect(header).toContain(
    '`resume()` restores that saved cwd even when the caller passes a different cwd',
  )
  expect(header).toContain(
    "A header with no `location` keeps the prior fallback, the caller's cwd or the default cwd",
  )
  expect(header).toContain(
    '`exportJsonl()`, `fork()`, and `clone()` keep `location` on the header they write',
  )

  const example = section(
    markdown,
    '## Example',
    '## Reading sessions from code',
  )
  const headerLine = example
    .split('\n')
    .find((line) => line.includes('"type":"session"'))
  expect(headerLine).toBeDefined()
  const record = JSON.parse(headerLine!) as {
    cwd?: string
    location?: { environment?: string; cwd?: string }
  }
  expect(record.location).toEqual({ environment: 'local', cwd: record.cwd })
})
