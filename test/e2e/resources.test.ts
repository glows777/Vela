import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { fauxText, fauxToolCall } from '../../src/testing/faux.ts'
import { createVela } from '../../src/vela.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

const REVIEW = {
  name: 'review',
  description: 'Review a change',
  body: 'Read the diff, then list risks.',
}

test('the model sees the skills index and loads a skill itself with read_file', async () => {
  const t = createTestVela({
    skills: [REVIEW],
    responses: [
      fauxToolCall('read_file', { path: '.skills/review/SKILL.md' }),
      fauxText('Following the review skill'),
    ],
  })
  await t.run('Review my change')
  const [first, second] = t.model.calls
  expect(first!.system).toContain('<available_skills>')
  expect(first!.system).toContain(
    `<location>${join(t.cwd, '.skills/review/SKILL.md')}</location>`,
  )
  expect(first!.system).not.toContain(REVIEW.body)
  expect(JSON.stringify(second!.toolResults)).toContain(
    'Read the diff, then list risks.',
  )
})

test('/skill:<name> args sends the skill body as the user message (SDK, without the CLI)', async () => {
  const t = createTestVela({ skills: [REVIEW], responses: [fauxText('ok')] })
  await t.run('/skill:review focus on tests')
  const text = t.model.calls[0]!.lastUserText
  expect(text).toStartWith(
    `<skill name="review" location="${join(t.cwd, '.skills/review/SKILL.md')}">`,
  )
  expect(text).toContain('Read the diff, then list risks.')
  expect(text).toEndWith('</skill>\n\nfocus on tests')
  // The system prompt stays the same: no per-session "active" state
  expect(t.model.calls[0]!.system).toBe(t.session.buildSystem())
})

test('a manual-only skill is not listed to the model but /skill:<name> still runs it', async () => {
  const t = createTestVela({
    skills: [{ ...REVIEW, disableModelInvocation: true }],
    responses: [fauxText('ok')],
  })
  await t.run('/skill:review')
  expect(t.model.calls[0]!.system).not.toContain('<available_skills>')
  expect(t.model.calls[0]!.lastUserText).toContain('Read the diff')
})

test('prompt templates from .vela/prompts expand with arguments; unknown /names go to the model unchanged', async () => {
  const t = createTestVela({
    files: {
      '.vela/prompts/fix.md':
        '---\ndescription: Fix a bug\n---\nFix $1 in ${@:2}',
    },
    responses: [fauxText('fixed'), fauxText('unknown')],
  })
  await t.run('/fix "the crash" a.ts b.ts')
  expect(t.model.calls[0]!.lastUserText).toBe('Fix the crash in a.ts b.ts')
  await t.run('/nothing here')
  expect(t.model.calls[1]!.lastUserText).toBe('/nothing here')
})

test('templates expand before steer / followUp queue them', async () => {
  const t = createTestVela({
    files: { '.vela/prompts/next.md': 'Then do $1' },
    responses: [
      () => {
        void t.session.followUp('/next cleanup')
        return fauxText('first')
      },
      fauxText('done'),
    ],
  })
  await t.run('start')
  expect(t.model.calls[1]!.lastUserText).toBe('Then do cleanup')
})

test('AGENTS.md and skills go into the system prompt in pi order; guests get neither', async () => {
  const t = createTestVela({
    files: { 'AGENTS.md': 'Always use bun.' },
    skills: [REVIEW],
  })
  const system = t.session.buildSystem()
  expect(system).toContain(
    `<project_instructions path="${join(t.cwd, 'AGENTS.md')}">\nAlways use bun.\n</project_instructions>`,
  )
  const order = ['<rules>', '<project_context>', '<skills>', '<cwd>'].map(
    (tag) => system.indexOf(tag),
  )
  expect(order).toEqual([...order].sort((a, b) => a - b))
  expect(order.every((i) => i >= 0)).toBe(true)

  const guest = t.vela.session('guest', { role: 'guest' })
  const guestSystem = guest.buildSystem()
  expect(guestSystem).not.toContain('Always use bun.')
  expect(guestSystem).not.toContain('<available_skills>')
  // Guests can't run skills or templates either: the text goes to the model as typed
  t.model.push(fauxText('hi'))
  await guest.prompt('/skill:review')
  expect(t.model.calls.at(-1)!.lastUserText).toBe('/skill:review')
})

test('SDK options: contextFiles false loads none, appendSystemPrompt adds an <addendum>', async () => {
  const t = createTestVela({ files: { 'AGENTS.md': 'Always use bun.' } })
  const vela = createVela({
    model: t.model,
    cwd: t.cwd,
    contextFiles: false,
    appendSystemPrompt: 'Answer in French.',
  })
  try {
    const system = vela.session().buildSystem()
    expect(system).not.toContain('Always use bun.')
    expect(system).toContain('<addendum>\nAnswer in French.\n</addendum>')
    // The addendum is the owner's own text: guests get it too (docs/security.md)
    expect(vela.session('guest', { role: 'guest' }).buildSystem()).toContain(
      '<addendum>\nAnswer in French.\n</addendum>',
    )
  } finally {
    await vela.dispose()
  }
})
