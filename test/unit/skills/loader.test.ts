import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, test } from 'bun:test'
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

test('load 解析 frontmatter 的 description 与 when_to_use', () => {
  const dir = makeTempDir()
  writeSkill(
    dir,
    'demo',
    '---\ndescription: 一个演示 skill\nwhen_to_use: 用户想要演示时\n---\n\n正文内容\n',
  )
  const loader = new SkillLoader([path.join(dir, '.skills')])
  loader.load()
  const skill = loader.get('demo')
  expect(skill?.name).toBe('demo')
  expect(skill?.description).toBe('一个演示 skill')
  expect(skill?.whenToUse).toBe('用户想要演示时')
  expect(skill?.content).toBe('正文内容')
})

test('无 frontmatter 的 SKILL.md 兜底为空描述', () => {
  const dir = makeTempDir()
  writeSkill(dir, 'bare', '没有 frontmatter 内容\n')
  const loader = new SkillLoader([path.join(dir, '.skills')])
  loader.load()
  expect(loader.get('bare')?.description).toBe('')
  expect(loader.get('bare')?.content).toBe('没有 frontmatter 内容\n')
})

test('load 跳过没有 SKILL.md 的目录', () => {
  const dir = makeTempDir()
  writeSkill(dir, 'valid', '---\ndescription: ok\n---\n\n内容\n')
  fs.mkdirSync(path.join(dir, '.skills', 'no-skill-file'), { recursive: true })
  const loader = new SkillLoader([path.join(dir, '.skills')])
  loader.load()
  expect(loader.list().map((s) => s.name)).toEqual(['valid'])
})

test('buildPromptSection 只输出索引，永不输出正文', () => {
  const dir = makeTempDir()
  writeSkill(
    dir,
    'demo',
    '---\ndescription: 演示\nwhen_to_use: 演示场景\n---\n\nSECRET_SKILL_BODY\n',
  )
  const loader = new SkillLoader([path.join(dir, '.skills')])
  loader.load()

  const inactive = loader.buildPromptSection(new Set())
  expect(inactive).toContain('/demo — 演示 (适用场景: 演示场景)')
  expect(inactive).not.toContain('SECRET_SKILL_BODY')
  expect(inactive).not.toContain('已激活')

  const active = loader.buildPromptSection(new Set(['demo']))
  expect(active).toContain('/demo — 演示 (适用场景: 演示场景) ✓ 已激活')
  expect(active).not.toContain('SECRET_SKILL_BODY')
})

test('没有 skill 时 buildPromptSection 返回 null', () => {
  const dir = makeTempDir()
  expect(new SkillLoader([path.join(dir, '.skills')]).buildPromptSection(new Set())).toBeNull()
})
