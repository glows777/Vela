import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import {
  githubFixture,
  setupModule,
} from '../../../../../test/support/github-setup.ts'
import { inputDialog } from '../../../src/cli/tui/input-dialogs.ts'

// Exercise the same input component used by setup, injecting only the terminal boundary.
function answer(
  title: string,
  value: string | undefined,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const dialog = inputDialog(title, undefined, undefined, resolve)
    for (const char of value ?? '') dialog.focus.handleInput(char)
    dialog.focus.handleInput(value === undefined ? '\x1b' : '\r')
  })
}
for (const cancelAt of [0, 1])
  test(`cancelling setup input ${cancelAt + 1} leaves existing settings and gh untouched`, async () => {
    const f = githubFixture()
    f.seed({ untouched: 'original' })
    const before = readFileSync(f.settingsPath, 'utf8')
    const prompts: string[] = []
    const { githubSetup } = await import(setupModule)
    const code = await githubSetup({
      agentDir: f.agentDir,
      repositories: [],
      interactive: true,
      env: f.env,
      input: (title: string) => {
        const index = prompts.push(title) - 1
        return answer(title, index === cancelAt ? undefined : 'acme/widgets')
      },
      write: () => {},
    })
    expect(code).toBe(0)
    expect(prompts).toHaveLength(cancelAt + 1)
    expect(readFileSync(f.settingsPath, 'utf8')).toBe(before)
    expect(f.state().calls).toEqual([])
  })
test('missing arguments collect repositories and origin through setup inputs without creating model state', async () => {
  const f = githubFixture()
  const prompts: string[] = []
  const { githubSetup } = await import(setupModule)
  const code = await githubSetup({
    agentDir: f.agentDir,
    repositories: [],
    interactive: true,
    env: f.env,
    input: (title: string) =>
      answer(
        title,
        prompts.push(title) === 1
          ? 'acme/one acme/two ACME/ONE'
          : 'https://hooks.example.com/',
      ),
    write: () => {},
  })
  expect(code).toBe(0)
  expect(prompts).toHaveLength(2)
  expect(
    f.settings().extensionConfig.channel.eventReceiver.github.repositories,
  ).toEqual(['acme/one', 'acme/two'])
  expect(f.state().hooks['acme/one']).toHaveLength(1)
  expect(existsSync(`${f.agentDir}/models.json`)).toBe(false)
})
test('invalid interactive input is rejected before saving or invoking gh', async () => {
  const f = githubFixture()
  const { githubSetup } = await import(setupModule)
  const code = await githubSetup({
    agentDir: f.agentDir,
    repositories: ['acme/widgets'],
    interactive: true,
    env: f.env,
    input: (title: string) => answer(title, 'https://hooks.example.com/path'),
    write: () => {},
  })
  expect(code).toBe(1)
  expect(f.saved()).toBe(false)
  expect(f.state().calls).toEqual([])
})
