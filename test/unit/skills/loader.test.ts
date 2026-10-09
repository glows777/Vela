import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SkillLoader } from '../../../src/skills/loader.ts'
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

const skill = (meta: string, body = 'Body') => `---\n${meta}\n---\n\n${body}\n`

test('name comes from frontmatter, falling back to the directory; multi-line YAML descriptions work', () => {
  const root = setup({
    'skills/a/SKILL.md': skill('name: pdf-tools\ndescription: Work with PDFs'),
    'skills/b-dir/SKILL.md': skill('description: >\n  Folded\n  description'),
  })
  const loader = new SkillLoader([join(root, 'skills')])
  const skills = loader.load()
  expect(skills.map((s) => s.name).sort()).toEqual(['b-dir', 'pdf-tools'])
  const pdf = loader.get('pdf-tools')!
  expect(pdf.description).toBe('Work with PDFs')
  expect(pdf.filePath).toBe(join(root, 'skills/a/SKILL.md'))
  expect(pdf.baseDir).toBe(join(root, 'skills/a'))
  expect(loader.get('b-dir')!.description).toBe('Folded description')
  expect(loader.diagnostics).toEqual([])
})

test('a SKILL.md without description is skipped with a diagnostic; invalid names only warn', () => {
  const root = setup({
    'skills/empty/SKILL.md': 'No frontmatter',
    'skills/Bad_Name/SKILL.md': skill('description: Still loads'),
  })
  const loader = new SkillLoader([join(root, 'skills')])
  expect(loader.load().map((s) => s.name)).toEqual(['Bad_Name'])
  const messages = loader.diagnostics.map((d) => d.message)
  expect(messages).toContain('description is required; skipped')
  expect(messages.some((m) => m.includes('invalid characters'))).toBe(true)
})

test('discovery: SKILL.md stops recursion, nested skills are found, root .md files with a description count', () => {
  const root = setup({
    'skills/group/inner/SKILL.md': skill('description: Nested'),
    'skills/outer/SKILL.md': skill('description: Outer'),
    'skills/outer/sub/SKILL.md': skill('description: Hidden by outer'),
    'skills/notes.md': skill('description: A root file skill'),
    'skills/readme.md': 'Just a document',
    'skills/.hidden/SKILL.md': skill('description: Hidden'),
    'skills/node_modules/x/SKILL.md': skill('description: Dependency'),
  })
  const loader = new SkillLoader([join(root, 'skills')])
  expect(
    loader
      .load()
      .map((s) => s.name)
      .sort(),
  ).toEqual(['inner', 'notes', 'outer'])
})

test('the first skill with a name wins and the collision is reported; a symlinked copy is not a collision', () => {
  const root = setup({
    'project/deploy/SKILL.md': skill('description: Project deploy'),
    'user/deploy/SKILL.md': skill('description: User deploy'),
  })
  symlinkSync(join(root, 'project/deploy'), join(root, 'user/linked'))
  const loader = new SkillLoader([
    join(root, 'project'),
    join(root, 'user'),
    join(root, 'missing'),
  ])
  loader.load()
  expect(loader.get('deploy')!.description).toBe('Project deploy')
  expect(loader.diagnostics).toHaveLength(1)
  expect(loader.diagnostics[0]!.message).toContain('already used by')
})

test('the prompt section lists name, description and location, needs a reading tool and hides manual-only skills', () => {
  const root = setup({
    'skills/review/SKILL.md': skill('description: Review <code> & more'),
    'skills/release/SKILL.md': skill(
      'description: Release\ndisable-model-invocation: true',
    ),
  })
  const loader = new SkillLoader([join(root, 'skills')])
  loader.load()
  const section = loader.buildPromptSection(['read_file', 'bash'])!
  expect(section.startsWith('<skills>\n')).toBe(true)
  expect(section).toContain('Use the read_file tool to load')
  expect(section).toContain('<name>review</name>')
  expect(section).toContain(
    '<description>Review &lt;code&gt; &amp; more</description>',
  )
  expect(section).toContain(
    `<location>${join(root, 'skills/review/SKILL.md')}</location>`,
  )
  expect(section).not.toContain('release')
  expect(section).not.toContain('Body')
  expect(loader.buildPromptSection(['bash'])).toContain('Use bash to load')
  expect(loader.buildPromptSection(['grep'])).toBeNull()
})

test('/skill:<name> args expands to the body in a <skill> block; unknown names and other text are left alone', () => {
  const root = setup({
    'skills/review/SKILL.md': skill('description: Review', 'Check the diff'),
  })
  const loader = new SkillLoader([join(root, 'skills')])
  loader.load()
  const file = join(root, 'skills/review/SKILL.md')
  expect(loader.expand('/skill:review')).toBe(
    `<skill name="review" location="${file}">\nReferences are relative to ${join(root, 'skills/review')}.\n\nCheck the diff\n</skill>`,
  )
  expect(loader.expand('/skill:review  focus on tests ')).toEndWith(
    '</skill>\n\nfocus on tests',
  )
  expect(loader.expand('/skill:nope')).toBeUndefined()
  expect(loader.expand('/review')).toBeUndefined()
})
