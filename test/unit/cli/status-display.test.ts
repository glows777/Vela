import { expect, test } from 'bun:test'
import { stripTerminalSequences, Text } from '@earendil-works/pi-tui'
import { formatStatusPath } from '../../../src/cli/status-display.ts'
import { formatUsd } from '../../../src/usage/format.ts'

const HOME = '/home/ada'
const AGENT = '/tmp/vela-verify/taste-status-43/home'
const PROJECT = '--tmp-vela-verify-taste-status-43-work--59f22c27'
const DATA_DIR = `${AGENT}/projects/${PROJECT}`
const ID = '20261014-171356-f69f'
const FILE = `${DATA_DIR}/sessions/${ID}.jsonl`

/** Same widget `/status` uses: one column of padding on each side. */
function pathLines(value: string, columns = 120): string[] {
  return new Text(`  Path: ${value}`, 1, 0)
    .render(columns)
    .map((line) => stripTerminalSequences(line).trimEnd())
    .filter((line) => line.trim().length > 0)
}

test('formatUsd matches across the amounts the footer used to round differently', () => {
  expect(formatUsd(0.0016)).toBe('$0.0016')
  expect(formatUsd(1.005)).toBe('$1.0050')
  expect(formatUsd(0.0016)).not.toBe(`$${(0.0016).toFixed(3)}`)
  expect(formatUsd(1.005)).not.toBe(`$${(1.005).toFixed(3)}`)
})

test('a missing session file is a destination, not a path that looks saved', () => {
  const value = formatStatusPath({
    persistence: { type: 'file', path: FILE },
    dataDir: DATA_DIR,
    homeDir: HOME,
    isFile: () => false,
  })
  expect(value.startsWith('not written yet (will save to ')).toBe(true)
  expect(value).toContain('$VELA_DIR/projects/')
  expect(value).toContain(`${ID}.jsonl`)
  expect(value).not.toContain(FILE)
  const lines = pathLines(value)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('Path:')
  expect(lines[0]).toContain(`${ID}.jsonl`)
})

test('a saved session outside home shortens VELA_DIR and keeps the session id on the Path line', () => {
  const value = formatStatusPath({
    persistence: { type: 'file', path: FILE },
    dataDir: DATA_DIR,
    homeDir: HOME,
    isFile: () => true,
  })
  expect(value).toBe(`$VELA_DIR/projects/${PROJECT}/sessions/${ID}.jsonl`)
  expect(value).not.toContain('not written yet')
  const lines = pathLines(value)
  expect(lines).toHaveLength(1)
  expect(lines[0]?.includes('Path:') && lines[0]?.includes(`${ID}.jsonl`)).toBe(
    true,
  )
})

test('a saved session under home shortens like the footer cwd', () => {
  const path = `${HOME}/.vela/projects/${PROJECT}/sessions/${ID}.jsonl`
  const value = formatStatusPath({
    persistence: { type: 'file', path },
    dataDir: `${HOME}/.vela/projects/${PROJECT}`,
    homeDir: HOME,
    isFile: () => true,
  })
  expect(value).toBe(`~/.vela/projects/${PROJECT}/sessions/${ID}.jsonl`)
})

test('a very long project path ellipsizes the directory and does not crack the session id', () => {
  const project = `--${'deep-project-name-'.repeat(12)}--abcd1234`
  const dataDir = `${AGENT}/projects/${project}`
  const path = `${dataDir}/sessions/${ID}.jsonl`
  const value = formatStatusPath({
    persistence: { type: 'file', path },
    dataDir,
    homeDir: HOME,
    isFile: () => true,
  })
  expect(value.endsWith(`/sessions/${ID}.jsonl`)).toBe(true)
  expect(value).toContain('…')
  expect(value.startsWith('$VELA_DIR/')).toBe(true)
  const lines = pathLines(value)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain(`${ID}.jsonl`)
  expect(lines[0]).toContain('Path:')
})

test('memory and unknown storage stay honest', () => {
  expect(
    formatStatusPath({
      persistence: { type: 'memory' },
      dataDir: DATA_DIR,
      homeDir: HOME,
      isFile: () => true,
    }),
  ).toBe('in-memory (not saved)')
  expect(
    formatStatusPath({
      persistence: { type: 'unknown' },
      dataDir: DATA_DIR,
      homeDir: HOME,
      isFile: () => true,
    }),
  ).toBe('custom storage (path unknown)')
})
