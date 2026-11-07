import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { githubFixture, setupEntry } from '../support/github-setup.ts'

const hasScript =
  process.platform === 'linux' && Bun.spawnSync(['script', '-V']).exitCode === 0
async function terminal(
  f: ReturnType<typeof githubFixture>,
  args: string[],
  steps: [string, string][],
) {
  const command = [
    process.execPath,
    '--no-env-file',
    setupEntry,
    'setup',
    'github',
    ...args,
  ]
  const child = Bun.spawn(
    [
      '/usr/bin/script',
      '-qec',
      command.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(' '),
      '/dev/null',
    ],
    { cwd: f.cwd, env: f.env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  )
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000)
  let output = ''
  const pending = [...steps]
  try {
    for await (const chunk of child.stdout) {
      output += new TextDecoder().decode(chunk)
      const screen = stripTerminalSequences(output)
      while (pending.length && screen.includes(pending[0]![0])) {
        child.stdin.write(pending.shift()![1])
        await child.stdin.flush()
      }
    }
    const [stderr, code] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ])
    return {
      code,
      output: stripTerminalSequences(output) + stderr,
      remaining: pending,
    }
  } finally {
    clearTimeout(timeout)
  }
}
for (const [keyName, key] of [
  ['Escape', '\x1b'],
  ['Ctrl+C', '\x03'],
  ['Ctrl+D', '\x04'],
]) {
  for (const at of ['repositories', 'origin'])
    test.skipIf(!hasScript)(
      `real CLI ${keyName} at ${at} cancels before any side effects`,
      async () => {
        const f = githubFixture()
        f.seed({ untouched: 'value' })
        const before = readFileSync(f.settingsPath, 'utf8')
        const steps: [string, string][] =
          at === 'repositories'
            ? [['GitHub repositories', key!]]
            : [
                ['GitHub repositories', 'acme/widgets\r'],
                ['Public HTTPS origin', key!],
              ]
        const result = await terminal(f, [], steps)
        expect(result.remaining).toEqual([])
        expect(result.code).toBe(0)
        expect(readFileSync(f.settingsPath, 'utf8')).toBe(before)
        expect(f.state().calls).toEqual([])
        expect(readdirSync(f.agentDir)).toEqual(['settings.json'])
      },
      20_000,
    )
}
test.skipIf(!hasScript)(
  'real CLI completes both setup inputs without model setup or a session',
  async () => {
    const f = githubFixture()
    const result = await terminal(
      f,
      [],
      [
        ['GitHub repositories', 'acme/one acme/two\r'],
        ['Public HTTPS origin', 'https://hooks.example.com\r'],
      ],
    )
    expect(result.remaining).toEqual([])
    expect(result.code).toBe(0)
    expect(f.state().hooks['acme/one']).toHaveLength(1)
    expect(f.state().hooks['acme/two']).toHaveLength(1)
    expect(readdirSync(f.agentDir)).toEqual(['settings.json'])
    expect(result.output).not.toContain('Choose a provider')
    expect(result.output).toContain('vela serve')
  },
  20_000,
)
test.skipIf(!hasScript)(
  'real CLI prompts only for the missing origin',
  async () => {
    const f = githubFixture()
    const result = await terminal(
      f,
      ['acme/widgets'],
      [['Public HTTPS origin', 'https://hooks.example.com\r']],
    )
    expect(result.remaining).toEqual([])
    expect(result.code).toBe(0)
    expect(result.output).not.toContain('GitHub repositories')
    expect(f.state().hooks['acme/widgets']).toHaveLength(1)
  },
  20_000,
)
