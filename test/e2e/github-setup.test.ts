import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { githubEvents, githubFixture, type Hook } from '../support/github-setup.ts'
const args = ['setup', 'github', 'acme/widgets', '--url', 'https://hooks.example.com']
const receiver = (secret: unknown = 'saved-secret', port: unknown = 8787) => ({ extensionConfig: { channel: { eventReceiver: { port, github: { secret, repositories: ['acme/old'] } } } } })

test('fresh model-free CLI saves privately, creates once and updates once with the same secret', async () => {
  const f = githubFixture()
  mkdirSync(join(f.cwd, '.vela', 'extensions'), { recursive: true })
  const project = '{ malformed project must not load'
  writeFileSync(join(f.cwd, '.vela', 'settings.json'), project)
  writeFileSync(join(f.cwd, '.vela', 'extensions', 'trap.ts'), 'throw new Error("PROJECT_EXTENSION_RAN")')
  writeFileSync(join(f.cwd, '.env'), 'SHOULD_NOT_LOAD=private-project-value')
  const first = await f.cli([...args.slice(0, 3), 'ACME/WIDGETS', ...args.slice(3)])
  expect(first.code).toBe(0)
  const settings = f.settings()
  const config = settings.extensionConfig.channel.eventReceiver
  expect(config.port).toBe(8787)
  expect(config.github.repositories).toEqual(['acme/widgets'])
  expect(config.github.secret).toMatch(/^[a-f0-9]{64}$/)
  expect(statSync(f.agentDir).mode & 0o777).toBe(0o700)
  expect(statSync(f.settingsPath).mode & 0o777).toBe(0o600)
  expect(readdirSync(f.agentDir)).toEqual(['settings.json'])
  const second = await f.cli(args)
  expect(second.code).toBe(0)
  expect(f.settings()).toEqual(settings)
  const hooks = f.state().hooks['acme/widgets']!
  expect(hooks).toHaveLength(1)
  expect(hooks[0]).toMatchObject({ name: 'web', active: true, config: { url: 'https://hooks.example.com/events/github', content_type: 'json', insecure_ssl: '0', secret: config.github.secret }, events: githubEvents })
  const calls = f.state().calls
  expect(calls[0]!.args).toEqual(['auth', 'status', '--hostname', 'github.com'])
  expect(calls.filter((call) => call.args.includes('POST'))).toHaveLength(1)
  expect(calls.filter((call) => call.args.includes('PATCH'))).toHaveLength(1)
  for (const call of calls) {
    expect(call.settings).toEqual(settings)
    expect(call.args.join(' ')).not.toContain(config.github.secret)
    if (call.input) expect(call.args).toContain('--input')
  }
  expect(first.output + second.output).not.toContain(config.github.secret)
  for (const text of ['vela serve', 'channel', 'Recent deliveries', 'tunnel', 'old', 'project']) expect(first.output.toLowerCase()).toContain(text.toLowerCase())
  expect(readFileSync(join(f.cwd, '.vela', 'settings.json'), 'utf8')).toBe(project)
})

for (const missing of [['setup', 'github'], ['setup', 'github', 'acme/widgets'], ['setup', 'github', '--url', 'https://hooks.example.com']]) test(`missing non-TTY input returns usage 2: ${missing.join(' ')}`, async () => {
  const f = githubFixture(); const result = await f.cli(missing)
  expect(result.code).toBe(2); expect(result.output).toContain('required'); expect(f.saved()).toBe(false); expect(f.state().calls).toEqual([])
})
for (const option of [['--model', 'mock/model'], ['--thinking', 'high'], ['--approve'], ['--no-extensions'], ['--no-session'], ['--tools', 'bash'], ['-e', 'trap.ts'], ['--append-system-prompt', 'extra'], ['--url', 'https://other.example']]) test(`GitHub setup rejects unrelated or duplicate options: ${option.join(' ')}`, async () => {
  const f = githubFixture(); const result = await f.cli([...args, ...option]); expect(result.code).toBe(2); expect(f.saved()).toBe(false); expect(f.state().calls).toEqual([])
})
for (const url of ['http://hooks.example.com', 'https://user:password@hooks.example.com', 'https://hooks.example.com/prefix', 'https://hooks.example.com/a/..', 'https://hooks.example.com/%2e', 'https://hooks.example.com/?x=1', 'https://hooks.example.com/#frag', 'https://hooks.example.com?', 'https://localhost', 'https://sub.localhost', 'https://127.1', 'https://[::1]', 'https://0.0.0.0']) test(`unsafe origin fails before config or gh: ${url}`, async () => {
  const f = githubFixture(); const result = await f.cli(['setup', 'github', 'acme/widgets', '--url', url]); expect(result.code).toBe(1); expect(f.saved()).toBe(false); expect(f.state().calls).toEqual([])
})
for (const repo of ['widgets', 'https://github.com/acme/widgets', 'acme/widgets/more', 'acme/..', '-acme/widgets', 'acme/space repo']) test(`invalid repository does not mutate: ${repo}`, async () => {
  const f = githubFixture(); const result = await f.cli(['setup', 'github', repo, '--url', 'https://hooks.example.com']); expect(result.code).not.toBe(0); expect(f.saved()).toBe(false); expect(f.state().calls).toEqual([])
})

