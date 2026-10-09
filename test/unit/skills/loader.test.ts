import { afterAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SkillLoader } from '../../../src/skills/loader.ts'

const tempDirs: string[] = []
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-loader-'))
  tempDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function writeSkill(base: string, name: string, content: string): void {
  const dir = path.join(base, '.skills', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8')
}

test('load parses description and when_to_use from the frontmatter', () => {
  const dir = makeTempDir()
  writeSkill(
    dir,
    'demo',
    '---\ndescription: A demo skill\nwhen_to_use: When the user wants a demo\n---\n\nBody text\n',
  )
  const loader = new SkillLoader([path.join(dir, '.skills')])
  loader.load()
  const skill = loader.get('demo')
  expect(skill?.name).toBe('demo')
  expect(skill?.description).toBe('A demo skill')
  expect(skill?.whenToUse).toBe('When the user wants a demo')
  expect(skill?.content).toBe('Body text')
})

test('a SKILL.md without frontmatter falls back to an empty description', () => {
  const dir = makeTempDir()
  writeSkill(dir, 'bare', 'Content without frontmatter\n')
  const loader = new SkillLoader([path.join(dir, '.skills')])
  loader.load()
  expect(loader.get('bare')?.description).toBe('')
  expect(loader.get('bare')?.content).toBe('Content without frontmatter\n')
})

test('load skips directories without a SKILL.md', () => {
  const dir = makeTempDir()
  writeSkill(dir, 'valid', '---\ndescription: ok\n---\n\nContent\n')
  fs.mkdirSync(path.join(dir, '.skills', 'no-skill-file'), { recursive: true })
  const loader = new SkillLoader([path.join(dir, '.skills')])
  loader.load()
  expect(loader.list().map((s) => s.name)).toEqual(['valid'])
})

test('buildPromptSection outputs only the index, never the body', () => {
  const dir = makeTempDir()
  writeSkill(
    dir,
    'demo',
    '---\ndescription: Demo\nwhen_to_use: Demo scenarios\n---\n\nSECRET_SKILL_BODY\n',
  )
  const loader = new SkillLoader([path.join(dir, '.skills')])
  loader.load()

  const inactive = loader.buildPromptSection(new Set())
  expect(inactive).toContain('/demo — Demo (when to use: Demo scenarios)')
  expect(inactive).not.toContain('SECRET_SKILL_BODY')
  expect(inactive).not.toContain('✓ active')

  const active = loader.buildPromptSection(new Set(['demo']))
  expect(active).toContain(
    '/demo — Demo (when to use: Demo scenarios) ✓ active',
  )
  expect(active).not.toContain('SECRET_SKILL_BODY')
})

test('buildPromptSection returns null when there are no skills', () => {
  const dir = makeTempDir()
  expect(
    new SkillLoader([path.join(dir, '.skills')]).buildPromptSection(new Set()),
  ).toBeNull()
})
