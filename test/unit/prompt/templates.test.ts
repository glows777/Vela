import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  expandPromptTemplate,
  loadPromptTemplates,
  parseCommandArgs,
  substituteArgs,
} from '../../../src/prompt/templates.ts'
import { tempDir } from '../../support/vela.ts'

const dirs: { cleanup(): void }[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})

function setup(files: Record<string, string>): string {
  const dir = tempDir()
  dirs.push(dir)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir.path, path)), { recursive: true })
    writeFileSync(join(dir.path, path), content)
  }
  return dir.path
}

test('parseCommandArgs splits on whitespace and keeps quoted groups', () => {
  expect(parseCommandArgs(`a "b c" 'd e'  f`)).toEqual(['a', 'b c', 'd e', 'f'])
  expect(parseCommandArgs('')).toEqual([])
})

test('substituteArgs supports positional, all, defaults and slices like pi', () => {
  const args = ['one', 'two', 'three']
  expect(substituteArgs('$1-$2-$4', args)).toBe('one-two-')
  expect(substituteArgs('$@ | $ARGUMENTS', args)).toBe(
    'one two three | one two three',
  )
  expect(substituteArgs('${4:-none} ${1:-x}', args)).toBe('none one')
  expect(substituteArgs('${@:-empty}', [])).toBe('empty')
  expect(substituteArgs('${@:2}', args)).toBe('two three')
  expect(substituteArgs('${@:2:1}', args)).toBe('two')
  // values are not substituted again
  expect(substituteArgs('$1', ['$2', 'x'])).toBe('$2')
})

test('templates load from directories and files; description from frontmatter or the first line; first name wins', () => {
  const root = setup({
    'project/review.md':
      '---\ndescription: Review a file\nargument-hint: <file>\n---\nReview $1 carefully',
    'project/notes.txt': 'not a template',
    'user/review.md': 'User review',
    'user/explain.md': `\n${'Explain this code in plain words please, step by step, with examples'}\n`,
  })
  const { templates, diagnostics } = loadPromptTemplates([
    join(root, 'project'),
    join(root, 'user'),
    join(root, 'missing'),
  ])
  expect(templates.map((t) => t.name)).toEqual(['review', 'explain'])
  expect(templates[0]).toMatchObject({
    description: 'Review a file',
    argumentHint: '<file>',
    content: 'Review $1 carefully',
  })
  expect(templates[1]!.description).toBe(
    'Explain this code in plain words please, step by step, with ...',
  )
  expect(diagnostics.map((d) => d.message)).toEqual([
    `prompt template name "review" is already used by ${join(root, 'project/review.md')}; skipped`,
  ])
})

test('expandPromptTemplate replaces /<name> args and leaves other text alone', () => {
  const root = setup({ 'p/fix.md': 'Fix $1 in ${@:2}' })
  const { templates } = loadPromptTemplates([join(root, 'p')])
  expect(expandPromptTemplate('/fix "the bug" a.ts b.ts', templates)).toBe(
    'Fix the bug in a.ts b.ts',
  )
  expect(expandPromptTemplate('/nope x', templates)).toBeUndefined()
  expect(expandPromptTemplate('fix x', templates)).toBeUndefined()
})
