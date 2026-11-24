import { expect, test } from 'bun:test'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import {
  headerText,
  LOGO_COLUMNS,
  LOGO_LINES,
  logoLines,
  StartupHeader,
  supportsLogo,
} from '../../../src/cli/tui/logo.ts'

const GAP = 2
const TEXT_COLUMN = LOGO_COLUMNS + GAP
const MIN_TEXT = 32
const PADDING = 2

/** The text of each rendered line, without colors or trailing padding. */
function plain(lines: string[]): string[] {
  return lines.map((line) => stripTerminalSequences(line).trimEnd())
}

test('the mark is a colored block on every line, as wide as the grid', () => {
  const lines = logoLines()
  expect(lines).toHaveLength(LOGO_LINES)
  for (const line of lines) {
    expect(line).toContain('\x1b[')
    expect(visibleWidth(line)).toBe(LOGO_COLUMNS)
  }
  // Every line draws something: a line of only transparent pixels would be blank once color is gone
  for (const line of plain(lines)) expect(line.trim()).not.toBe('')
})

test('no line of the mark is a lone pixel', () => {
  // A single half block reads as a rendering error at this size, so each line needs a run of two
  for (const line of plain(logoLines())) expect(line).toMatch(/[▀▄█]{2}/)
})

test('Apple Terminal and narrow terminals do not get the mark', () => {
  expect(supportsLogo(120, false)).toBe(true)
  expect(supportsLogo(120, true)).toBe(false)
  expect(supportsLogo(30, false)).toBe(false)
  // The text column needs its minimum, on top of the mark, its gap and the header's padding
  const exact = TEXT_COLUMN + MIN_TEXT + PADDING
  expect(supportsLogo(exact - 1, false)).toBe(false)
  expect(supportsLogo(exact, false)).toBe(true)
})

test('the mark sits left of the header text, which stays in its column', () => {
  const lines = plain(headerText(['TITLE', 'HINTS'], 100).split('\n'))
  expect(lines.length).toBe(Math.max(LOGO_LINES, 2))
  expect(lines[0]).toContain('TITLE')
  expect(lines[0]?.indexOf('TITLE')).toBe(TEXT_COLUMN)
  expect(lines[1]).toContain('HINTS')
  expect(lines[1]?.indexOf('HINTS')).toBe(TEXT_COLUMN)
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
