import { expect, test } from 'bun:test'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { formatUsd } from '../../../src/cli/format.ts'
import {
  fitStatusLines,
  formatStatusPath,
  noticeContentWidth,
} from '../../../src/cli/status-display.ts'
import { notice } from '../../../src/cli/tui/components.ts'

const HOME = '/home/ada'
const AGENT = '/tmp/vela-verify/taste-status-43/home'
const PROJECT = '--tmp-vela-verify-taste-status-43-work--59f22c27'
const ID = '20261014-171356-f69f'
const FILE = `${AGENT}/projects/${PROJECT}/sessions/${ID}.jsonl`

const PATH_LABEL = '  Path: '

/** True when `text` contains a UTF-16 surrogate that is not part of a pair. */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

/**
 * The same notice() the TUI uses for `/status`, at a real terminal width.
 * Each returned line is one rendered row. Text wraps anything wider than the
 * content width, so a fitted Path must come back as the same number of rows
 * `fitStatusLines` produced.
 */
function renderPath(value: string, columns: number): string[] {
  const content = noticeContentWidth(columns)
  const fitted = fitStatusLines(`${PATH_LABEL}${value}`, content)
  const fittedLines = fitted.split('\n')
  for (const line of fittedLines) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(content)
    expect(hasLoneSurrogate(line)).toBe(false)
  }
  const paddingX = Math.min(1, Math.max(0, Math.floor((columns - 1) / 2)))
  const lines = notice(`${PATH_LABEL}${value}`, 'info', true)
    .render(columns)
    .map((line) => stripTerminalSequences(line).trimEnd())
    .filter((line) => line.trim().length > 0)
  expect(lines).toHaveLength(fittedLines.length)
  for (const line of lines) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(columns)
    expect(visibleWidth(line.slice(paddingX))).toBeLessThanOrEqual(content)
    expect(hasLoneSurrogate(line)).toBe(false)
    expect(line.trim()).not.toBe('Path:')
  }
  return lines
}

/** One rendered Path row that still holds this short session id whole. */
function pathLine(value: string, columns: number): string {
  const lines = renderPath(value, columns)
  expect(lines).toHaveLength(1)
  const line = lines[0] ?? ''
  expect(line).toContain('Path:')
  expect(line).toContain(`${ID}.jsonl`)
  return line
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
    homeDir: HOME,
    agentDir: AGENT,
    isFile: () => false,
  })
  expect(value.startsWith('not written yet (will save to ')).toBe(true)
  expect(value).toContain('$VELA_DIR/projects/')
  expect(value).toContain(`${ID}.jsonl`)
  expect(value).not.toContain(FILE)
  for (const columns of [80, 120]) {
    const lines = renderPath(value, columns)
    const label = lines.find((line) => line.includes('Path:')) ?? ''
    expect(label).toContain('not written yet')
    expect(label).not.toContain('.jsonl')
    const dest = lines.find((line) => line.includes(`${ID}.jsonl`)) ?? ''
    expect(dest).toContain(`${ID}.jsonl`)
    expect(lines.filter((line) => line.includes('.jsonl'))).toHaveLength(1)
  }
})

test('a saved session outside home shortens VELA_DIR and fits 80 and 120 columns', () => {
  const value = formatStatusPath({
    persistence: { type: 'file', path: FILE },
    homeDir: HOME,
    agentDir: AGENT,
    isFile: () => true,
  })
  expect(value).toBe(`$VELA_DIR/projects/${PROJECT}/sessions/${ID}.jsonl`)
  expect(value).not.toContain('not written yet')
  const wide = pathLine(value, 120)
  expect(wide).toContain(PROJECT)
  expect(wide).not.toContain('…')
  const narrow = pathLine(value, 80)
  expect(narrow).toContain('…')
  expect(narrow).toContain(`${ID}.jsonl`)
})

