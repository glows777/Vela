import { expect, test } from 'bun:test'
import {
  coreRules,
  type PromptContext,
  workingDirectory,
} from '../../../src/prompt/index.ts'

const context = (role: PromptContext['role']): PromptContext => ({
  toolCount: 1,
  deferredToolSummary: '',
  sessionMessageCount: 0,
  sessionId: 's',
  role,
})

test('the core prompt has a preamble and rules; the working directory is its own section', () => {
  const prompt = coreRules()(context('owner'))!
  expect(prompt.startsWith('You are Vela')).toBe(true)
  expect(prompt).toContain('<rules>\n- ')
  expect(prompt).toContain('edit_file')
  expect(workingDirectory('C:\\work\\repo')(context('owner'))).toBe(
    '<cwd>\nC:/work/repo\n</cwd>',
  )
})

test('guests get no file rules and never see the working directory', () => {
  const prompt = coreRules()(context('guest'))!
  expect(prompt).toContain('tool_search')
  expect(prompt).not.toContain('edit_file')
  expect(workingDirectory('/srv/vela')(context('guest'))).toBeNull()
})
