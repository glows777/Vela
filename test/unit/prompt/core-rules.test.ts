import { expect, test } from 'bun:test'
import { coreRules, type PromptContext } from '../../../src/prompt/index.ts'

const context = (role: PromptContext['role']): PromptContext => ({
  toolCount: 1,
  deferredToolSummary: '',
  sessionMessageCount: 0,
  sessionId: 's',
  role,
})

test('the core prompt has a preamble, rules and the working directory', () => {
  const prompt = coreRules('C:\\work\\repo')(context('owner'))!
  expect(prompt.startsWith('You are Vela')).toBe(true)
  expect(prompt).toContain('<rules>\n- ')
  expect(prompt).toContain('edit_file')
  expect(prompt.endsWith('<cwd>\nC:/work/repo\n</cwd>')).toBe(true)
})

test('guests get no file rules and never see the working directory', () => {
  const prompt = coreRules('/srv/vela')(context('guest'))!
  expect(prompt).toContain('tool_search')
  expect(prompt).not.toContain('edit_file')
  expect(prompt).not.toContain('/srv/vela')
  expect(prompt).not.toContain('<cwd>')
})