test('a trailing separator on the configured directory stays between the alias and the next segment', () => {
  const saved = `projects/${PROJECT}/sessions/${ID}.jsonl`
  const path = `${AGENT}/${saved}`
  const shown = `$VELA_DIR/${saved}`

  const trailing = formatStatusPath({
    persistence: { type: 'file', path },
    homeDir: HOME,
    agentDir: `${AGENT}/`,
    isFile: () => true,
  })
  expect(trailing).toBe(shown)
  expect(trailing.startsWith('$VELA_DIR/')).toBe(true)
  expect(trailing).not.toContain('$VELA_DIRprojects')

  const plain = formatStatusPath({
    persistence: { type: 'file', path },
    homeDir: HOME,
    agentDir: AGENT,
    isFile: () => true,
  })
  expect(plain).toBe(shown)

  const atRoot = formatStatusPath({
    persistence: { type: 'file', path: `/${saved}` },
    homeDir: HOME,
    agentDir: '/',
    isFile: () => true,
  })
  expect(atRoot).toBe(shown)
  expect(atRoot).not.toContain('$VELA_DIRprojects')

  const underHome = formatStatusPath({
    persistence: { type: 'file', path: `${HOME}/${saved}` },
    homeDir: `${HOME}/`,
    agentDir: AGENT,
    isFile: () => true,
  })
  expect(underHome).toBe(`~/${saved}`)
  expect(underHome).not.toContain('~projects')

  for (const value of [trailing, plain, atRoot]) {
    const wide = pathLine(value, 120)
    expect(wide).toContain('$VELA_DIR/projects/')
    expect(wide).not.toContain('$VELA_DIRprojects')
  }
  const homeLine = pathLine(underHome, 120)
  expect(homeLine).toContain('~/projects/')
  expect(homeLine).not.toContain('~projects')
})

test('a saved session under home shortens like the footer cwd', () => {
  const path = `${HOME}/.vela/projects/${PROJECT}/sessions/${ID}.jsonl`
  const value = formatStatusPath({
    persistence: { type: 'file', path },
    homeDir: HOME,
    agentDir: `${HOME}/.vela`,
    isFile: () => true,
  })
  expect(value).toBe(`~/.vela/projects/${PROJECT}/sessions/${ID}.jsonl`)
  expect(value).not.toContain('$VELA_DIR')
})

test('a very long project path keeps the session id on one line at 80 and 120 columns', () => {
  const project = `--${'deep-project-name-'.repeat(12)}--abcd1234`
  const path = `${AGENT}/projects/${project}/sessions/${ID}.jsonl`
  const value = formatStatusPath({
    persistence: { type: 'file', path },
    homeDir: HOME,
    agentDir: AGENT,
    isFile: () => true,
  })
  expect(value.endsWith(`/sessions/${ID}.jsonl`)).toBe(true)
  expect(value.startsWith('$VELA_DIR/')).toBe(true)
  for (const columns of [80, 120]) {
    const line = pathLine(value, columns)
    expect(line).toContain('…')
    expect(line).toContain(`${ID}.jsonl`)
  }
})

test('VELA_DIR=/tmp/x/home does not claim a dataDir at /tmp/x/external/projects/team', () => {
  const agentDir = '/tmp/x/home'
  const path = `/tmp/x/external/projects/team/sessions/${ID}.jsonl`
  for (const isFile of [() => true, () => false]) {
    const value = formatStatusPath({
      persistence: { type: 'file', path },
      homeDir: HOME,
      agentDir,
      isFile,
    })
    expect(value).not.toContain('$VELA_DIR')
    expect(value).toContain(path)
    if (!isFile())
      expect(value.startsWith('not written yet (will save to ')).toBe(true)
    for (const columns of [80, 120]) {
      const lines = renderPath(value, columns)
      const shown = lines.join('\n')
      expect(shown).not.toContain('$VELA_DIR')
      expect(shown).toContain(path)
      if (!isFile()) expect(shown).toContain('not written yet')
    }
  }
  const inferred = formatStatusPath({
    persistence: { type: 'file', path },
    homeDir: HOME,
    isFile: () => true,
  })
  expect(inferred).toBe(path)
})

