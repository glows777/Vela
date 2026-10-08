import { afterEach, expect, test } from 'bun:test'
import { fauxText } from '../../../../src/testing/faux.ts'
import {
  captureConsole,
  cleanupTestVelas,
  createTestVela,
  type TestVela,
  type TestVelaOptions,
} from '../../../support/vela.ts'

const BODY = '## Review checklist\n- Run the diff\n- Confirm there are no regressions'
const SKILL = { name: 'code-review', description: 'Review code changes', body: BODY }

afterEach(cleanupTestVelas)

const fixture = (options: TestVelaOptions = {}) =>
  createTestVela({ skills: [SKILL], ...options })

function countOccurrences(text: string, needle: string): number {
  return needle ? text.split(needle).length - 1 : 0
}

function allPromptText(t: TestVela): string {
  const system = t.session.buildSystem()
  const messages = t.messages
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n')
  return `${system}\n${messages}`
}

test('/skill list prints the available skills', async () => {
  const t = fixture()
  const { output } = await captureConsole(() => {
    expect(t.dispatch('/skill')).toBe(true)
    expect(t.dispatch('/skill list')).toBe(true)
  })
  expect(output).toContain('/code-review')
  expect(output).toContain('Review code changes')
  expect(output).not.toContain('✓ active')
})

test('/skill load activates the skill and injects its body once (not in the system prompt)', async () => {
  const t = fixture()
  await captureConsole(() =>
    expect(t.dispatch('/skill load code-review')).toBe(true),
  )
  expect(t.session.activeSkills.has('code-review')).toBe(true)
  expect(t.messages).toHaveLength(1)
  expect(t.messages[0]!.content).toContain(BODY)
  expect(countOccurrences(allPromptText(t), BODY)).toBe(1)
})

test('/skill unload deactivates the skill', async () => {
  const t = fixture()
  await captureConsole(() => {
    t.dispatch('/skill load code-review')
    expect(t.dispatch('/skill unload code-review')).toBe(true)
  })
  expect(t.session.activeSkills.has('code-review')).toBe(false)
})

test('/<skill> trigger: activeSkills updates, the body is injected once as a message, the system prompt keeps only the index', async () => {
  const t = fixture({ responses: [fauxText('Review done')] })
  const { result } = await captureConsole(() => t.command('/code-review extra'))
  expect(result).toBe(true)
  expect(t.session.activeSkills.has('code-review')).toBe(true)
  expect(String(t.messages[0]!.content)).toBe(`${BODY}\n\nUser instruction: extra`)

  const system = t.session.buildSystem()
  expect(system).not.toContain(BODY)
  expect(system).toContain('/code-review — Review code changes ✓ active')
  expect(countOccurrences(allPromptText(t), BODY)).toBe(1)

  // The model receives the skill body + the user instruction; the reply goes back into the session and is saved
  expect(t.model.calls[0]!.lastUserText).toBe(`${BODY}\n\nUser instruction: extra`)
  expect(t.lastAssistantText()).toBe('Review done')
  expect(await t.readData('sessions/default.jsonl')).toContain('Review done')
})

test('/<skill> without arguments: the body is the whole message', async () => {
  const t = fixture({ responses: [fauxText('ok')] })
  await captureConsole(() => t.command('/code-review'))
  expect(t.messages[0]!.content).toBe(BODY)
})

test('an unknown /<skill> falls through to normal chat', () => {
  const t = fixture()
  expect(t.dispatch('/not-a-skill')).toBe(false)
})

test('/skill load with an unknown name returns true and says so', async () => {
  const t = fixture()
  const { result, output } = await captureConsole(() =>
    t.dispatch('/skill load nope'),
  )
  expect(result).toBe(true)
  expect(output).toContain('Skill not found: nope')
})

test('without a skills directory the system prompt has no skills index', () => {
  const t = createTestVela()
  expect(t.session.buildSystem()).not.toContain('Available skills')
})

test('P0-3: incomplete subcommands are caught and do not fall through as a skill trigger', async () => {
  const t = fixture()
  const { output } = await captureConsole(() => {
    expect(t.dispatch('/skill load')).toBe(true)
    expect(t.dispatch('/skill unload')).toBe(true)
    expect(t.dispatch('/skill bogus-command')).toBe(true)
  })
  expect(output).toContain('Usage: /skill load <name>')
  expect(output).toContain('Unknown subcommand')
  expect(t.session.activeSkills.size).toBe(0)
  expect(t.messages).toHaveLength(0)
})

test('P0-2: the busy lock refuses a concurrent trigger', () => {
  const t = fixture()
  t.session.busy.locked = true
  expect(t.dispatch('/code-review extra')).toBe(true)
  expect(t.session.activeSkills.has('code-review')).toBe(false)
  expect(t.messages).toHaveLength(0)
})

test('/skill load is refused while running (no message inserted before this turn answers)', () => {
  const t = fixture()
  t.session.busy.locked = true
  expect(t.dispatch('/skill load code-review')).toBe(true)
  expect(t.session.activeSkills.has('code-review')).toBe(false)
  expect(t.messages).toHaveLength(0)
})

test('P0-2: repeating /skill load does not inject the body twice', async () => {
  const t = fixture()
  await captureConsole(() => {
    expect(t.dispatch('/skill load code-review')).toBe(true)
    expect(t.dispatch('/skill load code-review')).toBe(true)
  })
  expect(t.messages).toHaveLength(1)
  expect(countOccurrences(allPromptText(t), BODY)).toBe(1)
})

test('P0-2: triggering after load does not inject a second copy of the body', async () => {
  const t = fixture({ responses: [fauxText('ok')] })
  await captureConsole(async () => {
    expect(t.dispatch('/skill load code-review')).toBe(true)
    expect(await t.command('/code-review extra')).toBe(true)
  })
  expect(t.messages.filter((m) => m.role === 'user')).toHaveLength(2)
  expect(countOccurrences(allPromptText(t), BODY)).toBe(1)
})

test('P0-2: a second trigger after the body is injected adds only a note, not the body again', async () => {
  const t = fixture({ responses: [fauxText('first'), fauxText('second')] })
  await captureConsole(async () => {
    expect(await t.command('/code-review extra')).toBe(true)
    expect(await t.command('/code-review extra')).toBe(true)
  })
  const lastUser = t.messages.filter((m) => m.role === 'user').at(-1)!
  expect(String(lastUser.content)).toContain('[skill loaded]')
  expect(String(lastUser.content)).not.toContain(BODY)
  expect(countOccurrences(allPromptText(t), BODY)).toBe(1)
})

test('skill persists the updated summary produced during preparation', async () => {
  const t = fixture({ responses: [fauxText('ok')] })
  await t.session.contextManager.commit([], 'old summary')
  t.session.prepareContext = async () => {
    await t.session.contextManager.commit(t.messages.slice(), 'new summary')
  }
  await captureConsole(() => t.command('/code-review'))
  expect((await t.session.store.loadState()).summary).toBe('new summary')
})
