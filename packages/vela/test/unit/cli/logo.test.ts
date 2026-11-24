import { expect, test } from 'bun:test'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import {
  headerText,
  LOGO_COLUMNS,
  logoLines,
  StartupHeader,
  supportsLogo,
} from '../../../src/cli/tui/logo.ts'

const GAP = 2
const TEXT_COLUMN = LOGO_COLUMNS + GAP

/** The text of each rendered line, without colors or trailing padding. */
function plain(lines: string[]): string[] {
  return lines.map((line) => stripTerminalSequences(line).trimEnd())
}

test('the mark is three colored lines, each as wide as the grid', () => {
  const lines = logoLines()
  expect(lines).toHaveLength(3)
  for (const line of lines) {
    expect(line).toContain('\x1b[')
    expect(visibleWidth(line)).toBe(LOGO_COLUMNS)
  }
  // Half blocks: a line that drew no pixel would be blank once the colors are stripped
  for (const line of plain(lines)) expect(line.trim()).not.toBe('')
})

test('Apple Terminal and narrow terminals do not get the mark', () => {
  expect(supportsLogo(120, false)).toBe(true)
  expect(supportsLogo(120, true)).toBe(false)
  expect(supportsLogo(30, false)).toBe(false)
  // The text column needs 32 columns, on top of the mark, its gap and the header's padding
  expect(supportsLogo(TEXT_COLUMN + 32 + 2 - 1, false)).toBe(false)
  expect(supportsLogo(TEXT_COLUMN + 32 + 2, false)).toBe(true)
})

test('the mark sits left of the header text, which stays in its column', () => {
  const lines = plain(headerText(['TITLE', 'HINTS'], 100).split('\n'))
  expect(lines).toHaveLength(3)
  expect(lines[0]).toContain('TITLE')
  expect(lines[0]?.indexOf('TITLE')).toBe(TEXT_COLUMN)
  expect(lines[1]).toContain('HINTS')
  expect(lines[1]?.indexOf('HINTS')).toBe(TEXT_COLUMN)
  // The mark's last line has no text beside it, and no text jumps back to the left edge
  expect(lines[2]).not.toContain('TITLE')
  for (const line of lines.slice(1)) expect(line).not.toStartWith('TITLE')
})

test('a wrapped hint stays in the text column instead of running back to the left edge', () => {
  const hint = 'x'.repeat(80)
  const lines = plain(headerText(['TITLE', hint], 60).split('\n'))
  const hintLines = lines.filter((line) => line.includes('x'))
  expect(hintLines.length).toBeGreaterThan(1)
  for (const line of hintLines) expect(line.indexOf('x')).toBe(TEXT_COLUMN)
})

test('without the mark the header is the plain text it always was', () => {
  expect(headerText(['TITLE', 'HINTS'], 30)).toBe('TITLE\nHINTS')
})

test('the header component renders the mark, and the text alone on a narrow terminal', () => {
  const header = new StartupHeader(() => ['TITLE', 'HINTS'])
  const wide = plain(header.render(100))
  expect(wide[0]).toContain('TITLE')
  expect(wide.join('\n')).toContain('█')

  const narrow = plain(header.render(30))
  expect(narrow.join('\n')).not.toContain('█')
  expect(narrow[0]?.trim()).toBe('TITLE')
})