test('a CJK project directory is measured in display columns, not JavaScript length', () => {
  const project = `--${'项目'.repeat(20)}--abcd1234`
  const path = `${AGENT}/projects/${project}/sessions/${ID}.jsonl`
  const value = formatStatusPath({
    persistence: { type: 'file', path },
    homeDir: HOME,
    agentDir: AGENT,
    isFile: () => true,
  })
  const line = `${PATH_LABEL}${value}`
  expect(line.length).toBeLessThanOrEqual(118)
  expect(visibleWidth(line)).toBeGreaterThan(118)
  for (const columns of [80, 120]) {
    const rendered = pathLine(value, columns)
    expect(rendered).toContain('…')
    expect(rendered).toContain(`/sessions/${ID}.jsonl`)
  }
})

test('90- and 128-character session ids stay honest at 80 and 120 columns', () => {
  const ids = ['x'.repeat(90), 'y'.repeat(128)]
  for (const id of ids) {
    const path = `${AGENT}/projects/${PROJECT}/sessions/${id}.jsonl`
    const name = `${id}.jsonl`
    for (const saved of [false, true]) {
      const value = formatStatusPath({
        persistence: { type: 'file', path },
        homeDir: HOME,
        agentDir: AGENT,
        isFile: () => saved,
      })
      for (const columns of [80, 120]) {
        const content = noticeContentWidth(columns)
        const lines = renderPath(value, columns)
        const label = lines.find((line) => line.includes('Path:')) ?? ''
        expect(label.trim()).not.toBe('Path:')
        if (!saved) {
          expect(label).toContain('not written yet')
          expect(label).not.toContain('.jsonl')
        } else {
          expect(label).not.toContain('not written yet')
        }
        const nameFits =
          visibleWidth(name) <=
          content - (saved ? PATH_LABEL.length : '  '.length)
        if (nameFits) {
          const holders = lines.filter((line) => line.includes(name))
          expect(holders).toHaveLength(1)
        } else {
          expect(lines.join('\n')).not.toContain(name)
          expect(lines).toHaveLength(1)
          if (saved) {
            expect(label).toContain('…')
            expect(label).toContain(id.slice(0, 16))
          }
        }
      }
    }
  }
})

test('truncation never splits a wide character or a surrogate pair', () => {
  const emoji = '😀'
  expect(emoji.length).toBe(2)
  expect(visibleWidth(emoji)).toBeGreaterThan(0)
  const project = `--${'n'.repeat(7)}${emoji}${'项目'.repeat(24)}--abcd1234`
  const path = `${AGENT}/projects/${project}/sessions/${ID}.jsonl`
  const value = formatStatusPath({
    persistence: { type: 'file', path },
    homeDir: HOME,
    agentDir: AGENT,
    isFile: () => true,
  })
  const samples = [
    `${PATH_LABEL}${value}`,
    `${PATH_LABEL}not written yet (will save to ${value})`,
    `${PATH_LABEL}${emoji.repeat(20)}${'项'.repeat(40)}`,
  ]
  for (const sample of samples) {
    for (let width = 1; width <= 140; width++) {
      for (const line of fitStatusLines(sample, width).split('\n')) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width)
        expect(hasLoneSurrogate(line)).toBe(false)
      }
    }
  }
  for (const columns of [80, 120]) {
    const rendered = pathLine(value, columns)
    expect(rendered).toContain(`${ID}.jsonl`)
  }
})

test('memory and unknown storage stay honest', () => {
  expect(
    formatStatusPath({
      persistence: { type: 'memory' },
      homeDir: HOME,
      agentDir: AGENT,
      isFile: () => true,
    }),
  ).toBe('in-memory (not saved)')
  expect(
    formatStatusPath({
      persistence: { type: 'unknown' },
      homeDir: HOME,
      agentDir: AGENT,
      isFile: () => true,
    }),
  ).toBe('custom storage (path unknown)')
})
