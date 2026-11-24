import { expect, test } from 'bun:test'
import { foldSummary, type TurnCounts } from '../../../src/cli/tui/turn-fold.ts'

const counts = (overrides: Partial<TurnCounts> = {}): TurnCounts => ({
  searched: 0,
  read: 0,
  listed: 0,
  edited: 0,
  shell: 0,
  mcp: 0,
  other: 0,
  ...overrides,
})

test('a finished turn reads in the past tense with singular nouns where they belong', () => {
  expect(
    foldSummary(counts({ searched: 3, read: 2, shell: 1 }), {
      running: false,
      thoughtMs: 159_000,
    }),
  ).toBe(
    'Thought for 2m 39s, searched for 3 patterns, read 2 files, ran 1 shell command',
  )
})

test('a running turn reads in the present tense', () => {
  expect(
    foldSummary(counts({ searched: 1, listed: 2, edited: 1 }), {
      running: true,
      thoughtMs: 3000,
    }),
  ).toBe(
    'Thinking for 3s, searching for 1 pattern, listing 2 directories, editing 1 file',
  )
})

test('the line only names what the turn did', () => {
  expect(
    foldSummary(counts({ shell: 4 }), { running: false, thoughtMs: 0 }),
  ).toBe('ran 4 shell commands')
  expect(
    foldSummary(counts({ mcp: 2, other: 1 }), { running: false, thoughtMs: 0 }),
  ).toBe('called 2 MCP tools, called 1 other tool')
  expect(foldSummary(counts(), { running: false, thoughtMs: 1200 })).toBe(
    'Thought for 1s',
  )
})
