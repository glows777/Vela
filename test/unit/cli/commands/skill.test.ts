import { afterEach, expect, test } from 'bun:test'
import {
  captureConsole,
  cleanupTestVelas,
  createTestVela,
} from '../../../support/vela.ts'

afterEach(cleanupTestVelas)

const SKILLS = [
  {
    name: 'code-review',
    description: 'Review code changes',
    body: 'Run the diff',
  },
  {
    name: 'release',
    description: 'Cut a release',
    body: 'Tag it',
    disableModelInvocation: true,
  },
]

test('/skill lists the skills with how to run them', async () => {
  const t = createTestVela({ skills: SKILLS })
  const { output } = await captureConsole(() => {
    expect(t.dispatch('/skill')).toBe(true)
    expect(t.dispatch('/skills')).toBe(true)
  })
  expect(output).toContain('/skill:code-review — Review code changes')
  expect(output).toContain('/skill:release — Cut a release (manual only)')
})

test('/skill without skills says where to add one', async () => {
  const t = createTestVela()
  const { output } = await captureConsole(() => t.dispatch('/skill'))
  expect(output).toContain('No skills found')
})

test('/skill:<name> is not a CLI command: it goes to session.prompt(), which expands it', () => {
  const t = createTestVela({ skills: SKILLS })
  expect(t.dispatch('/skill:code-review now')).toBe(false)
  expect(t.dispatch('/code-review')).toBe(false)
})