test('merge preserves model, Lark, adapters, apps, existing repositories and fixed port', async () => {
  const f = githubFixture(); const prior = { ...receiver(), defaultModel: 'custom/saved', extensions: ['-builtin:lark'], extensionConfig: { lark: { appSecret: '$LARK_SECRET' }, other: { value: 7 }, channel: { extra: true, eventReceiver: { port: 9443, host: '127.0.0.1', adapters: ['unchanged'], apps: { app: 'untouched' }, github: { secret: 'saved-secret', repositories: ['acme/old'], note: 'keep' } } } } }
  f.seed(prior); chmodSync(f.settingsPath, 0o644); chmodSync(f.agentDir, 0o755)
  expect((await f.cli(args)).code).toBe(0)
  expect(f.settings()).toEqual({ ...prior, extensionConfig: { ...prior.extensionConfig, channel: { ...prior.extensionConfig.channel, eventReceiver: { ...prior.extensionConfig.channel.eventReceiver, github: { ...prior.extensionConfig.channel.eventReceiver.github, repositories: ['acme/old', 'acme/widgets'] } } } } })
  expect(statSync(f.settingsPath).mode & 0o777).toBe(0o600); expect(statSync(f.agentDir).mode & 0o777).toBe(0o700)
})
for (const [stored, expanded, env] of [['$GH_SECRET', 'secret-from-env', { GH_SECRET: 'secret-from-env' }], ['${GH_SECRET}', 'other-env-secret', { GH_SECRET: 'other-env-secret' }], ['literal$$value', 'literal$value', {}]] as const) test(`reuse saved secret without changing raw setting: ${stored}`, async () => {
  const f = githubFixture(); f.seed(receiver(stored)); const result = await f.cli(args, env); expect(result.code).toBe(0); expect(f.settings().extensionConfig.channel.eventReceiver.github.secret).toBe(stored); expect(f.state().hooks['acme/widgets']![0]!.config.secret).toBe(expanded); expect(result.output).not.toContain(expanded)
})
for (const invalid of [receiver('$MISSING'), receiver('prefix-${MISSING}'), receiver(''), receiver(7), receiver('saved', 0), receiver('saved', 65536), receiver('saved', 1.5), { extensionConfig: [] }, { extensionConfig: { channel: { eventReceiver: { github: { repositories: 'acme/old' } } } } }, []]) test(`invalid saved config is unchanged and never reaches gh: ${JSON.stringify(invalid)}`, async () => {
  const f = githubFixture(); f.seed(invalid); const before = readFileSync(f.settingsPath, 'utf8'); const result = await f.cli(args); expect(result.code).toBe(1); expect(readFileSync(f.settingsPath, 'utf8')).toBe(before); expect(f.state().calls).toEqual([])
})
test('malformed settings fail without echoing the saved secret or changing bytes', async () => {
  const f = githubFixture(); f.seed({}); const broken = '{"secret":"DONT-LEAK-JSON", invalid}'; writeFileSync(f.settingsPath, broken); const result = await f.cli(args); expect(result.code).toBe(1); expect(result.output).not.toContain('DONT-LEAK-JSON'); expect(readFileSync(f.settingsPath, 'utf8')).toBe(broken); expect(f.state().calls).toEqual([])
})
test('local write failure precedes all gh actions', async () => {
  const f = githubFixture(); writeFileSync(f.agentDir, 'not a directory'); const result = await f.cli(args); expect(result.code).toBe(1); expect(f.state().calls).toEqual([]); expect(readFileSync(f.agentDir, 'utf8')).toBe('not a directory')
})
for (const mode of ['absent', 'not-authenticated']) test(`manual fallback saves configuration when gh is ${mode}`, async () => {
  const f = githubFixture(); if (mode === 'absent') rmSync(join(f.bin, 'gh')); else f.setState({ auth: false }); const result = await f.cli(args); expect(result.code).toBe(1); expect(f.saved()).toBe(true); const secret = f.settings().extensionConfig.channel.eventReceiver.github.secret; for (const text of ['https://github.com/acme/widgets/settings/hooks', 'https://hooks.example.com/events/github', 'json', 'SSL', 'Sensitive', secret, ...githubEvents]) expect(result.output).toContain(text); expect(Object.values(f.state().hooks)).toEqual([])
})
test('partial permissions failure preserves good hooks, saves all repos and continues without retry', async () => {
  const f = githubFixture(); f.setState({ fail: ['acme/denied'] }); const result = await f.cli(['setup', 'github', 'acme/ok', 'acme/denied', 'acme/later', '--url', 'https://hooks.example.com']); expect(result.code).toBe(1); expect(f.state().hooks['acme/ok']).toHaveLength(1); expect(f.state().hooks['acme/later']).toHaveLength(1); expect(f.settings().extensionConfig.channel.eventReceiver.github.repositories).toEqual(['acme/ok', 'acme/denied', 'acme/later']); expect(f.state().calls.filter((call) => call.args.some((arg) => arg.includes('acme/denied')))).toHaveLength(1); expect(result.output).toContain('403')
})
test('all pages are listed and only the normalized exact target URL is updated', async () => {
  const f = githubFixture(); const old = Array.from({ length: 100 }, (_, i): Hook => ({ id: i + 1, config: { url: `https://old.example.com/${i}` } })); const target: Hook = { id: 101, name: 'web', active: false, config: { url: 'https://HOOKS.EXAMPLE.COM:443/events/github' }, events: ['*'] }; f.setState({ hooks: { 'acme/widgets': [...old, target] } }); expect((await f.cli(args)).code).toBe(0); const hooks = f.state().hooks['acme/widgets']!; expect(hooks).toHaveLength(101); expect(hooks.slice(0, 100)).toEqual(old); expect(hooks[100]).toMatchObject({ id: 101, active: true, events: githubEvents }); expect(f.state().calls.some((call) => call.args.includes('POST'))).toBe(false)
})
test('ambiguous matching hooks are not mutated but other repositories still succeed', async () => {
  const f = githubFixture(); const duplicates = [1, 2].map((id) => ({ id, config: { url: 'https://hooks.example.com/events/github' } })); f.setState({ hooks: { 'acme/widgets': duplicates } }); const result = await f.cli(['setup', 'github', 'acme/widgets', 'acme/other', '--url', 'https://hooks.example.com']); expect(result.code).toBe(1); expect(f.state().hooks['acme/widgets']).toEqual(duplicates); expect(f.state().hooks['acme/other']).toHaveLength(1); expect(result.output).toMatch(/multiple|ambiguous|more than one/i)
})
test('a lost POST response is not retried and a rerun finds the existing hook', async () => {
  const f = githubFixture(); f.setState({ lost: true }); expect((await f.cli(args)).code).toBe(1); const secret = f.settings().extensionConfig.channel.eventReceiver.github.secret; expect(f.state().hooks['acme/widgets']).toHaveLength(1); expect(f.state().calls.filter((call) => call.args.includes('POST'))).toHaveLength(1); expect((await f.cli(args)).code).toBe(0); expect(f.state().hooks['acme/widgets']).toHaveLength(1); expect(f.settings().extensionConfig.channel.eventReceiver.github.secret).toBe(secret)
})
test('child errors redact both raw and JSON-escaped secrets without removing useful errors', async () => {
  const f = githubFixture(); const secret = 'secret"\\\n$tail'; f.seed(receiver(secret.replace(/\$/g, () => '$$'))); f.setState({ echoSecret: true }); const result = await f.cli(args); expect(result.code).toBe(1); expect(result.output).not.toContain(secret); expect(result.output).not.toContain(JSON.stringify(secret).slice(1, -1)); expect(result.output).toContain('[redacted]')
})
test('help documents GitHub arguments and setup exit codes without touching config', async () => {
  const f = githubFixture(); const result = await f.cli(['setup', 'github', '--help']); expect(result.code).toBe(0); for (const text of ['owner/repo', '--url', '0', '1', '2']) expect(result.stdout).toContain(text); expect(existsSync(f.agentDir)).toBe(false); expect(f.state().calls).toEqual([])
})
