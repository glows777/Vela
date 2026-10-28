import { expect, test } from 'bun:test'
import {
  coreRules,
  type PromptContext,
  workingDirectory,
} from '../../../src/prompt/index.ts'

const context: PromptContext = {
  toolCount: 1,
  deferredToolSummary: '',
  sessionMessageCount: 0,
  sessionId: 's',
}

test('the core prompt has a preamble and rules; the working directory is its own section', () => {
  const prompt = coreRules()(context)!
  expect(prompt.startsWith('You are Vela')).toBe(true)
  expect(prompt).toContain('<rules>\n- ')
  expect(prompt).toContain('edit_file')
  expect(prompt).toContain('tool_search')
  expect(workingDirectory('C:\\work\\repo')(context)).toBe(
    '<cwd>\nC:/work/repo\n</cwd>',
  )
})

test('the core prompt states the output rules', () => {
  const prompt = coreRules()(context)!
  for (const rule of [
    'Lead with the answer or result',
    'Match the response length to the question',
    "Don't restate the request",
    "Don't add unrequested suggestions",
    "Don't state unchecked things as fact",
    'only after the tool call for it succeeded',
  ])
    expect(prompt).toContain(rule)
})
